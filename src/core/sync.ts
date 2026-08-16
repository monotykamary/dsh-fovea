// Turn-sync is continuous repository intelligence for the active agent loop.
// Before agent start and after each assistant turn it compares extracted facts
// against its baseline, regardless of whether edits came from Harness tools,
// fabric_exec, bash, a subagent, or an external editor. Content hashes provide
// the cheap unchanged path; semantic fingerprints ignore coordinate-only drift.
//
// A route change or enough newly relevant files emits compact causal context.
// Pre-agent drift is injected directly; post-turn drift is sent as a steer and
// triggers a continuation if the agent would otherwise become idle.
//
// The first sync establishes the baseline. Baselines reset on /new, /fork,
// and /fovea reset alongside focus sessions.

import { createHash } from "node:crypto";
import { agentStateKey, currentRuntime, executionPathJoin } from "../runtime.js";
import { AGENT_CACHE_LIMIT, envInt, forEachChunked } from "./asyncutil.js";
import { gitProbe } from "./git.js";
import { focus, impact, isTestScope } from "./ops.js";
import { ensureState, ensureStateBackground, getInflight, getState } from "./state.js";
import type { RepoState } from "./state.js";
import { getSession, isLogicalProjectRoot, observeSessionPaths, syncScopeForPath } from "./session.js";
import { attributeChanges, type SyncProvenance } from "./provenance.js";

interface SyncBaseline {
  version: string;
  /** Wall-clock boundary for accepting mutation transitions into this baseline chain. */
  capturedAt: number;
  /** anchor id -> carrier file. Anchor escalation requires carrier drift
   * evidence: content-identical carriers keep content-identical anchors by
   * construction, so a delta with an untouched carrier is an extraction
   * artifact (parallel-load sweeps can drop a file's anchors transiently),
   * not a route change. */
  anchors: Map<string, string>;
  /** file -> content sha1 at baseline; used only for fast drift detection. */
  shas: Map<string, string>;
  /** file -> extracted semantic facts, excluding the content hash. */
  semantics: Map<string, string>;
  /** graph node ("kind|name@file") -> charged cascade mass + charge time. The
   * verdict memory lives at AST-hunk granularity so a disclosed cascade node
   * cannot regenerate surprise on revisits (ping-pong dies by construct),
   * while a novel hunk in an otherwise-known file still fires. */
  heat?: Map<string, { m: number; t: number }>;
  /** Hysteresis latch: any red sync disarms warmth firing until total surprise drops back into the re-arm fraction. */
  warmthArmed?: boolean;
  /** Drift targets already push-embedded in this baseline chain (embed-once). */
  pushed?: Set<string>;
}

// Hot-reload survival: `/fovea reload` re-evaluates this module in the same
// process, so a plain module-level Map would drop every charged ledger and
// the next drift would re-fire as a first disclosure. Park the baselines on
// a registered global symbol; the store outlives the module instance. The
// version stamp keeps shape changes safe: a mismatched slot degrades to a
// cold store (today's reload behavior) instead of corrupting verdict math —
// bump BASELINE_STATE_VERSION when SyncBaseline changes incompatibly.
const BASELINE_STATE_VERSION = 2;
const BASELINES_SLOT = Symbol.for("dsh-fovea:sync-baselines");
type BaselinesGlobal = typeof globalThis & {
  [BASELINES_SLOT]?: { v: number; map: Map<string, SyncBaseline> };
};
export const syncBaselineStore = (): Map<string, SyncBaseline> => {
  const g = globalThis as BaselinesGlobal;
  const held = g[BASELINES_SLOT];
  if (held && held.v === BASELINE_STATE_VERSION) return held.map;
  const map = new Map<string, SyncBaseline>();
  g[BASELINES_SLOT] = { v: BASELINE_STATE_VERSION, map };
  return map;
};
const baselines = syncBaselineStore();
const syncKey = (root: string): string => agentStateKey(root);
const getBaseline = (root: string): SyncBaseline | undefined => {
  const key = syncKey(root);
  const hit = baselines.get(key);
  if (hit) {
    baselines.delete(key);
    baselines.set(key, hit);
  }
  return hit;
};
const setBaseline = (root: string, baseline: SyncBaseline): void => {
  const key = syncKey(root);
  baselines.delete(key);
  baselines.set(key, baseline);
  while (baselines.size > AGENT_CACHE_LIMIT) {
    const oldest = baselines.keys().next().value!;
    baselines.delete(oldest);
    warmCache.delete(oldest);
    lastProbe.delete(oldest);
  }
};

export const resetSyncBaseline = (root: string): void => {
  const key = syncKey(root);
  baselines.delete(key);
  warmCache.delete(key);
  lastProbe.delete(key);
};

export const resetSyncBaselines = (): void => {
  baselines.clear();
  warmCache.clear();
  lastProbe.clear();
};

// Send-path drift probe TTL. The at-most-once-per-window git porcelain probe
// on before_agent_start trades external-edit freshness for responsiveness:
// consecutive pure-conversation sends inside the window cost ~0ms, and any
// positive hit defers the full compute to turn_end — the correctness backstop
// that always re-probes and re-builds. A miss in the window just means the
// next turn_end sees the drift a few hundred ms later, not a send-path hang.
const PROBE_TTL_MS = envInt("FOVEA_PROBE_TTL_MS", 1200, 200, 60_000);
const lastProbe = new Map<string, number>();

/**
 * Compare porcelain against the baseline's recorded content hashes. The raw
 * probe answers "dirty vs HEAD", which keeps firing after a warm verdict has
 * already absorbed the same uncommitted edit. Hashing only the porcelain
 * dirty files answers the question the send path needs: is there drift we
 * have not yet told the model about?
 */
const gitDriftSince = async (root: string, shas: Map<string, string>): Promise<boolean> => {
  const probe = await gitProbe(root);
  if (!probe) return false; // non-git roots fall back to turn_end's walk probe
  if (probe.relist) return true;
  for (const change of probe.changes) {
    const rel = change.path;
    if (rel.endsWith("/")) return true; // collapsed untracked dir: drift
    // Porcelain collapses submodule drift to the gitlink path, which names a
    // directory: content moved inside without a hash we can compare.
    const info = await currentRuntime().stat(executionPathJoin(root, rel)).catch(() => undefined);
    if (info?.type === "directory") return true;
    try {
      const bytes = await currentRuntime().readBytes(executionPathJoin(root, rel), 64 * 1024 * 1024);
      const sha = createHash("sha1").update(bytes).digest("hex");
      if (shas.get(rel) !== sha) return true;
    } catch {
      // A still-listed file that cannot be hashed is deleted or raced: real
      // drift when the baseline knew it.
      if (shas.has(rel)) return true;
    }
  }
  return false;
};

// Channel priors for the surprise gate. A cascade whose only evidence is a
// weak-prior channel (shared literal, co-change) must move proportionally
// more raw heat to steer. Reason labels mirror reasonFor() in ops.ts.
const CHANNEL_WEIGHT: Record<string, number> = {
  "call dependency": 1,
  "import dependency": 1,
  "test dependency": 1,
  "inheritance": 1,
  "shared route": 1,
  "co-change history": 0.5,
  "shared literal": 0.35,
  "graph path": 0.5,
};
// Unlabeled multi-hop warmth.
const CHANNEL_UNKNOWN = 0.5;
// Heat memory decays by the wall clock, not by sync count: within a session
// the half-life is effectively infinite, so a charged node stays silent no
// matter how many times its cascade is re-seeded (the ping-pong constructor
// dies here); across hours it finally cools, so a structurally re-heated
// neighborhood can earn a fresh verdict on a later day.
export const MEMORY_HALF_LIFE_HOURS = envInt("FOVEA_MEMORY_HALF_LIFE_HOURS", 48, 1, 8760);
const HALF_LIFE_MS = MEMORY_HALF_LIFE_HOURS * 3600_000;
export const decayedMass = (entry: { m: number; t: number }, nowMs: number): number =>
  entry.m * Math.pow(0.5, Math.max(0, nowMs - entry.t) / HALF_LIFE_MS);
// Ledger bound: prune cooled entries and cap size, evicting the weakest mass.
const MEMORY_MAX_NODES = 4096;
// Hysteresis re-arm band, as a fraction of the steer threshold.
const REARM_FRACTION = 0.5;
const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

// Background warm. The blocking `sync` call on the user-perceived send path
// (before_agent_start / turn_end) recomputes extraction, graph assembly, the
// baseline fingerprint, and the impact cascade whenever the repo drifted.
// `warmSync` runs those heavyweight ingredients eagerly as soon as edits land
// (tool_execution_end), keyed by state version + changed-file set, so the same
// drift's sync call reuses them and stays verdict-only. Never advances the
// baseline, never reports, never throws; a drift without a warm (external
// edits between turns) falls back to the inline compute in `sync`.

interface WarmCompute {
  /** State version this computation fingerprints. */
  version: string;
  /** Canonical key of the changed-file set this warm covers. */
  filesKey: string;
  /** Full next-baseline snapshot, identical to snapshot(state). */
  snapshot: SyncBaseline;
  /** impact() outputs for the changed set. */
  warmedFiles: string[];
  warmedMass: Record<string, number>;
  warmReasons: Record<string, string[]>;
  warmedNodes: Record<string, { file: string; m: number; r: string[] }>;
}

const warmCache = new Map<string, WarmCompute>();

/** Tests poll this to know a background warm actually landed (fixed sleeps
 * race the debounce + impact compute under load). */
export const warmCacheHas = (root: string): boolean => warmCache.has(syncKey(root));

const filesKey = (files: readonly string[]): string => [...new Set(files)].sort().join("\n");

/** Files whose extracted facts moved since a baseline, in canonical order. */
const semanticDrift = (state: RepoState, prev: SyncBaseline): string[] => {
  const changed = Object.keys(state.facts).filter(
    (file) => prev.shas.get(file) !== state.facts[file]!.sha1,
  );
  return changed.filter(
    (file) => prev.semantics.get(file) !== semanticFacts(state, file) && state.graph.byFile.has(file),
  );
};

export interface WarmParams {
  /** Optional drift hints, same role as sync hints; the probe stays the oracle. */
  files?: string[];
  /** Token budget for the impact cascade (mirrors sync.budget). */
  budget: number;
}

export const warmSync = async (root: string, params: WarmParams, state?: RepoState): Promise<void> => {
  try {
    const cur = state ?? (await ensureState(root, { hints: params.files ?? [], force: false }));
    const prev = getBaseline(root);
    if (!prev || prev.version === cur.version) return;
    // A checkout generation re-baselines silently in sync: no cascade to
    // prepare, and precomputing one over the branch diff would be waste.
    if (cur.checkout) return;
    const files = semanticDrift(cur, prev);
    if (!files.length) return;
    const key = filesKey(files);
    const cacheKey = syncKey(root);
    const cached = warmCache.get(cacheKey);
    if (cached && cached.version === cur.version && cached.filesKey === key) return;
    const next = await snapshot(cur);
    // The impact cascade runs against the same immutable state snapshot the
    // fingerprint used, so the cached pair is consistent for cur.version.
    const result = await impact(root, { files, includeUncommitted: false, budget: params.budget }, cur);
    warmCache.set(cacheKey, {
      version: cur.version,
      filesKey: key,
      snapshot: next,
      warmedFiles: (result.details.warmedFiles as string[] | undefined) ?? [],
      warmedMass: (result.details.warmedMass as Record<string, number> | undefined) ?? {},
      warmReasons: (result.details.warmedReasons as Record<string, string[]> | undefined) ?? {},
      warmedNodes: (result.details.warmedNodes as Record<string, { file: string; m: number; r: string[] }> | undefined) ?? {},
    });
    while (warmCache.size > AGENT_CACHE_LIMIT) warmCache.delete(warmCache.keys().next().value!);
  } catch {
    // Best-effort: a failed warm just means the next blocking sync computes
    // inline (with its own error reporting), exactly as before.
  }
};

export interface SyncParams {
  /** Optional drift hints (e.g. files touched by pi's edit/write tools this
   * turn). Unioned into the warmth seeds; never the source of truth. */
  files?: string[];
  budget: number;
  /** Total surprise (channel-adjusted cascade mass above the session heat
   * memory) that justifies proactive steering on warmth alone. Route and
   * deletion signals bypass it. */
  steerThreshold: number;
  /** Push vs pull (default push): embed the top file target's focus context. */
  pushFocus?: boolean;
  /** Agent-local attention by default; repository restores root-wide steering. */
  scope?: "session" | "repository";
  /** Integration-supplied top-level lineage attention; defaults to this runtime session. */
  attentionScopes?: readonly string[];
  /** DSH session identity used only as a hashed owner key for mutation attribution. */
  sessionId?: string;
}

export interface SyncOutcome {
  /** The graph version drifted since the last sync. */
  structural: boolean;
  /** Issues worth spending model tokens on. */
  red: boolean;
  text?: string;
  /** Immediate for current/mixed/unattributed work; deferred for another session. */
  delivery?: "steer" | "next-prompt";
  tokens: number;
  details: Record<string, unknown>;
}

type SemanticFact = RepoState["facts"][string];
const semanticCache = new WeakMap<SemanticFact, string>();

const semanticFacts = (state: RepoState, file: string): string => {
  const facts = state.facts[file];
  if (!facts) return "";
  const cached = semanticCache.get(facts);
  if (cached !== undefined) return cached;
  const stable = (rows: unknown[][]): string[] => rows.map((row) => JSON.stringify(row)).sort();
  const compactSig = (sig: string): string => sig.replace(/\s+/g, " ").trim();
  const value = JSON.stringify({
    symbols: stable(facts.symbols.map((symbol) => [symbol.name, symbol.kind, compactSig(symbol.sig), symbol.lang])),
    imports: stable(facts.imports.map((site) => [site.spec])),
    calls: stable(facts.calls.map((site) => [site.callee])),
    literals: stable(facts.literals.map((site) => [site.text])),
    anchors: stable(facts.anchors.map((anchor) => [anchor.id, anchor.kind, anchor.nodeId, anchor.implicit === true])),
    sigs: Object.entries(facts.sigs ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  });
  semanticCache.set(facts, value);
  return value;
};

const snapshot = async (state: RepoState): Promise<SyncBaseline> => {
  // The attribution boundary starts before asynchronous traversal so no edit
  // can be absent from the snapshot yet excluded by a later timestamp.
  const capturedAt = Date.now();
  const anchors = new Map<string, string>();
  await forEachChunked(state.graph.anchors, 256, (anchor) => anchors.set(anchor.id, anchor.file));
  const shas = new Map<string, string>();
  const semantics = new Map<string, string>();
  await forEachChunked(Object.entries(state.facts), 256, ([file, facts]) => {
    shas.set(file, facts.sha1);
    semantics.set(file, semanticFacts(state, file));
  });
  return { version: state.version, capturedAt, anchors, shas, semantics };
};

export const sync = async (
  root: string,
  params: SyncParams,
  now?: RepoState,
  opts?: { probe?: "cheap" | "full" | "defer" },
): Promise<SyncOutcome> => {
  if (params.sessionId && params.files?.length) await observeSessionPaths(root, params.files);
  let state = now;
  if (!state) {
    // Cold roots build in the background; a first answer beats a full build.
    // Hooks live on the TUI thread — the "indexing" outcome is how callers
    // learn to stay quiet this turn and let the background build land.
    const warm = getState(root);
    if (!warm) {
      if (!getInflight(root)) ensureStateBackground(root);
      return { structural: false, red: false, tokens: 0, details: { indexing: true } };
    }
    if (opts?.probe === "defer") {
      // The user-perceived send path never rebuilds. Nothing materialized
      // since the baseline: run the TTL-bounded porcelain probe to spot
      // out-of-band drift, and defer any hit to turn_end instead of paying
      // re-extraction + re-assembly while the UI waits. Materialized drift
      // (a background warm already rebuilt the resident state) falls through
      // to the normal verdict-or-defer logic below.
      const prev = getBaseline(root);
      if (prev && prev.version === warm.version) {
        const probeKey = syncKey(root);
        const due = Date.now() - (lastProbe.get(probeKey) ?? 0) >= PROBE_TTL_MS;
        if (due && (await gitDriftSince(root, prev.shas))) {
          lastProbe.set(probeKey, Date.now());
          return { structural: true, red: false, tokens: 0, details: { version: warm.version, deferred: true } };
        }
        if (due) lastProbe.set(probeKey, Date.now());
        return { structural: false, red: false, tokens: 0, details: { version: warm.version } };
      }
      state = warm;
    } else {
      state = await ensureState(root, {
        ...(params.files === undefined ? {} : { hints: params.files }),
        force: opts?.probe !== "cheap",
      });
    }
  }
  const prev = getBaseline(root);
  if (prev && prev.version === state.version) {
    return { structural: false, red: false, tokens: 0, details: { version: state.version } };
  }
  if (!prev) {
    setBaseline(root, await snapshot(state));
    return {
      structural: true, red: false, tokens: 0,
      details: { version: state.version, baseline: "established", anchors: state.graph.anchors.length },
    };
  }

  // Branch-switch re-baseline. A checkout moves HEAD and re-materializes the
  // worktree without authored edits; cascading over the branch diff would
  // fire a loud, useless steer on every switch, so the baseline just follows
  // the ref (details.baseline keeps the hooks' ack-clean notify silent too).
  // Heat memory belongs to the old ref's field and does not cross over.
  if (state.checkout) {
    setBaseline(root, await snapshot(state));
    return {
      structural: true, red: false, tokens: 0,
      details: { version: state.version, checkout: true, baseline: "established", anchors: state.graph.anchors.length },
    };
  }

  // Version drifted: measure what moved. Implicit (tier-3 discovered) hubs
  // churn is reported but NEVER escalates alone — hypotheses with no first-class
  // backing don't get to wake the model with a red verdict.
  const current = new Map(state.graph.anchors.map((a) => [a.id, a.implicit === true]));
  const currentCarrier = new Map(state.graph.anchors.map((a) => [a.id, a.file]));
  const currentIds = new Set(current.keys());
  const allAdded = [...currentIds].filter((id) => !prev.anchors.has(id));
  const allRemoved = [...prev.anchors.keys()].filter((id) => !currentIds.has(id));

  const session = getSession(root);
  const scopedSync = params.scope !== "repository" && params.sessionId !== undefined;
  const projectRoot = await isLogicalProjectRoot(root);
  const attention = new Set(params.attentionScopes ?? session.syncScopes);
  const attentionScopes = [...attention].sort();
  const relevantFile = (file: string | undefined): boolean => {
    if (!scopedSync) return true;
    if (!file) return false;
    const scope = syncScopeForPath(root, file, projectRoot);
    return scope !== undefined && attention.has(scope);
  };
  const added = allAdded.filter((id) => relevantFile(currentCarrier.get(id)));
  const removed = allRemoved.filter((id) => relevantFile(prev.anchors.get(id)));
  const newlyImplicit = added.filter((id) => current.get(id));

  const disclosedFiles = new Set<string>();
  for (const id of session.disclosed) {
    const at = id.indexOf("@");
    if (at >= 0) disclosedFiles.add(id.slice(at + 1));
  }

  // Index and baseline the whole root, but seed proactive consequences only
  // from logical directories this agent deliberately entered.
  const allChanged = Object.keys(state.facts).filter(
    (file) => prev.shas.get(file) !== state.facts[file]!.sha1,
  );
  const allSemanticChanged = semanticDrift(state, prev);
  const changed = allChanged.filter(relevantFile);
  const semanticChanged = allSemanticChanged.filter(relevantFile);
  const hinted = (params.files ?? []).filter((file) => semanticChanged.includes(file));
  // Fact gaps are usually degraded coverage, not deletion; provider stat is
  // the arbiter. Keep the whole-root set for baseline advancement, then scope.
  const allDeleted: string[] = [];
  for (const file of prev.shas.keys()) {
    if (file in state.facts) continue;
    const info = await currentRuntime().stat(executionPathJoin(state.root, file)).catch(() => undefined);
    if (!info) allDeleted.push(file);
  }
  const deleted = allDeleted.filter(relevantFile);
  const ignoredFiles = [...new Set([
    ...allChanged.filter((file) => !relevantFile(file)),
    ...allDeleted.filter((file) => !relevantFile(file)),
  ])].sort();
  const files = [...new Set([...semanticChanged, ...hinted])];

  // Coverage enrollment is not task drift. Adopt sibling-directory changes
  // silently so umbrella indexing stays broad without replaying them later.
  const outsideAttentionOnly = scopedSync && ignoredFiles.length > 0 &&
    changed.length === 0 && deleted.length === 0 && added.length === 0 && removed.length === 0;
  if (outsideAttentionOnly) {
    warmCache.delete(syncKey(root));
    setBaseline(root, {
      ...(await snapshot(state)),
      ...(prev.heat === undefined ? {} : { heat: prev.heat }),
      ...(prev.warmthArmed === undefined ? {} : { warmthArmed: prev.warmthArmed }),
      ...(prev.pushed === undefined ? {} : { pushed: prev.pushed }),
    });
    return {
      structural: true, red: false, tokens: 0,
      details: {
        version: state.version,
        outsideAttention: true,
        attentionScopes,
        ignoredFiles,
        changedFiles: [],
        semanticChangedFiles: [],
        deletedFiles: [],
      },
    };
  }

  const provenance: SyncProvenance | undefined = params.sessionId
    ? await attributeChanges(root, params.sessionId, prev.capturedAt, [
      ...changed.map((file) => ({
        file,
        ...(prev.shas.get(file) === undefined ? {} : { beforeSha: prev.shas.get(file)! }),
        afterSha: state.facts[file]!.sha1,
      })),
      ...deleted.map((file) => ({
        file,
        ...(prev.shas.get(file) === undefined ? {} : { beforeSha: prev.shas.get(file)! }),
      })),
    ])
    : undefined;

  let warmReasons: Record<string, string[]> = {};
  let warmNodes: Record<string, { file: string; m: number; r: string[] }> = {};
  let preparedBaseline: SyncBaseline | undefined;
  if (files.length) {
    // Edit-time `warmSync` may have precomputed the heavyweight ingredients —
    // the next baseline fingerprint and the impact cascade — so this blocking
    // hook only renders the verdict. Keyed by state version + changed set, a
    // stale warm (more drift landed since) falls through to the inline compute.
    const preparedKey = syncKey(root);
    const prepared = warmCache.get(preparedKey);
    const preparedHit =
      prepared !== undefined &&
      prepared.version === state.version &&
      prepared.filesKey === filesKey(files);
    if (preparedHit) {
      warmCache.delete(preparedKey);
      preparedBaseline = prepared.snapshot;
      warmReasons = prepared.warmReasons;
      warmNodes = prepared.warmedNodes;
    } else if (opts?.probe === "defer") {
      // No prepared verdict and real drift on the send path: never run the
      // impact cascade under the TUI's finger. Leave the baseline untouched
      // so turn_end's full sync (the cheap backstop) reports and steers it.
      return { structural: true, red: false, tokens: 0, details: { version: state.version, deferred: true } };
    } else {
      const result = await impact(root, { files, includeUncommitted: false, budget: params.budget });
      warmReasons = (result.details.warmedReasons as Record<string, string[]> | undefined) ?? {};
      warmNodes = (result.details.warmedNodes as Record<string, { file: string; m: number; r: string[] }> | undefined) ?? {};
    }
  }
  if (scopedSync) {
    warmReasons = Object.fromEntries(Object.entries(warmReasons).filter(([file]) => relevantFile(file)));
    warmNodes = Object.fromEntries(Object.entries(warmNodes).filter(([, hit]) => relevantFile(hit.file)));
  }

  // Surprise gate, per graph node. Warmth earns a steer only to the extent a
  // node's channel-adjusted mass exceeds what the ledger already holds for it
  // (wall-clock decayed). A re-seeded charged node contributes ~nothing — the
  // ping-pong constructor dies here; a novel node in a familiar file still
  // fires; and structurally re-heated neighborhoods re-fire once the ledger
  // cools past the half-life. Novelty is continuous, not a set difference.
  const nowMs = Date.now();
  const nodeMass = (hit: { m: number; r: string[] }): number => {
    let prior = 0;
    for (const reason of hit.r) prior = Math.max(prior, CHANNEL_WEIGHT[reason] ?? CHANNEL_UNKNOWN);
    return hit.m * (prior || CHANNEL_UNKNOWN);
  };
  // Age the ledger forward. Entries whose cooled mass is noise are pruned;
  // the bound evicts the weakest survivors, never the freshest charges.
  const memory = new Map<string, { m: number; t: number }>();
  for (const [key, entry] of prev.heat ?? []) {
    const cooled = decayedMass(entry, nowMs);
    if (cooled > 1e-9) memory.set(key, { m: cooled, t: nowMs });
  }
  if (memory.size > MEMORY_MAX_NODES) {
    const ranked = [...memory.entries()].sort((a, b) => a[1].m - b[1].m);
    for (const [key] of ranked.slice(0, memory.size - MEMORY_MAX_NODES)) memory.delete(key);
  }
  const surprise = new Map<string, number>(); // file -> Σ node surprise
  let surpriseTotal = 0;
  for (const [key, hit] of Object.entries(warmNodes)) {
    if (disclosedFiles.has(hit.file) || files.includes(hit.file)) continue;
    const delta = nodeMass(hit) - (memory.get(key)?.m ?? 0);
    if (delta > 1e-9) {
      surprise.set(hit.file, (surprise.get(hit.file) ?? 0) + delta);
      surpriseTotal += delta;
    }
  }

  const pushed = new Set(prev.pushed ?? []);
  // Extraction failures leave fact gaps that look like anchor *removals* —
  // never escalate red on removals while degraded; the degraded note is
  // already loud in details. Beyond degradation, an anchor delta whose
  // carrier file shows no content/semantic drift is an extraction artifact
  // even with a clean failure ledger: escalate and list only deltas whose
  // carriers actually moved. The baseline adopts the full new set either
  // way, so a transient artifact self-heals permanently (no echo loops).
  const degraded = state.extraction.failed.length > 0;
  const evidence = new Set([...changed, ...semanticChanged, ...deleted]);
  const suspectRemoved = removed.filter((id) => !evidence.has(prev.anchors.get(id) ?? ""));
  const suspectAdded = added.filter((id) => !evidence.has(currentCarrier.get(id) ?? ""));
  const evidentialAdded = added.filter((id) => !suspectAdded.includes(id));
  const evidentialRemoved = removed.filter((id) => !suspectRemoved.includes(id));
  const structuralRed = (evidentialAdded.length - newlyImplicit.length) > 0 ||
    (evidentialRemoved.length > 0 && !degraded) ||
    deleted.some((file) => !isTestScope(file));
  const prevArmed = prev.warmthArmed !== false;
  const warmthFire = prevArmed && surpriseTotal >= params.steerThreshold;
  const red = structuralRed || warmthFire;
  const upstream = provenance?.kind === "other-session";
  const delivery: SyncOutcome["delivery"] = upstream ? "next-prompt" : "steer";
  // Hysteresis: a red sync discloses its whole cascade, so the latch disarms
  // until total surprise drops into the re-arm fraction of the threshold.
  const warmthArmed = red ? false : prevArmed || surpriseTotal <= params.steerThreshold * REARM_FRACTION;
  // Absorb on disclosure: every warmed file the message covers charges the
  // memory at its current adjusted mass, displayed or not.
  if (red) {
    for (const [key, hit] of Object.entries(warmNodes)) {
      if (disclosedFiles.has(hit.file) || files.includes(hit.file)) continue;
      const adjusted = nodeMass(hit);
      if (adjusted > (memory.get(key)?.m ?? 0)) memory.set(key, { m: adjusted, t: nowMs });
    }
  }
  const orderedWarm = [...surprise.entries()]
    .sort((a, b) => b[1] - a[1] || Number(isTestScope(a[0])) - Number(isTestScope(b[0])) || a[0].localeCompare(b[0]))
    .map(([file]) => file);
  setBaseline(root, {
    ...(preparedBaseline ?? (await snapshot(state))),
    ...(memory.size ? { heat: memory } : {}),
    warmthArmed,
    pushed,
  });
  if (!red) {
    return {
      structural: true, red: false, tokens: 0,
      details: {
        version: state.version,
        anchorsDelta: added.length - removed.length,
        warmNew: orderedWarm.length,
        surprise: round4(surpriseTotal),
        changedFiles: changed,
        semanticChangedFiles: files,
        deletedFiles: deleted,
        ...(scopedSync ? { attentionScopes, ignoredFiles } : {}),
        ...(provenance ? { provenance } : {}),
        ...(suspectAdded.length || suspectRemoved.length
          ? { suspectAnchors: { added: suspectAdded, removed: suspectRemoved } }
          : {}),
        ...(degraded ? { extractionDegraded: true } : {}),
      },
    };
  }

  const changedSummary = files.length
    ? `${files.slice(0, 4).join(", ")}${files.length > 4 ? ` (+${files.length - 4} more)` : ""}`
    : deleted.length
      ? `deleted ${deleted.slice(0, 4).join(", ")}${deleted.length > 4 ? ` (+${deleted.length - 4} more)` : ""}`
      : "route structure";
  const origin = provenance?.kind === "current-session"
    ? "current session"
    : provenance?.kind === "other-session"
      ? "another agent session"
      : provenance?.kind === "mixed"
        ? "mixed sessions or mutation paths"
        : "unattributed mutation path";
  const lines: string[] = [
    "Repository structure changed.",
    `Changed: ${changedSummary}`,
    ...(provenance ? [`Origin: ${origin}.`] : []),
  ];
  for (const id of evidentialAdded.filter((anchor) => !newlyImplicit.includes(anchor)).slice(0, 6)) {
    lines.push(`Route added: ${id}`);
  }
  // Degraded or carrier-less removals are suspect (extraction gaps look like
  // removals); the escalation gate already distrusts them, the message does.
  if (!degraded) for (const id of evidentialRemoved.slice(0, 6)) lines.push(`Route removed: ${id}`);
  if (orderedWarm.length) {
    lines.push("Newly relevant files:");
    for (const file of orderedWarm.slice(0, 8)) {
      lines.push(`  ${file} — ${(warmReasons[file] ?? ["graph path"]).join(", ")}`);
    }
  }
  // Push vs pull on the consequence probe. A file target gets its refreshed
  // focus context embedded inline (the embed discloses it, so any follow-up
  // probe is a session delta and nearly free); each target embeds at most
  // once per baseline chain. Route targets keep the advisory pending route
  // fuzzy-match quality, and the no-target case stays verdict-only. Pull
  // mode renders the advisory unconditionally.
  const focusTarget = evidentialAdded.find((id) => !newlyImplicit.includes(id))?.replace(/^\w+\s+(?=\/)/, "")
    ?? files[0]
    ?? orderedWarm[0];
  const pushFocus = params.pushFocus !== false;
  const steerLine = upstream
    ? "Notice: another agent changed this active area; account for it on the next prompt."
    : "Steer: account for this update before continuing.";
  let embedded = false;
  if (pushFocus && focusTarget && focusTarget in state.facts && !pushed.has(focusTarget)) {
    const detailBudget = params.budget - Math.ceil([...lines, steerLine].join("\n").length / 4);
    if (detailBudget >= 128) {
      try {
        // Reuse the state this verdict was computed against: both the warmed
        // path and the inline path hold a current build, and the embed must
        // not trigger its own probe/rebuild under the send path.
        const detail = await focus(root, focusTarget, detailBudget, undefined, state);
        if (detail.text.trim()) {
          lines.push(...detail.text.split("\n"));
          pushed.add(focusTarget);
          embedded = true;
        }
      } catch {
        // Focus is best-effort context; fall through to the advisory.
      }
    }
  }
  if (!embedded && (!pushFocus || focusTarget)) {
    lines.push(focusTarget
      ? `Next: fovea_focus ${JSON.stringify(focusTarget)} to see what it now connects to.`
      : "Next: fovea_sketch for the updated silhouette.");
  }
  lines.push(steerLine);
  while (lines.length > 3 && Math.ceil(lines.join("\n").length / 4) > params.budget) {
    lines.splice(lines.length - 2, 1);
  }
  const text = lines.join("\n");
  return {
    structural: true, red: true, text, delivery, tokens: Math.ceil(text.length / 4),
    details: {
      version: state.version,
      added,
      removed,
      changedFiles: changed,
      semanticChangedFiles: files,
      warmNew: orderedWarm,
      surprise: round4(surpriseTotal),
      warmReasons,
      deletedFiles: deleted,
      ...(scopedSync ? { attentionScopes, ignoredFiles } : {}),
      ...(provenance ? { provenance } : {}),
      ...(embedded ? { pushedFocus: focusTarget } : {}),
      ...(degraded ? { extractionDegraded: true } : {}),
    },
  };
};
