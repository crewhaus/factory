/**
 * The runtime area's budget half in Home's versioned API (#516, module brief 324): the
 * current period, the closed periods, and a maintainer's raise. The period comes from the
 * harness's own spec; a read folds the harness's ledger and writes nothing. A raise is a
 * harness command whose effect appends one topup carrying its receipt, for the current
 * period only: a raise for any other period answers 412 with the current one.
 *
 * Its ledger lines reach the harness's stream as `budget.*` events (`./budget-stream.ts`).
 *
 * Also the area's sweep (one summary line per closed period, and a closed period's
 * segments removed once the period after it has closed) and its capability keys
 * (`budget.period`, `budget.reservations`), unsupported for a bundle compiled before
 * spending periods existed.
 */
import { readFileSync } from "node:fs";
import { BUDGET_CAPABILITY_KEYS } from "@crewhaus/control-contract";
import { periodOf, sweepBudgetPeriods } from "@crewhaus/control-records/budget";
import { applyBudgetExtend } from "@crewhaus/control-service";
import { budgetPeriodOf, declaredBudgetPeriod, readBudget, readBudgetHistory } from "../budget";
import { resolveContained } from "../safety";
import type { Sweep } from "../scheduler-host";
import type { HomePorts } from "../sweeps";
import type { HomeAreaRuntime } from "./areas";
import { BUDGET_STREAM_SOURCE } from "./budget-stream";
import { readCompiledWith } from "./compiler";
import type { CapabilityProvider, V1Handler } from "./context";
import { V1Error } from "./errors";
import { harnessOf, liveDirOr409 } from "./resolve";
import { acceptedAnswer, submitCommand } from "./submit";

/** The most of a spec Home reads to find its period. */
const SPEC_MAX_BYTES = 1024 * 1024;

/**
 * The harness's spec text, read contained to its directory; `undefined` when it is
 * missing, cannot be read or is larger than Home reads.
 */
export function readSpecText(harnessDir: string): string | undefined {
  const path = resolveContained(harnessDir, "crewhaus.yaml");
  if (path === undefined) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    return text.length > SPEC_MAX_BYTES ? undefined : text;
  } catch {
    return undefined;
  }
}

/** The harness's spec text, or "" when {@link readSpecText} has none. */
export function specTextOf(harnessDir: string): string {
  return readSpecText(harnessDir) ?? "";
}

const get: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  // What the screen offers: the raise only to a caller that holds it.
  const you = {
    extend: ctx.access.authorize("h.budget.extend", { harness: entry.id }).allow,
  };
  return {
    status: 200,
    body: { ...readBudget(dir, readSpecText(dir), ctx.deps.now(), entry.id), you },
  };
};

const periods: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  return { status: 200, body: readBudgetHistory(dir, entry.id) };
};

const extend: V1Handler = async (ctx) => {
  const entry = harnessOf(ctx);
  const dir = liveDirOr409(entry);
  const read = budgetPeriodOf(readSpecText(dir));
  if (read.kind === "unreadable") {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "spec_unreadable",
      message: "This harness's spec could not be read, so its spending limit is unknown.",
      remedy: "Run `crewhaus lint crewhaus.yaml` in its directory to see why.",
    });
  }
  if (read.kind === "none") {
    throw new V1Error({
      status: 409,
      code: "conflict",
      reason: "no_period",
      message: "This harness declares no spending period, so there is no limit to raise.",
      remedy: "Add `budget.period` to its spec to give it one.",
    });
  }
  const def = read.def;
  const usd = Number(ctx.body["usd"]);
  const reasonCode = String(ctx.body["reasonCode"]);
  const expect = String(ctx.body["expect"]);
  const current = periodOf(def, ctx.deps.now()).periodId;
  if (expect !== current) {
    throw new V1Error({
      status: 412,
      code: "precondition_failed",
      reason: "stale_period",
      message: "That period is over: a raise applies to the current period only.",
      current: { periodId: current },
    });
  }
  const submitted = await submitCommand(ctx, {
    target: `home/harness/${entry.id}`,
    ledger: { harness: dir },
    effect: (receipt) =>
      applyBudgetExtend(
        { receipt, harnessDir: dir, def, nowMs: ctx.deps.now() },
        { usd, reasonCode, expect },
      ),
  });
  const value = submitted.value;
  if (value !== undefined && !value.ok && value.code === "stale") {
    throw new V1Error({
      status: 412,
      code: "precondition_failed",
      reason: "stale_period",
      message: "That period is over: a raise applies to the current period only.",
      current: { periodId: value.periodId },
    });
  }
  return acceptedAnswer(submitted, value?.ok === true ? { fold: value.fold } : {}, dir);
};

export const BUDGET_HANDLERS: Readonly<Record<string, V1Handler>> = {
  "budget.get": get,
  "budget.periods": periods,
  "budget.extend": extend,
};

/** The summaries of closed periods, for every live harness that declares a period. */
export const BUDGET_SWEEP: Sweep<HomePorts> = {
  name: "budget-periods",
  everyMs: 3_600_000,
  run: ({ home, now, warn }) => {
    for (const harness of home.liveHarnesses()) {
      const def = declaredBudgetPeriod(specTextOf(harness.dir));
      if (def === undefined) continue;
      try {
        sweepBudgetPeriods(harness.dir, def, now);
      } catch (err) {
        warn(`the budget periods of ${harness.id}: ${(err as Error).message}`);
      }
    }
  },
};

/** The release spending periods and reservations arrived in. */
const BUDGET_SINCE = [0, 9] as const;

/** Whether a `major.minor…` version is at least {@link BUDGET_SINCE}; `undefined` when unreadable. */
export function compiledWithBudget(version: string | undefined): boolean | undefined {
  const match = version === undefined ? null : /^(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > BUDGET_SINCE[0] || (major === BUDGET_SINCE[0] && minor >= BUDGET_SINCE[1]);
}

/** `budget.period` and `budget.reservations`, by the version the harness's bundle was built with. */
export const BUDGET_CAPABILITIES: readonly CapabilityProvider[] = BUDGET_CAPABILITY_KEYS.map(
  (key) => ({
    key,
    answer: async (entry) => {
      const built = compiledWithBudget(readCompiledWith(entry));
      if (built === undefined) {
        return {
          supported: "unknown" as const,
          reason:
            "This harness has no build to read, so whether it keeps spending periods is unknown.",
        };
      }
      return built
        ? { supported: true as const }
        : {
            supported: false as const,
            reason: "This build is older than spending periods. Compile it again to use them.",
            verb: "crewhaus compile",
          };
    },
  }),
);

/** The budget half of the runtime area's Home entry; `./work.ts` composes the area's slot. */
export const BUDGET_HOME = {
  sweeps: [BUDGET_SWEEP],
  handlers: BUDGET_HANDLERS,
  capabilityProviders: BUDGET_CAPABILITIES,
  streamSources: [BUDGET_STREAM_SOURCE],
} as const satisfies Omit<HomeAreaRuntime, "area">;
