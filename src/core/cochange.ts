// Git-history co-change as a heat memory, not a structural bond.
//
// Heat diffusion over the static graph says what is near what BY
// CONSTRUCTION (imports, calls, routes, literals). Joint git history says
// what ACTUALLY moves together — the signal `impact` needs when two files
// share no static edge but are always edited in the same commits.
//
// Under the all-in heat model that signal is a seeded field, not permanent
// structure. Each (a, b) pair records the count of joint commits and the
// committer timestamp of the most recent one; at wall-clock `now` its
// contribution is
//
//     w = w0(count, jaccard) * 2^(-ageDays / COCHANGE_HALF_LIFE_DAYS)
//
// the same geometric-decay family as the sync heat memory (mu <- 0.7 mu).
// A pair that last moved together days ago is hot; one from months ago adds
// almost nothing. Nothing pins history into the graph, so old co-work cools
// out of the field exactly like every other heat source.
//
// Bounded by commit window and per-file pair caps; the raw facts (count +
// lastTs) are cached by HEAD + tracked-file set, and recency is applied at
// USE time so even a cached hit cools as the wall clock advances.

import { createHash } from "node:crypto";
import { currentRuntime } from "../runtime.js";
import { envInt } from "./asyncutil.js";
import { gitHead, gitOut, gitPrefix, gitRelativePath } from "./git.js";

const LOG_COMMITS = 400;
const MAX_FILES_PER_COMMIT = 24; // squashed monsters carry no pair signal
const MIN_SHARED = 2;            // a single collision is noise
const MAX_PAIRS_PER_FILE = 16;   // cap each file's history fan-out

/** Wall-clock half-life (days) of a co-change pair. Past joint work cools
 * with exponential decay; FOVEA_COCHANGE_HALF_LIFE_DAYS tunes how fast. */
export const COCHANGE_HALF_LIFE_DAYS = envInt("FOVEA_COCHANGE_HALF_LIFE_DAYS", 30, 1, 3650);

export interface CoChangePartner {
  /** Partner file (repo-relative), the other end of the history bond. */
  partner: string;
  /** Base conductance from count + Jaccard, BEFORE recency decay. */
  w: number;
  /** Committer epoch ms of the most recent joint commit of this pair. */
  lastTs: number;
}

/** Per-file history memory: file -> past co-change partners. Raw facts only;
 * recency is applied when the field is seeded (see recencyFactor). */
export type CoChangeHistory = Map<string, CoChangePartner[]>;

/** Freshness of a past joint commit: 1 when it just happened, 1/2 at one
 * half-life, ~0 once the work is ancient. Same geometric family as the sync
 * memory decay (mu <- 0.7 mu); the heat kernel's own e^{-tL} is the decay of
 * the diffusing field itself. */
export const recencyFactor = (ageDays: number): number =>
  Math.pow(0.5, ageDays / COCHANGE_HALF_LIFE_DAYS);

/** Effective seeding weight of a pair whose newest joint commit is ageDays
 * old. */
export const effectiveWeight = (baseW: number, ageDays: number): number =>
  baseW * recencyFactor(ageDays);

/** Base conductance: Jaccard-tilted confidence, mildly compressed by count so
 * a pair changed 40 times beats one changed twice without swampg the graph. */
export const scorePair = (n: number, soloA: number, soloB: number): number => {
  const union = soloA + soloB - n;
  if (union <= 0) return 0;
  const jaccard = n / union;
  return Math.min(0.5, 0.08 + 0.55 * jaccard + 0.10 * Math.min(n / 10, 1));
};

interface CacheShape {
  v: number;
  head: string;
  key: string;
  pairs: Array<[string, string, number, number]>;
}

const cachePath = (root: string): string =>
  `cochange-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`;

// coChangeHistory returns, for every tracked file, its past co-change partners
// with base conductance and the most recent joint commit time. filesInGraph
// restricts to files we actually track, so vendored churn is excluded.
export const coChangeHistory = async (
  root: string,
  filesInGraph: string[],
  now = Date.now(),
): Promise<CoChangeHistory> => {
  const head = (await gitHead(root)) ?? "";
  if (!head) return new Map(); // not a git repo
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return new Map();
  const tracked = new Set(filesInGraph);
  const key = createHash("sha1").update([...tracked].sort().join("\n")).digest("hex").slice(0, 12);
  const cp = cachePath(root);
  try {
    const text = await currentRuntime().readCache(cp, 16 * 1024 * 1024);
    if (text !== undefined) {
      const cached = JSON.parse(text) as CacheShape;
      if (cached.v === 2 && cached.head === head && cached.key === key) return groupPairs(cached.pairs);
    }
  } catch { /* recompute */ }

  const log = await gitOut(root, ["log", "--format=%x00%ct", "--numstat", "-n", String(LOG_COMMITS), "--no-renames", "--diff-filter=AMR", "--", "."]) ?? "";
  // numstat lines: "<added>\t<deleted>\t<file>"; each commit begins with a NUL
  // line carrying its committer timestamp (%ct).
  const pairCount = new Map<string, number>();
  const pairLast = new Map<string, number>();
  const soloCount = new Map<string, number>();
  let cur: string[] = [];
  let curTs = 0;
  const flush = (): void => {
    const fs = [...new Set(cur)].filter((f) => tracked.has(f));
    cur = [];
    if (fs.length < 2 || fs.length > MAX_FILES_PER_COMMIT) return;
    fs.sort();
    for (const f of fs) soloCount.set(f, (soloCount.get(f) ?? 0) + 1);
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        const k = `${fs[i]}|${fs[j]}`;
        pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
        if (curTs) pairLast.set(k, Math.max(pairLast.get(k) ?? 0, curTs));
      }
    }
  };
  for (const line of log.split("\n")) {
    if (!line.trim()) continue;
    if (line.includes("\0")) {
      flush();
      const ts = Number(line.slice(line.indexOf("\0") + 1).trim());
      if (Number.isFinite(ts)) curTs = ts * 1000;
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const secondTab = line.indexOf("\t", tab + 1);
    if (secondTab < 0) continue;
    const file = gitRelativePath(line.slice(secondTab + 1).trim(), prefix);
    if (file) cur.push(file);
  }
  flush();

  const scored: Array<[string, string, number, number]> = [];
  for (const [k, n] of pairCount) {
    if (n < MIN_SHARED) continue;
    const [a, b] = k.split("|") as [string, string];
    const w = scorePair(n, soloCount.get(a) ?? 0, soloCount.get(b) ?? 0);
    if (w <= 0) continue;
    scored.push([a, b, w, pairLast.get(k) ?? 0]);
  }

  // Keeper filter: per-file top partners by EFFECTIVE hotness (recency
  // included at compute time), so a fresh-but-weak pair outranks an ancient
  // strong one. The surviving raw facts keep their lastTs so later use still
  // cools them further as the wall clock advances.
  const perFile = new Map<string, number[]>();
  scored.forEach((p, i) => {
    for (const f of [p[0], p[1]]) (perFile.get(f) ?? perFile.set(f, []).get(f)!).push(i);
  });
  const eff = (p: [string, string, number, number]): number =>
    p[2] * recencyFactor(Math.max(0, now - p[3]) / 86_400_000);
  const keep = new Set<number>();
  for (const [, idxs] of perFile) {
    idxs.sort((x, y) => eff(scored[y]!) - eff(scored[x]!));
    for (const i of idxs.slice(0, MAX_PAIRS_PER_FILE)) keep.add(i);
  }
  const pairs = scored.filter((_, i) => keep.has(i));

  try {
    await currentRuntime().writeCache(cp, JSON.stringify({ v: 2, head, key, pairs } satisfies CacheShape));
  } catch { /* cache is an optimization */ }
  return groupPairs(pairs);
};

const groupPairs = (pairs: Array<[string, string, number, number]>): CoChangeHistory => {
  const out: CoChangeHistory = new Map();
  const push = (a: string, b: string, w: number, lastTs: number): void => {
    const list = out.get(a);
    if (list) list.push({ partner: b, w, lastTs });
    else out.set(a, [{ partner: b, w, lastTs }]);
  };
  for (const [a, b, w, lastTs] of pairs) {
    push(a, b, w, lastTs);
    push(b, a, w, lastTs);
  }
  return out;
};
