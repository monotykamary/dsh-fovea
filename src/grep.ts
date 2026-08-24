/**
 * Native `grep` integration, mirroring pi-fovea's tools.grepMode:
 *
 * - off: nothing registers; the deployment's native grep runs untouched.
 * - augment (default): native grep always executes; a `tools/post-execute`
 *   listener appends a compact Fovea graph section to successful symbol-query
 *   results. Never throws: a broken or seedless graph leaves the native result.
 * - replace: every agent receives a scoped `grep` definition shadowing the
 *   global native one (DSH scoped registrations shadow globals per agent).
 *   Bare identifiers, qualified symbols, repository paths, and routes navigate
 *   the Fovea graph; regex-shaped queries and calls carrying `path`/`include`
 *   keep native ripgrep semantics by delegating to the exact global definition
 *   this deployment registered (schema, render, presentation, and spill
 *   behavior stay native-owned).
 *
 * @module dsh-fovea/grep
 */

import type { Context } from '@monotykamary/cordis'
import type { Agent } from '@monotykamary/dsh-agent'
import type { ContentBlock } from '@monotykamary/dsh-llm'
import { defineTool } from '@monotykamary/dsh-tools'
import type { JsonValue, ToolDefinition, ToolResult, ToolResultView } from '@monotykamary/dsh-tools'
import { focus } from './core/ops.js'
import type { ResolvedConfig } from './core/config.js'
import { DshFoveaRuntime } from './dsh-runtime.js'
import { withFoveaRuntime } from './runtime.js'

/** pi-fovea's classifier, kept verbatim: metacharacters mark text, not symbols. */
const REGEX_META = /[\\^$.*+?()[\]{}|]/
const QUALIFIED_SYMBOL = /^[A-Za-z_$][\w$]*(?:[.#:][A-Za-z_$][\w$]*)+$/
const REPO_PATH = /^(?:\.\/)?[\w@.-]+(?:\/[\w@.{}:$-]+)+$/
const ROUTE_PATH = /^\/[\w@.{}:$/-]+$/

/** Queries the graph can answer: bare words, qualified symbols, repo paths, routes. */
export const isSymbolLikeGrepQuery = (pattern: string): boolean =>
  !REGEX_META.test(pattern) ||
  QUALIFIED_SYMBOL.test(pattern) ||
  REPO_PATH.test(pattern) ||
  ROUTE_PATH.test(pattern)

/** Native text search stays authoritative for scoped or regex-shaped queries. */
const requestsNativeGrep = (input: { pattern: string; path?: string; include?: string }): boolean =>
  input.path !== undefined || input.include !== undefined ||
  !isSymbolLikeGrepQuery(input.pattern.trim() || input.pattern)

type GrepMatchValue = { path: string; lineNumber: number; line: string }
type ShadowValue =
  | { matches: GrepMatchValue[]; foveaError?: string }
  | { fovea: { text: string; query: string; seeds: number } }

const isGraphValue = (value: ShadowValue): value is { fovea: { text: string; query: string; seeds: number } } =>
  'fovea' in value

const SHADOW_DESCRIPTION =
  'Hybrid repository search. A bare identifier, qualified symbol, repo path, or route navigates the Fovea graph; ' +
  'regular expressions and calls with path or include preserve native grep and return exact matching lines.'

/** One truncated native header emitted by dsh-tool-fs-search's own renderer. */
const TRUNCATED_HEADER = /Found \d+ of \d+ matches/
/** Exact recovery sentence emitted when no complete-result artifact exists. */
const RECOVERY_SENTENCE = 'The complete result could not be saved; narrow pattern, path, or include to see more.'
/** Mirrors dsh-tool-fs-search's default grepMaxLineBytes for spill previews. */
const LINE_PREVIEW_BYTES = 2_000

/** Bound one matched line to the shared preview budget on a UTF-8 boundary. */
const previewLine = (line: string): string => {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.byteLength <= LINE_PREVIEW_BYTES) return line
  let end = LINE_PREVIEW_BYTES
  while (end > 0 && (bytes[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return bytes.subarray(0, end).toString('utf8') + ' (line truncated)'
}

/** Group flat matches by file (first-seen order), mirroring dsh-tool-fs-search's artifact layout. */
const formatMatches = (matches: readonly GrepMatchValue[]): string => {
  const byFile = new Map<string, GrepMatchValue[]>()
  for (const match of matches) {
    const group = byFile.get(match.path)
    if (group !== undefined) group.push(match)
    else byFile.set(match.path, [match])
  }
  return [...byFile.entries()]
    .map(([path, group]) => `${path}\n${group.map(m => `Line ${m.lineNumber}: ${m.line}`).join('\n')}`)
    .join('\n\n')
}

/** Build one agent-scoped hybrid `grep`, delegating native work to the deployment's own definition. */
const buildShadow = (ctx: Context, native: ToolDefinition, config: ResolvedConfig, agent: Agent): ToolDefinition => defineTool({
  name: 'grep',
  description: SHADOW_DESCRIPTION,
  parameters: {
    pattern: { type: 'string', required: true, description: 'Graph query for a bare identifier, repo path, or route; exact text or a regular expression when path/include are present or the pattern is regex-shaped.' },
    path: { type: 'string', description: 'File or directory to search. Supplying it selects native text grep.' },
    include: { type: 'string', description: 'One glob filter for which files to search. Supplying it selects native text grep.' },
  },
  timeoutMs: config.toolTimeoutMs,
  output: {
    schema: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  lineNumber: { type: 'integer', required: true },
                  line: { type: 'string', required: true },
                },
              },
            },
            foveaError: { type: 'string' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            fovea: {
              type: 'object',
              required: true,
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                query: { type: 'string', required: true },
                seeds: { type: 'integer', required: true },
              },
            },
          },
        },
      ],
    },
    render: (args, value) => {
      if ('fovea' in value) return [{ type: 'text' as const, text: value.fovea.text }]
      const rendered = native.output.render(args, { matches: value.matches })
      // pi-fovea prepends the degradation note before the native results block.
      return value.foveaError === undefined
        ? rendered
        : [{ type: 'text' as const, text: `fovea graph unavailable — native text results (${value.foveaError})\n` }, ...rendered]
    },
    ...(native.output.presentationMeta === undefined ? {} : {
      presentationMeta: (args: unknown, value: { matches: GrepMatchValue[]; foveaError?: string } | { fovea: { text: string; query: string; seeds: number } }) =>
        'fovea' in value
          ? { shape: 'fovea-grep', query: value.fovea.query, seeds: value.fovea.seeds }
          : native.output.presentationMeta!(args, { matches: value.matches }),
    }),
  },
  async execute(args, exec) {
    const input = {
      pattern: args.pattern,
      ...(args.path === undefined ? {} : { path: args.path }),
      ...(args.include === undefined ? {} : { include: args.include }),
    }
    const query = input.pattern.trim() || input.pattern
    // Semantic validation itself stays native-owned: native routes re-run the
    // deployment definition's own argument checks.
    if (query.length === 0 || requestsNativeGrep(input)) return native.execute(args, exec) as Promise<ShadowValue>
    const runtime = await DshFoveaRuntime.create(ctx, agent, exec.signal, { toolName: 'grep', callId: exec.callId })
    return withFoveaRuntime(runtime, async (): Promise<ShadowValue> => {
      try {
        const result = await focus(runtime.processRoot, query, config.defaultBudget, { fresh: true })
        const seeds = Number(result.details.seeds ?? 0)
        if (seeds === 0) return native.execute(args, exec) as Promise<ShadowValue>
        return { fovea: { text: result.text.replace(/^fovea focus/, 'fovea grep'), query, seeds } }
      } catch (error) {
        // Cancellation is not a graph failure and must stay a cancellation.
        exec.signal.throwIfAborted()
        const fallback = await native.execute(args, exec) as { matches: GrepMatchValue[] }
        return { ...fallback, foveaError: error instanceof Error ? error.message : String(error) }
      }
    })
  },
  ...(native.presentCall === undefined ? {} : { presentCall: (args: unknown) => native.presentCall?.(args) }),
  presentResult: (args: unknown, result: ToolResult): ToolResultView | undefined => {
    const meta = result.meta
    if (typeof meta === 'object' && meta !== null && (meta as { shape?: unknown }).shape === 'fovea-grep') return undefined
    return native.presentResult?.(args, result)
  },
})

/**
 * Replace mode: a capped native delegation through the shadow would otherwise
 * lose its complete-result artifact — dsh-tool-fs-search's own spill policy
 * defers because the SHADOW (not its definition) owns the call, and the
 * renderer reports the could-not-be-saved sentence. Re-save the full match
 * list through Fovea's call-owned spill and swap the sentence for the pointer.
 */
const registerCappedSpillParity = (ctx: Context, shadows: ReadonlySet<ToolDefinition>): void => {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'grep' || exec.parent !== undefined || result.isError) return decision
    if (decision.kind !== 'accept' || decision.content !== undefined || Object.hasOwn(decision, 'value')) return decision
    if (exec.agent === undefined || !shadows.has(ctx.tools.get('grep', exec.agent) as ToolDefinition)) return decision
    const matches = (result.value as unknown as { matches?: GrepMatchValue[] }).matches
    if (!Array.isArray(matches)) return decision
    const plain = result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    if (!TRUNCATED_HEADER.test(plain) || !plain.includes(RECOVERY_SENTENCE)) return decision
    exec.signal.throwIfAborted()
    const runtime = await DshFoveaRuntime.create(ctx, exec.agent, exec.signal, { toolName: exec.name, callId: exec.callId })
    const previewed = matches.map(match => ({ ...match, line: previewLine(match.line) }))
    const artifact = `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}\n\n${formatMatches(previewed)}`
    const ref = await withFoveaRuntime(runtime, () => runtime.spillText('grep-results.txt', artifact))
    if (ref === undefined) return decision
    const pointer = `Full grep result stored at: ${ref.locator}. ${ref.retrievalHint}`
    const content = result.content.map((block): ContentBlock =>
      block.type === 'text' && block.text.includes(RECOVERY_SENTENCE)
        ? { ...block, text: block.text.replace(RECOVERY_SENTENCE, pointer) }
        : block)
    return {
      kind: 'accept',
      content,
      ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
    }
  })
}

const registerReplace = (ctx: Context, config: ResolvedConfig): void => {
  const shadows = new Set<ToolDefinition>()
  let warned = false
  ctx.on('agent/session-start', ({ agent }) => {
    // Resolved lazily per agent: mount order between tool-fs-search and this
    // plugin is deployment-owned, while agent lifecycles follow both.
    const native = ctx.tools.get('grep')
    if (native === undefined) {
      if (!warned) {
        warned = true
        ctx.logger.warn('dsh-fovea: grep replace requested but no native grep tool is registered; fovea_focus remains the graph entry point')
      }
      return
    }
    try {
      const shadow = buildShadow(ctx, native, config, agent)
      agent.ctx.tools.register(shadow)
      shadows.add(shadow)
    } catch (error: unknown) {
      ctx.logger.warn('dsh-fovea: grep shadow registration failed (native grep stays authoritative): %o', error)
    }
  })
  registerCappedSpillParity(ctx, shadows)
}

// pi-fovea also augmented nested pi.grep calls (fabric_exec). Here the
// section appends to top-level results only: run_code sub-dispatches hand the
// structured value to their program, so a content rewrite would touch only the
// log copy. Replacing content also makes dsh-tool-fs-search's own spill policy
// defer (it requires a pristine decision), so a symbol query capped at the
// native match limit keeps its inline truncation without the spill artifact —
// the same trade pi-fovea made by rendering one combined result.
const registerAugment = (ctx: Context, config: ResolvedConfig): void => {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'grep' || exec.parent !== undefined || result.isError) return decision
    if (decision.kind !== 'accept' || exec.agent === undefined) return decision
    const raw = exec.arguments as { pattern?: unknown; path?: unknown } | undefined
    const pattern = typeof raw?.pattern === 'string' ? raw.pattern.trim() : ''
    if (pattern === '' || !isSymbolLikeGrepQuery(pattern)) return decision
    try {
      const runtime = await DshFoveaRuntime.create(ctx, exec.agent, exec.signal, { toolName: exec.name, callId: exec.callId })
      const appended = await withFoveaRuntime(runtime, async () => {
        const path = typeof raw?.path === 'string' && raw.path.trim() !== '' ? raw.path : undefined
        const focused = await focus(runtime.processRoot, pattern, config.grep.augmentBudget, {
          ...(path === undefined ? {} : { path }),
          fresh: true,
        })
        if (Number(focused.details.seeds ?? 0) === 0) return undefined
        return focused.text.replace(/^fovea focus/, 'fovea graph')
      })
      if (appended === undefined) return decision
      const base = decision.content ?? result.content
      // Consumers join content blocks with one newline; pad from the appended
      // side so native and graph sections land one blank line apart.
      const head = base.map(block => (block.type === 'text' ? block.text : '')).join('')
      const gap = head === '' || head.endsWith('\n') ? '' : '\n'
      return {
        kind: 'accept',
        content: [...base, { type: 'text' as const, text: gap + appended }],
        ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
      }
    } catch {
      // A broken graph must never break text search: leave the native result.
      return decision
    }
  })
}

/** Mount the configured native-grep integration (pi-fovea's tools.grepMode). */
export function registerFoveaGrep(ctx: Context, config: ResolvedConfig): void {
  if (config.grep.mode === 'replace') registerReplace(ctx, config)
  else if (config.grep.mode === 'augment') registerAugment(ctx, config)
}
