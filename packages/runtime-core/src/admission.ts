/**
 * Admission at loop start: in a process that serves a control plane, a loop starts new
 * work only while the harness's operator record lets it.
 *
 * The control plane names its harness directory when it starts (`registerIntakeRoot` in
 * `@crewhaus/control-records`), so a compiled daemon or batch worker answers to its
 * operator record here. A process that serves none, every CLI process, an eval or the
 * REPL, admits every loop: its entry point decides instead.
 *
 * In that process, in this order:
 *   1. Work already admitted continues: a loop whose context names a `parent`, or whose
 *      run an earlier loop's admission let through here and is still held (a crew's, a
 *      graph's or a workflow's later loop). A run held before any of its loops was
 *      admitted is new work: the first loop of a crew or a graph is asked like any other.
 *   2. An open intake verdict admits.
 *   3. While paused, never while disabled, a loop that resumes a session is admitted
 *      once for each one-time grant waiting there, so a granted request re-drives its
 *      parked call: the grant is unconsumed, inside the approval store's retention
 *      window, asked in this loop's resume scope and not a standing ("always") allow,
 *      and no earlier loop in this process was admitted on it. The session root's
 *      approvals are read with `foldReadOnly`, which writes nothing.
 *   4. Anything else is refused before any row, session write or model call: a channel
 *      turn answers the verdict's notice as its reply (an empty reply for a quiet pause,
 *      which the router does not send), and every other loop throws a `RunFailedError`
 *      whose class and exit are the verdict's `exitName`.
 */
import { effectiveDecisionState } from "@crewhaus/control-contract";
import { type IntakeVerdict, intakeRoot, intakeVerdict } from "@crewhaus/control-records";
import { EXIT_CODES, type FailureReport, RunFailedError } from "@crewhaus/errors";
import { type Logger, createLogger } from "@crewhaus/logging";
import { isRunHeld } from "@crewhaus/run-context";
import {
  DEFAULT_ROOT_DIR,
  DEFAULT_TTL_DAYS,
  foldReadOnly,
  recordInScope,
} from "@crewhaus/session-store";

type ClosedVerdict = Extract<IntakeVerdict, { readonly state: "closed" }>;

/** What a loop's admission answers: run, or reply with `reply` and run nothing. */
export type LoopAdmission =
  | { readonly admit: true }
  | { readonly admit: false; readonly reply: string };

/** The pure decision: admit, reply, or fail with a report. */
export type LoopDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly code: ClosedVerdict["code"]; readonly reply: string }
  | { readonly admit: false; readonly code: ClosedVerdict["code"]; readonly report: FailureReport };

/** What the decision reads. The two reads are thunks, so each is taken only when needed. */
export type LoopAdmissionInputs = {
  /** Whether this process serves a control plane (an intake root is registered). */
  readonly served: boolean;
  /** A child loop, or a later loop on a run this process admitted and still holds. */
  readonly continuing: boolean;
  readonly verdict: () => IntakeVerdict;
  /**
   * Whether a one-time grant waits for this loop's re-drive. Asked only while paused,
   * and only when its answer decides: a `true` admits the loop on that grant.
   */
  readonly grantWaiting: () => boolean;
  readonly sessionTarget: string | undefined;
};

const TITLE: Readonly<Record<ClosedVerdict["exitName"], string>> = {
  paused: "paused by its operator",
  disabled: "disabled by its operator",
};

/**
 * The decision for one loop, from its inputs. A channel turn is refused with a reply;
 * any other loop with a report, no remediation verb included.
 */
export function loopAdmission(inputs: LoopAdmissionInputs): LoopDecision {
  if (!inputs.served || inputs.continuing) return { admit: true };
  const verdict = inputs.verdict();
  if (verdict.state === "open") return { admit: true };
  if (verdict.code === "paused" && inputs.grantWaiting()) return { admit: true };
  if (inputs.sessionTarget === "channel") {
    return { admit: false, code: verdict.code, reply: verdict.notice ?? "" };
  }
  const title = TITLE[verdict.exitName];
  return {
    admit: false,
    code: verdict.code,
    report: {
      class: verdict.exitName,
      title,
      detail: verdict.notice ?? title,
      exitCode: EXIT_CODES[verdict.exitName],
    },
  };
}

const MS_PER_DAY = 86_400_000;

/**
 * The grants that have each admitted one loop while paused, by approval id. A grant
 * admits one re-drive per process; the next message in its conversation is asked
 * again. Grows by one per admission it records, and only while paused.
 */
const grantsSpent = new Set<string>();

/**
 * Take the grant waiting in `sessionRoot` for a loop that resumes `sessionId` in
 * `resumeScope`, and answer whether there was one. A grant is taken when it is the
 * session's, asked in that scope (`recordInScope`), a one-time grant (never a standing
 * "always" allow), inside the store's retention window (`DEFAULT_TTL_DAYS` from its
 * park, the store's own `get` rule), `granted` now, and not yet taken in this process.
 */
function takeWaitingGrant(sessionRoot: string, sessionId: string, resumeScope: string): boolean {
  const now = Date.now();
  const cutoff = now - DEFAULT_TTL_DAYS * MS_PER_DAY;
  for (const record of foldReadOnly(sessionRoot).records) {
    if (record.sessionId !== sessionId || grantsSpent.has(record.id)) continue;
    if (record.always === true || !recordInScope(record, resumeScope)) continue;
    const parked = Date.parse(record.createdAt);
    if (!Number.isFinite(parked) || parked < cutoff) continue;
    if (effectiveDecisionState(record, null, now).state !== "granted") continue;
    grantsSpent.add(record.id);
    return true;
  }
  return false;
}

/** How many admitted runs are remembered at most; runs no loop holds go first. */
const ADMITTED_RUNS_CAP = 4096;

/**
 * The runs a top-level loop's admission let through in this process. `seenHeld`
 * marks a run some sweep found held, so the entry goes once its last hold is released.
 */
const admittedRuns = new Map<string, { seenHeld: boolean }>();

/** Forget the admitted runs that have ended, and keep the map within its cap. */
function sweepAdmittedRuns(): void {
  for (const [runId, entry] of admittedRuns) {
    if (isRunHeld(runId)) entry.seenHeld = true;
    else if (entry.seenHeld) admittedRuns.delete(runId);
  }
  while (admittedRuns.size >= ADMITTED_RUNS_CAP) {
    let victim: string | undefined;
    for (const runId of admittedRuns.keys()) {
      if (!isRunHeld(runId)) {
        victim = runId;
        break;
      }
    }
    victim ??= admittedRuns.keys().next().value;
    if (victim === undefined) break;
    admittedRuns.delete(victim);
  }
}

/** Whether `runId` is a run this process admitted and still holds. */
function admittedAndHeld(runId: string): boolean {
  return admittedRuns.has(runId) && isRunHeld(runId);
}

/** The fields of a loop's options admission reads. */
export type AdmissionLoopOptions = {
  readonly runContext?: {
    readonly runId: string;
    readonly parent?: string;
    readonly resumeScope?: string;
    readonly logger?: Logger;
  };
  readonly resume?: { readonly sessionId: string };
  readonly sessionTarget?: string;
};

/**
 * Admit one `runChatLoop` invocation, once, before it records anything. `sessionRoot`
 * answers the loop's session root (`undefined` for session-store's default). A refused
 * channel turn answers `{admit: false, reply}`; any other refused loop throws the
 * report's `RunFailedError`. One log line per refusal, without the message text.
 */
export function admitLoop(
  opts: AdmissionLoopOptions,
  sessionRoot: () => string | undefined,
): LoopAdmission {
  const root = intakeRoot();
  const ctx = opts.runContext;
  const resume = opts.resume;
  sweepAdmittedRuns();
  const decision = loopAdmission({
    served: root !== undefined,
    continuing: ctx !== undefined && (ctx.parent !== undefined || admittedAndHeld(ctx.runId)),
    verdict: (): IntakeVerdict => (root === undefined ? { state: "open" } : intakeVerdict(root)),
    grantWaiting: () =>
      resume !== undefined &&
      takeWaitingGrant(
        sessionRoot() ?? DEFAULT_ROOT_DIR,
        resume.sessionId,
        ctx?.resumeScope ?? `session:${resume.sessionId}`,
      ),
    sessionTarget: opts.sessionTarget,
  });
  if (decision.admit) {
    // A top-level loop let through: its run's later loops continue while it is held.
    if (ctx !== undefined && ctx.parent === undefined && !admittedRuns.has(ctx.runId)) {
      admittedRuns.set(ctx.runId, { seenHeld: isRunHeld(ctx.runId) });
    }
    return decision;
  }
  (ctx?.logger ?? createLogger()).info("new work refused: intake is closed by its operator", {
    code: decision.code,
    ...(opts.sessionTarget !== undefined ? { sessionTarget: opts.sessionTarget } : {}),
  });
  if ("report" in decision) throw new RunFailedError(decision.report);
  return { admit: false, reply: decision.reply };
}
