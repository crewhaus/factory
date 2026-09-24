/**
 * The tools against a real world: real processes, a real temporary directory,
 * real refusals.
 *
 * Every test runs inside a fresh `mkdtemp` workspace which becomes the
 * process's working directory, because that is what the containment boundary
 * is measured against. Nothing here writes into the repository, and the test
 * suites that are spawned are written into the temp directory first.
 *
 * `bun` is the one binary these tests assume, and only because they are
 * already running under it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { detectFormat, detectLint, detectPackageManager, detectTests, isMissing } from "./detect";
import {
  CODE_TOOLS,
  astQuery,
  coverageSummary,
  deadFileScan,
  dependencyList,
  dependencyOutdated,
  diagnostics,
  findReferences,
  format,
  formatCheck,
  importGraph,
  lint,
  packageScripts,
  runBuild,
  runTests,
  stackTraceParse,
  symbolOutline,
  testFailureSummary,
  todoScan,
  typecheck,
  workspacePackages,
} from "./index";

let workspace: string;
let outside: string;
let originalCwd: string;

/** Call a tool the way the runtime does, minus the schema validation. */
async function call(tool: RegisteredTool, input: unknown): Promise<string> {
  const result = await tool.execute(input);
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** Call a tool and parse its JSON result, failing loudly on a refusal. */
async function callJson(tool: RegisteredTool, input: unknown): Promise<Record<string, unknown>> {
  const text = await call(tool, input);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${tool.name} returned a message, not JSON: ${text}`);
  }
}

function write(relative: string, contents: string): void {
  const full = join(workspace, relative);
  const slash = relative.lastIndexOf("/");
  if (slash !== -1) mkdirSync(join(workspace, relative.slice(0, slash)), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * Install a stand-in for a toolchain binary in the project's own
 * `node_modules/.bin`, where `detect` looks for it.
 *
 * The read-only checkers take no `command`, deliberately — a tool the
 * permission engine auto-allows must not let a caller name the program — so
 * the only honest way to test their parsing against a real process is to give
 * detection a real binary to find. That also exercises the half of the code a
 * caller-supplied argv used to skip: the config sniffing, the local-install
 * rule, and the argv `detect` actually builds.
 */
function installBinary(name: string, shell: string): void {
  const relative = `node_modules/.bin/${name}`;
  write(relative, `#!/bin/sh\n${shell}\n`);
  chmodSync(join(workspace, relative), 0o755);
}

/** A shell fragment that prints each line to stdout, then exits non-zero. */
function prints(lines: readonly string[], exitCode = 1): string {
  return `${lines.map((l) => `printf '%s\\n' ${JSON.stringify(l)}`).join("\n")}\nexit ${exitCode}`;
}

beforeEach(() => {
  originalCwd = process.cwd();
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-code-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-tool-code-outside-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("RunTests against a real bun suite", () => {
  const SUITE = [
    'import { describe, expect, test } from "bun:test";',
    'describe("math", () => {',
    '  test("adds", () => { expect(1 + 1).toBe(2); });',
    '  test("breaks", () => { expect(1 + 1).toBe(3); });',
    '  test.skip("later", () => {});',
    "});",
  ].join("\n");

  test("reports counts, the failing test, its file and its assertion", async () => {
    write("a.test.ts", SUITE);
    const result = await callJson(runTests, { runner: "bun" });
    expect(result["ok"]).toBe(false);
    expect(result["passed"]).toBe(1);
    expect(result["failed"]).toBe(1);
    expect(result["skipped"]).toBe(1);
    const failures = result["failures"] as Array<Record<string, unknown>>;
    expect(failures).toHaveLength(1);
    expect(failures[0]?.["name"]).toBe("math > breaks");
    expect(failures[0]?.["file"]).toBe("a.test.ts");
    expect(String(failures[0]?.["message"])).toContain("Expected: 3");
  }, 30_000);

  test("a green run comes back as counts and an empty failure list", async () => {
    write(
      "green.test.ts",
      'import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n',
    );
    const result = await callJson(runTests, { runner: "bun" });
    expect(result["ok"]).toBe(true);
    expect(result["failed"]).toBe(0);
    expect(result["failures"]).toEqual([]);
    // The point of the tool: a green run is small.
    expect(JSON.stringify(result).length).toBeLessThan(400);
  }, 30_000);

  test("a name pattern narrows the run", async () => {
    write("a.test.ts", SUITE);
    const result = await callJson(runTests, { runner: "bun", namePattern: "adds" });
    expect(result["failed"]).toBe(0);
    expect(result["passed"]).toBe(1);
  }, 30_000);

  test("a path filter limits which files run", async () => {
    write("a.test.ts", SUITE);
    write(
      "b.test.ts",
      'import { expect, test } from "bun:test";\ntest("b ok", () => { expect(1).toBe(1); });\n',
    );
    const result = await callJson(runTests, { runner: "bun", paths: ["b.test.ts"] });
    expect(result["failed"]).toBe(0);
    expect(result["total"]).toBe(1);
  }, 30_000);

  test("bun detection finds the runner without being told", async () => {
    write("a.test.ts", SUITE);
    write("bun.lock", '{ "lockfileVersion": 1, "packages": {} }');
    const result = await callJson(runTests, {});
    expect(result["runner"]).toBe("bun");
    expect(result["detectedBy"]).toBe("bun.lock");
  }, 30_000);

  test("a suite that dies while loading is counted AND explained", async () => {
    // bun prints its count block for a file that threw on import but never a
    // `(fail)` line for it, so the failure has a count and no record. Saying
    // "1 failed" and nothing else would leave a caller nowhere to go.
    write("boom.test.ts", 'throw new Error("module-level explosion");\n');
    const result = await callJson(runTests, { runner: "bun" });
    expect(result["ok"]).toBe(false);
    expect(result["failed"]).toBeGreaterThan(0);
    expect((result["failures"] as unknown[]).length).toBe(0);
    expect(String((result["rawTail"] as string[]).join(" "))).toContain("module-level explosion");
  }, 30_000);

  test("unparseable output is reported as unparsed, with the raw tail", async () => {
    write("say.ts", 'console.log("this is not a test report");\n');
    const result = await callJson(runTests, { command: ["bun", "say.ts"] });
    expect(result["parsed"]).toBe(false);
    expect(String((result["rawTail"] as string[]).join(" "))).toContain("not a test report");
  }, 30_000);
});

describe("RunTests refusals", () => {
  test("a path filter that begins with a dash is refused, not passed on", async () => {
    write("a.test.ts", 'import { test } from "bun:test";\ntest("x", () => {});\n');
    const message = await call(runTests, { runner: "bun", paths: ["-D"] });
    expect(message).toContain("refused");
    expect(message).toContain('begins with "-"');
  });

  test("a name pattern that begins with a dash is refused", async () => {
    const message = await call(runTests, { runner: "bun", namePattern: "--reporter=junit" });
    expect(message).toContain("refused");
  });

  test("a cwd outside the workspace is refused", async () => {
    const message = await call(runTests, { cwd: "../", runner: "bun" });
    expect(message).toContain("outside the workspace root");
  });

  test("a path filter outside the workspace is refused", async () => {
    const message = await call(runTests, { runner: "bun", paths: ["../escape.test.ts"] });
    expect(message).toContain("refused");
  });

  test("a deadline kills the run and says so", async () => {
    const message = await call(runTests, { command: ["sleep", "10"], timeout: 400 });
    expect(message).toContain("timed out");
    expect(message).toContain("raise `timeout`");
  }, 20_000);

  test("a missing program is a sentence, not an exception", async () => {
    const message = await call(runTests, {
      command: ["crewhaus-no-such-program-xyz"],
      timeout: 5_000,
    });
    expect(message).toContain("could not start");
  });

  test("a project with no recognisable runner is told so", async () => {
    const message = await call(runTests, {});
    expect(message).toContain("could not work out how this project runs its tests");
  });
});

describe("TestFailureSummary", () => {
  test("extracts failures from stored output without running anything", async () => {
    const stored = [
      "a.test.ts:",
      "error: expect(received).toBe(expected)",
      "Expected: 3",
      "Received: 2",
      "      at <anonymous> (/tmp/x/a.test.ts:4:40)",
      "(fail) math > breaks [0.17ms]",
      " 1 pass",
      " 1 fail",
    ].join("\n");
    const result = await callJson(testFailureSummary, { output: stored });
    expect(result["runner"]).toBe("bun");
    expect(result["failed"]).toBe(1);
    expect((result["failures"] as unknown[]).length).toBe(1);
  });

  test("caps the failures it returns", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `(fail) case ${i}`).join("\n");
    const result = await callJson(testFailureSummary, { output: many, maxFailures: 5 });
    expect((result["failures"] as unknown[]).length).toBe(5);
    expect(result["failuresTruncated"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("diagnostic tools against the project's own toolchain", () => {
  test("Typecheck parses tsc-shaped output into diagnostics", async () => {
    write("tsconfig.json", "{}");
    installBinary(
      "tsc",
      prints([
        "src/a.ts(12,5): error TS2345: Argument of type 'string' is not assignable.",
        "src/b.ts(3,1): error TS6133: 'x' is declared but never used.",
      ]),
    );
    const result = await callJson(typecheck, {});
    expect(result["ok"]).toBe(false);
    expect(result["errors"]).toBe(2);
    const found = result["diagnostics"] as Array<Record<string, unknown>>;
    expect(found[0]).toMatchObject({ file: "src/a.ts", line: 12, column: 5, rule: "TS2345" });
  }, 20_000);

  test("Typecheck runs the checker in no-emit mode, which is what keeps it a read", async () => {
    write("tsconfig.json", "{}");
    installBinary("tsc", 'printf "%s\\n" "$*"\nexit 0');
    const result = await callJson(typecheck, {});
    expect(result["ok"]).toBe(true);
    // The binary is reported relative to the workspace root, not as this
    // machine's absolute path, so the same project gives the same bytes
    // wherever it is checked out.
    expect(result["command"]).toContain("node_modules/.bin/tsc --noEmit");
    expect(String(result["command"]).startsWith("/")).toBe(false);
  }, 20_000);

  test("Typecheck on a clean run returns zero errors and no noise", async () => {
    write("tsconfig.json", "{}");
    installBinary("tsc", "exit 0");
    const result = await callJson(typecheck, {});
    expect(result["ok"]).toBe(true);
    expect(result["errors"]).toBe(0);
    expect(result["diagnostics"]).toEqual([]);
  }, 20_000);

  test("Lint parses eslint JSON into the same shape", async () => {
    write("eslint.config.js", "export default [];\n");
    const payload = JSON.stringify([
      {
        filePath: "src/a.js",
        messages: [
          {
            ruleId: "no-debugger",
            severity: 2,
            message: "Unexpected debugger.",
            line: 2,
            column: 1,
          },
        ],
      },
    ]);
    installBinary("eslint", prints([payload]));
    const result = await callJson(lint, {});
    const found = result["diagnostics"] as Array<Record<string, unknown>>;
    expect(found[0]).toMatchObject({ file: "src/a.js", rule: "no-debugger", source: "eslint" });
  }, 20_000);

  test("RunBuild returns diagnostics and a raw tail when it cannot parse any", async () => {
    write("fake-build.ts", 'console.log("boom, something went wrong");\nprocess.exit(2);\n');
    const result = await callJson(runBuild, { command: ["bun", "fake-build.ts"] });
    expect(result["ok"]).toBe(false);
    expect(result["exitCode"]).toBe(2);
    expect((result["rawTail"] as string[]).join(" ")).toContain("boom");
  }, 20_000);

  test("a chatty command is capped and the result says it was cut", async () => {
    write("noisy.ts", "console.log('x'.repeat(2_000_000));\n");
    const result = await callJson(runBuild, { command: ["bun", "noisy.ts"], timeout: 20_000 });
    expect(result["outputTruncated"]).toBe(true);
    expect(String(result["note"])).toContain("capped");
    // The cap is enforced while the pipe is read, so the whole result stays
    // small rather than being trimmed after two megabytes are already held.
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
  }, 30_000);

  test("a child that prints far more than fits in memory is still bounded", async () => {
    // 256MB down the pipe. This passes only if the cap is applied AS the pipe
    // is read: buffering first and trimming afterwards would need a quarter of
    // a gigabyte of string before a single character was dropped.
    write(
      "flood.ts",
      [
        "const chunk = 'y'.repeat(1_000_000) + '\\n';",
        "for (let i = 0; i < 256; i++) process.stdout.write(chunk);",
      ].join("\n"),
    );
    // Sample RETAINED heap, not whatever garbage happens to be uncollected:
    // a bare `heapUsed` delta moves with GC timing and with every other test
    // sharing this process, so it reported failures that had nothing to do
    // with this tool. Forcing a full collection either side measures what the
    // implementation actually holds on to, which is the claim being made.
    const retained = (): number => {
      Bun.gc(true);
      return process.memoryUsage().heapUsed;
    };
    const before = retained();
    const result = await callJson(runBuild, { command: ["bun", "flood.ts"], timeout: 60_000 });
    const grew = retained() - before;
    expect(result["outputTruncated"]).toBe(true);
    expect(grew).toBeLessThan(64_000_000);
  }, 90_000);

  test("FormatCheck lists the files a formatter reports", async () => {
    write(".prettierrc", "{}");
    installBinary("prettier", prints(["[warn] src/a.ts", "[warn] src/b.ts"]));
    const result = await callJson(formatCheck, {});
    expect(result["formatted"]).toBe(false);
    expect(result["unformatted"]).toEqual(["src/a.ts", "src/b.ts"]);
  }, 20_000);

  test("prettier's trailing summary line is not mistaken for a file", async () => {
    write(".prettierrc", "{}");
    installBinary(
      "prettier",
      prints([
        "Checking formatting...",
        "[warn] src/a.ts",
        "[warn] Code style issues found in the above file(s). Run Prettier with --write to fix.",
      ]),
    );
    const result = await callJson(formatCheck, {});
    expect(result["unformatted"]).toEqual(["src/a.ts"]);
  }, 20_000);

  test("a caller's path filter is passed after a -- terminator", async () => {
    write("eslint.config.js", "export default [];\n");
    write("src/a.ts", "export const a = 1;\n");
    installBinary("eslint", "exit 0");
    const result = await callJson(lint, { paths: ["src/a.ts"] });
    expect(String(result["command"])).toContain("-- src/a.ts");
  }, 20_000);

  test("Lint refuses a path filter that begins with a dash", async () => {
    write("eslint.config.js", "export default [];\n");
    installBinary("eslint", "exit 0");
    const message = await call(lint, { paths: ["--fix"] });
    expect(message).toContain("refused");
  });

  test("Diagnostics skips each step it has no configuration for, with a reason", async () => {
    const result = await callJson(diagnostics, {});
    expect(result["ok"]).toBe(true);
    const steps = result["steps"] as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(3);
    for (const step of steps) {
      expect(step["ran"]).toBe(false);
      expect(String(step["reason"])).toContain("no configuration");
    }
  }, 20_000);

  test("Diagnostics says which tool is missing rather than pretending it passed", async () => {
    write("tsconfig.json", "{}");
    const result = await callJson(diagnostics, { include: ["typecheck"] });
    const steps = result["steps"] as Array<Record<string, unknown>>;
    expect(steps[0]?.["ran"]).toBe(false);
    expect(String(steps[0]?.["reason"])).toContain("not installed");
  }, 20_000);

  test("Diagnostics spends ONE timeout across its steps, not one per step", async () => {
    write("tsconfig.json", "{}");
    write("eslint.config.js", "export default [];\n");
    write(".prettierrc", "{}");
    installBinary("tsc", "sleep 30");
    installBinary("eslint", "exit 0");
    installBinary("prettier", "exit 0");
    const started = Date.now();
    const result = await callJson(diagnostics, { timeout: 1_500 });
    const elapsed = Date.now() - started;
    const steps = result["steps"] as Array<Record<string, unknown>>;
    // The type check eats the whole budget; the two after it are refused for
    // want of time rather than each being handed another 1.5 seconds.
    expect(String(steps[0]?.["reason"])).toContain("timed out");
    expect(String(steps[1]?.["reason"])).toContain("was spent by the earlier steps");
    expect(String(steps[2]?.["reason"])).toContain("was spent by the earlier steps");
    // Without the shared budget this is three sleeps, not one.
    expect(elapsed).toBeLessThan(12_000);
  }, 60_000);
});

describe("the checkers cannot be pointed at another program", () => {
  // They are allowed without asking in auto mode (not destructive), which is
  // why they take no `command`: a checker that accepted a caller's argv would
  // be an unreviewed `sh -c`. They are NOT read-only (0.7.1): the program they
  // run comes from the workspace (node_modules/.bin, a JS config), and plan
  // mode runs every read-only tool without asking.
  const checkers: ReadonlyArray<[string, RegisteredTool]> = [
    ["Typecheck", typecheck],
    ["Lint", lint],
    ["FormatCheck", formatCheck],
  ];

  test("each one is auto-allowed, and denied in plan mode", () => {
    for (const [name, tool] of checkers) {
      expect({ name, readOnly: tool.readOnly, destructive: tool.destructive }).toEqual({
        name,
        readOnly: false,
        destructive: false,
      });
    }
  });

  test("none of them advertises a `command` field", () => {
    for (const [name, tool] of checkers) {
      const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
      expect({ name, hasCommand: Object.hasOwn(shape, "command") }).toEqual({
        name,
        hasCommand: false,
      });
    }
  });

  test("a `command` smuggled past the schema never becomes a process", async () => {
    // The runtime's zod validator strips the undeclared key before execute is
    // reached; this calls execute directly, which is the harsher test — the
    // field is present and must still be ignored rather than spawned. The
    // marker is the proof: it is a file OUTSIDE the workspace that the
    // smuggled command would delete.
    const marker = join(outside, "must-survive");
    for (const [name, tool] of checkers) {
      writeFileSync(marker, "");
      const message = await call(tool, {
        command: ["sh", "-c", `rm -f ${JSON.stringify(marker)}`],
      });
      expect({ name, survived: existsSync(marker) }).toEqual({ name, survived: true });
      expect({ name, explained: message.includes("takes no explicit command") }).toEqual({
        name,
        explained: true,
      });
    }
  }, 20_000);

  test("no read-only checker ever runs a package.json script", async () => {
    // A script is whatever the project wrote in it, so a read-only tool that
    // could reach one would be the same hole as an explicit `command` by
    // another route. `detect` deliberately routes scripts to RunBuild and
    // RunTests only; this is the guard on that.
    write(
      "package.json",
      JSON.stringify({
        name: "demo",
        scripts: { lint: "rm -rf /", typecheck: "rm -rf /", format: "rm -rf /" },
      }),
    );
    write("tsconfig.json", "{}");
    write("eslint.config.js", "export default [];\n");
    write(".prettierrc", "{}");
    for (const [name, tool] of checkers) {
      const message = await call(tool, {});
      expect({ name, viaScript: message.includes("rm -rf") }).toEqual({ name, viaScript: false });
      // Each is refused for a missing LOCAL install rather than falling back.
      expect({ name, refused: message.includes("no local install") }).toEqual({
        name,
        refused: true,
      });
    }
  }, 20_000);

  test("the tools that DO take a command are the destructive ones", () => {
    for (const [name, tool] of [
      ["RunTests", runTests],
      ["RunBuild", runBuild],
      ["Format", format],
    ] as ReadonlyArray<[string, RegisteredTool]>) {
      const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
      expect({ name, hasCommand: Object.hasOwn(shape, "command"), d: tool.destructive }).toEqual({
        name,
        hasCommand: true,
        d: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe("code intelligence over a real tree", () => {
  beforeEach(() => {
    write(
      "src/index.ts",
      [
        "import { helper } from './util';",
        "import type { Shape } from './types';",
        "// TODO(ana): widen the shape",
        "export function main(s: Shape): string {",
        "  return helper(s.name);",
        "}",
      ].join("\n"),
    );
    write(
      "src/util.ts",
      ["export function helper(name: string): string {", "  return name.trim();", "}"].join("\n"),
    );
    write("src/types.ts", "export type Shape = { name: string };\n");
    write("src/orphan.ts", "// FIXME nothing imports this\nexport const unused = 1;\n");
    write("node_modules/dep/index.ts", "export class ShouldNeverBeScanned {}\n");
  });

  test("AstQuery finds declarations and skips node_modules", async () => {
    const result = await callJson(astQuery, { cwd: "src" });
    const names = (result["declarations"] as Array<Record<string, unknown>>).map((d) => d["name"]);
    expect(names).toContain("main");
    expect(names).toContain("helper");
    expect(names).not.toContain("ShouldNeverBeScanned");
  });

  test("AstQuery filters by kind, export status and pattern", async () => {
    const functions = await callJson(astQuery, {
      cwd: "src",
      kinds: ["function"],
      exportedOnly: true,
    });
    expect((functions["declarations"] as unknown[]).length).toBe(2);
    const matched = await callJson(astQuery, { cwd: "src", pattern: "^help" });
    expect((matched["declarations"] as Array<Record<string, unknown>>)[0]?.["name"]).toBe("helper");
  });

  test("AstQuery refuses an unusable pattern with the regex error", async () => {
    const message = await call(astQuery, { cwd: "src", pattern: "([" });
    expect(message).toContain("could not use the pattern");
  });

  test("SymbolOutline gives line ranges for one file", async () => {
    const result = await callJson(symbolOutline, { file: "src/util.ts", includeImports: true });
    const declarations = result["declarations"] as Array<Record<string, unknown>>;
    expect(declarations[0]).toMatchObject({
      name: "helper",
      startLine: 1,
      endLine: 3,
      exported: true,
    });
    expect(result["imports"]).toEqual([]);
  });

  test("FindReferences reports lexical hits with file and line", async () => {
    const result = await callJson(findReferences, { name: "helper", cwd: "src" });
    const references = result["references"] as Array<Record<string, unknown>>;
    expect(result["matches"]).toBe(3);
    // Paths come back relative to the workspace root, not to the scanned
    // directory, so a caller can open the next file without joining anything.
    expect(references.map((r) => r["file"]).sort()).toEqual([
      "src/index.ts",
      "src/index.ts",
      "src/util.ts",
    ]);
  });

  test("FindReferences refuses anything that is not a plain identifier", async () => {
    const message = await call(findReferences, { name: "help.*", cwd: "src" });
    expect(message).toContain("plain identifier");
  });

  test("ImportGraph resolves relative imports and separates externals", async () => {
    write("src/cycle-a.ts", "import './cycle-b';\nexport const a = 1;\n");
    write("src/cycle-b.ts", "import './cycle-a';\nimport 'zod';\nexport const b = 2;\n");
    const result = await callJson(importGraph, { cwd: "src" });
    const edges = (result["edges"] as Array<Record<string, string>>).map(
      (e) => `${e["from"]}->${e["to"]}`,
    );
    expect(edges).toContain("index.ts->util.ts");
    expect(edges).toContain("index.ts->types.ts");
    expect(result["cycles"]).toEqual([["cycle-a.ts", "cycle-b.ts"]]);
    expect(
      (result["external"] as Array<Record<string, unknown>>).map((e) => e["specifier"]),
    ).toEqual(["zod"]);
  });

  test("DeadFileScan reports the orphan and spares entry points", async () => {
    const result = await callJson(deadFileScan, { cwd: "src" });
    // Graph paths are relative to the scanned directory, which the result names.
    expect(result["directory"]).toBe("src");
    expect(result["unreferenced"]).toEqual(["orphan.ts"]);
    const withEntry = await callJson(deadFileScan, { cwd: "src", entries: ["orphan.ts"] });
    expect(withEntry["unreferenced"]).toEqual([]);
  });

  test("TodoScan collects notes with author and position", async () => {
    const result = await callJson(todoScan, { cwd: "src" });
    const notes = result["notes"] as Array<Record<string, unknown>>;
    expect(notes.map((n) => n["marker"]).sort()).toEqual(["FIXME", "TODO"]);
    expect(notes.find((n) => n["marker"] === "TODO")).toMatchObject({
      file: "src/index.ts",
      line: 3,
      author: "ana",
    });
  });

  test("the same call twice returns the same bytes", async () => {
    const first = await call(astQuery, { cwd: "src" });
    const second = await call(astQuery, { cwd: "src" });
    expect(first).toBe(second);
  });
});

describe("bounded work on caller-supplied input", () => {
  test("AstQuery refuses a pattern that repeats a repeating group", async () => {
    write("src/a.ts", "export const aaaaaaaaaaaaaaaaaaaaaaaaaaaa = 1;\n");
    const started = Date.now();
    const message = await call(astQuery, { cwd: "src", pattern: "^(a|a|aa)+$" });
    // Without the refusal this pattern backtracks exponentially over that
    // identifier and there is no deadline to reach for: a JavaScript regular
    // expression cannot be interrupted once it is running.
    expect(message).toContain("refused the pattern");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("AstQuery still takes the patterns a caller actually writes", async () => {
    write("src/a.ts", "export function getThing() {}\nexport function setThing() {}\n");
    const result = await callJson(astQuery, { cwd: "src", pattern: "^(get|set)Thing$" });
    expect((result["declarations"] as unknown[]).length).toBe(2);
  });

  test("StackTraceParse survives a frame that is megabytes of whitespace", async () => {
    const started = Date.now();
    const result = await callJson(stackTraceParse, {
      // The old pattern for `at name (location)` was quadratic on exactly this
      // shape: four thousand characters measured at twelve seconds, and the
      // schema admits two million.
      trace: `at ${" ".repeat(400_000)}x\n    at run (/repo/src/a.ts:1:1)`,
      projectRoot: "/repo",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result["firstProjectFrame"]).toBe(0);
  }, 20_000);

  test("TestFailureSummary survives a stack frame that never ends", async () => {
    const started = Date.now();
    const result = await callJson(testFailureSummary, {
      output: [
        "a.test.ts:",
        "error: boom",
        `      at ${"a".repeat(500_000)}`,
        "(fail) suite > case",
        " 0 pass",
        " 1 fail",
      ].join("\n"),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result["failed"]).toBe(1);
  }, 20_000);
});

describe("containment", () => {
  test("a relative escape is refused", async () => {
    const message = await call(astQuery, { cwd: "../" });
    expect(message).toContain("outside the workspace root");
  });

  test("a cwd that is a symlink out of the workspace is refused", async () => {
    symlinkSync(outside, join(workspace, "escape"));
    for (const [name, input] of [
      ["AstQuery", { cwd: "escape" }],
      ["TodoScan", { cwd: "escape" }],
      ["ImportGraph", { cwd: "escape" }],
    ] as ReadonlyArray<[string, Record<string, unknown>]>) {
      const tool = CODE_TOOLS.find((t) => t.name === name) as RegisteredTool;
      const message = await call(tool, input);
      expect({ name, refused: message.includes("outside the workspace root") }).toEqual({
        name,
        refused: true,
      });
    }
  });

  test("a RunTests path filter that reaches out through a symlink is refused", async () => {
    writeFileSync(
      join(outside, "x.test.ts"),
      'import { test } from "bun:test";\ntest("x", () => {});\n',
    );
    symlinkSync(outside, join(workspace, "escape"));
    write("bun.lock", '{ "lockfileVersion": 1, "packages": {} }');
    const message = await call(runTests, { runner: "bun", paths: ["escape/x.test.ts"] });
    expect(message).toContain("outside the workspace root");
  });

  test("an absolute path outside the workspace is refused", async () => {
    const message = await call(symbolOutline, { file: join(outside, "secret.ts") });
    expect(message).toContain("outside the workspace root");
  });

  test("a symlink pointing out of the workspace is refused", async () => {
    writeFileSync(join(outside, "secret.ts"), "export const key = 'value';\n");
    symlinkSync(outside, join(workspace, "escape"));
    const message = await call(symbolOutline, { file: "escape/secret.ts" });
    expect(message).toContain("outside the workspace root");
  });

  test("a file that does not exist is a sentence, not a throw", async () => {
    const message = await call(symbolOutline, { file: "nope.ts" });
    expect(message).toContain("not an existing file");
  });
});

// ---------------------------------------------------------------------------

describe("project and dependency tools", () => {
  beforeEach(() => {
    write(
      "package.json",
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        scripts: { test: "bun test", build: "tsc -b" },
        dependencies: { zod: "^4.0.0", left: "^1.0.0" },
        devDependencies: { typescript: "~5.4.0" },
      }),
    );
    write(
      "bun.lock",
      '{\n  "lockfileVersion": 1,\n  "packages": {\n    "zod": ["zod@3.23.8", "", {}, "sha512-x"],\n    "typescript": ["typescript@5.4.5", "", {}, "sha512-y"],\n  },\n}',
    );
  });

  test("DependencyList reads the manifest and can attach locked versions", async () => {
    const result = await callJson(dependencyList, { includeLocked: true });
    expect(result["manifests"]).toEqual(["package.json"]);
    const deps = result["dependencies"] as Array<Record<string, unknown>>;
    expect(deps.map((d) => d["name"])).toEqual(["left", "typescript", "zod"]);
    expect(deps.find((d) => d["name"] === "zod")?.["locked"]).toEqual(["3.23.8"]);
  });

  test("DependencyList filters by scope", async () => {
    const result = await callJson(dependencyList, { scopes: ["dev"] });
    expect(
      (result["dependencies"] as Array<Record<string, unknown>>).map((d) => d["name"]),
    ).toEqual(["typescript"]);
  });

  test("DependencyOutdated reports drift and missing entries, and hits no network", async () => {
    const result = await callJson(dependencyOutdated, {});
    expect(result["ok"]).toBe(false);
    expect((result["drifted"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "zod",
      range: "^4.0.0",
      locked: ["3.23.8"],
    });
    expect((result["missingFromLock"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      name: "left",
    });
    expect(String(result["method"])).toContain("no registry is contacted");
  });

  test("DependencyOutdated says so when there is no readable lockfile", async () => {
    rmSync(join(workspace, "bun.lock"));
    const message = await call(dependencyOutdated, {});
    expect(message).toContain("no readable lockfile");
  });

  test("a binary bun.lockb is called out rather than silently ignored", async () => {
    rmSync(join(workspace, "bun.lock"));
    write("bun.lockb", "not really binary, but the name is what matters");
    const message = await call(dependencyOutdated, {});
    expect(message).toContain("bun.lockb");
  });

  test("PackageScripts returns the command that would actually run", async () => {
    const result = await callJson(packageScripts, {});
    expect(result["packageManager"]).toBe("bun");
    const scripts = result["scripts"] as Array<Record<string, unknown>>;
    expect(scripts.map((s) => s["name"])).toEqual(["build", "test"]);
    expect(scripts[0]?.["run"]).toBe("bun run build");
  });

  test("PackageScripts names the scripts that do exist when one does not", async () => {
    const message = await call(packageScripts, { name: "deploy" });
    expect(message).toContain("no script named");
    expect(message).toContain("build, test");
  });

  test("WorkspacePackages lists members and their internal edges", async () => {
    write(
      "package.json",
      JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    );
    write("packages/core/package.json", JSON.stringify({ name: "@demo/core", version: "1.0.0" }));
    write(
      "packages/app/package.json",
      JSON.stringify({
        name: "@demo/app",
        version: "1.0.0",
        dependencies: { "@demo/core": "workspace:*", zod: "^3" },
      }),
    );
    write("packages/../other/package.json", JSON.stringify({ name: "@demo/outside" }));
    const result = await callJson(workspacePackages, {});
    const packages = result["packages"] as Array<Record<string, unknown>>;
    expect(packages.map((p) => p["name"])).toEqual(["@demo/app", "@demo/core"]);
    expect(packages[0]?.["dependsOn"]).toEqual(["@demo/core"]);
    expect(result["cycles"]).toEqual([]);
  });

  test("WorkspacePackages says when a directory is not a monorepo root", async () => {
    const message = await call(workspacePackages, {});
    expect(message).toContain("does not look like a monorepo root");
  });
});

describe("CoverageSummary", () => {
  test("finds a report, orders it worst-first and totals it", async () => {
    write(
      "coverage/lcov.info",
      [
        "SF:src/a.ts",
        "LF:4",
        "LH:1",
        "end_of_record",
        "SF:src/b.ts",
        "LF:2",
        "LH:2",
        "end_of_record",
      ].join("\n"),
    );
    const result = await callJson(coverageSummary, {});
    expect(result["format"]).toBe("lcov");
    const files = result["files"] as Array<Record<string, unknown>>;
    expect(files.map((f) => f["file"])).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result["total"]).toEqual({ covered: 3, total: 6, pct: 50 });
  });

  test("a threshold filters to the files under it", async () => {
    write(
      "coverage/coverage-summary.json",
      JSON.stringify({
        total: { lines: { total: 4, covered: 3, pct: 75 } },
        "src/a.ts": { lines: { total: 2, covered: 1, pct: 50 } },
        "src/b.ts": { lines: { total: 2, covered: 2, pct: 100 } },
      }),
    );
    const result = await callJson(coverageSummary, { below: 80 });
    expect((result["files"] as Array<Record<string, unknown>>).map((f) => f["file"])).toEqual([
      "src/a.ts",
    ]);
  });

  test("no report is a sentence saying where it looked", async () => {
    const message = await call(coverageSummary, {});
    expect(message).toContain("found no coverage report");
    expect(message).toContain("coverage/lcov.info");
  });

  test("`file` is read relative to `cwd`, like every other path field", async () => {
    write("sub/lcov.info", "SF:src/a.ts\nLF:4\nLH:1\nend_of_record\n");
    const result = await callJson(coverageSummary, { cwd: "sub", file: "lcov.info" });
    expect(result["report"]).toBe("sub/lcov.info");
    expect(result["total"]).toEqual({ covered: 1, total: 4, pct: 25 });
  });

  test("a report outside the workspace is refused", async () => {
    writeFileSync(join(outside, "lcov.info"), "SF:x\nend_of_record\n");
    const message = await call(coverageSummary, { file: join(outside, "lcov.info") });
    expect(message).toContain("outside the workspace root");
  });
});

describe("StackTraceParse", () => {
  test("classifies frames and points at the first project one", async () => {
    const result = await callJson(stackTraceParse, {
      trace: [
        "TypeError: boom",
        "    at inner (/repo/node_modules/dep/a.js:1:1)",
        "    at outer (/repo/src/b.ts:9:4)",
      ].join("\n"),
      projectRoot: "/repo",
    });
    expect(result["error"]).toBe("TypeError: boom");
    expect(result["firstProjectFrame"]).toBe(1);
    expect(result["byKind"]).toEqual({ project: 1, dependency: 1, runtime: 0, unknown: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("toolchain detection", () => {
  test("a cargo project's linter and formatter refuse path arguments", () => {
    write("Cargo.toml", '[package]\nname = "demo"\n');
    const linter = detectLint(workspace, workspace);
    expect(linter).toMatchObject({ tool: "clippy", acceptsPaths: false });
    const formatter = detectFormat(workspace, workspace, false);
    expect(formatter).toMatchObject({ tool: "rustfmt", acceptsPaths: false });
  });

  test("gofmt is detected without a baked-in path, so filters can be added", () => {
    write("go.mod", "module example/x\ngo 1.22\n");
    const formatter = detectFormat(workspace, workspace, true);
    expect(formatter).toMatchObject({ tool: "gofmt" });
    expect((formatter as { argv: string[] }).argv).toEqual(["gofmt", "-w"]);
  });

  test("a configured node tool with no local install is reported as missing", () => {
    write("biome.json", "{}");
    const linter = detectLint(workspace, workspace);
    expect(isMissing(linter)).toBe(true);
  });

  test("the package manager comes from the lockfile", () => {
    write("pnpm-lock.yaml", "lockfileVersion: 9\n");
    expect(detectPackageManager(workspace, workspace)).toBe("pnpm");
  });

  test("a vitest dependency beats a bun lockfile", () => {
    write("package.json", JSON.stringify({ name: "x", devDependencies: { vitest: "^1.0.0" } }));
    write("bun.lock", '{ "lockfileVersion": 1, "packages": {} }');
    const runner = detectTests(workspace, workspace);
    // vitest is not installed here, so the answer is "missing vitest" rather
    // than a silent fall-through to `bun test`, which would run the wrong thing.
    expect(isMissing(runner)).toBe(true);
  });
});

describe("safety flags", () => {
  test("every spawning tool declares its process capability and external scope", () => {
    const spawning = [
      "RunTests",
      "RunBuild",
      "Typecheck",
      "Lint",
      "Format",
      "FormatCheck",
      "Diagnostics",
    ];
    for (const name of spawning) {
      const tool = CODE_TOOLS.find((t) => t.name === name);
      expect({ name, scope: tool?.scope, io: tool?.ioCapability }).toEqual({
        name,
        scope: "external",
        io: "process",
      });
    }
  });

  test("the file-only tools stay internal and declare no io capability", () => {
    const internal = [
      "AstQuery",
      "SymbolOutline",
      "FindReferences",
      "ImportGraph",
      "DeadFileScan",
      "TodoScan",
      "DependencyList",
      "DependencyOutdated",
      "PackageScripts",
      "WorkspacePackages",
      "CoverageSummary",
      "StackTraceParse",
      "TestFailureSummary",
    ];
    for (const name of internal) {
      const tool = CODE_TOOLS.find((t) => t.name === name);
      expect({
        name,
        scope: tool?.scope,
        io: tool?.ioCapability,
        readOnly: tool?.readOnly,
      }).toEqual({
        name,
        scope: "internal",
        io: undefined,
        readOnly: true,
      });
    }
  });

  test("the tools that run or rewrite code are marked destructive", () => {
    for (const name of ["RunTests", "RunBuild", "Format"]) {
      expect({ name, destructive: CODE_TOOLS.find((t) => t.name === name)?.destructive }).toEqual({
        name,
        destructive: true,
      });
    }
  });

  test("no tool requires justification, because none has an outward side effect", () => {
    expect(CODE_TOOLS.filter((t) => t.requireJustification).map((t) => t.name)).toEqual([]);
  });

  test("every description's second sentence tells a model when to use it", () => {
    for (const tool of CODE_TOOLS) {
      const sentences = tool.description.split(/(?<=\.)\s+/);
      expect({ name: tool.name, starts: sentences[1]?.startsWith("Use ") }).toEqual({
        name: tool.name,
        starts: true,
      });
    }
  });

  test("names are PascalCase and the export list is frozen and complete", () => {
    expect(Object.isFrozen(CODE_TOOLS)).toBe(true);
    expect(CODE_TOOLS).toHaveLength(20);
    for (const tool of CODE_TOOLS) expect(tool.name).toMatch(/^[A-Z][A-Za-z]+$/);
    expect([...CODE_TOOLS].map((t) => t.name)).toEqual(
      [...CODE_TOOLS].map((t) => t.name).sort((a, b) => (a < b ? -1 : 1)),
    );
  });
});
