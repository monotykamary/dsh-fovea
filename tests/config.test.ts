import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, resolveConfig } from '../src/core/config.js'

describe('DSH Fovea config', () => {
  it('provides bounded tool and continuous-sync defaults', () => {
    expect(resolveConfig()).toEqual(DEFAULT_CONFIG)
    expect(DEFAULT_CONFIG).toMatchObject({
      defaultBudget: 512,
      toolTimeoutMs: 120_000,
      sync: { mode: 'enabled', scope: 'session', budget: 512, steerThreshold: 0.15, pushFocus: true, ackClean: false, warmMutations: true },
      grep: { mode: 'augment', augmentBudget: 512 },
    })
  })

  it('detaches and fills a partial Cordis config', () => {
    const input = { defaultBudget: 900, sync: { mode: 'hidden' as const, pushFocus: false, ackClean: true } }
    const resolved = resolveConfig(input)
    expect(resolved.defaultBudget).toBe(900)
    expect(resolved.sync).toMatchObject({ mode: 'hidden', budget: 512, pushFocus: false, ackClean: true })
    input.sync.pushFocus = true
    expect(resolved.sync.pushFocus).toBe(false)
  })

  it('loads repository-wide sync explicitly', () => {
    expect(resolveConfig({ sync: { scope: 'repository' } }).sync.scope).toBe('repository')
    expect(resolveConfig({ sync: { scope: 'repository' } }).sync.mode).toBe('enabled')
  })

  it('resolves the native-grep integration, defaulting to pi-fovea semantics', () => {
    expect(resolveConfig().grep).toEqual({ mode: 'augment', augmentBudget: 512 })
    expect(resolveConfig({ grep: { mode: 'replace' } }).grep).toEqual({ mode: 'replace', augmentBudget: 512 })
    expect(resolveConfig({ grep: { mode: 'off', augmentBudget: 1024 } }).grep).toEqual({ mode: 'off', augmentBudget: 1024 })
  })

  it('lets FOVEA_TURN_SYNC=off override the Cordis profile', () => {
    const previous = process.env.FOVEA_TURN_SYNC
    process.env.FOVEA_TURN_SYNC = 'off'
    try {
      expect(resolveConfig({ sync: { mode: 'hidden' } }).sync.mode).toBe('disabled')
    } finally {
      if (previous === undefined) delete process.env.FOVEA_TURN_SYNC
      else process.env.FOVEA_TURN_SYNC = previous
    }
  })

  it.each([
    [{ nope: true }, /unknown config key/],
    [{ sync: { nope: true } }, /unknown sync key/],
    [{ defaultBudget: 1 }, /defaultBudget/],
    [{ toolTimeoutMs: 999 }, /toolTimeoutMs/],
    [{ sync: { mode: 'visible' } }, /sync.mode/],
    [{ sync: { scope: 'workspace' } }, /sync.scope/],
    [{ sync: { steerThreshold: Number.NaN } }, /sync.steerThreshold/],
    [{ sync: { ackClean: 'yes' } }, /sync.ackClean/],
    [{ grep: { nope: true } }, /unknown grep key/],
    [{ grep: { mode: 'shadow' } }, /grep.mode/],
    [{ grep: { augmentBudget: 3 } }, /grep.augmentBudget/],
  ])('rejects malformed input %#', (input, message) => {
    expect(() => resolveConfig(input as never)).toThrow(message)
  })
})
