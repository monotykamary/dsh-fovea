// Light status probe across repos: build stats + anchor/rule coverage, driven
// through the standalone node runtime so it exercises the same execution-world
// boundary as the DSH plugin. Usage: pnpm tsx scripts/probe.ts <repo...>
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { ensureState } from '../src/core/state.ts'
import { sketch } from '../src/core/ops.ts'
import { resetSessions } from '../src/core/session.ts'
import { NodeFoveaRuntime } from '../src/node-runtime.ts'
import { withFoveaRuntime } from '../src/runtime.ts'

for (const arg of process.argv.slice(2)) {
  const root = resolve(arg)
  const runtime = new NodeFoveaRuntime(root)
  resetSessions()
  const t0 = performance.now()
  const state = await withFoveaRuntime(runtime, () => ensureState(runtime.processRoot))
  const ms = performance.now() - t0
  const g = state.graph
  const litEdges = g.edges.filter((edge) => edge.kind === 'join').length
  const callEdges = g.edges.filter((edge) => edge.kind === 'invokes').length
  console.log(root.split('/').pop() + ': ' + [
    g.files.length + ' files',
    g.nodes.length + ' nodes',
    g.edges.length + ' edges',
    g.anchors.length + ' anchors',
    litEdges + ' join-edges',
    callEdges + ' call-edges',
    ms.toFixed(0) + 'ms build',
  ].join(', '))
  resetSessions()
  const t1 = performance.now()
  const s = await withFoveaRuntime(runtime, () => sketch(runtime.processRoot, 400))
  console.log('  sketch: ' + s.tokens + ' tok, ' + (performance.now() - t1).toFixed(0) + 'ms, groups in body: ' + s.text.split('\n').length)
}
