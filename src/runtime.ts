import { AsyncLocalStorage } from 'node:async_hooks'

export type FoveaPathType = 'file' | 'directory' | 'symlink' | 'other'

export interface FoveaPathInfo {
  readonly type: FoveaPathType
  readonly version: string
  readonly size?: number
}

export interface FoveaDirEntry {
  readonly name: string
  readonly type: Exclude<FoveaPathType, 'symlink'>
  readonly version?: string
  readonly size?: number
}

export interface FoveaCommandOptions {
  readonly cwd?: string
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly signal?: AbortSignal
}

export interface FoveaCommandResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly timedOut: boolean
  readonly aborted: boolean
}

export interface FoveaSpillRef {
  readonly locator: string
  readonly bytes: number
  readonly retrievalHint: string
}

/** Lease for one isolated git worktree created through the runtime. */
export interface WorktreeLease {
  readonly gitRoot: string
  readonly path: string
  /** Effective child cwd inside the generated worktree. */
  readonly cwd: string
  readonly branch: string
}

/** One repository execution world bound to one calling agent. */
export interface FoveaRuntime {
  readonly workspaceKey: string
  readonly scopeKey: string
  readonly processRoot: string
  readonly displayRoot: string
  readonly signal: AbortSignal
  readText(path: string, signal?: AbortSignal): Promise<string>
  readBytes(path: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>
  stat(path: string, signal?: AbortSignal): Promise<FoveaPathInfo | undefined>
  lstat(path: string, signal?: AbortSignal): Promise<FoveaPathInfo | undefined>
  listDir(path: string, signal?: AbortSignal): Promise<FoveaDirEntry[]>
  run(argv: readonly string[], options?: FoveaCommandOptions): Promise<FoveaCommandResult>
  createTempText(prefix: string, name: string, content: string): Promise<string | undefined>
  /** Create an isolated git worktree outside the repository and return its lease. */
  createWorktree(id: string, cwd: string, name: string, preserveSourceSubdirectory?: boolean): Promise<WorktreeLease>
  /** Return the lease for a previously created worktree id. */
  getWorktree(id: string): WorktreeLease | undefined
  /** Remove the worktree (and optionally its branch). Returns false for an unknown id. */
  removeWorktree(id: string, deleteBranch?: boolean): Promise<boolean>
  /** Read host-managed optimization/state data scoped to this workspace. */
  readCache(key: string, maxBytes?: number): Promise<string | undefined>
  /** Persist host-managed optimization/state data scoped to this workspace. */
  writeCache(key: string, content: string): Promise<void>
  /** Remove one host-managed cache entry. */
  deleteCache(key: string): Promise<void>
  spillText(label: string, content: string): Promise<FoveaSpillRef | undefined>
}

const storage = new AsyncLocalStorage<FoveaRuntime>()

export function withFoveaRuntime<T>(runtime: FoveaRuntime, operation: () => T): T {
  return storage.run(runtime, operation)
}

export function currentRuntime(): FoveaRuntime {
  const runtime = storage.getStore()
  if (runtime === undefined) throw new Error('dsh-fovea: repository operation has no bound runtime')
  return runtime
}

export function maybeRuntime(): FoveaRuntime | undefined {
  return storage.getStore()
}

/** Path helpers deliberately follow the execution world's slash syntax rather
 * than the host process' node:path implementation. This keeps a macOS/Linux
 * Harness host able to address a Windows provider (and vice versa). */
const slashPath = (value: string): string => value.replaceAll('\\', '/')
export const isExecutionAbsolute = (value: string): boolean => {
  const normalized = slashPath(value)
  return normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
}

export function executionPathResolve(root: string, input = '.'): string {
  const base = slashPath(root)
  const value = slashPath(input)
  const combined = isExecutionAbsolute(value) ? value : `${base}/${value}`
  const drive = combined.match(/^[A-Za-z]:/u)?.[0] ?? ''
  const unc = drive === '' && combined.startsWith('//')
  const absolute = drive !== '' || combined.startsWith('/')
  const body = drive !== '' ? combined.slice(drive.length) : unc ? combined.slice(2) : combined
  const parts: string[] = []
  for (const part of body.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
      else if (!absolute) parts.push(part)
      continue
    }
    parts.push(part)
  }
  const prefix = drive !== '' ? `${drive}/` : unc ? '//' : absolute ? '/' : ''
  return prefix + parts.join('/')
}

export function executionPathJoin(root: string, ...parts: readonly string[]): string {
  let value = executionPathResolve(root)
  for (const part of parts) value = executionPathResolve(value, part)
  return value
}

/** Resolve a provider path and return its repository-relative identity only
 * when it is contained by root. Windows drive paths compare case-insensitively. */
export function executionRelativePath(root: string, input: string): { absolutePath: string; file: string } | undefined {
  const absolutePath = executionPathResolve(root, input)
  const absoluteRoot = executionPathResolve(root)
  const insensitive = /^[A-Za-z]:\//u.test(absoluteRoot) || absoluteRoot.startsWith('//')
  const lhs = insensitive ? absolutePath.toLowerCase() : absolutePath
  const rhs = insensitive ? absoluteRoot.toLowerCase() : absoluteRoot
  if (lhs === rhs || !lhs.startsWith(rhs.endsWith('/') ? rhs : rhs + '/')) return undefined
  const file = absolutePath.slice(absoluteRoot.length).replace(/^\/+/, '')
  return file === '' ? undefined : { absolutePath, file }
}

export function workspaceStateKey(fallback: string): string {
  return storage.getStore()?.workspaceKey ?? fallback
}

export function scopedStateKey(workspaceKey: string, scopeKey: string): string {
  return `${workspaceKey}\0${scopeKey}`
}

export function agentStateKey(fallback: string): string {
  const runtime = storage.getStore()
  return runtime === undefined ? fallback : scopedStateKey(runtime.workspaceKey, runtime.scopeKey)
}

export function operationSignal(signal?: AbortSignal): AbortSignal {
  const runtime = currentRuntime()
  return signal === undefined ? runtime.signal : AbortSignal.any([runtime.signal, signal])
}
