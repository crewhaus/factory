/**
 * `crewhaus work <verb>`: a harness's work items (#516, module brief 333), read from its
 * work log and changed through the same control service Home uses, so every verb works with
 * Home stopped. Each change writes its receipt before it acts.
 *
 * | Verb | What |
 * |---|---|
 * | `list [--state proposed\|open\|closed\|all]` | the items with their status in words |
 * | `show <wi>` | one item: what's asked, done when, why, notes, runs, history |
 * | `add --title <t> [--goal-file <p>] [--kind <k>] [--parent <wi>] [--priority 1-4] [--start]` | an item, up next |
 * | `edit <wi> --expect <rev> [--title …] [--goal-file …] [--kind …] [--priority …] [--note <text>]` | an edit, guarded by the revision read |
 * | `accept` · `reopen` · `cancel` · `start <wi>` | the lifecycle; `cancel` also cancels its runs |
 * | `decline <wi> --reason <code> [--note <text>]` | declines a proposal |
 * | `rank <wi> --above <wi> --scope item\|similar\|all` | puts an item ahead of another |
 * | `adopt --from continuity-goal:<id>` | one item per goal; a repeat names the item it opened |
 *
 * Every change refuses when the command was started by an agent's tool: the harness
 * proposes through its own Work tools, and a person decides.
 */
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  CORRECTION_SCOPES,
  DECLINE_REASONS,
  type DeclineReason,
  EXIT_FOR_ERROR,
  type ErrorCode,
  WORK_KINDS,
  type WorkKind,
  isId,
  mintRunId,
} from "@crewhaus/control-contract";
import {
  type ControlService,
  ISSUE_ADOPTION_NOT_SERVED,
  type RunHome,
  THREDZ_ADOPTION_NEEDS_HOME,
  type WorkCaller,
  type WorkHead,
  type WorkPlan,
  ensureHarnessIdentity,
  workCommands,
  workRefOf,
} from "@crewhaus/control-service";
import {
  type WorkSpecFacts,
  historyOf,
  itemDetail,
  itemViews,
  openWorkStore,
  viewContext,
  workSpecFacts,
} from "@crewhaus/tool-work/work-items";
import { parse as parseYaml } from "yaml";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import {
  type DaemonCommandOptions,
  directControl,
  harnessIdOf,
  resolveHarness,
} from "./daemon-cmd";
import { parseFamilyArgs as parseArgs } from "./family-args";
import { cliRunHome } from "./runs-cmd";
import type { CliFamily } from "./verbs";

const COMMON = { harness: "value", json: "boolean" } as const;
const FIELDS = {
  title: "value",
  "goal-file": "value",
  kind: "value",
  parent: "value",
  priority: "value",
} as const;

export const CLI_FAMILY = {
  verb: "work",
  since: "0.9.0",
  sub: {
    list: { flags: { ...COMMON, state: "value" } },
    show: { flags: COMMON },
    add: { flags: { ...COMMON, ...FIELDS, start: "boolean" } },
    edit: { flags: { ...COMMON, ...FIELDS, expect: "value", note: "value" } },
    accept: { flags: COMMON },
    decline: { flags: { ...COMMON, reason: "value", note: "value" } },
    cancel: { flags: COMMON },
    reopen: { flags: COMMON },
    start: { flags: COMMON },
    adopt: { flags: { ...COMMON, from: "value" } },
    rank: { flags: { ...COMMON, above: "value", scope: "value" } },
  },
} as const satisfies CliFamily;

type Sub = keyof typeof CLI_FAMILY.sub;

export type WorkDeps = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** The control service; the CLI's direct one by default, opened only when needed. */
  readonly control?: () => ControlService;
  /** What `start` and `cancel` lend the run adapter; the CLI's own by default. */
  readonly home?: (harnessDir: string) => RunHome;
  readonly now?: () => number;
};

export type WorkOutput = { readonly lines: readonly string[]; readonly exitCode: number };

const USAGE = [
  "usage: crewhaus work list [--state proposed|open|closed|all] [--harness <h>] [--json]",
  "       crewhaus work show <wi> [--harness <h>] [--json]",
  "       crewhaus work add --title <title> [--goal-file <path>] [--kind <kind>] [--parent <wi>] [--priority 1-4] [--start]",
  "       crewhaus work edit <wi> --expect <rev> [--title <t>] [--goal-file <path>] [--kind <kind>] [--priority 1-4] [--note <text>]",
  "       crewhaus work accept|reopen|cancel|start <wi> [--harness <h>]",
  `       crewhaus work decline <wi> --reason ${DECLINE_REASONS.join("|")} [--note <text>]`,
  "       crewhaus work rank <wi> --above <wi> --scope item|similar|all",
  "       crewhaus work adopt --from continuity-goal:<id>",
  "  A harness's work items. <h> is a harness id or its directory; without it, the current",
  `  directory. <kind> is one of ${WORK_KINDS.join(", ")}.`,
];

/** The sub-verbs that change something, and so refuse under an agent's tool. */
const WRITES: ReadonlySet<Sub> = new Set([
  "add",
  "edit",
  "accept",
  "decline",
  "cancel",
  "reopen",
  "start",
  "adopt",
  "rank",
]);

const KIND: Readonly<Record<Exclude<Sub, "list" | "show">, string>> = {
  add: "work.create",
  edit: "work.update",
  accept: "work.accept",
  decline: "work.decline",
  cancel: "work.cancel",
  reopen: "work.reopen",
  start: "work.start",
  adopt: "work.adopt",
  rank: "work.rank",
};

/** The most bytes `--goal-file` reads: a goal's own bound. */
export const WORK_GOAL_MAX_BYTES = 8192;

const NOFOLLOW: number = fsConstants.O_NOFOLLOW ?? 0;

/** A local user is a person: the CLI's caller for every work rule. */
const PERSON: WorkCaller = { role: "person" };

class WorkCmdError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = "invalid",
  ) {
    super(message);
  }
}

const refusalExit = (code: ErrorCode): number => EXIT_FOR_ERROR[code] ?? 1;

function requireValue(verb: Sub, args: ReturnType<typeof parseArgs>, flag: string): string {
  const value = args.values.get(flag)?.[0];
  if (value === undefined || value === "")
    throw new WorkCmdError(`work ${verb}: --${flag} is required`);
  return value;
}

function itemIdOf(verb: Sub, args: ReturnType<typeof parseArgs>): string {
  const wi = args.positional[0];
  if (wi === undefined || !isId("wi", wi)) {
    throw new WorkCmdError(`work ${verb}: name a work item, wi_ and 26 characters`);
  }
  if (args.positional.length > 1) throw new WorkCmdError(`work ${verb}: unexpected argument`);
  return wi;
}

/** Read a goal file whole: a regular file, no link, at most a goal's bound. */
function readGoalFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NOFOLLOW);
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new WorkCmdError(`${path} is not a file`);
    if (stats.size > WORK_GOAL_MAX_BYTES) {
      throw new WorkCmdError(`${path} is larger than ${WORK_GOAL_MAX_BYTES} bytes`);
    }
    const text = readFileSync(fd, "utf8");
    if (text.trim() === "") throw new WorkCmdError(`${path} is empty`);
    return text;
  } catch (err) {
    if (err instanceof WorkCmdError) throw err;
    throw new WorkCmdError(`could not read ${path}: ${(err as Error).message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** What the harness's spec says about work items; nothing when it cannot be read. */
function specFactsOf(dir: string): WorkSpecFacts | undefined {
  for (const name of ["crewhaus.yaml", "crewhaus.yml"]) {
    try {
      return workSpecFacts(parseYaml(readFileSync(resolve(dir, name), "utf8")));
    } catch {
      // The next name, or nothing.
    }
  }
  return undefined;
}

function fieldsOf(
  verb: Sub,
  args: ReturnType<typeof parseArgs>,
  cwd: string,
): {
  title?: string;
  goal?: string;
  kind?: WorkKind;
  parent?: string;
  priority?: number;
} {
  const out: {
    title?: string;
    goal?: string;
    kind?: WorkKind;
    parent?: string;
    priority?: number;
  } = {};
  const title = args.values.get("title")?.[0];
  if (title !== undefined) out.title = title;
  const goalFile = args.values.get("goal-file")?.[0];
  if (goalFile !== undefined)
    out.goal = readGoalFile(isAbsolute(goalFile) ? goalFile : resolve(cwd, goalFile));
  const kind = args.values.get("kind")?.[0];
  if (kind !== undefined) {
    if (!(WORK_KINDS as readonly string[]).includes(kind)) {
      throw new WorkCmdError(`work ${verb}: --kind is one of ${WORK_KINDS.join(", ")}`);
    }
    out.kind = kind as WorkKind;
  }
  const parent = args.values.get("parent")?.[0];
  if (parent !== undefined) out.parent = parent;
  const priority = args.values.get("priority")?.[0];
  if (priority !== undefined) {
    if (!/^[1-4]$/.test(priority)) throw new WorkCmdError(`work ${verb}: --priority is 1 to 4`);
    out.priority = Number(priority);
  }
  return out;
}

export async function runWorkCommand(
  argv: readonly string[],
  deps: WorkDeps = {},
): Promise<WorkOutput> {
  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h") return { lines: USAGE, exitCode: 0 };
  if (!Object.hasOwn(CLI_FAMILY.sub, sub)) {
    throw new Error(
      `unknown work verb "${sub}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  if (argv.includes("--help") || argv.includes("-h")) return { lines: USAGE, exitCode: 0 };
  const verb = sub as Sub;
  const env = deps.env ?? process.env;
  const agentTool = env[AGENT_TOOL_ENV];
  if (WRITES.has(verb) && agentTool !== undefined && agentTool !== "") {
    return {
      lines: [`work ${verb}: this command was started by an agent's tool; a person does this`],
      exitCode: EXIT_FOR_ERROR.forbidden,
    };
  }
  try {
    return await runVerb(verb, argv.slice(1), deps);
  } catch (err) {
    if (err instanceof WorkCmdError)
      return { lines: [err.message], exitCode: refusalExit(err.code) };
    throw err;
  }
}

async function runVerb(verb: Sub, rest: readonly string[], deps: WorkDeps): Promise<WorkOutput> {
  const label = `work ${verb}`;
  const args = parseArgs(label, rest, CLI_FAMILY.sub[verb].flags);
  const json = args.booleans.has("json");
  const opts: DaemonCommandOptions = {
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.cwd !== undefined ? { cwd: deps.cwd } : {}),
  };
  const cwd = deps.cwd ?? process.cwd();
  const harness = resolveHarness(args.values.get("harness")?.[0], opts);
  const dir = harness.dir;
  const now = deps.now ?? Date.now;
  const spec = specFactsOf(dir);
  const weights = spec?.config?.ranking?.weights;

  if (verb === "list") {
    const state = args.values.get("state")?.[0];
    if (state !== undefined && !["proposed", "open", "closed", "all"].includes(state)) {
      throw new WorkCmdError("work list: --state is proposed, open, closed or all");
    }
    const store = openWorkStore(dir, { now });
    const fold = store.fold();
    if (!fold.ok) throw new WorkCmdError(`work list: ${fold.message}`, fold.code);
    const items = [...fold.items.values()].filter((item) =>
      state === undefined ? item.state !== "closed" : state === "all" || item.state === state,
    );
    const views = itemViews(store, items, viewContext(dir, fold, weights)).sort(
      (a, b) =>
        a.state.localeCompare(b.state) ||
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
    );
    if (json) {
      return {
        lines: [JSON.stringify({ items: views, anomalies: fold.anomalies }, null, 2)],
        exitCode: 0,
      };
    }
    if (views.length === 0) {
      return {
        lines: [
          spec?.tools === false
            ? "This harness doesn't keep a work list. Turn on the Work tools in its spec."
            : "Nothing to do yet. Add work with: crewhaus work add --title <title>",
        ],
        exitCode: 0,
      };
    }
    return {
      lines: [
        ...views.map((v) => [v.id, v.statusWord.padEnd(22), v.kind.padEnd(11), v.title].join("  ")),
        ...(fold.anomalies > 0 ? [`(${fold.anomalies} log lines were not applied)`] : []),
      ],
      exitCode: 0,
    };
  }

  if (verb === "show") {
    const wi = itemIdOf(verb, args);
    const store = openWorkStore(dir, { now });
    const fold = store.fold();
    if (!fold.ok) throw new WorkCmdError(`work show: ${fold.message}`, fold.code);
    const item = fold.items.get(wi);
    if (item === undefined)
      throw new WorkCmdError(`work show: no work item ${wi} in ${dir}`, "not_found");
    const detail = itemDetail(store, item, fold, viewContext(dir, fold, weights), {
      content: true,
    });
    if (json) return { lines: [JSON.stringify(detail, null, 2)], exitCode: 0 };
    const content = detail.content;
    return {
      lines: [
        `${item.id}  ${detail.item.statusWord}  ${detail.item.title}`,
        `  kind ${item.kind}${item.basis !== undefined ? ` · basis ${item.basis}` : ""}${item.priority !== undefined ? ` · priority ${item.priority}` : ""} · revision ${item.rev}`,
        ...(content?.goal !== undefined
          ? ["  What's asked:", ...content.goal.split("\n").map((l) => `    ${l}`)]
          : []),
        ...(content?.acceptance !== undefined
          ? ["  Done when:", ...content.acceptance.map((c) => `    - ${c}`)]
          : []),
        ...(item.runs.length > 0 ? [`  Runs: ${item.runs.join(", ")}`] : []),
        "  History:",
        ...historyOf(item).map(
          (h) => `    ${h.at}  ${h.event}  by ${h.by}${h.via !== undefined ? ` (${h.via})` : ""}`,
        ),
      ],
      exitCode: 0,
    };
  }

  // Every other verb is a receipted command.
  const id = harnessIdOf(dir, opts) ?? ensureIdentity(dir);
  const head: WorkHead = {
    harnessDir: dir,
    harness: id,
    target: harness.target,
    specName: harness.specName,
    ...(spec !== undefined ? { tools: spec.tools } : {}),
    now,
  };
  const work = workCommands();
  const home = (deps.home ?? cliRunHome(opts, deps.now))(dir);
  const control = (): ControlService => deps.control?.() ?? directControl(opts);
  let plan: WorkPlan;
  let target = `home/harness/${id}`;
  let body: Record<string, unknown> = {};
  switch (verb) {
    case "add": {
      const fields = fieldsOf(verb, args, cwd);
      const title = requireValue(verb, args, "title");
      body = { ...fields, title, kind: fields.kind ?? "request" };
      plan = work.create(head, PERSON, body as never);
      break;
    }
    case "edit": {
      const wi = itemIdOf(verb, args);
      target = workRefOf(id, wi);
      const expect = requireValue(verb, args, "expect");
      if (!/^[1-9][0-9]{0,8}$/.test(expect))
        throw new WorkCmdError("work edit: --expect is a revision number");
      const note = args.values.get("note")?.[0];
      body = {
        expect: Number(expect),
        ...fieldsOf(verb, args, cwd),
        ...(note !== undefined ? { note } : {}),
      };
      plan = work.update(head, PERSON, wi, body as never);
      break;
    }
    case "accept":
    case "reopen": {
      const wi = itemIdOf(verb, args);
      target = workRefOf(id, wi);
      plan = verb === "accept" ? work.accept(head, PERSON, wi) : work.reopen(head, PERSON, wi);
      break;
    }
    case "decline": {
      const wi = itemIdOf(verb, args);
      target = workRefOf(id, wi);
      const reason = requireValue(verb, args, "reason");
      if (!(DECLINE_REASONS as readonly string[]).includes(reason)) {
        throw new WorkCmdError(`work decline: --reason is one of ${DECLINE_REASONS.join(", ")}`);
      }
      const note = args.values.get("note")?.[0];
      body = { reason: reason as DeclineReason, ...(note !== undefined ? { note } : {}) };
      plan = work.decline(head, PERSON, wi, body as never);
      break;
    }
    case "cancel": {
      const wi = itemIdOf(verb, args);
      target = workRefOf(id, wi);
      plan = await work.cancel(head, PERSON, wi, home);
      break;
    }
    case "start": {
      const wi = itemIdOf(verb, args);
      target = workRefOf(id, wi);
      plan = await work.start(head, PERSON, wi, home, mintRunId());
      break;
    }
    case "rank": {
      const wi = itemIdOf(verb, args);
      target = workRefOf(id, wi);
      const above = requireValue(verb, args, "above");
      const scope = requireValue(verb, args, "scope");
      if (!isId("wi", above)) throw new WorkCmdError("work rank: --above names a work item, wi_…");
      if (!(CORRECTION_SCOPES as readonly string[]).includes(scope)) {
        throw new WorkCmdError("work rank: --scope is item, similar or all");
      }
      body = { below: above, scope };
      plan = work.rank(head, PERSON, wi, body as never);
      break;
    }
    case "adopt": {
      if (args.positional.length > 0) throw new WorkCmdError("work adopt: unexpected argument");
      const from = requireValue(verb, args, "from");
      if (from.startsWith("github-issue:")) {
        throw new WorkCmdError(`work adopt: ${ISSUE_ADOPTION_NOT_SERVED}`, "unsupported");
      }
      if (from.startsWith("thredz-task:")) {
        throw new WorkCmdError(
          `work adopt: ${THREDZ_ADOPTION_NEEDS_HOME}\n  try: crewhaus hangar serve`,
          "unsupported",
        );
      }
      body = { source: from };
      plan = work.adopt(head, PERSON, from);
      break;
    }
  }
  if (!plan.ok) {
    const r = plan.refusal;
    return {
      lines: [
        `work ${verb}: ${r.message}${r.current !== undefined ? ` (now: ${r.current})` : ""}`,
        ...(r.verb !== undefined && r.verb !== null ? [`  try: ${r.verb}`] : []),
      ],
      exitCode: refusalExit(r.code),
    };
  }
  const answer = await control().commands.submit(
    { kind: KIND[verb], target, ledger: { harness: dir }, via: "cli", body },
    plan.effect,
  );
  if (!answer.ok) {
    return {
      lines: [`work ${verb}: ${answer.refusal.message}`],
      exitCode: refusalExit(answer.refusal.code),
    };
  }
  const value = answer.replayed ? undefined : answer.value;
  const receipt = answer.receipt;
  if (json) {
    return {
      lines: [
        JSON.stringify(
          {
            receipt,
            ...(value?.item !== undefined
              ? { item: { id: value.item.id, state: value.item.state, rev: value.item.rev } }
              : {}),
            ...(value?.run !== undefined ? { run: value.run } : {}),
            ...(value !== undefined && value.warnings.length > 0
              ? { warnings: value.warnings }
              : {}),
          },
          null,
          2,
        ),
      ],
      exitCode: receipt.state === "succeeded" ? 0 : EXIT_FOR_ERROR.conflict,
    };
  }
  if (receipt.state !== "succeeded") {
    return {
      lines: [
        `work ${verb}: not done${value?.problem !== undefined ? `: ${value.problem}` : ""}`,
        `  receipt ${receipt.id}`,
      ],
      exitCode: receipt.state === "rejected" ? EXIT_FOR_ERROR.conflict : EXIT_FOR_ERROR.unavailable,
    };
  }
  const item = value?.item;
  const lines = [
    `${item !== undefined ? `${item.id} ${item.state}` : "Done"}${value?.run !== undefined ? `, run ${value.run} started` : ""}`,
    ...(value?.warnings ?? []).map((w) => `  note: ${w}`),
    `  receipt ${receipt.id}`,
  ];
  if (verb === "add" && args.booleans.has("start") && item !== undefined) {
    const started = await runVerb("start", [item.id, "--harness", dir], deps);
    return { lines: [...lines, ...started.lines], exitCode: started.exitCode };
  }
  return { lines, exitCode: 0 };
}

function ensureIdentity(harnessDir: string): string {
  const made = ensureHarnessIdentity(harnessDir);
  if (!made.ok) {
    throw new WorkCmdError(
      `this harness has no id, and one could not be written: ${made.reason}`,
      "unavailable",
    );
  }
  return made.id;
}
