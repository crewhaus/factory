/**
 * Reading failure messages is bounded per harness: only the sessions of the newest failed
 * runs, at most {@link FAILURE_SESSIONS_MAX} logs and {@link FAILURE_READ_BYTES} in all,
 * each file once however many names reach it; past a cap the section says `truncated`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
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

  test("the bytes read across sessions stop at the budget", () => {
    const dir = harnessDir(root(), "big");
    // Each log says it is larger than one read takes: the budget holds this many reads.
    const big = SESSION_CAPS.maxBytes * 2;
    const reads = Math.ceil(FAILURE_READ_BYTES / SESSION_CAPS.maxBytes);
    expect(reads).toBeLessThan(FAILURE_SESSIONS_MAX);
    const reader = counting({ stamp: () => `${big}:1`, identity: () => undefined });
    const section = readFailuresSection(dir, failedRuns(40), testFacts(), reader, undefined);
    expect(reader.tails.length).toBe(reads);
    expect(section.truncated).toBe(true);
  });
});
