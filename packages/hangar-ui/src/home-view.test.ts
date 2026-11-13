/**
 * Home's panels answer honestly when one of their reads fails: a list nobody
 * could read is never counted as zero, and "Nothing needs you right now." is
 * said only when both inboxes answered and both are empty.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  needsYouModel,
  needsYouSummary,
  nothingNeedsYou,
  workingModel,
} from "../assets/js/views/home.js";

const approval = { status: "pending", toolName: "Bash", createdAt: "2026-11-12T10:00:00Z" };
const reviewItem = { status: "open", kind: "spec_change", ts: "2026-11-12T09:00:00Z" };

describe("needsYouModel", () => {
  test("both inboxes empty: nothing needs you", () => {
    const model = needsYouModel({ approvals: [], pending: 0 }, { items: [], open: 0 });
    expect(model.failed).toEqual([]);
    expect(nothingNeedsYou(model)).toBe(true);
    expect(needsYouSummary(model)).toBe("0 approvals waiting · 0 review items open");
  });

  test("approvals unread and review empty: not 'nothing', and no approvals count", () => {
    const model = needsYouModel(null, { items: [], open: 0 });
    expect(model.failed).toEqual(["approvals"]);
    expect(model.pending).toBeNull();
    expect(nothingNeedsYou(model)).toBe(false);
    expect(needsYouSummary(model)).toBe("0 review items open");
  });

  test("approvals unread and review holding items: the summary names review only", () => {
    const model = needsYouModel(null, { items: [reviewItem, reviewItem], open: 2 });
    expect(model.review.length).toBe(2);
    expect(needsYouSummary(model)).toBe("2 review items open");
    expect(needsYouSummary(model)).not.toContain("approval");
  });

  test("review unread: its count is unknown, not zero", () => {
    const model = needsYouModel({ approvals: [approval], pending: 1 }, null);
    expect(model.failed).toEqual(["review"]);
    expect(model.open).toBeNull();
    expect(nothingNeedsYou(model)).toBe(false);
    expect(needsYouSummary(model)).toBe("1 approval waiting");
  });

  test("both unread: no summary at all", () => {
    const model = needsYouModel(null, null);
    expect(model.failed).toEqual(["approvals", "review"]);
    expect(needsYouSummary(model)).toBeNull();
    expect(nothingNeedsYou(model)).toBe(false);
  });

  test("a count above the listed items is not 'nothing'", () => {
    const model = needsYouModel({ approvals: [], pending: 3 }, { items: [], open: 0 });
    expect(nothingNeedsYou(model)).toBe(false);
  });
});

describe("workingModel", () => {
  test("a failed process read is counted as unchecked, never as not running", () => {
    const harnesses = [
      { id: "a", specName: "a", dir: "/a" },
      { id: "b", specName: "b", dir: "/b" },
    ];
    const settled = [
      { status: "rejected", reason: new Error("down") },
      { status: "rejected", reason: new Error("down") },
    ];
    const model = workingModel(harnesses, settled, Date.parse("2026-11-12T10:00:00Z"));
    expect(model.unchecked).toBe(2);
    expect(model.working).toEqual([]);
  });

  test("every read answered: nothing unchecked", () => {
    const model = workingModel([], [], 0);
    expect(model).toEqual({ working: [], unchecked: 0 });
  });
});
