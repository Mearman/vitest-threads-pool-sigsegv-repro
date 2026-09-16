// Generates a large synthetic test suite that mirrors the shape of the real-world suite that triggers the crash: many files, each with real dependency usage and non-trivial logic for Rolldown to transform, each exercised by its own test file, with some cross-imports between feature modules to broaden the transitive graph beyond a flat star shape.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const count = Number(process.env.SUITE_SIZE ?? 20000);
const blobSizeKb = Number(process.env.SUITE_BLOB_KB ?? 24);

function randomBlob(sizeKb) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const target = sizeKb * 1024;
  let out = "";
  while (out.length < target) {
    let line = "";
    for (let i = 0; i < 120; i++) line += chars[Math.floor(Math.random() * chars.length)];
    out += line;
  }
  return out.slice(0, target);
}

const srcDir = path.join(root, "src", "features");
const testDir = path.join(root, "test");

rmSync(srcDir, { recursive: true, force: true });
rmSync(testDir, { recursive: true, force: true });
mkdirSync(srcDir, { recursive: true });
mkdirSync(testDir, { recursive: true });

writeFileSync(
  path.join(root, "src", "shared.ts"),
  `import { z } from "zod";
import { produce } from "immer";

export const RecordSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  weight: z.number().nonnegative(),
  tags: z.array(z.string()).default([]),
});

export type Record = z.infer<typeof RecordSchema>;

export function score(record: Record): number {
  return record.weight * (1 + record.tags.length) + record.label.length;
}

export function merge(a: Record, b: Record): Record {
  return RecordSchema.parse({
    id: \`\${a.id}:\${b.id}\`,
    label: \`\${a.label} + \${b.label}\`,
    weight: a.weight + b.weight,
    tags: [...new Set([...a.tags, ...b.tags])],
  });
}

export function bump(record: Record, delta: number): Record {
  return produce(record, (draft) => {
    draft.weight += delta;
  });
}
`,
);

function capitalize(value) {
  return value[0].toUpperCase() + value.slice(1);
}

for (let i = 0; i < count; i++) {
  const name = `feature${String(i).padStart(5, "0")}`;
  // Every module also imports a couple of earlier modules (when they exist) to widen the transitive import graph beyond a flat star of independent leaves.
  const crossImports = [];
  if (i > 1) crossImports.push(i - 1);
  if (i > 10) crossImports.push(i - 10);
  if (i > 50) crossImports.push(i - 50);
  if (i > 200) crossImports.push(i - 200);
  if (i > 500) crossImports.push(i - 500);
  if (i > 2000) crossImports.push(i - 2000);
  if (i > 5000) crossImports.push(i - 5000);
  if (i > 10000) crossImports.push(i - 10000);
  if (i > 15000) crossImports.push(i - 15000);
  const crossImportLines = crossImports
    .map((j) => {
      const dep = `feature${String(j).padStart(5, "0")}`;
      return `import { rank${capitalize(dep)} } from "./${dep}.js";`;
    })
    .join("\n");
  const crossCallLines = crossImports
    .map((j) => {
      const dep = `feature${String(j).padStart(5, "0")}`;
      return `rank${capitalize(dep)}(input as never).length;`;
    })
    .join("\n  ");

  const src = `import { z } from "zod";
import { addDays, formatISO, differenceInCalendarDays } from "date-fns";
import { nanoid } from "nanoid";
import { v4 as uuidv4 } from "uuid";
import { chunk, uniqBy } from "lodash-es";
import { produce } from "immer";
import { RecordSchema, score, merge, bump, type Record } from "../shared.js";
${crossImportLines}

// Inflates parse/transform + heap weight for this module, mirroring how much larger a real-world source file's combined literal/config/fixture data tends to be.
const ${name}Blob = "${randomBlob(blobSizeKb)}";
export const ${name}BlobLength = ${name}Blob.length;

export const ${name}Schema = z.object({
  id: z.string().default(() => nanoid()),
  correlationId: z.string().default(() => uuidv4()),
  createdAt: z.string().default(() => formatISO(new Date())),
  base: RecordSchema,
  variants: z.array(RecordSchema).min(1),
});

export type ${capitalize(name)}Input = z.infer<typeof ${name}Schema>;

export function build${capitalize(name)}(input: unknown): ${capitalize(name)}Input {
  return ${name}Schema.parse(input);
}

export function rank${capitalize(name)}(input: ${capitalize(name)}Input): Record[] {
  const merged = uniqBy(
    input.variants.map((variant) => merge(input.base, variant)),
    (record) => record.id,
  );
  return merged.sort((a, b) => score(b) - score(a));
}

export function batch${capitalize(name)}(input: ${capitalize(name)}Input, size: number): Record[][] {
  const ranked = rank${capitalize(name)}(input);
  return chunk(ranked, size).map((group) => group.map((record) => bump(record, 1)));
}

export function expiryOf(input: ${capitalize(name)}Input, days: number): string {
  return formatISO(addDays(new Date(input.createdAt), days));
}

export function daysUntilExpiry(input: ${capitalize(name)}Input, days: number): number {
  return differenceInCalendarDays(new Date(expiryOf(input, days)), new Date());
}

export const ${name}Reducer = produce((draft: { total: number }, delta: number) => {
  draft.total += delta;
});

export function filterByTag(records: Record[], tag: string): Record[] {
  return records.filter((record) => record.tags.includes(tag));
}

export function groupByTag(records: Record[]): Map<string, Record[]> {
  const groups = new Map<string, Record[]>();
  for (const record of records) {
    for (const tag of record.tags) {
      const existing = groups.get(tag) ?? [];
      existing.push(record);
      groups.set(tag, existing);
    }
  }
  return groups;
}

export function totalWeight(records: Record[]): number {
  return records.reduce((total, record) => total + record.weight, 0);
}

export function averageScore(records: Record[]): number {
  if (records.length === 0) return 0;
  return records.reduce((total, record) => total + score(record), 0) / records.length;
}

export function topN(records: Record[], n: number): Record[] {
  return [...records].sort((a, b) => score(b) - score(a)).slice(0, n);
}

export function validateAll(inputs: unknown[]): ${capitalize(name)}Input[] {
  return inputs.map((input) => build${capitalize(name)}(input));
}

export function withCorrelationId(input: ${capitalize(name)}Input, id: string): ${capitalize(name)}Input {
  return { ...input, correlationId: id };
}
`;

  // Deliberately one trivial test per file: the original crash happens during file loading/transform, before any test bodies run, so total test *execution* time isn't what matters here -- the number of files rolldown has to transform is. A suite whose tests take hours to run risks hitting an unrelated, mundane "JavaScript heap out of memory" abort from ordinary long-run accumulation (Vitest's own retained test-result/reporting state) long before it ever reaches whatever GC condition the real bug depends on. Keeping each test fast keeps total wall-clock time bounded by collection/transform, not by however many thousands of tests there are.
  const test = `import { expect, it } from "vitest";
import { build${capitalize(name)} } from "../src/features/${name}.js";

it("${name} builds", () => {
  expect(build${capitalize(name)}({ base: { id: "b", label: "l", weight: 1, tags: [] }, variants: [{ id: "v", label: "l", weight: 1, tags: [] }] }).variants).toHaveLength(1);
});
`;

  writeFileSync(path.join(srcDir, `${name}.ts`), src);
  writeFileSync(path.join(testDir, `${name}.test.ts`), test);
}

console.log(`Generated ${count} feature modules + ${count} test files under src/features and test/.`);
