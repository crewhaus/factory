/**
 * One answer for every CLI entry point, derived from the intake verdict. It never exits
 * and never throws for an operator state: `exitName` names the exit code, and the caller
 * maps it and words the refusal.
 *
 * | Record                    | interactive  | run                                 | start        |
 * |---|---|---|---|
 * | absent, or open           | ok           | ok                                  | ok           |
 * | intake paused             | ok           | paused, or ok with `ignorePause`    | ok           |
 * | deployment disabled       | disabled     | disabled                            | disabled     |
 * | unreadable                | ok           | paused; `ignorePause` does not lift | disabled     |
 * | budget period used up     | ok           | budget; `ignorePause` does not lift | ok           |
 *
 * A disable outranks everything; the budget outranks a pause. A daemon keeps
 * serving the budget notice, and a REPL meets the refusal at its first model call.
 *
 * `interactive` is the REPL, because the person at the keyboard is the operator. `run`
 * is what runs with no one there: `run --prompt`, `run --input-file`, `eval`, `flywheel`,
 * `optimize`, `dream run`, `daemon submit`. `start` is `daemon start`, `serve`, `dev`.
 */
import { type IntakeReason, intakeVerdict } from "./intake";
import type { OperatorRead } from "./operator";

export type RunnableMode = "interactive" | "run" | "start";

export type RunnableVerdict =
  | { readonly ok: true; readonly pauseIgnored?: true }
  | {
      readonly ok: false;
      /** An `EXIT_FOR_ERROR` key: `budget_exceeded` exits 33. */
      readonly exitName: "disabled" | "paused" | "budget_exceeded";
      readonly reason: "disabled" | "paused" | "unreadable" | "budget";
      readonly since?: string;
      readonly by?: string;
      readonly cmd?: string;
      /** The used-up budget period, and when it renews. */
      readonly periodId?: string;
      readonly renewsAt?: string;
    };

type OperatorReason = Extract<IntakeReason, { kind: "operator" }>;

function refuse(
  exitName: "disabled" | "paused",
  reason: "disabled" | "paused" | "unreadable",
  from: OperatorReason | undefined,
): RunnableVerdict {
  return {
    ok: false,
    exitName,
    reason,
    ...(from?.since !== undefined ? { since: from.since } : {}),
    ...(from?.by !== undefined ? { by: from.by } : {}),
    ...(from?.cmd !== undefined ? { cmd: from.cmd } : {}),
  };
}

/**
 * Whether this entry point may run against this harness.
 *
 * First consumer: the CLI's entry points.
 */
export function assertRunnable(
  harnessDir: string,
  options: {
    readonly mode: RunnableMode;
    readonly ignorePause?: boolean;
    readonly read?: (harnessDir: string) => OperatorRead;
  },
): RunnableVerdict {
  const { mode, ignorePause, read } = options;
  const verdict = intakeVerdict(harnessDir, read !== undefined ? { read } : {});
  if (verdict.state === "open") return { ok: true };
  const reason = (state: OperatorReason["state"]): OperatorReason | undefined =>
    verdict.reasons.find((r): r is OperatorReason => r.kind === "operator" && r.state === state);

  const disabled = reason("disabled");
  if (disabled !== undefined) return refuse("disabled", "disabled", disabled);
  if (mode === "interactive") return { ok: true };

  // A used-up budget refuses a run whatever else holds; `--ignore-pause` never lifts it.
  const budget = verdict.reasons.find(
    (r): r is Extract<IntakeReason, { kind: "budget" }> => r.kind === "budget",
  );
  if (budget !== undefined && mode === "run") {
    return {
      ok: false,
      exitName: "budget_exceeded",
      reason: "budget",
      periodId: budget.periodId,
      renewsAt: budget.renewsAt,
    };
  }

  const unreadable = reason("unreadable");
  if (unreadable !== undefined) {
    return refuse(mode === "run" ? "paused" : "disabled", "unreadable", unreadable);
  }
  if (mode === "start") return { ok: true };
  const paused = reason("paused");
  // Only the budget held it (a start or REPL already returned above).
  if (paused === undefined) return { ok: true };
  if (ignorePause === true) return { ok: true, pauseIgnored: true };
  return refuse("paused", "paused", paused);
}
