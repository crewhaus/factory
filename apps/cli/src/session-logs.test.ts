/**
 * The regression this file exists for: a harness's `.crewhaus/sessions`
 * holds `approvals.jsonl` beside its transcripts, and four commands counted
 * it as a session called "approvals" — `tools audit` said "across 2
 * session(s)" for a harness with one.
 *
 * Every case builds a real directory rather than stubbing `readdirSync`,
 * because the defect was in what the directory actually contains.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_ID_REGEX as RETENTION_SESSION_ID_REGEX } from "@crewhaus/data-retention-engine";
import { SESSION_ID_REGEX, rankedSessionLogs } from "./session-logs";

const ROOTS: string[] = [];
function sessionsDirWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "crewhaus-session-logs-"));
  ROOTS.push(root);
  const dir = join(root, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  // Ordered mtimes, oldest first, so "newest first" is a fact rather than
  // whatever order the filesystem happened to create them in.
  let when = 1_700_000_000;
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, body);
    utimesSync(path, when, when);
    when += 60;
  }
  return dir;
}

const A = "sess_00000000000000aa";
const B = "sess_00000000000000bb";

describe("rankedSessionLogs", () => {
  test("the approvals log is not a session", () => {
    const dir = sessionsDirWith({
      [`${A}.jsonl`]: '{"kind":"tool_stats"}\n',
      "approvals.jsonl": '{"id":"a1","status":"grant"}\n',
    });
    expect(rankedSessionLogs(dir).map((s) => s.sessionId)).toEqual([A]);
  });

  test("a sessions directory holding ONLY the approvals log has no sessions", () => {
    // The stronger half: the count must go to zero, not to one. A filter that
    // merely re-ordered would still pass the case above.
    const dir = sessionsDirWith({ "approvals.jsonl": '{"id":"a1"}\n' });
    expect(rankedSessionLogs(dir)).toEqual([]);
  });

  test("newest first, so `--sessions N` windows over the N most recent", () => {
    const dir = sessionsDirWith({
      [`${A}.jsonl`]: "{}\n", // oldest
      "approvals.jsonl": "{}\n",
      [`${B}.jsonl`]: "{}\n", // newest
    });
    const ranked = rankedSessionLogs(dir);
    expect(ranked.map((s) => s.sessionId)).toEqual([B, A]);
    // And the window cannot be spent on a non-session: with the approvals log
    // counted, `slice(0, 1)` returned it instead of the newest transcript.
    expect(ranked.slice(0, 1).map((s) => s.sessionId)).toEqual([B]);
  });

  test("the `.json` sidecar beside a transcript is not a second session", () => {
    const dir = sessionsDirWith({
      [`${A}.jsonl`]: "{}\n",
      [`${A}.json`]: "{}\n",
    });
    expect(rankedSessionLogs(dir).map((s) => s.sessionId)).toEqual([A]);
  });

  test("anything else in the directory is left alone", () => {
    const dir = sessionsDirWith({
      [`${A}.jsonl`]: "{}\n",
      "approvals.jsonl": "{}\n",
      "notes.txt": "hi\n",
      "sess_nothex.jsonl": "{}\n",
      "sess_00000000000000.jsonl": "{}\n", // 14 hex, too short
      "sess_00000000000000aaa.jsonl": "{}\n", // 17 hex, too long
    });
    expect(rankedSessionLogs(dir).map((s) => s.sessionId)).toEqual([A]);
  });

  test("a missing directory is empty rather than a throw", () => {
    expect(rankedSessionLogs(join(tmpdir(), "crewhaus-does-not-exist-xyz"))).toEqual([]);
  });

  test("the id shape matches the one the rest of the system enforces", () => {
    // This module keeps its own copy rather than taking a package dependency
    // for one regex. Pin the two spellings against each other so the copy
    // cannot drift in silence.
    expect(SESSION_ID_REGEX.source).toBe(RETENTION_SESSION_ID_REGEX.source);
    expect(SESSION_ID_REGEX.flags).toBe(RETENTION_SESSION_ID_REGEX.flags);
  });
});

process.on("exit", () => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});
