import { executionPathJoin, executionPathResolve, executionRelativePath, type FoveaRuntime, type WorktreeLease } from './runtime.js'

const safeLabel = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'agent'

const worktreePrefixParts = (prefix: string): string[] | undefined => {
  const parts = prefix.split(/[\\/]+/).filter(Boolean)
  return parts.every((part) => part !== '.' && part !== '..') ? parts : undefined
}

/** Compare two paths in the execution world's slash syntax (drive/UNC case-insensitive). */
const sameExecutionPath = (left: string, right: string): boolean => {
  const a = executionPathResolve(left)
  const b = executionPathResolve(right)
  const insensitive = /^[A-Za-z]:\//u.test(a) || a.startsWith('//')
  return insensitive ? a.toLowerCase() === b.toLowerCase() : a === b
}

const isInside = (root: string, target: string): boolean =>
  sameExecutionPath(root, target) || executionRelativePath(root, target) !== undefined

const gitFailure = (action: string, result: { exitCode: number | null; stdout: string; stderr: string }): Error => {
  const detail = (result.stderr || result.stdout).trim().slice(0, 500)
  return new Error(`git ${action} failed${detail === '' ? '' : `: ${detail}`}`)
}

/**
 * Port of pi-fabric's WorktreeManager, adapted to the FoveaRuntime execution
 * world. Every git call goes through runtime.run and every path is expressed
 * in the execution world's slash syntax, so leases behave identically through
 * the standalone Node adapter and the DSH provider adapters. The temporary
 * parent directory comes from runtime.createTempText, which lets each
 * execution world provide its own native temp location (the provider's
 * os.tmpdir() for DSH, the host tmpdir for standalone runs); git worktree
 * remove takes the checkout itself, so only the empty parent shell with its
 * .keep marker remains for the OS to reap.
 */
export class WorktreeManager {
  readonly #leases = new Map<string, WorktreeLease>()

  constructor(private readonly runtime: FoveaRuntime) {}

  async create(
    id: string,
    cwd: string,
    name: string,
    preserveSourceSubdirectory = false,
  ): Promise<WorktreeLease> {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Worktree isolation requires a plain worktree id')
    const rootResult = await this.runtime.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    const gitRoot = rootResult.exitCode === 0 ? rootResult.stdout.trim() : ''
    if (gitRoot === '') throw new Error('Worktree isolation requires a Git repository')
    let sourcePrefix = ''
    if (preserveSourceSubdirectory) {
      const prefixResult = await this.runtime.run(['git', 'rev-parse', '--show-prefix'], { cwd })
      sourcePrefix = prefixResult.exitCode === 0 ? prefixResult.stdout.trim() : ''
    }
    const marker = await this.runtime.createTempText('dsh-fovea-worktree-', '.keep', '')
    if (marker === undefined) throw new Error('Worktree isolation requires a writable temporary directory')
    const parent = executionPathResolve(marker, '..')
    const branch = `dsh-fovea/${safeLabel(name)}-${id.slice(0, 8)}`
    const worktreePath = executionPathJoin(parent, id)
    const added = await this.runtime.run(
      ['git', 'worktree', 'add', '-b', branch, worktreePath, 'HEAD'],
      { cwd: gitRoot, timeoutMs: 60_000 },
    )
    if (added.exitCode !== 0) throw gitFailure('worktree add', added)
    const prefix = preserveSourceSubdirectory ? worktreePrefixParts(sourcePrefix) : undefined
    let effectiveCwd = worktreePath
    if (prefix !== undefined && prefix.length > 0) {
      // Git reports its own worktree-relative prefix with '/' on every
      // platform; rejoin it in execution-world syntax so drive/UNC casing
      // never has to match the host process' node:path implementation.
      const candidate = executionPathJoin(worktreePath, ...prefix)
      try {
        const info = await this.runtime.stat(candidate)
        if (info?.type === 'directory' && isInside(worktreePath, candidate)) effectiveCwd = candidate
      } catch {
        // The selected subdirectory may be untracked or absent from HEAD;
        // use the valid worktree root in that case.
      }
    }
    const lease: WorktreeLease = { gitRoot, path: worktreePath, cwd: effectiveCwd, branch }
    this.#leases.set(id, lease)
    return lease
  }

  get(id: string): WorktreeLease | undefined {
    return this.#leases.get(id)
  }

  async cleanup(id: string, deleteBranch = false): Promise<boolean> {
    const lease = this.#leases.get(id)
    if (lease === undefined) return false
    const removed = await this.runtime.run(
      ['git', 'worktree', 'remove', '--force', lease.path],
      { cwd: lease.gitRoot, timeoutMs: 60_000 },
    )
    if (removed.exitCode !== 0) throw gitFailure('worktree remove', removed)
    if (deleteBranch) {
      const deleted = await this.runtime.run(['git', 'branch', '-D', lease.branch], {
        cwd: lease.gitRoot,
        timeoutMs: 30_000,
      })
      if (deleted.exitCode !== 0) throw gitFailure('branch delete', deleted)
    }
    this.#leases.delete(id)
    return true
  }
}
