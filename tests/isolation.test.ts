import { describe, expect, it } from 'vitest'
import { NodeFoveaRuntime } from '../src/node-runtime.js'
import {
  currentRuntime, executionPathJoin, executionPathResolve, executionRelativePath, withFoveaRuntime,
} from '../src/runtime.js'
import { getSession, resetSessions } from '../src/core/session.js'
import { resetSyncBaseline, resetSyncBaselines, sync, syncBaselineStore } from '../src/core/sync.js'
import type { RepoState } from '../src/core/state.js'

const synthetic = (): RepoState => ({
  version: 'synthetic',
  files: [],
  facts: {},
  graph: { nodes: [], edges: [], byName: new Map(), byFile: new Map(), anchors: [], files: [] },
  csr: { n: 0, rowPtr: new Int32Array(1), col: new Int32Array(), w: new Float64Array(), invSqrtDeg: new Float64Array() },
  cochange: new Map(),
  extraction: { failed: [], unreadable: [], oversized: [], generated: [] },
})

describe('agent and workspace state keys', () => {
  it('isolates disclosure and dwell state by agent over one repository graph key', async () => {
    resetSessions()
    const one = new NodeFoveaRuntime(process.cwd(), { scopeKey: 'agent-one' })
    const two = new NodeFoveaRuntime(process.cwd(), { scopeKey: 'agent-two' })
    await withFoveaRuntime(one, async () => { getSession('.').dwellT = 8 })
    expect(await withFoveaRuntime(one, async () => getSession('.').dwellT)).toBe(8)
    expect(await withFoveaRuntime(two, async () => getSession('.').dwellT)).toBeUndefined()
    expect(one.workspaceKey).toBe(two.workspaceKey)
  })

  it('keeps and resets continuous-sync baselines per agent', async () => {
    resetSyncBaselines()
    const one = new NodeFoveaRuntime(process.cwd(), { scopeKey: 'agent-one' })
    const two = new NodeFoveaRuntime(process.cwd(), { scopeKey: 'agent-two' })
    const state = synthetic()
    const first = await withFoveaRuntime(one, () => sync('.', { budget: 256, steerThreshold: 0.1 }, state))
    const second = await withFoveaRuntime(two, () => sync('.', { budget: 256, steerThreshold: 0.1 }, state))
    expect(first.details.baseline).toBe('established')
    expect(second.details.baseline).toBe('established')
    expect(syncBaselineStore().size).toBe(2)
    await withFoveaRuntime(one, async () => resetSyncBaseline('.'))
    expect(syncBaselineStore().size).toBe(1)
  })

  it('normalizes paths in the execution provider world, not the host OS', () => {
    expect(executionPathJoin('/workspace/repo', 'src', '../tests/a.ts')).toBe('/workspace/repo/tests/a.ts')
    expect(executionPathResolve('C:\\Work\\Repo', 'src\\users.ts')).toBe('C:/Work/Repo/src/users.ts')
    expect(executionRelativePath('C:\\Work\\Repo', 'c:\\work\\repo\\src\\users.ts')).toEqual({
      absolutePath: 'c:/work/repo/src/users.ts',
      file: 'src/users.ts',
    })
    expect(executionRelativePath('/workspace/repo', '../outside.ts')).toBeUndefined()
  })

  it('fails loudly when reusable core code has no runtime capability', () => {
    expect(() => currentRuntime()).toThrow(/no bound runtime/)
  })
})
