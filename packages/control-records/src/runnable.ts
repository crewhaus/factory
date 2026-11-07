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
      readonly exitName: "disabled" | "paused";
      readonly reason: "disabled" | "paused" | "unreadable";
      readonly since?: string;
      readonly by?: string;
      readonly cmd?: string;
    };

function refuse(
  exitName: "disabled" | "paused",
  reason: "disabled" | "paused" | "unreadable",
  from: IntakeReason | undefined,
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
  const reason = (state: IntakeReason["state"]): IntakeReason | undefined =>
    verdict.reasons.find((r) => r.kind === "operator" && r.state === state);

  const disabled = reason("disabled");
  if (disabled !== undefined) return refuse("disabled", "disabled", disabled);
  if (mode === "interactive") return { ok: true };

  const unreadable = reason("unreadable");
  if (unreadable !== undefined) {
    return refuse(mode === "run" ? "paused" : "disabled", "unreadable", unreadable);
  }
  if (mode === "start") return { ok: true };
  if (ignorePause === true) return { ok: true, pauseIgnored: true };
  return refuse("paused", "paused", reason("paused"));
}
