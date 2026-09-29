/**
 * Test-only modules are not compiled into dist, so they are not published
 * (C176). 0.7.0's tsconfig.base.json excluded only `*.test.ts`, so seventeen
 * tool packages compiled their `fixtures.ts` into dist and every release
 * shipped them, tool-secrets' included, with its secret-shaped test keys. The
 * base now excludes `fixtures.ts`, `*-fixtures.ts`, `fixtures/` and
 * `__fixtures__/` as well.
 *
 * `exclude` only keeps a file out of the initial set: a module that non-test
 * source imports is compiled anyway. So this checks both halves, for every
 * workspace package found on disk (not listed): what each tsconfig selects,
 * and that no non-test source imports a test-only module.
 */
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import ts from "typescript";

const ROOT = path.dirname(import.meta.dir);

/** A module only tests may use, by its path inside the package. */
function isTestOnly(rel: string): boolean {
  const posix = rel.split(path.sep).join("/");
  return (
    /\.test\.tsx?$/.test(posix) ||
    /(^|\/)fixtures\.ts$/.test(posix) ||
    /-fixtures\.ts$/.test(posix) ||
    /(^|\/)(fixtures|__fixtures__)\//.test(posix)
  );
}

function packageDirs(): string[] {
  const out: string[] = [];
  for (const group of ["packages", "apps"]) {
    for (const entry of readdirSync(path.join(ROOT, group), { withFileTypes: true })) {
      const dir = path.join(ROOT, group, entry.name);
      if (entry.isDirectory() && existsSync(path.join(dir, "tsconfig.json"))) out.push(dir);
    }
  }
  return out;
}

test("the judge knows a test-only module when it sees one", () => {
  expect(isTestOnly("src/fixtures.ts")).toBe(true);
  expect(isTestOnly("src/archive-fixtures.ts")).toBe(true);
  expect(isTestOnly("src/__fixtures__/host-output.ts")).toBe(true);
  expect(isTestOnly("src/fixtures/build-chat-db.ts")).toBe(true);
  expect(isTestOnly("src/index.test.ts")).toBe(true);
  // A runtime module that merely has "fixture" in its name is not one.
  expect(isTestOnly("src/fixture.ts")).toBe(false);
  expect(isTestOnly("src/index.ts")).toBe(false);
});

test("no package's build selects a test or fixture module", () => {
  const selected: string[] = [];
  let fixtureModules = 0;
  const dirs = packageDirs();
  for (const dir of dirs) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      path.join(dir, "tsconfig.json"),
      {},
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    if (parsed === undefined) throw new Error(`${dir}/tsconfig.json did not parse`);
    for (const file of parsed.fileNames) {
      const rel = path.relative(dir, file);
      if (isTestOnly(rel)) selected.push(path.relative(ROOT, file));
    }
    const src = path.join(dir, "src");
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src, { recursive: true }) as string[]) {
      if (f.endsWith(".ts") && !/\.test\.tsx?$/.test(f) && isTestOnly(path.join("src", f))) {
        fixtureModules += 1;
      }
    }
  }
  expect(selected).toEqual([]);
  // Hit count: every package was read, and the fixture modules exist to be
  // excluded (tool-secrets alone has one).
  expect(dirs.length).toBeGreaterThan(250);
  expect(fixtureModules).toBeGreaterThanOrEqual(20);
});

test("no non-test source imports a test-only module, which would compile it anyway", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const dir of packageDirs()) {
    const src = path.join(dir, "src");
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src, { recursive: true }) as string[]) {
      const rel = path.join("src", f);
      if (!/\.tsx?$/.test(f) || isTestOnly(rel)) continue;
      scanned += 1;
      const text = readFileSync(path.join(dir, rel), "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const target = path.join(path.dirname(rel), m[1] ?? "");
        if (isTestOnly(target.replace(/\.js$/, ".ts")) || isTestOnly(`${target}.ts`)) {
          offenders.push(`${path.relative(ROOT, path.join(dir, rel))} imports ${m[1]}`);
        }
      }
    }
  }
  expect(offenders).toEqual([]);
  expect(scanned).toBeGreaterThan(1000);
});
