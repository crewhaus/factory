/**
 * Reading failure messages is bounded per harness: only the sessions of the newest failed
 * runs, at most {@link FAILURE_SESSIONS_MAX} logs and {@link FAILURE_READ_BYTES} read in
 * all, whatever size a file was when it was looked at, each file once however many names
 * reach it; past a cap the section says `truncated`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHUNK_BYTES } from "@crewhaus/control-records";
import { HOUR, MIN, NOW, failure, harnessDir, iso, tempRoot, testFacts } from "./__test__/fleet";
import { FAILURE_READ_BYTES, FAILURE_SESSIONS_MAX, readFailuresSection } from "./adapters/runs";
import { emptyModel } from "./fold";
import { type AttentionReader, DEFAULT_READER, SESSION_CAPS } from "./read";
import type { AttentionModel } from "./types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function root(): string {
  const t = tempRoot();
  cleanups.push(t.cleanup);
  return t.root;
}

const sessionOf = (i: number) => `sess_${i.toString(16).padStart(16, "0")}`;

/** A model with `n` failed runs, each in its own session, run `i` failing at NOW - i minutes. */
function failedRuns(n: number): AttentionModel {
  const model = emptyModel();
  for (let i = 0; i < n; i++) {
    const id = `run_${i.toString().padStart(26, "0")}`;
    model.runs[id] = {
      id,
      state: "failed",
      at: iso(NOW - i * MIN),
      failureClass: "tool_error",
      session: sessionOf(i),
    };
  }
  return model;
}

function counting(over: Partial<AttentionReader> = {}): AttentionReader & { tails: string[] } {
  const reader = {
    tails: [] as string[],
    stamp: over.stamp ?? DEFAULT_READER.stamp,
    identity: over.identity ?? DEFAULT_READER.identity,
    tail(r: string, rel: string, caps: typeof SESSION_CAPS) {
      reader.tails.push(rel);
      return DEFAULT_READER.tail(r, rel, caps);
    },
  };
  return reader;
}

describe("failure messages are read under caps", () => {
  test("600 failed sessions open at most the cap of logs, the newest first, and say truncated", () => {
    const dir = harnessDir(root(), "many");
    const model = failedRuns(600);
    const reader = counting();
    const section = readFailuresSection(dir, model, testFacts(), reader, undefined);
    expect(reader.tails.length).toBe(FAILURE_SESSIONS_MAX);
    expect(reader.tails[0]).toBe(`${sessionOf(0)}.jsonl`);
    expect(reader.tails).not.toContain(`${sessionOf(FAILURE_SESSIONS_MAX)}.jsonl`);
    expect(section.truncated).toBe(true);
  });

  test("under the cap nothing is cut", () => {
    const dir = harnessDir(root(), "few");
    for (let i = 0; i < 3; i++) failure(dir, sessionOf(i), "tool_error", "boom", NOW - i * MIN);
    const reader = counting();
    const section = readFailuresSection(dir, failedRuns(3), testFacts(), reader, undefined);
    expect(reader.tails.length).toBe(3);
    expect(section.truncated).toBeUndefined();
    expect(section.facts.length).toBe(3);
  });

  test("a file reached by several names is read once", () => {
    const dir = harnessDir(root(), "linked");
    failure(dir, sessionOf(0), "tool_error", "boom", NOW - HOUR);
    const sessions = join(dir, ".crewhaus", "sessions");
    for (let i = 1; i < 10; i++) {
      symlinkSync(join(sessions, `${sessionOf(0)}.jsonl`), join(sessions, `${sessionOf(i)}.jsonl`));
    }
    const reader = counting();
    readFailuresSection(dir, failedRuns(10), testFacts(), reader, undefined);
    expect(reader.tails).toEqual([`${sessionOf(0)}.jsonl`]);
  });

  test("the bytes read across sessions stay inside the budget, however the logs grow", () => {
    const dir = harnessDir(root(), "grown");
    // Each log says 10 bytes when it is looked at, and holds all a read takes by then.
    let bytes = 0;
    let reads = 0;
    const reader: AttentionReader = {
      stamp: () => "10:1",
      tail(_root, _rel, caps) {
        reads++;
        bytes += caps.maxBytes;
        return {
          state: "read",
          records: [],
          truncated: true,
          gaps: [],
          torn: false,
          bytesRead: caps.maxBytes,
        };
      },
    };
    const section = readFailuresSection(
      dir,
      failedRuns(FAILURE_SESSIONS_MAX),
      testFacts(),
      reader,
      undefined,
    );
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThan(FAILURE_SESSIONS_MAX);
    expect(bytes).toBeLessThanOrEqual(FAILURE_READ_BYTES);
    expect(section.truncated).toBe(true);
  });

  test("a reader that does not say what it read is charged all it was given", () => {
    const dir = harnessDir(root(), "quiet");
    let handed = 0;
    const reader: AttentionReader = {
      stamp: () => "0:1",
      tail(_root, _rel, caps) {
        handed += caps.maxBytes;
        return { state: "read", records: [], truncated: false, gaps: [], torn: false };
      },
    };
    const section = readFailuresSection(
      dir,
      failedRuns(FAILURE_SESSIONS_MAX),
      testFacts(),
      reader,
      undefined,
    );
    expect(handed).toBeGreaterThan(0);
    expect(handed).toBeLessThanOrEqual(FAILURE_READ_BYTES);
    expect(section.truncated).toBe(true);
  });

  test("real logs are charged what was read from them, one chunk past a read included", () => {
    const dir = harnessDir(root(), "real");
    const sessions = join(dir, ".crewhaus", "sessions");
    const line = `${JSON.stringify({ kind: "note", text: "x".repeat(900) })}\n`;
    const log = line.repeat(Math.ceil((SESSION_CAPS.maxBytes * 1.5) / line.length));
    for (let i = 0; i < 12; i++) writeFileSync(join(sessions, `${sessionOf(i)}.jsonl`), log);
    let read = 0;
    const reader: AttentionReader = {
      ...DEFAULT_READER,
      tail(r, rel, caps) {
        const answer = DEFAULT_READER.tail(r, rel, caps);
        if (answer.state === "read") {
          expect(answer.bytesRead).toBeGreaterThan(0);
          expect(answer.bytesRead).toBeLessThanOrEqual(caps.maxBytes + CHUNK_BYTES + 1);
          read += answer.bytesRead ?? 0;
        }
        return answer;
      },
    };
    const section = readFailuresSection(dir, failedRuns(12), testFacts(), reader, undefined);
    expect(read).toBeGreaterThan(SESSION_CAPS.maxBytes);
    expect(read).toBeLessThanOrEqual(FAILURE_READ_BYTES);
    expect(section.truncated).toBe(true);
  });
});
