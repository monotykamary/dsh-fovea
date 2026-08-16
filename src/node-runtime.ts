import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat as fsStat, lstat as fsLstat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { FoveaCommandOptions, FoveaCommandResult, FoveaDirEntry, FoveaPathInfo, FoveaRuntime, FoveaSpillRef } from './runtime.js'

function versionOf(value: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint }): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`
}

function infoOf(value: Stats): FoveaPathInfo {
  return {
    type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other',
    version: versionOf(value),
    ...(value.isFile() ? { size: value.size } : {}),
  }
}

/** Local adapter used by the reusable core tests and standalone consumers. */
export class NodeFoveaRuntime implements FoveaRuntime {
  readonly workspaceKey: string
  readonly scopeKey: string
  readonly processRoot: string
  readonly displayRoot: string
  readonly signal: AbortSignal
  private spillRoot: string | undefined
  private readonly cacheRoot: string

  constructor(root: string, options: { scopeKey?: string; signal?: AbortSignal } = {}) {
    this.processRoot = resolve(root)
    this.displayRoot = this.processRoot
    this.workspaceKey = createHash('sha256').update(this.processRoot).digest('hex')
    this.cacheRoot = join(tmpdir(), 'dsh-fovea-cache', this.workspaceKey.slice(0, 24))
    this.scopeKey = options.scopeKey ?? 'standalone'
    this.signal = options.signal ?? new AbortController().signal
  }

  private path(path: string): string { return isAbsolute(path) ? path : resolve(this.processRoot, path) }

  async readText(path: string): Promise<string> { this.signal.throwIfAborted(); return readFile(this.path(path), 'utf8') }
  async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    this.signal.throwIfAborted()
    const value = await readFile(this.path(path))
    if (value.byteLength > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes: ${path}`)
    return value
  }
  async stat(path: string): Promise<FoveaPathInfo | undefined> {
    this.signal.throwIfAborted()
    try { return infoOf(await fsStat(this.path(path))) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async lstat(path: string): Promise<FoveaPathInfo | undefined> {
    this.signal.throwIfAborted()
    try {
      const value = await fsLstat(this.path(path))
      if (value.isSymbolicLink()) return { type: 'symlink', version: versionOf(value), size: value.size }
      return infoOf(value)
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async listDir(path: string): Promise<FoveaDirEntry[]> {
    this.signal.throwIfAborted()
    const entries = await readdir(this.path(path), { withFileTypes: true })
    return entries.sort((a, b) => a.name.localeCompare(b.name)).map(entry => ({
      name: entry.name,
      type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
    }))
  }
  async run(argv: readonly string[], options: FoveaCommandOptions = {}): Promise<FoveaCommandResult> {
    if (argv.length === 0) throw new Error('empty argv')
    const timeoutMs = options.timeoutMs ?? 120_000
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    const upstream = options.signal === undefined ? this.signal : AbortSignal.any([this.signal, options.signal])
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([upstream, timeout])
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
        execFile(argv[0]!, [...argv.slice(1)], {
          cwd: options.cwd ?? this.processRoot,
          encoding: 'utf8',
          maxBuffer: maxBytes,
          signal,
        }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : accept({ stdout, stderr }))
      })
      return { exitCode: 0, signal: null, stdout: result.stdout, stderr: result.stderr, stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false }
    } catch (error) {
      const value = error as NodeJS.ErrnoException & { code?: string | number; signal?: string; stdout?: string; stderr?: string }
      const timedOut = timeout.aborted && !upstream.aborted
      return {
        exitCode: typeof value.code === 'number' ? value.code : null,
        signal: value.signal ?? null,
        stdout: value.stdout ?? '', stderr: value.stderr ?? '',
        stdoutTruncated: value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderrTruncated: false,
        timedOut, aborted: upstream.aborted,
      }
    }
  }
  async createTempText(prefix: string, name: string, content: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix))
    const path = join(directory, name)
    await writeFile(path, content, { mode: 0o600 })
    return path
  }
  private cachePath(key: string): string {
    return join(this.cacheRoot, createHash('sha256').update(key).digest('hex') + '.txt')
  }
  async readCache(key: string, maxBytes = 64 * 1024 * 1024): Promise<string | undefined> {
    this.signal.throwIfAborted()
    const path = this.cachePath(key)
    try {
      const info = await fsStat(path)
      if (!info.isFile() || info.size > maxBytes) return undefined
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  async writeCache(key: string, content: string): Promise<void> {
    this.signal.throwIfAborted()
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 })
    const target = this.cachePath(key)
    const temporary = target + '.tmp-' + process.pid + '-' + randomUUID()
    await writeFile(temporary, content, { mode: 0o600 })
    await rename(temporary, target)
  }
  async deleteCache(key: string): Promise<void> {
    await rm(this.cachePath(key), { force: true })
  }
  async spillText(label: string, content: string): Promise<FoveaSpillRef> {
    this.spillRoot ??= await mkdtemp(join(tmpdir(), 'dsh-fovea-spill-'))
    await mkdir(this.spillRoot, { recursive: true, mode: 0o700 })
    const name = `${Date.now()}-${label.replace(/[^A-Za-z0-9._-]/g, "-")}`
    const path = join(this.spillRoot, name)
    await writeFile(path, content, { mode: 0o600 })
    return { locator: path, bytes: Buffer.byteLength(content), retrievalHint: `Read the complete result from ${path}.` }
  }
}
