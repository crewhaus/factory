/**
 * `crewhaus runs list|show|create|cancel|resume`: a harness's runs, read from its run
 * ledger, and the run commands the control API serves, carried out here through the same
 * control service (each writes its receipt before it acts). `resume` re-drives a parked
 * cli session or run, as it always has.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  CANONICAL_RUN_ID_RE,
  type CursorPosition,
  EXIT_FOR_ERROR,
  type ErrorCode,
  mintRunId,
} from "@crewhaus/control-contract";
import { readPage, runsLedger } from "@crewhaus/control-records";
import {
  type ControlService,
  type RunHome,
  type RunPlan,
  ensureHarnessIdentity,
  runAdapterFor,
  runRefOf,
} from "@crewhaus/control-service";
import { createControlClient } from "@crewhaus/gateway-protocol/control-client";
import {
  type DaemonCommandOptions,
  controlTargetFor,
  directControl,
  harnessIdOf,
  resolveHarness,
  supervisorFor,
} from "./daemon-cmd";
import { parseFamilyArgs as parseArgs } from "./family-args";
import { RunsError } from "./runs";
import type { CliFamily } from "./verbs";

export const CLI_FAMILY = {
  verb: "runs",
  since: "0.8.0",
  sub: {
    list: { flags: { harness: "value", limit: "value", json: "boolean" } },

    show: { flags: { harness: "value", json: "boolean" } },

    create: { flags: { "input-file": "value", admission: "value", json: "boolean" } },

    cancel: { flags: { harness: "value", json: "boolean" } },

    resume: {
      flags: {
        spec: "value",
        model: "value",
        "permission-mode": "value",
        "ask-mode": "value",
        prompt: "value",
        "justification-judge": "value",
        "no-justification-audit": "boolean",
        "egress-matcher": "value",
        "egress-embedder": "value",
        "budget-usd": "value",
        streaming: "boolean",
        trace: "value",
        user: "value",
        "no-mcp-quarantine": "boolean",
        help: "boolean",
      },
    },

    // A later change adds `inspect` here.

    // A later change adds `retry` here.
  },
} as const satisfies CliFamily;

export type RunsDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** The control service; the CLI's direct one by default, opened only when needed. */
  readonly control?: () => ControlService;
  /** What the run commands lend: the job starter and the daemon client. */
  readonly home?: (harnessDir: string) => RunHome;
  /** `runs resume`: index.ts's resumed run, parsed with `RUNS_SCHEMA`. */
  readonly resume?: (argv: readonly string[]) => Promise<void>;
  readonly now?: () => number;
};

export type RunsOutput = { readonly lines: readonly string[]; readonly exitCode: number };

const USAGE = [
  "usage: crewhaus runs list [--harness <h>] [--limit n] [--json]",
  "       crewhaus runs show <run> [--harness <h>] [--json]",
  "       crewhaus runs create <harness> --input-file <path> [--admission reject|queue] [--json]",
  "       crewhaus runs cancel <run> [--harness <h>] [--json]",
  "       crewhaus runs resume <session|run> [--spec <path>] [--prompt <text>] …",
  "  A harness's runs, newest first, and the run commands. <h> is a harness id or its",
  "  directory; without it, the current directory. `create` reads the input from a plain",
  "  text file. `cancel` of a run parked on a decision withdraws what it waits on.",
];

/** The most bytes `runs create` reads from its input file: the API's body cap. */
export const RUNS_INPUT_MAX_BYTES = 256 * 1024;

const NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

type Sub = Exclude<keyof typeof CLI_FAMILY.sub, "resume">;

function flagsOf(sub: Sub, argv: readonly string[]) {
  const label = `runs ${sub}`;
  const args = parseArgs(label, argv, CLI_FAMILY.sub[sub].flags);
  const values: Record<string, string> = {};
  for (const [name, list] of args.values) values[name] = list[0] as string;
  return { positional: args.positional, values, json: args.booleans.has("json") };
}

function optionsOf(deps: RunsDeps): DaemonCommandOptions {
  return {
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
  };
}

/** What the CLI lends a run command: its own supervisor for one job, and the daemon client. */
export function cliRunHome(
  opts: DaemonCommandOptions,
  now?: () => number,
): (dir: string) => RunHome {
  return (dir) => {
    const harness = resolveHarness(dir, opts);
    return {
      startRunJob: async (_harnessDir, apiRun) =>
        supervisorFor(harness, opts, { enabled: true }, {}, { apiRun }).start(),
      controlClient: createControlClient(),
      controlTarget: () => controlTargetFor(harness),
      ...(now !== undefined ? { now } : {}),
    };
  };
}

/** The harness a run command names, or the current directory. */
function harnessOf(deps: RunsDeps, raw: string | undefined) {
  return resolveHarness(raw, optionsOf(deps));
}

/** Every run's newest row, newest first, read from the whole ledger. */
function newestRuns(harnessDir: string): Array<Readonly<Record<string, unknown>>> {
  const ledger = runsLedger(harnessDir);
  const seen = new Set<string>();
  const out: Array<Readonly<Record<string, unknown>>> = [];
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, { limit: 1000, ...(before !== undefined ? { before } : {}) });
    for (const item of page.items) {
      const id = item.record["id"];
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      out.push(item.record);
    }
    if (page.next === undefined) return out;
    before = page.next;
  }
}

/** Every row of one run, oldest first. */
function rowsOfRun(harnessDir: string, runId: string): Array<Readonly<Record<string, unknown>>> {
  const ledger = runsLedger(harnessDir);
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, { limit: 1000, ...(before !== undefined ? { before } : {}) });
    for (const item of page.items) if (item.record["id"] === runId) rows.push(item.record);
    if (page.next === undefined) return rows.reverse();
    before = page.next;
  }
}

/** A run as these verbs show it: ids, states, what started it and when. Content-free. */
function viewOf(rows: ReadonlyArray<Readonly<Record<string, unknown>>>): Record<string, unknown> {
  const first = rows[0] ?? {};
  const last = rows.at(-1) ?? {};
  const session = rows.map((row) => row["session"]).find((value) => typeof value === "string");
  const trigger = (last["trigger"] ?? first["trigger"]) as { kind?: unknown } | undefined;
  return {
    id: last["id"],
    state: last["state"],
    ...(typeof trigger?.kind === "string" ? { trigger: trigger.kind } : {}),
    ...(typeof first["at"] === "string" ? { firstAt: first["at"] } : {}),
    ...(typeof last["at"] === "string" ? { lastAt: last["at"] } : {}),
    ...(typeof session === "string" ? { session } : {}),
    ...(typeof last["failureClass"] === "string" ? { failureClass: last["failureClass"] } : {}),
  };
}

function lineOf(view: Record<string, unknown>): string {
  return [
    String(view["id"]),
    String(view["state"]).padEnd(20),
    String(view["trigger"] ?? "-").padEnd(8),
    String(view["lastAt"] ?? ""),
  ].join("  ");
}

const refusalExit = (code: ErrorCode): number => EXIT_FOR_ERROR[code] ?? 1;

/** Run a planned command through the control service; its receipt, or the refusal. */
async function carryOut<T>(
  control: ControlService,
  kind: "runs.create" | "runs.cancel",
  harnessDir: string,
  target: string,
  plan: RunPlan<T>,
  body: Readonly<Record<string, unknown>> = {},
): Promise<
  | {
      readonly ok: true;
      readonly receipt: { id: string; state: string; outcome?: unknown };
      readonly value?: T;
    }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly message: string;
      readonly verb?: string;
    }
> {
  if (!plan.ok) {
    return {
      ok: false,
      code: plan.refusal.code,
      message: plan.refusal.message,
      ...(plan.refusal.verb !== undefined ? { verb: plan.refusal.verb } : {}),
    };
  }
  const answer = await control.commands.submit<T>(
    { kind, target, ledger: { harness: harnessDir }, via: "cli", body },
    plan.effect,
  );
  if (!answer.ok) return { ok: false, code: answer.refusal.code, message: answer.refusal.message };
  return {
    ok: true,
    receipt: answer.receipt,
    ...(!answer.replayed && answer.value !== undefined ? { value: answer.value } : {}),
  };
}

/** Read a `runs create` input file whole: a regular file, no link, at most the API's cap. */
function readCreateInput(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new RunsError(`${path} is not a file`);
    if (stats.size > RUNS_INPUT_MAX_BYTES) {
      throw new RunsError(`${path} is larger than ${RUNS_INPUT_MAX_BYTES} bytes`);
    }
    const text = readFileSync(fd, "utf8");
    if (text.trim() === "") throw new RunsError(`${path} is empty`);
    return text;
  } catch (err) {
    if (err instanceof RunsError) throw err;
    throw new RunsError(`could not read ${path}: ${(err as Error).message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function runRunsCommand(
  argv: readonly string[],
  deps: RunsDeps = {},
): Promise<RunsOutput> {
  const sub = argv[0];
  if (sub === "resume") {
    if (deps.resume === undefined) {
      if (argv.includes("--help") || argv.includes("-h")) return { lines: USAGE, exitCode: 0 };
      throw new Error("runs resume: not available here");
    }
    await deps.resume(argv.slice(1));
    return { lines: [], exitCode: 0 };
  }
  if (sub === undefined || sub === "--help" || sub === "-h") return { lines: USAGE, exitCode: 0 };
  if (!Object.hasOwn(CLI_FAMILY.sub, sub)) {
    throw new Error(
      `unknown runs verb "${sub}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  if (argv.includes("--help") || argv.includes("-h")) return { lines: USAGE, exitCode: 0 };
  const verb = sub as Sub;
  const args = flagsOf(verb, argv.slice(1));
  const opts = optionsOf(deps);
  const control = (): ControlService => deps.control?.() ?? directControl(opts);
  const home = deps.home ?? cliRunHome(opts, deps.now);

  if (verb === "list") {
    const harness = harnessOf(deps, args.values["harness"]);
    const limit = args.values["limit"] === undefined ? 50 : Number(args.values["limit"]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return {
        lines: ["runs list: --limit is a whole number from 1 to 500"],
        exitCode: EXIT_FOR_ERROR.invalid,
      };
    }
    const newest = newestRuns(harness.dir);
    const views = newest
      .slice(0, limit)
      .map((row) => viewOf(rowsOfRun(harness.dir, String(row["id"]))));
    if (args.json) return { lines: [JSON.stringify(views, null, 2)], exitCode: 0 };
    if (views.length === 0)
      return { lines: ["No runs are recorded for this harness yet."], exitCode: 0 };
    return {
      lines: [
        ...views.map(lineOf),
        ...(newest.length > limit ? [`(the newest ${limit}; pass --limit for more)`] : []),
      ],
      exitCode: 0,
    };
  }

  if (verb === "show") {
    const runId = args.positional[0];
    if (runId === undefined || !CANONICAL_RUN_ID_RE.test(runId)) {
      return {
        lines: ["runs show: name a run, run_ and 26 characters"],
        exitCode: EXIT_FOR_ERROR.invalid,
      };
    }
    const harness = harnessOf(deps, args.values["harness"]);
    const rows = rowsOfRun(harness.dir, runId);
    if (rows.length === 0) {
      return {
        lines: [`runs show: no run ${runId} in ${harness.dir}`],
        exitCode: EXIT_FOR_ERROR.not_found,
      };
    }
    const view = viewOf(rows);
    if (args.json) return { lines: [JSON.stringify(view, null, 2)], exitCode: 0 };
    return {
      lines: [
        lineOf(view),
        ...(view["firstAt"] !== undefined ? [`  first recorded ${String(view["firstAt"])}`] : []),
        ...(view["session"] !== undefined ? [`  session ${String(view["session"])}`] : []),
        ...(view["failureClass"] !== undefined
          ? [`  failed: ${String(view["failureClass"])}`]
          : []),
      ],
      exitCode: 0,
    };
  }

  if (verb === "create") {
    const harness = harnessOf(deps, args.positional[0]);
    const file = args.values["input-file"];
    if (file === undefined) {
      return {
        lines: ["runs create: name the input with --input-file <path>"],
        exitCode: EXIT_FOR_ERROR.invalid,
      };
    }
    const admission = args.values["admission"] ?? "reject";
    if (admission !== "reject" && admission !== "queue") {
      return {
        lines: ["runs create: --admission is reject or queue"],
        exitCode: EXIT_FOR_ERROR.invalid,
      };
    }
    const input = readCreateInput(
      isAbsolute(file) ? file : resolve(deps.cwd ?? process.cwd(), file),
    );
    const id = harnessIdOf(harness.dir, opts) ?? ensureIdentity(harness.dir);
    const runId = mintRunId();
    const plan = await runAdapterFor(harness.target).createRun({
      harnessDir: harness.dir,
      harness: id,
      target: harness.target,
      runId,
      input,
      admission,
      home: home(harness.dir),
    });
    const done = await carryOut(control(), "runs.create", harness.dir, runRefOf(id, runId), plan, {
      input,
      admission,
    });
    if (!done.ok) {
      return {
        lines: [
          `runs create: ${done.message}`,
          ...(done.verb !== undefined ? [`  try: ${done.verb}`] : []),
        ],
        exitCode: refusalExit(done.code),
      };
    }
    const value = done.value;
    if (args.json) {
      return {
        lines: [
          JSON.stringify({ run: value?.run ?? { id: runId }, receipt: done.receipt }, null, 2),
        ],
        exitCode: 0,
      };
    }
    if (done.receipt.state !== "succeeded") {
      return {
        lines: [
          `runs create: run ${runId} was not started${value?.problem !== undefined ? `: ${value.problem}` : ""}`,
          `  receipt ${done.receipt.id}`,
        ],
        exitCode: EXIT_FOR_ERROR.unavailable,
      };
    }
    return {
      lines: [
        `run ${runId} started`,
        ...(value?.warnings ?? []).map((w) => `  note: ${w}`),
        `  receipt ${done.receipt.id}`,
      ],
      exitCode: 0,
    };
  }

  // cancel
  const runId = args.positional[0];
  if (runId === undefined || !CANONICAL_RUN_ID_RE.test(runId)) {
    return {
      lines: ["runs cancel: name a run, run_ and 26 characters"],
      exitCode: EXIT_FOR_ERROR.invalid,
    };
  }
  const harness = harnessOf(deps, args.values["harness"]);
  const id = harnessIdOf(harness.dir, opts) ?? ensureIdentity(harness.dir);
  const plan = await runAdapterFor(harness.target).cancelRun({
    harnessDir: harness.dir,
    harness: id,
    target: harness.target,
    runId,
    home: home(harness.dir),
  });
  const done = await carryOut(control(), "runs.cancel", harness.dir, runRefOf(id, runId), plan);
  if (!done.ok) {
    return {
      lines: [
        `runs cancel: ${done.message}`,
        ...(done.verb !== undefined ? [`  try: ${done.verb}`] : []),
      ],
      exitCode: refusalExit(done.code),
    };
  }
  if (args.json)
    return { lines: [JSON.stringify({ receipt: done.receipt }, null, 2)], exitCode: 0 };
  if (done.receipt.state !== "succeeded") {
    return {
      lines: [
        `runs cancel: run ${runId} was not cancelled${done.value?.problem !== undefined ? `: ${done.value.problem}` : ""}`,
        `  receipt ${done.receipt.id}`,
      ],
      exitCode:
        done.receipt.state === "rejected" ? EXIT_FOR_ERROR.conflict : EXIT_FOR_ERROR.unavailable,
    };
  }
  return { lines: [`run ${runId} cancelled`, `  receipt ${done.receipt.id}`], exitCode: 0 };
}

function ensureIdentity(harnessDir: string): string {
  const made = ensureHarnessIdentity(harnessDir);
  if (!made.ok)
    throw new RunsError(`this harness has no id, and one could not be written: ${made.reason}`);
  return made.id;
}
