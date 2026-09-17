# vitest-threads-pool-sigsegv-repro

Minimal reproduction for [vitest-dev/vitest#11291](https://github.com/vitest-dev/vitest/issues/11291) (duplicate: [#11292](https://github.com/vitest-dev/vitest/issues/11292)): running a large test suite through Vitest's Node API with `pool: "threads"` and `maxWorkers: 1` reliably crashes the process with SIGSEGV during V8 GC on the threads-pool worker isolate. The same file set runs clean under `pool: "forks"`.

## Why this exists

The original report came from a large private monorepo, where the crashing invocation was Vite's own `@stryker-mutator/vitest-runner`, which hardcodes `pool: 'threads'` (see [stryker-mutator/stryker-js#6223](https://github.com/stryker-mutator/stryker-js/issues/6223)). That monorepo can't be shared, so this repo generates a large synthetic pnpm workspace from scratch and drives it through the exact same Node API call shape -- no Stryker involved.

## Environment

- `vite` 8.1.4, `vitest` 4.1.10 (pinned exactly, matching the original report)
- pnpm 10.33.0 (matching the original monorepo's own package manager -- see "Why a pnpm workspace, not a flat file tree" below)
- Reproduces on Node 24 and Node 26
- macOS arm64 (the CI workflow runs `macos-latest`, currently arm64)

## Structure

- `pnpm-workspace.yaml` -- this repo is a real pnpm workspace, not a single package.
- `scripts/generate-workspace.mjs` -- generates `packages/pkgNNNN/` on demand (gitignored; nothing generated is committed). Each package is its own `package.json` (`@synth/pkgNNNN`), resolved through pnpm's symlinked `node_modules` and a package.json `exports` map pointing straight at TypeScript source (no build step), the same way the original monorepo's own internal packages are resolved. Each package uses a real, moderately heavy external dependency in rotation -- `drizzle-orm` + `better-sqlite3`, `zod` + `@orpc/client`/`@orpc/server`, `@electric-sql/pglite`, or a `zod` + `drizzle-orm` mix -- and cross-imports 1-2 other generated packages via `workspace:*` to build a real, resolvable dependency graph rather than a flat star. Controlled by `WORKSPACE_SIZE` (package count, default 300) and `TESTS_PER_PACKAGE` (test cases per package, default 15).
- `repro-threads.mjs` -- calls `createVitest("test", { pool: "threads", maxWorkers: 1, ... })` from `vitest/node`, globs every generated package's test file, and runs them all in one invocation.
- `repro-forks.mjs` -- identical, except `pool: "forks"`, included as the clean comparison run.
- `.github/workflows/repro.yml` -- runs both on `macos-latest` across Node 24 and 26, with `NODE_OPTIONS=--max-old-space-size=6144` for headroom against an unrelated, mundane out-of-memory abort (see below).

## Why a pnpm workspace, not a flat file tree

The first version of this repo generated a large number of files inside one flat package (up to 20000), with a shallow ~6-package dependency surface (`zod`, `date-fns`, `nanoid`, `uuid`, `lodash-es`, `immer`). That never reproduced the crash, at any scale tried -- see "Prior attempts" below.

Going back to the actual related-file set the original crash was triggered against (reconstructed via `npx vitest related --run --reporter=json --outputFile=related.json <mutated-package>/src/*.ts`, the same command the original report used) showed a structurally different shape: 454 test files pull in **61 distinct internal workspace packages** and a handful of genuinely heavy external dependencies -- an ORM (`drizzle-orm`), a WASM-backed embedded database (`@electric-sql/pglite`), a typed RPC framework (`@orpc/client`/`@orpc/server`), plus `zod`, `wrangler`'s type surface, and the Vercel AI SDK's provider types. Average test file size in the real set was ~13.8 KB (up to 48 KB), not a handful of lines. That's a real multi-package pnpm workspace, resolved through pnpm's own symlinked `node_modules` and each package's `exports` map -- not a large flat file count in a single package.

This version tests that structural hypothesis directly: many small real packages, cross-importing each other through the exact resolution mechanism (pnpm workspace symlinks + `exports` maps) the original crash's dependency graph actually used, using real (if smaller-scale) versions of the same class of heavy dependencies.

## Running it locally

```bash
pnpm run generate           # writes packages/pkgNNNN/ (WORKSPACE_SIZE=300, TESTS_PER_PACKAGE=15 by default) -- pure Node, no install needed first
pnpm install --no-frozen-lockfile   # resolves root + every generated package's deps, including workspace:* cross-refs
pnpm run repro:threads       # expected: process dies with SIGSEGV (exit code 139)
pnpm run repro:forks         # expected: completes cleanly
```

`--no-frozen-lockfile` is required here: the generated package set (and therefore the lockfile) changes with `WORKSPACE_SIZE`/`TESTS_PER_PACKAGE`, so a lockfile committed for one size will never exactly match a different size.

Scale further with environment variables if you need to push harder:

```bash
WORKSPACE_SIZE=600 TESTS_PER_PACKAGE=20 NODE_OPTIONS=--max-old-space-size=6144 pnpm run generate && pnpm install --no-frozen-lockfile
```

## Expected vs actual

- **Expected:** both runs complete cleanly (or at worst behave the same way).
- **Actual:** the `threads`-pool run's process is killed by SIGSEGV; the `forks`-pool run, driven identically otherwise, completes cleanly every time.

## Crash signature (from the original report)

Consistent across every occurrence in the original environment (macOS DiagnosticReports, dozens of real crash reports on that machine going back several days, independently parsed and confirmed): the faulting thread is a `node::worker::Worker`; the stack terminates in either

- `v8::internal::Isolate::Deinit` -> `Heap::StartTearDown` -> `CppHeap::StartDetachingIsolate` -> `Heap::CollectGarbage` -> `GlobalHandles::InvokeFirstPassWeakCallbacks` -> SIGSEGV (worker teardown GC), or
- `IncrementalMarkingJob::Task::RunInternal` -> `MarkCompactCollector::StartMarking` -> `MarkingWorklists::Local::~Local` -> SIGSEGV (near-null deref)

The crashing process hosted vite 8's own `rolldown-worker` native transform threads alongside the Vitest worker isolate; the only `.node` addons loaded were `rolldown-binding.darwin-arm64.node` and `fsevents.node` -- no database driver of any kind -- so the crash happens during file loading/transform, before any test bodies run, and is not related to any native module a test itself might use.

**A caveat worth stating plainly:** the original report's Environment section also states the crash was "also seen on GitHub Actions arm64 macOS runners." That specific claim has no supporting evidence behind it -- every confirmed crash report traces back to one physical machine's own local diagnostic logs, not any CI system, and the monorepo the crash originated in runs its own CI exclusively on Linux runners. Treat that one sentence in the original report as unverified.

## Prior attempts (flat-file design)

Before this pnpm-workspace version, a flat single-package design was tried extensively and never reproduced the SIGSEGV, at any scale:

- Local runs at 500, 1500, 2000, and 4000 file-pairs (real dependency usage, up to 40 KB synthetic data blobs per file) all completed cleanly -- consistent with the original investigation's own finding that a 420-file synthetic suite didn't crash either.
- A CI run at 8000 files on a clean `macos-latest` runner also completed cleanly on both Node 24 and Node 26, in ~2 hours each.
- A 20000-file run (44x the real trigger set's file count) surfaced a different, mundane failure instead: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` (SIGABRT, exit code 134) after 2-4.5 hours, hitting all four pool/Node combinations at nearly the same wall-clock point -- an ordinary V8 heap ceiling from Vitest's own retained per-test state over a very long-running process, unrelated to the SIGSEGV this repo targets. Fixed by making generated tests trivial (a single fast assertion each, since the real crash is reported to happen during collection/transform, before test bodies run) and raising `NODE_OPTIONS=--max-old-space-size`; a subsequent 20000-file run with that fix completed with no crash of any kind.
- Across every one of these, the CI workflow's own reproduction check had a real bug: it treated *any* signal-killed exit (`code > 128`) as a match, conflating the SIGSEGV (139) this repo targets with the unrelated OOM abort (134) above. Fixed to check specifically for exit code 139.

The consistent result across every flat-file scale tried, up to 44x the real trigger set's file count, is what motivated the structural rework above: raw file count in one package clearly isn't the dominant factor, so this version tests dependency-graph shape and cross-package resolution complexity instead.

If you get this to crash with a genuine SIGSEGV (exit code 139, not 134) at a specific `WORKSPACE_SIZE`/`TESTS_PER_PACKAGE`, please say so in an issue or PR here -- that data point is directly useful for narrowing down what specifically triggers it.
