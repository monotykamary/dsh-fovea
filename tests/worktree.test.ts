import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeFoveaRuntime } from '../src/node-runtime.js'
import type { WorktreeLease } from '../src/runtime.js'
import { WorktreeManager } from '../src/worktree.js'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const roots: string[] = []
const leases: Array<{ repository: string; path: string; branch: string }> = []

const initRepository = (prefix: string, relativeDirectory?: string): string => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  roots.push(repository)
  git(repository, 'init', '-q')
  git(repository, 'config', 'user.email', 'dsh-fovea-tests@example.invalid')
  git(repository, 'config', 'user.name', 'DSH Fovea tests')
  fs.writeFileSync(path.join(repository, 'README.md'), 'test repository\n')
  if (relativeDirectory) {
    const directory = path.join(repository, relativeDirectory)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'module.ts'), 'export const test = true;\n')
  }
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'initial')
  return repository
}

const trackLease = (repository: string, lease: WorktreeLease): void => {
  leases.push({ repository, path: lease.path, branch: lease.branch })
}

afterEach(() => {
  for (const lease of leases.splice(0)) {
    try { git(lease.repository, 'worktree', 'remove', '--force', lease.path) } catch { /* already gone */ }
    try { git(lease.repository, 'branch', '-D', lease.branch) } catch { /* already gone */ }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('git worktree isolation', () => {
  it('creates an isolated worktree lease and cleanup removes it', async () => {
    const repository = initRepository('dsh-fovea-wt-isolate-')
    const runtime = new NodeFoveaRuntime(repository)
    const lease = await runtime.createWorktree('one', repository, 'My Agent')
    trackLease(repository, lease)
    const realPath = fs.realpathSync(lease.path)

    expect(runtime.getWorktree('one')).toBe(lease)
    expect(lease.path).not.toBe(repository)
    expect(fs.statSync(lease.path).isDirectory()).toBe(true)
    expect(lease.cwd).toBe(lease.path)
    expect(lease.branch).toBe('dsh-fovea/my-agent-one')
    // Git marks branches checked out in a linked worktree with a '+ ' prefix.
    expect(git(repository, 'branch', '--list', lease.branch)).toContain(lease.branch)
    expect(git(repository, 'worktree', 'list', '--porcelain')).toContain(realPath)
    // gitRoot names the owning repository (cwd for cleanup), not the checkout.
    expect(fs.realpathSync(lease.gitRoot)).toBe(fs.realpathSync(repository))
    expect(fs.realpathSync(git(lease.path, 'rev-parse', '--show-toplevel'))).toBe(realPath)

    // Uncommitted edits in the main worktree never leak into the lease.
    fs.writeFileSync(path.join(repository, 'README.md'), 'edited in main worktree\n')
    expect(fs.readFileSync(path.join(lease.path, 'README.md'), 'utf8')).toBe('test repository\n')
    expect(git(lease.path, 'status', '--porcelain')).toBe('')

    expect(await runtime.removeWorktree('one', true)).toBe(true)
    expect(fs.existsSync(lease.path)).toBe(false)
    expect(git(repository, 'branch', '--list', lease.branch)).toBe('')
    expect(git(repository, 'worktree', 'list', '--porcelain')).not.toContain(realPath)
    expect(await runtime.removeWorktree('one', true)).toBe(false)
  })

  it('exposes worktree commits on the lease branch in the main repository', async () => {
    const repository = initRepository('dsh-fovea-wt-commit-')
    const runtime = new NodeFoveaRuntime(repository)
    const lease = await runtime.createWorktree('agent-c', repository, 'Committing Agent')
    trackLease(repository, lease)

    fs.writeFileSync(path.join(lease.path, 'NEW.md'), 'from the worktree\n')
    git(lease.path, 'add', '.')
    git(lease.path, 'commit', '-qm', 'worktree change')

    const branchHead = git(repository, 'rev-parse', lease.branch)
    expect(branchHead).toBe(git(lease.path, 'rev-parse', 'HEAD'))
    expect(branchHead).not.toBe(git(repository, 'rev-parse', 'HEAD'))
    await runtime.removeWorktree('agent-c', true)
  })

  it('preserves the source subdirectory in the lease cwd when requested', async () => {
    const repository = initRepository('dsh-fovea-wt-subdir-', 'packages/app')
    const runtime = new NodeFoveaRuntime(repository)
    const lease = await runtime.createWorktree('agent-sub', path.join(repository, 'packages', 'app'), 'worker', true)
    trackLease(repository, lease)

    expect(lease.cwd).toBe(path.join(lease.path, 'packages', 'app'))
    expect(fs.statSync(lease.cwd).isDirectory()).toBe(true)
    expect(fs.realpathSync(git(lease.cwd, 'rev-parse', '--show-toplevel'))).toBe(fs.realpathSync(lease.path))
    await runtime.removeWorktree('agent-sub', true)
  })

  it('defaults to the worktree root when the subdirectory is not preserved', async () => {
    const repository = initRepository('dsh-fovea-wt-root-', 'packages/app')
    const runtime = new NodeFoveaRuntime(repository)
    const lease = await runtime.createWorktree('agent-root', path.join(repository, 'packages', 'app'), 'worker')
    trackLease(repository, lease)

    expect(lease.cwd).toBe(lease.path)
    await runtime.removeWorktree('agent-root', true)
  })

  it('rejects a non-repository cwd', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fovea-wt-plain-'))
    roots.push(plain)
    const runtime = new NodeFoveaRuntime(plain)
    await expect(runtime.createWorktree('agent-x', plain, 'worker')).rejects.toThrow(/requires a Git repository/)
  })

  it('rejects ids that would escape the temporary parent', async () => {
    const repository = initRepository('dsh-fovea-wt-escape-')
    const runtime = new NodeFoveaRuntime(repository)
    await expect(runtime.createWorktree('../escape', repository, 'worker')).rejects.toThrow(/plain worktree id/)
  })

  it('returns false and undefined for unknown ids', async () => {
    const repository = initRepository('dsh-fovea-wt-unknown-')
    const runtime = new NodeFoveaRuntime(repository)
    expect(runtime.getWorktree('missing')).toBeUndefined()
    expect(await runtime.removeWorktree('missing', true)).toBe(false)
  })

  it('isolates concurrent leases on the same repository', async () => {
    const repository = initRepository('dsh-fovea-wt-pair-')
    const runtime = new NodeFoveaRuntime(repository)
    const one = await runtime.createWorktree('agent-a', repository, 'A')
    trackLease(repository, one)
    const two = await runtime.createWorktree('agent-b', repository, 'B')
    trackLease(repository, two)

    expect(one.path).not.toBe(two.path)
    expect(git(repository, 'worktree', 'list', '--porcelain')).toContain(fs.realpathSync(one.path))
    expect(git(repository, 'worktree', 'list', '--porcelain')).toContain(fs.realpathSync(two.path))
    fs.writeFileSync(path.join(one.path, 'README.md'), 'changed in A\n')
    expect(fs.readFileSync(path.join(two.path, 'README.md'), 'utf8')).toBe('test repository\n')

    await runtime.removeWorktree('agent-a', true)
    expect(git(repository, 'worktree', 'list', '--porcelain')).toContain(fs.realpathSync(two.path))
    await runtime.removeWorktree('agent-b', true)
  })

  it('works when the manager is used directly against a runtime', async () => {
    const repository = initRepository('dsh-fovea-wt-direct-')
    const runtime = new NodeFoveaRuntime(repository)
    const manager = new WorktreeManager(runtime)

    const lease = await manager.create('direct', repository, 'Direct Consumer')
    trackLease(repository, lease)
    expect(manager.get('direct')).toBe(lease)
    expect(await manager.cleanup('direct', true)).toBe(true)
    expect(await manager.cleanup('direct', true)).toBe(false)
  })
})
