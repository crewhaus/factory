/**
 * One answer to whether new work may enter (#513). For door authors: read `state`,
 * `code`, `notice` and `retryAfter`; never switch exhaustively on `reasons[].kind`,
 * because a reason can join here without any door changing.
 *
 * Reasons stay independent, so lifting one never lifts another. The SLO gate keeps its
 * own file, unread here, so SLO recovery can never lift an operator pause.
 */
import { type BudgetStateRead, readBudgetState } from "./budget";
import { type OperatorRead, readOperatorRecord } from "./operator";

export type IntakeReason =
  | {
      readonly kind: "operator";
      readonly state: "paused" | "disabled" | "unreadable";
      readonly since?: string;
      readonly by?: string;
      readonly cmd?: string;
      /** Why the record could not be read. */
      readonly detail?: string;
    }
  | {
      /** The harness's budget period is used up until it renews. */
      readonly kind: "budget";
      readonly periodId: string;
      readonly renewsAt: string;
    };

export type IntakeVerdict =
  | {
      readonly state: "open";
      /**
       * Present only when the budget state could not be read. An unreadable budget
       * state closes nothing: it is not a safety control like the operator record.
       */
      readonly detail?: string;
    }
  | {
      readonly state: "closed";
      readonly reasons: readonly IntakeReason[];
      /** Text a person sees; `null` when the operator chose quiet. */
      readonly notice: string | null;
      /** Maps to each door's own wire form. Operator reasons win it over the budget. */
      readonly code: "paused" | "disabled" | "budget_exceeded";
      /**
       * The `EXIT_CODES` name a door exits with. A door puts `code` on the wire and
       * `exitName` on an exit, and switches on neither.
       */
      readonly exitName: "paused" | "disabled" | "crewhaus_budget";
      /**
       * Seconds. Absent from every operator answer: a door supplies its own default. A
       * budget-only answer carries the seconds until the period renews, and a door
       * never puts its own default in its place.
       */
      readonly retryAfter?: number;
    };

const FIXED_NOTICE = {
  paused: "Paused by its operator; this message was not processed.",
  disabled: "Disabled by its operator; this message was not processed.",
  budget_exceeded: "Its budget for this period is used up; this message was not processed.",
} as const;

/** The budget reason, while an exhausted period has not renewed. */
function budgetReasons(read: BudgetStateRead, nowMs: number): readonly IntakeReason[] {
  if (read.state !== "present") return [];
  const renews = Date.parse(read.record.renewsAt);
  if (!(nowMs < renews)) return [];
  return [{ kind: "budget", periodId: read.record.periodId, renewsAt: read.record.renewsAt }];
}

function operatorReasons(read: OperatorRead): readonly IntakeReason[] {
  if (read.state === "absent") return [];
  if (read.state === "unreadable") {
    return [{ kind: "operator", state: "unreadable", detail: read.reason }];
  }
  const reasons: IntakeReason[] = [];
  const { intake, deployment } = read.record;
  for (const [state, block, on] of [
    ["paused", intake, intake?.paused === true],
    ["disabled", deployment, deployment?.disabled === true],
  ] as const) {
    if (!on || block === null || block === undefined) continue;
    reasons.push({
      kind: "operator",
      state,
      ...(block.since !== undefined ? { since: block.since } : {}),
      ...(block.by !== undefined ? { by: block.by } : {}),
      ...(block.cmd !== undefined ? { cmd: block.cmd } : {}),
    });
  }
  return reasons;
}

/** The record's own notice, while its pause is in force. */
function operatorNotice(read: OperatorRead): string | null | undefined {
  if (read.state !== "present" || read.record.intake?.paused !== true) return undefined;
  return read.record.intake.notice;
}

/**
 * Compose reasons into one verdict. It is internal and list-shaped so another reason
 * joins here. Any disabled reason makes `code` disabled.
 */
export function composeIntake(
  reasons: readonly IntakeReason[],
  recordNotice: string | null | undefined,
  nowMs: number = Date.now(),
): IntakeVerdict {
  if (reasons.length === 0) return { state: "open" };
  const operator = reasons.filter((r) => r.kind === "operator");
  if (operator.length > 0) {
    const code = operator.some((r) => r.state === "disabled") ? "disabled" : "paused";
    return {
      state: "closed",
      reasons,
      notice: recordNotice === undefined ? FIXED_NOTICE[code] : recordNotice,
      code,
      exitName: code,
    };
  }
  // The budget alone: the wire code and the exit say so, with the wait until renewal.
  const renews = Math.min(
    ...reasons.map((r) =>
      r.kind === "budget" ? Date.parse(r.renewsAt) : Number.POSITIVE_INFINITY,
    ),
  );
  return {
    state: "closed",
    reasons,
    notice: FIXED_NOTICE.budget_exceeded,
    code: "budget_exceeded",
    exitName: "crewhaus_budget",
    ...(Number.isFinite(renews)
      ? { retryAfter: Math.max(1, Math.ceil((renews - nowMs) / 1000)) }
      : {}),
  };
}

/**
 * Whether new work may enter this harness. Synchronous; `read` is an injected reader for
 * tests, the default operator reader otherwise.
 *
 * First consumers: the doors that admit work (lanes, loop admission, gateway admission,
 * the queue consumer) and `assertRunnable`.
 */
export function intakeVerdict(
  harnessDir: string,
  options: {
    readonly read?: (harnessDir: string) => OperatorRead;
    readonly readBudget?: (harnessDir: string) => BudgetStateRead;
    readonly now?: () => number;
  } = {},
): IntakeVerdict {
  const read = (options.read ?? readOperatorRecord)(harnessDir);
  const budget = (options.readBudget ?? readBudgetState)(harnessDir);
  const nowMs = (options.now ?? Date.now)();
  const verdict = composeIntake(
    [...operatorReasons(read), ...budgetReasons(budget, nowMs)],
    operatorNotice(read),
    nowMs,
  );
  if (verdict.state === "open" && budget.state === "unreadable") {
    return { state: "open", detail: `the budget state cannot be read (${budget.reason})` };
  }
  return verdict;
}
