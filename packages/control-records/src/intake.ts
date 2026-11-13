/**
 * One answer to whether new work may enter (#513). For door authors: read `state`,
 * `code`, `notice` and `retryAfter`; never switch exhaustively on `reasons[].kind`,
 * because a reason can join here without any door changing.
 *
 * Reasons stay independent, so lifting one never lifts another. The SLO gate keeps its
 * own file, unread here, so SLO recovery can never lift an operator pause.
 */
import { type OperatorRead, readOperatorRecord } from "./operator";

export type IntakeReason = {
  readonly kind: "operator";
  readonly state: "paused" | "disabled" | "unreadable";
  readonly since?: string;
  readonly by?: string;
  readonly cmd?: string;
  /** Why the record could not be read. */
  readonly detail?: string;
};

export type IntakeVerdict =
  | { readonly state: "open" }
  | {
      readonly state: "closed";
      readonly reasons: readonly IntakeReason[];
      /** Text a person sees; `null` when the operator chose quiet. */
      readonly notice: string | null;
      /** Maps to each door's own wire form. */
      readonly code: "paused" | "disabled";
      /**
       * The `EXIT_CODES` name a door exits with. A door puts `code` on the wire and
       * `exitName` on an exit, and switches on neither.
       */
      readonly exitName: "paused" | "disabled";
      /** Seconds. Absent from every operator answer: a door supplies its own default. */
      readonly retryAfter?: number;
    };

const FIXED_NOTICE = {
  paused: "Paused by its operator; this message was not processed.",
  disabled: "Disabled by its operator; this message was not processed.",
} as const;

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
): IntakeVerdict {
  if (reasons.length === 0) return { state: "open" };
  const code = reasons.some((r) => r.state === "disabled") ? "disabled" : "paused";
  return {
    state: "closed",
    reasons,
    notice: recordNotice === undefined ? FIXED_NOTICE[code] : recordNotice,
    code,
    exitName: code,
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
  options: { readonly read?: (harnessDir: string) => OperatorRead } = {},
): IntakeVerdict {
  const read = (options.read ?? readOperatorRecord)(harnessDir);
  return composeIntake(operatorReasons(read), operatorNotice(read));
}
