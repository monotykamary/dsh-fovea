import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { DshFoveaRuntime } from './dsh-runtime.js'
import { dwell, focus, impact, sketch } from './core/ops.js'
import { ensureStateBackground, evictState, getInflight, getState } from './core/state.js'
import { resetSession } from './core/session.js'
import { resetSyncBaseline } from './core/sync.js'
import type { ResolvedConfig } from './core/config.js'
import { withFoveaRuntime } from './runtime.js'

async function withAgent<T>(ctx: Context, agent: Agent, signal: AbortSignal, operation: (root: string) => Promise<T>): Promise<T> {
  const runtime = await DshFoveaRuntime.create(ctx, agent, signal)
  return withFoveaRuntime(runtime, () => operation(runtime.processRoot))
}

function warmInBackground(ctx: Context, root: string): void {
  const pending = ensureStateBackground(root).promise
  void pending.catch((error: unknown) => ctx.logger.warn('dsh-fovea: command indexing failed: %o', error))
}

function statusText(ctx: Context, root: string): string {
  const state = getState(root)
  if (state === undefined) {
    if (getInflight(root) === undefined) warmInBackground(ctx, root)
    return 'Fovea is indexing this workspace. Run /fovea status again shortly.'
  }
  const dropped = state.extraction.failed.length
    + state.extraction.unreadable.length
    + state.extraction.oversized.length
    + state.extraction.generated.length
  return [
    `Fovea ready · ${state.graph.files.length} files · ${state.graph.nodes.length} nodes · ${state.graph.edges.length} edges`,
    `Anchors: ${state.graph.anchors.length} · graph version: ${state.version.slice(0, 12)}`,
    dropped === 0
      ? 'Extraction coverage: complete for discovered supported files.'
      : `Extraction coverage: ${dropped} skipped/degraded (failed ${state.extraction.failed.length}, unreadable ${state.extraction.unreadable.length}, oversized ${state.extraction.oversized.length}, generated ${state.extraction.generated.length}).`,
  ].join('\n')
}

export function registerFoveaCommand(ctx: Context, config: ResolvedConfig): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'fovea',
      description: 'Inspect, focus, widen, reset, or check Fovea repository intelligence',
      input: { hint: '[status|reset|sketch|focus <query>|dwell [factor]|impact [files...]]' },
      async handler({ agent, rawInput, signal }) {
        return withAgent(ctx, agent, signal, async (root) => {
          const input = rawInput.trim()
          const [verb = 'status', ...rest] = input.split(/\s+/u)
          if (verb === 'status') return { kind: 'success' as const, text: statusText(ctx, root) }
          if (verb === 'reset') {
            resetSession(root)
            resetSyncBaseline(root)
            evictState(root)
            warmInBackground(ctx, root)
            return { kind: 'success' as const, text: 'Fovea state reset; repository indexing restarted.' }
          }
          if (verb === 'sketch') {
            const result = await sketch(root, config.defaultBudget)
            return { kind: 'success' as const, text: result.text }
          }
          if (verb === 'dwell') {
            const rawFactor = rest[0]
            const factor = rawFactor === undefined ? undefined : Number(rawFactor)
            if (factor !== undefined && (!Number.isFinite(factor) || factor <= 0)) {
              return { kind: 'error' as const, text: 'dwell factor must be a positive number' }
            }
            const result = await dwell(root, factor, config.defaultBudget)
            return { kind: 'success' as const, text: result.text }
          }
          if (verb === 'impact') {
            const result = await impact(root, {
              ...(rest.length === 0 ? {} : { files: rest }),
              includeUncommitted: rest.length === 0,
              budget: config.defaultBudget,
            })
            return { kind: 'success' as const, text: result.text }
          }
          const query = verb === 'focus' ? rest.join(' ') : input
          if (query.trim() === '') {
            return { kind: 'error' as const, text: 'usage: /fovea focus <symbol, route, concept, or file>' }
          }
          const result = await focus(root, query, config.defaultBudget)
          return { kind: 'success' as const, text: result.text }
        })
      },
    })
  })
}
