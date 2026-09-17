// Generates a real pnpm workspace of many small TypeScript packages, cross-importing each other via `workspace:*` and resolved through pnpm's symlinked node_modules + package.json `exports` maps -- rather than one flat directory of files. This mirrors the shape of the real crash trigger more closely than a flat-file suite does: the real related-file set for the crashing package pulls in 61 distinct internal workspace packages and a handful of genuinely heavy external dependencies (an ORM, a WASM-backed database, a typed-RPC framework), not just a large file count in one package. A flat suite of up to 20000 files with a shallow ~6-package dependency surface did not reproduce the crash; this tests whether cross-package resolution complexity and heavier real dependencies are the missing ingredient instead of raw file count.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const packageCount = Number(process.env.WORKSPACE_SIZE ?? 300);
const testsPerPackage = Number(process.env.TESTS_PER_PACKAGE ?? 15);

const packagesDir = path.join(root, "packages");
rmSync(packagesDir, { recursive: true, force: true });
mkdirSync(packagesDir, { recursive: true });

function capitalize(value) {
  return value[0].toUpperCase() + value.slice(1);
}

// Rotates through the real external dependencies the crashing package's related set actually pulls in, so packages vary in shape the way real ones do (not every workspace package uses every dependency).
const depKinds = ["drizzle", "zod-orpc", "pglite", "mixed"];

for (let i = 0; i < packageCount; i++) {
  const name = `pkg${String(i).padStart(4, "0")}`;
  const pkgDir = path.join(packagesDir, name);
  mkdirSync(path.join(pkgDir, "src"), { recursive: true });

  const crossDeps = [];
  if (i > 0) crossDeps.push(i - 1);
  if (i > 10) crossDeps.push(i - 10);
  const crossImportLines = crossDeps
    .map((j) => `import { describePkg${String(j).padStart(4, "0")} } from "@synth/pkg${String(j).padStart(4, "0")}";`)
    .join("\n");
  const crossUseLines = crossDeps
    .map((j) => `describePkg${String(j).padStart(4, "0")}();`)
    .join("\n  ");

  const kind = depKinds[i % depKinds.length];

  let deps = {};
  let src = "";

  if (kind === "drizzle") {
    deps = { "drizzle-orm": "^0.45.2", "better-sqlite3": "^13.0.3" };
    src = `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
${crossImportLines}

export const ${name}Table = sqliteTable("${name}", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  weight: integer("weight").notNull().default(0),
});

export function ${name}Db() {
  const sqlite = new Database(":memory:");
  return drizzle(sqlite);
}

export function ${name}Query(db: ReturnType<typeof ${name}Db>, id: number) {
  return db.select().from(${name}Table).where(eq(${name}Table.id, id));
}

export function describe${capitalize(name)}(): string {
  ${crossUseLines}
  return "${name}";
}
`;
  } else if (kind === "zod-orpc") {
    deps = { "zod": "^4.1.0", "@orpc/client": "^1.15.0", "@orpc/server": "^1.15.0" };
    src = `import { z } from "zod";
import { os } from "@orpc/server";
import type { RouterClient } from "@orpc/client";
${crossImportLines}

export const ${name}Schema = z.object({
  id: z.string(),
  label: z.string(),
  tags: z.array(z.string()).default([]),
});

export const ${name}Contract = os
  .input(${name}Schema)
  .output(z.object({ ok: z.boolean() }));

export const ${name}Router = {
  handle: ${name}Contract.handler(async ({ input }) => ({ ok: input.tags.length >= 0 })),
};

export type ${capitalize(name)}Client = RouterClient<typeof ${name}Router>;

export function describe${capitalize(name)}(): string {
  ${crossUseLines}
  return "${name}";
}
`;
  } else if (kind === "pglite") {
    deps = { "@electric-sql/pglite": "^0.5.8", "zod": "^4.1.0" };
    src = `import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
${crossImportLines}

export const ${name}RowSchema = z.object({
  id: z.number(),
  label: z.string(),
});

export function ${name}Client(): PGlite {
  return new PGlite();
}

export function describe${capitalize(name)}(): string {
  ${crossUseLines}
  return "${name}";
}
`;
  } else {
    deps = { "zod": "^4.1.0", "drizzle-orm": "^0.45.2" };
    src = `import { z } from "zod";
import { sql } from "drizzle-orm";
${crossImportLines}

export const ${name}Schema = z.object({
  id: z.string(),
  label: z.string().min(1),
  weight: z.number().nonnegative(),
});

export type ${capitalize(name)}Input = z.infer<typeof ${name}Schema>;

export function ${name}Fragment() {
  return sql\`select 1\`;
}

export function build${capitalize(name)}(input: unknown): ${capitalize(name)}Input {
  return ${name}Schema.parse(input);
}

export function describe${capitalize(name)}(): string {
  ${crossUseLines}
  return "${name}";
}
`;
  }

  const test = Array.from({ length: testsPerPackage }, (_, n) => `
it("${name} case ${n}", () => {
  expect(describe${capitalize(name)}()).toBe("${name}");
});`).join("\n");

  const testFile = `import { describe, expect, it } from "vitest";
import { describe${capitalize(name)} } from "./index.js";

describe("${name}", () => {${test}
});
`;

  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify(
      {
        name: `@synth/${name}`,
        version: "0.0.0",
        private: true,
        type: "module",
        exports: { ".": "./src/index.ts" },
        dependencies: {
          ...deps,
          ...(crossDeps.length > 0
            ? Object.fromEntries(crossDeps.map((j) => [`@synth/pkg${String(j).padStart(4, "0")}`, "workspace:*"]))
            : {}),
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(pkgDir, "src", "index.ts"), src);
  writeFileSync(path.join(pkgDir, "src", "index.test.ts"), testFile);
}

console.log(`Generated ${packageCount} workspace packages (@synth/pkg0000..pkg${String(packageCount - 1).padStart(4, "0")}) under packages/, ${testsPerPackage} tests each.`);
