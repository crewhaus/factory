import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@crewhaus/session-store";
import { parseSessionLog, summarizeSessionIntoIndex } from "./sessions-index";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sessions-index-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const S = "sess_00000000000000c9";

function writeLog(events: unknown[]): string {
  const logPath = join(tmp, `${S}.jsonl`);
  writeFileSync(logPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return logPath;
}

describe("summarizeSessionIntoIndex (#57)", () => {
  test("writes a durable index entry with outcome/tools/ratings", () => {
    const logPath = writeLog([
      { kind: "user_message", payload: { content: "list files" } },
      {
        kind: "assistant_message",
        payload: {
          content: [
            { type: "tool_use", name: "Bash" },
            { type: "text", text: "listed" },
          ],
        },
      },
      { kind: "user_feedback", payload: { rating: { thumbs: "up" } } },
    ]);
    const indexDir = join(tmp, "sessions-index");
    const summary = summarizeSessionIntoIndex(
      S,
      logPath,
      indexDir,
      () => new Date("2026-07-02T00:00:00Z"),
    );
    expect(summary).toBeDefined();
    const file = join(indexDir, `${S}.json`);
    expect(existsSync(file)).toBe(true);
    const written = JSON.parse(readFileSync(file, "utf-8")) as SessionSummary;
    expect(written.sessionId).toBe(S);
    expect(written.turnCount).toBe(1);
    expect(written.toolsUsed).toEqual(["Bash"]);
    expect(written.ratings.positive).toBe(1);
    expect(written.outcome).toBe("listed");
  });

  test("is idempotent: re-summarizing overwrites, never duplicates", () => {
    const logPath = writeLog([
      { kind: "user_message", payload: { content: "q" } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "a" }] } },
    ]);
    const indexDir = join(tmp, "sessions-index");
    summarizeSessionIntoIndex(S, logPath, indexDir);
    summarizeSessionIntoIndex(S, logPath, indexDir);
    const written = JSON.parse(readFileSync(join(indexDir, `${S}.json`), "utf-8"));
    expect(written.sessionId).toBe(S);
  });

  test("returns undefined for a missing or empty log", () => {
    const indexDir = join(tmp, "sessions-index");
    expect(summarizeSessionIntoIndex(S, join(tmp, "nope.jsonl"), indexDir)).toBeUndefined();
    const empty = join(tmp, `${S}.jsonl`);
    writeFileSync(empty, "\n\n");
    expect(summarizeSessionIntoIndex(S, empty, indexDir)).toBeUndefined();
  });

  test("parseSessionLog skips malformed lines", () => {
    const events = parseSessionLog('{"kind":"a"}\nnot json\n{"kind":"b"}\n');
    expect(events.map((e) => e.kind)).toEqual(["a", "b"]);
  });
});
