/**
 * One state vocabulary for every item. A decision item's state is the decision's own, as
 * every other reader computes it (`effectiveDecisionState`); a problem item is open until
 * newer evidence clears it, expires when nothing newer than its kind's window has been
 * seen, and is superseded when a newer revision of it replaced it. A derived state that
 * the `attention` machine does not allow from `open` reads `open`: the record is shown,
 * never a move it cannot make.
 */
import {
  type AttentionResolution,
  type AttentionState,
  type DecisionRecordView,
  canTransition,
  effectiveDecisionState,
} from "@crewhaus/control-contract";

/** A problem with no evidence newer than this is no longer open. */
export const PROBLEM_WINDOW_MS = 7 * 86_400_000;

export type AttentionStateInput =
  | {
      readonly source: "decision";
      readonly record: DecisionRecordView;
      /** When a pending request stops waiting even with no deadline of its own (its TTL). */
      readonly ttlAt?: number;
    }
  | {
      readonly source: "problem";
      /** The newest failure's time. */
      readonly latestAt: number;
      /** The newest success after every failure, when one cleared them. */
      readonly clearedAt?: number;
      readonly superseded?: boolean;
      readonly windowMs?: number;
    };

export type EffectiveAttention = {
  readonly state: AttentionState;
  readonly resolution?: {
    readonly how: AttentionResolution;
    readonly at: string;
    readonly via?: string;
  };
};

function checked(answer: EffectiveAttention): EffectiveAttention {
  if (answer.state === "open" || canTransition("attention", "open", answer.state)) return answer;
  return { state: "open" };
}

/** An item's state as of `now`. Pure. */
export function effectiveAttentionState(
  input: AttentionStateInput,
  now: number,
): EffectiveAttention {
  if (input.source === "problem") {
    if (input.superseded === true) return checked({ state: "superseded" });
    if (input.clearedAt !== undefined && input.clearedAt >= input.latestAt) {
      return checked({
        state: "resolved",
        resolution: { how: "cleared", at: new Date(input.clearedAt).toISOString() },
      });
    }
    if (now - input.latestAt > (input.windowMs ?? PROBLEM_WINDOW_MS)) {
      return checked({ state: "expired" });
    }
    return { state: "open" };
  }
  const record = input.record;
  const effective = effectiveDecisionState(record, null, now);
  switch (effective.state) {
    case "pending":
      if (input.ttlAt !== undefined && now > input.ttlAt && !effective.overdue) {
        return checked({ state: "expired" });
      }
      return { state: "open" };
    case "granted":
    case "denied":
    case "consumed": {
      const at = record.decidedAt ?? record.consumedAt ?? record.createdAt;
      const how: AttentionResolution = record.resolvedBy === "policy" ? "fallback" : "decided";
      return checked({
        state: "resolved",
        resolution: {
          how,
          at,
          ...(typeof record.decidedVia === "string" ? { via: record.decidedVia } : {}),
        },
      });
    }
    case "superseded":
      return checked({ state: "superseded" });
    default:
      return checked({ state: "expired" });
  }
}
