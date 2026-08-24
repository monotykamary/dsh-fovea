import type { Context } from '@monotykamary/cordis'
import type {} from '@monotykamary/dsh-skill'
import type { GrepMode } from './core/config.js'

export const FOVEA_SKILL = `# Fovea repository intelligence

Fovea builds a typed, weighted repository graph and reveals only the neighborhood relevant to the current task.

## Choose the operation

- **fovea_sketch** — start here in an unfamiliar repository. It returns feature basins, route density, hubs, and honest extraction coverage.
- **fovea_focus** — investigate a symbol, route, concept, or file. Prefer this over broad text search when the question is structural: callers, imports, tests, routes, inheritance, or shared feature anchors.
- **fovea_dwell** — widen the current focus without repeating already disclosed periphery. Use it when the first focus is useful but too narrow.
- **fovea_impact** — estimate blast radius and review order for edits, uncommitted work, changed symbols, or a base-ref diff.

## Working pattern

1. Sketch once if the repository is unfamiliar.
2. Focus on the most concrete task noun: exact symbol, route path, or repository-relative file.
3. Read the suggested source windows returned in structured details.
4. Dwell only when adjacent context is still missing.
5. Before finishing a multi-file change, run impact for the touched files.

Fovea is complementary to grep and file reads: use graph navigation to decide **where and why**, then use exact text tools to inspect **what**. Treat extraction warnings as coverage limits rather than evidence that a feature is absent. Continuous sync may inject a repository-change notice between steps; account for it before continuing.
`

const GREP_NOTE: Record<GrepMode, string> = {
  off: '',
  replace: '- **grep** — bare symbol queries navigate the same Fovea graph with native text fallback; regular expressions and path/include calls stay native text search.\n',
  augment: '- **grep** — native results for bare symbol queries gain an appended Fovea graph section.\n',
}

export function registerFoveaSkill(ctx: Context, grepMode: GrepMode = 'augment'): void {
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.skills.register({
      name: 'fovea',
      description: 'Navigate repository structure, focus semantic neighborhoods, and estimate change impact with Fovea.',
      whenToUse: 'Use for unfamiliar repositories, cross-file dependency questions, routes and handlers, test discovery, or blast-radius review.',
      source: 'runtime',
      content: FOVEA_SKILL.replace('\n## Working pattern', `\n${GREP_NOTE[grepMode]}\n## Working pattern`),
    })
  })
}
