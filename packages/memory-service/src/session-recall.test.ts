/**
 * Batch E item 8 (G77) — session-summary recall (the third recall ranker).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@crewhaus/session-store";
import { createSessionSummaryRecall } from "./session-recall";

let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function summary(over: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    schemaVersion: 1,
    turnCount: 1,
    toolsUsed: [],
    ratings: { positive: 0, negative: 0 },
    outcome: "",
    keyFacts: [],
    hadError: false,
    summarizedAt: "2026-07-15T10:00:00.000Z",
    ...over,
  };
}

/** Write the given summaries into a fresh sessions-index and return its dir. */
function seedIndex(summaries: SessionSummary[]): string {
  root = mkdtempSync(join(tmpdir(), "crewhaus-sessrecall-"));
  const indexDir = join(root, "sessions-index");
  mkdirSync(indexDir, { recursive: true });
  for (const s of summaries) {
    writeFileSync(join(indexDir, `${s.sessionId}.json`), `${JSON.stringify(s, null, 2)}\n`);
  }
  return indexDir;
}

describe("createSessionSummaryRecall", () => {
  test("a missing index dir recalls nothing (fresh harness)", async () => {
    root = mkdtempSync(join(tmpdir(), "crewhaus-sessrecall-"));
    const recall = createSessionSummaryRecall({ indexDir: join(root, "does-not-exist") });
    expect(await recall.recall("anything", 5)).toEqual([]);
  });

  test("an empty index recalls nothing", async () => {
    const indexDir = seedIndex([]);
    const recall = createSessionSummaryRecall({ indexDir });
    expect(await recall.recall("anything", 5)).toEqual([]);
  });

  test("ranks the most relevant session first and formats a pointer line", async () => {
    const indexDir = seedIndex([
      summary({
        sessionId: "sess-csv",
        outcome: "shipped the CSV export feature end to end",
        keyFacts: ["CSV export wired to the download button"],
      }),
      summary({
        sessionId: "sess-auth",
        outcome: "debugged an OAuth token refresh loop",
        keyFacts: ["token refresh now retries once"],
      }),
    ]);
    const recall = createSessionSummaryRecall({ indexDir });
    const lines = await recall.recall("how did we do the csv export", 5);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    // The CSV session ranks first…
    expect(lines[0]).toContain("sess-csv");
    expect(lines[0]).toContain("2026-07-15");
    expect(lines[0]).toContain("shipped the CSV export");
    // …and its key facts ride along after the em dash.
    expect(lines[0]).toContain("download button");
  });

  test("respects the k cap", async () => {
    const indexDir = seedIndex([
      summary({ sessionId: "a", outcome: "fox alpha work" }),
      summary({ sessionId: "b", outcome: "fox beta work" }),
      summary({ sessionId: "c", outcome: "fox gamma work" }),
    ]);
    const recall = createSessionSummaryRecall({ indexDir });
    const lines = await recall.recall("fox", 2);
    expect(lines.length).toBe(2);
  });

  test("an empty or non-matching query recalls nothing", async () => {
    const indexDir = seedIndex([summary({ sessionId: "a", outcome: "shipped csv export" })]);
    const recall = createSessionSummaryRecall({ indexDir });
    expect(await recall.recall("", 5)).toEqual([]);
    expect(await recall.recall("   ", 5)).toEqual([]);
    // A query with no lexical overlap scores zero → no lines.
    expect(await recall.recall("zzzz nonexistentterm", 5)).toEqual([]);
  });

  test("k <= 0 recalls nothing", async () => {
    const indexDir = seedIndex([summary({ sessionId: "a", outcome: "shipped csv export" })]);
    const recall = createSessionSummaryRecall({ indexDir });
    expect(await recall.recall("csv", 0)).toEqual([]);
  });

  test("tool names are part of the ranked surface", async () => {
    const indexDir = seedIndex([
      summary({ sessionId: "used-grep", outcome: "looked around", toolsUsed: ["Grep", "Read"] }),
      summary({ sessionId: "used-bash", outcome: "looked around", toolsUsed: ["Bash"] }),
    ]);
    const recall = createSessionSummaryRecall({ indexDir });
    const lines = await recall.recall("grep", 5);
    expect(lines[0]).toContain("used-grep");
  });

  test("skips non-json files and malformed / wrong-shape records", async () => {
    const indexDir = seedIndex([summary({ sessionId: "good", outcome: "shipped csv export" })]);
    writeFileSync(join(indexDir, "notes.txt"), "csv export notes", "utf-8");
    writeFileSync(join(indexDir, "broken.json"), "{ not json", "utf-8");
    writeFileSync(join(indexDir, "wrong.json"), JSON.stringify({ hello: "csv export" }), "utf-8");
    const recall = createSessionSummaryRecall({ indexDir });
    const lines = await recall.recall("csv export", 5);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("good");
  });

  test("a summary with no key facts still recalls (outcome only)", async () => {
    const indexDir = seedIndex([
      summary({ sessionId: "bare", outcome: "shipped the csv export", keyFacts: [] }),
    ]);
    const recall = createSessionSummaryRecall({ indexDir });
    const lines = await recall.recall("csv", 5);
    expect(lines[0]).toBe("[session:bare · 2026-07-15] shipped the csv export");
  });

  test("a malformed timestamp renders as ? rather than throwing", async () => {
    const indexDir = seedIndex([
      summary({ sessionId: "nodate", outcome: "shipped csv", summarizedAt: "not-a-date" }),
    ]);
    const recall = createSessionSummaryRecall({ indexDir });
    const lines = await recall.recall("csv", 5);
    expect(lines[0]).toContain("[session:nodate · ?]");
  });
});
