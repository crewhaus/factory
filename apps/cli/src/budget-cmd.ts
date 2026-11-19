/**
 * `crewhaus budget <verb>`: a harness's spending period (#516), read from its spec's
 * `budget.period` and its local spend ledger, and raised by a maintainer. The verbs
 * work with Home stopped: a raise goes through the same control service Home uses, as a
 * receipted command.
 *
 * | Verb | What |
 * |---|---|
 * | `show [--harness <h>] [--json]` | this period's spend, what is reserved, when it renews |
 * | `history [--harness <h>] [--json]` | the closed periods |
 * | `extend --usd <amount> --reason <code> [--harness <h>] [--expect <period>]` | raise this period's limit |
 *
 * `--harness` takes a registered harness's id or name, or a directory; the working
 * directory by default. A raise applies to the current period only, and refuses when the
 * command was started by an agent's tool. Side-effect-free on import.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BUDGET_EXTEND_REASONS, EXIT_FOR_ERROR, type ErrorCode } from "@crewhaus/control-contract";
import {
  type BudgetFold,
  type BudgetPeriodDef,
  type BudgetPeriodSummary,
  budgetPeriodProblem,
  foldBudget,
  openBudgetLedger,
  periodOf,
  readBudgetPeriods,
  renewalDay,
} from "@crewhaus/control-records/budget";
import type { BudgetExtendAnswer, ControlService } from "@crewhaus/control-service";
import { applyBudgetExtend } from "@crewhaus/control-service";
import { HARNESS_ID_RE, openHangarRegistry, slugOf } from "@crewhaus/harness-registry";
import { parseSpec } from "@crewhaus/spec";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import { directControl } from "./daemon-cmd";
import { parseFamilyArgs as parseArgs } from "./family-args";
import type { CliFamily } from "./verbs";

export const CLI_FAMILY = {
  verb: "budget",
  since: "0.9.0",
  sub: {
    show: { flags: { harness: "value", json: "boolean" } },
    history: { flags: { harness: "value", json: "boolean" } },
    extend: {
      flags: {
        harness: "value",
        usd: "value",
        reason: "value",
        expect: "value",
        json: "boolean",
      },
    },
  },
} as const satisfies CliFamily;

type Sub = keyof typeof CLI_FAMILY.sub;

export type BudgetOut = { readonly lines: readonly string[]; readonly exitCode: number };

export type BudgetDeps = {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly now?: () => number;
  readonly control?: () => ControlService;
};

const USAGE = [
  "usage: crewhaus budget show [--harness <h>] [--json]",
  "       crewhaus budget history [--harness <h>] [--json]",
  `       crewhaus budget extend --usd <amount> --reason ${BUDGET_EXTEND_REASONS.join("|")} [--harness <h>] [--expect <period>]`,
];

class Refused extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

const exitFor = (code: ErrorCode): number => EXIT_FOR_ERROR[code];

/** The harness `--harness` names: a registered id or name, else a directory; the cwd by default. */
function harnessDirOf(raw: string | undefined, deps: BudgetDeps): string {
  const cwd = deps.cwd ?? process.cwd();
  if (raw === undefined) return cwd;
  const env = deps.env ?? process.env;
  try {
    const registry = openHangarRegistry({ env: env as Record<string, string | undefined> });
    const entries = registry.list();
    const found = HARNESS_ID_RE.test(raw)
      ? entries.find((e) => e.id === raw)
      : entries.find((e) => (e.slug ?? slugOf(e.specName)) === raw);
    if (found !== undefined) return found.dir;
  } catch {
    // No registry on this computer: a directory is the only way to name a harness.
  }
  const dir = resolve(cwd, raw);
  if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
  throw new Refused(
    `budget: no harness "${raw}". Run \`crewhaus harness list\`, or pass its directory.`,
    exitFor("not_found"),
  );
}

/**
 * What the harness's spec says about its period. "Could not tell" is not "none": a
 * directory with no spec, a spec that cannot be read or parsed, and a period the
 * runtime cannot use each answer their own kind, and only a valid spec without
 * `budget.period` answers `none`.
 */
export type SpecPeriod =
  | { readonly kind: "period"; readonly def: BudgetPeriodDef }
  | { readonly kind: "none" }
  | { readonly kind: "no-spec" }
  | { readonly kind: "unreadable"; readonly detail: string };

/** The harness's spec, read and parsed, and the period it declares. */
export function readSpecPeriod(harnessDir: string): SpecPeriod {
  let text: string;
  try {
    text = readFileSync(join(harnessDir, "crewhaus.yaml"), "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "no-spec" }
      : { kind: "unreadable", detail: (err as Error).message };
  }
  let spec: ReturnType<typeof parseSpec>;
  try {
    spec = parseSpec(text);
  } catch (err) {
    return { kind: "unreadable", detail: firstLine((err as Error).message) };
  }
  const period = "budget" in spec ? spec.budget?.period : undefined;
  if (period === undefined) return { kind: "none" };
  const def: BudgetPeriodDef = {
    every: period.every,
    usdMicros: Math.round(period.usd * 1_000_000),
    ...(period.starts !== undefined ? { starts: period.starts } : {}),
    ...(period.timezone !== undefined ? { timezone: period.timezone } : {}),
  };
  const problem = budgetPeriodProblem(def);
  return problem === undefined
    ? { kind: "period", def }
    : { kind: "unreadable", detail: `budget.period: ${problem}` };
}

const firstLine = (text: string): string => text.split("\n")[0] ?? text;

/** The period the harness's spec declares, or `undefined` when it declares none or cannot be read. */
export function specPeriodOf(harnessDir: string): BudgetPeriodDef | undefined {
  const read = readSpecPeriod(harnessDir);
  return read.kind === "period" ? read.def : undefined;
}

/** A directory with no spec, or a spec that cannot be read, refused in words: never "no limit". */
function refuseUnknownPeriod(label: string, read: SpecPeriod): never {
  if (read.kind === "no-spec") {
    throw new Refused(
      `${label}: no harness here (no crewhaus.yaml). Pass --harness <id>, or run it from the harness's directory.`,
      exitFor("not_found"),
    );
  }
  const detail = read.kind === "unreadable" ? read.detail : "it could not be read";
  throw new Refused(
    `${label}: the harness's spec could not be read, so its spending limit is unknown (${detail}). \`crewhaus lint crewhaus.yaml\` in its directory says what to fix.`,
    exitFor("invalid"),
  );
}

const dollars = (micros: number): string => `$${(micros / 1_000_000).toFixed(2)}`;

/** `1 Dec 2026`: the day the period renews, in the period's own zone. */
const dateOf = (fold: Pick<BudgetFold, "renewsAt" | "timezone">): string =>
  renewalDay(fold.renewsAt, fold.timezone) ?? fold.renewsAt;

const PERIOD_WORD: Readonly<Record<BudgetFold["every"], string>> = {
  day: "today",
  week: "this week",
  month: "this month",
};

/** What `show` prints for a fold. */
export function foldLines(fold: BudgetFold): string[] {
  const limit = fold.capUsdMicros + fold.extensionsUsdMicros;
  const lines = [
    `Spending limit ${PERIOD_WORD[fold.every]}: ${dollars(fold.spentUsdMicros)}${
      fold.unknownCalls > 0 ? " + unknown" : ""
    } of ${dollars(limit)} used${
      fold.reservedUsdMicros > 0
        ? `, ${dollars(fold.reservedUsdMicros)} held for calls in flight`
        : ""
    }.`,
  ];
  if (fold.extensionsUsdMicros > 0) {
    lines.push(`Raised by ${dollars(fold.extensionsUsdMicros)} this period.`);
  }
  if (fold.unknownCalls > 0) {
    lines.push(
      `${fold.unknownCalls} call${fold.unknownCalls === 1 ? "" : "s"} used a model with no price, so the spend is a lower bound. \`crewhaus models audit\` lists them.`,
    );
  }
  lines.push(
    fold.exhausted
      ? `The limit is used up: new work waits until it renews on ${dateOf(fold)}. \`crewhaus budget extend --usd <amount> --reason <code>\` raises it.`
      : `It renews on ${dateOf(fold)}.`,
  );
  if (fold.truncated || fold.gaps > 0) {
    lines.push("Some ledger lines could not be read, so these totals are lower bounds.");
  }
  return lines;
}

function historyLines(periods: readonly BudgetPeriodSummary[]): string[] {
  if (periods.length === 0) return ["No period has closed yet."];
  return [...periods]
    .reverse()
    .map(
      (p) =>
        `${p.periodId}  ${dollars(p.spentUsdMicros)}${p.unknownCalls > 0 ? " + unknown" : ""} spent${
          p.extensionsUsdMicros > 0 ? `, raised ${dollars(p.extensionsUsdMicros)}` : ""
        }`,
    );
}

/** A raise in dollars: positive, at most two decimals. */
function usdOf(raw: string | undefined): number {
  if (raw === undefined || !/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(raw)) {
    throw new Refused(
      "budget extend: --usd takes an amount in dollars, such as 50 or 12.50",
      exitFor("invalid"),
    );
  }
  const usd = Number(raw);
  if (!(usd > 0)) throw new Refused("budget extend: --usd must be more than 0", exitFor("invalid"));
  return usd;
}

/** The one entry `index.ts` calls. */
export async function runBudgetCommand(
  argv: readonly string[],
  deps: BudgetDeps = {},
): Promise<BudgetOut> {
  const sub = argv[0];
  if (
    sub === undefined ||
    sub === "--help" ||
    sub === "-h" ||
    argv.includes("--help") ||
    argv.includes("-h")
  ) {
    return { lines: USAGE, exitCode: 0 };
  }
  if (!Object.hasOwn(CLI_FAMILY.sub, sub)) {
    throw new Error(
      `unknown budget verb "${sub}" (expected: ${Object.keys(CLI_FAMILY.sub).join(" | ")})`,
    );
  }
  const verb = sub as Sub;
  const now = deps.now ?? Date.now;
  try {
    const label = `budget ${verb}`;
    const args = parseArgs(label, argv.slice(1), CLI_FAMILY.sub[verb].flags);
    const json = args.booleans.has("json");
    const dir = harnessDirOf(args.values.get("harness")?.[0], deps);
    const read = readSpecPeriod(dir);
    if (read.kind === "no-spec") refuseUnknownPeriod(label, read);
    if (verb === "history") {
      const history = readBudgetPeriods(dir);
      return {
        lines: json ? [JSON.stringify(history, null, 2)] : historyLines(history.periods),
        exitCode: 0,
      };
    }
    if (read.kind === "unreadable") refuseUnknownPeriod(label, read);
    if (read.kind === "none") {
      const line =
        "No spending limit for a period: each run keeps only its own cap. Add `budget.period` to the spec to set one.";
      if (verb === "show") {
        return {
          lines: json ? [JSON.stringify({ present: false, note: line }, null, 2)] : [line],
          exitCode: 0,
        };
      }
      return { lines: [`budget extend: ${line}`], exitCode: exitFor("conflict") };
    }
    const def = read.def;
    if (verb === "show") {
      const fold = foldBudget(dir, def, now());
      return {
        lines: json ? [JSON.stringify({ present: true, fold }, null, 2)] : foldLines(fold),
        exitCode: 0,
      };
    }
    // extend
    const env = deps.env ?? process.env;
    const agentTool = env[AGENT_TOOL_ENV];
    if (agentTool !== undefined && agentTool !== "") {
      return {
        lines: ["budget extend: this command was started by an agent's tool; a person does this"],
        exitCode: exitFor("forbidden"),
      };
    }
    const usd = usdOf(args.values.get("usd")?.[0]);
    const reasonCode = args.values.get("reason")?.[0];
    if (
      reasonCode === undefined ||
      !(BUDGET_EXTEND_REASONS as readonly string[]).includes(reasonCode)
    ) {
      throw new Refused(
        `budget extend: --reason is one of ${BUDGET_EXTEND_REASONS.join(", ")}`,
        exitFor("invalid"),
      );
    }
    const current = periodOf(def, now());
    const expect = args.values.get("expect")?.[0] ?? current.periodId;
    const control =
      deps.control?.() ?? directControl({ ...(deps.env !== undefined ? { env: deps.env } : {}) });
    const answer = await control.commands.submit<BudgetExtendAnswer>(
      {
        kind: "budget.extend",
        ledger: { harness: dir },
        via: "cli",
        body: { usd, reasonCode, expect },
      },
      (receipt) =>
        applyBudgetExtend(
          { receipt, harnessDir: dir, def, nowMs: now() },
          { usd, reasonCode, expect },
        ),
    );
    if (!answer.ok) {
      return {
        lines: [`budget extend: ${answer.refusal.message}`],
        exitCode: exitFor(answer.refusal.code as ErrorCode),
      };
    }
    if (answer.replayed) {
      return {
        lines: ["budget extend: this raise was already submitted"],
        exitCode: exitFor("conflict"),
      };
    }
    const value = answer.value;
    if (value === undefined) {
      return { lines: ["budget extend: the raise did not run"], exitCode: exitFor("unavailable") };
    }
    if (!value.ok) {
      return value.code === "stale"
        ? {
            lines: [
              `budget extend: that period is over; the current one is ${value.periodId}. A raise applies to the current period only.`,
            ],
            exitCode: exitFor("precondition_failed"),
          }
        : { lines: [`budget extend: ${value.detail}`], exitCode: exitFor("unavailable") };
    }
    if (json) {
      return {
        lines: [JSON.stringify({ receipt: answer.receipt.id, fold: value.fold }, null, 2)],
        exitCode: 0,
      };
    }
    return {
      lines: [
        `Raised by ${dollars(Math.round(usd * 1_000_000))} for ${PERIOD_WORD[value.fold.every]}. It resets on ${dateOf(value.fold)}.`,
        `receipt ${answer.receipt.id}`,
      ],
      exitCode: 0,
    };
  } catch (err) {
    if (err instanceof Refused) return { lines: [err.message], exitCode: err.exitCode };
    throw err;
  }
}

/**
 * The harness's period ledger for the optimizer's own model calls, opened with trigger
 * `optimize` when the spec at `specPath` declares `budget.period`; `{}` otherwise.
 *
 * First consumers: `crewhaus optimize` and `crewhaus flywheel run`.
 */
export function optimizeSpendLedger(specPath: string): {
  readonly spendLedger?: ReturnType<typeof openBudgetLedger>;
} {
  const dir = dirname(resolve(specPath));
  const def = specPeriodOf(dir);
  return def === undefined
    ? {}
    : { spendLedger: openBudgetLedger(dir, def, { trigger: "optimize" }) };
}
