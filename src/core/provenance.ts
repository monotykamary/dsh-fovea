import { createHash } from "node:crypto";
import { currentRuntime, executionPathResolve, executionRelativePath, workspaceStateKey } from "../runtime.js";

const JOURNAL_VERSION = 1;
const JOURNAL_TTL_MS = 7 * 24 * 3600_000;
const JOURNAL_MAX_RECORDS = 2048;

interface MutationRecord {
  file: string;
  beforeSha?: string;
  afterSha?: string;
  owner: string;
  toolCallId: string;
  at: number;
}

interface MutationJournal {
  version: number;
  root: string;
  records: MutationRecord[];
}

export interface MutationCapture {
  root: string;
  file: string;
  absolutePath: string;
  beforeSha?: string;
}

export interface MutationTransition {
  path: string;
  beforeSha?: string | undefined;
  afterSha?: string | undefined;
}

type ProvenanceKind = "current-session" | "other-session" | "mixed" | "unattributed";

export interface SyncProvenance {
  kind: ProvenanceKind;
  files: Record<string, ProvenanceKind>;
}

const sha1 = (value: string): string => createHash("sha1").update(value).digest("hex");
const ownerFor = (sessionId: string): string => sha1(sessionId).slice(0, 16);
const rootKey = (root: string): string => sha1(`${workspaceStateKey(root)}\0${root}`).slice(0, 16);
const keyFor = (root: string): string => `provenance-${rootKey(root)}.json`;

/** Opaque runtime cache key; sessionId remains accepted for API compatibility. */
export const provenancePathFor = (root: string, _sessionId: string): string => keyFor(root);

const hashFile = async (path: string): Promise<string | undefined> => {
  try {
    return createHash("sha1").update(await currentRuntime().readBytes(path, 64 * 1024 * 1024)).digest("hex");
  } catch {
    return undefined;
  }
};

const repoPath = (root: string, path: string): { file: string; absolutePath: string } | undefined =>
  executionRelativePath(root, path);

export const captureMutation = async (root: string, path: string): Promise<MutationCapture | undefined> => {
  const located = repoPath(root, path);
  if (!located) return undefined;
  const beforeSha = await hashFile(located.absolutePath);
  return { root: executionPathResolve(root), ...located, ...(beforeSha === undefined ? {} : { beforeSha }) };
};

const writeQueues = new Map<string, Promise<void>>();

const persistRecords = async (target: string, root: string, additions: readonly MutationRecord[]): Promise<void> => {
  const cutoff = Date.now() - JOURNAL_TTL_MS;
  let records: MutationRecord[] = [];
  try {
    const text = await currentRuntime().readCache(target, 16 * 1024 * 1024);
    if (text !== undefined) {
      const existing = JSON.parse(text) as MutationJournal;
      if (existing.version === JOURNAL_VERSION && existing.root === root && Array.isArray(existing.records)) {
        records = existing.records.filter((item) => item.at >= cutoff);
      }
    }
  } catch {
    // Missing and torn journals both recover as a fresh workspace journal.
  }
  records.push(...additions);
  await currentRuntime().writeCache(target, JSON.stringify({
    version: JOURNAL_VERSION,
    root,
    records: records.slice(-JOURNAL_MAX_RECORDS),
  } satisfies MutationJournal));
};

export const recordMutationTransitions = async (
  root: string,
  transitions: readonly MutationTransition[],
  sessionId: string,
  toolCallId: string,
): Promise<number> => {
  const resolvedRoot = executionPathResolve(root);
  const owner = ownerFor(sessionId);
  const at = Date.now();
  const records = transitions.flatMap((transition): MutationRecord[] => {
    const located = repoPath(root, transition.path);
    if (!located || transition.beforeSha === transition.afterSha) return [];
    return [{
      file: located.file,
      ...(transition.beforeSha === undefined ? {} : { beforeSha: transition.beforeSha }),
      ...(transition.afterSha === undefined ? {} : { afterSha: transition.afterSha }),
      owner,
      toolCallId,
      at,
    }];
  });
  if (records.length === 0) return 0;
  const target = provenancePathFor(resolvedRoot, sessionId);
  const previous = writeQueues.get(target) ?? Promise.resolve();
  const queued = previous.catch(() => {}).then(() => persistRecords(target, resolvedRoot, records));
  writeQueues.set(target, queued);
  try {
    await queued;
    return records.length;
  } finally {
    if (writeQueues.get(target) === queued) writeQueues.delete(target);
  }
};

export const recordMutationTransition = async (
  root: string,
  path: string,
  beforeSha: string | undefined,
  afterSha: string | undefined,
  sessionId: string,
  toolCallId: string,
): Promise<boolean> => (await recordMutationTransitions(
  root, [{ path, beforeSha, afterSha }], sessionId, toolCallId,
)) === 1;

export const finishMutation = async (
  capture: MutationCapture,
  sessionId: string,
  toolCallId: string,
): Promise<boolean> => recordMutationTransition(
  capture.root, capture.file, capture.beforeSha, await hashFile(capture.absolutePath), sessionId, toolCallId,
);

const readRecords = async (root: string, since: number): Promise<MutationRecord[]> => {
  const target = keyFor(root);
  await writeQueues.get(target)?.catch(() => {});
  const cutoff = Math.max(since, Date.now() - JOURNAL_TTL_MS);
  try {
    const text = await currentRuntime().readCache(target, 16 * 1024 * 1024);
    if (text === undefined) return [];
    const journal = JSON.parse(text) as MutationJournal;
    if (journal.version !== JOURNAL_VERSION || journal.root !== executionPathResolve(root) || !Array.isArray(journal.records)) return [];
    const records = journal.records.filter((record) => record.at >= cutoff);
    if (!records.length && journal.records.every((record) => record.at < Date.now() - JOURNAL_TTL_MS)) {
      await currentRuntime().deleteCache(target).catch(() => {});
    }
    return records.sort((a, b) => a.at - b.at || a.toolCallId.localeCompare(b.toolCallId));
  } catch {
    return [];
  }
};

const kindForOwners = (owners: Set<string>, currentOwner: string): ProvenanceKind => {
  if (!owners.size) return "unattributed";
  if (owners.size === 1) return owners.has(currentOwner) ? "current-session" : "other-session";
  return "mixed";
};

const ownersForTransition = (
  records: MutationRecord[],
  beforeSha: string | undefined,
  afterSha: string | undefined,
): Set<string> => {
  const states = new Map<string, Set<string>>();
  const key = (sha: string | undefined): string => sha ?? "\0deleted";
  states.set(key(beforeSha), new Set());
  for (const record of records) {
    const owners = states.get(key(record.beforeSha));
    if (!owners) continue;
    const nextKey = key(record.afterSha);
    const next = states.get(nextKey) ?? new Set<string>();
    for (const owner of owners) next.add(owner);
    next.add(record.owner);
    states.set(nextKey, next);
  }
  return states.get(key(afterSha)) ?? new Set();
};

export const attributeChanges = async (
  root: string,
  sessionId: string,
  since: number,
  changes: Array<{ file: string; beforeSha?: string; afterSha?: string }>,
): Promise<SyncProvenance> => {
  const records = await readRecords(root, since);
  const recordsByFile = new Map<string, MutationRecord[]>();
  for (const record of records) {
    const matching = recordsByFile.get(record.file) ?? [];
    matching.push(record);
    recordsByFile.set(record.file, matching);
  }
  const currentOwner = ownerFor(sessionId);
  const files: Record<string, ProvenanceKind> = {};
  for (const change of changes) {
    files[change.file] = kindForOwners(
      ownersForTransition(recordsByFile.get(change.file) ?? [], change.beforeSha, change.afterSha),
      currentOwner,
    );
  }
  const kinds = new Set(Object.values(files));
  return {
    kind: kinds.size === 0 ? "unattributed" : kinds.size === 1 ? [...kinds][0]! : "mixed",
    files,
  };
};
