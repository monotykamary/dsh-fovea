import type { Context } from '@monotykamary/cordis'
import type { Agent } from '@monotykamary/dsh-agent'
import type { CallId } from '@monotykamary/dsh-llm'
import { defineTool } from '@monotykamary/dsh-tools'
import type { JsonValue } from '@monotykamary/dsh-tools'
import { DshFoveaRuntime } from './dsh-runtime.js'
import { dwell, focus, impact, sketch, type OpResult } from './core/ops.js'
import type { NodeKind } from './core/types.js'
import { withFoveaRuntime } from './runtime.js'
import type { ResolvedConfig } from './core/config.js'

const TEXT_RESULT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      text: { type: 'string' as const, required: true },
      tokens: { type: 'integer' as const, required: true },
      details: { type: 'object' as const, required: true, additionalProperties: true },
    },
  },
  render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }],
} as const

type ToolValue = { text: string; tokens: number; details: Record<string, JsonValue> }

/** Remove optional-undefined fields before crossing DSH's lossless JSON boundary. */
function canonical(result: OpResult): ToolValue {
  return JSON.parse(JSON.stringify(result)) as ToolValue
}

async function invoke(
  ctx: Context,
  agent: Agent | undefined,
  signal: AbortSignal,
  callId: CallId,
  toolName: string,
  operation: (root: string) => Promise<OpResult>,
): Promise<ToolValue> {
  if (agent === undefined) throw new Error(`${toolName} requires a calling agent`)
  const runtime = await DshFoveaRuntime.create(ctx, agent, signal, { toolName, callId })
  return withFoveaRuntime(runtime, async () => canonical(await operation(runtime.processRoot)))
}

const nodeKinds = ['function', 'method', 'class', 'interface', 'type', 'field', 'decl', 'file', 'anchor'] as const

export function registerFoveaTools(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'fovea_sketch',
    description: 'Survey the repository as a compact structural silhouette: feature basins, routes, hubs, and extraction coverage. Use before choosing where to investigate.',
    parameters: {
      max_tokens: { type: 'integer', description: 'Output token budget. Defaults to the plugin default.' },
    },
    output: TEXT_RESULT,
    timeoutMs: config.toolTimeoutMs,
    execute: (args, exec) => invoke(ctx, exec.agent, exec.signal, exec.callId, 'fovea_sketch', root =>
      sketch(root, args.max_tokens ?? config.defaultBudget)),
  }))

  ctx.tools.register(defineTool({
    name: 'fovea_focus',
    description: 'Center semantic repository context on a symbol, route, concept, or file and reveal its strongest direct and nearby relationships.',
    parameters: {
      query: { type: 'string', required: true, description: 'Symbol, route, concept, or repository-relative file path to focus on.' },
      max_tokens: { type: 'integer', description: 'Output token budget. Defaults to the plugin default.' },
      fresh: { type: 'boolean', description: 'Reset disclosure for this focus even if it matches the current nucleus.' },
      path: { type: 'string', description: 'Restrict results to repository paths containing this value.' },
      language: { type: 'string', description: 'Restrict results to one language name.' },
      kind: { type: 'string', enum: nodeKinds, description: 'Restrict results to one graph node kind.' },
    },
    output: TEXT_RESULT,
    timeoutMs: config.toolTimeoutMs,
    execute: (args, exec) => invoke(ctx, exec.agent, exec.signal, exec.callId, 'fovea_focus', root =>
      focus(root, args.query, args.max_tokens ?? config.defaultBudget, {
        ...(args.fresh === undefined ? {} : { fresh: args.fresh }),
        ...(args.path === undefined ? {} : { path: args.path }),
        ...(args.language === undefined ? {} : { language: args.language }),
        ...(args.kind === undefined ? {} : { kind: args.kind as NodeKind }),
      })),
  }))

  ctx.tools.register(defineTool({
    name: 'fovea_dwell',
    description: 'Widen the current Fovea focus and return newly disclosed context. Call after fovea_focus when the first semantic neighborhood is too narrow.',
    parameters: {
      factor: { type: 'number', description: 'Diffusion-time multiplier; defaults to 2 and is clamped by the engine.' },
      max_tokens: { type: 'integer', description: 'Output token budget. Defaults to the plugin default.' },
    },
    output: TEXT_RESULT,
    timeoutMs: config.toolTimeoutMs,
    execute: (args, exec) => invoke(ctx, exec.agent, exec.signal, exec.callId, 'fovea_dwell', root =>
      dwell(root, args.factor, args.max_tokens ?? config.defaultBudget)),
  }))

  ctx.tools.register(defineTool({
    name: 'fovea_impact',
    description: 'Estimate the semantic blast radius and review order for changed files, symbols, uncommitted work, or a base-ref diff.',
    parameters: {
      files: { type: 'array', items: { type: 'string' }, description: 'Repository-relative changed or hypothetical file paths.' },
      symbols: { type: 'array', items: { type: 'string' }, description: 'Changed or hypothetical symbols to seed.' },
      include_uncommitted: { type: 'boolean', description: 'Include current uncommitted files. Defaults to true unless base is supplied.' },
      base: { type: 'string', description: 'Base ref for PR-style base...HEAD impact.' },
      max_tokens: { type: 'integer', description: 'Output token budget. Defaults to the plugin default.' },
    },
    output: TEXT_RESULT,
    timeoutMs: config.toolTimeoutMs,
    execute: (args, exec) => invoke(ctx, exec.agent, exec.signal, exec.callId, 'fovea_impact', root =>
      impact(root, {
        ...(args.files === undefined ? {} : { files: args.files }),
        ...(args.symbols === undefined ? {} : { symbols: args.symbols }),
        ...(args.include_uncommitted === undefined ? {} : { includeUncommitted: args.include_uncommitted }),
        ...(args.base === undefined ? {} : { base: args.base }),
        budget: args.max_tokens ?? config.defaultBudget,
      })),
  }))
}
