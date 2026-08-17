import type { Context } from '@monotykamary/cordis'
import type {} from '@monotykamary/dsh-agent'
import type {} from '@monotykamary/dsh-fs'
import type {} from '@monotykamary/dsh-spill'
import type {} from '@monotykamary/dsh-subprocess'
import type {} from '@monotykamary/dsh-system-prompt'
import type {} from '@monotykamary/dsh-commands'
import type {} from '@monotykamary/dsh-skill'
import { resolveConfig, type Config } from './core/config.js'
import { registerFoveaCommand } from './command.js'
import { registerFoveaIntegration } from './integration.js'
import { registerFoveaSkill } from './skill.js'
import { registerFoveaTools } from './tools.js'

export const name = 'dsh-fovea'
export const inject = ['tools', 'fs', 'subprocess', 'systemPrompt']

const PROMPT = [
  'Use Fovea for structural repository navigation and change impact: fovea_sketch surveys an unfamiliar codebase,',
  'fovea_focus reveals the semantic neighborhood of a symbol/route/file, fovea_dwell widens the current focus,',
  'and fovea_impact estimates blast radius and review order. Use exact read/grep tools after Fovea identifies where and why.',
].join(' ')

/** Mount Fovea into a DeepSeek Harness Cordis context. */
export function apply(ctx: Context, input: Config = {}): void {
  const config = resolveConfig(input)
  ctx.systemPrompt.section({ name: 'tool:fovea', order: 114, text: PROMPT })
  registerFoveaTools(ctx, config)
  registerFoveaIntegration(ctx, config)
  registerFoveaCommand(ctx, config)
  registerFoveaSkill(ctx)
}

export type { Config, ResolvedConfig, SyncMode } from './core/config.js'
export { DEFAULT_CONFIG, resolveConfig } from './core/config.js'
export { DshFoveaRuntime } from './dsh-runtime.js'
export { NodeFoveaRuntime } from './node-runtime.js'
export type { FoveaRuntime } from './runtime.js'
export { withFoveaRuntime } from './runtime.js'
