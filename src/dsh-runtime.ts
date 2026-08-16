import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { FoveaCommandOptions, FoveaCommandResult, FoveaDirEntry, FoveaPathInfo, FoveaRuntime, FoveaSpillRef } from './runtime.js'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-spill'
import type {} from '@deepseek-ai/dsh-subprocess'

interface RuntimeCall {
  readonly toolName: string
  readonly callId: CallId
}

interface CacheEntry { readonly text: string; readonly bytes: number }
const agentScopes = new WeakMap<Agent, string>()

/** Bind delegated agents to their top-level Fovea focus/sync lineage. */
export const setDshFoveaAgentScope = (agent: Agent, scope: string): void => { agentScopes.set(agent, scope) }
export const clearDshFoveaAgentScope = (agent: Agent): void => { agentScopes.delete(agent) }

const cache = new Map<string, CacheEntry>()
const MAX_CACHE_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_CACHE_BYTES = 128 * 1024 * 1024
let cacheBytes = 0

const cacheId = (workspaceKey: string, key: string): string => `${workspaceKey}\0${key}`
const dropCache = (id: string): void => {
  const previous = cache.get(id)
  if (previous !== undefined) cacheBytes -= previous.bytes
  cache.delete(id)
}

/** DSH capability adapter. Repository I/O and commands stay in one execution world. */
export class DshFoveaRuntime implements FoveaRuntime {
  readonly workspaceKey: string
  readonly scopeKey: string
  readonly processRoot: string
  readonly displayRoot: string
  readonly signal: AbortSignal
  private readonly executables = new Map<string, Promise<string>>()

  private constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    root: Awaited<ReturnType<Context['fs']['resolve']>>,
    signal: AbortSignal,
    private readonly call: RuntimeCall | undefined,
  ) {
    this.workspaceKey = String(root.targetKey)
    this.scopeKey = agentScopes.get(agent) ?? String(agent.id)
    this.processRoot = ctx.fs.processPath(root)
    this.displayRoot = root.displayPath
    this.signal = signal
  }

  static async create(ctx: Context, agent: Agent, signal: AbortSignal, call?: RuntimeCall): Promise<DshFoveaRuntime> {
    const root = await ctx.fs.resolve(agent.session.header.cwd ?? '.', { signal })
    const info = await ctx.fs.stat(root, signal)
    if (info?.type !== 'directory') throw new Error(`dsh-fovea: session cwd is not a directory: ${root.displayPath}`)
    return new DshFoveaRuntime(ctx, agent, root, signal, call)
  }

  private async target(path: string, signal?: AbortSignal) {
    return this.ctx.fs.resolve(path, { cwd: this.processRoot, signal: signal ?? this.signal })
  }
  async readText(path: string, signal = this.signal): Promise<string> { return this.ctx.fs.readText(await this.target(path, signal), signal) }
  async readBytes(path: string, maxBytes: number, signal = this.signal): Promise<Uint8Array> { return this.ctx.fs.readBytes(await this.target(path, signal), signal, maxBytes) }
  async stat(path: string, signal = this.signal): Promise<FoveaPathInfo | undefined> {
    const value = await this.ctx.fs.stat(await this.target(path, signal), signal)
    return value === undefined ? undefined : { type: value.type, version: String(value.version), ...(value.size === undefined ? {} : { size: value.size }) }
  }
  async lstat(path: string, signal = this.signal): Promise<FoveaPathInfo | undefined> {
    const value = await this.ctx.fs.lstat(path, { cwd: this.processRoot }, signal)
    return value === undefined ? undefined : { type: value.type, version: String(value.version), ...(value.size === undefined ? {} : { size: value.size }) }
  }
  async listDir(path: string, signal = this.signal): Promise<FoveaDirEntry[]> {
    const values = await this.ctx.fs.listDir(await this.target(path, signal), signal)
    return values.map(value => ({ name: value.name, type: value.type, ...(value.version === undefined ? {} : { version: String(value.version) }), ...(value.size === undefined ? {} : { size: value.size }) }))
  }
  private executable(command: string, signal: AbortSignal): Promise<string> {
    const hit = this.executables.get(command)
    if (hit !== undefined) return hit
    const pending = this.ctx.subprocess.resolveExecutable(command, undefined, signal)
    this.executables.set(command, pending)
    void pending.catch(() => this.executables.delete(command))
    return pending
  }
  async run(argv: readonly string[], options: FoveaCommandOptions = {}): Promise<FoveaCommandResult> {
    if (argv.length === 0) throw new Error('dsh-fovea: empty subprocess argv')
    const upstream = options.signal === undefined ? this.signal : AbortSignal.any([this.signal, options.signal])
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000)
    const signal = AbortSignal.any([upstream, timeout])
    const executable = await this.executable(argv[0]!, signal)
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    const collect = { maxBytes, spill: { maxBytes } }
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, ...argv.slice(1)], cwd: options.cwd ?? this.processRoot,
      stdio: { stdin: options.stdin === undefined ? 'ignore' : { data: options.stdin }, stdout: collect, stderr: collect },
      graceMs: 2_000, signal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined || stderr === undefined) throw new Error('dsh-fovea: subprocess provider dropped collected output')
    return {
      exitCode: outcome.exitCode, signal: outcome.signal,
      stdout: stdout.text, stderr: stderr.text,
      stdoutTruncated: stdout.lossy, stderrTruncated: stderr.lossy,
      timedOut: timeout.aborted && !upstream.aborted, aborted: upstream.aborted,
    }
  }
  async createTempText(prefix: string, name: string, content: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9._-]+$/.test(prefix) || !/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error('dsh-fovea: invalid temporary file name')
    }
    const script = [
      "const fs=require('node:fs')", "const os=require('node:os')", "const path=require('node:path')",
      "const dir=fs.mkdtempSync(path.join(os.tmpdir(),process.argv[1]))",
      "const file=path.join(dir,process.argv[2])", "fs.writeFileSync(file,fs.readFileSync(0),{mode:0o600})",
      "process.stdout.write(file)",
    ].join(';')
    const result = await this.run(['node', '-e', script, prefix, name], { stdin: content, timeoutMs: 15_000, maxBytes: 1024 * 1024 })
    return result.exitCode === 0 && !result.stdoutTruncated ? result.stdout.trim() || undefined : undefined
  }
  async readCache(key: string, maxBytes = MAX_CACHE_ENTRY_BYTES): Promise<string | undefined> {
    this.signal.throwIfAborted()
    const id = cacheId(this.workspaceKey, key)
    const value = cache.get(id)
    if (value === undefined || value.bytes > maxBytes) return undefined
    // Refresh insertion order for deterministic LRU eviction.
    cache.delete(id)
    cache.set(id, value)
    return value.text
  }
  async writeCache(key: string, content: string): Promise<void> {
    this.signal.throwIfAborted()
    const id = cacheId(this.workspaceKey, key)
    const bytes = Buffer.byteLength(content)
    dropCache(id)
    if (bytes > MAX_CACHE_ENTRY_BYTES) return
    cache.set(id, { text: content, bytes })
    cacheBytes += bytes
    while (cacheBytes > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value as string | undefined
      if (oldest === undefined) break
      dropCache(oldest)
    }
  }
  async deleteCache(key: string): Promise<void> {
    dropCache(cacheId(this.workspaceKey, key))
  }
  async spillText(label: string, content: string): Promise<FoveaSpillRef | undefined> {
    const store = this.ctx.get('spillStore')
    if (store === undefined || this.call === undefined) return undefined
    const ref = await store.saveText({
      owner: { sessionId: this.agent.session.id },
      source: { toolName: this.call.toolName, callId: this.call.callId, label },
      suggestedName: `dsh-fovea-${label}.txt`, content,
    })
    return { locator: String(ref.locator), bytes: ref.bytes, retrievalHint: ref.retrievalHint }
  }
}
