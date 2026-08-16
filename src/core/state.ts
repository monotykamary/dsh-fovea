import { createHash } from "node:crypto";
import { currentRuntime, executionPathJoin, workspaceStateKey } from "../runtime.js";
import { hasAstGrepAsync } from "./astgrep.js";
import {
  clearPersistTimer,
  filterSupported,
  listFiles,
  loadFacts,
  readEnrolledBoundaries,
  refreshFacts,
} from "./build.js";
import type { ExtractionReport, FactStore, FileFacts } from "./build.js";
import { assembleGraphWithIndex } from "./graph.js";
import { gitProbe, gitReflogAction } from "./git.js";
import { ROOT_CACHE_LIMIT, envInt, yieldToLoop } from "./asyncutil.js";
import { loadRepoRules } from "./anchors.js";
import { buildCsr, type Csr } from "./heat.js";
import type { JoinIndex } from "./join.js";
import { coChangeHistory, type CoChangeHistory } from "./cochange.js";
import type { Graph } from "./types.js";

export interface RepoState {
  root: string;
  version: string;
  graph: Graph;
  csr: Csr;
  joinIndex: JoinIndex;
  /** facts → FileFacts snapshot for this version; records are immutable per generation. */
  facts: Record<string, FileFacts>;
  /** What extraction dropped on the floor building this graph version. */
  extraction: ExtractionReport;
  adjacency: Map<number, Array<{ to: number; kind: string; w: number }>>;
  /** The live mutation container; facts/meta records are replaced immutably on refresh. */
  store: FactStore;
  /** Authoritative file listing for this version. */
  files: string[];
  gitKind: "git" | "plain";
  head: string | undefined;
  probedAt: number;
  walkedAt: number;
  sweptAt: number;
  /** Porcelain-dirty paths at last probe. Porcelain diffs the worktree against
   * HEAD, but facts track the last seen worktree: a file reverting to
   * porcelain-clean with unmoved HEAD would otherwise keep serving its dirty
   * facts until the next edit. */
  dirty: Set<string>;
  /** Set when this generation materialized from a `git checkout` (HEAD moved
   * with reflog action "checkout:…"): sync re-baselines silently instead of
   * cascading over the branch diff. Lives exactly one generation — the next
   * fact-moving refresh builds a fresh state without it, so the quiet path
   * cannot hide authored drift. */
  checkout?: boolean;
  /** Past joint-edit affinity (raw conductance + last joint commit). History
   * is NOT structure: impact re-seeds these partners at recency-decayed
   * strength whenever a change lands, so old co-work cools like any heat. */
  history: CoChangeHistory;
}

// State lifecycle: background builds, probe-gated refreshes, LRU eviction.
// pi runs hooks on one JS thread, so ensureState must never block the first
// resolvable answer behind a full rebuild.

const states = new Map<string, RepoState>(); // insertion order doubles as LRU order
const inflight = new Map<string, Promise<RepoState>>();
// Each resident root holds a full fact store + graph; all heavyweight root
// caches use ROOT_CACHE_LIMIT so one override cannot leave hidden retainers.
const WALK_GAP_MS = envInt("FOVEA_WALK_GAP_MS", 4000, 500, 300_000);
const SWEEP_GAP_MS = envInt("FOVEA_SWEEP_GAP_MS", 20_000, 2000, 600_000);

const stateKey = (root: string): string => workspaceStateKey(root);

const touch = (root: string): RepoState | undefined => {
  const key = stateKey(root);
  const st = states.get(key);
  if (st) {
    states.delete(key);
    states.set(key, st);
  }
  return st;
};

const evictLru = (): void => {
  while (states.size > ROOT_CACHE_LIMIT) {
    const oldest = states.keys().next().value!;
    const state = states.get(oldest);
    states.delete(oldest);
    inflight.delete(oldest);
    if (state) clearPersistTimer(state.root, state.store.workspaceKey);
  }
};

/** Warm state if present (does not block). */
export const getState = (root: string): RepoState | undefined => touch(root);

/** Ongoing build/refresh for root, if any (does not block). */
export const getInflight = (root: string): Promise<RepoState> | undefined => inflight.get(stateKey(root));

/** Drop resident state (tests); the on-disk fact cache survives. */
export const evictState = (root: string): void => {
  const key = stateKey(root);
  states.delete(key);
  inflight.delete(key);
  clearPersistTimer(root);
};

// All live fact passes serialize through one chain. Extraction-failure
// attribution is a process-wide ledger (astgrep cannot see nested passes),
// so overlapping passes would misblame files — and piled-up ast-grep spawns
// would freeze the host anyway. The chain itself never rejects.
let factChain: Promise<unknown> = Promise.resolve();
const factPass = <T>(job: () => Promise<T>): Promise<T> => {
  const run = factChain.then(job, job);
  factChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const graphVersion = (facts: Record<string, FileFacts>): string =>
  createHash("sha1")
    .update(Object.entries(facts).map(([k, v]) => `${k}:${v.sha1}`).sort().join("\n"))
    .digest("hex")
    .slice(0, 12);

const assembleState = async (
  root: string,
  files: string[],
  store: FactStore,
  extraction: ExtractionReport,
  gitKind: "git" | "plain",
  head: string | undefined,
  dirty: Set<string>,
): Promise<RepoState> => {
  // Snapshot the generation: refresh replaces fact records wholesale, so the
  // Record view stays a stable witness for baselines (sync).
  const facts: Record<string, FileFacts> = {};
  for (const [k, v] of store.facts) facts[k] = v;
  await yieldToLoop();
  const version = graphVersion(facts);
  const { graph, joinIndex } = await assembleGraphWithIndex(root, files, store.facts);
  await yieldToLoop();
  const csr = buildCsr(graph);
  await yieldToLoop();
  const adjacency = new Map<number, Array<{ to: number; kind: string; w: number }>>();
  for (const e of graph.edges) {
    (adjacency.get(e.a) ?? adjacency.set(e.a, []).get(e.a)!).push({ to: e.b, kind: e.kind, w: e.w });
    (adjacency.get(e.b) ?? adjacency.set(e.b, []).get(e.b)!).push({ to: e.a, kind: e.kind, w: e.w });
  }
  // impact's path-reason walk used to sort a fresh copy of this list per
  // visited node; identical comparator, pre-sorted once here.
  for (const list of adjacency.values()) {
    list.sort((a, b) => Number(a.kind === "contains") - Number(b.kind === "contains") || b.w - a.w || a.to - b.to);
  }
  // History memory rides alongside the graph, not in it. Impact re-seeds the
  // partners of a change at recency-decayed strength; focus/sketch stay pure
  // structure. Cached by HEAD + tracked set, so a rebuild is cheap.
  const history = await coChangeHistory(root, files);
  const stamp = Date.now();
  return { root, version, graph, csr, joinIndex, facts, extraction, adjacency, store, files, gitKind, head, dirty, history, probedAt: stamp, walkedAt: stamp, sweptAt: stamp };
};

const buildState = async (root: string): Promise<RepoState> => {
  if (!(await hasAstGrepAsync())) {
    throw new Error(
      "fovea: packaged `ast-grep` is unavailable (set FOVEA_AST_GREP to an execution-world binary to override).",
    );
  }
  const { fileRoutes } = await loadRepoRules(root);
  const routeRes = fileRoutes.map((r) => new RegExp(r.re));
  const probe = await gitProbe(root);
  const gitKind: RepoState["gitKind"] = probe ? "git" : "plain";
  // Cold start: the fact cache header remembers which nested boundaries this
  // root had enrolled, so a restart restores coverage without a fresh edit.
  const files = await listFiles(root, routeRes, new Set(await readEnrolledBoundaries(root)));
  const { store, report } = await factPass(() => loadFacts(root, files));
  return assembleState(root, files, store, report, gitKind, probe?.head,
    new Set(probe ? probe.changes.map((c) => c.path).filter((p) => p && !p.endsWith("/")) : []));
};

const refreshState = async (state: RepoState, hints: string[] = [], force = false): Promise<RepoState> => {
  const now = Date.now();
  // No probe-short-circuit across turns: git porcelain is ~40ms behind the
  // spawn gate and is the correctness oracle; plain roots gate on their own
  // walk/sweep intervals below. In-flight dedupe already coalesces bursts.
  const { fileRoutes } = await loadRepoRules(state.root);
  const routeRes = fileRoutes.map((r) => new RegExp(r.re));
  const store = state.store;
  let files = state.files;
  const changed: string[] = [];
  const deleted: string[] = [];
  // A checkout re-materializes the worktree from another ref; flag the
  // rebuilt generation so sync re-baselines quietly. Only a HEAD move whose
  // latest reflog action is "checkout:…" qualifies — pulls/rebases merge
  // foreign work and keep the loud drift path, and reflog-less repos stay
  // conservative (undefined -> false).
  let checkout = false;
  const hinted = [...new Set([...filterSupported(hints, routeRes), ...hints.filter((h) => store.facts.has(h))])];
  changed.push(...hinted);

  // Progressive disclosure: a nested repository stays outside this root's
  // graph until work touches it. A hint landing across a .git marker enrolls
  // the boundary — every marker on the path, so doubly-nested clones cross
  // together — and a vanished marker un-enrolls, so a removed clone leaves
  // no orphan facts behind.
  let disclosureChanged = false;
  for (const boundary of [...store.enrolled]) {
    const exists = await currentRuntime().stat(executionPathJoin(state.root, boundary, ".git")).then((info) => info !== undefined, () => false);
    if (!exists) {
      store.enrolled.delete(boundary);
      disclosureChanged = true;
    }
  }
  let known: Set<string> | undefined;
  for (const h of hinted) {
    let covered = false;
    for (const b of store.enrolled) {
      if (h.startsWith(b + "/")) { covered = true; break; }
    }
    if (!covered) {
      known ??= new Set(state.files);
      covered = known.has(h);
    }
    if (covered) continue;
    let prefix = "";
    for (const seg of h.split("/").slice(0, -1)) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (store.enrolled.has(prefix)) continue;
      const boundary = await currentRuntime().stat(executionPathJoin(state.root, prefix, ".git")).then((info) => info !== undefined, () => false);
      if (!boundary) continue;
      store.enrolled.add(prefix);
      disclosureChanged = true;
    }
  }

  if (state.gitKind === "git") {
    const probe = await gitProbe(state.root);
    if (probe) {
      const headMoved = probe.head !== state.head;
      state.head = probe.head;
      if (headMoved) {
        checkout = (await gitReflogAction(state.root))?.startsWith("checkout:") ?? false;
      }
      // Untracked directories appear collapsed ("dir/") in porcelain; adds
      // inside them only surface through a relist. Relist moments are rare.
      let needsList = probe.relist || disclosureChanged || probe.changes.some((c) => c.path.endsWith("/"));
      if (probe.changes.length) {
        // Porcelain collapses any drift inside a nested checkout (submodule
        // or embedded repo: HEAD move, dirty content, untracked files) to
        // one entry naming its gitlink. A directory change therefore _is_ an
        // edit event: enroll the boundary and relist. Pushing its path into
        // the file pipeline would fail stat and masquerade as unreadable.
        const dirFlags = await Promise.all(
          probe.changes.map((c) => !c.path.endsWith("/") && currentRuntime().stat(executionPathJoin(state.root, c.path)).then((info) => info?.type === "directory", () => false)),
        );
        probe.changes.forEach((c, i) => {
          if (!dirFlags[i]) return;
          needsList = true;
          if (!store.enrolled.has(c.path)) {
            store.enrolled.add(c.path);
            disclosureChanged = true;
          }
        });
      }
      if (needsList) {
        files = await listFiles(state.root, routeRes, store.enrolled);
        changed.push(...state.files);
      } else {
        // HEAD moved with a clean status means a checkout: worktree content
        // re-materialized under fresh mtimes, so sweep everything once.
        if (headMoved) changed.push(...state.files);
        for (const c of probe.changes) {
          const p = c.path;
          if (!p || p.endsWith("/")) continue;
          if (c.code.includes("D")) {
            if (store.facts.has(p) || store.failedSha.has(p)) deleted.push(p);
          } else if (store.facts.has(p) || filterSupported([p], routeRes).length) {
            changed.push(p);
          }
        }
      }
      const nowDirty = new Set(
        probe.changes.map((c) => c.path).filter((p) => p && !p.endsWith("/")),
      );
      if (!headMoved && !needsList) {
        // Porcelain-clean with unmoved HEAD hides reverts: a previously dirty
        // file vanishes from the probe while its captured facts stay dirty.
        // Resurrect it once so the snapshot follows the worktree (covers
        // checkout/restore and untracked files that disappear).
        for (const p of state.dirty) {
          if (nowDirty.has(p)) continue;
          // stat is the arbiter: a restored file whose facts were dropped
          // with the deletion must come back through changed, not sit
          // deleted until its next porcelain-visible edit.
          const onDisk = await currentRuntime().stat(executionPathJoin(state.root, p)).then((info) => info?.type === "file", () => false);
          if (onDisk) changed.push(p);
          else if (store.facts.has(p) || store.failedSha.has(p)) deleted.push(p);
        }
      }
      state.dirty = nowDirty;
    } else {
      // .git vanished (moved/renamed out from under us): degrade to plain.
      state.gitKind = "plain";
    }
  }
  if (state.gitKind === "plain") {
    const walkDue = now - state.walkedAt > WALK_GAP_MS;
    if (force || walkDue || changed.length || disclosureChanged) {
      files = await listFiles(state.root, routeRes, store.enrolled);
      state.walkedAt = now;
      if (force || now - state.sweptAt > SWEEP_GAP_MS) {
        state.sweptAt = now;
        changed.push(...state.files);
      }
    }
  }

  if (!changed.length && !deleted.length && files === state.files) {
    state.probedAt = Date.now();
    return state;
  }
  const { report, stats } = await factPass(() =>
    refreshFacts(state.root, store, files, [...new Set(changed)], [...new Set(deleted)]),
  );
  const noDelta =
    !stats.reExtracted.length && !stats.deleted.length && !stats.added.length && files.length === state.files.length;
  if (noDelta) {
    state.probedAt = Date.now();
    state.extraction = report; // reports are state-wide (taint/unreadable live in the store)
    state.files = files;
    return state;
  }
  const fresh = await assembleState(state.root, files, store, report, state.gitKind, state.head, state.dirty);
  if (checkout) fresh.checkout = true;
  states.set(stateKey(state.root), fresh);
  return fresh;
};

export const ensureState = (root: string, opts: { hints?: string[]; force?: boolean } = {}): Promise<RepoState> => {
  const key = stateKey(root);
  const pending = inflight.get(key);
  if (pending) return pending;
  const warm = touch(root);
  const p: Promise<RepoState> = warm
    ? refreshState(warm, opts.hints, opts.force)
    : (async () => {
        const info = await currentRuntime().stat(root).catch(() => undefined);
        if (info?.type !== "directory") throw new Error(`fovea: root does not exist or is not a directory: ${root}`);
        const state = await buildState(root);
        states.set(key, state);
        evictLru();
        return state;
      })();
  inflight.set(key, p);
  const clear = (): void => {
    if (inflight.get(key) === p) inflight.delete(key);
  };
  p.then(clear, clear);
  return p;
};

/**
 * Fire-and-forget indexing. started=true when this call kicked a cold build;
 * the completion is always awaitable via the returned promise.
 */
export const ensureStateBackground = (root: string): { started: boolean; promise: Promise<RepoState> } => {
  const key = stateKey(root);
  if (states.has(key) || inflight.has(key)) {
    return { started: false, promise: ensureState(root) };
  }
  return { started: true, promise: ensureState(root) };
};
