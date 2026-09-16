// Runs the generated suite through Vitest's Node API with pool: "threads" and maxWorkers: 1 -- the same invocation shape @stryker-mutator/vitest-runner uses, and the one that crashes. No Stryker involved.
process.env.NODE_ENV = "test";
process.env.VITEST = "1";

import { createVitest } from "vitest/node";
import { glob } from "node:fs/promises";
import path from "node:path";

const files = [];
for await (const entry of glob("test/**/*.test.ts")) {
  files.push(path.resolve(entry));
}
console.log(`Running ${files.length} test files under pool: "threads", maxWorkers: 1`);

const ctx = await createVitest("test", {
  config: "vitest.config.ts",
  pool: "threads",
  maxWorkers: 1,
  coverage: { enabled: false },
  watch: false,
});

const specs = await ctx.globTestSpecifications(files);
console.log(`Resolved ${specs.length} test specifications`);
try {
  await ctx.runTestSpecifications(specs);
} catch (error) {
  // A JS-level error surfacing here (as opposed to the process dying with SIGSEGV, which bypasses this entirely) is not the bug this repro targets -- report it but don't treat it as a false "clean pass".
  console.error("Non-crash error during the run (not the SIGSEGV under test):", error);
}
await ctx.close();
console.log("Completed without crashing.");
// See the matching comment in repro-forks.mjs: Vitest's own reporter can set a nonzero process.exitCode internally, unrelated to whether the process crashed. Reaching this line at all already means it didn't (a real SIGSEGV never returns control to JS), so force success rather than let that internal state read as a false "reproduced" signal.
process.exitCode = 0;
