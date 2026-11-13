/**
 * The CLI's entry points honour the harness's operator record
 * (`.crewhaus/run/control/operator.json`): a verb that runs work with no one at the
 * keyboard refuses while new work is paused (exit 39, unless `--ignore-pause`) or the
 * harness is disabled (exit 38), and a verb that starts a server refuses while it is
 * disabled. The harness is the working directory, as every one of these verbs resolves
 * `.crewhaus` there.
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
 * the supervisor itself. Not gated: `loadtest`, `runs resume`, any `--help`, and the
 * read-only `eval` branches (`coverage`, `plan`, `leaderboard`, and the report aliases),
 * which this mirrors from the dispatch exactly, its is-it-a-spec-file guard included.
 *
 * Side-effect-free on import: `index.ts` calls {@link gateEntryPoint} once, before its
 * dispatch switch.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { EXIT_FOR_ERROR } from "@crewhaus/control-contract";
import { type RunnableMode, assertRunnable, readOperatorRecord } from "@crewhaus/control-records";
import { readSpecHeader } from "@crewhaus/harness-inventory";

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

function flagged(rest: readonly string[], name: string): boolean {
  return rest.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
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
  if (rest.includes("--help") || rest.includes("-h")) return undefined;
  switch (subcommand) {
    case "run":
      return flagged(rest, "prompt") || flagged(rest, "input-file") ? "run" : "interactive";
    case "eval": {
      const first = rest[0] ?? "";
      if (first === "coverage") return undefined;
      if (first === "suite" && !isSpecFile(options.cwd, first)) return "run";
      if (first === "plan" && !isSpecFile(options.cwd, first)) return undefined;
      if (first === "leaderboard" && !isSpecFile(options.cwd, first)) return undefined;
      if (EVAL_REPORT_ALIASES.has(first) && !isSpecFile(options.cwd, first)) return undefined;
      return "run";
    }
    case "flywheel":
      return rest[0] === "run" ? "run" : undefined;
    case "optimize":
      return "run";
    case "dream": {
      const first = rest[0];
      const action = first === "run" || first === "status" || first === "init" ? first : "run";
      return action === "run" ? "run" : undefined;
    }
    case "serve":
    case "dev":
      return "start";
    default:
      return undefined;
  }
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
 * Refuse this invocation when the harness's operator record says so: print the line and
 * exit 38 (disabled) or 39 (paused). A run `--ignore-pause` let through prints a notice
 * and goes on. Returns when it may run.
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
  const mode = entryPointMode(subcommand, rest, { cwd: io.cwd });
  if (mode === undefined) return;
  const verdict = assertRunnable(io.cwd, { mode, ignorePause: flagged(rest, "ignore-pause") });
  if (verdict.ok) {
    if (verdict.pauseIgnored === true) io.write(`${IGNORE_PAUSE_NOTICE}\n`);
    return;
  }
  io.write(`${entryRefusalLine(harnessName(io.cwd), verdict.reason, io.cwd)}\n`);
  io.exit(EXIT_FOR_ERROR[verdict.exitName]);
}
