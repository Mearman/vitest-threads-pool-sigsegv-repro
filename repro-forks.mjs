// Identical to repro-threads.mjs except for pool: "forks" -- included as the clean comparison run: same file set, same Node API call shape, only the pool differs.
process.env.NODE_ENV = "test";
process.env.VITEST = "1";

import { createVitest } from "vitest/node";
import { glob } from "node:fs/promises";
import path from "node:path";

const files = [];
for await (const entry of glob("packages/*/src/*.test.ts")) {
  files.push(path.resolve(entry));
}
console.log(`Running ${files.length} test files under pool: "forks", maxWorkers: 1`);

const ctx = await createVitest("test", {
  config: "vitest.config.ts",
  pool: "forks",
  maxWorkers: 1,
  coverage: { enabled: false },
  watch: false,
});

const specs = await ctx.globTestSpecifications(files);
console.log(`Resolved ${specs.length} test specifications`);
try {
  await ctx.runTestSpecifications(specs);
} catch (error) {
  console.error("Non-crash error during the run:", error);
}
await ctx.close();
console.log("Completed without crashing.");
// Vitest's own reporter can set a nonzero process.exitCode internally (a separate, pre-existing bug in its Node API reporting path) even when the run itself -- the thing this script exists to observe -- completed with no crash. Force success here so that unrelated internal state doesn't masquerade as "the crash happened".
process.exitCode = 0;
