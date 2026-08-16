// Feature anchors: where a feature touches the outside world. Anchors are
// extracted by a declarative rule pack (ast-grep patterns + metadata), so new
// frameworks are added as data. The pack covers five port shapes:
//
//   1. recv.verb("path", handlers...)        express/koa/gin/echo/chi(net style)
//   2. verb-annotation on handler            Nest/Flask/FastAPI(+class prefix)
//   3. verb embedded in the path string      Go 1.22 mux.HandleFunc("GET /x", h)
//   4. receiver-less route DSL               Rails, Phoenix, Django
//   5. file-convention routes                Next/SvelteKit/Nuxt (extractFileRoutes)
//
// Every captured token still has to validate as a path before it can become a
// hub — the route string is the real discriminator, the call shape is flavor.
// Known blind spots (documented in README): Rust proc-macro attributes
// (actix/rocket) — ast-grep cannot parameterize attribute paths; frameworks
// with constructor-assigned prefixes (Flask Blueprint, FastAPI APIRouter,
// chi Mount); tRPC/GraphQL/gRPC have no path token to anchor at all.

import { createHash } from "node:crypto";
import { currentRuntime, executionPathJoin } from "../runtime.js";
import {
  anonymousVariadics,
  groupByLang,
  patternRunAll,
  scanRules,
  type AgMatch,
  type ScanMatch,
  type ScanRule,
} from "./astgrep.js";
import { PATH_TOKEN_RE } from "./extract.js";
import { classifyLiteral, normalizeLiteral } from "./join.js";
import { readAll, type FileSource } from "./source.js";
import type { Anchor } from "./types.js";

export interface AnchorRule {
  id: string;
  langs: string[];
  /** Single ast-grep pattern; tier-3 synthesized rules use `patterns` instead. */
  pattern?: string;
  methods: string; // regex tested against the captured method metavar
  kind: string;
  /**
   * Optional class-level prefix patterns (e.g. NestJS '@Controller("api/x")').
   * Their $P captures are collected per file; a matched route path is composed
   * prefix + suffix so the anchor id is the full router-visible path.
   */
  prefixPattern?: string[];
  /** Metavar name that carries the HTTP verb (e.g. chi `r.Method("GET", …)`). */
  verbFrom?: string;
  /** Idiom writes paths mount-relative (Django `path("users/")`): root them. */
  mountRoot?: boolean;
  /** Synthesized tier-3 rules ship as variant lists (exact arity + trailing $$$H). */
  patterns?: string[];
  /** Discovered rules: half hub gravity until a real join upgrades them. */
  implicit?: boolean;
}

// Case-insensitive method alternations are written canonically as an inline
// flag group, "^(?i:get|post)$" — an ES2025 RegExp modifier that engines
// without the feature (Node < 23 / V8 < 12.5) cannot even parse. Rewrite it
// to a plain non-capturing group with a trailing flag so every compile path
// works on older engines (see issue #1).
const INLINE_I_RE = /^\^\(\?i:([\s\S]*)\)\$$/;
export const compileMethods = (methods: string): RegExp => {
  const m = INLINE_I_RE.exec(methods);
  return m ? new RegExp(`^(?:${m[1]})$`, "i") : new RegExp(methods);
};

const HTTP_VERB_RE = /^(?:get|post|put|delete|patch|head|options)$/i;

// Verbs-in-path: Go 1.22 net/http ServeMux writes the verb inside the pattern.
const VERB_IN_PATH = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\/\S*)$/;

// Arg-node captures land with their quote chars (and Python prefixes):
// '"/users"', "'/items'", '`/users/${id}`', 'f"/users/{id}"' → inner content.
const QUOTED_RE = /^[rbfuRBFU]{0,3}(["'`])([\s\S]*)\1$/;
const unquote = (s: string): string => {
  const m = QUOTED_RE.exec(s.trim());
  return m ? m[2]! : s.trim();
};

const PLACEHOLDER_ONLY = /^(:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\[[A-Za-z_]\w*\])$/;

// Method names that are mounts, not verbs: Django urls, Rails match/root,
// Spring's umbrella RequestMapping. They anchor as ANY so the hub exists
// without pretending a verb was declared.
// Method names that mount a target rather than declare a verb. fetch(url)
// and redirect targets both resolve to GET; Django urlconfs and Rails mounts
// accept any verb.
const METHOD_ALIASES: Record<string, string> = {
  PATH: "ANY", RE_PATH: "ANY", URL: "ANY", MATCH: "ANY", ROOT: "ANY",
  REQUESTMAPPING: "ANY", RESOURCES: "ANY", FORWARD: "ANY",
  FETCH: "GET", REDIRECT: "GET", RESPONDREDIRECT: "GET", REDIRECT_TO: "GET",
};

const deriveVerb = (method: string): string => {
  let up = method.toUpperCase();
  if (up.endsWith("MAPPING")) up = up.slice(0, -"MAPPING".length); // Spring GetMapping → GET
  return METHOD_ALIASES[up] ?? up;
};

export const DEFAULT_PACK: AnchorRule[] = [
  {
    // `$P` as an arg NODE, not in-string: binds across double/single quotes,
    // backticks and Python f-strings. Quote chars are stripped by unquote().
    id: "http-route-call",
    langs: ["TypeScript", "Tsx", "JavaScript", "Go"],
    pattern: "$R.$M($P, $$$H)",
    methods: "^(?i:get|post|put|delete|patch|head|options|all|use|any|handle|handlefunc|route|group)$",
    kind: "route",
  },
  {
    // Single-arg verb call: axios.get("/me") — client call sites only become
    // feature hubs when they reference a real path (validated below).
    id: "http-verb-single-arg",
    langs: ["TypeScript", "Tsx", "JavaScript"],
    pattern: "$R.$M($P)",
    methods: "^(?i:get|post|put|delete|patch)$",
    kind: "route",
  },
  {
    id: "http-verb-single-arg-py",
    langs: ["Python"],
    pattern: "$R.$M($P)",
    methods: "^(get|post|put|delete|patch|head|options)$",
    kind: "route",
  },
  {
    id: "python-route-call",
    langs: ["Python"],
    pattern: "$R.$M($P, $$$H)",
    methods: "^(?:add_)?(?:get|post|put|delete|patch|head|options|route)$",
    kind: "route",
  },
  {
    // NestJS / Angular-style decorators; class prefix via @Controller.
    id: "ts-http-decorator",
    langs: ["TypeScript", "Tsx"],
    pattern: "@$M($P)",
    methods: "^(?i:get|post|put|delete|patch|options|head)$",
    kind: "route",
    prefixPattern: ["@Controller($P)"],
  },
  {
    id: "python-decorator-route",
    langs: ["Python"],
    pattern: "@$R.$M($P)",
    methods: "^(get|post|put|delete|patch|route|websocket)$",
    kind: "route",
  },
  {
    // chi r.Method("GET", "/x", h), aiohttp web.route(...)/router.add_route(...).
    id: "verb-as-argument",
    langs: ["Go", "Python", "TypeScript", "Tsx", "JavaScript"],
    pattern: '$R.$M("$V", "$P", $$$H)',
    methods: "^(?i:method|methodfunc|add_route|add_view|route)$",
    kind: "route",
    verbFrom: "V",
  },
  {
    // aiohttp module-level / receiver-free form: route("GET", "/x", h).
    id: "verb-as-argument-norecv",
    langs: ["Python"],
    pattern: '$M("$V", "$P", $$$H)',
    methods: "^route$",
    kind: "route",
    verbFrom: "V",
  },
  {
    // Django urlconf; mounts for every verb, so they anchor as ANY /x.
    id: "django-url",
    langs: ["Python"],
    pattern: '$M("$P", $$$H)',
    methods: "^(path|re_path|url)$",
    kind: "route",
    mountRoot: true,
  },
  {
    // Rails routes.rb macros. Bare word form, string content capture.
    id: "rails-route-macro",
    langs: ["Ruby"],
    pattern: '$M "$P", $$$R',
    methods: "^(get|post|put|delete|patch|match|redirect|mount|root|head|options)$",
    kind: "route",
  },
  {
    id: "rails-route-macro-sq",
    langs: ["Ruby"],
    pattern: "$M '$P', $$$R",
    methods: "^(get|post|put|delete|patch|match|redirect|mount|root|head|options)$",
    kind: "route",
  },
  {
    // Phoenix router.ex macros. Scope prefixes are not composed (see README).
    // resources expands to the REST verb set — anchor the mount as ANY,
    // the hub still merges with controller code via literal joins.
    id: "phoenix-route-macro",
    langs: ["Elixir"],
    pattern: '$M "$P", $$$R',
    methods: "^(get|post|put|delete|patch|head|options|forward|resources)$",
    kind: "route",
  },
  {
    id: "phoenix-route-call",
    langs: ["Elixir"],
    pattern: '$M("$P", $$$R)',
    methods: "^(get|post|put|delete|patch|head|options|forward|resources)$",
    kind: "route",
  },
  {
    // Ktor routing DSL: get("/health") { … }
    id: "ktor-routing-dsl",
    langs: ["Kotlin"],
    pattern: '$M("$P") { $$$B }',
    methods: "^(get|post|put|delete|patch|head|options|route)$",
    kind: "route",
  },
  {
    // Spring MVC / WebFlux: class @RequestMapping prefix x method @GetMapping.
    id: "spring-mapping-annotation",
    langs: ["Java", "Kotlin"],
    pattern: '@$M("$P")',
    methods: "^(Get|Post|Put|Delete|Patch)Mapping$",
    kind: "route",
    prefixPattern: ['@RequestMapping("$P")'],
  },
  {
    id: "flask-add-url-rule",
    langs: ["Python"],
    pattern: "$R.add_url_rule($P, $$$H)",
    methods: "^add_url_rule$",
    kind: "route",
  },
  {
    // Client fetch with no receiver: fetch("/api/x"). Precision-audited by
    // discovery (~93% path precision in the next.js clone corpus).
    id: "fetch-bare",
    langs: ["TypeScript", "Tsx", "JavaScript"],
    pattern: "$M($P, $$$H)",  // trailing $$$H absorbs the options bag; zero-arg tail matches fetch("/x") too
    methods: "^fetch$",
    kind: "route",
  },
  {
    // Response-side route linkage: ktor respondRedirect("/myfiles") references
    // an existing route without declaring it. Discovery found it at p̂≈0.81.
    id: "ktor-respond-redirect",
    langs: ["Kotlin"],
    pattern: "$R.$M($P, $$$H)",
    methods: "^respondRedirect$",
    kind: "route",
  },
  {
    id: "rust-router-chain",
    langs: ["Rust"],
    pattern: '$R.route("$P", $$$H)',
    methods: "^route$",
    kind: "route",
  },
];

export interface AnchorDraft extends Anchor {}

// NestJS mounts every controller at the router root, so the joined path is
// always slash-rooted regardless of how each framework writes the pieces.
const joinRoute = (prefix: string, child: string): string => {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  const c = child.replace(/^\/+|\/+$/g, "");
  return c ? `/${[p, c].filter(Boolean).join("/")}` : `/${p}`;
};

interface AnchorMatchGroup {
  rule: AnchorRule;
  prefixes: AgMatch[];
  matches: AgMatch[];
}

const anchorsFromGroups = (
  groups: readonly AnchorMatchGroup[],
  resolveEnclosing: (file: string, line: number) => string | undefined,
): AnchorDraft[] => {
  const out: AnchorDraft[] = [];
  for (const { rule, prefixes: prefixMatches, matches } of groups) {
    const methodRe = compileMethods(rule.methods);
    const prefixes = new Map<string, string>();
    for (const match of prefixMatches) {
      const prefix = match.single.P?.trim();
      if (prefix !== undefined && !prefixes.has(match.file)) prefixes.set(match.file, unquote(prefix));
    }
    for (const match of matches) {
      const method = match.single.M;
      const pathLike = match.single.P;
      if (!method || !pathLike || !methodRe.test(method)) continue;
      const prefix = prefixes.get(match.file);
      let raw = prefix !== undefined && prefix !== "" ? joinRoute(prefix, unquote(pathLike)) : unquote(pathLike);
      if (rule.mountRoot && !raw.startsWith("/")) raw = "/" + raw.replace(/^\/+/, "");
      const verbInPath = VERB_IN_PATH.exec(raw);
      let verbOverride: string | undefined;
      if (verbInPath) {
        verbOverride = verbInPath[1]!.toUpperCase();
        raw = verbInPath[2]!;
      }
      if (!PATH_TOKEN_RE.test(raw) && !PLACEHOLDER_ONLY.test(raw)) continue;
      let httpMethod: string;
      if (rule.verbFrom) {
        const verb = match.single[rule.verbFrom];
        if (!verb || !HTTP_VERB_RE.test(verb)) continue;
        httpMethod = verb.toUpperCase();
      } else {
        httpMethod = verbOverride ?? deriveVerb(method);
      }
      const norm = normalizeLiteral(raw, "path");
      const label = `${httpMethod} ${norm}`;
      const enclosing = resolveEnclosing(match.file, match.line);
      out.push({
        id: label,
        kind: rule.kind,
        label,
        nodeId: enclosing ?? `file:${match.file}`,
        file: match.file,
        line: match.line,
        ...(rule.implicit ? { implicit: true } : {}),
      });
    }
  }
  return dedupeAnchors(out);
};

interface AnchorScanGroup {
  rule: AnchorRule;
  prefixIds: string[];
  matchIds: string[];
}

export interface AnchorScanPlan {
  rules: ScanRule[];
  groups: AnchorScanGroup[];
}

export const anchorScanPlan = (files: string[], pack: AnchorRule[] = DEFAULT_PACK): AnchorScanPlan => {
  const byLang = groupByLang(files);
  const rules: ScanRule[] = [];
  const groups: AnchorScanGroup[] = [];
  let ordinal = 0;
  for (const rule of pack) {
    for (const language of rule.langs) {
      if (!byLang.get(language)?.length) continue;
      const prefixIds: string[] = [];
      const matchIds: string[] = [];
      for (const pattern of rule.prefixPattern ?? []) {
        const id = `fovea-anchor-prefix-${ordinal++}`;
        prefixIds.push(id);
        rules.push({ id, language, pattern: anonymousVariadics(pattern) });
      }
      for (const pattern of rule.patterns ?? [rule.pattern!]) {
        const id = `fovea-anchor-match-${ordinal++}`;
        matchIds.push(id);
        rules.push({
          id,
          language,
          pattern: anonymousVariadics(pattern),
          constraints: { M: { regex: rule.methods } },
        });
      }
      groups.push({ rule, prefixIds, matchIds });
    }
  }
  return { rules, groups };
};

export const anchorsFromScan = (
  matches: readonly ScanMatch[],
  plan: AnchorScanPlan,
  resolveEnclosing: (file: string, line: number) => string | undefined,
): AnchorDraft[] => {
  const byRule = new Map<string, ScanMatch[]>();
  for (const match of matches) {
    const bucket = byRule.get(match.ruleId);
    if (bucket) bucket.push(match);
    else byRule.set(match.ruleId, [match]);
  }
  const groups: AnchorMatchGroup[] = plan.groups.map(({ rule, prefixIds, matchIds }) => ({
    rule,
    prefixes: prefixIds.flatMap((id) => byRule.get(id) ?? []),
    matches: matchIds.flatMap((id) => byRule.get(id) ?? []),
  }));
  return anchorsFromGroups(groups, resolveEnclosing);
};

export const extractAnchors = async (
  files: string[],
  cwd: string,
  resolveEnclosing: (file: string, line: number) => string | undefined,
  pack: AnchorRule[] = DEFAULT_PACK,
): Promise<AnchorDraft[]> => {
  const plan = anchorScanPlan(files, pack);
  const scanned = await scanRules(plan.rules, files, cwd);
  if (scanned !== undefined) return anchorsFromScan(scanned, plan, resolveEnclosing);

  const byLang = groupByLang(files);
  const groups: AnchorMatchGroup[] = [];
  for (const rule of pack) {
    for (const language of rule.langs) {
      const langFiles = byLang.get(language);
      if (!langFiles?.length) continue;
      const prefixes = rule.prefixPattern?.length
        ? await patternRunAll(rule.prefixPattern, language, langFiles, cwd)
        : [];
      const matches = await patternRunAll(rule.patterns ?? [rule.pattern!], language, langFiles, cwd);
      groups.push({ rule, prefixes, matches });
    }
  }
  return anchorsFromGroups(groups, resolveEnclosing);
};

// Frameworks where the route *is* the file path (no route string exists in
// code at all): Next App Router, SvelteKit, Nuxt. Each rule is a regex with
// capture group 1 = route stem, plus how verbs are known.
export interface FileRouteRule {
  id: string;
  re: string;
  verbs: "exports" | "suffix";
  pathPrefix?: string; // prepended to the derived route (Nuxt /api)
  kind?: string; // default "route"
}

const DEFAULT_FILE_ROUTES: FileRouteRule[] = [
  { id: "next-app-route", re: "(?:^|/)app/(.+)/route\\.(?:ts|tsx|js|jsx|mjs)$", verbs: "exports", kind: "route" },
  { id: "next-app-page", re: "(?:^|/)app/(?:(.+)/)?page\\.(?:tsx|jsx|mdx)$", verbs: "suffix", kind: "page" },
  { id: "next-pages-api", re: "(?:^|/)pages/api/(.+)\\.(?:ts|tsx|js|jsx)$", verbs: "suffix", pathPrefix: "/api", kind: "route" },
  { id: "sveltekit-server", re: "(?:^|/)src/routes/(?:(.+)/)?\\+server\\.(?:ts|js)$", verbs: "exports", kind: "route" },
  { id: "sveltekit-page", re: "(?:^|/)src/routes/(?:(.+)/)?\\+page\\.(?:svelte|md)$", verbs: "suffix", kind: "page" },
  { id: "nuxt-server-api", re: "(?:^|/)server/api/(.+)\\.(?:ts|js|mjs)$", verbs: "suffix", pathPrefix: "/api", kind: "route" },
  { id: "astro-endpoint", re: "(?:^|/)src/pages/(.+)\\.(?:ts|js|mjs)$", verbs: "exports", kind: "route" },
];

// `export async function GET`, `export const POST` — route handler verbs.
const EXPORTED_VERB_RE = /\bexport\s+(?:(?:async\s+)?function\s+|const\s+)(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
const SUFFIX_VERB_RE = /\.(get|post|put|delete|patch|head|options)$/i;

// Cards → concrete path. `(group)` segments vanish (Next), dynamic segments
// become the canonical {*} placeholder, `index` is the path itself.
const FILE_DYNAMIC_SEG = /^@?\[+(?:\.\.\.)?[^\]]+\]+$/; // [x], [...x], [[...x]] (optional catch-all), @[x]
const toFileRoutePath = (stem: string): string => {
  if (stem === "") return "/";
  const segs = stem.split("/").flatMap((seg) => {
    if (!seg || /^\(.+\)$/.test(seg)) return [];
    if (FILE_DYNAMIC_SEG.test(seg)) return ["{*}"];
    if (seg === "index") return [];
    return [seg];
  });
  return "/" + segs.filter((s) => s !== "").join("/");
};

export const extractFileRoutes = async (
  files: string[],
  root: string,
  rules: FileRouteRule[] = DEFAULT_FILE_ROUTES,
  source?: FileSource,
): Promise<AnchorDraft[]> => {
  const compiled = rules.map((r) => ({ rule: r, re: new RegExp(r.re) }));
  const out: AnchorDraft[] = [];
  // Route files whose verbs come from exported handler names need one read;
  // batch them through the shared provider ahead of the match loop.
  const verbReaders: string[] = [];
  for (const file of files) {
    for (const { rule, re } of compiled) {
      const match = re.exec(file);
      if (match && rule.verbs === "exports") {
        verbReaders.push(file);
        break;
      }
    }
  }
  const texts = source ? await readAll(verbReaders, source) : new Map<string, string>();
  for (const file of files) {
    for (const { rule, re } of compiled) {
      const match = re.exec(file);
      if (!match) continue;
      let stem = match[1] ?? ""; // optional dir group: route lives at the root
      if (!stem && !rule.pathPrefix) { /* root page/endpoint: keep going, path is / */ }
      const verbs = new Set<string>();
      let suffixVerb: string | undefined;
      const sv = SUFFIX_VERB_RE.exec(stem);
      if (sv) {
        suffixVerb = sv[1]!.toUpperCase();
        stem = stem.slice(0, -sv[0].length);
      }
      if (rule.verbs === "suffix") {
        if (suffixVerb) verbs.add(suffixVerb);
      } else {
        let content = texts.get(file);
        if (content === undefined) {
          try {
            content = (source ? await source.read(file) : await currentRuntime().readText(executionPathJoin(root, file))) ?? "";
          } catch {
            content = ""; // unreadable: fall through with no verbs
          }
        }
        for (const vm of content.matchAll(EXPORTED_VERB_RE)) verbs.add(vm[1]!);
      }
      if (verbs.size === 0) verbs.add("ANY")
      const rel = (rule.pathPrefix ?? "") + toFileRoutePath(stem);
      const norm = normalizeLiteral(rel, "path");
      for (const verb of verbs) {
        const label = `${verb} ${norm}`;
        out.push({
          id: label,
          kind: rule.kind ?? "route",
          label,
          nodeId: `file:${file}`,
          file,
          line: 0,
        });
      }
    }
  }
  return dedupeAnchors(out);
};

const dedupeAnchors = (out: AnchorDraft[]): AnchorDraft[] => {
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.id}|${a.file}|${a.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Hash of the built-in packs: code changes to the default pack invalidate
// cached anchor facts even when a repo ships no rules.json of its own.
const DEFAULTS_SHA = createHash("sha1")
  .update(JSON.stringify(DEFAULT_PACK))
  .update(JSON.stringify(DEFAULT_FILE_ROUTES))
  .digest("hex");

// Repo-local overrides: .fovea/rules.json = { "rules": AnchorRule[], "fileRoutes": FileRouteRule[] }.
export const loadRepoRules = async (root: string): Promise<{ pack: AnchorRule[]; fileRoutes: FileRouteRule[]; sha: string }> => {
  let raw = "";
  try {
    raw = await currentRuntime().readText(executionPathJoin(root, ".fovea", "rules.json"));
  } catch {
    return { pack: DEFAULT_PACK, fileRoutes: DEFAULT_FILE_ROUTES, sha: DEFAULTS_SHA };
  }
  // Repo rules extend defaults; the defaults themselves ride in the hash,
  // so upgrading dsh-fovea invalidates anchors even with no repo rules file.
  const sha = createHash("sha1").update(DEFAULTS_SHA + raw).digest("hex");
  try {
    const parsed = JSON.parse(raw) as { rules?: AnchorRule[]; fileRoutes?: FileRouteRule[] };
    const rules = (parsed.rules ?? []).filter(
      (r) => r && typeof r.pattern === "string" && typeof r.methods === "string" && Array.isArray(r.langs),
    );
    const fileRoutes = (parsed.fileRoutes ?? []).filter((r) => r && typeof r.re === "string" && typeof r.verbs === "string");
    return { pack: [...DEFAULT_PACK, ...rules], fileRoutes: [...DEFAULT_FILE_ROUTES, ...fileRoutes], sha };
  } catch {
    return { pack: DEFAULT_PACK, fileRoutes: DEFAULT_FILE_ROUTES, sha };
  }
};
