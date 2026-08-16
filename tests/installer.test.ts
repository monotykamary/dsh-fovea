import { spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(root, 'scripts', 'install-local.mjs')
const localLink = 'link:' + root
let sandbox = ''
let home = ''
let bin = ''

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'dsh-fovea-installer-'))
  home = join(sandbox, 'home')
  bin = join(sandbox, 'bin')
  await mkdir(bin, { recursive: true })
  const fake = join(bin, 'pnpm')
  await writeFile(fake, [
    '#!/usr/bin/env node',
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    '',
    'const args = process.argv.slice(2)',
    "if (args[0] === 'install' || (args[0] === 'run' && args[1] === 'build')) process.exit(0)",
    "if (args[0] !== 'dlx') process.exit(91)",
    "const profileAt = args.indexOf('--profile')",
    "const profile = profileAt >= 0 ? args[profileAt + 1] : 'web'",
    "const dir = join(process.env.DSH_HOME, 'profiles', profile)",
    "const path = join(dir, 'package.json')",
    "const read = () => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return { private: true, dependencies: {} } } }",
    "const save = manifest => { mkdirSync(dir, { recursive: true }); writeFileSync(path, JSON.stringify(manifest, null, 2) + String.fromCharCode(10)) }",
    "if (args.includes('--dump-config')) {",
    "  const value = read().dependencies?.['dsh-fovea']",
    "  if (typeof value === 'string') process.stdout.write(['- id: dsh-fovea', '  name: dsh-fovea', process.env.FAKE_DSH_DISABLED === '1' ? '  disabled: true' : '  config: {}', ''].join(String.fromCharCode(10)))",
    '  process.exit(0)',
    '}',
    "const pluginAt = args.indexOf('plugin')",
    'const action = args[pluginAt + 3]',
    'const spec = args[pluginAt + 4]',
    'const manifest = read()',
    'manifest.dependencies ??= {}',
    "if (action === 'add') manifest.dependencies['dsh-fovea'] = spec.startsWith('dsh-fovea@') ? spec.slice('dsh-fovea@'.length) : spec",
    "else if (action === 'remove') delete manifest.dependencies['dsh-fovea']",
    'else process.exit(92)',
    'save(manifest)',
    '',
  ].join('\n'))
  await chmod(fake, 0o755)
})

afterEach(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true })
})

const profilePath = (...parts: string[]) => join(home, 'profiles', 'web', ...parts)

async function seedDependency(value: string | null) {
  const path = profilePath('package.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({
    private: true,
    dependencies: value === null ? {} : { 'dsh-fovea': value },
  }, null, 2) + '\n')
}

async function dependency(): Promise<string | null> {
  const manifest = JSON.parse(await readFile(profilePath('package.json'), 'utf8'))
  return typeof manifest.dependencies?.['dsh-fovea'] === 'string'
    ? manifest.dependencies['dsh-fovea']
    : null
}

function run(args: string[], extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [installer, ...args], {
      cwd: root,
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, DSH_HOME: home, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => accept({ code, stdout, stderr }))
  })
}

async function exists(path: string) {
  try { await access(path); return true } catch { return false }
}

describe('local profile installer', () => {
  it('restores the exact prior dependency on uninstall', async () => {
    await seedDependency('~0.0.9')
    const installed = await run([])
    expect(installed).toMatchObject({ code: 0, stderr: '' })
    expect(await dependency()).toBe(localLink)
    expect(await exists(profilePath('.dsh-fovea-local-install.json'))).toBe(true)

    const removed = await run(['--uninstall'])
    expect(removed).toMatchObject({ code: 0, stderr: '' })
    expect(await dependency()).toBe('~0.0.9')
    expect(await exists(profilePath('.dsh-fovea-local-install.json'))).toBe(false)
  })

  it('preserves a same-checkout link that predated the installer', async () => {
    await seedDependency(localLink)
    const installed = await run([])
    expect(installed).toMatchObject({ code: 0, stderr: '' })
    const marker = JSON.parse(await readFile(profilePath('.dsh-fovea-local-install.json'), 'utf8'))
    expect(marker.prior).toBe(localLink)

    const removed = await run(['--uninstall'])
    expect(removed).toMatchObject({ code: 0, stderr: '' })
    expect(await dependency()).toBe(localLink)
    expect(await exists(profilePath('.dsh-fovea-local-install.json'))).toBe(false)
  })

  it('keeps the original prior dependency across repeat installs', async () => {
    await seedDependency('^0.0.7')
    expect((await run([])).code).toBe(0)
    expect((await run([])).code).toBe(0)
    const marker = JSON.parse(await readFile(profilePath('.dsh-fovea-local-install.json'), 'utf8'))
    expect(marker.prior).toBe('^0.0.7')

    expect((await run(['--uninstall'])).code).toBe(0)
    expect(await dependency()).toBe('^0.0.7')
  })

  it('refuses to uninstall over a dependency changed by someone else', async () => {
    await seedDependency(null)
    expect((await run([])).code).toBe(0)
    await seedDependency('file:../someone-else')

    const removed = await run(['--uninstall'])
    expect(removed.code).toBe(1)
    expect(removed.stderr).toContain("no longer contains this checkout's local link")
    expect(await dependency()).toBe('file:../someone-else')
    expect(await exists(profilePath('.dsh-fovea-local-install.json'))).toBe(true)
  })

  it('rolls back when composed-profile verification fails', async () => {
    await seedDependency('^0.0.8')
    const installed = await run([], { FAKE_DSH_DISABLED: '1' })
    expect(installed.code).toBe(1)
    expect(installed.stderr).toContain('did not compose exactly one active dsh-fovea row')
    expect(installed.stderr).toContain('rolled back')
    expect(await dependency()).toBe('^0.0.8')
    expect(await exists(profilePath('.dsh-fovea-local-install.json'))).toBe(false)
  })
})
