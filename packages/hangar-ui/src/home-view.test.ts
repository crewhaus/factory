/**
 * Home's panels answer honestly when one of their reads fails: a list nobody
 * could read is never counted as zero, and "Nothing needs you right now." is
 * said only when Home's inbox answered in full and holds nothing. Its items
 * read in the inbox's own words and link to their own card on the Needs-you
 * page, and a list read only in part says so.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  needsYouModel,
  needsYouSummary,
  nothingNeedsYou,
  olderChangesNote,
  statusLineNotes,
  statusLineParts,
  workingModel,
} from "../assets/js/views/home.js";

const A = "hrn_000000000000000a";
const B = "hrn_000000000000000b";
const att = (n: number) => `home/attention/att_${String(n).padStart(26, "0")}`;

/** An inbox item as `attention.list` serves it. */
const item = (over: Record<string, unknown> = {}) => ({
  ref: att(1),
  kind: "permission",
  band: "decide",
  harness: A,
  source: { kind: "approval", id: "appr_00000000000000a1" },
  title: { template: "permission.ask", params: { tool: "SendMessage" } },
  whyNow: { template: "why.waiting", params: { runs: 1 } },
  affected: { runs: [], count: 0 },
  evidence: [],
  choices: [],
  requiredClass: "operator",
  state: "open",
  evidenceRev: "0123456789abcdef",
  since: "2026-11-12T10:00:00Z",
  freshness: { asOf: "2026-11-12T10:00:00Z", mode: "projection" },
  ...over,
});

const checkpoint = item({
  ref: att(7),
  kind: "checkpoint",
  source: { kind: "checkpoint", id: "run_1" },
  title: { template: "checkpoint.waiting", params: { node: "review" } },
});

describe("needsYouModel, from Home's inbox", () => {
  test("a checkpoint item, a list cut short and an unreadable harness: the item and both notes", () => {
    const model = needsYouModel({
      items: [checkpoint, item({ ref: att(2), band: "fix", kind: "run-failures" })],
      snapshotAt: "x",
      truncated: { reason: "harness_capped", verb: "crewhaus inbox list --json" },
      unreachable: [B],
      names: [
        { id: A, name: "support-bot" },
        { id: B, name: "release-bot" },
      ],
    });
    expect(model.failed).toBe(false);
    expect(model.items[0]).toEqual({
      text: "A graph run is paused before review",
      band: "decide",
      where: "support-bot",
      since: "2026-11-12T10:00:00Z",
      href: `#/home/needs-you?item=att_${"7".padStart(26, "0")}`,
    });
    expect(model.notes).toEqual([
      "Couldn't read the requests of release-bot: its sessions folder is outside its folder.",
      "Some harnesses have more items than were read. To see them all, run crewhaus inbox list --json",
    ]);
    // The counts stay as shown, and a list read in part is never "nothing".
    expect(needsYouSummary(model)).toBe("1 to decide · 1 to fix");
    expect(nothingNeedsYou(model)).toBe(false);
  });

  test("a list read in full: neither note", () => {
    const model = needsYouModel({ items: [checkpoint], snapshotAt: "x" });
    expect(model.notes).toEqual([]);
    expect(model.items.map((i: { text: string }) => i.text)).toEqual([
      "A graph run is paused before review",
    ]);
    expect(needsYouSummary(model)).toBe("1 to decide");
  });

  test("a list cut at its page names no harness and still says so", () => {
    const model = needsYouModel({
      items: [checkpoint],
      snapshotAt: "x",
      truncated: { reason: "page_limit" },
    });
    expect(model.notes).toEqual(["More items are waiting than this list shows."]);
  });

  test("an empty inbox read in full: nothing needs you", () => {
    const model = needsYouModel({
      items: [],
      snapshotAt: "x",
      empty: { reason: "no-data", remedy: "Nothing needs you right now." },
    });
    expect(nothingNeedsYou(model)).toBe(true);
    expect(needsYouSummary(model)).toBeNull();
  });

  test("an empty list with an unreadable harness is not 'nothing'", () => {
    const model = needsYouModel({ items: [], snapshotAt: "x", unreachable: [A] });
    expect(nothingNeedsYou(model)).toBe(false);
    expect(model.notes[0]).toContain(A);
  });

  test("an inbox nobody could read: failed, no count and never 'nothing'", () => {
    const model = needsYouModel(null);
    expect(model.failed).toBe(true);
    expect(needsYouSummary(model)).toBeNull();
    expect(nothingNeedsYou(model)).toBe(false);
  });

  test("Home lists at most three items, in the order the inbox gives them", () => {
    const items = [1, 2, 3, 4].map((n) => item({ ref: att(n) }));
    const model = needsYouModel({ items, snapshotAt: "x" });
    expect(model.items.map((i: { href: string }) => i.href.slice(-2))).toEqual(["01", "02", "03"]);
    expect(needsYouSummary(model)).toBe("4 to decide");
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

describe("older changes Home did not read say so", () => {
  test("a digest cut short says older changes are not shown; a whole one says nothing", () => {
    expect(olderChangesNote({ items: [], truncated: true })).toBe("Older changes not shown");
    expect(olderChangesNote({ items: [], truncated: false })).toBeNull();
    expect(olderChangesNote(null)).toBeNull();
  });
});

describe("Home's status line", () => {
  test("names each count in words, links each part, and leaves out what it cannot know", () => {
    const parts = statusLineParts({
      counts: {
        harnesses: 4,
        needsYou: 1,
        working: 2,
        paused: 1,
        notResponding: 1,
        waitingForBudget: 1,
      },
    });
    expect(parts.map((p: { text: string }) => p.text)).toEqual([
      "4 harnesses",
      "1 needs you",
      "2 working",
      "1 paused",
      "1 not responding",
      "1 waiting for budget",
    ]);
    expect(parts.map((p: { href: string }) => p.href)).toEqual([
      "#/harnesses",
      "#/home/needs-you",
      "#/home/working",
      "#/harnesses?state=paused",
      "#/harnesses?state=not-responding",
      "#/harnesses/spend",
    ]);
    // A count that is absent (unknown) or zero is not printed.
    const unknown = statusLineParts({ counts: { harnesses: 2, working: 0 } });
    expect(unknown.map((p: { text: string }) => p.text)).toEqual(["2 harnesses"]);
    expect(
      statusLineNotes({ counts: {}, notes: [{ count: "needsYou", note: "Not counted." }] }),
    ).toEqual(["Not counted."]);
  });
});
