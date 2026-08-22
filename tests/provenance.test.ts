import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attributeChanges,
  captureMutation,
  finishMutation,
  provenancePathFor,
  recordMutationTransition,
  recordMutationTransitions,
} from "../src/core/provenance.js";
import { inNodeRuntime } from "./helpers/runtime.js";

const hash = (text: string): string => createHash("sha1").update(text).digest("hex");
const roots: string[] = [];

const rootWithFile = (content = "one\n"): { root: string; file: string } => {
  const root = mkdtempSync(join(tmpdir(), "dsh-fovea-provenance-test-"));
  const file = join(root, "file.ts");
  writeFileSync(file, content);
  roots.push(root);
  return { root, file };
};

const mutate = async (root: string, file: string, sessionId: string, next: string, toolCallId: string): Promise<void> => {
  const capture = await inNodeRuntime(root, (processRoot) => captureMutation(processRoot, file));
  expect(capture).toBeDefined();
  writeFileSync(file, next);
  expect(await inNodeRuntime(root, () => finishMutation(capture!, sessionId, toolCallId))).toBe(true);
};

const attribute = <T extends Array<{ file: string; beforeSha?: string; afterSha?: string }>>(
  root: string,
  sessionId: string,
  changes: T,
) => inNodeRuntime(root, (processRoot) => attributeChanges(processRoot, sessionId, 0, changes));

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await inNodeRuntime(root, async (processRoot, runtime) =>
      runtime.deleteCache(provenancePathFor(processRoot, "cleanup")));
    rmSync(root, { recursive: true, force: true });
  }
});

describe("sync provenance", () => {
  it("attributes an exact content transition to the current or another session", async () => {
    const { root, file } = rootWithFile();
    await mutate(root, file, "session-a", "two\n", "tool-a");

    const change = [{ file: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n") }];
    await expect(attribute(root, "session-a", change)).resolves.toEqual({
      kind: "current-session",
      files: { "file.ts": "current-session" },
    });
    await expect(attribute(root, "session-b", change)).resolves.toEqual({
      kind: "other-session",
      files: { "file.ts": "other-session" },
    });
  });

  it("attributes an explicit trusted hash transition", async () => {
    const { root, file } = rootWithFile();
    await expect(inNodeRuntime(root, (processRoot) => recordMutationTransition(
      processRoot, file, hash("one\n"), hash("two\n"), "session-a", "receipt-a",
    ))).resolves.toBe(true);
    await expect(attribute(root, "session-a", [{
      file: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n"),
    }])).resolves.toEqual({ kind: "current-session", files: { "file.ts": "current-session" } });
  });

  it("persists one multi-file receipt batch with one cache read and write", async () => {
    const { root } = rootWithFile();
    writeFileSync(join(root, "other.ts"), "alpha\n");
    await inNodeRuntime(root, async (processRoot, runtime) => {
      const readCache = vi.spyOn(runtime, "readCache");
      const writeCache = vi.spyOn(runtime, "writeCache");
      await expect(recordMutationTransitions(processRoot, [
        { path: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n") },
        { path: "other.ts", beforeSha: hash("alpha\n"), afterSha: hash("beta\n") },
      ], "session-a", "receipt-batch")).resolves.toBe(2);
      expect(readCache).toHaveBeenCalledTimes(1);
      expect(writeCache).toHaveBeenCalledTimes(1);
    });
    await expect(attribute(root, "session-a", [
      { file: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n") },
      { file: "other.ts", beforeSha: hash("alpha\n"), afterSha: hash("beta\n") },
    ])).resolves.toEqual({
      kind: "current-session",
      files: { "file.ts": "current-session", "other.ts": "current-session" },
    });
  });

  it("reports a transition chain owned by multiple sessions as mixed", async () => {
    const { root, file } = rootWithFile();
    await mutate(root, file, "session-a", "two\n", "tool-a");
    await mutate(root, file, "session-b", "three\n", "tool-b");

    const result = await attribute(root, "session-a", [{
      file: "file.ts",
      beforeSha: hash("one\n"),
      afterSha: hash(readFileSync(file, "utf8")),
    }]);
    expect(result).toEqual({ kind: "mixed", files: { "file.ts": "mixed" } });
  });

  it("leaves uninstrumented writes unattributed", async () => {
    const { root, file } = rootWithFile();
    writeFileSync(file, "external\n");
    await expect(attribute(root, "session-a", [{
      file: "file.ts",
      beforeSha: hash("one\n"),
      afterSha: hash("external\n"),
    }])).resolves.toEqual({
      kind: "unattributed",
      files: { "file.ts": "unattributed" },
    });
  });

  it("rejects provider paths that escape the repository", async () => {
    const { root } = rootWithFile();
    await expect(inNodeRuntime(root, (processRoot) => captureMutation(processRoot, "../outside.ts"))).resolves.toBeUndefined();
  });
});
