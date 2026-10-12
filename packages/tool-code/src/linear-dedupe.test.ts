/**
 * Four readers keep their "seen already?" answer in a set.
 *
 * Each checked a new item against every item it had kept so far, quadratic
 * in the items of one workspace input:
 *
 *   - `scanExports` (SymbolOutline) checked each `export default` against
 *     every export found before it, over a file of up to 2 MB;
 *   - `scanImports` (SymbolOutline, ImportGraph, DeadFileScan) checked each
 *     bare `import "x"` against every import found before it, over the same;
 *   - `buildImportGraph` (ImportGraph and the cycle tools) checked each
 *     import against the file's targets listed so far, and one file can
 *     import thousands of the 20,000 files a walk may visit;
 *   - DependencyList with `includeLocked` checked each locked version against
 *     the name's versions listed so far, and a lockfile can lock one name at
 *     thousands of versions.
 *
 * The results are the same, in the same order. The work is counted with
 * __test__/js-work.ts, which charges an array's `includes` for the whole
 * array and `some` for each element it visits, never timed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsWork, jsWorkAsync } from "./__test__/js-work";
import { dependencyList } from "./index";
import { type FileImports, buildImportGraph } from "./lib/graph";
import { scanExports, scanImports } from "./lib/scan";

const range = (k: number) => Array.from({ length: k }, (_, i) => i);

describe("scanExports lists one default a line, in one pass", () => {
  // About 1.6 a character here.
  const WORK_PER_CHARACTER = 4;

  test("a file of `export default` lines", () => {
    const rows = [4_000, 8_000].map((k) => {
      // Two defaults on every fourth line: still one record for that line.
      const text = range(k)
        .map((i) => (i % 4 === 0 ? "export default 1; export default 2;\n" : "export default 1;\n"))
        .join("");
      const run = jsWork(WORK_PER_CHARACTER * text.length, () => scanExports(text));
      return { k, text, run };
    });
    for (const { k, text, run } of rows) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * text.length);
      const lines = (run.value ?? []).map((e) => [e.kind, e.line]);
      expect(lines).toEqual(range(k).map((i) => ["default", i + 1]));
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("a default declaration and a default expression on one line make one record", () => {
    const text = "export default function f() {} export default 1;\nexport default 2;\n";
    expect(scanExports(text).filter((e) => e.kind === "default")).toEqual([
      { name: "f", line: 1, kind: "default" },
      { name: "default", line: 2, kind: "default" },
    ]);
  });
});

describe("scanImports checks each bare import in one pass", () => {
  // About 0.5 a character here.
  const WORK_PER_CHARACTER = 2;

  test('a file of `import "x";` lines', () => {
    const rows = [4_000, 8_000].map((k) => {
      // Every fourth line imports its module with a clause too: the bare
      // pattern matches that line again, and the clause has claimed it.
      const text = range(k)
        .map((i) =>
          i % 4 === 0 ? `import x from "m${i}"; import "m${i}";\n` : `import "m${i}";\n`,
        )
        .join("");
      const run = jsWork(WORK_PER_CHARACTER * text.length, () => scanImports(text));
      return { k, text, run };
    });
    for (const { k, text, run } of rows) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_CHARACTER * text.length);
      const records = (run.value ?? []).map((r) => [r.line, r.specifier, r.names]);
      expect(records).toEqual(range(k).map((i) => [i + 1, `m${i}`, i % 4 === 0 ? ["x"] : []]));
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);

  test("a bare import is dropped where a record on its line has its masked specifier", () => {
    // The bare pattern reads the masked text, where a string's body is
    // blank, so only an empty or all-space specifier can equal a record's.
    const text = [
      'import x from "a"; import "a";',
      'export * from "c"; import "c";',
      'require(""); import "";',
      'export * from ""; import "";',
      'import "  "; require("  ");',
      'import "\t"; require("\t");',
    ].join("\n");
    expect(scanImports(text).map((r) => [r.line, r.kind, r.specifier])).toEqual([
      [1, "import", "a"],
      [2, "export-from", "c"],
      [2, "import", "c"],
      [3, "require", ""],
      [4, "export-from", ""],
      [5, "require", "  "],
      [6, "require", "\t"],
      [6, "import", "\t"],
    ]);
  });
});

describe("buildImportGraph lists a file's targets in one pass", () => {
  // About 48 an import here: resolving a specifier tries a dozen spellings.
  const WORK_PER_IMPORT = 128;

  test("one file importing thousands of others, each twice, that all import it back", () => {
    const rows = [2_000, 4_000].map((k) => {
      const input: FileImports[] = [
        {
          file: "hub.ts",
          imports: range(2 * k).map((i) => ({
            specifier: i < k ? `./f${i}` : `./f${i - k}.ts`,
            line: i + 1,
          })),
        },
        ...range(k).map((i) => ({ file: `f${i}.ts`, imports: [{ specifier: "./hub", line: 1 }] })),
      ];
      const run = jsWork(WORK_PER_IMPORT * 3 * k, () => buildImportGraph(input));
      return { k, run };
    });
    for (const { k, run } of rows) {
      expect(run.work).toBeLessThanOrEqual(WORK_PER_IMPORT * 3 * k);
      // Two spellings of each target are two edges, and one neighbour.
      expect(run.value?.edges).toHaveLength(3 * k);
      expect(run.value?.cycles).toEqual([[...range(k).map((i) => `f${i}.ts`), "hub.ts"].sort()]);
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.run.work / small.run.work).toBeLessThan(2.4);
  }, 20_000);
});

describe("DependencyList lists a name's locked versions in one pass", () => {
  // About 39 a locked version here, most of it reading the lockfile.
  const WORK_PER_VERSION = 100;
  const originalCwd = process.cwd();
  const dirs = { workspace: "" };

  beforeEach(() => {
    dirs.workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-code-locked-")));
    process.chdir(dirs.workspace);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dirs.workspace, { recursive: true, force: true });
  });

  test("one name locked at thousands of versions, some twice", async () => {
    writeFileSync("package.json", JSON.stringify({ name: "w", dependencies: { a: "*" } }));
    const rows: Array<{ k: number; work: number; out: string }> = [];
    for (const k of [2_000, 4_000]) {
      const packages: Record<string, unknown> = { "": { name: "w" } };
      for (const i of range(k))
        packages[`node_modules/x${i}/node_modules/a`] = { version: `1.0.${i}` };
      // The same versions again under other paths: listed once.
      for (const i of range(k / 4))
        packages[`node_modules/y${i}/node_modules/a`] = { version: `1.0.${i}` };
      writeFileSync("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages }));
      const input = dependencyList.inputSchema.parse({ includeLocked: true });
      const run = await jsWorkAsync(
        WORK_PER_VERSION * k,
        () => dependencyList.execute(input, {} as never) as Promise<unknown>,
      );
      rows.push({ k, work: run.work, out: String(run.value) });
    }
    for (const { k, work, out } of rows) {
      expect(work).toBeLessThanOrEqual(WORK_PER_VERSION * k);
      const locked = (JSON.parse(out) as { dependencies: Array<{ locked?: string[] }> })
        .dependencies[0]?.locked;
      expect(locked).toEqual(
        range(k)
          .map((i) => `1.0.${i}`)
          .sort(),
      );
    }
    const [small, large] = rows as [(typeof rows)[0], (typeof rows)[0]];
    expect(large.work / small.work).toBeLessThan(2.4);
  }, 20_000);
});
