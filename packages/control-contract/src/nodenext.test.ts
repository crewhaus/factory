import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { scanImportGraph } from "./__test__/checkers.js";

const OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: [],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};

function check(entry: string) {
  const program = ts.createProgram([entry], OPTIONS);
  const own = program.getSourceFiles().filter((file) => !file.isDeclarationFile);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map(
      (d) => `${d.file?.fileName ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    );
  return { files: own.length, diagnostics };
}

describe("the main entry type-checks as NodeNext, with no Bun types", () => {
  test("no diagnostics over the whole graph", () => {
    const entry = join(import.meta.dir, "index.ts");
    const { files, diagnostics } = check(entry);
    expect(diagnostics).toEqual([]);
    expect(files).toBe(scanImportGraph(entry).files.length);
    expect(files).toBeGreaterThanOrEqual(30);
  }, 20_000); // A full program check.
});

describe("the check sees a planted defect", () => {
  const dir = mkdtempSync(join(tmpdir(), "control-contract-nodenext-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function plant(name: string, source: string) {
    const root = join(dir, name);
    mkdirSync(root);
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "other.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "index.ts"), source);
    return check(join(root, "index.ts")).diagnostics.join("\n");
  }

  test("an extensionless import", () => {
    expect(plant("bare", 'export { a } from "./other";\n')).toContain("explicit file extensions");
  }, 20_000);

  test("Bun.file", () => {
    expect(plant("bun", 'export const f = Bun.file("x");\n')).toContain("Cannot find name 'Bun'");
  }, 20_000);

  test("a clean file has no diagnostics, so the two above are about the plant", () => {
    expect(plant("clean", 'export { a } from "./other.js";\n')).toBe("");
  }, 20_000);
});
