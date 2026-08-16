// Thin runner over the ast-grep CLI. All extraction goes through here.
// Resolution: FOVEA_AST_GREP env var, packaged CLI, then `ast-grep` on PATH.
//
// Everything is async and gated: a cold build fans chunk invocations out to
// SPAWN_CONCURRENCY processes instead of serializing spawnSync behind the
// TUI's event loop; the loop never stalls waiting on a child process.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ROOT_CACHE_LIMIT, SPAWN_CONCURRENCY, envInt, mapLimit, spawnGate } from "./asyncutil.js";
import { currentRuntime, maybeRuntime } from "../runtime.js";

export const LANG_BY_EXT: Record<string, string> = {
  ts: "TypeScript", tsx: "Tsx", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "Tsx", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  // Second tier: symbols via ast-grep outline; name derivation is heuristic.
  ex: "Elixir", exs: "Elixir",
  rb: "Ruby",
  c: "C", h: "C",
  cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++",
  java: "Java",
  kt: "Kotlin", kts: "Kotlin",
  lua: "Lua",
  php: "Php",
  swift: "Swift",
  scala: "Scala",
  hs: "Haskell",
  sh: "Bash",
};

// Compiled artifacts masquerading as source extensions.
const BINARY_EXTS = new Set(["beam", "pyc", "o", "obj", "so", "a", "d"]);
export const isBinaryExt = (file: string): boolean =>
  BINARY_EXTS.has(file.split(".").pop()?.toLowerCase() ?? "");

// Non-code files: literals are regex-extracted so config/spec files can join.
const CONFIG_EXTS = new Set(["yaml", "yml", "json", "toml", "env", "tf", "hcl", "md"]);

export interface AgMatch {
  file: string;                    // as passed to ast-grep (repo-relative)
  line: number;                    // 1-indexed
  text: string;                    // full matched node text
  single: Record<string, string>;  // $VAR -> text (single metavars)
  multi: Record<string, string[]>; // $$$VAR -> texts
}

interface ScanConstraint {
  regex?: string;
  not?: ScanConstraint;
  all?: ScanConstraint[];
}

export interface ScanRule {
  id: string;
  language: string;
  pattern: string;
  constraints?: Record<string, ScanConstraint>;
}

export interface ScanMatch extends AgMatch {
  ruleId: string;
}

/** Drop redundant named variadic captures while preserving matching and match text. */
export const anonymousVariadics = (pattern: string): string =>
  pattern.replace(/\$\$\$[A-Za-z_][A-Za-z0-9_]*/g, () => "$$$");

const packagedBinary = (() => {
  try {
    const packageJson = createRequire(import.meta.url).resolve("@ast-grep/cli/package.json");
    return join(dirname(packageJson), process.platform === "win32" ? "ast-grep.exe" : "ast-grep");
  } catch {
    return undefined;
  }
})();

const FAILURE_TTL_MS = 15_000;
interface BinarySelection { readonly binary?: string; readonly at: number }
const selections = new Map<string, BinarySelection>();
const selectionInflight = new Map<string, Promise<string | undefined>>();
const selectionKey = (workspaceKey: string): string =>
  workspaceKey + "\0" + (process.env.FOVEA_AST_GREP ?? "<default>");
const binaryCandidates = (): string[] => {
  const override = process.env.FOVEA_AST_GREP;
  if (override !== undefined) return [override];
  return [...new Set([packagedBinary, "ast-grep"].filter((value): value is string => value !== undefined))];
};
const touchSelection = (key: string, value: BinarySelection): void => {
  selections.delete(key);
  selections.set(key, value);
  while (selections.size > ROOT_CACHE_LIMIT * 4) selections.delete(selections.keys().next().value!);
};

/** Resolve ast-grep in the active filesystem/subprocess execution world. */
const selectedBinary = (): Promise<string | undefined> => {
  const runtime = currentRuntime();
  const key = selectionKey(runtime.workspaceKey);
  const hit = selections.get(key);
  if (hit && (hit.binary !== undefined || Date.now() - hit.at < FAILURE_TTL_MS)) {
    touchSelection(key, hit);
    return Promise.resolve(hit.binary);
  }
  const pending = selectionInflight.get(key);
  if (pending) return pending;
  const probe = spawnGate.run(async () => {
    for (const candidate of binaryCandidates()) {
      try {
        const result = await runtime.run([candidate, "--version"], { timeoutMs: 5_000, maxBytes: 1024 * 1024 });
        if (result.exitCode === 0 && !result.timedOut && !result.aborted) return candidate;
      } catch {
        // A packaged host path can be absent in a remote execution world; try PATH next.
      }
    }
    return undefined;
  }).then((resolved) => {
    touchSelection(key, { ...(resolved === undefined ? {} : { binary: resolved }), at: Date.now() });
    return resolved;
  }).finally(() => selectionInflight.delete(key));
  selectionInflight.set(key, probe);
  return probe;
};

/** Last known availability for the currently bound execution world. */
export const hasAstGrep = (): boolean => {
  const runtime = maybeRuntime();
  return runtime !== undefined && selections.get(selectionKey(runtime.workspaceKey))?.binary !== undefined;
};

/** Non-blocking availability probe for extension hooks and graph builds. */
export const hasAstGrepAsync = async (): Promise<boolean> => (await selectedBinary()) !== undefined;

// Import-file argument lists on Windows cap around 8k chars; keep chunks
// conservative. Extraction batches align to this boundary so each consolidated
// scan normally pays one process.
export const AST_GREP_CHUNK = envInt("FOVEA_AST_GREP_CHUNK", 160, 32, 2048);

// Extraction honesty ledger: a failed ast-grep invocation implicates every
// file in its chunk. build.ts drains this once per fact pass and folds it
// into the extraction report surfaced by tools, /fovea status, `fovea status`.
export interface ExtractionFailure {
  op: "outline" | "outline-structured" | "run";
  lang?: string;
  files: string[];
}
const failures: ExtractionFailure[] = [];
const recordFailure = (op: ExtractionFailure["op"], files: string[], lang?: string): void => {
  failures.push({ op, files, ...(lang === undefined ? {} : { lang }) });
};
export const drainExtractionFailures = (): ExtractionFailure[] => failures.splice(0, failures.length);

const RUN_TIMEOUT = 120_000;
// 160-file chunks answer a few MB typically; the cap exists so a pathological
// JSON dump fails one chunk instead of inflating the gate's resident set.
const RUN_MAX_BUFFER = 16 * 1024 * 1024;

interface RunResult { ok: boolean; stdout: string; split: boolean }

const run = async (args: string[], cwd: string): Promise<RunResult> => {
  const bin = await selectedBinary();
  if (bin === undefined) return { ok: false, stdout: "", split: false };
  return spawnGate.run(async () => {
    try {
      const result = await currentRuntime().run([bin, ...args], {
        cwd, timeoutMs: RUN_TIMEOUT, maxBytes: RUN_MAX_BUFFER,
      });
      if (result.stdoutTruncated || result.stderrTruncated) return { ok: false, stdout: "", split: true };
      if (result.timedOut || result.aborted || result.exitCode === null) return { ok: false, stdout: "", split: false };
      if (result.exitCode !== 0) {
        // ast-grep uses exit 1 with no stderr for a successful zero-match run.
        return result.stderr.trim()
          ? { ok: false, stdout: "", split: false }
          : { ok: true, stdout: "", split: false };
      }
      return { ok: true, stdout: result.stdout, split: false };
    } catch {
      return { ok: false, stdout: "", split: false };
    }
  });
};

export const langOf = (file: string): string | undefined => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext];
};

export const isConfigFile = (file: string): boolean => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return CONFIG_EXTS.has(ext);
};

export const groupByLang = (files: string[]): Map<string, string[]> => {
  const m = new Map<string, string[]>();
  for (const f of files) {
    const lang = langOf(f);
    if (!lang) continue;
    const arr = m.get(lang) ?? [];
    arr.push(f);
    m.set(lang, arr);
  }
  return m;
};

// `ast-grep outline` is the uniform symbol source across languages.
// Expanded JSON is primary; the legacy text view remains as a compatibility fallback.
interface OutlineRange {
  start: { line: number; column: number };
  end?: { line: number; column: number };
}

export interface OutlineSymbol {
  role: "item" | "member";
  symbolType: string;
  name: string;
  range: OutlineRange;
  signature: string;
  astKind?: string;
  members?: OutlineSymbol[];
}

export interface OutlineFile {
  path: string;
  language: string;
  items: OutlineSymbol[];
}

// Chunks of one stage fan out concurrently, bounded by the shared spawn gate.
// Order is preserved (mapLimit keeps indices) so concatenated text output
// stays deterministic for the outline parser.
const runChunked = async (
  files: string[],
  chunkArgs: (chunk: string[]) => string[],
  cwd: string,
): Promise<Array<{ chunk: string[]; result: RunResult }>> => {
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += AST_GREP_CHUNK) chunks.push(files.slice(i, i + AST_GREP_CHUNK));
  const adaptive = async (chunk: string[]): Promise<Array<{ chunk: string[]; result: RunResult }>> => {
    const result = await run(chunkArgs(chunk), cwd);
    if (!result.split || chunk.length === 1) return [{ chunk, result }];
    const middle = Math.ceil(chunk.length / 2);
    const halves = await Promise.all([
      adaptive(chunk.slice(0, middle)),
      adaptive(chunk.slice(middle)),
    ]);
    return [...halves[0], ...halves[1]];
  };
  const settled = await mapLimit(chunks, SPAWN_CONCURRENCY, adaptive);
  return settled.flat();
};

// Expanded JSON preserves each member's own range and signature. Return
// undefined when the installed ast-grep predates this interface so callers can
// fall back without presenting parent locations as exact member locations.
export const outlineStructured = async (files: string[], _lang: string, cwd: string): Promise<OutlineFile[] | undefined> => {
  const out: OutlineFile[] = [];
  // A subprocess failure here is NOT recorded: extractSymbols falls back to
  // the text outline for old ast-grep versions, and that text run is what
  // records a genuine failure (old versions must not read as failures).
  const settled = await runChunked(
    files,
    (chunk) => ["outline", "--json=compact", "--view=expanded", ...chunk],
    cwd,
  );
  for (const { result } of settled) {
    if (!result.stdout.trim()) return undefined;
    try {
      const parsed = JSON.parse(result.stdout) as OutlineFile[];
      if (!Array.isArray(parsed)) return undefined;
      for (const file of parsed) out.push(file);
    } catch {
      return undefined;
    }
  }
  return out;
};

export const outline = async (files: string[], lang: string, cwd: string): Promise<string> => {
  let out = "";
  const settled = await runChunked(files, (chunk) => ["outline", ...chunk], cwd);
  for (const { chunk, result } of settled) {
    if (!result.ok) {
      recordFailure("outline", chunk, lang);
      continue;
    }
    out += result.stdout;
  }
  return out;
};

interface RawMatch {
  text: string;
  range: { start: { line: number; column: number } };
  file: string;
  metaVariables?: {
    single?: Record<string, { text: string }>;
    multi?: Record<string, Array<{ text: string }>>;
  };
}

interface RawScanMatch extends RawMatch { ruleId: string }

const fromRawMatch = (m: RawMatch): AgMatch => {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(m.metaVariables?.single ?? {})) single[key] = value.text;
  for (const [key, value] of Object.entries(m.metaVariables?.multi ?? {})) multi[key] = value.map((item) => item.text);
  return { file: m.file, line: m.range.start.line + 1, text: m.text, single, multi };
};

const scanSupport = new Map<string, { ok: boolean; at: number }>();
const touchScanSupport = (key: string, value: { ok: boolean; at: number }): void => {
  scanSupport.delete(key);
  scanSupport.set(key, value);
  while (scanSupport.size > ROOT_CACHE_LIMIT * 4) scanSupport.delete(scanSupport.keys().next().value!);
};
const scanSupportInflight = new Map<string, Promise<boolean>>();

const hasRuleScan = async (): Promise<boolean> => {
  const selected = await selectedBinary();
  if (selected === undefined) return false;
  const bin = currentRuntime().workspaceKey + "\0" + selected;
  const hit = scanSupport.get(bin);
  if (hit && (hit.ok || Date.now() - hit.at < FAILURE_TTL_MS)) {
    touchScanSupport(bin, hit);
    return Promise.resolve(hit.ok);
  }
  const pending = scanSupportInflight.get(bin);
  if (pending) return pending;
  const probe = spawnGate.run(async () => {
    try {
      const result = await currentRuntime().run([selected, "scan", "--help"], { timeoutMs: 5_000, maxBytes: 1024 * 1024 });
      return result.exitCode === 0 && !result.timedOut && !result.aborted;
    } catch {
      return false;
    }
  }).then((ok) => {
    touchScanSupport(bin, { ok, at: Date.now() });
    return ok;
  }).finally(() => scanSupportInflight.delete(bin));
  scanSupportInflight.set(bin, probe);
  return probe;
};

const scanRuleFiles = new Map<string, Promise<string | undefined>>();

const materializeRuleFile = (rules: readonly ScanRule[]): Promise<string | undefined> => {
  const runtime = currentRuntime();
  const key = `${runtime.workspaceKey}\0${JSON.stringify(rules)}`;
  const hit = scanRuleFiles.get(key);
  if (hit) {
    scanRuleFiles.delete(key);
    scanRuleFiles.set(key, hit);
    return hit;
  }
  const documents = rules.map(({ id, language, pattern, constraints }) => JSON.stringify({
    id,
    language,
    rule: { pattern },
    ...(constraints ? { constraints } : {}),
  }));
  const pending = runtime.createTempText("dsh-fovea-scan-", "rules.yml", documents.join("\n---\n"));
  scanRuleFiles.set(key, pending);
  while (scanRuleFiles.size > ROOT_CACHE_LIMIT * 4) scanRuleFiles.delete(scanRuleFiles.keys().next().value!);
  void pending.catch(() => scanRuleFiles.delete(key));
  return pending;
};

const scanChunk = async (
  rulePath: string,
  files: string[],
  cwd: string,
): Promise<ScanMatch[] | undefined> => {
  const bin = await selectedBinary();
  if (bin === undefined) return undefined;
  return spawnGate.run(async () => {
    const result = await currentRuntime().run(
      [bin, "scan", "--rule", rulePath, "--json=stream", ...files],
      { cwd, timeoutMs: RUN_TIMEOUT, maxBytes: RUN_MAX_BUFFER },
    );
    if (result.exitCode !== 0 || result.timedOut || result.aborted || result.stdoutTruncated) return undefined;
    const matches: ScanMatch[] = [];
    try {
      for (const line of result.stdout.split("\n")) {
        if (!line.trim()) continue;
        const raw = JSON.parse(line) as RawScanMatch;
        if (!raw.ruleId || !raw.range?.start || typeof raw.file !== "string") return undefined;
        matches.push({ ...fromRawMatch(raw), ruleId: raw.ruleId });
      }
    } catch {
      return undefined;
    }
    return matches;
  });
};

/**
 * Run a mixed-language rule set in one ast-grep parse per file chunk.
 * Undefined means the optimized interface was unavailable or failed; callers
 * then use the legacy per-pattern path, preserving compatibility and partial
 * extraction behavior for malformed repository rules.
 */
export const scanRules = async (
  rules: readonly ScanRule[],
  files: string[],
  cwd: string,
): Promise<ScanMatch[] | undefined> => {
  if (!rules.length || !files.length) return [];
  if (!(await hasRuleScan())) return undefined;
  let rulePath: string | undefined;
  try {
    rulePath = await materializeRuleFile(rules);
  } catch {
    return undefined;
  }
  if (rulePath === undefined) return undefined;
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += AST_GREP_CHUNK) {
    chunks.push(files.slice(i, i + AST_GREP_CHUNK));
  }
  const settled = await mapLimit(chunks, SPAWN_CONCURRENCY, (chunk) =>
    scanChunk(rulePath, chunk, cwd),
  );
  if (settled.some((matches) => matches === undefined)) return undefined;
  const out: ScanMatch[] = [];
  for (const matches of settled) for (const match of matches!) out.push(match);
  return out;
};

// `ast-grep run --pattern` with JSON output for a set of files of one language.
const patternRun = async (
  pattern: string,
  lang: string,
  files: string[],
  cwd: string,
): Promise<AgMatch[]> => {
  const out: AgMatch[] = [];
  const settled = await runChunked(
    files,
    (chunk) => ["run", "--pattern", pattern, "--lang", lang, "--json=compact", ...chunk],
    cwd,
  );
  for (const { chunk, result } of settled) {
    if (!result.ok) {
      recordFailure("run", chunk, lang);
      continue;
    }
    if (!result.stdout.trim()) continue;
    let parsed: RawMatch[];
    try {
      parsed = JSON.parse(result.stdout) as RawMatch[];
    } catch {
      recordFailure("run", chunk, lang);
      continue;
    }
    if (!Array.isArray(parsed)) {
      recordFailure("run", chunk, lang);
      continue;
    }
    for (const m of parsed) out.push(fromRawMatch(m));
  }
  return out;
};

// First match of any of the patterns, per language/file set, concatenated.
// Patterns run concurrently (bounded by the spawn gate): per-stage latency
// collapses from O(patterns * chunks) processes-sequential to ~the slowest
// slice of chunks wide SPAWN_CONCURRENCY.
export const patternRunAll = async (
  patterns: string[],
  lang: string,
  files: string[],
  cwd: string,
): Promise<AgMatch[]> => {
  const perPattern = await mapLimit(patterns, patterns.length || 1, (p) => patternRun(p, lang, files, cwd));
  const out: AgMatch[] = [];
  for (const matches of perPattern) for (const m of matches) out.push(m);
  return out;
};
