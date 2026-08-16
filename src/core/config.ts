/** DSH plugin configuration and strict load-time normalization. */

export const SYNC_MODES = ['enabled', 'hidden', 'disabled'] as const
export type SyncMode = (typeof SYNC_MODES)[number]
export const SYNC_SCOPES = ['session', 'repository'] as const
export type SyncScope = (typeof SYNC_SCOPES)[number]

export interface Config {
  /** Default output budget when a fovea tool omits max_tokens. */
  defaultBudget?: number
  /** Cooperative tool timeout advertised to Harness policy, in milliseconds. */
  toolTimeoutMs?: number
  /** Continuous repository intelligence between model steps. */
  sync?: {
    /** enabled: inject and steer; hidden: instruction-form context; disabled: no hooks. */
    mode?: SyncMode
    /** Session attention by default; repository restores root-wide steering. */
    scope?: SyncScope
    /** Maximum tokens used by one proactive drift message. */
    budget?: number
    /** Channel-adjusted novel heat required for a proactive steer. */
    steerThreshold?: number
    /** Embed a compact focus preview in red syncs instead of only suggesting a follow-up. */
    pushFocus?: boolean
    /** Emit a tiny model-visible ack when a clean sync checks and finds nothing new. */
    ackClean?: boolean
    /** Warm graph state after successful mutation tools to shorten turn-stop latency. */
    warmMutations?: boolean
  }
}

export interface ResolvedConfig {
  defaultBudget: number
  toolTimeoutMs: number
  sync: {
    mode: SyncMode
    scope: SyncScope
    budget: number
    steerThreshold: number
    pushFocus: boolean
    ackClean: boolean
    warmMutations: boolean
  }
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  defaultBudget: 512,
  toolTimeoutMs: 120_000,
  sync: {
    mode: 'enabled',
    scope: 'session',
    budget: 512,
    steerThreshold: 0.15,
    pushFocus: true,
    ackClean: false,
    warmMutations: true,
  },
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`dsh-fovea: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

const unknownKeys = (value: Record<string, unknown>, known: readonly string[], label: string): void => {
  const unknown = Object.keys(value).filter(key => !known.includes(key))
  if (unknown.length > 0) throw new TypeError(`dsh-fovea: unknown ${label} key(s): ${unknown.join(', ')}`)
}

const integer = (value: unknown, fallback: number, min: number, max: number, label: string): number => {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || (resolved as number) < min || (resolved as number) > max) {
    throw new TypeError(`dsh-fovea: ${label} must be an integer from ${min} to ${max}`)
  }
  return resolved as number
}

const number = (value: unknown, fallback: number, min: number, max: number, label: string): number => {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < min || resolved > max) {
    throw new TypeError(`dsh-fovea: ${label} must be a finite number from ${min} to ${max}`)
  }
  return resolved
}

const boolean = (value: unknown, fallback: boolean, label: string): boolean => {
  const resolved = value ?? fallback
  if (typeof resolved !== 'boolean') throw new TypeError(`dsh-fovea: ${label} must be boolean`)
  return resolved
}

export function resolveConfig(input: Config = {}): ResolvedConfig {
  const raw = object(input, 'config')
  unknownKeys(raw, ['defaultBudget', 'toolTimeoutMs', 'sync'], 'config')
  const sync = object(raw.sync, 'sync')
  unknownKeys(sync, ['mode', 'scope', 'budget', 'steerThreshold', 'pushFocus', 'ackClean', 'warmMutations'], 'sync')
  const mode = sync.mode ?? DEFAULT_CONFIG.sync.mode
  if (typeof mode !== 'string' || !SYNC_MODES.includes(mode as SyncMode)) {
    throw new TypeError(`dsh-fovea: sync.mode must be one of ${SYNC_MODES.join(', ')}`)
  }
  const scope = sync.scope ?? DEFAULT_CONFIG.sync.scope
  if (typeof scope !== 'string' || !SYNC_SCOPES.includes(scope as SyncScope)) {
    throw new TypeError(`dsh-fovea: sync.scope must be one of ${SYNC_SCOPES.join(', ')}`)
  }
  return {
    defaultBudget: integer(raw.defaultBudget, DEFAULT_CONFIG.defaultBudget, 256, 16_000, 'defaultBudget'),
    toolTimeoutMs: integer(raw.toolTimeoutMs, DEFAULT_CONFIG.toolTimeoutMs, 1_000, 2_147_483_647, 'toolTimeoutMs'),
    sync: {
      // Emergency host-wide escape hatch retained from pi-fovea. Environment
      // policy intentionally wins over the composed Cordis profile.
      mode: ['off', '0', 'false'].includes(process.env.FOVEA_TURN_SYNC ?? '')
        ? 'disabled'
        : mode as SyncMode,
      scope: scope as SyncScope,
      budget: integer(sync.budget, DEFAULT_CONFIG.sync.budget, 128, 8_192, 'sync.budget'),
      steerThreshold: number(sync.steerThreshold, DEFAULT_CONFIG.sync.steerThreshold, 0.02, 8, 'sync.steerThreshold'),
      pushFocus: boolean(sync.pushFocus, DEFAULT_CONFIG.sync.pushFocus, 'sync.pushFocus'),
      ackClean: boolean(sync.ackClean, DEFAULT_CONFIG.sync.ackClean, 'sync.ackClean'),
      warmMutations: boolean(sync.warmMutations, DEFAULT_CONFIG.sync.warmMutations, 'sync.warmMutations'),
    },
  }
}
