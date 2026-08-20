// Turn-sync verdicts. Copies the fixture into a temp git repo, establishes
// the baseline, then drives drifts the way the turn_end hook would.

import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureState, getState } from "../src/core/ops.js";
import type { RepoState } from "../src/core/ops.js";
import { decayedMass, MEMORY_HALF_LIFE_HOURS, resetSyncBaselines, sync, syncBaselineStore, warmSync } from "../src/core/sync.js";
import type { SyncParams, WarmParams } from "../src/core/sync.js";
import { observeSessionPaths, resetSessions } from "../src/core/session.js";
import { captureMutation, finishMutation } from "../src/core/provenance.js";
import { inNodeRuntime } from "./helpers/runtime.js";

const SRC = new URL("./fixtures/mini", import.meta.url).pathname;
const ensureRoot = (target: string) => inNodeRuntime(target, (processRoot) => ensureState(processRoot));
const stateFor = (target: string) => inNodeRuntime(target, (processRoot) => getState(processRoot));
const syncRoot = (target: string, params: SyncParams, now?: RepoState, opts?: Parameters<typeof sync>[3]) =>
  inNodeRuntime(target, (processRoot) => sync(processRoot, params, now, opts));
const warmRoot = (target: string, params: WarmParams) =>
  inNodeRuntime(target, (processRoot) => warmSync(processRoot, params));
const observeRoot = (target: string, paths: string[]) =>
  inNodeRuntime(target, (processRoot) => observeSessionPaths(processRoot, paths));
let root = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fovea-sync-"));
  cpSync(SRC, root, { recursive: true });
  execSync("git init -qb main && git add -A", { cwd: root });
  execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
  await ensureRoot(root); // pre-warm: the sync loop reads warm state by design
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("turn sync", () => {
  it("yields while fingerprinting a large baseline", async () => {
    resetSyncBaselines();
    const facts: RepoState["facts"] = {};
    for (let i = 0; i < 600; i++) {
      facts[`src/file-${i}.ts`] = {
        sha1: String(i),
        symbols: [],
        imports: [],
        calls: [],
        literals: [{ file: `src/file-${i}.ts`, line: 1, text: `/route/${i}` }],
        anchors: [],
      };
    }
    const state = {
      version: "synthetic-baseline",
      facts,
      graph: { anchors: [] },
    } as unknown as RepoState;
    let yielded = false;
    setImmediate(() => { yielded = true; });

    const outcome = await syncRoot("/synthetic-baseline", { budget: 512, steerThreshold: 0.01 }, state);

    expect(outcome.details.baseline).toBe("established");
    expect(yielded).toBe(true);
  });

  it("baseline establishes silently, then clean edits stay silent", async () => {
    resetSyncBaselines();
    resetSessions();
    const first = await syncRoot(root, { files: ["server/main.go"], budget: 512, steerThreshold: 0.01 });
    expect(first.structural).toBe(true);
    expect(first.red).toBe(false);       // baseline: never red on first contact
    expect(first.text).toBeUndefined();

    // Same content again: version unchanged -> not structural.
    const same = await syncRoot(root, { files: ["server/main.go"], budget: 512, steerThreshold: 0.01 });
    expect(same.structural).toBe(false);

    // A comment-only edit drifts the file but must stay green.
    const main = join(root, "server/main.go");
    writeFileSync(main, readFileSync(main, "utf8") + "\n// touched\n");
    const drift = await syncRoot(root, { files: ["server/main.go"], budget: 512, steerThreshold: 0.01 });
    expect(drift.structural).toBe(true);
    expect(drift.red).toBe(false);
    expect(drift.details.semanticChangedFiles).toEqual([]);

    writeFileSync(main, `\n${readFileSync(main, "utf8")}`);
    const shifted = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    expect(shifted.red).toBe(false);
    expect(shifted.details.semanticChangedFiles).toEqual([]);
    execSync("git checkout -- server/main.go", { cwd: root });
  });


  it("re-baselines quietly on a branch switch, then measures drift against the new ref", async () => {
    resetSyncBaselines();
    resetSessions();
    try {
      // altrec carries one semantic commit ahead of main in server/users.go.
      execSync("git checkout -qb altrec", { cwd: root });
      const users = join(root, "server/users.go");
      writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
      execSync('git add -A && git -c user.name=t -c user.email=t@t commit -qm alt', { cwd: root });
      execSync("git checkout -q main", { cwd: root });

      const baseline = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
      expect(baseline.details.baseline).toBe("established");

      // The branch switch re-materializes the worktree: quiet re-baseline,
      // no branch-diff cascade, no steer.
      execSync("git checkout -q altrec", { cwd: root });
      const switched = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
      expect(switched.structural).toBe(true);
      expect(switched.red).toBe(false);
      expect(switched.text).toBeUndefined();
      expect(switched.details.checkout).toBe(true);
      expect(switched.details.baseline).toBe("established");
      expect(switched.details.semanticChangedFiles).toBeUndefined();

      const again = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
      expect(again.structural).toBe(false);

      // Drift after the switch measures against the new ref, not against
      // main, and rebuilds a flagless generation: normal steering resumes.
      writeFileSync(users, readFileSync(users, "utf8").replace("return SaveUser(id)", "return LoadUser(id)"));
      const drift = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
      expect(drift.red).toBe(true);
      expect(drift.details.semanticChangedFiles).toEqual(["server/users.go"]);
      expect((await stateFor(root))?.checkout).toBeUndefined();
    } finally {
      execSync("git checkout -qf main", { cwd: root }); // -f: drop the drift edit
      execSync("git branch -qD altrec", { cwd: root });
      resetSyncBaselines();
      await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }); // leave state + baseline on main
    }
  });

  it("steers on the first semantic cascade with causal context", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    const users = join(root, "server/users.go");
    const src = readFileSync(users, "utf8");
    writeFileSync(users, src.replace("return LoadUser(id)", "return SaveUser(id)"));
    const outcome = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(outcome.red).toBe(true);
    expect(outcome.tokens).toBeLessThanOrEqual(512);
    expect(outcome.text).toContain("Repository structure changed.");
    expect(outcome.text).toContain("Changed: server/users.go");
    expect(outcome.text).toContain("Newly relevant files:");
    expect(outcome.text).toContain("Steer: account for this update");
    expect(outcome.text).toContain('fovea focus "server/users.go"');
    expect(outcome.text).not.toContain("Next:");
    expect(outcome.details.pushedFocus).toBe("server/users.go");
    expect(outcome.text).not.toContain("undisclosed");
    expect(outcome.text).not.toMatch(/ · v [a-f0-9]+/);
    expect(outcome.details.semanticChangedFiles).toContain("server/users.go");
    expect(outcome.details.warmReasons).toBeTruthy();
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("gates on surprise mass, not warmed-file count, and reports it when silent", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 8 });
    const users = join(root, "server/users.go");
    const src = readFileSync(users, "utf8");
    writeFileSync(users, src.replace("return LoadUser(id)", "return SaveUser(id)"));
    // Fixture calibration: this cascade totals ~0.077 channel-adjusted mass —
    // far above any file-count threshold of 1, far below a mass threshold of 8.
    const quiet = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 8 });
    expect(quiet.structural).toBe(true);
    expect(quiet.red).toBe(false);
    expect(Number(quiet.details.surprise)).toBeGreaterThan(0.02);
    // No fire -> nothing absorbed into the heat memory and the latch stays
    // armed: a fresh semantic nudge re-examined under a low threshold fires.
    writeFileSync(users, readFileSync(users, "utf8").replace("return SaveUser(id)", "return SaveUserByRef(id)"));
    const loud = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(loud.red).toBe(true);
    expect(loud.text).toContain("Changed: server/users.go");
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("charged node memory kills the ping-pong by construct, on every flip", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.05 });
    const users = join(root, "server/users.go");
    const src = readFileSync(users, "utf8");
    const flip = (on: boolean) =>
      writeFileSync(users, on
        ? src.replace("return LoadUser(id)", "return SaveUser(id)")
        : src);
    // First contact: the ledger is empty, full surprise crosses 0.05 and the
    // disclosure charges every warmed cascade node at its adjusted mass.
    flip(true);
    const first = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.05 });
    expect(first.red).toBe(true);
    expect(Number(first.details.surprise)).toBeGreaterThan(0.05);
    // Every later flip re-seeds the IDENTICAL cascade: the same node keys,
    // now charged. Wall-clock decay at a 48h half-life is ~0 within a
    // session, so each revisit's surprise is rounding noise — not a ~30%%
    // regrowth margin that climbs back over the threshold after enough
    // flips. Five poles, all silent, forever.
    for (let pole = 0; pole < 5; pole++) {
      flip(pole % 2 === 1);
      const repeat = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.05 });
      expect(repeat.red).toBe(false);
      expect(Number(repeat.details.surprise)).toBeLessThan(0.005);
    }
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.05 });
  });

  it("node memory damps charged nodes without blanketing fresh warmth", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    const users = join(root, "server/users.go");
    const src = readFileSync(users, "utf8");
    writeFileSync(users, src.replace("return LoadUser(id)", "return SaveUser(id)"));
    const first = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(first.red).toBe(true);
    execSync("git checkout -- server/users.go", { cwd: root });
    const quiet = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    expect(quiet.red).toBe(false);
    expect(Number(quiet.details.surprise)).toBeLessThan(0.005);
    // The users cascade charged the whole shared-literal cluster (config.go
    // rides it). A config change re-seeds that charged mass AND adds a fresh
    // literal node: the charged part stays damped (surprise is a fraction of
    // the original disclosure), but the novelty still crosses a sensitive
    // threshold. Cascade-shaped bookkeeping: suppression by charged key,
    // never by file or by blanket.
    const config = join(root, "server/config.go");
    const cfgSrc = readFileSync(config, "utf8");
    writeFileSync(config, cfgSrc.replace('os.Getenv("DATABASE_URL")', 'os.Getenv("DATABASE_URL") + "?pool=1"'));
    const novel = await syncRoot(root, { files: ["server/config.go"], budget: 512, steerThreshold: 0.01 });
    expect(novel.red).toBe(true);
    expect(Number(novel.details.surprise)).toBeGreaterThan(0.01);
    expect(Number(novel.details.surprise)).toBeLessThan(Number(first.details.surprise));
    execSync("git checkout -- server/config.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("wall-clock aging of the ledger follows the half-life exactly", () => {
    const hlMs = MEMORY_HALF_LIFE_HOURS * 3600_000;
    expect(decayedMass({ m: 1, t: 0 }, 0)).toBeCloseTo(1, 12);
    expect(decayedMass({ m: 1, t: 0 }, hlMs)).toBeCloseTo(0.5, 6);
    expect(decayedMass({ m: 1, t: 0 }, 2 * hlMs)).toBeCloseTo(0.25, 6);
    // Clock skew or rewinds never amplify.
    expect(decayedMass({ m: 1, t: 1000 }, 500)).toBeCloseTo(1, 12);
  });

  it("pull mode keeps the Next advisory instead of embedding focus", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01, pushFocus: false });
    const users = join(root, "server/users.go");
    const src = readFileSync(users, "utf8");
    writeFileSync(users, src.replace("return LoadUser(id)", "return SaveUser(id)"));
    const outcome = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01, pushFocus: false });
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain('Next: fovea_focus "server/users.go" to see what it now connects to.');
    expect(outcome.text).not.toContain('fovea focus "server/users.go"');
    expect(outcome.details.pushedFocus).toBeUndefined();
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01, pushFocus: false });
  });

  it("embeds focus detail once per drift target", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    const users = join(root, "server/users.go");
    const src = readFileSync(users, "utf8");
    writeFileSync(users, src.replace("return LoadUser(id)", "return SaveUser(id)"));
    rmSync(join(root, "web/types.ts"));
    const first = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(first.red).toBe(true);
    expect(first.text).toContain('fovea focus "server/users.go"');
    expect(first.details.pushedFocus).toBe("server/users.go");
    execSync("git checkout -- web/types.ts", { cwd: root });
    writeFileSync(users, readFileSync(users, "utf8").replace("return SaveUser(id)", "return LoadUser(id)"));
    rmSync(join(root, "pages/api/health.ts"));
    const second = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(second.red).toBe(true);
    expect(second.text).not.toContain('fovea focus "server/users.go"');
    expect(second.text).toContain('Next: fovea_focus "server/users.go"');
    expect(second.details.pushedFocus).toBeUndefined();
    execSync("git checkout -- server/users.go pages/api/health.ts", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("follows the worktree when a dirty file returns to porcelain-clean", async () => {
    resetSyncBaselines();
    resetSessions();
    const users = join(root, "server/users.go");
    const base = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    const pristineVersion = String(base.details.version);
    writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
    const dirty = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(dirty.red).toBe(true);
    expect(dirty.details.version).not.toBe(pristineVersion);
    execSync("git checkout -- server/users.go", { cwd: root });
    const restored = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    expect(restored.details.version).toBe(pristineVersion);
    writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
    const again = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(again.structural).toBe(true);
    expect(again.details.semanticChangedFiles).toContain("server/users.go");
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("anchor shift escalates to red with the added route", async () => {
    const main = join(root, "server/main.go");
    const src = readFileSync(main, "utf8");
    writeFileSync(main, src.replace(
      'r.POST("/api/users", server.CreateUserHandler)',
      'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/restore", server.GetUserHandler)',
    ));
    const outcome = await syncRoot(root, { files: ["server/main.go"], budget: 512, steerThreshold: 0.01 });
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain("GET /api/users/{*}/restore");
    expect(outcome.details.added).toContain("GET /api/users/{*}/restore");
    expect(outcome.text).toContain('Next: fovea_focus "/api/users/{*}/restore"');
    execSync("git checkout -- server/main.go", { cwd: root });
    // Post-restore sync re-baselines; the restored repo is the new normal.
    await syncRoot(root, { files: ["server/main.go"], budget: 512, steerThreshold: 0.01 });
  });

  it("hintless drift is detected identically (fabric_exec / bash mutation path)", async () => {
    // Raw filesystem write with NO tool-event hints: the sha diff against the
    // baseline's content hashes is the source of truth, so a fabric_exec inner
    // pi.edit, a bash heredoc, or an out-of-band editor save all escalate the
    // same way a pi edit/write tool call does.
    const main = join(root, "server/main.go");
    const src = readFileSync(main, "utf8");
    writeFileSync(main, src.replace(
      'r.POST("/api/users", server.CreateUserHandler)',
      'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/audit", server.GetUserHandler)',
    ));
    const outcome = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    expect(outcome.structural).toBe(true);
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain("GET /api/users/{*}/audit");
    execSync("git checkout -- server/main.go", { cwd: root });
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });


  it("precomputes ingredients so the blocking sync reuses them", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    const users = join(root, "server/users.go");
    writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
    await warmRoot(root, { files: ["server/users.go"], budget: 512 });
    const outcome = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain("Newly relevant files:");
    expect(outcome.text).toContain('fovea focus "server/users.go"');
    expect(outcome.details.warmReasons).toBeTruthy();
    // The warm did not advance the baseline; the verdict arrives at the
    // blocking sync. After it, the next sync is a no-op fast path.
    const again = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    expect(again.structural).toBe(false);
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("warm path equals the inline compute on the same drift", async () => {
    const users = join(root, "server/users.go");
    const edit = (): void => {
      writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
    };
    const restore = (): void => { execSync("git checkout -- server/users.go", { cwd: root }); };

    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    edit();
    const inline = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });

    restore();
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    edit();
    await warmRoot(root, { files: ["server/users.go"], budget: 512 });
    const warmed = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });

    expect(warmed.red).toBe(inline.red);
    const stableText = (value: string | undefined) => value?.replace(
      /Read the complete result from .*?focus\. — use/u,
      "Read the complete result from <spill>. — use",
    );
    expect(stableText(warmed.text)).toBe(stableText(inline.text));
    expect(warmed.details.semanticChangedFiles).toEqual(inline.details.semanticChangedFiles);
    expect(warmed.details.warmNew).toEqual(inline.details.warmNew);
    expect(warmed.details.surprise).toEqual(inline.details.surprise);
    restore();
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("stale warm (more drift since) falls back to the inline compute", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 8 });
    const users = join(root, "server/users.go");
    const main = join(root, "server/main.go");
    writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
    await warmRoot(root, { files: ["server/users.go"], budget: 512 });
    // A second edit lands after the warm: the cached fingerprint covers only
    // the first drift, so sync must recompute against the newest state.
    writeFileSync(main, readFileSync(main, "utf8").replace(
      'r.POST("/api/users", server.CreateUserHandler)',
      'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/warmcheck", server.GetUserHandler)',
    ));
    const outcome = await syncRoot(root, { files: ["server/users.go", "server/main.go"], budget: 512, steerThreshold: 8 });
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain("GET /api/users/{*}/warmcheck");
    execSync("git checkout -- server/users.go server/main.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 8 });
  });

  it("steers when a production file disappears", async () => {
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 8 });
    rmSync(join(root, "web/types.ts"));
    const outcome = await syncRoot(root, { files: [], budget: 512, steerThreshold: 8 });
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain("deleted web/types.ts");
    expect(outcome.text).not.toContain("Next:");
    expect(outcome.details.deletedFiles).toContain("web/types.ts");
    execSync("git checkout -- web/types.ts", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 8 });
  });

  it("never reports an on-disk file as deleted (coverage gaps are not deletions)", async () => {
    resetSyncBaselines();
    resetSessions();
    const rel = "web/big-new.ts";
    const big = join(root, rel);
    try {
      writeFileSync(big, "export const PAD_BIG = 1;\n");
      await syncRoot(root, { files: [rel], budget: 512, steerThreshold: 0.01 }); // baseline: extracted, in facts + baseline shas

      // Past FOVEA_MAX_FILE_BYTES: refresh moves it from facts to the oversized
      // bucket while it stays on disk. Absent-from-facts is a coverage gap, so
      // sync must not narrate it as a deletion — the phantom-deletion loop that
      // used to steer red on every turn while such a gap persisted.
      const pad = "// pad past the 1 MiB extraction cap\n";
      writeFileSync(big, pad.repeat(Math.ceil((1024 * 1024 + 4096) / pad.length)));
      const gapped = await syncRoot(root, { files: [rel], budget: 512, steerThreshold: 0.01 });
      expect(gapped.red).toBe(false);
      expect(gapped.text).toBeUndefined();
      expect((gapped.details.deletedFiles as string[] | undefined) ?? []).toEqual([]);
    } finally {
      rmSync(big, { force: true });
      resetSyncBaselines();
      await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    }
  });

  it("hintless drift in a non-git workspace still detects content change", async () => {
    const plain = mkdtempSync(join(tmpdir(), "fovea-sync-nogit-"));
    cpSync(SRC, plain, { recursive: true }); // deliberately no git init
    try {
      await ensureRoot(plain); // plain workspace: pre-warm, same as hooks do at session start
      const base = await syncRoot(plain, { files: [], budget: 512, steerThreshold: 0.01 });
      expect(base.structural).toBe(true);
      expect(base.red).toBe(false);
      const main = join(plain, "server/main.go");
      const src = readFileSync(main, "utf8");
      writeFileSync(main, src.replace(
        'r.GET("/api/users/:id", server.GetUserHandler)',
        'r.GET("/api/users/:id", server.GetUserHandler)\n\tr.DELETE("/api/users/:id", server.GetUserHandler)',
      ));
      const outcome = await syncRoot(plain, { files: [], budget: 512, steerThreshold: 0.01 });
      expect(outcome.structural).toBe(true);
      expect(outcome.red).toBe(true);
      expect(outcome.text).toContain("DELETE /api/users/{*}");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("defer mode keeps pure-conversation sends on the quick path", async () => {
    resetSyncBaselines();
    resetSessions();
    await ensureRoot(root);
    const first = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }, undefined, { probe: "defer" });
    expect(first.details.baseline).toBe("established");
    const second = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }, undefined, { probe: "defer" });
    const third = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }, undefined, { probe: "defer" });
    // Nothing drifted and nothing rebuilt: both sends are silent no-ops, and
    // the resident version is reported without a rebuild or baseline advance.
    expect(second.structural).toBe(false);
    expect(third.structural).toBe(false);
    expect(third.details.version).toBe(first.details.version);
  });

  it("defer mode never rebuilds for hintless drift and leaves it to the backstop", async () => {
    resetSyncBaselines();
    resetSessions();
    await ensureRoot(root);
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }, undefined, { probe: "defer" });
    const main = join(root, "server/main.go");
    writeFileSync(main, readFileSync(main, "utf8").replace(
      'r.POST("/api/users", server.CreateUserHandler)',
      'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/defercheck", server.GetUserHandler)',
    ));
    // Hintless edit: the send-path verdict is deferred (no rebuild, no inline
    // cascade) and the baseline stays untouched so turn_end still sees it.
    const deferred = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }, undefined, { probe: "defer" });
    expect(deferred.details.deferred).toBe(true);
    expect(deferred.red).toBe(false);
    // The turn_end backstop (default full probe) reports and steers it.
    const follow = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    expect(follow.red).toBe(true);
    expect(follow.text).toContain("GET /api/users/{*}/defercheck");
    execSync("git checkout -- server/main.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("defer mode renders a prepared warm verdict on the send path", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    const users = join(root, "server/users.go");
    writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
    await warmRoot(root, { files: ["server/users.go"], budget: 512 });
    const out = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }, undefined, { probe: "defer" });
    expect(out.red).toBe(true);
    expect(out.text).toContain("Steer: account for this update");
    expect(out.text).toContain("server/users.go");
    // Rendering the warm verdict advanced the baseline; the next send is a
    // no-op quick path.
    const again = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }, undefined, { probe: "defer" });
    expect(again.structural).toBe(false);
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });

  it("warm-embedded focus reuses the verdict state (no double probe)", async () => {
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    const users = join(root, "server/users.go");
    writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
    const inline = await syncRoot(root, { files: ["server/users.go"], budget: 512, steerThreshold: 0.01 });
    const inlineRed = inline.red;
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    resetSessions();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
    writeFileSync(users, readFileSync(users, "utf8").replace("return LoadUser(id)", "return SaveUser(id)"));
    await warmRoot(root, { files: ["server/users.go"], budget: 512 });
    const warmed = await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 }, undefined, { probe: "defer" });
    // The warm verdict renders on the send path and embeds focus from the
    // exact state the warm built — red like the inline compute, focus pushed
    // (not a pull advisory), steer line present.
    expect(warmed.red).toBe(inlineRed);
    expect(String(warmed.text)).toContain('fovea focus "server/users.go"');
    expect(String(warmed.text)).not.toContain("Next:");
    expect(String(warmed.text)).toContain("Steer: account for this update");
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    await syncRoot(root, { files: [], budget: 512, steerThreshold: 0.01 });
  });
});

describe("hot-reload handoff", () => {
  it("baselines survive a module reload via the global store", async () => {
    // Same-process reload (/fovea reload) re-evaluates the module; the
    // verdict ledger must ride through on the global slot or the next drift
    // re-fires as a first disclosure.
    const viaStore = syncBaselineStore();
    const probeRoot = "\u2206reload-probe";
    const fake = { probe: true };
    viaStore.set(probeRoot, fake as never);
    vi.resetModules();
    const fresh = await import("../src/core/sync.js");
    expect(fresh.syncBaselineStore()).toBe(viaStore);
    expect(fresh.syncBaselineStore().get(probeRoot)).toBe(fake);
    viaStore.delete(probeRoot);
  });

  it("a mismatched shape version degrades to a cold store", () => {
    const slot = Symbol.for("dsh-fovea:sync-baselines");
    const holder = globalThis as Record<symbol, unknown>;
    const backup = holder[slot];
    holder[slot] = { v: -1, map: new Map([["stale-root", { probe: true }]]) };
    try {
      const cold = syncBaselineStore();
      expect(cold.has("stale-root")).toBe(false);
      expect(syncBaselineStore()).toBe(cold);
    } finally {
      holder[slot] = backup ?? { v: 1, map: syncBaselineStore() };
    }
  });
});

describe("session-scoped sync delivery", () => {
  it("defers another session's relevant change to the next prompt", async () => {
    resetSyncBaselines();
    resetSessions();
    const file = "web/api.ts";
    const path = join(root, file);
    const original = readFileSync(path, "utf8");
    try {
      const initial = await ensureRoot(root);
      const baseline = await syncRoot(root, {
        files: [],
        budget: 512,
        steerThreshold: 0.01,
        scope: "session",
        sessionId: "session-b",
      }, initial, { probe: "full" });
      expect(baseline.details.baseline).toBe("established");

      // Session A mutates web/api.ts inside the scope session B later enters;
      // the mutation is attributed to session A via the provenance journal.
      await inNodeRuntime(root, async (processRoot) => {
        await observeSessionPaths(processRoot, [file]);
        const capture = await captureMutation(processRoot, file);
        writeFileSync(path, original + 'export const siblingRoute = () => "/sibling";\n');
        expect(capture).toBeDefined();
        await finishMutation(capture!, "session-a", "call-1");
      });

      const outcome = await syncRoot(root, {
        files: [],
        budget: 512,
        steerThreshold: 0.01,
        scope: "session",
        sessionId: "session-b",
      });
      // Relevant (scope "web" entered) and red, but owned by another session:
      // the verdict must be deferred, never an immediate steer.
      expect(outcome.red).toBe(true);
      expect(outcome.details.provenance).toMatchObject({ kind: "other-session" });
      expect(outcome.delivery).toBe("next-prompt");
    } finally {
      writeFileSync(path, original);
      resetSyncBaselines();
      resetSessions();
    }
  });

  it("steers a relevant unattributed change immediately", async () => {
    resetSyncBaselines();
    resetSessions();
    const file = "web/api.ts";
    const path = join(root, file);
    const original = readFileSync(path, "utf8");
    try {
      const initial = await ensureRoot(root);
      const baseline = await syncRoot(root, {
        files: [],
        budget: 512,
        steerThreshold: 0.01,
        scope: "session",
        sessionId: "session-b",
      }, initial, { probe: "full" });
      expect(baseline.details.baseline).toBe("established");
      await observeRoot(root, [file]);

      // External editor drift: no provenance record exists for the change.
      writeFileSync(path, original + 'export const externalRoute = () => "/external";\n');
      const outcome = await syncRoot(root, {
        files: [],
        budget: 512,
        steerThreshold: 0.01,
        scope: "session",
        sessionId: "session-b",
      });
      expect(outcome.red).toBe(true);
      expect(outcome.details.provenance).toMatchObject({ kind: "unattributed" });
      expect(outcome.delivery).toBe("steer");
    } finally {
      writeFileSync(path, original);
      resetSyncBaselines();
      resetSessions();
    }
  });
});
