import { describe, expect, test } from "bun:test";
import { settleStart } from "./core-runtime";
import { outcomeOf } from "./refusal";

describe("settleStart", () => {
  test("a restart refused before it stopped anything records the daemon as kept running", () => {
    const gate = {
      allowed: false,
      // Only `allowed` and the lists are read here.
      report: { ok: false } as never,
      refused: [],
      unforceable: [],
      acknowledged: [],
    };
    for (const result of [
      { ok: false, reason: "preflight-blocked", gate, kept: true },
      { ok: false, reason: "build-not-active", message: "not active", kept: true },
      { ok: false, reason: "plan-failed", stage: "plan", error: new Error("x"), kept: true },
    ] as const) {
      expect(settleStart(result)).toEqual({
        state: "rejected",
        effects: [{ kind: "daemon", status: "skipped", note: "kept running" }],
        outcome: outcomeOf("precondition_failed"),
      });
    }
  });

  test("a start's refusal records no daemon effect", () => {
    expect(settleStart({ ok: false, reason: "build-not-active", message: "not active" })).toEqual({
      state: "rejected",
      outcome: outcomeOf("precondition_failed"),
    });
    expect(
      settleStart({ ok: false, reason: "plan-failed", stage: "plan", error: new Error("x") }),
    ).toMatchObject({ state: "failed", effects: [{ kind: "daemon", status: "failed" }] });
  });
});
