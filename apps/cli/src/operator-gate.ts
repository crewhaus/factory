/**
 * The CLI's entry points honour the harness's operator record
 * (`.crewhaus/run/control/operator.json`): a verb that runs work with no one at the
 * keyboard refuses while new work is paused (exit 39, unless `--ignore-pause`) or the
 * harness is disabled (exit 38), and a verb that starts a server refuses while it is
 * disabled. The harness is the working directory, as every one of these verbs resolves
 * `.crewhaus` there, and also each other directory holding a spec the verb runs: the spec
 * it is given as its first argument, or for `eval suite` its `--spec`, else each selected
 * entry's spec, resolved as the verb resolves it. Every one of those operator records is
 * checked and the stricter verdict decides (a disable over a pause; the working
 * directory's when they refuse alike).
 *
 * | Verb | Mode |
 * |---|---|
 * | `run --prompt` (or `--input-file`) | run |
 * | `run` otherwise: the REPL, whose person at the keyboard is the operator | interactive |
 * | `eval` on its run path, and `eval suite` | run |
 * | `flywheel run`, `optimize`, `dream run` (and a bare `dream <spec>`) | run |
 * | `serve`, `dev` | start |
 *
 * `daemon submit` checks inside its own verb, and `daemon start|restart` are refused by
 * the supervisor itself. Not gated: `loadtest`, `runs resume`, a `--help` call, and the
 * read-only `eval` branches (`coverage`, `plan`, `leaderboard`, and the report aliases),
 * which this mirrors from the dispatch exactly, its is-it-a-spec-file guard included.
 *
 * The flags that decide (`--help`, `--prompt`, `--ignore-pause`) are read the way the
 * dispatch reads them: the verb's own schema parses the same argv slice the dispatch
 * hands it, so a token that is another flag's value, or comes after `--`, counts for
 * nothing here either. An argv the schema refuses is checked anyway, in the verb's
 * strictest mode: the dispatch dies on the same parse error.
 *
 * Side-effect-free on import: `index.ts` calls {@link gateEntryPoint} once, before its
 * dispatch switch.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import {
  type RunnableMode,
  type RunnableVerdict,
  assertRunnable,
  readOperatorRecord,
} from "@crewhaus/control-records";
import { readSpecHeader } from "@crewhaus/harness-inventory";
import { type ParseArgsSchema, type ParsedArgs, parseArgs } from "@crewhaus/infra-utils";
import {
  DEV_SCHEMA,
  DREAM_CLI_SCHEMA,
  EVAL_SCHEMA,
  EVAL_SUITE_SCHEMA,
  FLYWHEEL_SCHEMA,
  OPTIMIZE_SCHEMA,
  RUN_SCHEMA,
  SERVE_SCHEMA,
} from "./arg-schemas";
import {
  type SuiteEntry,
  type SuiteManifest,
  parseSuiteManifest,
  parseTierFlag,
  selectTier,
  specForEntry,
} from "./eval-suite";

/** What a run that `--ignore-pause` let through prints on stderr. */
export const IGNORE_PAUSE_NOTICE = "Running although new work is paused (--ignore-pause).";

/** The `eval` read verbs the dispatch sends to `eval-report`. */
const EVAL_REPORT_ALIASES = new Set(["history", "baseline", "baselines", "diff"]);

function isSpecFile(cwd: string, p: string): boolean {
  try {
    return statSync(resolve(cwd, p)).isFile();
  } catch {
    return false;
  }
}

/** A gated verb's argv as its dispatch branch parses it: the schema and the slice. */
type Gated = {
  readonly schema: ParseArgsSchema;
  readonly argv: readonly string[];
  /** The mode, from the parsed flags; `undefined` when the parse failed. */
  readonly mode: (parsed: ParsedArgs | undefined) => RunnableMode;
};

const fixed = (mode: RunnableMode) => (): RunnableMode => mode;

/** The dispatch branch a verb takes, or `undefined` when that branch is not gated. */
function gatedBranch(subcommand: string, rest: readonly string[], cwd: string): Gated | undefined {
  switch (subcommand) {
    case "run":
      return {
        schema: RUN_SCHEMA,
        argv: rest,
        // A prompt (or an input file) is a run with no one at the keyboard; without
        // either it is the REPL. An argv that does not parse takes the stricter mode.
        mode: (parsed) =>
          parsed === undefined ||
          typeof parsed.flags["prompt"] === "string" ||
          typeof parsed.flags["input-file"] === "string"
            ? "run"
            : "interactive",
      };
    case "eval": {
      const first = rest[0] ?? "";
      if (first === "coverage") return undefined;
      if (first === "suite" && !isSpecFile(cwd, first)) {
        return { schema: EVAL_SUITE_SCHEMA, argv: rest.slice(1), mode: fixed("run") };
      }
      if (first === "plan" && !isSpecFile(cwd, first)) return undefined;
      if (first === "leaderboard" && !isSpecFile(cwd, first)) return undefined;
      if (EVAL_REPORT_ALIASES.has(first) && !isSpecFile(cwd, first)) return undefined;
      return { schema: EVAL_SCHEMA, argv: rest, mode: fixed("run") };
    }
    case "flywheel":
      return rest[0] === "run"
        ? { schema: FLYWHEEL_SCHEMA, argv: rest.slice(1), mode: fixed("run") }
        : undefined;
    case "optimize":
      return { schema: OPTIMIZE_SCHEMA, argv: rest, mode: fixed("run") };
    case "dream": {
      const first = rest[0];
      const action = first === "run" || first === "status" || first === "init" ? first : "run";
      if (action !== "run") return undefined;
      return {
        schema: DREAM_CLI_SCHEMA,
        argv: first === action ? rest.slice(1) : rest,
        mode: fixed("run"),
      };
    }
    case "serve":
      return { schema: SERVE_SCHEMA, argv: rest, mode: fixed("start") };
    case "dev":
      return { schema: DEV_SCHEMA, argv: rest, mode: fixed("start") };
    default:
      return undefined;
  }
}

/** The verb's argv parsed by its own schema, or `undefined` when the schema refuses it. */
function parsedFor(branch: Gated): ParsedArgs | undefined {
  try {
    return parseArgs(branch.argv, branch.schema);
  } catch {
    return undefined;
  }
}

/** What the gate decides for one invocation: its mode, and whether a pause is lifted. */
function decide(
  subcommand: string,
  rest: readonly string[],
  cwd: string,
): { readonly mode: RunnableMode; readonly ignorePause: boolean } | undefined {
  const branch = gatedBranch(subcommand, rest, cwd);
  if (branch === undefined) return undefined;
  const parsed = parsedFor(branch);
  if (parsed?.flags["help"] === true) return undefined;
  return { mode: branch.mode(parsed), ignorePause: parsed?.flags["ignore-pause"] === true };
}

/**
 * The mode a verb's entry point is checked in, or `undefined` when it is not gated.
 *
 * First consumer: {@link gateEntryPoint}.
 */
export function entryPointMode(
  subcommand: string,
  rest: readonly string[],
  options: { readonly cwd: string },
): RunnableMode | undefined {
  return decide(subcommand, rest, options.cwd)?.mode;
}

/** The harness's name for a refusal: its spec's `name`, else its directory's. */
function harnessName(harnessDir: string): string {
  try {
    const name = readSpecHeader(readFileSync(join(harnessDir, "crewhaus.yaml"), "utf8")).name;
    if (typeof name === "string" && name !== "") return name;
  } catch {
    // No spec here, or one that does not parse: the directory names it.
  }
  return basename(resolve(harnessDir));
}

/**
 * The one line a refused entry point prints.
 *
 * First consumers: {@link gateEntryPoint} and `crewhaus daemon submit`.
 */
export function entryRefusalLine(
  name: string,
  reason: "disabled" | "paused" | "unreadable",
  harnessDir: string,
): string {
  switch (reason) {
    case "disabled":
      return `${name} is disabled by its operator, so this doesn't run. \`crewhaus daemon enable\` allows it again.`;
    case "paused":
      return `New work is paused on ${name}. \`crewhaus daemon resume\` reopens it, or pass --ignore-pause to run this once.`;
    case "unreadable": {
      const read = readOperatorRecord(harnessDir);
      const why = read.state === "unreadable" ? read.reason : "it is not a record";
      return `The operator record can't be read (${why}), so nothing runs here.`;
    }
  }
}

/**
 * The specs an `eval suite` runs, as the verb resolves them: `--spec` when it is given,
 * else the spec of each entry in the selected tier (the entry's, else the manifest's).
 * A manifest the verb cannot read or select from names none: the verb refuses it before
 * any entry runs.
 */
function suiteSpecs(parsed: ParsedArgs, cwd: string): readonly string[] {
  const override = parsed.flags["spec"];
  if (typeof override === "string") return override === "" ? [] : [override];
  const manifestPath = parsed.positional[0];
  if (typeof manifestPath !== "string" || manifestPath === "") return [];
  let entries: ReadonlyArray<SuiteEntry>;
  let manifest: SuiteManifest;
  try {
    manifest = parseSuiteManifest(readFileSync(resolve(cwd, manifestPath), "utf8"));
    const tier = parsed.flags["tier"];
    entries = selectTier(manifest, parseTierFlag(typeof tier === "string" ? tier : undefined));
  } catch {
    return [];
  }
  const specs: string[] = [];
  for (const entry of entries) {
    try {
      specs.push(specForEntry(manifest, entry));
    } catch {
      // An entry with no spec: the verb's preflight refuses the suite before any run.
    }
  }
  return specs;
}

/**
 * The directories, other than `cwd`, of the specs a gated verb runs: the spec it is given
 * as its first positional, or for `eval suite` the specs {@link suiteSpecs} names. Empty
 * when the verb's own schema refuses its argv.
 */
function specDirsOf(subcommand: string, rest: readonly string[], cwd: string): readonly string[] {
  const branch = gatedBranch(subcommand, rest, cwd);
  if (branch === undefined) return [];
  const parsed = parsedFor(branch);
  if (parsed === undefined) return [];
  const specs =
    branch.schema === EVAL_SUITE_SCHEMA ? suiteSpecs(parsed, cwd) : [parsed.positional[0]];
  const here = resolve(cwd);
  const dirs: string[] = [];
  for (const spec of specs) {
    if (typeof spec !== "string" || spec === "") continue;
    const dir = dirname(resolve(cwd, spec));
    if (dir !== here && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Refuse this invocation when the harness's operator record says so: print the line and
 * exit 38 (disabled) or 39 (paused). The working directory's record and the record of
 * each other directory holding a spec the verb runs are all checked; the stricter verdict
 * decides. A run `--ignore-pause` let through prints a notice and goes
 * on. Returns when it may run.
 *
 * First consumer: the dispatch in `index.ts`.
 */
export function gateEntryPoint(
  subcommand: string,
  rest: readonly string[],
  io: {
    readonly cwd: string;
    readonly write: (line: string) => void;
    readonly exit: (code: number) => void;
  },
): void {
  const decided = decide(subcommand, rest, io.cwd);
  if (decided === undefined) return;
  const dirs = [io.cwd, ...specDirsOf(subcommand, rest, io.cwd)];
  let refused:
    | { readonly dir: string; readonly verdict: RunnableVerdict & { ok: false } }
    | undefined;
  let pauseIgnored = false;
  for (const dir of dirs) {
    const verdict = assertRunnable(dir, {
      mode: decided.mode,
      ignorePause: decided.ignorePause,
    });
    if (verdict.ok) {
      if (verdict.pauseIgnored === true) pauseIgnored = true;
      continue;
    }
    // A disable outranks a pause; between equals the first (the working directory) stands.
    if (
      refused === undefined ||
      (refused.verdict.exitName === "paused" && verdict.exitName === "disabled")
    ) {
      refused = { dir, verdict };
    }
  }
  if (refused === undefined) {
    if (pauseIgnored) io.write(`${IGNORE_PAUSE_NOTICE}\n`);
    return;
  }
  io.write(`${entryRefusalLine(harnessName(refused.dir), refused.verdict.reason, refused.dir)}\n`);
  io.exit(EXIT_FOR_ERROR[refused.verdict.exitName]);
}
