/**
 * The two fleet inboxes.
 *
 * The load-bearing assertions are about SIDE EFFECTS, not payload shapes:
 *
 *   - reading the approvals inbox must leave `approvals.jsonl` byte-identical
 *     (`PendingApprovalStore.list()` compacts; a polled inbox must not);
 *   - a grant written by the API must be the record the CLI's own store
 *     reads back, or the runtime would park the run forever on a decision
 *     the manager thinks it made;
 *   - a thumbs verdict on a session-turn review item must land as an
 *     ADJUDICATING FeedbackRecord on the session log, not just close the
 *     queue row — otherwise the next `crewhaus distill` re-opens it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractFeedbackRecords } from "@crewhaus/feedback-distill";
import { createPendingApprovalStore } from "@crewhaus/session-store";
import { makeFixtureHarness } from "./fixture";
import { logLine } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

function inboxHarness(t: TestServer, name: string): string {
  return makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    sessions: [
      {
        id: "sess_00000000000000aa",
        updatedAt: iso(NOW - DAY),
        lastTurnIndex: 1,
        log: [
          logLine("user_message", { content: "do the thing" }, iso(NOW - DAY)),
          logLine(
            "assistant_message",
            { content: [{ type: "text", text: "done" }] },
            iso(NOW - DAY),
          ),
        ],
      },
    ],
    approvals: [
      {
        id: "appr_00000000000000b1",
        toolName: "SendMessage",
        inputHash: "hash-1",
        input: { channel: "ops", text: "ship it" },
        runId: "run_00000000000000b0",
        sessionId: "sess_00000000000000aa",
        surface: "daemon",
        createdAt: iso(NOW - DAY),
      },
    ],
    reviewQueue: [
      {
        schemaVersion: 1,
        id: "rev_rater_disagreement_sess_00000000000000aa_t1",
        kind: "rater_disagreement",
        sourceRef: { sessionId: "sess_00000000000000aa", turn: 1 },
        ts: iso(NOW - DAY),
        status: "open",
        context: "split verdict — a: up, b: down",
      },
      {
        schemaVersion: 1,
        id: "rev_quarantine_smoke_s9",
        kind: "quarantine",
        sourceRef: { dataset: "smoke", sampleId: "s9" },
        ts: iso(NOW - DAY),
        status: "open",
      },
    ],
  });
}

describe("approvals inbox", () => {
  test("reading the inbox never compacts the approvals ledger", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inboxHarness(t, "inbox-read");
      await register(t, dir);
      const path = join(dir, ".crewhaus", "sessions", "approvals.jsonl");
      const before = readFileSync(path, "utf8");

      for (let i = 0; i < 3; i += 1) {
        const res = await t.api("/api/approvals");
        expect(res.status).toBe(200);
        expect(res.body["pending"]).toBe(1);
      }

      // `PendingApprovalStore.list()` would have rewritten this file.
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the verbatim tool input renders, masked", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inboxHarness(t, "inbox-input");
      await register(t, dir);
      const rows = (await t.api("/api/approvals")).body["approvals"] as Array<{
        input: { channel: string; text: string };
        parkedRun: { runId: string };
      }>;
      // An approver cannot judge a call they cannot see.
      expect(rows[0]?.input).toEqual({ channel: "ops", text: "ship it" });
      // …and the parked run is linked so grant-and-resume can chain.
      expect(rows[0]?.parkedRun.runId).toBe("run_00000000000000b0");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a grant written through the API is the record the CLI's own store reads back", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inboxHarness(t, "inbox-grant");
      const id = await register(t, dir);
      const granted = await t.api(`/api/h/${id}/approvals/appr_00000000000000b1/grant`, {
        method: "POST",
        body: JSON.stringify({ by: "operator@example.invalid" }),
      });
      expect(granted.status).toBe(200);

      // The CLI/runtime path: `get(toolName, inputHash)` is what re-resolves
      // a parked call. If the manager wrote a shape it does not recognize,
      // the run parks forever.
      const store = createPendingApprovalStore({
        rootDir: join(dir, ".crewhaus", "sessions"),
        now: () => new Date(NOW),
      });
      const seen = await store.get("SendMessage", "hash-1");
      expect(seen?.decision).toBe("grant");
      expect(seen?.decidedBy).toBe("operator@example.invalid");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("an unknown approval id is a 404, not a silent no-op", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inboxHarness(t, "inbox-404");
      const id = await register(t, dir);
      const res = await t.api(`/api/h/${id}/approvals/appr_0000000000000000/deny`, {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(404);
    } finally {
      await t.stop();
    }
  }, 20_000);
});

describe("review queue", () => {
  test("a thumbs verdict on a session turn writes an adjudicating FeedbackRecord", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inboxHarness(t, "review-adjudicate");
      const id = await register(t, dir);
      const res = await t.api(
        `/api/h/${id}/review/rev_rater_disagreement_sess_00000000000000aa_t1`,
        { method: "POST", body: JSON.stringify({ verdict: "up" }) },
      );
      expect(res.status).toBe(200);
      expect(res.body["adjudicated"]).toBe(true);

      // Settled at the SOURCE, not just in the queue: distill lets an
      // adjudication win the disagreement and stops re-opening the item.
      const log = readFileSync(
        join(dir, ".crewhaus", "sessions", "sess_00000000000000aa.jsonl"),
        "utf8",
      );
      const objects = log
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as unknown);
      const records = extractFeedbackRecords(objects);
      expect(records.length).toBe(1);
      expect(records[0]?.adjudication).toBe(true);
      expect(records[0]?.rating.thumbs).toBe("up");
      expect(records[0]?.turnNumber).toBe(1);

      const queue = (await t.api("/api/review?all=1")).body["items"] as Array<{
        id: string;
        status: string;
      }>;
      expect(
        queue.find((i) => i.id === "rev_rater_disagreement_sess_00000000000000aa_t1")?.status,
      ).toBe("resolved");
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("a thumbs verdict on an item with no session turn is refused, not silently mis-recorded", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = inboxHarness(t, "review-refuse");
      const id = await register(t, dir);
      const res = await t.api(`/api/h/${id}/review/rev_quarantine_smoke_s9`, {
        method: "POST",
        body: JSON.stringify({ verdict: "down" }),
      });
      expect(res.status).toBe(409);
      expect(String(res.body["error"])).toContain("pass/fail");

      // …and pass/fail on the same item closes it.
      const ok = await t.api(`/api/h/${id}/review/rev_quarantine_smoke_s9`, {
        method: "POST",
        body: JSON.stringify({ verdict: "fail", note: "not a real case" }),
      });
      expect(ok.status).toBe(200);
      expect(ok.body["adjudicated"]).toBe(false);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("the inbox folds across every registered harness, oldest open first", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      await register(t, inboxHarness(t, "review-a"));
      await register(t, inboxHarness(t, "review-b"));
      const body = (await t.api("/api/review")).body;
      expect(body["open"]).toBe(4);
      const harnesses = new Set(
        (body["items"] as Array<{ harnessId: string }>).map((i) => i.harnessId),
      );
      expect(harnesses.size).toBe(2);
    } finally {
      await t.stop();
    }
  }, 20_000);
});
