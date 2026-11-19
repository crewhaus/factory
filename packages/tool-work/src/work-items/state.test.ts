import { describe, expect, test } from "bun:test";
import { WORK_STATUSES } from "@crewhaus/control-contract";
import { WORK_STATUS_WORDS, type WorkStateFacts, effectiveWorkState } from "./state";

const OPEN: WorkStateFacts = { state: "open" };

describe("effectiveWorkState, row by row", () => {
  const rows: readonly [string, WorkStateFacts, string][] = [
    ["merged", { state: "closed", outcome: "done", pr: { state: "merged" } }, "merged"],
    [
      "closed unmerged",
      { state: "closed", outcome: "declined", pr: { state: "closed" } },
      "closed-unmerged",
    ],
    ["reverted", { state: "closed", pr: { state: "merged", reverted: true } }, "reverted"],
    ["done", { state: "closed", outcome: "done" }, "done"],
    ["declined", { state: "closed", outcome: "declined" }, "declined"],
    ["cancelled", { state: "closed", outcome: "cancelled" }, "cancelled"],
    ["superseded", { state: "closed", outcome: "superseded" }, "superseded"],
    ["failed", { state: "closed", outcome: "failed" }, "failed"],
    ["approval", { ...OPEN, runs: ["waiting-for-approval"] }, "waiting-approval"],
    ["input", { ...OPEN, runs: ["waiting-for-input"] }, "needs-input"],
    ["running", { ...OPEN, runs: ["running"] }, "working"],
    ["preparing", { ...OPEN, runs: ["preparing"] }, "working"],
    ["in review", { ...OPEN, pr: { state: "open" } }, "in-review"],
    [
      "changes",
      { ...OPEN, pr: { state: "open", review: "changes_requested" } },
      "changes-requested",
    ],
    ["publish", { ...OPEN, publish: "failed" }, "publish-unfinished"],
    ["publish not done", { ...OPEN, publish: "not-done" }, "publish-unfinished"],
    ["interrupted", { ...OPEN, runs: ["succeeded", "interrupted"] }, "interrupted"],
    ["paused", { ...OPEN, harness: { paused: true } }, "paused"],
    ["disabled", { ...OPEN, harness: { disabled: true } }, "disabled"],
    ["budget", { ...OPEN, harness: { budgetExhausted: true } }, "waiting-budget"],
    ["proposed", { state: "proposed" }, "proposed"],
    ["queued", { ...OPEN, runs: ["queued"] }, "queued"],
    ["up next", OPEN, "up-next"],
  ];
  for (const [name, facts, status] of rows) {
    test(name, () => expect(effectiveWorkState(facts)).toBe(status as never));
  }

  test("precedence: the first row that applies wins", () => {
    expect(effectiveWorkState({ ...OPEN, runs: ["running", "waiting-for-approval"] })).toBe(
      "waiting-approval",
    );
    expect(effectiveWorkState({ ...OPEN, runs: ["running"], pr: { state: "open" } })).toBe(
      "working",
    );
    expect(effectiveWorkState({ ...OPEN, runs: ["interrupted"], harness: { paused: true } })).toBe(
      "interrupted",
    );
    // A newer run than the interrupted one: no longer interrupted.
    expect(effectiveWorkState({ ...OPEN, runs: ["interrupted", "succeeded"] })).toBe("up-next");
    expect(effectiveWorkState({ state: "closed", outcome: "done", runs: ["running"] })).toBe(
      "done",
    );
    expect(effectiveWorkState({ ...OPEN, harness: { disabled: true, paused: true } })).toBe(
      "disabled",
    );
  });

  test("every status has words", () => {
    for (const status of WORK_STATUSES) expect(WORK_STATUS_WORDS[status].length).toBeGreaterThan(0);
  });
});
