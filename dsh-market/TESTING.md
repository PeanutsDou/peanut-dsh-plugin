# Testing

Four layers, mirroring the deepseek-harness conventions — everything runs on
vitest; playwright is used as a library, never as a separate runner.

| Layer | What | Where | Command | CI |
|---|---|---|---|---|
| 1. Behavioral specs | Pure/orchestration logic against real tmp-dir fixtures; flow suite drives every HTTP route through a programmable FakeDsh (real filesystem effects, scriptable npm state — update logic is testable **without publishing versions**) | `tests/*.spec.ts` | `npm test` | every push, ubuntu + windows |
| 2. Component specs | `// @vitest-environment jsdom` + testing-library against the REAL TSX components, REAL locale dicts, and the npm-published `@deepseek-ai/dsh-client-ui-primitives` | `tests/client/*.client.spec.tsx` | `npm test` (same lane) | every push |
| 3. Web e2e | A REAL dsh web composition booted in a throwaway `DSH_HOME` with the packed market installed, driven by real Chromium; console tripwire fails the run on any page error | `tests/web/*.e2e.ts` + `tests/web/scaffold.ts` | `npm run test:web` | own job |
| 4. Perimeter | Real pnpm 9/10/11 behavior matrix (pins the failure signatures behind #20/#21/#22) and the packaging/restart smoke scripts | `tests/*.compat.spec.ts`, `scripts/*.mjs` | `npm run test:compat`, `npm run check` | own job / in check |

## Running layer 3 locally

The scaffold needs a dsh CLI. Either have `dsh` on PATH, or point it at a
source checkout:

```sh
DSHM_E2E_DSH="node --import tsx/esm /path/to/deepseek-harness/apps/cli/src/bin.ts" \
DSHM_E2E_DSH_CWD=/path/to/deepseek-harness \
npm run test:web
```

Without a reachable dsh the e2e specs skip (they never fail a machine that
cannot run them). Browser download can use a mirror:
`PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium`.

## Conventions

- **Red first**: a bug fix lands with the failing test that reproduces it.
  Every issue number in a test title is a reproduced-then-fixed incident.
- **Mutation-audited**: the suites have been checked with targeted mutations
  (every mutation must kill ≥1 test; every test must be killable). Keep new
  tests killable — no assertion that can be satisfied by a fallback path.
- **Fake pnpm never invents behavior**: everything FakeDsh simulates is a
  signature pinned by the real-pnpm compat lane first.
