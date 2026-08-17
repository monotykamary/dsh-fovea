#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DSH_PACKAGE = '@monotykamary/dsh@0.1.0-rc.6'
const PACKAGE = 'dsh-fovea'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINK = 'link:' + ROOT
const STATE_FILE = '.dsh-fovea-local-install.json'
const REQUIRED = ['lib/index.js', 'lib/core.js', 'lib/types/index.d.ts', 'lib/types/core.d.ts']

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return printHelp()
  if (options.uninstall) return uninstall(options.profile)
  if (options.skipBuild) await verifyArtifacts()
  else {
    await runPnpm(['install', '--frozen-lockfile'])
    await runPnpm(['run', 'build'])
  }
  const { record: state, created: stateCreated } = await captureState(options.profile)
  try {
    await runPnpm(['dlx', DSH_PACKAGE, 'plugin', '--profile', options.profile, 'add', LINK])
    verifyInstalled(await dumpConfig(options.profile), options.profile)
  } catch (error) {
    const rollback = await rollbackInstall(options.profile, state.prior, stateCreated)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(reason + '\n' + rollback)
  }
  console.log('Installed local dsh-fovea into profile ' + JSON.stringify(options.profile) + '.')
  console.log('No server was started or restarted; reload that profile to activate the new row.')
}

async function uninstall(profile) {
  const state = await loadState(profile)
  const current = await dependencies(profile)
  if (state === undefined && current[PACKAGE] !== LINK) {
    throw new Error('profile ' + JSON.stringify(profile) + " is not proven to contain this checkout's local link")
  }
  if (state !== undefined && state.root !== ROOT) {
    throw new Error('profile ' + JSON.stringify(profile) + ' is owned by a different dsh-fovea checkout')
  }
  const installed = typeof current[PACKAGE] === 'string' ? current[PACKAGE] : null
  if (installed !== LINK) {
    throw new Error(
      'refusing to remove ' + JSON.stringify(installed) + ': profile ' + JSON.stringify(profile) +
      " no longer contains this checkout's local link",
    )
  }
  const prior = state?.prior ?? null
  await restorePrior(profile, prior)
  await rm(statePath(profile), { force: true })
  const config = await dumpConfig(profile)
  if (prior === null && hasRow(config)) throw new Error('composed profile still contains dsh-fovea after removal')
  console.log('Removed local dsh-fovea from profile ' + JSON.stringify(profile) + (prior === null ? '.' : ' and restored ' + JSON.stringify(prior) + '.'))
  console.log('No server was started or restarted; reload that profile to apply the change.')
}

function parseArgs(args) {
  let profile = 'web'
  let skipBuild = false
  let uninstall = false
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg === '--profile') {
      const value = args[++index]
      if (value === undefined) throw new Error('--profile requires a value')
      profile = value
    } else if (arg.startsWith('--profile=')) profile = arg.slice('--profile='.length)
    else if (arg === '--skip-build') skipBuild = true
    else if (arg === '--uninstall') uninstall = true
    else if (arg === '--help' || arg === '-h') help = true
    else throw new Error('unknown argument ' + JSON.stringify(arg))
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile)) throw new Error('invalid profile name ' + JSON.stringify(profile))
  if (uninstall && skipBuild) throw new Error('--skip-build applies only to installation')
  return { profile, skipBuild, uninstall, help }
}

function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  const selected = configured ? configured : join(homedir(), '.dsh')
  if (selected === '~') return homedir()
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return resolve(homedir(), selected.slice(2))
  return resolve(selected)
}
const profileDir = profile => join(dshHome(), 'profiles', profile)
const statePath = profile => join(profileDir(profile), STATE_FILE)

async function dependencies(profile) {
  try {
    const manifest = JSON.parse(await readFile(join(profileDir(profile), 'package.json'), 'utf8'))
    return manifest && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {}
    throw error
  }
}

async function captureState(profile) {
  const existing = await loadState(profile)
  if (existing !== undefined) {
    if (existing.root !== ROOT) throw new Error('profile ' + JSON.stringify(profile) + ' is already owned by ' + JSON.stringify(existing.root))
    const current = await dependencies(profile)
    if (current[PACKAGE] !== LINK) {
      throw new Error(
        'profile ' + JSON.stringify(profile) + " has an installer state marker but no longer contains this checkout's local link",
      )
    }
    return { record: existing, created: false }
  }
  const current = await dependencies(profile)
  const prior = typeof current[PACKAGE] === 'string' ? current[PACKAGE] : null
  const path = statePath(profile)
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + process.pid + '.tmp'
  await writeFile(temporary, JSON.stringify({ version: 1, root: ROOT, prior }, null, 2) + '\n', { flag: 'wx' })
  await rename(temporary, path)
  return { record: { version: 1, root: ROOT, prior }, created: true }
}

async function restorePrior(profile, prior) {
  const current = await dependencies(profile)
  const installed = typeof current[PACKAGE] === 'string' ? current[PACKAGE] : null
  if (installed !== LINK) {
    throw new Error('refusing restoration over unexpected dependency ' + JSON.stringify(installed))
  }
  // Replacing the dependency in place preserves its existing bundle-layer
  // position. A remove-then-add cycle would silently append it at the end.
  if (prior !== LINK) {
    if (prior === null) await runPnpm(['dlx', DSH_PACKAGE, 'plugin', '--profile', profile, 'remove', PACKAGE])
    else await runPnpm(['dlx', DSH_PACKAGE, 'plugin', '--profile', profile, 'add', PACKAGE + '@' + prior])
  }
  const after = await dependencies(profile)
  const actual = typeof after[PACKAGE] === 'string' ? after[PACKAGE] : null
  if (actual !== prior) throw new Error('profile restoration mismatch: got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(prior))
}

async function rollbackInstall(profile, prior, stateCreated) {
  const current = await dependencies(profile)
  const installed = typeof current[PACKAGE] === 'string' ? current[PACKAGE] : null
  if (!stateCreated && installed === LINK) {
    return 'The previously installed local link was left unchanged; its installer state marker was retained.'
  }
  if (stateCreated && installed === prior) {
    await rm(statePath(profile), { force: true })
    return 'The profile was unchanged; the new installer state marker was removed.'
  }
  if (installed !== LINK) {
    return 'Automatic rollback was skipped because the dependency now has the unexpected value ' +
      JSON.stringify(installed) + '; the installer state marker was retained.'
  }
  try {
    await restorePrior(profile, prior)
    if (stateCreated) await rm(statePath(profile), { force: true })
    return 'The profile dependency was rolled back to its previous value.'
  } catch (error) {
    return 'Automatic rollback failed and the installer state marker was retained: ' +
      (error instanceof Error ? error.message : String(error))
  }
}

async function loadState(profile) {
  try {
    const value = JSON.parse(await readFile(statePath(profile), 'utf8'))
    if (value?.version !== 1 || typeof value.root !== 'string' || (value.prior !== null && typeof value.prior !== 'string')) {
      throw new Error('invalid ' + STATE_FILE)
    }
    return value
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function verifyArtifacts() {
  for (const path of REQUIRED) {
    try { await access(resolve(ROOT, path)) } catch { throw new Error('--skip-build requires ' + path + '; run installation without --skip-build first') }
  }
}

async function dumpConfig(profile) {
  return runPnpm(['dlx', DSH_PACKAGE, '--profile', profile, '--dump-config'], true)
}
const hasRow = config => /- id: dsh-fovea(?:\r?\n)+\s+name: ['"]?dsh-fovea['"]?/u.test(config)
function verifyInstalled(config, profile) {
  const rows = [...config.matchAll(/^- id: dsh-fovea\r?\n((?: {2}[^\n]*(?:\n|$))*)/gmu)]
  if (rows.length !== 1 || !hasRow(config) || /(?:^|\n)  disabled: true(?:\n|$)/u.test(rows[0][1] ?? '')) {
    throw new Error('profile ' + JSON.stringify(profile) + ' did not compose exactly one active dsh-fovea row')
  }
}

function runPnpm(args, capture = false) {
  let invocation
  if (process.platform === 'win32') {
    const entry = process.env.npm_execpath
    if (!entry || !/\.[cm]?js$/i.test(entry)) throw new Error('on Windows invoke this script through pnpm run')
    invocation = { command: process.execPath, args: [entry, ...args] }
  } else invocation = { command: 'pnpm', args }
  return new Promise((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: ROOT, env: process.env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' })
    let stdout = ''
    if (capture) child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) accept(stdout)
      else reject(new Error('pnpm ' + args.join(' ') + ' failed' + (signal ? ' from signal ' + signal : ' with exit code ' + code)))
    })
  })
}

function printHelp() {
  console.log([
    'Usage:',
    '  pnpm run install:local -- [--profile web] [--skip-build]',
    '  pnpm run uninstall:local -- [--profile web]',
    '',
    'Build and link this checkout into one DSH profile without starting or restarting DSH.',
    'DSH_HOME selects a non-default DSH home.',
  ].join('\n'))
}

try { await main() } catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
