// Shared graph model for dsh-fovea.
// Nodes are symbols (functions, methods, classes, ...), files, and route anchors.
// Edges are undirected conductances between node indices; `kind` records why
// the edge exists and `w` is the thermal conductance used by diffusion.

export type NodeKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "field"
  | "decl"
  | "file"
  | "anchor";

export type EdgeKind =
  | "contains"   // file -> its symbols
  | "imports"    // symbol/file -> symbol/file across an import
  | "invokes"    // call edge caller -> callee
  | "inherits"   // class extends / implements (outline-derived)
  | "tests"      // test file -> unit under test
  | "join"       // shared normalized literal (cross-language bridge)
  | "anchors";   // route anchor -> handler symbol (site-collapsed feature hub)

export interface NodeRec {
  id: string;        // stable identity: "name@file" (methods: "Type.name@file")
  name: string;
  kind: NodeKind;
  file: string;      // repo-relative path
  line: number;      // 1-indexed
  lineApproximate?: boolean; // legacy outlines only know the enclosing declaration
  sig: string;       // one-line signature for foveated rendering
  lang: string;      // ast-grep language name, or "config" / "text"
}

export interface Edge {
  a: number;         // index into Graph.nodes
  b: number;
  kind: EdgeKind;
  w: number;         // conductance >= 0
}

export interface Anchor {
  id: string;        // e.g. "GET /api/users/{*}"
  kind: string;      // "route"
  label: string;     // display label
  nodeId: string;    // handler symbol node id, or enclosing node
  file: string;
  line: number;
  implicit?: boolean; // tier-3 discovered shape: half hub gravity, shown with △
}

export interface Graph {
  nodes: NodeRec[];
  edges: Edge[];
  byName: Map<string, number[]>;   // lowercased name -> node indices
  byFile: Map<string, number[]>;   // file -> node indices (sorted by line)
  anchors: Anchor[];
  files: string[];
}

export interface SymbolRec {
  name: string;
  kind: NodeKind;
  file: string;
  line: number;
  lineApproximate?: boolean;
  sig: string;
  lang: string;
}

export interface ImportSite { file: string; spec: string; line: number; }
export interface CallSite { file: string; line: number; callee: string; }
export interface LiteralSite { file: string; line: number; text: string; }
