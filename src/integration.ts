import type { Context } from '@monotykamary/cordis'
import type { Agent, PreStepDecision } from '@monotykamary/dsh-agent'
import { createUserMessage } from '@monotykamary/dsh-llm'
import type { ToolExecutionResult } from '@monotykamary/dsh-tools'
import { clearDshFoveaAgentScope, DshFoveaRuntime, setDshFoveaAgentScope } from './dsh-runtime.js'
import { ensureState } from './core/state.js'
import { captureMutation, finishMutation, recordMutationTransition, type MutationCapture } from './core/provenance.js'
import { sync, warmSync, type SyncOutcome } from './core/sync.js'
import { getSession, observeSessionPaths } from './core/session.js'
import type { ResolvedConfig } from './core/config.js'
import { withFoveaRuntime } from './runtime.js'

interface BackgroundWork {
  readonly controller: AbortController
  readonly warmFiles: Set<string>
  warmTimer: ReturnType<typeof setTimeout> | undefined
  tail: Promise<void>
}

const WARM_DEBOUNCE_MS = 250

const argumentPath = (args: unknown, key: 'file_path' | 'path' | 'workdir'): string | undefined => {
  if (typeof args !== 'object' || args === null || !(key in args)) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

const mutationPath = (name: string, args: unknown): string | undefined =>
  name === 'write' || name === 'edit' ? argumentPath(args, 'file_path') : undefined

const attentionPath = (args: unknown): string | undefined =>
  argumentPath(args, 'file_path') ?? argumentPath(args, 'path') ?? argumentPath(args, 'workdir')

const ACK_TEXT = 'fovea: checked repository changes; no new action is needed.'

const messageFor = (text: string, mode: ResolvedConfig['sync']['mode']) => createUserMessage({
  content: [{ type: 'text', text }],
  source: mode === 'hidden'
    ? { kind: 'plugin', plugin: 'dsh-fovea', form: 'instructions' }
    : { kind: 'plugin', plugin: 'dsh-fovea', form: 'notice', summary: 'Fovea detected repository drift' },
})

/** Register execution-world mutation attribution and model-step repository sync. */
export function registerFoveaIntegration(ctx: Context, config: ResolvedConfig): void {
  if (config.sync.mode === 'disabled') return

  const background = new Map<Agent, BackgroundWork>()
  const legacyCaptures = new WeakMap<object, MutationCapture>()
  const nextPrompt = new Map<Agent, string[]>()
  const lineageBySession = new Map<string, string>()
  const lineageMembers = new Map<string, Set<string>>()
  const attentionByLineage = new Map<string, Set<string>>()
  const scopedAgents = new Set<Agent>()
  const syncTails = new Map<string, Promise<void>>()
  const lineageFor = (agent: Agent): string => {
    const id = String(agent.session.id)
    const header = agent.session.header
    const parent = header.origin === 'subagent' && header.parentSession !== undefined
      ? String(header.parentSession)
      : undefined
    const lineage = parent === undefined ? id : (lineageBySession.get(parent) ?? parent)
    lineageBySession.set(id, lineage)
    setDshFoveaAgentScope(agent, lineage)
    scopedAgents.add(agent)
    return lineage
  }
  const rememberAttention = (agent: Agent, scopes: Iterable<string>): void => {
    const lineage = lineageFor(agent)
    const remembered = attentionByLineage.get(lineage) ?? new Set<string>()
    for (const scope of scopes) remembered.add(scope)
    attentionByLineage.set(lineage, remembered)
  }
  const attentionFor = (agent: Agent): string[] => [...(attentionByLineage.get(lineageFor(agent)) ?? [])].sort()
  // pi-fovea parity: a clean structural sync may emit a tiny "nothing new" ack
  // when sync.ackClean is set. Baseline establishment, deferred verdicts, and
  // silent sibling-only indexing never ack — they are not task-relevant checks.
  const ackDue = (outcome: SyncOutcome): boolean =>
    config.sync.ackClean && outcome.structural &&
    outcome.details.baseline === undefined && outcome.details.deferred === undefined &&
    outcome.details.outsideAttention === undefined
  const workFor = (agent: Agent): BackgroundWork => {
    let work = background.get(agent)
    if (work === undefined) {
      work = {
        controller: new AbortController(),
        warmFiles: new Set<string>(),
        warmTimer: undefined,
        tail: Promise.resolve(),
      }
      background.set(agent, work)
    }
    return work
  }
  const enqueue = (agent: Agent, task: (signal: AbortSignal) => Promise<void>): void => {
    const work = workFor(agent)
    const signal = work.controller.signal
    const next = work.tail.catch(() => undefined).then(() => task(signal))
    work.tail = next
    void next.catch((error: unknown) => {
      if (!signal.aborted) ctx.logger.warn('dsh-fovea: background graph refresh failed: %o', error)
    })
  }
  const flushWarm = (agent: Agent, work: BackgroundWork): void => {
    if (work.warmTimer !== undefined) {
      clearTimeout(work.warmTimer)
      work.warmTimer = undefined
    }
    if (work.warmFiles.size === 0) return
    const files = [...work.warmFiles]
    work.warmFiles.clear()
    enqueue(agent, signal => runForAgent(agent, signal, root => warmSync(root, {
      files,
      budget: config.sync.budget,
    })))
  }
  const scheduleWarm = (agent: Agent, path: string): void => {
    const work = workFor(agent)
    work.warmFiles.add(path)
    if (work.warmTimer !== undefined) clearTimeout(work.warmTimer)
    work.warmTimer = setTimeout(() => { flushWarm(agent, work) }, WARM_DEBOUNCE_MS)
  }

  const runForAgent = async <T>(
    agent: Agent,
    signal: AbortSignal,
    operation: (root: string) => Promise<T>,
  ): Promise<T> => {
    lineageFor(agent)
    const runtime = await DshFoveaRuntime.create(ctx, agent, signal)
    return withFoveaRuntime(runtime, () => operation(runtime.processRoot))
  }
  const runSyncForAgent = async <T>(
    agent: Agent,
    signal: AbortSignal,
    operation: (root: string) => Promise<T>,
  ): Promise<T> => {
    const lineage = lineageFor(agent)
    const previous = syncTails.get(lineage) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(() => {
      signal.throwIfAborted()
      return runForAgent(agent, signal, operation)
    })
    const tail = result.then(() => undefined, () => undefined)
    syncTails.set(lineage, tail)
    try {
      return await result
    } finally {
      if (syncTails.get(lineage) === tail) syncTails.delete(lineage)
    }
  }

  // Start indexing as soon as an Agent enters its lifecycle. This is deliberately
  // non-blocking; first-turn pre-step degrades to "indexing" while the graph warms.
  ctx.on('agent/session-start', ({ agent }) => {
    const lineage = lineageFor(agent)
    const members = lineageMembers.get(lineage) ?? new Set<string>()
    const firstMember = members.size === 0
    members.add(String(agent.session.id))
    lineageMembers.set(lineage, members)
    enqueue(agent, signal => runSyncForAgent(agent, signal, async (root) => {
      // pi-fovea parity: attention starts empty and accumulates only from the
      // path-bearing tools this conversation actually uses. The session-start
      // sync just establishes the quiet content-hash baseline.
      const state = await ensureState(root)
      if (!firstMember) return
      await sync(root, {
        budget: config.sync.budget,
        steerThreshold: config.sync.steerThreshold,
        pushFocus: config.sync.pushFocus,
        scope: config.sync.scope,
        attentionScopes: attentionFor(agent),
        sessionId: lineageFor(agent),
      }, state)
    }))
  })

  // Built-in write/edit calls retain a before-image fallback for older Harness
  // runtimes. Final tools/result observers choose receipts over that fallback.
  ctx.on('tools/execute', async (exec, next): Promise<ToolExecutionResult> => {
    const agent = exec.agent
    const path = mutationPath(exec.name, exec.arguments)
    const observed = attentionPath(exec.arguments)
    const discloses = exec.name.startsWith('fovea_')
    if (agent === undefined || (!discloses && path === undefined && observed === undefined)) return next()
    lineageFor(agent)
    let runtime: DshFoveaRuntime
    try {
      runtime = await DshFoveaRuntime.create(ctx, agent, exec.signal)
    } catch {
      return next()
    }
    return withFoveaRuntime(runtime, async () => {
      if (observed !== undefined) {
        rememberAttention(agent, await observeSessionPaths(runtime.processRoot, [observed]))
      }
      let capture: MutationCapture | undefined
      if (path !== undefined) {
        try { capture = await captureMutation(runtime.processRoot, path) } catch { /* attribution is best-effort */ }
      }
      const result = await next()
      if (!result.isError && capture !== undefined) legacyCaptures.set(exec, capture)
      if (!result.isError) rememberAttention(agent, getSession(runtime.processRoot).syncScopes)
      return result
    })
  })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec.agent
    if (agent === undefined) return
    const capture = legacyCaptures.get(exec)
    legacyCaptures.delete(exec)
    const mutations = result.mutations ?? []
    if (mutations.length === 0 && (result.isError || capture === undefined)) return
    enqueue(agent, signal => runForAgent(agent, signal, async (root) => {
      if (mutations.length > 0) {
        for (const mutation of mutations) {
          await recordMutationTransition(
            root, mutation.path, mutation.beforeSha1 ?? undefined, mutation.afterSha1 ?? undefined,
            lineageFor(agent), String(exec.callId),
          )
        }
        rememberAttention(agent, await observeSessionPaths(root, mutations.map(mutation => mutation.path)))
      } else if (capture !== undefined) {
        await finishMutation(capture, lineageFor(agent), String(exec.callId))
      }
    }))
  })

  // Successful mutations debounce and coalesce one background preparation while
  // the model reads tool results. The turn-stop check is queued after that warm
  // work, but never waits for it on the Agent lifecycle path.
  if (config.sync.warmMutations) {
    ctx.on('tools/result', (exec, result) => {
      const agent = exec.agent
      if (agent === undefined) return
      const receiptPaths = result.mutations?.map(mutation => mutation.path) ?? []
      const fallbackPath = !result.isError ? mutationPath(exec.name, exec.arguments) : undefined
      for (const path of receiptPaths.length > 0 ? receiptPaths : fallbackPath === undefined ? [] : [fallbackPath]) {
        scheduleWarm(agent, path)
      }
    })
  }

  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const additions: ReturnType<typeof messageFor>[] = []
    try {
      const outcome = await runSyncForAgent(agent, signal, root => sync(root, {
        budget: config.sync.budget,
        steerThreshold: config.sync.steerThreshold,
        pushFocus: config.sync.pushFocus,
        scope: config.sync.scope,
        attentionScopes: attentionFor(agent),
        sessionId: lineageFor(agent),
      }, undefined, { probe: 'defer' }))
      if (outcome.red && outcome.text !== undefined) additions.push(messageFor(outcome.text, config.sync.mode))
      else if (ackDue(outcome)) additions.push(messageFor(ACK_TEXT, config.sync.mode))
    } catch (error: unknown) {
      if (!signal.aborted) ctx.logger.warn('dsh-fovea: pre-step sync failed: %o', error)
    }
    // Detached turn-stop work may have completed while this pre-step waited on
    // the lineage serializer. Drain after that wait so deferred notices reach
    // this request rather than slipping to a later prompt.
    const queued = nextPrompt.get(agent) ?? []
    nextPrompt.delete(agent)
    additions.unshift(...queued.map(text => messageFor(text, config.sync.mode)))
    return additions.length > 0
      ? { ...decision, messages: [...decision.messages, ...additions] }
      : decision
  })

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (signal.aborted) return
    const work = workFor(agent)
    flushWarm(agent, work)
    enqueue(agent, async (backgroundSignal) => {
      const operationSignal = AbortSignal.any([signal, backgroundSignal])
      if (operationSignal.aborted) return
      try {
        const outcome = await runSyncForAgent(agent, operationSignal, root => sync(root, {
          budget: config.sync.budget,
          steerThreshold: config.sync.steerThreshold,
          pushFocus: config.sync.pushFocus,
          scope: config.sync.scope,
          attentionScopes: attentionFor(agent),
          sessionId: lineageFor(agent),
        }, undefined, { probe: 'full' }))
        if (operationSignal.aborted || background.get(agent) !== work) return
        if (outcome.red && outcome.text !== undefined) {
          if (outcome.delivery === 'next-prompt') {
            const queued = nextPrompt.get(agent) ?? []
            queued.push(outcome.text)
            nextPrompt.set(agent, queued)
          } else {
            agent.steer(messageFor(outcome.text, config.sync.mode))
          }
        } else if (ackDue(outcome)) {
          // The ack rides the next prompt like a deferred update: it must never
          // restart an idle agent, matching pi's UI-only notify semantics.
          const queued = nextPrompt.get(agent) ?? []
          queued.push(ACK_TEXT)
          nextPrompt.set(agent, queued)
        }
      } catch (error: unknown) {
        if (!operationSignal.aborted) ctx.logger.warn('dsh-fovea: turn-stop sync failed: %o', error)
      }
    })
  })

  ctx.on('agent/disposed', async ({ agent }) => {
    const work = background.get(agent)
    nextPrompt.delete(agent)
    const id = String(agent.session.id)
    const lineage = lineageFor(agent)
    clearDshFoveaAgentScope(agent)
    scopedAgents.delete(agent)
    lineageBySession.delete(id)
    const members = lineageMembers.get(lineage)
    members?.delete(id)
    if (members?.size === 0) {
      lineageMembers.delete(lineage)
      attentionByLineage.delete(lineage)
    }
    if (work === undefined) return
    if (work.warmTimer !== undefined) clearTimeout(work.warmTimer)
    work.warmFiles.clear()
    work.controller.abort(new Error('Fovea agent scope disposed'))
    background.delete(agent)
    await work.tail.catch(() => undefined)
  })

  ctx.effect(function* () {
    yield async () => {
      const active = [...background.values()]
      for (const work of active) {
        if (work.warmTimer !== undefined) clearTimeout(work.warmTimer)
        work.warmFiles.clear()
        work.controller.abort(new Error('dsh-fovea disposed'))
      }
      background.clear()
      nextPrompt.clear()
      for (const agent of scopedAgents) clearDshFoveaAgentScope(agent)
      scopedAgents.clear()
      syncTails.clear()
      lineageBySession.clear()
      lineageMembers.clear()
      attentionByLineage.clear()
      await Promise.allSettled(active.map(work => work.tail))
    }
  }, 'dsh-fovea: stop and drain background refreshes')
}
