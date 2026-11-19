/**
 * `readDecisionLog`: the session root's decision log read back oldest first, every line
 * that is not a decision-log line counted and skipped, the newest kept under a cap, and
 * nothing written while it reads.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createPendingApprovalStore, readDecisionLog } from "./index";
import { ALLOW, pending, removeTempRoots, tempRoot } from "./test-helpers";

afterAll(removeTempRoots);

const SESSION = "sess_00000000000000aa";

function line(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    at: `2026-11-14T00:00:${String(n).padStart(2, "0")}.000Z`,
    event: "park",
    decision: `appr_${String(n).padStart(16, "0")}`,
    sessionId: SESSION,
    tool: "Write",
    inputDigest: "a".repeat(64),
    placesDigest: "b".repeat(64),
    surface: "single-turn",
    ...overrides,
  };
}

function writeSegment(root: string, seg: number, lines: ReadonlyArray<unknown>): void {
  const dir = join(root, "approvals.d", "decisions");
  mkdirSync(dir, { recursive: true });
  const text = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  writeFileSync(join(dir, `${String(seg).padStart(6, "0")}.jsonl`), `${text}\n`);
}

/** Every path under `root` with its size and mtime, sorted. */
function listing(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = statSync(path);
      out.push(`${relative(root, path)} ${stats.size} ${stats.mtimeMs}`);
      if (stats.isDirectory()) walk(path);
    }
  };
  walk(root);
  return out.sort();
}

describe("readDecisionLog", () => {
  test("lines come back oldest first across segments, each with where it starts", () => {
    const root = tempRoot();
    writeSegment(root, 1, [line(1), line(2)]);
    writeSegment(root, 2, [line(3, { event: "expire", reason: "ttl" }), line(4)]);
    const read = readDecisionLog(root);
    expect(read.lines.map((entry) => entry.line.decision)).toEqual([
      "appr_0000000000000001",
      "appr_0000000000000002",
      "appr_0000000000000003",
      "appr_0000000000000004",
    ]);
    expect(read.lines.map((entry) => [entry.at.seg, entry.at.off])).toEqual([
      [1, 0],
      [1, JSON.stringify(line(1)).length + 1],
      [2, 0],
      [2, JSON.stringify(line(3, { event: "expire", reason: "ttl" })).length + 1],
    ]);
    expect(read.lines[2]?.line.event).toBe("expire");
    expect(read).toMatchObject({ skipped: 0, truncated: false });
  });

  test("a torn line, a line with a key the log never writes, a wrong event and bad ids are skipped and counted", () => {
    const root = tempRoot();
    writeSegment(root, 1, [
      line(1),
      "{ torn",
      line(2, { note: "free text" }),
      line(3, { event: "approve" }),
      line(4, { decision: "dec_0000000000000004" }),
      line(5, { sessionId: "sess_x" }),
      line(6, { v: 2 }),
      line(7, { surface: 7 }),
      line(8, { runId: 8 }),
      "[1, 2]",
      line(9, { event: "supersede", reason: "moved" }),
    ]);
    const read = readDecisionLog(root);
    expect(read.lines.map((entry) => entry.line.decision)).toEqual([
      "appr_0000000000000001",
      "appr_0000000000000009",
    ]);
    expect(read.skipped).toBe(9);
    expect(read.truncated).toBe(false);
  });

  test("maxLines keeps the newest lines and says older ones remain", () => {
    const root = tempRoot();
    writeSegment(root, 1, [line(1), line(2), line(3)]);
    writeSegment(root, 2, [line(4), line(5)]);
    const read = readDecisionLog(root, { maxLines: 3 });
    expect(read.lines.map((entry) => entry.line.decision)).toEqual([
      "appr_0000000000000003",
      "appr_0000000000000004",
      "appr_0000000000000005",
    ]);
    expect(read.truncated).toBe(true);
    expect(readDecisionLog(root, { maxLines: 5 }).truncated).toBe(false);
    expect(() => readDecisionLog(root, { maxLines: 0 })).toThrow(RangeError);
  });

  test("a root with no approvals folder answers no lines and creates nothing", () => {
    const root = tempRoot();
    const before = listing(root);
    expect(readDecisionLog(root)).toEqual({ lines: [], skipped: 0, truncated: false });
    expect(listing(root)).toEqual(before);
    expect(readdirSync(root)).toEqual([]);
  });

  test("reading a log a store wrote changes nothing under the root", async () => {
    const root = tempRoot();
    const store = createPendingApprovalStore({ rootDir: root });
    const record = pending({ sessionId: SESSION });
    await store.persist(record);
    expect((await store.decide(record.id, { choice: "grant", actor: {} }, ALLOW)).outcome).toBe(
      "decided",
    );
    const before = listing(root);
    const read = readDecisionLog(root);
    expect(read.lines.map((entry) => [entry.line.event, entry.line.decision])).toEqual([
      ["park", record.id],
      ["decide", record.id],
    ]);
    expect(read.lines[1]?.line.choice).toBe("grant");
    expect(listing(root)).toEqual(before);
  });
});
