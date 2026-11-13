/**
 * What a start decides before it acts, kept in one place so a restart can ask the same
 * questions before it stops the daemon it replaces.
 *
 *   - {@link operatorRefusal}: the operator record. A harness its operator disabled, or
 *     whose record cannot be read, is not started, restarted or restarted after adoption,
 *     whatever build it runs. A pause alone refuses no start.
 *   - {@link decideStart}: every refusal a start can decide without compiling, writing or
 *     spawning: the operator record, its plan, the preflight gate and the build check. A
 *     restart asks it while the daemon still runs and, on a refusal, leaves that daemon
 *     running.
 *   - {@link automaticSpecRefusal}: an automatic start of a launch that runs the saved
 *     spec (`crewhaus run`, `serve --mcp`) runs it only while it is the active
 *     deployment's spec.
 */
import { readFileSync } from "node:fs";
import { assertRunnable, readDeployments, readOperatorRecord } from "@crewhaus/control-records";
import { sameRevision, specRevision } from "@crewhaus/ir/policy";
import {
  BUILD_NOT_ACTIVE_MESSAGE,
  SPEC_NOT_ACTIVE_MESSAGE,
  artifactOf,
  launchedEntryOf,
  verifyActiveBuild,
} from "./active-build";
import type { GateDecision, GateOptions } from "./gate";
import type { PrepareRunner } from "./prepare";
import type { SpawnPlan } from "./spawn-contracts";
import type { StartResult, SupervisorOptions } from "./supervisor";

/** A start's refusal. */
export type StartRefusal = Extract<StartResult, { readonly ok: false }>;

/** Preflight areas a running daemon holds: a restart decides them after its stop. */
const HELD_BY_THE_RUNNING_DAEMON: ReadonlySet<string> = new Set(["ports"]);

export type StartDecisionInput = Pick<
  SupervisorOptions,
  "harnessDir" | "target" | "plan" | "gate" | "prepare" | "admit"
> & {
  /** The options the start after the stop would pass the gate. */
  readonly gateOptions: GateOptions;
};

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** The gate's decision with the items a running daemon holds left out. */
function withoutHeldItems(decision: GateDecision): GateDecision {
  const deciding = (item: GateDecision["refused"][number]): boolean =>
    !HELD_BY_THE_RUNNING_DAEMON.has(item.area);
  const refused = decision.refused.filter(deciding);
  return {
    ...decision,
    allowed: refused.length === 0,
    refused,
    unforceable: decision.unforceable.filter(deciding),
  };
}

/**
 * Why the operator record refuses a start: disabled, or unreadable. Read now, never from
 * the one-second cache, because a start is rare and must see a disable written a moment
 * ago. Undefined when it may start, a pause included.
 *
 * First consumers: the supervisor's `start()` and {@link decideStart}.
 */
export function operatorRefusal(harnessDir: string): StartRefusal | undefined {
  const read = readOperatorRecord.refresh(harnessDir);
  const verdict = assertRunnable(harnessDir, { mode: "start", read: () => read });
  if (verdict.ok) return undefined;
  if (read.state === "unreadable") {
    return {
      ok: false,
      reason: "disabled",
      exitName: "disabled",
      cause: "unreadable",
      message: `The operator record can't be read (${read.reason}), so nothing starts.`,
    };
  }
  return {
    ok: false,
    reason: "disabled",
    exitName: "disabled",
    cause: "disabled",
    message: `Disabled by its operator, so it doesn't start. Run \`crewhaus daemon enable ${harnessDir}\` to allow starts.`,
  };
}

/**
 * Every refusal the start after a restart's stop would make that can be decided now,
 * writing nothing and spawning nothing:
 *
 *   0. the operator record ({@link operatorRefusal});
 *   1. the plan (a throw is `plan-failed`);
 *   2. the preflight gate with the same options, every area but `ports`, which the running
 *      daemon holds until it stops; `workspace.holds-home` decides here like any other;
 *   3. the build: when the start's compile step will not compile, an active-only start
 *      needs the active build, and a person's start of a compiled launch needs its head's
 *      admission, asked in decide-only mode.
 *
 * When the start's compile step may compile, its build is decided only after the compile,
 * as the start always does; operator hooks also run only in the start itself. Answers the
 * refusal, or undefined when nothing decided now refuses.
 *
 * First consumer: the supervisor's restart, before it stops a running daemon.
 */
export async function decideStart(input: StartDecisionInput): Promise<StartRefusal | undefined> {
  const operator = operatorRefusal(input.harnessDir);
  if (operator !== undefined) return operator;
  let plan: SpawnPlan;
  try {
    plan = await input.plan();
  } catch (err) {
    return { ok: false, reason: "plan-failed", stage: "plan", error: toError(err) };
  }
  if (input.gate !== undefined) {
    const decision = withoutHeldItems(await input.gate(input.gateOptions));
    if (!decision.allowed) return { ok: false, reason: "preflight-blocked", gate: decision };
  }
  if (plan.launchMode !== "compiled") return undefined;
  const runner: PrepareRunner | undefined = input.prepare?.();
  const forecast = runner?.forecast() ?? { compileMayRun: false, activeOnly: false };
  if (forecast.compileMayRun) return undefined;
  const launched = launchedEntryOf(input.harnessDir, plan.bundleDir, plan.entry);
  if (forecast.activeOnly) {
    const check = verifyActiveBuild(input.harnessDir, input.target, launched);
    return check.ok ? undefined : { ok: false, reason: "build-not-active", message: check.message };
  }
  if (input.admit === undefined) return undefined;
  const admitted = await input.admit({
    harnessDir: input.harnessDir,
    target: input.target,
    entry: launched,
    ledgerAbsent: readDeployments(input.harnessDir).state === "absent",
    decideOnly: true,
  });
  if (!admitted.ok) return { ok: false, reason: "build-not-active", message: admitted.message };
  if (
    admitted.deployment !== undefined &&
    artifactOf(admitted.deployment.record)?.entry !== launched
  ) {
    return { ok: false, reason: "build-not-active", message: BUILD_NOT_ACTIVE_MESSAGE };
  }
  return undefined;
}

/**
 * Why an automatic start of a launch that runs the saved spec may not run it: while a
 * deployment is active, the saved spec must be that deployment's revision. A spec that
 * cannot be read, an active record that names no revision and records that cannot be read
 * refuse too. Undefined when it may run, including when no deployment is active.
 *
 * First consumer: the supervisor's automatic starts of interpreter and cli-verb launches.
 */
export function automaticSpecRefusal(
  harnessDir: string,
  specPath: string | undefined,
): string | undefined {
  const read = readDeployments(harnessDir);
  if (read.state === "unreadable") {
    return `The deployment records can't be read (${read.reason}), so nothing starts automatically.`;
  }
  if (read.state === "absent" || read.active === undefined) return undefined;
  const artifact = read.active["artifact"];
  const active =
    typeof artifact === "object" && artifact !== null
      ? (artifact as { readonly specHash?: unknown }).specHash
      : undefined;
  let saved: string | undefined;
  try {
    saved = specPath === undefined ? undefined : specRevision(readFileSync(specPath, "utf8"));
  } catch {
    saved = undefined;
  }
  return sameRevision(saved, active) ? undefined : SPEC_NOT_ACTIVE_MESSAGE;
}
