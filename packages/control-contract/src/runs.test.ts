import { describe, expect, test } from "bun:test";
import { type DecisionRecordView, effectiveRunState } from "./index.js";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const RECORD: DecisionRecordView = {
  id: "appr_0123456789abcdef",
  createdAt: "2026-11-01T00:00:00.000Z",
};
const EXPIRED: DecisionRecordView = { ...RECORD, expiresAt: "2026-11-07T11:00:00.000Z" };

describe("effectiveRunState", () => {
  test("a stored state stands, not computed", () => {
    expect(effectiveRunState({ state: "running" }, { now: NOW })).toEqual({
      state: "running",
      computed: false,
    });
    expect(
      effectiveRunState({ state: "failed", failureClass: "tool_error" }, { now: NOW }),
    ).toEqual({ state: "failed", failureClass: "tool_error", computed: false });
  });

  test("a terminal row ignores an expired decision and a continuation", () => {
    expect(
      effectiveRunState(
        { state: "succeeded" },
        {
          decision: EXPIRED,
          continuation: { id: "run_b", state: "failed" },
          now: NOW,
        },
      ),
    ).toEqual({ state: "succeeded", computed: false });
  });

  test("a waiting run takes its continuation's terminal state and names it", () => {
    expect(
      effectiveRunState(
        { state: "waiting-for-approval" },
        { continuation: { id: "run_b", state: "failed", failureClass: "x" }, now: NOW },
      ),
    ).toEqual({ state: "failed", failureClass: "x", continuedIn: "run_b", computed: true });
    expect(
      effectiveRunState(
        { state: "waiting-for-approval" },
        { continuation: { id: "run_b", state: "succeeded" }, now: NOW },
      ),
    ).toEqual({ state: "succeeded", continuedIn: "run_b", computed: true });
  });

  test("while the continuation goes on, it reads as it is and names it", () => {
    expect(
      effectiveRunState(
        { state: "waiting-for-approval" },
        { continuation: { id: "run_b", state: "running" }, now: NOW },
      ),
    ).toEqual({ state: "waiting-for-approval", continuedIn: "run_b", computed: false });
  });

  test("a continuation outranks an expired decision: the grant was spent", () => {
    expect(
      effectiveRunState(
        { state: "waiting-for-approval" },
        {
          decision: EXPIRED,
          continuation: { id: "run_b", state: "succeeded" },
          now: NOW,
        },
      ).state,
    ).toBe("succeeded");
  });

  test("an effectively expired decision reads failed, approval_expired, computed", () => {
    expect(
      effectiveRunState({ state: "waiting-for-approval" }, { decision: EXPIRED, now: NOW }),
    ).toEqual({ state: "failed", failureClass: "approval_expired", computed: true });
  });

  test("a live decision, or one past due with a fallback, keeps it waiting", () => {
    expect(
      effectiveRunState({ state: "waiting-for-approval" }, { decision: RECORD, now: NOW }).state,
    ).toBe("waiting-for-approval");
    expect(
      effectiveRunState(
        { state: "waiting-for-approval" },
        { decision: { ...EXPIRED, ifUnanswered: "deny" }, now: NOW },
      ).state,
    ).toBe("waiting-for-approval");
  });

  test("only a parked run is computed from its decision", () => {
    expect(effectiveRunState({ state: "running" }, { decision: EXPIRED, now: NOW }).state).toBe(
      "running",
    );
  });

  test("a stored continuedIn is kept", () => {
    expect(
      effectiveRunState({ state: "succeeded", continuedIn: "run_b" }, { now: NOW }).continuedIn,
    ).toBe("run_b");
  });

  test("a record that cannot be read fails closed", () => {
    for (const bad of [null, {}, { state: "nope" }, { state: 7 }]) {
      expect(effectiveRunState(bad as never, { now: NOW })).toEqual({
        state: "failed",
        failureClass: "unreadable_run_record",
        computed: true,
      });
    }
    expect(effectiveRunState({ state: "waiting-for-approval" }, null as never).computed).toBe(
      false,
    );
  });
});
