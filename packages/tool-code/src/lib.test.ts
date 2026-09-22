/**
 * The pure half of the package: the scanner, the parsers, the graph and the
 * dependency readers. Everything here is text in, records out, so the tests
 * are fixtures rather than fixtures-plus-a-world — `index.test.ts` is where
 * real processes and real directories live.
 *
 * Several fixtures are verbatim output from the real tools, including the
 * exact layout quirks (bun printing a failure's detail ABOVE the line that
 * names the test), because a parser tested only against tidied-up samples is
 * a parser that has not been tested.
 */
import { describe, expect, test } from "bun:test";
import { parseIstanbulSummary, parseLcov, totalOf, worstFirst } from "./lib/coverage";
import {
  LOCKFILE_NAMES,
  matchWorkspaceGlob,
  parseBunLock,
  parseBunLockDetailed,
  parseCargoLock,
  parseCargoLockDetailed,
  parseCargoToml,
  parseGoMod,
  parseLockfileDetailed,
  parsePackageJson,
  parsePackageLock,
  parsePackageLockDetailed,
  parsePnpmLock,
  parsePnpmLockDetailed,
  parsePyproject,
  parseRequirementsTxt,
  parseSemver,
  parseYarnLock,
  parseYarnLockDetailed,
  satisfies,
  stripJsonc,
} from "./lib/deps";
import {
  countBySeverity,
  parseAnyDiagnostics,
  parseBiomeJson,
  parseEslintJson,
  parseGenericDiagnostics,
  parseRuffJson,
  parseTsc,
  sortDiagnostics,
} from "./lib/diagnostics";
import {
  buildImportGraph,
  resolveSpecifier,
  stronglyConnected,
  unreferencedFiles,
} from "./lib/graph";
import {
  KIND_CODE,
  KIND_COMMENT,
  KIND_STRING,
  findOccurrences,
  hasNestedRepetition,
  maskSource,
  scanDeclarations,
  scanExports,
  scanImports,
  scanTodos,
} from "./lib/scan";
import { classifyFrame, parseStackTrace } from "./lib/stack";
import {
  detectRunnerFromOutput,
  parseBunTest,
  parseCargoTest,
  parseGoTestJson,
  parseJestJson,
  parsePytest,
  parseTestOutput,
  relativizeFailures,
  splitMessageAndStack,
} from "./lib/tests";

// ---------------------------------------------------------------------------

describe("maskSource", () => {
  test("blanks comment and string bodies but keeps offsets", () => {
    const src = 'const a = "hello"; // note\n';
    const masked = maskSource(src);
    expect(masked.code.length).toBe(src.length);
    // Delimiters survive (a `from "…"` pattern still matches); bodies become
    // spaces of the same length, so offsets line up with the original.
    expect(masked.code).toContain('"     "');
    expect(masked.code).not.toContain("hello");
    expect(masked.code).not.toContain("note");
    expect(masked.kind[src.indexOf("hello")]).toBe(KIND_STRING);
    expect(masked.kind[src.indexOf("note")]).toBe(KIND_COMMENT);
    expect(masked.kind[0]).toBe(KIND_CODE);
  });

  test("a URL inside a string is not read as a line comment", () => {
    const src = 'const u = "https://example.com/x"; const b = 1;';
    const masked = maskSource(src);
    expect(masked.kind[src.indexOf("b = 1")]).toBe(KIND_CODE);
  });

  test("template literals keep their interpolations as code", () => {
    const src = "const t = `a ${value} b`;";
    const masked = maskSource(src);
    expect(masked.kind[src.indexOf("value")]).toBe(KIND_CODE);
    expect(masked.kind[src.indexOf("a $")]).toBe(KIND_STRING);
  });

  test("a regex literal containing a brace does not open a block", () => {
    const src = "const re = /class Fake {/;\nconst after = 2;\n";
    expect(scanDeclarations(src).map((d) => d.name)).toEqual(["re", "after"]);
  });

  test("newlines survive so line numbers are preserved", () => {
    const src = "/* a\nb */\nconst x = 1;\n";
    const masked = maskSource(src);
    expect(masked.code.split("\n").length).toBe(src.split("\n").length);
  });
});

describe("scanDeclarations", () => {
  const src = [
    "import { z } from 'zod';",
    "export async function run(a: string): Promise<void> {",
    "  return;",
    "}",
    "export class Widget extends Base {",
    "  static count = 0;",
    "  #secret: string;",
    "  constructor() { super(); }",
    "  async render(x: number): Promise<string> {",
    "    return '';",
    "  }",
    "  get value(): number { return 1; }",
    "}",
    "export interface Shape { a: number }",
    "export type Alias = string;",
    "export const enum Mode { On }",
    "const local = 1;",
    "export const builder = z",
    "  .object({})",
    "  .strict();",
  ].join("\n");

  test("finds every top-level declaration with its span", () => {
    const decls = scanDeclarations(src);
    const run = decls.find((d) => d.name === "run");
    expect(run).toBeDefined();
    expect(run?.kind).toBe("function");
    expect(run?.exported).toBe(true);
    expect(run?.startLine).toBe(2);
    expect(run?.endLine).toBe(4);
  });

  test("a multi-line fluent declaration spans to its last line", () => {
    const builder = scanDeclarations(src).find((d) => d.name === "builder");
    expect(builder?.startLine).toBe(18);
    expect(builder?.endLine).toBe(20);
  });

  test("class members carry their parent and kind", () => {
    const members = scanDeclarations(src).filter((d) => d.parent === "Widget");
    expect(members.map((m) => [m.kind, m.name])).toEqual([
      ["property", "count"],
      ["property", "#secret"],
      ["method", "constructor"],
      ["method", "render"],
      ["accessor", "value"],
    ]);
  });

  test("interfaces, type aliases and enums are distinguished", () => {
    const kinds = new Map(scanDeclarations(src).map((d) => [d.name, d.kind]));
    expect(kinds.get("Shape")).toBe("interface");
    expect(kinds.get("Alias")).toBe("type");
    expect(kinds.get("Mode")).toBe("enum");
    expect(kinds.get("local")).toBe("variable");
  });

  test("a declaration written inside a comment is not found", () => {
    const decls = scanDeclarations("// export function ghost() {}\nconst real = 1;\n");
    expect(decls.map((d) => d.name)).toEqual(["real"]);
  });

  test("results are sorted by line and are stable across calls", () => {
    expect(scanDeclarations(src)).toEqual(scanDeclarations(src));
  });
});

describe("scanImports and scanExports", () => {
  const src = [
    "import path from 'node:path';",
    'import { a, b as c } from "./mod";',
    "import type { T } from './types';",
    "import * as ns from '../ns';",
    "import './side-effect';",
    "const lazy = () => import('./lazy');",
    "const cjs = require('legacy');",
    "export { a, c as d };",
    "export * from './star';",
    "export type { T } from './types';",
    "export default function main() {}",
  ].join("\n");

  test("every import form is found with its specifier", () => {
    const specifiers = scanImports(src).map((i) => i.specifier);
    expect(specifiers).toContain("node:path");
    expect(specifiers).toContain("./mod");
    expect(specifiers).toContain("./types");
    expect(specifiers).toContain("../ns");
    expect(specifiers).toContain("./side-effect");
    expect(specifiers).toContain("./lazy");
    expect(specifiers).toContain("legacy");
    expect(specifiers).toContain("./star");
  });

  test("import kinds and type-only imports are reported", () => {
    const records = scanImports(src);
    expect(records.find((i) => i.specifier === "./lazy")?.kind).toBe("dynamic");
    expect(records.find((i) => i.specifier === "legacy")?.kind).toBe("require");
    expect(records.find((i) => i.specifier === "./types" && i.kind === "import")?.typeOnly).toBe(
      true,
    );
    expect(records.find((i) => i.specifier === "./mod")?.names).toEqual(["a", "c"]);
  });

  test("an import inside a string is not counted", () => {
    const records = scanImports("const doc = \"import x from './fake'\";\n");
    expect(records).toEqual([]);
  });

  test("exports include declarations, lists, stars and default", () => {
    const names = scanExports(src).map((e) => e.name);
    expect(names).toContain("a");
    expect(names).toContain("d");
    expect(names).toContain("*");
    expect(names).toContain("main");
  });
});

describe("findOccurrences", () => {
  const src = [
    "import { widget } from './w';",
    "// widget in a comment",
    'const s = "widget in a string";',
    "const used = widget(1);",
    "const widgetFactory = 2;",
  ].join("\n");

  test("finds code occurrences and skips comments and strings", () => {
    const hits = findOccurrences(src, "widget");
    expect(hits.map((h) => h.line)).toEqual([1, 4]);
  });

  test("does not match inside a longer identifier", () => {
    expect(findOccurrences(src, "widgetFactory").map((h) => h.line)).toEqual([5]);
  });
});

describe("scanTodos", () => {
  const src = [
    "// TODO(dave): tighten the cap",
    "/* FIXME @ana - the retry is wrong */",
    "const text = 'TODO: not a note, this is data';",
    "// HACK works around the upstream bug",
    "const TODOLIST = 1;",
  ].join("\n");

  test("finds markers in comments only, with authors", () => {
    const todos = scanTodos(src);
    expect(todos.map((t) => [t.marker, t.author, t.text])).toEqual([
      ["TODO", "dave", "tighten the cap"],
      ["FIXME", "ana", "the retry is wrong"],
      ["HACK", undefined, "works around the upstream bug"],
    ]);
  });

  test("respects a caller's marker list", () => {
    expect(scanTodos(src, ["HACK"]).map((t) => t.line)).toEqual([4]);
  });
});

// ---------------------------------------------------------------------------

describe("diagnostics parsers", () => {
  test("tsc --pretty false, including a wrapped continuation", () => {
    const text = [
      "src/a.ts(12,5): error TS2345: Argument of type 'string' is not assignable.",
      "  Type 'string' is not assignable to type 'number'.",
      "src/b.ts(3,1): warning TS6133: 'x' is declared but never used.",
      "error TS18003: No inputs were found in config file.",
    ].join("\n");
    const found = parseTsc(text);
    expect(found).toHaveLength(3);
    expect(found[0]).toMatchObject({
      file: "",
      severity: "error",
      rule: "TS18003",
      source: "tsc",
    });
    const first = found.find((d) => d.file === "src/a.ts");
    expect(first?.line).toBe(12);
    expect(first?.column).toBe(5);
    expect(first?.message).toContain("not assignable to type 'number'");
    expect(found.find((d) => d.file === "src/b.ts")?.severity).toBe("warning");
  });

  test("tsc paths are made relative to the run directory", () => {
    const found = parseTsc("/work/pkg/src/a.ts(1,1): error TS1005: ';' expected.", "/work/pkg");
    expect(found[0]?.file).toBe("src/a.ts");
  });

  test("biome JSON, with the byte span converted to a line and column", () => {
    const source = "const a = 1;\nif (a == 2) {}\n";
    const payload = JSON.stringify({
      diagnostics: [
        {
          category: "lint/suspicious/noDoubleEquals",
          severity: "error",
          description: "Use === instead of ==",
          location: {
            path: { file: "src/x.ts" },
            span: [source.indexOf("=="), 21],
            sourceCode: source,
          },
        },
      ],
    });
    const found = parseBiomeJson(payload);
    expect(found).toHaveLength(1);
    expect(found?.[0]).toMatchObject({
      file: "src/x.ts",
      line: 2,
      severity: "error",
      rule: "lint/suspicious/noDoubleEquals",
      source: "biome",
    });
  });

  test("biome JSON without a source excerpt still yields the finding", () => {
    const found = parseBiomeJson(
      JSON.stringify({
        diagnostics: [
          {
            category: "format",
            severity: "warning",
            description: { content: "Formatter would change this file" },
            location: { path: { file: "a.ts" } },
          },
        ],
      }),
    );
    expect(found?.[0]).toMatchObject({ file: "a.ts", line: 0, severity: "warning" });
  });

  test("a verbatim biome 1.9 record parses, message markup and all", () => {
    // Captured from `biome lint --reporter=json` rather than written by hand:
    // the description is a plain string, the message is nested markup, and the
    // location carries a byte span with the source beside it.
    const payload = JSON.stringify({
      summary: { errors: 1, warnings: 0 },
      diagnostics: [
        {
          category: "lint/suspicious/noDoubleEquals",
          severity: "error",
          description: "Use === instead of ==. == is only allowed when comparing against `null`",
          message: [
            { elements: [], content: "Use " },
            { elements: ["Emphasis"], content: "===" },
          ],
          location: {
            path: { file: "/repo/x.ts" },
            span: [19, 21],
            sourceCode: 'const a = 1;\nif (a == 2) { console.log("x"); }\n',
          },
        },
      ],
    });
    const found = parseBiomeJson(payload, "/repo");
    expect(found).toHaveLength(1);
    expect(found?.[0]).toMatchObject({
      file: "x.ts",
      line: 2,
      column: 7,
      severity: "error",
      rule: "lint/suspicious/noDoubleEquals",
      source: "biome",
    });
    expect(found?.[0]?.message).toContain("Use === instead of ==");
  });

  test("non-biome JSON is rejected rather than half-parsed", () => {
    expect(parseBiomeJson("[]")).toBeUndefined();
    expect(parseBiomeJson("not json")).toBeUndefined();
  });

  test("eslint -f json, including a fatal parse error", () => {
    const payload = JSON.stringify([
      {
        filePath: "/repo/src/a.js",
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "'x' is defined but never used.",
            line: 4,
            column: 7,
          },
          { ruleId: null, fatal: true, severity: 2, message: "Parsing error", line: 1, column: 1 },
        ],
      },
    ]);
    const found = parseEslintJson(payload, "/repo");
    expect(found).toHaveLength(2);
    expect(found?.[0]).toMatchObject({ file: "src/a.js", source: "eslint" });
    expect(found?.some((d) => d.rule === "no-unused-vars")).toBe(true);
  });

  test("ruff --output-format json", () => {
    const payload = JSON.stringify([
      {
        code: "F401",
        message: "`os` imported but unused",
        filename: "app.py",
        location: { row: 1, column: 8 },
      },
    ]);
    const found = parseRuffJson(payload);
    expect(found?.[0]).toMatchObject({
      file: "app.py",
      line: 1,
      column: 8,
      rule: "F401",
      source: "ruff",
    });
  });

  test("the generic reader takes file:line:col and ignores timestamps and URLs", () => {
    const found = parseGenericDiagnostics(
      ["main.go:12:3: undefined: foo", "12:30:00 starting", "https://example.com:443 fetched"].join(
        "\n",
      ),
      "go-vet",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: "main.go", line: 12, column: 3, source: "go-vet" });
  });

  test("parseAny prefers a structured parser and falls back to lines", () => {
    expect(
      parseAnyDiagnostics(
        '[{"code":"E1","message":"m","filename":"a.py","location":{"row":1,"column":2}}]',
      )[0],
    ).toMatchObject({ source: "ruff" });
    expect(parseAnyDiagnostics("a.ts(1,1): error TS1000: x")[0]).toMatchObject({ source: "tsc" });
    expect(parseAnyDiagnostics("{}")).toEqual([]);
  });

  test("sorting is by file, position, rule and message — never locale-dependent", () => {
    const items = sortDiagnostics([
      { file: "b.ts", line: 1, column: 1, severity: "error", message: "b", source: "t" },
      { file: "a.ts", line: 2, column: 1, severity: "error", message: "a", source: "t" },
      { file: "a.ts", line: 1, column: 9, severity: "warning", message: "c", source: "t" },
    ]);
    expect(items.map((d) => `${d.file}:${d.line}`)).toEqual(["a.ts:1", "a.ts:2", "b.ts:1"]);
    expect(countBySeverity(items)).toEqual({ error: 2, warning: 1, info: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("test output parsers", () => {
  // Verbatim from `bun test`: the failure detail comes ABOVE the (fail) line,
  // and passing tests print nothing but a count.
  const BUN_OUTPUT = [
    "",
    "a.test.ts:",
    '1 | import { expect, test } from "bun:test";',
    '4 |   test("breaks", () => { expect(1 + 1).toBe(3); });',
    "                                           ^",
    "error: expect(received).toBe(expected)",
    "",
    "Expected: 3",
    "Received: 2",
    "",
    "      at <anonymous> (/tmp/x/a.test.ts:4:40)",
    "(fail) math > breaks [0.17ms]",
    "",
    " 1 pass",
    " 1 skip",
    " 1 fail",
    " 2 expect() calls",
    "Ran 3 tests across 1 file. [6.00ms]",
  ].join("\n");

  test("bun: counts, the failing test, its file, line and assertion", () => {
    const outcome = parseBunTest(BUN_OUTPUT);
    expect(outcome).toMatchObject({ runner: "bun", passed: 1, failed: 1, skipped: 1, total: 3 });
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatchObject({
      name: "math > breaks",
      file: "a.test.ts",
      line: 4,
    });
    expect(outcome.failures[0]?.message).toContain("Expected: 3");
    // The source excerpt bun prints is dropped, not carried into the message.
    expect(outcome.failures[0]?.message).not.toContain("import { expect");
  });

  test("bun: a green run reports no failures at all", () => {
    const outcome = parseBunTest(" 12 pass\n 0 fail\nRan 12 tests across 3 files. [40.00ms]");
    expect(outcome.failed).toBe(0);
    expect(outcome.failures).toEqual([]);
    expect(outcome.parsed).toBe(true);
  });

  test("jest/vitest JSON: failure message, stack and location", () => {
    const payload = JSON.stringify({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [
        {
          name: "/repo/src/a.test.ts",
          assertionResults: [
            { fullName: "adds", status: "passed" },
            {
              fullName: "suite > breaks",
              status: "failed",
              location: { line: 9, column: 3 },
              failureMessages: [
                "AssertionError: expected 2 to be 3\n    at /repo/src/a.test.ts:9:3\n    at node_modules/vitest/dist/x.js:1:1",
              ],
            },
          ],
        },
      ],
    });
    const outcome = parseJestJson(payload, "vitest");
    expect(outcome).toMatchObject({ runner: "vitest", passed: 2, failed: 1, total: 3 });
    expect(outcome?.failures[0]).toMatchObject({
      name: "suite > breaks",
      file: "/repo/src/a.test.ts",
      line: 9,
    });
    expect(outcome?.failures[0]?.message).toContain("expected 2 to be 3");
    // Dependency frames are dropped from the stack.
    expect(outcome?.failures[0]?.stack?.join(" ")).not.toContain("node_modules");
  });

  test("jest/vitest: a suite that failed to load is still reported", () => {
    const outcome = parseJestJson(
      JSON.stringify({
        numTotalTests: 0,
        testResults: [{ name: "/repo/b.test.ts", message: "SyntaxError: bad token" }],
      }),
    );
    expect(outcome?.failures[0]?.message).toContain("SyntaxError");
  });

  test("pytest -q -rf --tb=short", () => {
    const text = [
      "F.                                                                       [100%]",
      "=================================== FAILURES ===================================",
      "________________________________ test_adds _____________________________________",
      "tests/test_math.py:7: in test_adds",
      "    assert add(1, 2) == 4",
      "E   assert 3 == 4",
      "=========================== short test summary info ============================",
      "FAILED tests/test_math.py::test_adds - assert 3 == 4",
      "1 failed, 1 passed in 0.03s",
    ].join("\n");
    const outcome = parsePytest(text);
    expect(outcome).toMatchObject({ runner: "pytest", passed: 1, failed: 1 });
    expect(outcome.failures[0]).toMatchObject({
      name: "tests/test_math.py::test_adds",
      file: "tests/test_math.py",
      line: 7,
      message: "assert 3 == 4",
    });
  });

  test("go test -json", () => {
    const text = [
      JSON.stringify({ Action: "run", Package: "example/pkg", Test: "TestAdd" }),
      JSON.stringify({
        Action: "output",
        Package: "example/pkg",
        Test: "TestAdd",
        Output: "    math_test.go:12: got 3 want 4\n",
      }),
      JSON.stringify({ Action: "fail", Package: "example/pkg", Test: "TestAdd" }),
      JSON.stringify({ Action: "pass", Package: "example/pkg", Test: "TestSub" }),
      JSON.stringify({ Action: "skip", Package: "example/pkg", Test: "TestSlow" }),
    ].join("\n");
    const outcome = parseGoTestJson(text);
    expect(outcome).toMatchObject({ runner: "go", passed: 1, failed: 1, skipped: 1 });
    expect(outcome.failures[0]).toMatchObject({
      file: "math_test.go",
      line: 12,
      message: "got 3 want 4",
    });
  });

  test("cargo test", () => {
    const text = [
      "running 2 tests",
      "test tests::adds ... ok",
      "test tests::breaks ... FAILED",
      "",
      "failures:",
      "",
      "---- tests::breaks stdout ----",
      "thread 'tests::breaks' panicked at src/lib.rs:10:9:",
      "assertion `left == right` failed",
      "",
      "test result: FAILED. 1 passed; 1 failed; 0 ignored;",
    ].join("\n");
    const outcome = parseCargoTest(text);
    expect(outcome).toMatchObject({ runner: "cargo", passed: 1, failed: 1 });
    expect(outcome.failures[0]).toMatchObject({
      name: "tests::breaks",
      file: "src/lib.rs",
      line: 10,
    });
    expect(outcome.failures[0]?.message).toContain("assertion");
  });

  test("a runner's signature is found even when a build log precedes it", () => {
    // Detection samples both ends: half these signatures are printed when a
    // run FINISHES, and a stored log usually begins with an install.
    const noise = `${"compiling module\n".repeat(4_000)}`;
    expect(detectRunnerFromOutput(`${noise}test result: ok. 3 passed`)).toBe("cargo");
    expect(detectRunnerFromOutput(`${noise}=== short test summary info`)).toBe("pytest");
  });

  test("jest/vitest JSON is found with noise printed after it", () => {
    const report = JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 0,
      numFailedTests: 1,
      testResults: [
        {
          name: "/repo/a.test.ts",
          assertionResults: [
            { status: "failed", fullName: "a > b", failureMessages: ["Error: nope"] },
          ],
        },
      ],
    });
    const outcome = parseTestOutput(`${report}\nWarning: deprecated flag\n`, "vitest");
    expect({ parsed: outcome.parsed, failed: outcome.failed }).toEqual({ parsed: true, failed: 1 });
  });

  test("the runner is inferred from the output's own shape", () => {
    expect(detectRunnerFromOutput(BUN_OUTPUT)).toBe("bun");
    expect(detectRunnerFromOutput('{"numTotalTests":1,"testResults":[]}')).toBe("jest");
    expect(detectRunnerFromOutput('{"Action":"run","Package":"p","Test":"T"}')).toBe("go");
    expect(detectRunnerFromOutput("short test summary info")).toBe("pytest");
    expect(detectRunnerFromOutput("test result: ok. 1 passed;")).toBe("cargo");
    expect(detectRunnerFromOutput("hello world")).toBeUndefined();
  });

  test("unrecognised output is reported as unparsed rather than as a green run", () => {
    const outcome = parseTestOutput("something else entirely", "auto");
    expect(outcome.parsed).toBe(false);
    expect(outcome.total).toBe(0);
  });

  test("splitMessageAndStack drops runtime frames and caps the rest", () => {
    const blob = [
      "Error: boom",
      "    at one (/a/x.ts:1:1)",
      "    at two (/a/y.ts:2:2)",
      "    at three (node:internal/process:3:3)",
      "    at four (/a/node_modules/dep/z.js:4:4)",
    ].join("\n");
    const split = splitMessageAndStack(blob, 1);
    expect(split.message).toBe("Error: boom");
    expect(split.stack).toEqual(["at one (/a/x.ts:1:1)"]);
  });
});

// ---------------------------------------------------------------------------

describe("caller-supplied patterns", () => {
  test("a repetition nested in a repetition is rejected", () => {
    for (const pattern of ["^(a|a|aa)+$", "(a+)+", "(a*)*", "(\\w+)+$", "(ab{1,})+"]) {
      expect({ pattern, unsafe: hasNestedRepetition(pattern) }).toEqual({ pattern, unsafe: true });
    }
  });

  test("the patterns a caller writes over declaration names are left alone", () => {
    for (const pattern of [
      "^help",
      "^(get|set)Foo$",
      "^get[A-Z]\\w*",
      "Service$",
      "(abc)+",
      "[+*]+",
      "\\(a+\\)",
      "(a|b){0,3}",
    ]) {
      expect({ pattern, unsafe: hasNestedRepetition(pattern) }).toEqual({ pattern, unsafe: false });
    }
  });
});

describe("stack traces", () => {
  test("V8 frames are classified against the project root", () => {
    const trace = [
      "TypeError: x is not a function",
      "    at run (/repo/src/a.ts:10:5)",
      "    at /repo/src/b.ts:3:1",
      "    at Module._compile (node:internal/modules/cjs/loader:1234:14)",
      "    at load (/repo/node_modules/dep/index.js:2:2)",
      "    at other (/elsewhere/lib.js:1:1)",
    ].join("\n");
    const parsed = parseStackTrace(trace, "/repo");
    expect(parsed.error).toBe("TypeError: x is not a function");
    expect(parsed.frames.map((f) => f.kind)).toEqual([
      "project",
      "project",
      "runtime",
      "dependency",
      "dependency",
    ]);
    expect(parsed.frames[0]).toMatchObject({
      function: "run",
      file: "/repo/src/a.ts",
      line: 10,
      column: 5,
    });
    expect(parsed.firstProjectFrame).toBe(0);
  });

  test("a CPython traceback is parsed too", () => {
    const parsed = parseStackTrace(
      [
        "Traceback (most recent call last):",
        '  File "/repo/app.py", line 12, in main',
        "    boom()",
      ].join("\n"),
      "/repo",
    );
    expect(parsed.frames[0]).toMatchObject({
      file: "/repo/app.py",
      line: 12,
      function: "main",
      kind: "project",
    });
  });

  test("file:// URLs and bundler query strings are cleaned", () => {
    const parsed = parseStackTrace("    at go (file:///repo/src/a.ts?v=123:4:2)", "/repo");
    expect(parsed.frames[0]?.file).toBe("/repo/src/a.ts");
  });

  test("a named frame is split without backtracking", () => {
    // `/^at\\s+(.+?)\\s+\\((.+)\\)$/` took twelve seconds on four thousand
    // characters of this shape, and `trace` accepts two million.
    const started = Date.now();
    const parsed = parseStackTrace(`at ${" ".repeat(200_000)}x`);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(parsed.frames).toEqual([]);
  });

  test("a frame longer than the cap keeps both ends, so its position survives", () => {
    const parsed = parseStackTrace(`at run (${"d/".repeat(50_000)}a.ts:12:34)`);
    expect(parsed.frames).toHaveLength(1);
    // Cut from the middle: the function name and the `:line:col)` at the end
    // are what a reader needs, and cutting the tail would drop the frame.
    expect(parsed.frames[0]).toMatchObject({ function: "run", line: 12, column: 34 });
    expect((parsed.frames[0] as { raw: string }).raw.length).toBeLessThanOrEqual(2_000);
  });

  test("classification without a root treats relative paths as project code", () => {
    expect(classifyFrame("src/a.ts")).toBe("project");
    expect(classifyFrame("node:fs")).toBe("runtime");
    expect(classifyFrame("/x/node_modules/a/b.js")).toBe("dependency");
  });
});

// ---------------------------------------------------------------------------

describe("coverage", () => {
  const LCOV = [
    "SF:src/a.ts",
    "DA:1,1",
    "DA:2,0",
    "LF:2",
    "LH:1",
    "FNF:2",
    "FNH:1",
    "end_of_record",
    "SF:src/b.ts",
    "LF:4",
    "LH:4",
    "end_of_record",
  ].join("\n");

  test("lcov records become per-file metrics", () => {
    const files = parseLcov(LCOV);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ file: "src/a.ts" });
    expect(files[0]?.lines).toEqual({ covered: 1, total: 2, pct: 50 });
    expect(files[0]?.functions).toEqual({ covered: 1, total: 2, pct: 50 });
    expect(files[1]?.lines.pct).toBe(100);
  });

  test("DA lines are used when LF/LH are missing", () => {
    const files = parseLcov("SF:x.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record");
    expect(files[0]?.lines).toEqual({ covered: 2, total: 3, pct: 66.7 });
  });

  test("istanbul coverage-summary.json is read, total separated from files", () => {
    const summary = parseIstanbulSummary(
      JSON.stringify({
        total: { lines: { total: 10, covered: 5, pct: 50 } },
        "src/a.ts": {
          lines: { total: 4, covered: 1, pct: 25 },
          branches: { total: 2, covered: 2, pct: 100 },
        },
      }),
    );
    expect(summary?.files).toHaveLength(1);
    expect(summary?.total?.lines.pct).toBe(50);
    expect(summary?.files[0]?.branches?.pct).toBe(100);
  });

  test("worst-first puts the biggest hole first and is stable", () => {
    const files = parseLcov(LCOV);
    expect(worstFirst(files).map((f) => f.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(totalOf(files).lines).toEqual({ covered: 5, total: 6, pct: 83.3 });
  });
});

// ---------------------------------------------------------------------------

describe("dependency manifests", () => {
  test("package.json: scripts, scopes and workspaces", () => {
    const manifest = parsePackageJson(
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        scripts: { test: "bun test", build: "tsc -b" },
        dependencies: { zod: "^3.23.8" },
        devDependencies: { typescript: "~5.4.0" },
        workspaces: ["packages/*"],
      }),
    );
    expect(manifest?.name).toBe("app");
    expect(manifest?.scripts["build"]).toBe("tsc -b");
    expect(manifest?.dependencies.map((d) => [d.name, d.range, d.scope])).toEqual([
      ["typescript", "~5.4.0", "dev"],
      ["zod", "^3.23.8", "prod"],
    ]);
    expect(manifest?.workspaces).toEqual(["packages/*"]);
  });

  test("stripJsonc removes comments and trailing commas but spares URLs", () => {
    const text = '{\n  // note\n  "a": "https://x/y", /* b */\n  "c": [1, 2,],\n}';
    const parsed = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
    expect(parsed["a"]).toBe("https://x/y");
    expect(parsed["c"]).toEqual([1, 2]);
  });

  test("bun.lock", () => {
    const locked = parseBunLock(
      '{\n  "lockfileVersion": 1,\n  "packages": {\n    "zod": ["zod@3.23.8", "", {}, "sha512-x"],\n    "@scope/pkg": ["@scope/pkg@2.1.0", "", {}, "sha512-y"],\n  },\n}',
    );
    expect(locked).toEqual([
      { name: "@scope/pkg", version: "2.1.0" },
      { name: "zod", version: "3.23.8" },
    ]);
  });

  test("package-lock.json v3", () => {
    const locked = parsePackageLock(
      JSON.stringify({
        packages: {
          "": { name: "root", version: "1.0.0" },
          "node_modules/zod": { version: "3.23.8" },
          "node_modules/a/node_modules/b": { version: "2.0.0" },
        },
      }),
    );
    expect(locked).toEqual([
      { name: "b", version: "2.0.0" },
      { name: "root", version: "1.0.0" },
      { name: "zod", version: "3.23.8" },
    ]);
  });

  test("yarn.lock, classic and berry", () => {
    const classic = parseYarnLock(
      '"zod@^3.0.0", "zod@^3.23.0":\n  version "3.23.8"\n  resolved "x"\n',
    );
    expect(classic).toEqual([{ name: "zod", version: "3.23.8" }]);
    const berry = parseYarnLock(
      '"zod@npm:^3.23.0":\n  version: 3.23.8\n  resolution: "zod@npm:3.23.8"\n',
    );
    expect(berry).toEqual([{ name: "zod", version: "3.23.8" }]);
  });

  // pnpm changed its entry-key grammar twice, and all three generations are
  // still in the wild. These three fixtures are the `packages:` sections of
  // lockfiles written by pnpm 7, 8 and 10 for the same package.json.
  test("pnpm-lock.yaml, generations 5, 6 and 9", () => {
    const v5 = parsePnpmLock(
      [
        "lockfileVersion: 5.4",
        "",
        "dependencies:",
        "  react-dom: 18.2.0_react@18.2.0",
        "",
        "packages:",
        "",
        "  /@sindresorhus/is/5.6.0:",
        "    resolution: {integrity: sha512-Abc==}",
        "    dev: false",
        "",
        "  /react-dom/18.2.0_react@18.2.0:",
        "    resolution: {integrity: sha512-Def==}",
        "    dependencies:",
        "      react: 18.2.0",
        "    dev: false",
        "",
      ].join("\n"),
    );
    expect(v5).toEqual([
      { name: "@sindresorhus/is", version: "5.6.0" },
      { name: "react-dom", version: "18.2.0" },
    ]);
    // pnpm 8 kept the leading slash but moved to `name@version`, so a reader
    // written only to the v5 shape reads NOTHING here — which is how the
    // whole format came to be silently unread.
    const v6 = parsePnpmLock(
      [
        "lockfileVersion: '6.0'",
        "",
        "packages:",
        "",
        "  /@sindresorhus/is@5.6.0:",
        "    resolution: {integrity: sha512-Abc==}",
        "",
        "  /react-dom@18.2.0(react@18.2.0):",
        "    resolution: {integrity: sha512-Def==}",
        "",
      ].join("\n"),
    );
    expect(v6).toEqual([
      { name: "@sindresorhus/is", version: "5.6.0" },
      { name: "react-dom", version: "18.2.0" },
    ]);
    const v9 = parsePnpmLock(
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  '@sindresorhus/is@5.6.0':",
        "    resolution: {integrity: sha512-Abc==}",
        "",
        "  react-dom@18.2.0:",
        "    resolution: {integrity: sha512-Def==}",
        "",
      ].join("\n"),
    );
    expect(v9).toEqual([
      { name: "@sindresorhus/is", version: "5.6.0" },
      { name: "react-dom", version: "18.2.0" },
    ]);
  });

  test("pnpm: only `packages:` is a resolution, and `_` is legal in a name", () => {
    // `importers:` holds the ranges the workspace DECLARED and `snapshots:`
    // re-lists a package once per peer combination. Counting either would
    // report a resolved version that is not one, or the same package twice.
    const scoped = parsePnpmLock(
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      zod:",
        "        specifier: ^3",
        "        version: 3.23.8",
        "",
        "packages:",
        "",
        "  zod@3.23.8:",
        "    resolution: {integrity: sha512-Abc==}",
        "",
        "snapshots:",
        "",
        "  zod@3.23.8: {}",
        "",
      ].join("\n"),
    );
    expect(scoped).toEqual([{ name: "zod", version: "3.23.8" }]);
    // `@a2ui/web_core` is a real package. Cutting a v5 peer suffix at the
    // first `_` in the key rather than inside the version segment would
    // truncate this name to `@a2ui/web`.
    expect(
      parsePnpmLock(
        "packages:\n\n  '@a2ui/web_core@0.10.0':\n    resolution: {integrity: sha512-A==}\n",
      ),
    ).toEqual([{ name: "@a2ui/web_core", version: "0.10.0" }]);
  });

  test("requirements.txt: extras, markers and comments", () => {
    const deps = parseRequirementsTxt(
      [
        "# comment",
        "requests==2.31.0",
        "uvicorn[standard]>=0.29,<1.0 ; python_version >= '3.9'",
        "-r other.txt",
        "git+https://example.com/x.git",
      ].join("\n"),
    );
    expect(deps.map((d) => [d.name, d.range])).toEqual([
      ["requests", "==2.31.0"],
      ["uvicorn", ">=0.29,<1.0"],
    ]);
  });

  test("pyproject.toml: PEP 621 and poetry", () => {
    const pep621 = parsePyproject(
      ["[project]", 'name = "x"', "dependencies = [", '  "requests>=2",', '  "rich",', "]"].join(
        "\n",
      ),
    );
    expect(pep621.map((d) => d.name)).toEqual(["requests", "rich"]);
    const poetry = parsePyproject(
      ["[tool.poetry.dependencies]", 'python = "^3.11"', 'httpx = "^0.27"'].join("\n"),
    );
    expect(poetry.map((d) => [d.name, d.range])).toEqual([["httpx", "^0.27"]]);
  });

  test("go.mod: require block and indirect markers", () => {
    const deps = parseGoMod(
      [
        "module example/x",
        "go 1.22",
        "require (",
        "\tgithub.com/a/b v1.2.3",
        "\tgithub.com/c/d v0.1.0 // indirect",
        ")",
      ].join("\n"),
    );
    expect(deps.map((d) => [d.name, d.range, d.scope])).toEqual([
      ["github.com/a/b", "v1.2.3", "prod"],
      ["github.com/c/d", "v0.1.0", "optional"],
    ]);
  });

  test("Cargo.toml and Cargo.lock", () => {
    const deps = parseCargoToml(
      [
        "[dependencies]",
        'serde = "1.0"',
        'tokio = { version = "1.38", features = ["full"] }',
        "[dev-dependencies]",
        'proptest = "1"',
      ].join("\n"),
    );
    expect(deps.map((d) => [d.name, d.range, d.scope])).toEqual([
      ["proptest", "1", "dev"],
      ["serde", "1.0", "prod"],
      ["tokio", "1.38", "prod"],
    ]);
    expect(parseCargoLock('[[package]]\nname = "serde"\nversion = "1.0.203"\n')).toEqual([
      { name: "serde", version: "1.0.203" },
    ]);
  });

  test("workspace globs", () => {
    expect(matchWorkspaceGlob("packages/tool-code", "packages/*")).toBe(true);
    expect(matchWorkspaceGlob("packages/a/b", "packages/*")).toBe(false);
    expect(matchWorkspaceGlob("packages/a/b", "packages/**")).toBe(true);
    expect(matchWorkspaceGlob("apps/web", "packages/*")).toBe(false);
    expect(matchWorkspaceGlob("packages/x", "!packages/x")).toBe(false);
  });
});

describe("lockfile readers, the wide view", () => {
  // Verbatim bun shapes: the integrity is the LAST slot, the resolution slot
  // is empty for anything from the configured registry and a URL only when it
  // is not, and a workspace member is a one-element tuple with neither.
  const BUN_LOCK = [
    "{",
    '  "lockfileVersion": 1,',
    '  "packages": {',
    '    "zod": ["zod@3.23.8", "", { "dependencies": {} }, "sha512-Abc123=="],',
    '    "inhouse": ["inhouse@1.0.0", "https://npm.internal.example.com/inhouse/-/inhouse-1.0.0.tgz", {}, "sha512-Def456=="],',
    '    "@acme/app": ["@acme/app@workspace:packages/app"],',
    "  },",
    "}",
  ].join("\n");

  test("bun.lock: integrity always, a URL only where bun recorded one", () => {
    expect(parseBunLockDetailed(BUN_LOCK)).toEqual([
      { ecosystem: "npm", name: "@acme/app", version: "workspace:packages/app" },
      {
        ecosystem: "npm",
        name: "inhouse",
        version: "1.0.0",
        resolvedUrl: "https://npm.internal.example.com/inhouse/-/inhouse-1.0.0.tgz",
        integrity: "sha512-Def456==",
      },
      { ecosystem: "npm", name: "zod", version: "3.23.8", integrity: "sha512-Abc123==" },
    ]);
  });

  test("package-lock.json: `resolved` only when it is a URL", () => {
    const detailed = parsePackageLockDetailed(
      JSON.stringify({
        packages: {
          "": { name: "root", version: "1.0.0" },
          "node_modules/zod": {
            version: "3.23.8",
            resolved: "https://registry.npmjs.org/zod/-/zod-3.23.8.tgz",
            integrity: "sha512-Abc123==",
          },
          // npm usually omits `version` on a link entry, so this is the guard
          // rather than a common shape — but a workspace path is what npm
          // writes into `resolved` there, and it must never come back as a URL
          // for something to fetch.
          "node_modules/ui": { version: "0.1.0", resolved: "packages/ui", link: true },
        },
      }),
    );
    expect(detailed).toEqual([
      { ecosystem: "npm", name: "root", version: "1.0.0" },
      { ecosystem: "npm", name: "ui", version: "0.1.0" },
      {
        ecosystem: "npm",
        name: "zod",
        version: "3.23.8",
        resolvedUrl: "https://registry.npmjs.org/zod/-/zod-3.23.8.tgz",
        integrity: "sha512-Abc123==",
      },
    ]);
  });

  test("yarn.lock: classic carries both, berry neither", () => {
    // `resolved` and `integrity` sit BELOW `version`, which is the whole
    // reason an entry is flushed at the next header rather than at its
    // version line.
    const classic = parseYarnLockDetailed(
      [
        '"zod@^3.23.0":',
        '  version "3.23.8"',
        '  resolved "https://registry.yarnpkg.com/zod/-/zod-3.23.8.tgz#e67ad4b4"',
        "  integrity sha512-Abc123==",
        "",
      ].join("\n"),
    );
    expect(classic).toEqual([
      {
        ecosystem: "npm",
        name: "zod",
        version: "3.23.8",
        resolvedUrl: "https://registry.yarnpkg.com/zod/-/zod-3.23.8.tgz#e67ad4b4",
        integrity: "sha512-Abc123==",
      },
    ]);
    // Berry's `resolution:` is a descriptor and its `checksum:` hashes Yarn's
    // own zip, not the published tarball. Both are dropped: a consumer that
    // verified a registry download against that checksum would reject a good
    // tarball, and one that fetched the descriptor would fetch nothing.
    const berry = parseYarnLockDetailed(
      [
        '"zod@npm:^3.23.0":',
        "  version: 3.23.8",
        '  resolution: "zod@npm:3.23.8"',
        "  checksum: 10c0/9f3a1c2b",
        "  languageName: node",
        "",
      ].join("\n"),
    );
    expect(berry).toEqual([{ ecosystem: "npm", name: "zod", version: "3.23.8" }]);
  });

  test("pnpm-lock.yaml: the entry's own fields beat the key, and only a tarball is a URL", () => {
    // Verbatim pnpm 10 shapes. A registry package records SRI and no URL; a
    // git one records `repo`/`commit` and its REAL version in a `version:`
    // field, while the key holds the git URL where a version would be; a
    // directory one records neither.
    const detailed = parsePnpmLockDetailed(
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  is-odd@git+ssh://git@github.com/jonschlinkert/is-odd.git#a80ee0d:",
        "    resolution: {commit: a80ee0d, repo: git+ssh://git@github.com/jonschlinkert/is-odd.git, type: git}",
        "    version: 3.0.1",
        "    engines: {node: '>=4'}",
        "",
        "  inhouse@1.0.0:",
        "    resolution: {tarball: https://npm.internal.example.com/inhouse/-/inhouse-1.0.0.tgz}",
        "",
        "  local-pkg@file:local-pkg:",
        "    resolution: {directory: local-pkg, type: directory}",
        "",
        "  zod@3.23.8:",
        "    resolution: {integrity: sha512-Abc123==}",
        "",
      ].join("\n"),
    );
    expect(detailed).toEqual([
      {
        ecosystem: "npm",
        name: "inhouse",
        version: "1.0.0",
        resolvedUrl: "https://npm.internal.example.com/inhouse/-/inhouse-1.0.0.tgz",
      },
      // The version is 3.0.1, not the git URL the key carries — and the key
      // is split at the FIRST `@` after the scope, because the last one is
      // inside `git@github.com`.
      { ecosystem: "npm", name: "is-odd", version: "3.0.1" },
      // Neither field is recorded for a directory, and the key stands in for
      // the version so the entry is still visible in a diff.
      { ecosystem: "npm", name: "local-pkg", version: "file:local-pkg" },
      { ecosystem: "npm", name: "zod", version: "3.23.8", integrity: "sha512-Abc123==" },
    ]);
    // A git resolution's `repo` is a repository, not the address an artifact
    // came from, so it is NOT promoted to `resolvedUrl` the way `tarball` is.
    expect(detailed[1]).not.toHaveProperty("resolvedUrl");
  });

  test("Cargo.lock: checksum as bare hex, and `source` is not a resolved URL", () => {
    const detailed = parseCargoLockDetailed(
      [
        "[[package]]",
        'name = "serde"',
        'version = "1.0.203"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'checksum = "7253ab4de971e72fb7be983802300c30b5a7f0c2e56fab8abfc6a214307c0094"',
        "",
        "[[package]]",
        'name = "local-thing"',
        'version = "0.1.0"',
      ].join("\n"),
    );
    expect(detailed).toEqual([
      // A path dependency has no checksum at all, and no URL is invented for it.
      { ecosystem: "cargo", name: "local-thing", version: "0.1.0" },
      {
        ecosystem: "cargo",
        name: "serde",
        version: "1.0.203",
        integrity: "7253ab4de971e72fb7be983802300c30b5a7f0c2e56fab8abfc6a214307c0094",
      },
    ]);
  });

  test("Cargo.lock: a table after the packages does not inherit the last checksum", () => {
    // `[[patch.unused]]` is written below the packages and carries its own
    // name and version. The reader has to end the crate before reading them,
    // or the crate is lost and its checksum is reported against another name.
    const detailed = parseCargoLockDetailed(
      [
        "[[package]]",
        'name = "serde"',
        'version = "1.0.203"',
        'checksum = "7253ab4de971e72fb7be983802300c30b5a7f0c2e56fab8abfc6a214307c0094"',
        "",
        "[[patch.unused]]",
        'name = "other"',
        'version = "9.9.9"',
      ].join("\n"),
    );
    expect(detailed).toContainEqual({
      ecosystem: "cargo",
      name: "serde",
      version: "1.0.203",
      integrity: "7253ab4de971e72fb7be983802300c30b5a7f0c2e56fab8abfc6a214307c0094",
    });
    expect(detailed.find((e) => e.name === "other")?.integrity).toBeUndefined();
  });

  test("a hash that is not the hash it claims to be is dropped", () => {
    const notSri = parsePackageLockDetailed(
      JSON.stringify({
        packages: {
          "node_modules/a": {
            version: "1.0.0",
            integrity: "10c0/9f3a",
            resolved: "https://example.com/a.tgz",
          },
        },
      }),
    );
    expect(notSri).toEqual([
      { ecosystem: "npm", name: "a", version: "1.0.0", resolvedUrl: "https://example.com/a.tgz" },
    ]);
    const truncated = parseCargoLockDetailed(
      ["[[package]]", 'name = "x"', 'version = "1.0.0"', 'checksum = "abc123"'].join("\n"),
    );
    expect(truncated).toEqual([{ ecosystem: "cargo", name: "x", version: "1.0.0" }]);
  });

  test("the narrow readers still return exactly a name and a version", () => {
    const narrow = [
      ...parseBunLock(BUN_LOCK),
      ...parsePackageLock(
        JSON.stringify({
          packages: {
            "node_modules/zod": {
              version: "3.23.8",
              resolved: "https://registry.npmjs.org/zod/-/zod-3.23.8.tgz",
              integrity: "sha512-Abc123==",
            },
          },
        }),
      ),
      ...parseYarnLock('"zod@^3":\n  version "3.23.8"\n  integrity sha512-Abc123==\n'),
      ...parsePnpmLock(
        "packages:\n\n  zod@3.23.8:\n    resolution: {integrity: sha512-Abc123==}\n",
      ),
      ...parseCargoLock(
        [
          "[[package]]",
          'name = "serde"',
          'version = "1.0.203"',
          'checksum = "7253ab4de971e72fb7be983802300c30b5a7f0c2e56fab8abfc6a214307c0094"',
        ].join("\n"),
      ),
    ];
    // Every fixture above carries a hash, and several a URL. `toEqual` alone
    // would still pass on a record that had them set to `undefined`, so the
    // keys are asserted: the narrow view is what every existing caller
    // destructures and what `DependencyList` serialises, and a widened one
    // would put a hash in output that has never contained one.
    for (const entry of narrow) expect(Object.keys(entry).sort()).toEqual(["name", "version"]);
    expect(narrow).toHaveLength(7);
  });

  test("parseLockfileDetailed picks a reader, and says when there is none", () => {
    expect(parseLockfileDetailed("bun.lock", BUN_LOCK)).toHaveLength(3);
    expect(
      parseLockfileDetailed("/abs/path/Cargo.lock", '[[package]]\nname = "serde"\nversion = "1"\n'),
    ).toEqual([{ ecosystem: "cargo", name: "serde", version: "1" }]);
    expect(
      parseLockfileDetailed("pnpm-lock.yaml", "packages:\n\n  zod@3.23.8:\n    resolution: {}\n"),
    ).toEqual([{ ecosystem: "npm", name: "zod", version: "3.23.8" }]);
    // `undefined`, never `[]`: a format this package does not read and a
    // lockfile with nothing in it are different answers, and a caller that
    // conflated them would report a bun project as depending on nothing.
    // `bun.lockb` is binary, so the `bun.lock` reader would return `[]`.
    expect(parseLockfileDetailed("bun.lockb", "")).toBeUndefined();
    expect(parseLockfileDetailed("shrinkwrap.yaml", "packages:\n")).toBeUndefined();
    // Every name in the list resolves to a reader, so the list cannot name a
    // format nothing reads.
    for (const name of LOCKFILE_NAMES) {
      expect({ name, read: parseLockfileDetailed(name, "") !== undefined }).toEqual({
        name,
        read: true,
      });
    }
  });
});

describe("semver, the subset", () => {
  test("parses the shapes a manifest holds", () => {
    expect(parseSemver("v1.2.3-rc.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "rc.1",
    });
    expect(parseSemver("2")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: "" });
    expect(parseSemver("not-a-version")).toBeUndefined();
  });

  test("caret, tilde, inequalities, exact and wildcards", () => {
    expect(satisfies("3.23.8", "^3.23.0")).toBe(true);
    expect(satisfies("4.0.0", "^3.23.0")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.0")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfies("5.4.5", "~5.4.0")).toBe(true);
    expect(satisfies("5.5.0", "~5.4.0")).toBe(false);
    expect(satisfies("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(satisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.9.0", "1.x")).toBe(true);
    expect(satisfies("1.2.3", "*")).toBe(true);
    expect(satisfies("1.0.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfies("2.5.0", "^1.0.0 || ^2.0.0")).toBe(true);
    expect(satisfies("3.0.0", "^1.0.0 || ^2.0.0")).toBe(false);
  });

  test("a range it cannot evaluate says so instead of guessing", () => {
    expect(satisfies("1.0.0", "workspace:*")).toBeUndefined();
    expect(satisfies("1.0.0", "github:a/b#main")).toBeUndefined();
    expect(satisfies("nonsense", "^1.0.0")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("import graph", () => {
  const files = new Set(["a.ts", "b.ts", "dir/index.ts", "c.tsx"]);

  test("resolves the extension ladder, index files and the .js-means-.ts habit", () => {
    expect(resolveSpecifier("a.ts", "./b", files)).toBe("b.ts");
    expect(resolveSpecifier("a.ts", "./b.js", files)).toBe("b.ts");
    expect(resolveSpecifier("a.ts", "./dir", files)).toBe("dir/index.ts");
    expect(resolveSpecifier("dir/index.ts", "../a", files)).toBe("a.ts");
    expect(resolveSpecifier("a.ts", "./c", files)).toBe("c.tsx");
    expect(resolveSpecifier("a.ts", "./missing", files)).toBeUndefined();
    expect(resolveSpecifier("a.ts", "zod", files)).toBeUndefined();
  });

  test("builds edges, externals, unresolved specifiers and cycles", () => {
    const graph = buildImportGraph([
      {
        file: "a.ts",
        imports: [
          { specifier: "./b", line: 1 },
          { specifier: "zod", line: 2 },
        ],
      },
      {
        file: "b.ts",
        imports: [
          { specifier: "./a", line: 1 },
          { specifier: "./gone", line: 2 },
        ],
      },
      { file: "c.ts", imports: [{ specifier: "zod", line: 1 }] },
    ]);
    expect(graph.files).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(graph.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["a.ts->b.ts", "b.ts->a.ts"]);
    expect(graph.external).toEqual([{ specifier: "zod", importedBy: ["a.ts", "c.ts"] }]);
    expect(graph.unresolved).toEqual([{ from: "b.ts", specifier: "./gone", line: 2 }]);
    expect(graph.cycles).toEqual([["a.ts", "b.ts"]]);
  });

  test("a self-import is a cycle, an acyclic graph has none", () => {
    const selfLoop = new Map([["a.ts", ["a.ts"]]]);
    expect(stronglyConnected(["a.ts"], selfLoop)).toEqual([["a.ts"]]);
    const chain = new Map([
      ["a.ts", ["b.ts"]],
      ["b.ts", []],
    ]);
    expect(stronglyConnected(["a.ts", "b.ts"], chain)).toEqual([]);
  });

  test("unreferenced files exclude whatever the caller calls an entry", () => {
    const graph = buildImportGraph([
      { file: "index.ts", imports: [{ specifier: "./used", line: 1 }] },
      { file: "used.ts", imports: [] },
      { file: "orphan.ts", imports: [] },
    ]);
    expect(unreferencedFiles(graph, (f) => f === "index.ts")).toEqual(["orphan.ts"]);
    expect(unreferencedFiles(graph, () => false)).toEqual(["index.ts", "orphan.ts"]);
  });

  test("a large cyclic graph does not overflow the stack", () => {
    const count = 5_000;
    const input = Array.from({ length: count }, (_, i) => ({
      file: `f${i}.ts`,
      imports: [{ specifier: `./f${(i + 1) % count}`, line: 1 }],
    }));
    const graph = buildImportGraph(input);
    expect(graph.cycles).toHaveLength(1);
    expect(graph.cycles[0]).toHaveLength(count);
  });
});

describe("relativizeFailures", () => {
  const outcome = {
    runner: "bun",
    passed: 1,
    failed: 1,
    skipped: 0,
    total: 2,
    parsed: true,
    failures: [
      {
        name: "math > breaks",
        file: "/tmp/crewhaus-abc/a.test.ts",
        line: 3,
        message: "x",
        stack: [],
      },
    ],
  };

  test("an absolute path under the run directory becomes the path a caller would open", () => {
    // bun printed `a.test.ts` on macOS and the absolute form on Linux for the
    // same suite, so the test asserted one platform's answer.
    expect(relativizeFailures(outcome, ["/tmp/crewhaus-abc"]).failures[0]?.file).toBe("a.test.ts");
  });

  test("a path that is already relative is left alone", () => {
    const relative = { ...outcome, failures: [{ ...outcome.failures[0], file: "a.test.ts" }] };
    expect(relativizeFailures(relative, ["/tmp/crewhaus-abc"]).failures[0]?.file).toBe("a.test.ts");
  });

  test("a path outside the run directory is left exactly as the runner printed it", () => {
    expect(relativizeFailures(outcome, ["/somewhere/else"]).failures[0]?.file).toBe(
      "/tmp/crewhaus-abc/a.test.ts",
    );
  });

  test("either spelling of a symlinked temporary directory is shortened", () => {
    // macOS reaches /var through /private/var, so a run has two valid roots.
    const mac = {
      ...outcome,
      failures: [{ ...outcome.failures[0], file: "/private/var/f/a.test.ts" }],
    };
    expect(relativizeFailures(mac, ["/var/f", "/private/var/f"]).failures[0]?.file).toBe(
      "a.test.ts",
    );
  });

  test("a failure with no file is untouched", () => {
    const noFile = { ...outcome, failures: [{ name: "x", message: "y", stack: [] }] };
    expect(relativizeFailures(noFile, ["/tmp"]).failures[0]?.file).toBeUndefined();
  });
});
