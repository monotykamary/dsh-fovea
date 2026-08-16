import { basename, posix } from "node:path";
import { forEachChunked } from "./asyncutil.js";
import { LANG_BY_EXT } from "./astgrep.js";
import { isTestFile } from "./extract.js";
import { buildJoinIndex, type JoinIndex } from "./join.js";
import type { AnchorDraft } from "./anchors.js";
import type { FileFacts } from "./build.js";
import type { Edge, Graph, LiteralSite, NodeRec } from "./types.js";

const CODE_EXTS_BY_LANGFAMILY: Record<string, string[]> = {
  ts: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  py: [".py"],
  rs: [".rs"],
  go: [],
};

const langFamily = (file: string): string => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(ext)) return "ts";
  if (ext === "py") return "py";
  if (ext === "rs") return "rs";
  if (ext === "go") return "go";
  return ext;
};

/**
 * Precomputed suffix indexes. The naive resolvers scanned the whole file set
 * per import (O(imports × files)), which quadratic-blows on big trees; these
 * maps make each lookup near-constant while preserving the exact match rules.
 */
interface ImportIndex {
  fileSet: Set<string>;
  filesByDir: Map<string, string[]>;
  /** Go: last-k-segment dir suffix (k <= 3) -> dirs, built for every source dir. */
  goDirsBySuffix: Map<string, string[]>;
  /** Rust: module basename -> files (`foo.rs`, `foo/mod.rs`). */
  rsByBase: Map<string, string[]>;
  /** TS bare specifiers: last path segment -> `x.ts` / `x/index.ts` files. */
  tsByTailStem: Map<string, string[]>;
}

const pushIndex = (m: Map<string, string[]>, key: string, value: string): void => {
  (m.get(key) ?? m.set(key, []).get(key)!).push(value);
};

const buildImportIndex = (files: string[]): ImportIndex => {
  const fileSet = new Set(files);
  const filesByDir = new Map<string, string[]>();
  const goDirsBySuffix = new Map<string, string[]>();
  const rsByBase = new Map<string, string[]>();
  const tsByTailStem = new Map<string, string[]>();
  for (const f of files) {
    const dir = posix.dirname(f);
    pushIndex(filesByDir, dir, f);
  }
  for (const dir of filesByDir.keys()) {
    const segs = dir.split("/").filter(Boolean);
    for (let k = 1; k <= Math.min(3, segs.length); k++) {
      pushIndex(goDirsBySuffix, segs.slice(-k).join("/"), dir);
    }
  }
  for (const f of files) {
    if (f.endsWith(".rs")) {
      const base = basename(f, ".rs");
      pushIndex(rsByBase, base, f);
      if (base === "mod") {
        const parentBase = basename(posix.dirname(f));
        pushIndex(rsByBase, parentBase, f);
      }
    }
    if (f.endsWith(".ts")) {
      const base = basename(f, ".ts");
      if (base === "index") pushIndex(tsByTailStem, basename(posix.dirname(f)), f);
      else pushIndex(tsByTailStem, base, f);
    }
  }
  return { fileSet, filesByDir, goDirsBySuffix, rsByBase, tsByTailStem };
};

const resolveImportToFile = (
  spec: string,
  fromFile: string,
  index: ImportIndex,
): string | undefined => {
  const { fileSet } = index;
  const fam = langFamily(fromFile);
  if (spec.startsWith("./") || spec.startsWith("../")) {
    let base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    // NodeNext convention: TS files import "./sibling.js" — the .js refers to
    // the .ts source. Strip a runtime extension before probing.
    base = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    for (const ext of CODE_EXTS_BY_LANGFAMILY[fam] ?? []) {
      if (fileSet.has(base + ext)) return base + ext;
      if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    }
    if (fileSet.has(base)) return base;
    return undefined;
  }
  if (fam === "py") {
    const p = spec.replace(/\./g, "/");
    for (const cand of [`${p}.py`, `${p}/__init__.py`]) if (fileSet.has(cand)) return cand;
    return undefined;
  }
  if (fam === "go") {
    const segs = spec.split("/").filter(Boolean);
    for (let k = 1; k <= Math.min(3, segs.length); k++) {
      const suffix = segs.slice(-k).join("/");
      const matches = (index.goDirsBySuffix.get(suffix) ?? []).filter(
        (d) => d === suffix || d.endsWith(`/${suffix}`),
      );
      if (matches.length === 1) {
        const dir = matches[0]!;
        const inDir = index.filesByDir.get(dir) ?? [];
        if (inDir.length) return inDir[0];
      }
    }
    return undefined;
  }
  if (fam === "rs") {
    const modPath = spec.replace(/^crate::|^self::/, "").replace(/::/g, "/");
    for (const cand of [`src/${modPath}.rs`, `${modPath}.rs`]) if (fileSet.has(cand)) return cand;
    const baseName = basename(modPath);
    const hits = (index.rsByBase.get(baseName) ?? []).filter(
      (f) => f === `${baseName}.rs` || f.endsWith(`/${baseName}.rs`) || f.endsWith(`/${baseName}/mod.rs`),
    );
    return hits.length === 1 ? hits[0] : undefined;
  }
  // ts bare specifier: node_modules or aliased; try a tail match.
  const tail = spec.split("/").filter(Boolean).join("/");
  const stem = tail.split("/").pop() ?? tail;
  const hits = (index.tsByTailStem.get(stem) ?? []).filter(
    (f) => f.endsWith(`/${tail}.ts`) || f.endsWith(`/${tail}/index.ts`),
  );
  return hits.length === 1 ? hits[0] : undefined;
};

const addNode = (nodes: NodeRec[], seen: Map<string, number>, rec: NodeRec): number => {
  const hit = seen.get(rec.id);
  if (hit !== undefined) return hit;
  const idx = nodes.length;
  seen.set(rec.id, idx);
  nodes.push(rec);
  return idx;
};

export interface GraphAssembly { graph: Graph; joinIndex: JoinIndex }

export const assembleGraphWithIndex = async (
  root: string,
  files: string[],
  factsMap: Map<string, FileFacts> | Record<string, FileFacts>,
): Promise<GraphAssembly> => {
  const facts = (file: string): FileFacts | undefined =>
    factsMap instanceof Map ? factsMap.get(file) : factsMap[file];
  const factValues = (): Iterable<FileFacts> =>
    factsMap instanceof Map ? factsMap.values() : Object.values(factsMap);
  const nodes: NodeRec[] = [];
  const seen = new Map<string, number>();
  const edges: Edge[] = [];
  const byFile = new Map<string, number[]>();
  const fileIdx = new Map<string, number>();

  const pushEdge = (a: number, b: number, kind: Edge["kind"], w: number): void => {
    if (a === b) return;
    edges.push({ a, b, kind, w });
  };

  // File nodes first (stable for enclosing fallback + sketch grouping).
  for (const rel of files) {
    const idx = addNode(nodes, seen, {
      id: `file:${rel}`, name: posix.basename(rel), kind: "file", file: rel, line: 0,
      sig: rel, lang: LANG_BY_EXT[rel.split(".").pop()?.toLowerCase() ?? ""] ?? "config",
    });
    fileIdx.set(rel, idx);
    (byFile.get(rel) ?? byFile.set(rel, []).get(rel)!).push(idx);
  }

  // Symbol nodes + contains edges.
  const symIdxByFileLine = new Map<string, number>(); // `${file}:${line}` first symbol idx
  await forEachChunked(files, 512, (rel) => {
    const f = facts(rel);
    if (!f) return;
    for (const s of f.symbols) {
      const idx = addNode(nodes, seen, { id: `${s.name}@${s.file}`, ...s });
      (byFile.get(rel) ?? byFile.set(rel, []).get(rel)!).push(idx);
      pushEdge(fileIdx.get(rel)!, idx, "contains", 1.0);
      const key = `${rel}:${s.line}`;
      if (!symIdxByFileLine.has(key)) symIdxByFileLine.set(key, idx);
    }
  });

  // Order each file's node list by line for enclosing-symbol queries.
  for (const [, arr] of byFile) arr.sort((x, y) => nodes[x]!.line - nodes[y]!.line);

  const enclosingIdx = (file: string, line: number): number => {
    const arr = byFile.get(file) ?? [];
    let best = fileIdx.get(file)!;
    for (const idx of arr) {
      const n = nodes[idx]!;
      if (n.kind !== "file" && n.line <= line && nodes[best]!.line <= n.line) best = idx;
    }
    return best;
  };

  // byName index: exact, lowercased, and short suffix (methods).
  const byName = new Map<string, number[]>();
  {
    const addKey = (key: string, idx: number): void => {
      if (!key) return;
      (byName.get(key) ?? byName.set(key, []).get(key)!).push(idx);
    };
    nodes.forEach((n, i) => {
      if (n.kind === "file" || n.kind === "anchor") return;
      addKey(n.name.toLowerCase(), i);
      const dot = n.name.indexOf(".");
      if (dot > 0) addKey(n.name.slice(dot + 1).toLowerCase(), i);
    });
  }

  const importIndex = buildImportIndex(files);

  // Import edges (file-level, low conductance backbone) + tests wiring.
  const importTargets = new Map<string, string[]>();
  await forEachChunked(files, 512, (rel) => {
    const f = facts(rel);
    if (!f) return;
    for (const imp of f.imports) {
      const target = resolveImportToFile(imp.spec, rel, importIndex);
      if (!target || target === rel) continue;
      pushEdge(fileIdx.get(rel)!, fileIdx.get(target)!, "imports", 0.3);
      (importTargets.get(rel) ?? importTargets.set(rel, []).get(rel)!).push(target);
    }
    if (isTestFile(rel)) {
      for (const t of importTargets.get(rel) ?? []) {
        pushEdge(fileIdx.get(rel)!, fileIdx.get(t)!, "tests", 0.6);
      }
    }
  });

  // Call edges: resolve callee by name, prefer same-file, then imported files,
  // then a globally unique definition. Conductance decays with definition
  // cardinality: a name defined twice is a pointer, a name defined 40 times
  // is ambient noise (the dynamic-language `str(`/`it(` hub failure mode).
  await forEachChunked(files, 256, (rel) => {
    const f = facts(rel);
    if (!f) return;
    const imported = new Set(importTargets.get(rel) ?? []);
    for (const call of f.calls) {
      const cands = byName.get(call.callee.toLowerCase()) ?? [];
      if (!cands.length || cands.length > 48) continue;
      let chosen: number[] = cands.filter((i) => nodes[i]!.file === rel);
      if (!chosen.length) chosen = cands.filter((i) => imported.has(nodes[i]!.file));
      if (!chosen.length && cands.length === 1) chosen = cands;
      if (!chosen.length || chosen.length > 3) continue;
      const w = cands.length <= 8 ? 0.7 : cands.length <= 24 ? 0.45 : 0.25;
      const from = enclosingIdx(rel, call.line);
      for (const to of chosen) pushEdge(from, to, "invokes", w);
    }
  });

  // Inherits edges from class signatures (TS/py style visible on the sig line).
  nodes.forEach((n, i) => {
    if (n.kind !== "class") return;
    for (const m of n.sig.matchAll(/extends\s+([A-Za-z_$][\w$.]*)/g)) {
      for (const to of byName.get(m[1]!.toLowerCase()) ?? []) pushEdge(i, to, "inherits", 0.9);
    }
    const impl = /implements\s+([A-Za-z_$][\w$.,\s]*)/.exec(n.sig);
    if (impl) {
      for (const raw of impl[1]!.split(",")) {
        for (const to of byName.get(raw.trim().toLowerCase()) ?? []) pushEdge(i, to, "inherits", 0.9);
      }
    }
  });

  // Literal join edges (the cross-language bridge).
  const allSites: LiteralSite[] = [];
  for (const f of factValues()) for (const literal of f.literals) allSites.push(literal);
  const joinIdx = buildJoinIndex(allSites, (file, line) => enclosingIdx(file, line));
  for (const je of joinIdx.edges) pushEdge(je.a, je.b, "join", je.w);

  // Anchors: ONE node per feature route, not per site. Server registration
  // and every client call of "POST /auth/login" are occurrences of the same
  // feature; the anchor hub is where they meet. Site conductance decays with
  // sqrt(count) so a route consumed everywhere doesn't become a gravity well.
  const drafts: AnchorDraft[] = [];
  for (const rel of files) {
    const f = facts(rel);
    if (f) for (const anchor of f.anchors) drafts.push(anchor);
  }
  const draftsByLabel = new Map<string, AnchorDraft[]>();
  for (const a of drafts) {
    (draftsByLabel.get(a.id) ?? draftsByLabel.set(a.id, []).get(a.id)!).push(a);
  }
  const anchors: Graph["anchors"] = [];
  for (const [label, sites] of draftsByLabel) {
    const first = sites[0]!;
    const filesOf = [...new Set(sites.map((s) => s.file))];
    // A hub is implicit only when EVERY site came from a discovered rule — a
    // match by any real rule upgrades it back to first-class instantly.
    const hubImplicit = sites.every((s) => s.implicit === true);
    anchors.push({ id: label, kind: first.kind, label: sites.length > 1 ? `${label} · ${sites.length} sites` : label, nodeId: first.nodeId, file: first.file, line: first.line, ...(hubImplicit ? { implicit: true } : {}) });
    const idx = addNode(nodes, seen, {
      id: `anchor:${label}`, name: label, kind: "anchor", file: first.file, line: first.line,
      sig: `${hubImplicit ? "(△ discovered) " : ""}${sites.length > 1 ? `${label} (${sites.length} sites)` : label}`, lang: "anchor",
    });
    (byFile.get(first.file) ?? byFile.set(first.file, []).get(first.file)!).push(idx);
    // Tier-3 hubs prove themselves at half conductance; a later literal join
    // against a first-class hub can still warm them via the channel edges.
    const w = (hubImplicit ? 0.5 : 1) / Math.sqrt(sites.length);
    for (const s of sites) {
      const handler = seen.get(s.nodeId) ?? fileIdx.get(s.file)!;
      pushEdge(idx, handler, "anchors", w);
    }
    // A multi-file route binds its files too (the feature's file hood).
    if (filesOf.length > 1 && filesOf.length <= 12) {
      const fw = 0.35 / Math.sqrt(filesOf.length);
      for (const f of filesOf) pushEdge(idx, fileIdx.get(f)!, "anchors", fw);
    }
  }

  return { graph: { nodes, edges, byName, byFile, anchors, files }, joinIndex: joinIdx };
};
