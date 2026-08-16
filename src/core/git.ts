// Async git plumbing for drift probes and history mining. Every call goes
// through execFile behind the shared spawn gate: pi's event loop is the UI,
// so even a 50ms spawnSync per turn is a hang tax we no longer pay.

import { ROOT_CACHE_LIMIT, spawnGate } from "./asyncutil.js";
import { currentRuntime, workspaceStateKey } from "../runtime.js";

const GIT_TIMEOUT = 15_000;

/** Run git, returning stdout or undefined on any failure (not a repo, timeout). */
export const gitOut = async (
  root: string,
  args: string[],
  opts: { timeout?: number; maxBuffer?: number } = {},
): Promise<string | undefined> =>
  spawnGate.run(async () => {
    const result = await currentRuntime().run(
      ["git", "-C", root, ...args],
      { timeoutMs: opts.timeout ?? GIT_TIMEOUT, maxBytes: opts.maxBuffer ?? 64 * 1024 * 1024 },
    );
    return result.exitCode === 0 && !result.timedOut && !result.aborted && !result.stdoutTruncated
      ? result.stdout
      : undefined;
  });

export const gitHead = async (root: string): Promise<string | undefined> => {
  const out = await gitOut(root, ["rev-parse", "HEAD"]);
  const head = out?.trim();
  return head ? head : undefined;
};

/**
 * Subject of the most recent HEAD reflog entry, e.g. "checkout: moving from
 * main to feature". Tells branch switches (re-baseline quietly) apart from
 * commits/pulls/rebases (foreign drift worth reporting). Undefined when the
 * reflog is unavailable or disabled — callers fall back to the loud path.
 */
export const gitReflogAction = async (root: string): Promise<string | undefined> => {
  const out = await gitOut(root, ["reflog", "-1", "--format=%gs"]);
  const line = out?.trim();
  return line ? line : undefined;
};

interface WorktreeChange {
  /** X+Y status columns, e.g. " M", "??", "D ". */
  code: string;
  /** Path as reported by git, relative to root. */
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
}

/**
 * Cheap drift probe: HEAD + `status --porcelain -z`.
 * Returns undefined when root is not (inside) a git work tree.
 * Any parse surprise yields `relist: true` so callers can fall back to a
 * full rescan instead of trusting partial change sets.
 */
export interface GitProbe {
  head: string;
  changes: WorktreeChange[];
  relist: boolean;
}

const gitPrefixes = new Map<string, string>();
export const gitPrefix = async (root: string): Promise<string | undefined> => {
  const key = workspaceStateKey(root);
  if (gitPrefixes.has(key)) {
    const hit = gitPrefixes.get(key)!;
    gitPrefixes.delete(key);
    gitPrefixes.set(key, hit);
    return hit;
  }
  const out = await gitOut(root, ["rev-parse", "--show-prefix"]);
  if (out === undefined) return undefined;
  const prefix = out.trim().replace(/\\/g, "/");
  gitPrefixes.delete(key);
  gitPrefixes.set(key, prefix);
  while (gitPrefixes.size > ROOT_CACHE_LIMIT) gitPrefixes.delete(gitPrefixes.keys().next().value!);
  return prefix;
};

export const gitRelativePath = (path: string, prefix: string): string | undefined => {
  const normalized = path.replace(/\\/g, "/");
  if (!prefix) return normalized;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
};

export const gitProbe = async (root: string): Promise<GitProbe | undefined> => {
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return undefined;
  const out = await gitOut(root, [
    "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames", "--", ".",
  ]);
  if (out === undefined) return undefined;
  const head = (await gitHead(root)) ?? "";
  const fields = out.split("\0").filter((f) => f.length > 0);
  const changes: WorktreeChange[] = [];
  let relist = false;
  for (const field of fields) {
    if (field.length < 4) {
      relist = true;
      continue;
    }
    const code = field.slice(0, 2);
    const path = gitRelativePath(field.slice(3), prefix);
    if (!path) {
      relist = true;
      continue;
    }
    // --no-renames keeps the format to a single path per record; anything
    // else unexpected marks the probe unreliable rather than lossy.
    if (!/^[ MARCUD?!]{2}$/.test(code)) relist = true;
    changes.push({ code, path });
  }
  return { head, changes, relist };
};

/** Files differing from the index/HEAD or untracked, for impact seeding. */
export const uncommittedFiles = async (root: string): Promise<string[]> => {
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return [];
  const out = await gitOut(root, ["status", "--porcelain", "-z", "--no-renames", "--", "."]);
  if (!out) return [];
  return out
    .split("\0")
    .filter(Boolean)
    .map((entry) => gitRelativePath(entry.slice(3), prefix))
    .filter((path): path is string => !!path);
};

export const prFiles = async (root: string, base: string): Promise<string[]> => {
  const prefix = await gitPrefix(root);
  if (prefix === undefined) return [];
  const out = await gitOut(root, ["diff", "--name-only", `${base}...HEAD`, "--", "."]);
  return out
    ? out.split("\n").map((s) => gitRelativePath(s.trim(), prefix)).filter((s): s is string => !!s)
    : [];
};
