import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { scanImportGraph } from "./__test__/checkers.js";

const SRC = import.meta.dir;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__test__" ? [] : sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the main entry", () => {
  const graph = scanImportGraph(join(SRC, "index.ts"));

  test("imports nothing but its own relative .js files", () => {
    expect(graph.problems).toEqual([]);
  });

  test("reaches every source file outside ./schemas, and none inside it", () => {
    const expected = sourceFiles(SRC)
      .filter((file) => !relative(SRC, file).startsWith("schemas"))
      .sort();
    expect(graph.files).toEqual(expected);
    expect(graph.files.length).toBeGreaterThanOrEqual(30);
  });

  test("only src/schemas imports zod, and the manifest declares only zod", () => {
    const zodImporters = sourceFiles(SRC)
      .filter((file) => /from "zod"/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC, file))
      .sort();
    expect(zodImporters).toEqual([
      "schemas/areas.ts",
      "schemas/core.ts",
      "schemas/index.ts",
      "schemas/type-checks.ts",
    ]);
    const manifest = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ zod: "^3.23.8" });
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      "./schemas": "./src/schemas/index.ts",
    });
  });
});

describe("the scan sees a planted defect", () => {
  const dir = mkdtempSync(join(tmpdir(), "control-contract-graph-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function scan(name: string, source: string) {
    const root = join(dir, name);
    mkdirSync(root);
    writeFileSync(join(root, "index.ts"), source);
    return scanImportGraph(join(root, "index.ts")).problems;
  }

  test("a node: import", () => {
    expect(
      scan("node", 'import { randomBytes } from "node:crypto";\nexport const a = randomBytes;\n'),
    ).toEqual(['index.ts: imports the package or builtin "node:crypto"']);
  });
  test("an import type from a package", () => {
    expect(scan("type", 'import type { z } from "zod";\nexport type A = z.ZodTypeAny;\n')).toEqual([
      'index.ts: imports the package or builtin "zod"',
    ]);
  });
  test("an extensionless import", () => {
    expect(scan("bare", 'export { a } from "./other";\n')).toEqual([
      'index.ts: extensionless import "./other"',
    ]);
  });
  test("reaching ./schemas", () => {
    expect(scan("schemas", 'export * from "./schemas/index.js";\n')).toEqual([
      'index.ts: imports ./schemas through "./schemas/index.js"',
    ]);
  });
  test("each runtime global, in code and not in a comment", () => {
    expect(
      scan(
        "globals",
        "export const a = Buffer.from(process.env.X ?? '');\nexport const b = Bun.file('x');\nexport const c = require('x');\n",
      ),
    ).toEqual([
      "index.ts: uses Buffer",
      "index.ts: uses process.",
      "index.ts: uses Bun.",
      "index.ts: uses require(",
      'index.ts: imports the package or builtin "x"',
    ]);
    expect(
      scan(
        "comment",
        "// Buffer, process.env, Bun.file and require('x') are only words here.\nexport const a = 1;\n",
      ),
    ).toEqual([]);
  });
});
