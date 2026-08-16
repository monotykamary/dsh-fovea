#!/usr/bin/env node

import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

const fail = message => { throw new Error(`package verification failed: ${message}`) }
const exists = async path => { try { await access(resolve(root, path)); return true } catch { return false } }

if (manifest.name !== 'dsh-fovea') fail('unexpected package name')
if (manifest.type !== 'module') fail('package must be ESM')
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') fail('missing DSH bundle patch declaration')

const required = [
  'lib/index.js',
  'lib/core.js',
  'lib/types/index.d.ts',
  'lib/types/core.d.ts',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
]
for (const path of required) if (!await exists(path)) fail(`missing artifact ${path}`)

for (const [subpath, declaration] of Object.entries(manifest.exports ?? {})) {
  if (typeof declaration === 'string') {
    if (!await exists(declaration)) fail(`export ${subpath} points to missing ${declaration}`)
    continue
  }
  if (declaration && typeof declaration === 'object') {
    for (const target of Object.values(declaration)) {
      if (typeof target === 'string' && !await exists(target)) fail(`export ${subpath} points to missing ${target}`)
    }
  }
}

const plugin = await import(pathToFileURL(resolve(root, 'lib/index.js')).href + `?verify=${Date.now()}`)
if (typeof plugin.apply !== 'function') fail('main entry does not export apply()')
if (plugin.name !== 'dsh-fovea') fail('main entry has the wrong Cordis plugin name')
for (const service of ['tools', 'fs', 'subprocess', 'systemPrompt']) {
  if (!plugin.inject?.includes(service)) fail(`main entry does not inject ${service}`)
}
const core = await import(pathToFileURL(resolve(root, 'lib/core.js')).href + `?verify=${Date.now()}`)
for (const symbol of ['sketch', 'focus', 'dwell', 'impact', 'NodeFoveaRuntime', 'withFoveaRuntime']) {
  if (!(symbol in core)) fail(`core entry does not export ${symbol}`)
}

const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
if (!/- id: dsh-fovea(?:\r?\n)+\s+name: dsh-fovea/u.test(patch)) fail('bundle patch does not insert dsh-fovea')

const jsFiles = (await readdir(resolve(root, 'lib'), { recursive: true }))
  .filter(path => typeof path === 'string' && path.endsWith('.js'))
for (const path of jsFiles) {
  const text = await readFile(resolve(root, 'lib', path), 'utf8')
  if (text.includes('@earendil-works/pi-coding-agent') || text.includes('@mariozechner/pi-coding-agent')) {
    fail(`built artifact ${path} retains a Pi host dependency`)
  }
  if (text.includes(root)) fail(`built artifact ${path} embeds the source checkout path`)
}

console.log(`Verified dsh-fovea ${manifest.version}: ${required.length} required artifacts, Cordis surface, core surface, patch, and host-dependency hygiene.`)
