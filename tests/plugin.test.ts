import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as Fovea from '../src/index.js'
import { attributeChanges, provenancePathFor } from '../src/core/provenance.js'
import { getSession } from '../src/core/session.js'
import { DshFoveaRuntime } from '../src/dsh-runtime.js'
import { withFoveaRuntime } from '../src/runtime.js'

let root = ''
let seq = 0

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-fovea-plugin-')))
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

async function mount(
  config: Fovea.Config = { sync: { mode: 'disabled' } },
  optionalServices = false,
  spill = false,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  if (spill) await ctx.plugin(LocalSpillStore, { root: join(root, '.spills') })
  if (optionalServices) {
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(SkillRegistry)
  }
  await ctx.plugin(Fovea, config)
  return ctx
}

const agent = () => ({
  id: 'agent-fovea-test',
  session: {
    id: 'session-fovea-test',
    header: { cwd: root },
    append: (type: string, data: unknown) => ({ type, data, seq: ++seq, at: Date.now() }),
  },
}) as never

function call(ctx: Context, name: string, args: unknown, subject = agent()) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `fovea-test-${++seq}` as never,
    name,
    arguments: args,
    agent: subject,
  })
}

describe('DSH plugin registration', () => {
  it('registers four canonical tools and prompt guidance', async () => {
    const ctx = await mount()
    for (const name of ['fovea_sketch', 'fovea_focus', 'fovea_dwell', 'fovea_impact']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.map(section => section.text).join('\n')).toContain('fovea_focus')
    await ctx.fiber.dispose()
  })

  it('registers optional command and runtime skill surfaces', async () => {
    const ctx = await mount({ sync: { mode: 'disabled' } }, true)
    expect(ctx.commands.find(agent(), 'fovea')).toMatchObject({ name: 'fovea' })
    const skill = await ctx.skills.get('fovea')
    expect(skill).toMatchObject({ name: 'fovea', source: 'runtime', provider: 'runtime' })
    expect(skill?.content).toContain('fovea_impact')
    const signal = new AbortController().signal
    const focused = await ctx.commands.execute(agent(), '/fovea focus loadUser', signal)
    expect(focused?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('loadUser') })
    const invalid = await ctx.commands.execute(agent(), '/fovea dwell nope', signal)
    expect(invalid?.result).toEqual({ kind: 'error', text: 'dwell factor must be a positive number' })
    await ctx.fiber.dispose()
  })

  it('runs sketch and focus through real DSH fs/subprocess services', async () => {
    const ctx = await mount()
    const sketch = await call(ctx, 'fovea_sketch', { max_tokens: 500 })
    expect(sketch.isError).toBe(false)
    expect(sketch.content[0]).toMatchObject({ type: 'text' })
    expect((sketch.content[0] as { text: string }).text).toContain('fovea sketch')

    const focus = await call(ctx, 'fovea_focus', { query: 'loadUser', max_tokens: 700 })
    expect(focus.isError).toBe(false)
    expect((focus.content[0] as { text: string }).text).toContain('loadUser')
    expect(focus.value).toMatchObject({ tokens: expect.any(Number), details: expect.any(Object) })
    await ctx.fiber.dispose()
  }, 30_000)

  it('warms on session start and steers red external drift at turn stop', async () => {
    const steered: unknown[] = []
    const subject = {
      id: 'agent-fovea-lifecycle',
      session: { id: 'session-fovea-lifecycle', header: { cwd: root } },
      steer(message: unknown) { steered.push(message) },
    } as never
    const ctx = await mount({
      sync: { mode: 'enabled', warmMutations: false, steerThreshold: 0.02, pushFocus: false },
    })
    const events = agentEvents(ctx, subject)
    events.emit('agent/session-start', { source: 'startup' })
    const signal = new AbortController().signal
    await events.serial('agent/turn-stopping', { turn: 1, signal })
    expect(steered).toHaveLength(0)

    const file = join(root, 'src', 'users.ts')
    await writeFile(file, [
      'export function changedRoute() { return "/changed" }',
      'app.get("/changed", changedRoute)',
      '',
    ].join('\n'))
    await events.serial('agent/turn-stopping', { turn: 2, signal })
    expect(steered).toHaveLength(1)
    expect(steered[0]).toMatchObject({ source: { kind: 'plugin', plugin: 'dsh-fovea', form: 'notice' } })
    events.emit('agent/disposed', {})
    await ctx.fiber.dispose()
  }, 30_000)

  it('keeps unrelated umbrella siblings quiet until the agent enters them', async () => {
    await rm(join(root, 'package.json'))
    await mkdir(join(root, 'repo-a'))
    await mkdir(join(root, 'repo-b'))
    await writeFile(join(root, 'repo-a', 'active.ts'), 'export function activeArea() { return true }\n')
    await writeFile(join(root, 'repo-b', 'other.ts'), 'export function otherArea() { return true }\n')

    const steered: unknown[] = []
    const childSteered: unknown[] = []
    const subject = {
      id: 'agent-umbrella',
      session: { id: 'session-umbrella', header: { cwd: root } },
      steer(message: unknown) { steered.push(message) },
    } as never
    const child = {
      id: 'agent-umbrella-child',
      session: {
        id: 'session-umbrella-child',
        header: { cwd: root, origin: 'subagent', parentSession: 'session-umbrella', delegationDepth: 1 },
      },
      steer(message: unknown) { childSteered.push(message) },
    } as never
    const ctx = await mount({
      sync: { mode: 'enabled', warmMutations: false, steerThreshold: 0.02, pushFocus: false },
    })
    const events = agentEvents(ctx, subject)
    const signal = new AbortController().signal
    events.emit('agent/session-start', { source: 'startup' })
    await events.serial('agent/turn-stopping', { turn: 1, signal })

    const focused = await call(ctx, 'fovea_focus', { query: 'activeArea', max_tokens: 600 }, subject)
    expect(focused.isError).toBe(false)
    expect((focused.content[0] as { text: string }).text).toContain('activeArea')
    expect(focused.value).toMatchObject({ details: { nodes: expect.any(Array) } })
    const focusedNodes = (focused.value as { details: { nodes: unknown[] } }).details.nodes
    expect(focusedNodes.length).toBeGreaterThan(0)
    const runtime = await DshFoveaRuntime.create(ctx, subject, signal)
    const scopes = await withFoveaRuntime(runtime, () => Promise.resolve([...getSession(root).syncScopes]))
    expect(scopes).toContain('repo-a')
    await writeFile(join(root, 'repo-b', 'other.ts'), [
      'export function siblingRoute() { return "/sibling" }',
      'app.get("/sibling", siblingRoute)',
      '',
    ].join('\n'))
    await events.serial('agent/turn-stopping', { turn: 2, signal })
    expect(steered).toHaveLength(0)

    await writeFile(join(root, 'repo-a', 'active.ts'), [
      'export function activeRoute() { return "/active" }',
      'app.get("/active", activeRoute)',
      '',
    ].join('\n'))
    await events.serial('agent/turn-stopping', { turn: 3, signal })
    expect(steered).toHaveLength(1)

    const childEvents = agentEvents(ctx, child)
    childEvents.emit('agent/session-start', { source: 'startup' })
    const childFocus = await call(ctx, 'fovea_focus', { query: 'siblingRoute', max_tokens: 600 }, child)
    expect(childFocus.isError).toBe(false)
    await writeFile(join(root, 'repo-b', 'other.ts'), [
      'export function siblingV2Route() { return "/sibling-v2" }',
      'app.get("/sibling-v2", siblingV2Route)',
      '',
    ].join('\n'))
    await events.serial('agent/turn-stopping', { turn: 4, signal })
    expect(steered).toHaveLength(2)

    await writeFile(join(root, 'repo-b', 'other.ts'), [
      'export function siblingV3Route() { return "/sibling-v3" }',
      'app.get("/sibling-v3", siblingV3Route)',
      '',
    ].join('\n'))
    await Promise.all([
      events.serial('agent/turn-stopping', { turn: 5, signal }),
      childEvents.serial('agent/turn-stopping', { turn: 1, signal }),
    ])
    expect(steered.length + childSteered.length).toBe(3)

    events.emit('agent/disposed', {})
    childEvents.emit('agent/disposed', {})
    await ctx.fiber.dispose()
  }, 30_000)

  it('defers another top-level agent but treats subagent writes as current-lineage work', async () => {
    const steered: unknown[] = []
    const subject = {
      id: 'agent-current',
      session: { id: 'session-current', header: { cwd: root } },
      steer(message: unknown) { steered.push(message) },
    } as never
    const other = {
      id: 'agent-other',
      session: { id: 'session-other', header: { cwd: root } },
      steer() {},
    } as never
    const child = {
      id: 'agent-child',
      session: {
        id: 'session-child',
        header: { cwd: root, origin: 'subagent', parentSession: 'session-current', delegationDepth: 1 },
      },
      steer() {},
    } as never
    const ctx = await mount({
      sync: { mode: 'enabled', warmMutations: false, steerThreshold: 0.02, pushFocus: false },
    })
    ctx.tools.register(defineTool({
      name: 'write',
      description: 'Synthetic mutation for routing verification',
      parameters: {
        file_path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => { await writeFile(args.file_path, args.content); return 'written' },
    }))
    const events = agentEvents(ctx, subject)
    const signal = new AbortController().signal
    events.emit('agent/session-start', { source: 'startup' })
    agentEvents(ctx, other).emit('agent/session-start', { source: 'startup' })
    await events.serial('agent/turn-stopping', { turn: 1, signal })

    const file = join(root, 'src', 'users.ts')
    await call(ctx, 'write', {
      file_path: file,
      content: 'export function upstreamRoute() { return "/upstream" }\napp.get("/upstream", upstreamRoute)\n',
    }, other)
    await events.serial('agent/turn-stopping', { turn: 2, signal })
    expect(steered).toHaveLength(0)

    const prompt = createUserMessage({
      content: [{ type: 'text', text: 'continue' }],
      source: { kind: 'plugin', plugin: 'dsh-fovea-test' },
    })
    const decision = await events.waterfall(
      'agent/pre-step',
      { messages: [prompt], turn: 3, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [prompt] }),
    )
    expect(decision.kind).toBe('enter')
    expect(JSON.stringify(decision)).toContain('another agent session')
    expect(steered).toHaveLength(0)

    agentEvents(ctx, child).emit('agent/session-start', { source: 'startup' })
    await call(ctx, 'write', {
      file_path: file,
      content: 'export function childRoute() { return "/child" }\napp.get("/child", childRoute)\n',
    }, child)
    await events.serial('agent/turn-stopping', { turn: 3, signal })
    expect(steered).toHaveLength(1)
    expect(JSON.stringify(steered[0])).toContain('Origin: current session')
    const [parentRuntime, childRuntime] = await Promise.all([
      DshFoveaRuntime.create(ctx, subject, signal),
      DshFoveaRuntime.create(ctx, child, signal),
    ])
    expect(childRuntime.scopeKey).toBe(parentRuntime.scopeKey)

    events.emit('agent/disposed', {})
    agentEvents(ctx, other).emit('agent/disposed', {})
    agentEvents(ctx, child).emit('agent/disposed', {})
    await ctx.fiber.dispose()
  }, 30_000)

  it('attributes successful write tools without replacing them', async () => {
    const ctx = await mount({ sync: { mode: 'enabled', warmMutations: false } })
    ctx.tools.register(defineTool({
      name: 'write',
      description: 'Synthetic mutation for adapter verification',
      parameters: {
        file_path: { type: 'string', required: true },
        content: { type: 'string', required: true },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async args => { await writeFile(args.file_path, args.content); return 'written' },
    }))
    const file = join(root, 'src', 'users.ts')
    const before = createHash('sha1').update(await readFile(file)).digest('hex')
    const since = Date.now() - 1_000
    const result = await call(ctx, 'write', { file_path: file, content: 'export const changed = true\n' })
    expect(result.isError).toBe(false)
    const after = createHash('sha1').update(await readFile(file)).digest('hex')
    const runtime = await DshFoveaRuntime.create(ctx, agent(), new AbortController().signal)
    const attribution = await withFoveaRuntime(runtime, () => attributeChanges(root, 'session-fovea-test', since, [{
      file: 'src/users.ts', beforeSha: before, afterSha: after,
    }]))
    expect(attribution).toEqual({ kind: 'current-session', files: { 'src/users.ts': 'current-session' } })
    await withFoveaRuntime(runtime, () => runtime.deleteCache(provenancePathFor(root, 'session-fovea-test'))) 
    await ctx.fiber.dispose()
  })

  it('stores only call-owned overflow through the optional DSH spill service', async () => {
    const ctx = await mount({ sync: { mode: 'disabled' } }, false, true)
    const signal = new AbortController().signal
    const owned = await DshFoveaRuntime.create(ctx, agent(), signal, {
      toolName: 'fovea_focus',
      callId: 'spill-call' as never,
    })
    const ref = await withFoveaRuntime(owned, () => owned.spillText('focus', 'complete semantic context'))
    expect(ref).toMatchObject({ bytes: Buffer.byteLength('complete semantic context') })
    expect(await readFile(ref!.locator, 'utf8')).toBe('complete semantic context')

    const unowned = await DshFoveaRuntime.create(ctx, agent(), signal)
    await expect(withFoveaRuntime(unowned, () => unowned.spillText('focus', 'hidden'))).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('validates config before registering anything', async () => {
    await expect(mount({ defaultBudget: 1 })).rejects.toThrow(/defaultBudget/)
  })
})
