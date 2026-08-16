// End-to-end over the fixture: graph build, the four ops, budget conformance,
// and the session delta contract.

import { describe, expect, it } from "vitest";
import { assembleGraphWithIndex as assembleGraphFromBuild } from "../src/core/build.js";
import { assembleGraphWithIndex } from "../src/core/graph.js";
import {
  dwell,
  ensureState,
  ensureStateBackground,
  evictState,
  focus,
  getInflight,
  getState,
  impact,
  sketch,
} from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";
import type { FocusOptions, ImpactArgs } from "../src/core/ops.js";
import * as state from "../src/core/state.js";
import { inNodeRuntime } from "./helpers/runtime.js";

const FIXTURE = new URL("./fixtures/mini", import.meta.url).pathname;
const fixtureEnsure = () => inNodeRuntime(FIXTURE, (root) => ensureState(root));
const fixtureSketch = (budget?: number) => inNodeRuntime(FIXTURE, (root) => sketch(root, budget));
const fixtureFocus = (query: string, budget?: number, options?: FocusOptions) =>
  inNodeRuntime(FIXTURE, (root) => focus(root, query, budget, options));
const fixtureDwell = (factor?: number, budget?: number) =>
  inNodeRuntime(FIXTURE, (root) => dwell(root, factor, budget));
const fixtureImpact = (args: ImpactArgs) => inNodeRuntime(FIXTURE, (root) => impact(root, args));

describe("extracted module compatibility", () => {
  it("re-exports graph assembly and state lifecycle without wrappers", () => {
    expect(assembleGraphFromBuild).toBe(assembleGraphWithIndex);
    expect(ensureState).toBe(state.ensureState);
    expect(ensureStateBackground).toBe(state.ensureStateBackground);
    expect(evictState).toBe(state.evictState);
    expect(getInflight).toBe(state.getInflight);
    expect(getState).toBe(state.getState);
  });
});

describe("fovea ops on the minimonorepo", () => {
  it("builds the graph with anchors and cross-language join edges", async () => {
    const s = await fixtureEnsure();
    expect(s.graph.anchors.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(s.graph.edges.map((e) => e.kind));
    expect(kinds.has("join")).toBe(true);
    expect(kinds.has("contains")).toBe(true);
    expect(kinds.has("invokes")).toBe(true);
    // a join edge crossing server -> web or server -> openapi exists
    const cross = s.graph.edges.some((e) => {
      if (e.kind !== "join") return false;
      const fa = s.graph.nodes[e.a]!.file;
      const fb = s.graph.nodes[e.b]!.file;
      return fa.split("/")[0] !== fb.split("/")[0];
    });
    expect(cross).toBe(true);
  });

  it("sketch silhouettes the repo with feature anchors first", async () => {
    resetSessions();
    const r = await fixtureSketch(900);
    expect(r.tokens).toBeLessThanOrEqual(900);
    expect(r.text).toContain("fovea sketch");
    expect(r.text).toContain("⚑ GET /api/users/{*}");
    expect(r.text).toMatch(/server\//);
    expect(r.text).toMatch(/web\//);
  });

  it("keeps test and fixture architecture collapsed in a real project sketch", async () => {
    const project = new URL("../", import.meta.url).pathname;
    const r = await inNodeRuntime(project, (root) => sketch(root, 1200));
    expect(Number(r.details.testAnchors)).toBeGreaterThan(0);
    expect(r.text).toContain("test/fixture anchors collapsed");
    expect(r.text).toContain("src/core/");
    expect(r.text).not.toContain("⚑ GET /elixir-health");
  });

  it("focus on a route resolves across languages within budget", async () => {
    resetSessions();
    const r = await fixtureFocus("/api/users/{id}", 1600);
    expect(r.tokens).toBeLessThanOrEqual(1600);
    expect(r.text).toContain("server/main.go");
    expect(r.text).toContain("web/api.ts");
    expect(r.text).toContain("openapi.yaml");
  });

  it("focus on a symbol keeps signatures foveated and budgets", async () => {
    for (const B of [400, 800, 1600, 4000]) {
      resetSessions(); // fresh eyes per budget: deltas otherwise show nothing new
      const r = await fixtureFocus("loadUser", B);
      expect(r.tokens).toBeLessThanOrEqual(B);
    }
    resetSessions();
    const r = await fixtureFocus("loadUser", 4000);
    expect(r.text).toContain("▲"); // hot tier renders full signature lines
    expect(r.text).toContain("loadUser");
  });


  it("recovers equivalent camelCase and inflected symbol queries", async () => {
    resetSessions();
    const plural = await fixtureFocus("loadsUsers", 1200);
    expect(Number(plural.details.seeds)).toBeGreaterThan(0);
    expect(plural.text).toContain("loadUser");

    resetSessions();
    const switchQuery = await fixtureFocus("switchServer", 1200);
    expect(Number(switchQuery.details.seeds)).toBeGreaterThan(0);
    expect(switchQuery.text).toContain("ClientConnection.switchingServers");
    expect(switchQuery.text).toContain("web/server-switcher.ts:2");
  });

  it("suggests nearby symbols when a typo cannot seed the graph", async () => {
    resetSessions();
    const r = await fixtureFocus("loadUsr", 256);
    expect(r.tokens).toBeLessThanOrEqual(256);
    expect(r.details.seeds).toBe(0);
    expect(r.text).toContain("Nearby symbols:");
    expect(r.text).toContain("loadUser");
    expect(Array.isArray(r.details.suggestions)).toBe(true);
  });

  it("explains direct call relationships before the thermal periphery", async () => {
    resetSessions();
    const r = await fixtureFocus("loadUser", 1600);
    expect(r.text).toContain("← caller");
    expect(r.text).toContain("GetUserHandler");
  });

  it("repeats the active nucleus while suppressing previously seen periphery", async () => {
    resetSessions();
    const first = await fixtureFocus("loadUser", 2000);
    const second = await fixtureFocus("loadUser", 2000);
    expect(Number(second.details.suppressed)).toBeGreaterThan(0);
    expect(second.text).toContain("prior results omitted");
    for (const line of first.text.split("\n").filter((entry) => entry.includes("[focus]"))) {
      expect(second.text).toContain(line);
    }
  });

  it("starts unrelated focuses sharp and never hides their target", async () => {
    resetSessions();
    await fixtureFocus("loadUser", 2000);
    const user = await fixtureFocus("User", 1200);
    expect(user.text).toContain("web/api.ts:3");
    expect(user.text).toContain("[focus]");
    expect(user.details.t).toBe(2);

    await fixtureDwell(8, 800);
    const search = await fixtureFocus("AirportsController.search", 800);
    expect(search.details.t).toBe(2);
    expect(search.text).toContain("web/airports.controller.ts:7");
  });

  it("supports reproducible fresh focus and source scoping", async () => {
    resetSessions();
    await fixtureFocus("loadUser", 1200);
    const delta = await fixtureFocus("loadUser", 1200);
    expect(Number(delta.details.suppressed)).toBeGreaterThan(0);
    const fresh = await fixtureFocus("loadUser", 1200, {
      fresh: true,
      path: "web",
      language: "TypeScript",
      kind: "function",
    });
    expect(fresh.details.suppressed).toBe(0);
    expect(fresh.text).toContain("web/api.ts:8");
    expect(fresh.text).not.toContain("server/users.go:13");
    expect(Array.isArray(fresh.details.nodes)).toBe(true);
    expect(Array.isArray(fresh.details.suggestedReads)).toBe(true);
    const reads = fresh.details.suggestedReads as Array<{ path: string; offset: number; limit: number }>;
    expect(reads.filter((read) => read.path === "web/api.ts")).toHaveLength(1);

    await fixtureFocus("loadUser", 256, { fresh: true, path: "web", language: "TypeScript" });
    const wider = await fixtureDwell(8, 1200);
    const widenedNodes = wider.details.nodes as Array<{ file: string; language: string }>;
    expect(widenedNodes.length).toBeGreaterThan(0);
    expect(widenedNodes.every((node) => node.file.startsWith("web/") && node.language === "TypeScript")).toBe(true);
  });

  it("dwell deepens the field and reports the t transition", async () => {
    resetSessions();
    await fixtureFocus("loadUser", 800);
    const d = await fixtureDwell(2, 1600);
    expect(d.tokens).toBeLessThanOrEqual(1600);
    expect(d.text).toContain("dwell");
    expect(d.text).toContain("context widened 2×");
    expect(Number(d.details.to)).toBe(4);
  });

  it("impact warms the client and spec when the Go handler file is edited", async () => {
    resetSessions();
    const r = await fixtureImpact({ files: ["server/users.go"], includeUncommitted: false, budget: 2000 });
    expect(r.tokens).toBeLessThanOrEqual(2000);
    expect(r.text).toContain("fovea impact");
    expect(r.text).toContain("web/api.ts");      // shares the /api/users literal
    expect(r.text).toContain("openapi.yaml");    // same route in the spec
    expect(r.text).toContain("worker/search.rs"); // same route literal in Rust
    expect(r.details.warmedReasons).toBeTruthy();
    const reasons = r.details.warmedReasons as Record<string, string[]>;
    expect(reasons["web/api.ts"]).toContain("shared literal");
    expect(reasons["worker/search.rs"]).not.toContain("graph path");
    // the seed file's own symbols are not part of the review list
    expect(r.text.split("\n").filter((l) => l.startsWith("server/users.go"))).toHaveLength(0);
  });

  it("budgets are hard even with hundreds of lit nodes (min clamp)", async () => {
    resetSessions();
    for (const B of [256, 300, 400, 600]) {
      const r = await fixtureFocus("users", B); // broad substring: lights most of the graph
      expect(r.tokens).toBeLessThanOrEqual(B);
    }
  });

  it("impact with unknown files guides instead of crashing", async () => {
    const r = await fixtureImpact({ files: ["nope/nothing.ts"], includeUncommitted: false });
    expect(r.text).toContain("no seed files");
  });
});
