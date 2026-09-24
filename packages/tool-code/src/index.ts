/**
 * @crewhaus/tool-code — deterministic code intelligence, build and test.
 *
 * Most of these tools drive a project's OWN toolchain rather than
 * reimplementing it: the value is not a second type checker, it is turning
 * the noisy, human-facing output of the real one into structured JSON a
 * harness can decide on without a model reading it. A green test run should
 * cost three lines of context, not three thousand.
 *
 * Four rules run through the whole file.
 *
 *   - Containment. Every caller-supplied path goes through `./paths`
 *     `resolveSafe` and is refused if it escapes the workspace root, symlinks
 *     included.
 *   - Argument safety. Nothing reaches a shell — argv is always an ARRAY —
 *     and every caller value that lands in argv as a bare word is refused if
 *     it begins with `-`, or placed after a `--` terminator, or joined to its
 *     flag with `=`. See `checkOptionSafe` in `./run` for why.
 *   - Boundedness. Every spawn has a deadline and an output cap enforced as
 *     the pipe is READ, and every listing has a limit with an explicit
 *     `truncated` flag. Memory is bounded, not just the returned bytes.
 *   - Determinism. Same inputs against the same project, same bytes out.
 *     Every listing is sorted with plain `<` rather than `localeCompare`, and
 *     nothing reports a timestamp or a duration the caller did not ask for.
 *
 * The scanning tools (`AstQuery`, `SymbolOutline`, `FindReferences`,
 * `ImportGraph`, `DeadFileScan`) are LEXICAL. They read code with the scanner
 * in `./lib/scan`, which has no parser and no type information. Each tool's
 * description says what that costs; `./lib/scan`'s header lists every syntax
 * it does not handle. A tool that overstates its coverage is worse than one
 * that is narrow and says so.
 */
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  detectBuild,
  detectFormat,
  detectLint,
  detectPackageManager,
  detectTests,
  detectTypecheck,
  isMissing,
  localBinary,
  nearestManifest,
  scriptArgv,
} from "./detect";
import { parseIstanbulSummary, parseLcov, totalOf, worstFirst } from "./lib/coverage";
import {
  type Dependency,
  type LockedVersion,
  matchWorkspaceGlob,
  parseCargoToml,
  parseGoMod,
  parseLockfileDetailed,
  parsePackageJson,
  parsePyproject,
  parseRequirementsTxt,
  satisfies,
} from "./lib/deps";
import {
  type Diagnostic,
  countBySeverity,
  parseAnyDiagnostics,
  parseBiomeJson,
  parseEslintJson,
  parseGenericDiagnostics,
  parseRuffJson,
  parseTsc,
  sortDiagnostics,
} from "./lib/diagnostics";
import { buildImportGraph, stronglyConnected, unreferencedFiles } from "./lib/graph";
import {
  DEFAULT_TODO_MARKERS,
  type Declaration,
  findOccurrences,
  hasNestedRepetition,
  scanDeclarations,
  scanExports,
  scanImports,
  scanTodos,
} from "./lib/scan";
import { parseStackTrace } from "./lib/stack";
import { type RunnerName, parseTestOutput, relativizeFailures } from "./lib/tests";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  type RunResult,
  checkArgv,
  checkOptionSafe,
  displayCommand,
  json,
  relPosix,
  resolveDir,
  resolveDirOrFile,
  resolveFile,
  runProcess,
  spawnFailure,
  tailLines,
  truncationNote,
} from "./run";
import {
  DEFAULT_MAX_FILES,
  MAX_FILE_BYTES,
  SOURCE_EXTENSIONS,
  fileExists,
  readTextFile,
  walkFiles,
} from "./walk";

// ---------------------------------------------------------------------------
// shared schema fragments

const cwdField = z
  .string()
  .optional()
  .describe("directory inside the workspace to work in; defaults to the working directory");

const timeoutField = z
  .number()
  .int()
  .positive()
  .max(MAX_TIMEOUT_MS)
  .optional()
  .describe(`milliseconds before the command is killed; default ${DEFAULT_TIMEOUT_MS}`);

/**
 * The explicit-argv escape hatch, for when detection cannot work a project out.
 *
 * It appears ONLY on the tools marked `destructive` (`RunTests`, `RunBuild`,
 * `Format`). Spawning a program the caller names is arbitrary execution, and
 * the permission engine auto-allows a `readOnly` tool in auto mode and allows
 * it outright in plan mode — so `Typecheck`, `Lint` and `FormatCheck` do not
 * take one, and stay reads that a permission engine can believe.
 */
const commandField = z
  .array(z.string().min(1))
  .min(1)
  .max(64)
  .optional()
  .describe("explicit argv to run instead of the detected command; the first element is a program");

const maxFilesField = z
  .number()
  .int()
  .positive()
  .max(20_000)
  .optional()
  .describe(`most files to visit; default ${DEFAULT_MAX_FILES}`);

const extensionsField = z
  .array(z.string().min(2).max(10))
  .max(20)
  .optional()
  .describe("file extensions to scan, with the dot; defaults to the JS/TS family");

/**
 * Safety flags for a tool that spawns a program but asks it only to report:
 * a type check with `--noEmit`, a linter without `--fix`. Spawning is still
 * crossing a process boundary, so `scope`/`ioCapability` say so. Never
 * concurrency-safe: two type checks racing on one `.tsbuildinfo` is exactly
 * the contention the flag exists to prevent.
 *
 * NOT `readOnly` (0.7.1, permission-integration#7). None of these accepts a
 * caller-supplied `command` — the program is worked out from the project's
 * own files by `./detect` — but that program IS the project's:
 * `node_modules/.bin/eslint`, an `eslint.config.js`, a TypeScript plugin. All
 * of it is code the workspace supplies, and plan mode runs every read-only
 * tool without asking, so a read-only checker was a way to run a cloned
 * repository's code during a plan. The rule for the whole registry is in
 * apps/cli/src/flag-rules.test.ts: a read-only tool may spawn only a program
 * the tool itself fixes. Not `destructive` either: a checker is not expected
 * to change anything, so auto mode still runs it without asking, as before.
 */
const READ_SPAWN = {
  readOnly: false,
  concurrencySafe: false,
  scope: "external",
  ioCapability: "process",
} as const;

/**
 * Safety flags for a tool that spawns a program which writes: a formatter, a
 * build, a test run (whose suites run arbitrary project code and may write
 * anything at all — calling that read-only would be a lie a permission engine
 * would believe).
 */
const WRITE_SPAWN = {
  destructive: true,
  concurrencySafe: false,
  scope: "external",
  ioCapability: "process",
} as const;

/** Safety flags for a tool that only reads files in the workspace. */
const READ_FILES = { readOnly: true, concurrencySafe: true } as const;

// ---------------------------------------------------------------------------
// shared helpers

/** Trim a list to a limit and say so, rather than returning a silent prefix. */
function capList<T>(items: readonly T[], limit: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, limit), truncated: items.length > limit };
}

/** Most diagnostics any one call returns. */
const MAX_DIAGNOSTICS = 300;
/** Most failures any one test call returns. */
const DEFAULT_MAX_FAILURES = 20;
/** Most raw output lines returned when a parser recognised nothing. */
const RAW_TAIL_LINES = 25;

/**
 * What to tell a caller who has nowhere left to go.
 *
 * The three read-only checkers take no `command`, so pointing them at one
 * would be advice that cannot be followed; they are pointed at the
 * destructive tool that does take one instead.
 */
const escapeHatch = (toolName: string): string =>
  TAKES_COMMAND.has(toolName)
    ? "Pass `command` with an explicit argv."
    : `${toolName} deliberately takes no explicit command — it is marked read-only, and a read-only tool that spawned a caller-named program would be auto-allowed by the permission engine. Install the tool, or use RunBuild with \`command\`, which is marked destructive for exactly this reason.`;

/** The tools that accept a caller-supplied argv. Every one is `destructive`. */
const TAKES_COMMAND: ReadonlySet<string> = new Set(["RunTests", "RunBuild", "Format"]);

/** The sentence for a detected-but-missing toolchain binary. */
const missingSentence = (toolName: string, pkg: string): string =>
  `${toolName} found this project's configuration for "${pkg}" but no local install (nothing in node_modules/.bin). Install it. It is deliberately not downloaded on the fly. ${escapeHatch(toolName)}`;

/** The sentence for "nothing detected and nothing supplied". */
const undetectedSentence = (toolName: string, what: string, dir: string): string =>
  `${toolName} could not work out how this project runs its ${what} from "${dir}" — no recognised configuration file, manifest script or lockfile. ${escapeHatch(toolName)}`;

type Resolution =
  | {
      readonly ok: true;
      readonly argv: string[];
      readonly tool: string;
      readonly reason: string;
      /** False for a command that refuses path arguments (the cargo family). */
      readonly acceptsPaths: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Turn "explicit command or detection" into one argv, with the argument-safety
 * check applied to whichever won. Every spawning tool starts here.
 */
function resolveToolchain(
  toolName: string,
  what: string,
  explicit: readonly string[] | undefined,
  detected:
    | { argv: readonly string[]; tool: string; reason: string; acceptsPaths?: boolean }
    | { missing: string }
    | undefined,
  requested: string,
): Resolution {
  if (explicit !== undefined) {
    // Belt and braces: the schema of a read-only tool has no `command` field,
    // so this is unreachable through the runtime's validator. It is here so a
    // future edit that adds the field back fails loudly instead of quietly
    // reopening arbitrary execution behind a `readOnly` flag.
    if (!TAKES_COMMAND.has(toolName)) {
      return {
        ok: false,
        message: `${toolName} does not accept an explicit command: it is marked read-only, and a read-only tool that spawned a caller-named program would be auto-allowed by the permission engine.`,
      };
    }
    const bad = checkArgv(toolName, explicit);
    if (bad !== undefined) return { ok: false, message: bad.message };
    return {
      ok: true,
      argv: [...explicit],
      tool: "explicit",
      reason: "caller-supplied command",
      acceptsPaths: true,
    };
  }
  if (detected === undefined) {
    return { ok: false, message: undetectedSentence(toolName, what, requested) };
  }
  if (isMissing(detected)) {
    return { ok: false, message: missingSentence(toolName, detected.missing) };
  }
  return {
    ok: true,
    argv: [...detected.argv],
    tool: detected.tool,
    reason: detected.reason,
    acceptsPaths: detected.acceptsPaths ?? true,
  };
}

/**
 * What a lint/format command should be pointed at.
 *
 * The caller's paths go after a `--` terminator — they have already been
 * refused for a leading `-`, and the terminator means a future version of the
 * tool that learns a flag of the same name still reads them as paths. With no
 * paths, a detected command is pointed at `.`; a command the caller wrote is
 * left exactly as they wrote it, and a command that takes no path arguments
 * at all (the cargo family) is given none.
 */
function targets(
  resolution: { tool: string; acceptsPaths: boolean },
  paths: readonly string[],
): string[] {
  if (!resolution.acceptsPaths) return [];
  if (paths.length > 0) return ["--", ...paths];
  return resolution.tool === "explicit" ? [] : ["."];
}

/**
 * The common tail of every spawn result: what ran, how it ended.
 *
 * `command` is reported relative to the workspace root, because a detected
 * node tool is an absolute path into `node_modules/.bin` and echoing it
 * verbatim would put this machine's home directory in the record — and make
 * the same call against the same project return different bytes elsewhere.
 */
function runSummary(run: RunResult, tool: string, reason: string): Record<string, unknown> {
  return {
    tool,
    detectedBy: reason,
    command: displayCommand(run.argv, path.resolve(process.cwd())),
    exitCode: run.code,
    ...(run.truncated ? { outputTruncated: true, note: truncationNote(run) } : {}),
  };
}

// ---------------------------------------------------------------------------
// tests

const runnerEnum = z.enum(["bun", "vitest", "jest", "pytest", "go", "cargo", "auto"]);

function runnerFor(tool: string): RunnerName | "auto" {
  switch (tool) {
    case "bun":
    case "vitest":
    case "jest":
    case "pytest":
    case "go":
    case "cargo":
      return tool;
    default:
      return "auto";
  }
}

/**
 * Add the caller's filters to a runner's argv.
 *
 * Every value here has already been refused if it begins with `-`. Name
 * patterns are additionally joined to their flag with `=` where the runner
 * supports it, so even a future value that slipped the check cannot become a
 * separate option, and path filters go last, after a `--` terminator for the
 * runners that honour one.
 */
function withFilters(
  argv: string[],
  runner: RunnerName | "auto",
  namePattern: string | undefined,
  paths: readonly string[],
): string[] {
  const out = [...argv];
  if (namePattern !== undefined) {
    switch (runner) {
      case "bun":
        out.push(`--test-name-pattern=${namePattern}`);
        break;
      case "vitest":
      case "jest":
        out.push(`--testNamePattern=${namePattern}`);
        break;
      case "go":
        out.push(`-run=${namePattern}`);
        break;
      case "pytest":
        out.push("-k", namePattern);
        break;
      case "cargo":
        break;
      default:
        break;
    }
  }
  if (paths.length > 0) {
    // `--` first: after it, a value is positional to every runner here even
    // if a future version learns a flag of the same name.
    out.push("--", ...paths);
  }
  return out;
}

/**
 * The directory a test run happened in, in both spellings it can have.
 *
 * macOS reaches its temporary directory through a symlink (`/var` to
 * `/private/var`), so a runner may print either form; both are offered so a
 * path under the workspace is shortened whichever one it used.
 */
function workspaceRoots(): string[] {
  const cwd = process.cwd();
  try {
    const real = realpathSync(cwd);
    return real === cwd ? [cwd] : [cwd, real];
  } catch {
    return [cwd];
  }
}

export const runTests: RegisteredTool = buildTool({
  name: "RunTests",
  operativeArgs: [
    { field: "cwd", kind: "path", default: "." },
    { field: "command", kind: "command" },
  ],
  description:
    "Run the project's test suite and return only what failed, as structured JSON: the test name, the failing assertion, its file and line, and a trimmed stack. Use it instead of running a test command and reading the output, because a green run comes back as three counts rather than thousands of lines. The runner is detected from the project (bun, vitest, jest, pytest, go, cargo) or given explicitly, and each one is asked for its machine-readable form. Running tests executes the project's own code, so it is not a read-only operation.",
  inputSchema: z.object({
    cwd: cwdField,
    command: commandField,
    runner: runnerEnum.optional().describe("force a runner instead of detecting one"),
    namePattern: z.string().max(400).optional().describe("only tests whose name matches"),
    paths: z
      .array(z.string().min(1))
      .max(64)
      .optional()
      .describe("limit the run to these test files, relative to `cwd`"),
    maxFailures: z.number().int().positive().max(500).optional(),
    includeRawOutput: z
      .boolean()
      .optional()
      .describe("include a tail of the raw output even when parsing succeeded"),
    timeout: timeoutField,
  }),
  ...WRITE_SPAWN,
  execute: async (input, ctx) => {
    const dir = resolveDir("RunTests", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());

    const paths = input.paths ?? [];
    const bad = checkOptionSafe("RunTests", [input.namePattern, ...paths], "filter");
    if (bad !== undefined) return bad.message;
    for (const candidate of paths) {
      const inside = resolveFile("RunTests", path.join(relPosix(root, dir.value), candidate));
      if (!inside.ok) return inside.message;
    }

    const detected =
      input.runner === undefined || input.runner === "auto"
        ? detectTests(dir.value, root)
        : forcedRunner(input.runner, dir.value, root);
    const resolution = resolveToolchain(
      "RunTests",
      "tests",
      input.command,
      detected,
      input.cwd ?? ".",
    );
    if (!resolution.ok) return resolution.message;

    const runner: RunnerName | "auto" =
      input.runner !== undefined && input.runner !== "auto"
        ? input.runner
        : runnerFor(resolution.tool);
    const argv =
      input.command === undefined
        ? withFilters(resolution.argv, runner, input.namePattern, paths)
        : [...resolution.argv, ...(paths.length > 0 ? ["--", ...paths] : [])];

    const run = await runProcess(argv, {
      cwd: dir.value,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const failed = spawnFailure("RunTests", run);
    if (failed !== undefined) return failed;

    // stdout first: a JSON reporter writes there and stderr may hold a
    // warning that would confuse the parse. Falling back to both catches bun
    // and pytest, which report on stderr.
    let outcome = parseTestOutput(run.stdout, runner);
    if (!outcome.parsed) outcome = parseTestOutput(`${run.stdout}\n${run.stderr}`, runner);
    // Runners print the failing file however they like — absolute on one
    // platform, relative on another. Report the path a caller would open.
    outcome = relativizeFailures(outcome, workspaceRoots());

    const capped = capList(outcome.failures, input.maxFailures ?? DEFAULT_MAX_FAILURES);
    // The raw tail is also included when the run counted failures but the
    // parser recovered no record for any of them — which is what a suite that
    // threw while LOADING looks like under bun, whose count block is printed
    // even though no `(fail)` line ever was. "2 failed" with an empty list
    // and nothing else would leave a caller with no way forward.
    const failuresWithoutDetail = outcome.failed > 0 && outcome.failures.length === 0;
    const tail =
      !outcome.parsed || failuresWithoutDetail || input.includeRawOutput === true
        ? tailLines(`${run.stdout}\n${run.stderr}`, RAW_TAIL_LINES)
        : undefined;

    return json({
      ...runSummary(run, resolution.tool, resolution.reason),
      runner: outcome.runner,
      ok: run.code === 0 && outcome.failed === 0,
      passed: outcome.passed,
      failed: outcome.failed,
      skipped: outcome.skipped,
      total: outcome.total,
      failures: capped.items,
      ...(capped.truncated ? { failuresTruncated: true } : {}),
      ...(outcome.parsed
        ? {}
        : {
            parsed: false,
            parseNote:
              "the runner's output did not match any known reporter — the raw tail is included instead",
          }),
      ...(tail === undefined ? {} : { rawTail: tail }),
    });
  },
});

/** Argv for a runner the caller named rather than one detected from files. */
function forcedRunner(
  runner: Exclude<z.infer<typeof runnerEnum>, "auto">,
  dir: string,
  root: string,
): { argv: string[]; tool: string; reason: string } | { missing: string } {
  switch (runner) {
    case "bun":
      return { argv: ["bun", "test"], tool: "bun", reason: "runner requested by the caller" };
    case "vitest": {
      const binary = localBinary(dir, root, "vitest");
      return binary === undefined
        ? { missing: "vitest" }
        : {
            argv: [binary, "run", "--reporter=json", "--silent"],
            tool: "vitest",
            reason: "runner requested by the caller",
          };
    }
    case "jest": {
      const binary = localBinary(dir, root, "jest");
      return binary === undefined
        ? { missing: "jest" }
        : {
            argv: [binary, "--json", "--silent"],
            tool: "jest",
            reason: "runner requested by the caller",
          };
    }
    case "pytest":
      return {
        argv: ["python3", "-m", "pytest", "-q", "--no-header", "-rf", "--tb=short"],
        tool: "pytest",
        reason: "runner requested by the caller",
      };
    case "go":
      return {
        argv: ["go", "test", "-json", "./..."],
        tool: "go",
        reason: "runner requested by the caller",
      };
    case "cargo":
      return {
        argv: ["cargo", "test", "--quiet"],
        tool: "cargo",
        reason: "runner requested by the caller",
      };
  }
}

export const testFailureSummary: RegisteredTool = buildTool({
  name: "TestFailureSummary",
  description:
    "Extract just the failures from test output you already have, as structured JSON. Use it on a stored CI log or a previous run's output to get the failing tests, assertions and locations without a model reading the whole log. It runs nothing and touches no files; the runner is named or inferred from the text's own shape.",
  inputSchema: z.object({
    output: z.string().max(8_000_000).describe("the captured test output"),
    runner: runnerEnum.optional().describe("which runner produced it; inferred when omitted"),
    maxFailures: z.number().int().positive().max(500).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const outcome = relativizeFailures(
      parseTestOutput(input.output, input.runner ?? "auto"),
      workspaceRoots(),
    );
    const capped = capList(outcome.failures, input.maxFailures ?? DEFAULT_MAX_FAILURES);
    return json({
      runner: outcome.runner,
      parsed: outcome.parsed,
      passed: outcome.passed,
      failed: outcome.failed,
      skipped: outcome.skipped,
      total: outcome.total,
      failures: capped.items,
      ...(capped.truncated ? { failuresTruncated: true } : {}),
      ...(outcome.parsed
        ? {}
        : {
            parseNote:
              "no known runner's output was recognised — name the runner explicitly, or check that the text is a test log",
          }),
    });
  },
});

// ---------------------------------------------------------------------------
// build, typecheck, lint, format

/**
 * Parse a run's output with the parser that matches the tool that produced it,
 * falling back to the generic line reader rather than returning nothing.
 *
 * `root` is the directory the command ran in, which is what the tools print
 * their paths relative to (or absolutely under), so diagnostics come back
 * workspace-relative either way.
 */
function parseFor(tool: string, run: RunResult, root: string): Diagnostic[] {
  const both = `${run.stdout}\n${run.stderr}`;
  switch (tool) {
    case "tsc":
      return parseTsc(both, root);
    case "biome":
      return parseBiomeJson(run.stdout, root) ?? parseGenericDiagnostics(both, "biome", root);
    case "eslint":
      return parseEslintJson(run.stdout, root) ?? parseGenericDiagnostics(both, "eslint", root);
    case "ruff":
      return parseRuffJson(run.stdout, root) ?? parseGenericDiagnostics(both, "ruff", root);
    case "mypy":
    case "go-vet":
    case "clippy":
      return parseGenericDiagnostics(both, tool, root);
    default:
      return parseAnyDiagnostics(both, root);
  }
}

/** Shape a diagnostic list into the result body every diagnostic tool returns. */
function diagnosticsBody(diagnostics: readonly Diagnostic[]): Record<string, unknown> {
  const sorted = sortDiagnostics(diagnostics);
  const capped = capList(sorted, MAX_DIAGNOSTICS);
  const counts = countBySeverity(sorted);
  return {
    errors: counts.error,
    warnings: counts.warning,
    infos: counts.info,
    diagnostics: capped.items,
    ...(capped.truncated
      ? {
          diagnosticsTruncated: true,
          diagnosticsNote: `only the first ${MAX_DIAGNOSTICS} of ${sorted.length} are returned, sorted by file and line — fix these and run again`,
        }
      : {}),
  };
}

export const runBuild: RegisteredTool = buildTool({
  name: "RunBuild",
  operativeArgs: [
    { field: "cwd", kind: "path", default: "." },
    { field: "command", kind: "command" },
  ],
  description:
    "Build the project and return structured diagnostics instead of the build log: file, line, column, severity, rule and message. Use it to find out whether a change compiles and, when it does not, exactly where — without a model reading a compiler's output. The command comes from the project (a build script, cargo, go, tsc) or is given explicitly. A build writes its own output, so this is not a read-only operation.",
  inputSchema: z.object({
    cwd: cwdField,
    command: commandField,
    timeout: timeoutField,
    includeRawOutput: z.boolean().optional().describe("include a tail of the raw output as well"),
  }),
  ...WRITE_SPAWN,
  execute: async (input, ctx) => {
    const dir = resolveDir("RunBuild", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());
    const resolution = resolveToolchain(
      "RunBuild",
      "build",
      input.command,
      detectBuild(dir.value, root),
      input.cwd ?? ".",
    );
    if (!resolution.ok) return resolution.message;

    const run = await runProcess(resolution.argv, {
      cwd: dir.value,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const failed = spawnFailure("RunBuild", run);
    if (failed !== undefined) return failed;

    const diagnostics = parseFor(resolution.tool, run, dir.value);
    const body = diagnosticsBody(diagnostics);
    const tail =
      run.code !== 0 && (diagnostics.length === 0 || input.includeRawOutput === true)
        ? tailLines(`${run.stdout}\n${run.stderr}`, RAW_TAIL_LINES)
        : undefined;
    return json({
      ...runSummary(run, resolution.tool, resolution.reason),
      ok: run.code === 0,
      ...body,
      ...(tail === undefined ? {} : { rawTail: tail }),
    });
  },
});

export const typecheck: RegisteredTool = buildTool({
  name: "Typecheck",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Type-check the project and return the errors as structured diagnostics with file, line, column and code. Use it after an edit to learn whether the types still hold, in a form a harness can act on directly. The checker is the one this project configures, always run in no-emit mode so nothing is written, and there is no way to point this tool at a different program — that is what keeps it a read; RunBuild is where an arbitrary command belongs.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
  }),
  ...READ_SPAWN,
  execute: async (input, ctx) => {
    const dir = resolveDir("Typecheck", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());
    const resolution = resolveToolchain(
      "Typecheck",
      "type checking",
      undefined,
      detectTypecheck(dir.value, root),
      input.cwd ?? ".",
    );
    if (!resolution.ok) return resolution.message;

    const run = await runProcess(resolution.argv, {
      cwd: dir.value,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const failed = spawnFailure("Typecheck", run);
    if (failed !== undefined) return failed;

    const diagnostics = parseFor(resolution.tool, run, dir.value);
    const body = diagnosticsBody(diagnostics);
    return json({
      ...runSummary(run, resolution.tool, resolution.reason),
      ok: run.code === 0,
      ...body,
      ...(run.code !== 0 && diagnostics.length === 0
        ? { rawTail: tailLines(`${run.stdout}\n${run.stderr}`, RAW_TAIL_LINES) }
        : {}),
    });
  },
});

export const lint: RegisteredTool = buildTool({
  name: "Lint",
  operativeArgs: [{ field: "paths", kind: "path", within: "cwd", default: "." }],
  description:
    "Run the project's linter and return its findings as structured diagnostics with file, line, column, rule and message. Use it to check a change against the project's own rules without reading a linter's framed, coloured output. The linter is the one this project configures and is never passed a fix flag, so nothing is rewritten and no caller can substitute another program — Format is the tool that writes.",
  inputSchema: z.object({
    cwd: cwdField,
    paths: z
      .array(z.string().min(1))
      .max(64)
      .optional()
      .describe("limit to these files or directories, relative to `cwd`"),
    timeout: timeoutField,
  }),
  ...READ_SPAWN,
  execute: async (input, ctx) => {
    const dir = resolveDir("Lint", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());
    const paths = input.paths ?? [];
    const bad = checkOptionSafe("Lint", paths, "path");
    if (bad !== undefined) return bad.message;
    for (const candidate of paths) {
      const inside = resolveDirOrFile("Lint", path.join(relPosix(root, dir.value), candidate));
      if (!inside.ok) return inside.message;
    }
    const resolution = resolveToolchain(
      "Lint",
      "linting",
      undefined,
      detectLint(dir.value, root),
      input.cwd ?? ".",
    );
    if (!resolution.ok) return resolution.message;

    const argv = [...resolution.argv, ...targets(resolution, paths)];
    const run = await runProcess(argv, {
      cwd: dir.value,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const failed = spawnFailure("Lint", run);
    if (failed !== undefined) return failed;

    const diagnostics = parseFor(resolution.tool, run, dir.value);
    return json({
      ...runSummary(run, resolution.tool, resolution.reason),
      ok: run.code === 0,
      ...diagnosticsBody(diagnostics),
    });
  },
});

export const format: RegisteredTool = buildTool({
  name: "Format",
  operativeArgs: [
    { field: "paths", kind: "path", within: "cwd", default: "." },
    { field: "command", kind: "command" },
  ],
  description:
    "Rewrite files with the project's own formatter and report what it did. Use it after generating or editing code so the result matches the project's style without a model reproducing that style by hand. This tool WRITES: it is the only one here that changes source files, and FormatCheck is the read-only counterpart.",
  inputSchema: z.object({
    cwd: cwdField,
    command: commandField,
    paths: z
      .array(z.string().min(1))
      .max(64)
      .optional()
      .describe("limit to these files or directories, relative to `cwd`"),
    timeout: timeoutField,
  }),
  ...WRITE_SPAWN,
  execute: async (input, ctx) => {
    const dir = resolveDir("Format", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());
    const paths = input.paths ?? [];
    const bad = checkOptionSafe("Format", paths, "path");
    if (bad !== undefined) return bad.message;
    for (const candidate of paths) {
      const inside = resolveDirOrFile("Format", path.join(relPosix(root, dir.value), candidate));
      if (!inside.ok) return inside.message;
    }
    const resolution = resolveToolchain(
      "Format",
      "formatting",
      input.command,
      detectFormat(dir.value, root, true),
      input.cwd ?? ".",
    );
    if (!resolution.ok) return resolution.message;

    const argv = [...resolution.argv, ...targets(resolution, paths)];
    const run = await runProcess(argv, {
      cwd: dir.value,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const failed = spawnFailure("Format", run);
    if (failed !== undefined) return failed;

    return json({
      ...runSummary(run, resolution.tool, resolution.reason),
      ok: run.code === 0,
      // Formatters report what they rewrote in their own words and none of
      // them agrees on the wording, so the summary lines are passed through
      // rather than parsed into a shape that would be wrong for the next one.
      summary: tailLines(`${run.stdout}\n${run.stderr}`, 10),
    });
  },
});

/**
 * Files a formatter says are not formatted.
 *
 * Each formatter announces this its own way, so the parse is keyed on which
 * one ran — and it can be, because neither caller of this function can be
 * handed a formatter the project did not configure: `FormatCheck` and
 * `Diagnostics` both take their command from `./detect` alone.
 */
function unformattedFiles(tool: string, run: RunResult, root: string): string[] {
  const text = `${run.stdout}\n${run.stderr}`;
  if (tool === "biome") {
    const parsed = parseBiomeJson(run.stdout, root);
    if (parsed !== undefined && parsed.length > 0) {
      return [...new Set(parsed.map((d) => d.file))].sort();
    }
  }
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (tool === "prettier") {
      // `[warn] path` per file, then a `[warn] Code style issues…` summary
      // line that names no file and must not be read as one.
      const m = /^\[warn\]\s+(.*)$/.exec(line);
      if (m !== null && !/^Code style issues/.test(m[1] as string)) {
        out.add(m[1] as string);
        continue;
      }
    }
    if (tool === "gofmt" || tool === "rustfmt") {
      if (/^[\w./-]+\.(go|rs|ts|tsx|js|jsx|py)$/.test(line)) out.add(line);
    }
  }
  return [...out].sort();
}

export const formatCheck: RegisteredTool = buildTool({
  name: "FormatCheck",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Ask the project's formatter which files are not formatted, without changing any of them. Use it as a gate before committing, or to decide whether Format needs to run at all. It returns the file list rather than a diff, because the diff is the formatter's job to produce and nobody needs it in context to make the decision; the formatter is the one this project configures and cannot be swapped for another program.",
  inputSchema: z.object({
    cwd: cwdField,
    timeout: timeoutField,
  }),
  ...READ_SPAWN,
  execute: async (input, ctx) => {
    const dir = resolveDir("FormatCheck", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());
    const resolution = resolveToolchain(
      "FormatCheck",
      "formatting",
      undefined,
      detectFormat(dir.value, root, false),
      input.cwd ?? ".",
    );
    if (!resolution.ok) return resolution.message;

    const argv = [...resolution.argv, ...targets(resolution, [])];
    const run = await runProcess(argv, {
      cwd: dir.value,
      timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
      ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    const failed = spawnFailure("FormatCheck", run);
    if (failed !== undefined) return failed;

    const files = unformattedFiles(resolution.tool, run, dir.value);
    const capped = capList(files, 200);
    return json({
      ...runSummary(run, resolution.tool, resolution.reason),
      formatted: run.code === 0,
      unformattedCount: files.length,
      unformatted: capped.items,
      ...(capped.truncated ? { unformattedTruncated: true } : {}),
      ...(run.code !== 0 && files.length === 0
        ? { rawTail: tailLines(`${run.stdout}\n${run.stderr}`, RAW_TAIL_LINES) }
        : {}),
    });
  },
});

export const diagnostics: RegisteredTool = buildTool({
  name: "Diagnostics",
  operativeArgs: [{ field: "cwd", kind: "path", default: "." }],
  description:
    "Run the project's type checker, linter and formatter check and return every finding in ONE normalized shape: file, line, column, severity, rule, message, source. Use it as the single 'is this code healthy' call, so a harness decides on one schema instead of three tools' formats. Each step is skipped, with a reason, when the project has no configuration for it, `timeout` is the budget for the whole call rather than for each step, and nothing is written.",
  inputSchema: z.object({
    cwd: cwdField,
    include: z
      .array(z.enum(["typecheck", "lint", "format"]))
      .min(1)
      .max(3)
      .optional()
      .describe("which checks to run; all three when omitted"),
    timeout: timeoutField,
  }),
  ...READ_SPAWN,
  execute: async (input, ctx) => {
    const dir = resolveDir("Diagnostics", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());
    const include = input.include ?? ["typecheck", "lint", "format"];
    // One budget for the whole call, not one per step: three steps each given
    // the caller's `timeout` would let a `timeout` of 15 minutes cost 45.
    const budgetMs = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + budgetMs;

    const collected: Diagnostic[] = [];
    const steps: Array<Record<string, unknown>> = [];

    for (const step of include) {
      const detected =
        step === "typecheck"
          ? detectTypecheck(dir.value, root)
          : step === "lint"
            ? detectLint(dir.value, root)
            : detectFormat(dir.value, root, false);
      if (detected === undefined) {
        steps.push({ step, ran: false, reason: "no configuration for it in this project" });
        continue;
      }
      if (isMissing(detected)) {
        steps.push({ step, ran: false, reason: `"${detected.missing}" is not installed locally` });
        continue;
      }
      const argv =
        step === "typecheck" || detected.acceptsPaths === false
          ? [...detected.argv]
          : [...detected.argv, "."];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        steps.push({
          step,
          ran: false,
          reason: `the \`timeout\` of ${budgetMs}ms was spent by the earlier steps — raise it, or ask for one step at a time with \`include\``,
        });
        continue;
      }
      const run = await runProcess(argv, {
        cwd: dir.value,
        timeoutMs: remaining,
        ...(ctx?.signal !== undefined ? { signal: ctx.signal } : {}),
      });
      const failed = spawnFailure("Diagnostics", run);
      if (failed !== undefined) {
        steps.push({ step, ran: false, reason: failed });
        continue;
      }
      const found =
        step === "format"
          ? unformattedFiles(detected.tool, run, dir.value).map(
              (file): Diagnostic => ({
                file,
                line: 0,
                column: 0,
                severity: "warning",
                rule: "format",
                message: "file is not formatted",
                source: detected.tool,
              }),
            )
          : parseFor(detected.tool, run, dir.value);
      collected.push(...found);
      steps.push({
        step,
        ran: true,
        tool: detected.tool,
        exitCode: run.code,
        findings: found.length,
      });
    }

    const body = diagnosticsBody(collected);
    return json({
      // "ok" is about errors: a warning is a finding to read, not a gate.
      ok: countBySeverity(collected).error === 0,
      steps,
      ...body,
    });
  },
});

// ---------------------------------------------------------------------------
// lexical code intelligence

/** Total characters of source one scanning call will hold at once. */
const MAX_SCAN_CHARS = 20_000_000;

type SourceFile = {
  /** Path relative to the directory being scanned: the graph tools resolve
   * specifiers against this, so it has to be consistent among themselves. */
  readonly rel: string;
  /** Path relative to the WORKSPACE root: what a caller can open next. */
  readonly workspacePath: string;
  readonly text: string;
};

type Collected = {
  readonly files: readonly SourceFile[];
  /** True when the file or byte ceiling stopped the scan early. */
  readonly truncated: boolean;
  /** Files skipped for being too large or not text. */
  readonly skipped: readonly string[];
};

/**
 * Read every source file under a directory, bounded by count and by total
 * bytes. The byte bound is the one that matters: a file ceiling alone still
 * lets a hundred two-megabyte bundles into memory at once.
 */
function collectSources(
  dirAbs: string,
  extensions: readonly string[],
  maxFiles: number,
): Collected {
  const walked = walkFiles({ root: dirAbs, extensions, maxFiles });
  const root = path.resolve(process.cwd());
  const files: SourceFile[] = [];
  const skipped: string[] = [];
  let total = 0;
  let truncated = walked.truncated;
  for (const rel of walked.files) {
    const abs = path.join(dirAbs, rel);
    const text = readTextFile(abs, MAX_FILE_BYTES);
    if (text === undefined) {
      skipped.push(rel);
      continue;
    }
    if (total + text.length > MAX_SCAN_CHARS) {
      truncated = true;
      break;
    }
    total += text.length;
    files.push({ rel, workspacePath: relPosix(root, abs), text });
  }
  return { files, truncated, skipped };
}

const declarationKinds = z.enum([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "namespace",
  "variable",
  "method",
  "property",
  "accessor",
]);

export const astQuery: RegisteredTool = buildTool({
  name: "AstQuery",
  description:
    "Find declarations across a directory by kind, name or export status, with the line span of each one. Use it to answer 'where is X defined' or 'what classes are in this package' without reading files into context. It is a lexical SCANNER, not a parser: it reads code with comments and strings masked out, and it does not understand JSX bodies, destructured declarations, classes nested inside functions, or computed member names — see the package README for the full list. A `pattern` that nests one repetition inside another is refused rather than run.",
  inputSchema: z.object({
    cwd: cwdField,
    kinds: z.array(declarationKinds).max(10).optional().describe("only these kinds"),
    name: z.string().max(200).optional().describe("exact declaration name"),
    pattern: z.string().max(400).optional().describe("JavaScript regular expression over names"),
    exportedOnly: z.boolean().optional(),
    includeMembers: z.boolean().optional().describe("include class members; default true"),
    extensions: extensionsField,
    maxFiles: maxFilesField,
    maxResults: z.number().int().positive().max(5_000).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("AstQuery", input.cwd);
    if (!dir.ok) return dir.message;
    let matcher: RegExp | undefined;
    if (input.pattern !== undefined) {
      // Refused before it is compiled: this pattern is run against every
      // declaration name in the tree, and a JavaScript regular expression
      // cannot be interrupted once it has started, so there is no deadline to
      // fall back on. See `hasNestedRepetition`.
      if (hasNestedRepetition(input.pattern)) {
        return `AstQuery refused the pattern /${input.pattern}/: it repeats a group that itself repeats or branches (\`(a+)+\`, \`(a|a)*\`), which can take exponential time on an ordinary identifier and cannot be interrupted once it starts. Rewrite it without the nested repetition — \`^(get|set)\` rather than \`^(get|set)+\`.`;
      }
      try {
        matcher = new RegExp(input.pattern);
      } catch (err) {
        return `AstQuery could not use the pattern /${input.pattern}/: ${(err as Error).message}`;
      }
    }
    const collected = collectSources(
      dir.value,
      input.extensions ?? SOURCE_EXTENSIONS,
      input.maxFiles ?? DEFAULT_MAX_FILES,
    );
    const kinds = input.kinds === undefined ? undefined : new Set<string>(input.kinds);
    const includeMembers = input.includeMembers ?? true;
    const results: Array<Record<string, unknown>> = [];
    for (const file of collected.files) {
      for (const decl of scanDeclarations(file.text)) {
        if (!includeMembers && decl.parent !== undefined) continue;
        if (kinds !== undefined && !kinds.has(decl.kind)) continue;
        if (input.name !== undefined && decl.name !== input.name) continue;
        if (matcher !== undefined && !matcher.test(decl.name)) continue;
        if (input.exportedOnly === true && !decl.exported) continue;
        results.push({
          file: file.workspacePath,
          kind: decl.kind,
          name: decl.name,
          ...(decl.parent === undefined ? {} : { parent: decl.parent }),
          startLine: decl.startLine,
          endLine: decl.endLine,
          exported: decl.exported,
          signature: decl.signature,
        });
      }
    }
    const capped = capList(results, input.maxResults ?? 1_000);
    return json({
      filesScanned: collected.files.length,
      matches: results.length,
      declarations: capped.items,
      ...(capped.truncated ? { resultsTruncated: true } : {}),
      ...(collected.truncated ? { scanTruncated: true } : {}),
      ...(collected.skipped.length === 0 ? {} : { skippedFiles: collected.skipped.length }),
      method: "lexical scan, not a parser",
    });
  },
});

export const symbolOutline: RegisteredTool = buildTool({
  name: "SymbolOutline",
  description:
    "List what one file declares — functions, classes and their members, types, exports — with each declaration's line range. Use it instead of reading a large file whole: the outline says what is there and the line ranges say which part to read next. Lexical, with the same limits as AstQuery.",
  inputSchema: z.object({
    file: z.string().min(1).describe("path to the file, relative to the workspace root"),
    includeMembers: z.boolean().optional().describe("include class members; default true"),
    includeImports: z.boolean().optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const file = resolveFile("SymbolOutline", input.file);
    if (!file.ok) return file.message;
    const text = readTextFile(file.value, MAX_FILE_BYTES);
    if (text === undefined) {
      return `SymbolOutline could not read "${input.file}": it is larger than ${MAX_FILE_BYTES} bytes, or it is not a text file.`;
    }
    const includeMembers = input.includeMembers ?? true;
    const declarations = scanDeclarations(text).filter(
      (d: Declaration) => includeMembers || d.parent === undefined,
    );
    const exports = scanExports(text);
    return json({
      file: relPosix(path.resolve(process.cwd()), file.value),
      lines: text.split("\n").length,
      declarations: declarations.map((d) => ({
        kind: d.kind,
        name: d.name,
        ...(d.parent === undefined ? {} : { parent: d.parent }),
        startLine: d.startLine,
        endLine: d.endLine,
        exported: d.exported,
        signature: d.signature,
      })),
      exports: exports.map((e) => ({
        name: e.name,
        kind: e.kind,
        line: e.line,
        ...(e.from === undefined ? {} : { from: e.from }),
      })),
      ...(input.includeImports === true
        ? {
            imports: scanImports(text).map((i) => ({
              specifier: i.specifier,
              line: i.line,
              kind: i.kind,
              typeOnly: i.typeOnly,
              names: i.names,
            })),
          }
        : {}),
      method: "lexical scan, not a parser",
    });
  },
});

export const findReferences: RegisteredTool = buildTool({
  name: "FindReferences",
  description:
    "Find every mention of an identifier across a directory, with file and line, skipping comments and string literals. Use it before renaming or deleting something, to see what would break. It is LEXICAL, not semantic: it matches the characters, so a local variable of the same name, a property on an unrelated object, and a shadowed binding all appear, and a name reached through an aliased import does not.",
  inputSchema: z.object({
    name: z
      .string()
      .min(1)
      .max(200)
      .describe("the identifier to look for; must be a plain identifier, not a pattern"),
    cwd: cwdField,
    extensions: extensionsField,
    maxFiles: maxFilesField,
    maxResults: z.number().int().positive().max(5_000).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input.name)) {
      return `FindReferences refused "${input.name}": it takes a plain identifier, not a pattern or an expression. Use AstQuery's \`pattern\` to search declaration names by regex.`;
    }
    const dir = resolveDir("FindReferences", input.cwd);
    if (!dir.ok) return dir.message;
    const collected = collectSources(
      dir.value,
      input.extensions ?? SOURCE_EXTENSIONS,
      input.maxFiles ?? DEFAULT_MAX_FILES,
    );
    const hits: Array<Record<string, unknown>> = [];
    for (const file of collected.files) {
      if (!file.text.includes(input.name)) continue; // cheap reject before masking
      for (const occurrence of findOccurrences(file.text, input.name)) {
        hits.push({
          file: file.workspacePath,
          line: occurrence.line,
          column: occurrence.column,
          text: occurrence.text,
        });
      }
    }
    const capped = capList(hits, input.maxResults ?? 500);
    const fileCount = new Set(hits.map((h) => h["file"])).size;
    return json({
      name: input.name,
      filesScanned: collected.files.length,
      matches: hits.length,
      filesWithMatches: fileCount,
      references: capped.items,
      ...(capped.truncated ? { resultsTruncated: true } : {}),
      ...(collected.truncated ? { scanTruncated: true } : {}),
      method: "lexical scan; comments and strings excluded, scope not resolved",
    });
  },
});

export const importGraph: RegisteredTool = buildTool({
  name: "ImportGraph",
  description:
    "Build the module import graph for a directory and report its edges, its external dependencies and any cycles. Use it to see how a package hangs together, or to find the import cycle behind an initialisation bug, without opening every file. Relative specifiers are resolved against the files on disk; bare specifiers are reported as external rather than resolved through node_modules.",
  inputSchema: z.object({
    cwd: cwdField,
    extensions: extensionsField,
    maxFiles: maxFilesField,
    includeEdges: z.boolean().optional().describe("include every edge; default true"),
    includeExternal: z.boolean().optional().describe("include bare specifiers; default true"),
    maxEdges: z.number().int().positive().max(20_000).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("ImportGraph", input.cwd);
    if (!dir.ok) return dir.message;
    const collected = collectSources(
      dir.value,
      input.extensions ?? SOURCE_EXTENSIONS,
      input.maxFiles ?? DEFAULT_MAX_FILES,
    );
    const graph = buildImportGraph(
      collected.files.map((file) => ({
        file: file.rel,
        imports: scanImports(file.text).map((i) => ({ specifier: i.specifier, line: i.line })),
      })),
    );
    const edges = capList(graph.edges, input.maxEdges ?? 2_000);
    const external = capList(graph.external, 500);
    return json({
      // Graph paths are relative to the scanned directory, because that is
      // what the specifiers themselves resolve against.
      directory: relPosix(path.resolve(process.cwd()), dir.value),
      files: graph.files.length,
      edgeCount: graph.edges.length,
      cycleCount: graph.cycles.length,
      cycles: graph.cycles.slice(0, 50),
      ...(input.includeEdges === false
        ? {}
        : {
            edges: edges.items.map((e) => ({ from: e.from, to: e.to })),
            ...(edges.truncated ? { edgesTruncated: true } : {}),
          }),
      ...(input.includeExternal === false
        ? {}
        : {
            external: external.items.map((e) => ({
              specifier: e.specifier,
              importers: e.importedBy.length,
            })),
            ...(external.truncated ? { externalTruncated: true } : {}),
          }),
      unresolvedCount: graph.unresolved.length,
      unresolved: graph.unresolved.slice(0, 100),
      ...(collected.truncated ? { scanTruncated: true } : {}),
      method: "lexical scan; static, dynamic and require specifiers, resolved on disk",
    });
  },
});

/** Files a dead-file scan never reports, because something outside imports them. */
function isConventionalEntry(file: string): boolean {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (!file.includes("/") && /^index\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/\.d\.[cm]?ts$/.test(base)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (/^(main|index|cli|server|worker|setup)\.[cm]?[jt]sx?$/.test(base) && !file.includes("/")) {
    return true;
  }
  return /\.config\.[cm]?[jt]s$/.test(base);
}

export const deadFileScan: RegisteredTool = buildTool({
  name: "DeadFileScan",
  description:
    "List the files in a directory that nothing else in it imports. Use it to find leftovers after a refactor, as a list to REVIEW rather than a list to delete. It is import-based and therefore blind to anything loaded by a computed path, referenced from HTML or a config, discovered by filename convention, or imported from outside the scanned directory; entry points, type declarations, tests and config files are excluded by convention.",
  inputSchema: z.object({
    cwd: cwdField,
    entries: z
      .array(z.string().min(1))
      .max(200)
      .optional()
      .describe("additional entry points, relative to `cwd`, never reported as dead"),
    extensions: extensionsField,
    maxFiles: maxFilesField,
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("DeadFileScan", input.cwd);
    if (!dir.ok) return dir.message;
    const collected = collectSources(
      dir.value,
      input.extensions ?? SOURCE_EXTENSIONS,
      input.maxFiles ?? DEFAULT_MAX_FILES,
    );
    const graph = buildImportGraph(
      collected.files.map((file) => ({
        file: file.rel,
        imports: scanImports(file.text).map((i) => ({ specifier: i.specifier, line: i.line })),
      })),
    );
    const explicit = new Set((input.entries ?? []).map((e) => e.replace(/^\.\//, "")));
    const dead = unreferencedFiles(
      graph,
      (file) => explicit.has(file) || isConventionalEntry(file),
    );
    const capped = capList(dead, 500);
    return json({
      directory: relPosix(path.resolve(process.cwd()), dir.value),
      filesScanned: graph.files.length,
      unreferencedCount: dead.length,
      unreferenced: capped.items,
      ...(capped.truncated ? { resultsTruncated: true } : {}),
      ...(collected.truncated ? { scanTruncated: true } : {}),
      method:
        "import-based: a file loaded by a computed path, from HTML, or from outside this directory looks unreferenced here",
    });
  },
});

export const todoScan: RegisteredTool = buildTool({
  name: "TodoScan",
  description:
    "Collect TODO, FIXME, HACK and XXX notes from the comments in a directory, with file, line, author and text. Use it to turn the notes scattered through a codebase into a list that can be triaged. Markers inside string literals are ignored, so a fixture containing the word TODO is not reported as a note.",
  inputSchema: z.object({
    cwd: cwdField,
    markers: z
      .array(z.string().min(2).max(20))
      .max(10)
      .optional()
      .describe(`markers to look for; defaults to ${DEFAULT_TODO_MARKERS.join(", ")}`),
    author: z.string().max(80).optional().describe("only notes attributed to this author"),
    extensions: extensionsField,
    maxFiles: maxFilesField,
    maxResults: z.number().int().positive().max(5_000).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("TodoScan", input.cwd);
    if (!dir.ok) return dir.message;
    const markers = input.markers ?? DEFAULT_TODO_MARKERS;
    const collected = collectSources(
      dir.value,
      input.extensions ?? SOURCE_EXTENSIONS,
      input.maxFiles ?? DEFAULT_MAX_FILES,
    );
    const notes: Array<Record<string, unknown>> = [];
    const byMarker: Record<string, number> = {};
    for (const file of collected.files) {
      for (const todo of scanTodos(file.text, markers)) {
        if (input.author !== undefined && todo.author !== input.author) continue;
        byMarker[todo.marker] = (byMarker[todo.marker] ?? 0) + 1;
        notes.push({
          file: file.workspacePath,
          line: todo.line,
          column: todo.column,
          marker: todo.marker,
          ...(todo.author === undefined ? {} : { author: todo.author }),
          text: todo.text,
        });
      }
    }
    const capped = capList(notes, input.maxResults ?? 500);
    return json({
      filesScanned: collected.files.length,
      count: notes.length,
      byMarker,
      notes: capped.items,
      ...(capped.truncated ? { resultsTruncated: true } : {}),
      ...(collected.truncated ? { scanTruncated: true } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// dependencies and project shape

type LockSource = { readonly file: string; readonly locked: readonly LockedVersion[] };

/** Read whichever lockfiles are present, plus a note for the unreadable one. */
function readLocks(dirAbs: string): { sources: LockSource[]; notes: string[] } {
  const sources: LockSource[] = [];
  const notes: string[] = [];
  const add = (name: string): void => {
    const text = readTextFile(path.join(dirAbs, name));
    if (text === undefined) return;
    // The filename-to-reader mapping lives in `deps.ts` and only there, so a
    // format cannot end up half-added — read by one caller and invisible to
    // the next. These tools use the narrow half of what comes back; the wide
    // half is for the packages that go to a registry with an entry.
    const locked = parseLockfileDetailed(name, text);
    if (locked === undefined) return;
    sources.push({ file: name, locked });
  };
  add("bun.lock");
  add("package-lock.json");
  add("yarn.lock");
  add("pnpm-lock.yaml");
  add("Cargo.lock");
  if (fileExists(path.join(dirAbs, "bun.lockb"))) {
    notes.push(
      "bun.lockb is bun's BINARY lockfile and cannot be read here; run `bun install --save-text-lockfile` to get a bun.lock this tool can read",
    );
  }
  return { sources, notes };
}

/** Every manifest present in a directory, read into one dependency list. */
function readManifests(dirAbs: string): { dependencies: Dependency[]; manifests: string[] } {
  const dependencies: Dependency[] = [];
  const manifests: string[] = [];
  const pkg = readTextFile(path.join(dirAbs, "package.json"));
  if (pkg !== undefined) {
    const parsed = parsePackageJson(pkg);
    if (parsed !== undefined) {
      dependencies.push(...parsed.dependencies);
      manifests.push("package.json");
    }
  }
  for (const name of ["requirements.txt", "requirements-dev.txt"]) {
    const text = readTextFile(path.join(dirAbs, name));
    if (text === undefined) continue;
    dependencies.push(...parseRequirementsTxt(text, name));
    manifests.push(name);
  }
  const pyproject = readTextFile(path.join(dirAbs, "pyproject.toml"));
  if (pyproject !== undefined) {
    dependencies.push(...parsePyproject(pyproject));
    manifests.push("pyproject.toml");
  }
  const gomod = readTextFile(path.join(dirAbs, "go.mod"));
  if (gomod !== undefined) {
    dependencies.push(...parseGoMod(gomod));
    manifests.push("go.mod");
  }
  const cargo = readTextFile(path.join(dirAbs, "Cargo.toml"));
  if (cargo !== undefined) {
    dependencies.push(...parseCargoToml(cargo));
    manifests.push("Cargo.toml");
  }
  return { dependencies, manifests: manifests.sort() };
}

export const dependencyList: RegisteredTool = buildTool({
  name: "DependencyList",
  description:
    "Read a project's manifests and return its declared dependencies as one list: name, declared range, scope and ecosystem. Use it to answer 'what does this depend on' across package.json, requirements.txt, pyproject.toml, go.mod and Cargo.toml without opening any of them. Nothing is installed and no registry is contacted; the answer comes from the files on disk.",
  inputSchema: z.object({
    cwd: cwdField,
    scopes: z
      .array(z.enum(["prod", "dev", "peer", "optional", "build"]))
      .max(5)
      .optional()
      .describe("only these dependency scopes"),
    ecosystems: z
      .array(z.enum(["npm", "pypi", "go", "cargo"]))
      .max(4)
      .optional(),
    includeLocked: z.boolean().optional().describe("attach the version the lockfile resolved"),
    maxResults: z.number().int().positive().max(5_000).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("DependencyList", input.cwd);
    if (!dir.ok) return dir.message;
    const { dependencies, manifests } = readManifests(dir.value);
    if (manifests.length === 0) {
      return `DependencyList found no manifest in "${input.cwd ?? "."}" — no package.json, requirements.txt, pyproject.toml, go.mod or Cargo.toml.`;
    }
    const scopes = input.scopes === undefined ? undefined : new Set<string>(input.scopes);
    const ecosystems =
      input.ecosystems === undefined ? undefined : new Set<string>(input.ecosystems);
    const filtered = dependencies.filter(
      (d) =>
        (scopes === undefined || scopes.has(d.scope)) &&
        (ecosystems === undefined || ecosystems.has(d.ecosystem)),
    );
    const locks = input.includeLocked === true ? readLocks(dir.value) : undefined;
    const lockIndex = new Map<string, string[]>();
    for (const source of locks?.sources ?? []) {
      for (const entry of source.locked) {
        const versions = lockIndex.get(entry.name) ?? [];
        if (!versions.includes(entry.version)) versions.push(entry.version);
        lockIndex.set(entry.name, versions);
      }
    }
    const capped = capList(filtered, input.maxResults ?? 1_000);
    const byScope: Record<string, number> = {};
    for (const dep of filtered) byScope[dep.scope] = (byScope[dep.scope] ?? 0) + 1;
    return json({
      manifests,
      count: filtered.length,
      byScope,
      dependencies: capped.items.map((d) => ({
        name: d.name,
        range: d.range,
        scope: d.scope,
        ecosystem: d.ecosystem,
        source: d.source,
        ...(lockIndex.has(d.name) ? { locked: (lockIndex.get(d.name) as string[]).sort() } : {}),
      })),
      ...(capped.truncated ? { resultsTruncated: true } : {}),
      ...(locks !== undefined && locks.notes.length > 0 ? { notes: locks.notes } : {}),
    });
  },
});

export const dependencyOutdated: RegisteredTool = buildTool({
  name: "DependencyOutdated",
  description:
    "Compare a project's declared dependency ranges against what its lockfile actually resolved, and report the drift: ranges no locked version satisfies, dependencies missing from the lock, and packages locked at several versions at once. Use it to tell whether the lockfile is stale relative to the manifests before trusting an install. Two limits, both of which it reports: it NEVER contacts a registry, so it cannot say a newer version exists upstream, and it compares only npm and cargo, because bun.lock, package-lock.json, yarn.lock, pnpm-lock.yaml and Cargo.lock are the lockfiles it reads — a Python or Go dependency is counted as unchecked rather than declared fine.",
  inputSchema: z.object({
    cwd: cwdField,
    includeUncheckable: z
      .boolean()
      .optional()
      .describe("include ranges this tool cannot evaluate, such as workspace: or git specs"),
    maxResults: z.number().int().positive().max(2_000).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("DependencyOutdated", input.cwd);
    if (!dir.ok) return dir.message;
    const { dependencies, manifests } = readManifests(dir.value);
    if (manifests.length === 0) {
      return `DependencyOutdated found no manifest in "${input.cwd ?? "."}".`;
    }
    const { sources, notes } = readLocks(dir.value);
    if (sources.length === 0) {
      return `DependencyOutdated found no readable lockfile in "${input.cwd ?? "."}"${notes.length > 0 ? ` (${notes.join("; ")})` : ""}. Without one there is nothing to compare the manifests against.`;
    }
    const lockIndex = new Map<string, Set<string>>();
    for (const source of sources) {
      for (const entry of source.locked) {
        const versions = lockIndex.get(entry.name) ?? new Set<string>();
        versions.add(entry.version);
        lockIndex.set(entry.name, versions);
      }
    }
    const drifted: Array<Record<string, unknown>> = [];
    const missing: Array<Record<string, unknown>> = [];
    const uncheckable: Array<Record<string, unknown>> = [];
    let notComparedCount = 0;
    for (const dep of dependencies) {
      if (dep.ecosystem !== "npm" && dep.ecosystem !== "cargo") {
        // No lockfile reader for this ecosystem, so there is nothing to
        // compare against. Counted rather than dropped: silence here would
        // read as "checked and fine".
        notComparedCount += 1;
        continue;
      }
      const versions = lockIndex.get(dep.name);
      if (versions === undefined || versions.size === 0) {
        missing.push({ name: dep.name, range: dep.range, scope: dep.scope, source: dep.source });
        continue;
      }
      const sorted = [...versions].sort();
      let satisfied: boolean | undefined = false;
      for (const version of sorted) {
        const result = satisfies(version, dep.range);
        if (result === undefined) {
          satisfied = undefined;
          break;
        }
        if (result) {
          satisfied = true;
          break;
        }
      }
      if (satisfied === undefined) {
        uncheckable.push({ name: dep.name, range: dep.range, locked: sorted });
        continue;
      }
      if (!satisfied) {
        drifted.push({ name: dep.name, range: dep.range, locked: sorted, scope: dep.scope });
      }
    }
    const duplicates = [...lockIndex.entries()]
      .filter(([, versions]) => versions.size > 1)
      .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));

    const limit = input.maxResults ?? 200;
    return json({
      manifests,
      lockfiles: sources.map((s) => s.file),
      ok: drifted.length === 0 && missing.length === 0,
      driftedCount: drifted.length,
      drifted: drifted.slice(0, limit),
      missingFromLockCount: missing.length,
      missingFromLock: missing.slice(0, limit),
      duplicateVersionsCount: duplicates.length,
      duplicateVersions: duplicates.slice(0, limit),
      ...(input.includeUncheckable === true
        ? { uncheckable: uncheckable.slice(0, limit) }
        : { uncheckableCount: uncheckable.length }),
      ...(notes.length > 0 ? { notes } : {}),
      // Said in the result, not only in the description: a caller who sees
      // `ok: true` must not read it as "every dependency checked out".
      ecosystemsCompared: ["npm", "cargo"],
      notCompared: notComparedCount,
      method:
        "lockfile comparison only; no registry is contacted, so an available newer release is invisible here, and only npm and cargo have a lockfile reader here — a pypi or go dependency is counted in `notCompared`, never in `ok`",
    });
  },
});

export const packageScripts: RegisteredTool = buildTool({
  name: "PackageScripts",
  description:
    "List the scripts a project declares, with the exact command that would run each one. Use it to find out how a project is built, tested or started before guessing at a command line. The package manager is read from the lockfile, so the command it returns is the one this project actually uses.",
  inputSchema: z.object({
    cwd: cwdField,
    name: z.string().max(200).optional().describe("only this script"),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("PackageScripts", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());
    const found = nearestManifest(dir.value, root);
    if (found === undefined) {
      return `PackageScripts found no package.json at or above "${input.cwd ?? "."}".`;
    }
    const manager = detectPackageManager(found.dir, root);
    const entries = Object.entries(found.manifest.scripts)
      .filter(([name]) => input.name === undefined || name === input.name)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    if (input.name !== undefined && entries.length === 0) {
      return `PackageScripts found no script named "${input.name}" in ${relPosix(root, path.join(found.dir, "package.json"))}. Declared scripts: ${Object.keys(found.manifest.scripts).sort().join(", ") || "none"}.`;
    }
    return json({
      manifest: relPosix(root, path.join(found.dir, "package.json")),
      ...(found.manifest.name === undefined ? {} : { package: found.manifest.name }),
      packageManager: manager,
      count: entries.length,
      scripts: entries.map(([name, command]) => ({
        name,
        command,
        run: scriptArgv(manager, name).join(" "),
      })),
    });
  },
});

export const workspacePackages: RegisteredTool = buildTool({
  name: "WorkspacePackages",
  description:
    "List the packages in a monorepo and how they depend on each other, including any dependency cycles. Use it to find which package owns a name, or which ones a change would ripple into, without walking the tree by hand. Membership comes from the workspaces globs in the root package.json, or from the packages list in pnpm-workspace.yaml; a package outside those globs is not reported.",
  inputSchema: z.object({
    cwd: cwdField,
    includeDependencies: z.boolean().optional().describe("include internal edges; default true"),
    maxPackages: z.number().int().positive().max(5_000).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("WorkspacePackages", input.cwd);
    if (!dir.ok) return dir.message;
    const rootManifestText = readTextFile(path.join(dir.value, "package.json"));
    const rootManifest =
      rootManifestText === undefined ? undefined : parsePackageJson(rootManifestText);
    let globs = rootManifest?.workspaces ?? [];
    if (globs.length === 0) {
      // pnpm keeps the same list in its own file; only the `packages:` list is
      // read, which is all this needs and all a partial YAML read can promise.
      const pnpm = readTextFile(path.join(dir.value, "pnpm-workspace.yaml"));
      if (pnpm !== undefined) {
        globs = [...pnpm.matchAll(/^\s*-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) =>
          (m[1] as string).trim(),
        );
      }
    }
    if (globs.length === 0) {
      return `WorkspacePackages found no workspaces in "${input.cwd ?? "."}" — the root package.json declares none and there is no pnpm-workspace.yaml. This does not look like a monorepo root.`;
    }

    const walked = walkFiles({
      root: dir.value,
      extensions: [".json"],
      maxFiles: 20_000,
      maxDepth: 6,
    });
    const members: Array<{ dir: string; name: string; version?: string; deps: string[] }> = [];
    for (const rel of walked.files) {
      if (!rel.endsWith("package.json") || rel === "package.json") continue;
      const memberDir = rel.slice(0, rel.length - "/package.json".length);
      if (!globs.some((glob) => matchWorkspaceGlob(memberDir, glob))) continue;
      const text = readTextFile(path.join(dir.value, rel));
      if (text === undefined) continue;
      const manifest = parsePackageJson(text);
      if (manifest?.name === undefined) continue;
      members.push({
        dir: memberDir,
        name: manifest.name,
        ...(manifest.version === undefined ? {} : { version: manifest.version }),
        deps: manifest.dependencies.map((d) => d.name),
      });
    }
    members.sort((a, b) => (a.name < b.name ? -1 : 1));
    const names = new Set(members.map((m) => m.name));
    const adjacency = new Map<string, string[]>();
    for (const member of members) {
      adjacency.set(
        member.name,
        [...new Set(member.deps.filter((d) => names.has(d) && d !== member.name))].sort(),
      );
    }
    const capped = capList(members, input.maxPackages ?? 1_000);
    return json({
      workspaces: globs,
      count: members.length,
      packages: capped.items.map((m) => ({
        name: m.name,
        dir: m.dir,
        ...(m.version === undefined ? {} : { version: m.version }),
        ...(input.includeDependencies === false ? {} : { dependsOn: adjacency.get(m.name) ?? [] }),
      })),
      ...(capped.truncated ? { resultsTruncated: true } : {}),
      cycles: stronglyConnected(
        members.map((m) => m.name),
        adjacency,
      ),
    });
  },
});

// ---------------------------------------------------------------------------
// coverage and stacks

const COVERAGE_CANDIDATES = [
  "coverage/coverage-summary.json",
  "coverage/lcov.info",
  "lcov.info",
  "coverage.lcov",
];

export const coverageSummary: RegisteredTool = buildTool({
  name: "CoverageSummary",
  description:
    "Turn a coverage report into per-file percentages, worst-covered first. Use it to find where the tests are thin without reading an lcov file or opening an HTML report. It reads an existing report — lcov.info or istanbul's coverage-summary.json — and never re-runs the tests to produce one.",
  inputSchema: z.object({
    cwd: cwdField,
    file: z
      .string()
      .min(1)
      .optional()
      .describe(
        `the report to read, relative to \`cwd\`; searched for in ${COVERAGE_CANDIDATES.join(", ")} when omitted`,
      ),
    maxFiles: z.number().int().positive().max(2_000).optional(),
    below: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("only files under this line-coverage percentage"),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const dir = resolveDir("CoverageSummary", input.cwd);
    if (!dir.ok) return dir.message;
    const root = path.resolve(process.cwd());
    let reportRel: string | undefined;
    if (input.file !== undefined) {
      // Relative to `cwd`, which is what the fallback search below uses and
      // what every other path field in this package means. Resolving it
      // against the workspace root instead would refuse "lcov.info" for a
      // caller who had just pointed `cwd` at the directory holding it.
      const resolved = resolveFile(
        "CoverageSummary",
        path.join(relPosix(root, dir.value), input.file),
      );
      if (!resolved.ok) return resolved.message;
      reportRel = relPosix(root, resolved.value);
    } else {
      for (const candidate of COVERAGE_CANDIDATES) {
        if (fileExists(path.join(dir.value, candidate))) {
          reportRel = relPosix(root, path.join(dir.value, candidate));
          break;
        }
      }
    }
    if (reportRel === undefined) {
      return `CoverageSummary found no coverage report under "${input.cwd ?? "."}" (looked for ${COVERAGE_CANDIDATES.join(", ")}). Run the tests with coverage enabled first, or pass \`file\`.`;
    }
    const text = readTextFile(path.join(root, reportRel), 20_000_000);
    if (text === undefined) {
      return `CoverageSummary could not read "${reportRel}": it is not a text file, or it is larger than 20MB.`;
    }
    const istanbul = text.trimStart().startsWith("{") ? parseIstanbulSummary(text) : undefined;
    const files = istanbul !== undefined ? [...istanbul.files] : parseLcov(text);
    if (files.length === 0) {
      return `CoverageSummary read "${reportRel}" but found no file records in it — it is neither an lcov report nor an istanbul coverage-summary.json.`;
    }
    const filtered =
      input.below === undefined
        ? files
        : files.filter((f) => f.lines.pct < (input.below as number));
    const ordered = worstFirst(filtered, input.maxFiles ?? 100);
    const total = istanbul?.total ?? totalOf(files);
    return json({
      report: reportRel,
      format: istanbul !== undefined ? "coverage-summary.json" : "lcov",
      fileCount: files.length,
      total: total.lines,
      returned: ordered.length,
      files: ordered.map((f) => ({
        file: f.file,
        lines: f.lines,
        ...(f.functions === undefined ? {} : { functions: f.functions }),
        ...(f.branches === undefined ? {} : { branches: f.branches }),
      })),
    });
  },
});

export const stackTraceParse: RegisteredTool = buildTool({
  name: "StackTraceParse",
  description:
    "Parse a stack trace into structured frames — function, file, line, column — and mark each frame as project code, a dependency or the runtime. Use it to jump straight to the first frame that is actually yours instead of reading sixty frames of framework internals. It handles V8 traces (node, bun, browsers) and CPython tracebacks; JVM, .NET and Go panic traces are not recognised.",
  inputSchema: z.object({
    trace: z.string().min(1).max(2_000_000).describe("the stack trace text"),
    projectRoot: z
      .string()
      .max(400)
      .optional()
      .describe("absolute path prefix that marks project code; defaults to the working directory"),
    maxFrames: z.number().int().positive().max(500).optional(),
  }),
  ...READ_FILES,
  execute: async (input) => {
    const parsed = parseStackTrace(
      input.trace,
      input.projectRoot ?? process.cwd(),
      input.maxFrames ?? 100,
    );
    const counts = { project: 0, dependency: 0, runtime: 0, unknown: 0 };
    for (const frame of parsed.frames) counts[frame.kind] += 1;
    return json({
      ...(parsed.error === undefined ? {} : { error: parsed.error }),
      frameCount: parsed.frames.length,
      byKind: counts,
      firstProjectFrame: parsed.firstProjectFrame,
      frames: parsed.frames.map((frame) => ({
        ...(frame.function === undefined ? {} : { function: frame.function }),
        file: frame.file,
        ...(frame.line === undefined ? {} : { line: frame.line }),
        ...(frame.column === undefined ? {} : { column: frame.column }),
        kind: frame.kind,
      })),
    });
  },
});

// ---------------------------------------------------------------------------

/** Every tool this package registers, in the order a catalog should list them. */
export const CODE_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
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
]);

/**
 * The semver helpers and the lockfile readers, re-exported for other tool
 * packages.
 *
 * `DependencyOutdated` here and `SemverResolve` in `@crewhaus/tool-pkg` both
 * have to answer "does this version satisfy this range?". Two
 * implementations of that would disagree at the edges — prerelease ordering,
 * `^0.x`, wildcard forms — and a harness would get one answer from one tool
 * and another from the next. There is one implementation, and it is here.
 *
 * The same rule holds for the lockfiles, and the `*Detailed` readers are why
 * it can keep holding. A package that needs a dependency's resolved URL or
 * integrity hash — to ask a vulnerability database or a registry about it —
 * takes the wide view of the SAME parse the tools here take the narrow view
 * of, instead of copying a lockfile reader and drifting from this one the
 * first time a format changes.
 */
export {
  LOCKFILE_NAMES,
  type LockEcosystem,
  type LockedDependency,
  type LockedVersion,
  type SemVer,
  compareSemver,
  parseBunLock,
  parseBunLockDetailed,
  parseCargoLock,
  parseCargoLockDetailed,
  parseLockfileDetailed,
  parsePackageLock,
  parsePackageLockDetailed,
  parsePnpmLock,
  parsePnpmLockDetailed,
  parseSemver,
  parseYarnLock,
  parseYarnLockDetailed,
  satisfies,
} from "./lib/deps";
