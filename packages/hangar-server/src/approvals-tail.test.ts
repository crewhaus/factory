/**
 * The inbox reads `approvals.jsonl` from its newest end. A reader that starts at the
 * head and stops at a cap shows a large file's oldest records, hides its latest asks,
 * and shows an ask decided past the window as still pending.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldApprovals, pendingApprovalCount } from "./approvals";
import { MAX_JSONL_LINES } from "./constants";
import { logLine, makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;
const SESSION = "sess_00000000000000aa";

function approval(id: string, change: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    toolName: "SendMessage",
    inputHash: "hash-1",
    input: { channel: "ops", text: "ship it" },
    runId: "run_00000000000000b0",
    sessionId: SESSION,
    surface: "daemon",
    createdAt: iso(NOW - DAY),
    ...change,
  };
}

/** A settled record: the kind of line a long-lived harness is mostly made of. */
function filler(n: number): Record<string, unknown> {
  const id = `appr_f${n.toString(16).padStart(15, "0")}`;
  return approval(id, {
    decision: "grant",
    decidedBy: "max",
    decidedAt: iso(NOW - DAY),
    consumedAt: iso(NOW - DAY),
  });
}

function jsonl(records: readonly Record<string, unknown>[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function fillers(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => filler(i));
}

async function register(t: TestServer, dir: string): Promise<string> {
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (res.body["entry"] as { id: string }).id;
}

function harness(t: TestServer, name: string): string {
  return makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: name,
    sessions: [
      {
        id: SESSION,
        updatedAt: iso(NOW - DAY),
        lastTurnIndex: 1,
        log: [logLine("user_message", { content: "do the thing" }, iso(NOW - DAY))],
      },
    ],
  });
}

function approvalsPath(dir: string): string {
  return join(dir, ".crewhaus", "sessions", "approvals.jsonl");
}

function rowsOf(body: Record<string, unknown>): readonly { readonly id: string }[] {
  return body["approvals"] as readonly { readonly id: string }[];
}

describe("the inbox reads the newest end of a large approvals file", () => {
  test("an ask past the line cap is in the inbox, counted, and the read reports the cap", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = harness(t, "tail-late-ask");
      const id = await register(t, dir);
      const late = "appr_00000000000000c1";
      writeFileSync(approvalsPath(dir), jsonl([...fillers(MAX_JSONL_LINES + 1), approval(late)]));
      const res = await t.api("/api/approvals");
      expect(res.status).toBe(200);
      expect(rowsOf(res.body).map((r) => r.id)).toEqual([late]);
      expect(res.body["pending"]).toBe(1);
      expect(res.body["truncatedHarnesses"]).toEqual([id]);
      expect(pendingApprovalCount(dir)).toBe(1);
    } finally {
      await t.stop();
    }
  }, 20_000); // boots a server and folds a file past the line cap

  test("an ask decided past the head window reads as decided, not pending", async () => {
    const t = bootTestServer({ now: () => NOW });
    try {
      const dir = harness(t, "tail-decided");
      await register(t, dir);
      const parked = "appr_00000000000000c2";
      writeFileSync(
        approvalsPath(dir),
        jsonl([
          approval(parked),
          ...fillers(MAX_JSONL_LINES),
          approval(parked, { decision: "grant", decidedBy: "max", decidedAt: iso(NOW) }),
        ]),
      );
      const res = await t.api("/api/approvals");
      expect(res.status).toBe(200);
      expect(rowsOf(res.body)).toEqual([]);
      expect(res.body["pending"]).toBe(0);
      expect(pendingApprovalCount(dir)).toBe(0);
    } finally {
      await t.stop();
    }
  }, 20_000); // boots a server and folds a file past the line cap

  test("a file inside the caps reads whole, with nothing reported as capped", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-tail-"));
    try {
      const dir = makeFixtureHarness(join(root, "h"), { specName: "small" });
      writeFileSync(approvalsPath(dir), jsonl([approval("appr_00000000000000c3")]));
      const fold = foldApprovals(dir);
      expect(fold.truncated).toBe(false);
      expect(fold.approvals.map((a) => a.id)).toEqual(["appr_00000000000000c3"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a final line with no newline waits until it completes", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-tail-"));
    try {
      const dir = makeFixtureHarness(join(root, "h"), { specName: "torn" });
      const line = JSON.stringify(approval("appr_00000000000000c4"));
      writeFileSync(approvalsPath(dir), line);
      expect(foldApprovals(dir).approvals).toEqual([]);
      writeFileSync(approvalsPath(dir), `${line}\n`);
      expect(foldApprovals(dir).approvals.map((a) => a.id)).toEqual(["appr_00000000000000c4"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("garbage in the middle is skipped, and no new field appears", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-tail-"));
    try {
      const dir = makeFixtureHarness(join(root, "h"), { specName: "garbage" });
      writeFileSync(
        approvalsPath(dir),
        `${JSON.stringify(approval("appr_00000000000000c5"))}\nnot json\n`,
      );
      const fold = foldApprovals(dir);
      expect(Object.keys(fold).sort()).toEqual(["approvals", "truncated"]);
      expect(fold.approvals.map((a) => a.id)).toEqual(["appr_00000000000000c5"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a harness with no approvals file is an empty fold", () => {
    const root = mkdtempSync(join(tmpdir(), "hangar-tail-"));
    try {
      const dir = makeFixtureHarness(join(root, "h"), { specName: "none" });
      expect(foldApprovals(dir)).toEqual({ approvals: [], truncated: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("where the file may be", () => {
  test("a sessions directory linked outside the harness lists as the browser does", async () => {
    if (process.platform === "win32") return; // the fixture moves the directory under a POSIX link
    const t = bootTestServer({ now: () => NOW });
    const outside = mkdtempSync(join(tmpdir(), "hangar-tail-outside-"));
    try {
      const dir = harness(t, "tail-linked-sessions");
      const id = await register(t, dir);
      const sessions = join(dir, ".crewhaus", "sessions");
      writeFileSync(approvalsPath(dir), jsonl([approval("appr_00000000000000c6")]));
      const moved = join(outside, "sessions");
      renameSync(sessions, moved);
      symlinkSync(moved, sessions);

      const browser = await t.api(`/api/h/${id}/sessions`);
      expect(browser.status).toBe(200);
      const listed = (browser.body["sessions"] as readonly { readonly id: string }[]).map(
        (s) => s.id,
      );
      expect(listed).toContain(SESSION);

      const inbox = await t.api("/api/approvals");
      expect(rowsOf(inbox.body).map((r) => r.id)).toEqual(["appr_00000000000000c6"]);
      expect(inbox.body["pending"]).toBe(1);
    } finally {
      await t.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 20_000); // boots a server

  test("an approvals file that is a link out of the session root lists nothing", async () => {
    if (process.platform === "win32") return; // the fixture plants a POSIX link
    const t = bootTestServer({ now: () => NOW });
    const outside = mkdtempSync(join(tmpdir(), "hangar-tail-outside-"));
    try {
      const dir = harness(t, "tail-linked-file");
      await register(t, dir);
      const target = join(outside, "approvals.jsonl");
      writeFileSync(target, jsonl([approval("appr_00000000000000c7")]));
      mkdirSync(join(dir, ".crewhaus", "sessions"), { recursive: true });
      symlinkSync(target, approvalsPath(dir));

      const inbox = await t.api("/api/approvals");
      expect(rowsOf(inbox.body)).toEqual([]);
      expect(inbox.body["pending"]).toBe(0);
      expect(foldApprovals(dir)).toEqual({ approvals: [], truncated: false });
    } finally {
      await t.stop();
      rmSync(outside, { recursive: true, force: true });
    }
  }, 20_000); // boots a server

  test("an approvals file that is a link inside the session root reads through it", () => {
    if (process.platform === "win32") return; // the fixture plants a POSIX link
    const root = mkdtempSync(join(tmpdir(), "hangar-tail-"));
    try {
      const dir = makeFixtureHarness(join(root, "h"), { specName: "inner-link" });
      const sessions = join(dir, ".crewhaus", "sessions");
      writeFileSync(join(sessions, "real.jsonl"), jsonl([approval("appr_00000000000000c8")]));
      symlinkSync(join(sessions, "real.jsonl"), approvalsPath(dir));
      expect(foldApprovals(dir).approvals.map((a) => a.id)).toEqual(["appr_00000000000000c8"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
