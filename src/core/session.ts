// Per-workspace, per-agent state. Disclosure belongs to one focus key:
// repeated focus preserves its seed/direct nucleus and suppresses seen
// periphery, while a new seed/scope resets to sharp context. Cached Chebyshev
// vectors keep dwell cheap across wider timescales within that focus.

import { agentStateKey, scopedStateKey } from "../runtime.js";
import { AGENT_CACHE_LIMIT } from "./asyncutil.js";
import type { NodeKind } from "./types.js";

interface FocusScope {
  path?: string;
  language?: string;
  kind?: NodeKind;
}

export interface FoveaSession {
  root: string;
  t: number;
  seeds: number[];
  seedNote: string;
  focusKey: string;
  scope: FocusScope;
  disclosed: Set<string>;
  /** Top-level logical directories/files this agent deliberately entered. */
  syncScopes: Set<string>;
  tk: Float64Array[];
  tkKey: string;
}

export const FOCUS_T0 = 2;
export const TK_ORDER = 80; // covers dwell up to t ~ 33 with full accuracy
const SESSION_CACHE_LIMIT = AGENT_CACHE_LIMIT;
const sessions = new Map<string, FoveaSession>();

export const getSession = (root: string): FoveaSession => {
  const key = agentStateKey(root);
  const hit = sessions.get(key);
  if (hit) {
    sessions.delete(key);
    sessions.set(key, hit);
    return hit;
  }
  const session: FoveaSession = {
    root,
    t: FOCUS_T0,
    seeds: [],
    seedNote: "",
    focusKey: "",
    scope: {},
    disclosed: new Set<string>(),
    syncScopes: new Set<string>(),
    tk: [],
    tkKey: "",
  };
  sessions.set(key, session);
  while (sessions.size > SESSION_CACHE_LIMIT) sessions.delete(sessions.keys().next().value!);
  return session;
};

const normalized = (value: string): string => value.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
const absoluteLike = (value: string): boolean => value.startsWith("/") || /^[A-Za-z]:\//.test(value);

/** Resolve a provider path to one slash-normalized repository-relative id
 * without asking host node:path to interpret the execution provider's syntax. */
const repoRelativePath = (root: string, input: string): string | undefined => {
  const rawInput = input.startsWith("@") ? input.slice(1) : input;
  const raw = normalized(rawInput.trim());
  const base = normalized(root).replace(/\/$/, "");
  if (!raw || raw === ".") return undefined;
  let rel = raw;
  if (absoluteLike(raw)) {
    const insensitive = /^[A-Za-z]:\//.test(base);
    const lhs = insensitive ? raw.toLowerCase() : raw;
    const rhs = insensitive ? base.toLowerCase() : base;
    if (lhs === rhs) return undefined;
    if (!lhs.startsWith(rhs + "/")) return undefined;
    rel = raw.slice(base.length + 1);
  }
  const parts: string[] = [];
  for (const part of rel.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts.join("/") : undefined;
};

/** A shared-root session treats each top-level child as a logical workspace.
 * Root files remain exact scopes, while any descendant maps to its first path
 * segment. This keeps umbrella indexing broad without letting sibling task
 * directories enter the active conversation. */
export const syncScopeForPath = (root: string, input: string): string | undefined => {
  const rel = repoRelativePath(root, input);
  if (!rel) return undefined;
  const slash = rel.indexOf("/");
  return slash < 0 ? rel : rel.slice(0, slash);
};

export const observeSessionPaths = (root: string, paths: readonly string[]): string[] => {
  const session = getSession(root);
  for (const path of paths) {
    const scope = syncScopeForPath(root, path);
    if (scope) session.syncScopes.add(scope);
  }
  return [...session.syncScopes].sort();
};

export const resetSession = (root: string): void => {
  sessions.delete(agentStateKey(root));
};

export const resetSessionFor = (workspaceKey: string, scopeKey: string): void => {
  sessions.delete(scopedStateKey(workspaceKey, scopeKey));
};

export const resetSessions = (): void => {
  sessions.clear();
};
