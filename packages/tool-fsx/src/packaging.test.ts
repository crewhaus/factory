/**
 * Test-only fixture modules are not compiled into dist, so they are not
 * published (C176). `tsconfig.base.json` excludes only `*.test.ts`, and a
 * package tsconfig that sets `exclude` replaces the base's list, so this
 * package's own list carries the test patterns and the fixture module.
 */
import { expect, test } from "bun:test";
import * as path from "node:path";
import ts from "typescript";

test("the build compiles the package's sources, and neither its tests nor archive-fixtures.ts", () => {
  const configPath = path.join(import.meta.dir, "..", "tsconfig.json");
  const parsed = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (parsed === undefined) throw new Error("tsconfig.json did not parse");
  const names = parsed.fileNames.map((f) => path.relative(path.join(import.meta.dir, ".."), f));
  expect(names).toContain("src/index.ts");
  expect(names.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
  expect(names.filter((f) => f.endsWith("archive-fixtures.ts"))).toEqual([]);
});
