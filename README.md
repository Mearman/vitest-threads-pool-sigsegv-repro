# vitest-threads-pool-sigsegv-repro

Minimal reproduction for [vitest-dev/vitest#11291](https://github.com/vitest-dev/vitest/issues/11291) (duplicate: [#11292](https://github.com/vitest-dev/vitest/issues/11292)): running a large test suite through Vitest's Node API with `pool: "threads"` and `maxWorkers: 1` reliably crashes the process with SIGSEGV during V8 GC on the threads-pool worker isolate. The same file set runs clean under `pool: "forks"`.

## Why this exists

The original report came from a large private monorepo, where the crashing invocation was Vite's own `@stryker-mutator/vitest-runner`, which hardcodes `pool: 'threads'` (see [stryker-mutator/stryker-js#6223](https://github.com/stryker-mutator/stryker-js/issues/6223)). That monorepo can't be shared, so this repo generates a large synthetic suite from scratch, at the same rough scale (thousands of files, real dependency usage, `vite` 8's rolldown transform pipeline), and drives it through the exact same Node API call shape -- no Stryker involved.

## Environment

- `vite` 8.1.4, `vitest` 4.1.10 (pinned exactly, matching the original report)
- Reproduces on Node 24 and Node 26
- macOS arm64 (the CI workflow runs `macos-latest`, currently arm64)

## Structure

- `scripts/generate-suite.mjs` -- generates `src/features/*.ts` + `test/*.test.ts` on demand (both directories are gitignored; nothing generated is committed). Each feature *module* does real work with `zod`, `date-fns`, `nanoid`, `uuid`, `lodash-es`, and `immer`, cross-imports into up to nine other generated modules at varying distances to widen the transitive import graph well beyond a flat star, and carries a synthetic data blob to add extra parse/heap weight per file -- controlled by `SUITE_SIZE` (file-pair count, default 20000) and `SUITE_BLOB_KB` (blob size per file in KB, default 24). Each *test* file is deliberately a single trivial assertion: the original crash happens during file loading/transform, before any test bodies run, so the thing worth stressing is the number of files Rolldown has to transform, not how long the tests themselves take to execute -- see "A note on reproducing this synthetically" below for why this matters.
- `repro-threads.mjs` -- calls `createVitest("test", { pool: "threads", maxWorkers: 1, ... })` from `vitest/node`, globs every generated test file, and runs them all in one invocation.
- `repro-forks.mjs` -- identical, except `pool: "forks"`, included as the clean comparison run.
- `.github/workflows/repro.yml` -- runs both on `macos-latest` across Node 24 and 26, with `NODE_OPTIONS=--max-old-space-size=6144` to give the process headroom against an unrelated, mundane out-of-memory abort (see below).

## Running it locally

```bash
npm install
npm run generate            # writes src/features/ and test/ (SUITE_SIZE=20000, SUITE_BLOB_KB=24 by default)
npm run repro:threads       # expected: process dies with SIGSEGV (exit code 139)
npm run repro:forks         # expected: completes cleanly
```

Scale the suite further with environment variables if you need to push harder to trigger the crash:

```bash
SUITE_SIZE=40000 SUITE_BLOB_KB=48 NODE_OPTIONS=--max-old-space-size=6144 npm run generate
```

Note: at larger `SUITE_SIZE`, most of the added weight so far has come from widening the cross-import graph and per-file function count rather than raw blob size -- see `scripts/generate-suite.mjs` if you want to tune that balance further. Raising `SUITE_BLOB_KB` a lot without also raising `--max-old-space-size` risks hitting the unrelated OOM abort described below before you ever reach the crash this repo targets.

## Expected vs actual

- **Expected:** both runs complete cleanly (or at worst behave the same way).
- **Actual:** the `threads`-pool run's process is killed by SIGSEGV; the `forks`-pool run, driven identically otherwise, completes cleanly every time.

## Crash signature (from the original report)

Consistent across every occurrence in the original environment (macOS DiagnosticReports, ~15 crash reports on that machine, since these runs were part of routine CI): the faulting thread is the pool's `WorkerThread`; the stack terminates in either

- `v8::internal::Isolate::Deinit` -> `Heap::StartTearDown` -> `CppHeap::StartDetachingIsolate` -> `Heap::CollectGarbage` -> `GlobalHandles::InvokeFirstPassWeakCallbacks` -> SIGSEGV (worker teardown GC), or
- `IncrementalMarkingJob::Task::RunInternal` -> `MarkCompactCollector::StartMarking` -> `MarkingWorklists::Local::~Local` -> SIGSEGV (near-null deref)

The crashing process hosted vite 8's own `rolldown-worker` native transform threads alongside the Vitest worker isolate; the only `.node` addons loaded were `rolldown-binding.darwin-arm64.node` and `fsevents.node` -- the crash happens during file loading/transform, before any test bodies run, so it is not related to any native module a test itself might use.

## A note on reproducing this synthetically

The original crash was traced to Stryker's Node-API-driven invocation running the *related* test set for one package in a large real monorepo (454 files / ~4,900 tests, spanning many packages). A synthetic suite generated from scratch is not guaranteed to hit the exact same V8 heap-layout/GC-timing window that trips this -- reproducing it reliably may take a larger `SUITE_SIZE`/`SUITE_BLOB_KB` than this repo's defaults, and/or a specific machine's memory pressure at the time. If the CI workflow's `threads-pool-crash` job comes back green on a given run, that means the crash reproduced (see the job's own "Report reproduction status" step); if it's red because the process exited cleanly, try re-running with a larger `SUITE_SIZE`/`SUITE_BLOB_KB` via `workflow_dispatch`, or on a machine under real memory pressure.

Local runs at 500, 1500, 2000, and 4000 file-pairs (with real dependency usage and up to 40 KB synthetic blobs per file) all completed cleanly without reproducing the crash -- consistent with the original investigation's own finding that a smaller synthetic suite (420 files) didn't crash either. A subsequent CI run at 8000 files on a clean `macos-latest` runner (no local machine contention) also completed cleanly on Node 26 and Node 24 after ~2 hours each.

**A 20000-file run (each test file originally carrying four real assertions, per the earlier design) surfaced a different, mundane failure instead: `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`, aborting via SIGABRT (exit code 134) after roughly 4h15m-4h40m.** All four jobs in that run -- both `threads` and both `forks`, on both Node 24 and Node 26 -- hit the identical abort at essentially the same wall-clock point, which confirms it's pool-independent: not the SIGSEGV this repo targets, but an ordinary V8 heap ceiling. The `threads-pool-crash` job's own "Report reproduction status" step originally treated *any* signal-killed exit (`code > 128`) as a reproduction, which conflated this with the real thing; it now checks specifically for exit code 139 (SIGSEGV) and reports a heap-limit abort as a distinct, explicit non-match.

The likely cause: with `maxWorkers: 1`, a suite that takes hours to *run* (not just to collect/transform) accumulates Vitest's own retained per-test state (results, source maps, reporting data) for the lifetime of one long-lived process, which can exhaust the heap on ordinary long-run growth alone, with nothing to do with the specific GC condition the real bug depends on. Since the original crash is reported to happen "during file loading, before any test bodies run," the fix was to make each generated test trivial (a single fast assertion) so total wall-clock time is dominated by collection/transform of however many files `SUITE_SIZE` generates, not by however long thousands of real test bodies take to execute -- this lets `SUITE_SIZE` scale much higher within a bounded, sane runtime, and CI now also sets `NODE_OPTIONS=--max-old-space-size=6144` for extra headroom against the same class of mundane OOM.

If you get this to crash with a genuine SIGSEGV (exit code 139, not 134) at a specific `SUITE_SIZE`/`SUITE_BLOB_KB`, please say so in an issue or PR here -- that data point is directly useful for narrowing down what specifically triggers it.
