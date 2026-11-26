/**
 * One state vocabulary for every item. A decision item's state is the decision's own, as
 * every other reader computes it (`effectiveDecisionState`); a problem item is open until
 * newer evidence clears it, expires when nothing newer than its kind's window has been
 * seen, and is superseded when a newer revision of it replaced it. A derived state that
 * the `attention` machine does not allow from `open` reads `open`: the record is shown,
 * never a move it cannot make.
 *
 * What people did about an item (its overlays) comes after: an open item reads assigned or
 * put off, and a problem reads resolved while the evidence it was set aside on is still the
 * newest. An item that waits on a record of its own is settled by that record alone.
 */
import {
  type AttentionResolution,
  type AttentionState,
  type DecisionRecordView,
  canTransition,
  effectiveDecisionState,
} from "@crewhaus/control-contract";
import type { ItemOverlay } from "./types";

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
    }
  | {
      /** An item as its records leave it, with what people did about it. */
      readonly source: "item";
      readonly state: AttentionState;
      readonly resolution?: EffectiveAttention["resolution"];
      /** It waits on a record of its own (a request, a review, a pause, a quorum). */
      readonly decides: boolean;
      /** Its record keeps its own deferral (a request's), so an overlay puts it off never. */
      readonly ownDeferral: boolean;
      readonly evidenceRev: string;
      /** One per harness the item is about. */
      readonly overlays: readonly ItemOverlay[];
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

/** An item's state with what people did about it. */
function overlaidState(
  input: Extract<AttentionStateInput, { source: "item" }>,
  now: number,
): EffectiveAttention {
  const as = {
    state: input.state,
    ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
  };
  // Only an open item (its own deferral included) can be assigned, put off or set aside.
  if (input.state !== "open" && input.state !== "deferred") return as;
  if (input.overlays.length === 0) return as;
  const closed = input.overlays.every(
    (o) => o.state === "resolved" && o.how !== undefined && o.evidenceRev === input.evidenceRev,
  );
  const last = input.overlays.reduce((a, b) => (a.at >= b.at ? a : b));
  if (closed && !input.decides) {
    return checked({
      state: "resolved",
      resolution: {
        how: last.how as AttentionResolution,
        at: last.at,
        ...(last.via !== undefined ? { via: last.via } : {}),
      },
    });
  }
  if (input.state === "deferred") return as;
  const putOff =
    !input.ownDeferral &&
    input.overlays.every((o) => {
      const until = o.deferredUntil === undefined ? Number.NaN : Date.parse(o.deferredUntil);
      return o.state === "deferred" && until > now;
    });
  if (putOff) return checked({ state: "deferred" });
  return input.overlays.some((o) => o.assignee !== undefined) ? checked({ state: "assigned" }) : as;
}

/** An item's state as of `now`. Pure. */
export function effectiveAttentionState(
  input: AttentionStateInput,
  now: number,
): EffectiveAttention {
  if (input.source === "item") return overlaidState(input, now);
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
