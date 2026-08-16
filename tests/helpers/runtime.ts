import { NodeFoveaRuntime } from '../../src/node-runtime.js'
import { withFoveaRuntime } from '../../src/runtime.js'

/** Run core operations against the standalone Node capability adapter. */
export async function inNodeRuntime<T>(
  root: string,
  operation: (processRoot: string, runtime: NodeFoveaRuntime) => Promise<T> | T,
  scopeKey = 'test',
): Promise<T> {
  const runtime = new NodeFoveaRuntime(root, { scopeKey })
  return withFoveaRuntime(runtime, () => operation(runtime.processRoot, runtime))
}
