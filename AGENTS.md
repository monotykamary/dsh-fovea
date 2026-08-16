# AGENTS.md

## Golden rule: check when done

```sh
pnpm run check
```

Runs typecheck + the full vitest suite + the npm-package verifier. It builds the
publishable `lib/` bundle first, so a green check means the change ships.
`packages/*` peers come from the installed DeepSeek Harness workspace; a local
re-install uses `pnpm run install:local`.

## What this repository is

dsh-fovea is a native DeepSeek Harness plugin that adapts the pi-fovea engine to
the Harness execution world. The engine under `src/core/` is a port of
pi-fovea and stays a pure function of repository content. `src/runtime.ts`,
`src/node-runtime.ts`, and `src/dsh-runtime.ts` are the only places that
touch filesystems or subprocesses, so Harness never bypasses its own execution
world. `tests/isolation.test.ts` enforces that boundary.

## Cache invalidation

Extraction facts live in the active runtime's cache store (DSH cache service;
standalone runs use `$TMPDIR/dsh-fovea-cache`), keyed by content sha1 +
`CACHE_VERSION` + rules hash. Co-change pairs cache by HEAD + tracked-file set.

If you change *extractor semantics* (what a parser emits for unchanged file
content), bump `CACHE_VERSION` in `src/core/build.ts` or stale test facts
linger.

## Conventions

- Vitest covers the same scenarios as pi-fovea — diffusion core against an
  independent scaled-Taylor reference, extractors and joins on
  `tests/fixtures/mini` (cross-language monorepo: Go server + TS client +
  OpenAPI + Python worker), budget conformance, and turn-sync verdicts — plus
  the DSH surface: plugin registration, agent/lineage isolation, real DSH
  fs/subprocess/spill integration, provenance attribution, installer, and
  packaging.
- Budget assertions use `tokens <= B` exactly; the renderer's prefix-fit loop
  must stay monotonic in the candidate prefix.
- Conventional commits: `feat(scope): ...`, `fix(scope): ...`.
- Runtime deps stay at `@ast-grep/cli` (the packaged parser); everything else
  is peer/dev. Heavy deps belong in devDependencies.
- `pnpm run check` never touches git; `lib/` is build output and stays
  ignored.
