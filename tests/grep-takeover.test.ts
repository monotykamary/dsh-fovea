import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@monotykamary/cordis'
import { agentEvents, type Agent } from '@monotykamary/dsh-agent'
import { createScope, type Scope } from '@monotykamary/dsh-scope'
import LocalFileSystem from '@monotykamary/dsh-fs-local'
import LocalSubprocessRuntime from '@monotykamary/dsh-subprocess-local'
import LocalSpillStore from '@monotykamary/dsh-spill-local'
import SystemPrompt from '@monotykamary/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@monotykamary/dsh-tools'
import * as Fovea from '../src/index.js'

let root = ''
let seq = 0

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-fovea-grep-')))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'package.json'), '{"name":"fixture","private":true}\n')
  await writeFile(join(root, 'src', 'users.ts'), [
    'export interface User { id: string }',
    'export function loadUser(id: string): User { return { id } }',
    'export function handleUser(id: string): User { return loadUser(id) }',
    '',
  ].join('\n'))
})

afterEach(async () => {
  if (root !== '') await rm(root, { recursive: true, force: true })
})

type Match = { path: string; lineNumber: number; line: string }

const DEFAULT_MATCHES: Match[] = [
  { path: 'src/users.ts', lineNumber: 2, line: 'export function loadUser(id: string): User { return { id } }' },
]

interface NativeHandle {
  calls: unknown[]
}

/** Register a synthetic native `grep`, mirroring dsh-tool-fs-search's value/render contract. */
function registerNativeGrep(ctx: Context, options: { matches?: Match[]; cap?: number } = {}): NativeHandle {
  const matches = options.matches ?? DEFAULT_MATCHES
  const cap = options.cap ?? 250
  const calls: unknown[] = []
  ctx.tools.register(defineTool({
    name: 'grep',
    description: 'synthetic native grep',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search.' },
      include: { type: 'string', description: 'One glob filter.' },
    },
    output: {
      schema: {
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
        },
      },
      render: (_args, value) => {
        const all = value.matches
        const kept = all.slice(0, cap)
        const header = all.length > kept.length ? `Found ${kept.length} of ${all.length} matches` : `Found ${all.length} ${all.length === 1 ? 'match' : 'matches'}`
        const body = kept.map(match => `${match.path}\nLine ${match.lineNumber}: ${match.line}`).join('\n\n')
        const recovery = all.length > kept.length
          ? '\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)'
          : ''
        return [{ type: 'text' as const, text: `${header}\n\n${body}${recovery}` }]
      },
      presentationMeta: (_args, value) => ({ shape: 'matches', count: value.matches.length }),
    },
    execute: async (args) => {
      calls.push(args)
      return { matches }
    },
  }))
  return { calls }
}

interface Subject {
  agent: Agent
  scope: Scope
}

/** Host plugin carrying the dependency API a live agent ctx inherits. */
function subjectHost(): void {}
subjectHost.inject = ['tools']

function subject(ctx: Context, id: string): Subject {
  const agent = {
    id,
    session: {
      id: `session-${id}`,
      header: { cwd: root, id: `session-${id}` },
      events: [],
      append: (type: string, data: unknown) => ({ type, data, seq: ++seq, at: Date.now() }),
    },
  } as never as Agent
  // Real agents receive ctx from the harness: an agent-scoped context minted
  // under the agent-loop's dependency API; registrations unwind on disposal.
  const host = ctx.plugin(subjectHost)
  const scope = createScope(host.ctx, agent)
  ;(agent as { ctx?: Context }).ctx = scope.ctx.extend({ agent })
  return { agent, scope }
}

async function mountAll(config: Fovea.Config, options: { native?: { matches?: Match[]; cap?: number }; spill?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  if (options.spill === true) await ctx.plugin(LocalSpillStore, { root: join(root, '.spills') })
  const native = registerNativeGrep(ctx, options.native ?? {})
  await ctx.plugin(Fovea, config)
  return { ctx, native }
}

function call(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `grep-test-${++seq}` as never,
    name,
    arguments: args,
    agent,
  })
}

const textOf = (contents: readonly { type: string; text?: string }[]): string =>
  contents.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')

describe('grep takeover (replace mode)', () => {
  it('shadows the native definition only inside the registered agent scope', async () => {
    const { ctx, native } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'replace' } })
    const { agent, scope } = subject(ctx, 'agent-shadow-scope')
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })

    const globalView = ctx.tools.get('grep')
    const scopedView = ctx.tools.get('grep', agent)
    expect(globalView).toBeDefined()
    expect(scopedView).toBeDefined()
    expect(scopedView).not.toBe(globalView)
    expect(globalView!.name).toBe('grep')
    expect(scopedView!.description).toContain('Hybrid repository search')
    expect(native.calls).toHaveLength(0)
    await scope.dispose()
    await ctx.fiber.dispose()
  })

  it('routes bare symbol queries through the Fovea graph', async () => {
    const { ctx, native } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'replace' } })
    const { agent, scope } = subject(ctx, 'agent-symbol')
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })

    const result = await call(ctx, 'grep', { pattern: 'loadUser' }, agent)
    expect(result.isError).toBe(false)
    const value = result.value as { fovea: { text: string; query: string; seeds: number } } | undefined
    expect(value?.fovea?.query).toBe('loadUser')
    expect(value?.fovea?.seeds).toBeGreaterThanOrEqual(1)
    expect(textOf(result.content)).toContain('fovea grep')
    expect(textOf(result.content)).toContain('loadUser')
    expect(result.meta).toMatchObject({ shape: 'fovea-grep', query: 'loadUser' })
    expect(native.calls).toHaveLength(0)
    await scope.dispose()
    await ctx.fiber.dispose()
  }, 30_000)

  it('keeps regex-shaped and scoped queries on the native definition', async () => {
    const { ctx, native } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'replace' } })
    const { agent, scope } = subject(ctx, 'agent-native-routes')
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })

    const regex = await call(ctx, 'grep', { pattern: 'loadU[a-z]+' }, agent)
    expect(regex.isError).toBe(false)
    expect((regex.value as { matches?: Match[] }).matches).toHaveLength(1)
    expect(textOf(regex.content)).toContain('Found 1 match')

    const scoped = await call(ctx, 'grep', { pattern: 'loadUser', path: 'src' }, agent)
    expect((scoped.value as { matches?: Match[] }).matches).toHaveLength(1)

    const included = await call(ctx, 'grep', { pattern: 'loadUser', include: '*.ts' }, agent)
    expect((included.value as { matches?: Match[] }).matches).toHaveLength(1)

    expect(native.calls).toHaveLength(3)
    await scope.dispose()
    await ctx.fiber.dispose()
  }, 30_000)

  it('falls back to native text search on a graph miss', async () => {
    const { ctx, native } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'replace' } })
    const { agent, scope } = subject(ctx, 'agent-graph-miss')
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })

    const result = await call(ctx, 'grep', { pattern: 'definitelyMissingSymbol' }, agent)
    expect(result.isError).toBe(false)
    const value = result.value as { matches?: Match[]; foveaError?: string } | undefined
    expect(value?.matches).toHaveLength(1)
    expect(value?.foveaError).toBeUndefined()
    expect(textOf(result.content)).toContain('Found 1 match')
    expect(native.calls).toHaveLength(1)
    await scope.dispose()
    await ctx.fiber.dispose()
  }, 30_000)

  it('annotates the native fallback when the graph is unavailable', async () => {
    const previous = process.env.FOVEA_AST_GREP
    process.env.FOVEA_AST_GREP = '/nonexistent/ast-grep'
    try {
      const { ctx, native } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'replace' } })
      const { agent, scope } = subject(ctx, 'agent-graph-broken')
      agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })

      const result = await call(ctx, 'grep', { pattern: 'loadUser' }, agent)
      expect(result.isError).toBe(false)
      const value = result.value as { matches?: Match[]; foveaError?: string } | undefined
      expect(value?.matches).toHaveLength(1)
      expect(value?.foveaError).toBeTypeOf('string')
      expect(textOf(result.content)).toContain('fovea graph unavailable — native text results')
      expect(native.calls).toHaveLength(1)
      await scope.dispose()
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.FOVEA_AST_GREP
      else process.env.FOVEA_AST_GREP = previous
    }
  }, 30_000)

  it('re-saves a capped native result through the call-owned spill', async () => {
    const matches: Match[] = [
      { path: 'src/users.ts', lineNumber: 2, line: 'export function loadUser(id: string): User { return { id } }' },
      { path: 'src/users.ts', lineNumber: 3, line: 'export function handleUser(id: string): User { return loadUser(id) }' },
    ]
    const { ctx, native } = await mountAll(
      { sync: { mode: 'disabled' }, grep: { mode: 'replace' } },
      { native: { matches, cap: 1 }, spill: true },
    )
    const { agent, scope } = subject(ctx, 'agent-capped-spill')
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })

    const result = await call(ctx, 'grep', { pattern: 'loadU[a-z]+' }, agent)
    expect(result.isError).toBe(false)
    const plain = textOf(result.content)
    expect(plain).toContain('Found 1 of 2 matches')
    expect(plain).toContain('Full grep result stored at:')
    expect(plain).not.toContain('The complete result could not be saved')
    const locator = /Full grep result stored at: (\S+)\./.exec(plain)
    expect(locator).not.toBeNull()
    const saved = await readFile(locator![1]!, 'utf8')
    expect(saved).toContain('Found 2 matches')
    expect(saved).toContain('handleUser')
    expect(native.calls).toHaveLength(1)
    await scope.dispose()
    await ctx.fiber.dispose()
  }, 30_000)

  it('unwinds the shadow when the agent scope disposes', async () => {
    const { ctx } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'replace' } })
    const { agent, scope } = subject(ctx, 'agent-shadow-unwind')
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })
    const globalView = ctx.tools.get('grep')
    expect(ctx.tools.get('grep', agent)).not.toBe(globalView)
    await scope.dispose()
    expect(ctx.tools.get('grep', agent)).toBe(globalView)
    await ctx.fiber.dispose()
  })
})

describe('grep augment mode', () => {
  it('appends the graph section to successful symbol-query results', async () => {
    const { ctx, native } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'augment' } })
    const { agent, scope } = subject(ctx, 'agent-augment-append')

    const result = await call(ctx, 'grep', { pattern: 'loadUser' }, agent)
    expect(result.isError).toBe(false)
    const plain = textOf(result.content)
    expect(plain).toContain('Found 1 match')
    expect(plain).toContain('fovea graph')
    expect(plain).toContain('loadUser')
    expect(native.calls).toHaveLength(1)
    await scope.dispose()
    await ctx.fiber.dispose()
  }, 30_000)

  it('leaves regex-shaped queries native-only', async () => {
    const { ctx, native } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'augment' } })
    const { agent, scope } = subject(ctx, 'agent-augment-regex')

    const result = await call(ctx, 'grep', { pattern: 'loadU[a-z]+' }, agent)
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toContain('Found 1 match')
    expect(textOf(result.content)).not.toContain('fovea graph')
    expect(native.calls).toHaveLength(1)
    await scope.dispose()
    await ctx.fiber.dispose()
  }, 30_000)

  it('leaves the native result alone when the graph finds nothing', async () => {
    const { ctx } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'augment' } })
    const { agent, scope } = subject(ctx, 'agent-augment-miss')
    const result = await call(ctx, 'grep', { pattern: 'definitelyMissingSymbol' }, agent)
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toContain('Found 1 match')
    expect(textOf(result.content)).not.toContain('fovea graph')
    await scope.dispose()
    await ctx.fiber.dispose()
  }, 30_000)
})

describe('grep off mode', () => {
  it('leaves the native definition visible and untouched', async () => {
    const { ctx, native } = await mountAll({ sync: { mode: 'disabled' }, grep: { mode: 'off' } })
    const { agent, scope } = subject(ctx, 'agent-grep-off')
    agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })
    expect(ctx.tools.get('grep', agent)).toBe(ctx.tools.get('grep'))

    const result = await call(ctx, 'grep', { pattern: 'loadUser' }, agent)
    expect(result.isError).toBe(false)
    expect(textOf(result.content)).toContain('Found 1 match')
    expect(textOf(result.content)).not.toContain('fovea graph')
    expect(native.calls).toHaveLength(1)
    await scope.dispose()
    await ctx.fiber.dispose()
  }, 30_000)
})
