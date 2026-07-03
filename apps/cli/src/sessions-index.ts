/**
 * Item #57 — durable sessions index. Before a session JSONL is evicted (30-day
 * TTL), it is summarized into a compact index entry under
 * `.crewhaus/sessions-index/<id>.json` so the harness retains long-term
 * knowledge (outcome, tools used, ratings, key facts) past raw-transcript
 * retention. These entries feed the memory-store / few-shot / FAQ features.
 *
 * The summary logic lives in `@crewhaus/session-store` (`summarizeSession`, a
 * deterministic no-model reducer). This module is the CLI-side glue: read a
 * session's JSONL, summarize it, and write the index entry idempotently. Kept
 * thin + separately testable, mirroring `feedback.ts` / `dataset-mine.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SessionSummary, summarizeSession } from "@crewhaus/session-store";

/** The index directory, relative to a session root's PARENT `.crewhaus`. */
export const SESSIONS_INDEX_DIRNAME = "sessions-index";

/** Parse a JSONL blob into `{ kind, payload }` events, skipping bad lines. */
export function parseSessionLog(text: string): Array<{ kind?: string; payload?: unknown }> {
  const out: Array<{ kind?: string; payload?: unknown }> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A single malformed line must not abort the summary.
    }
  }
  return out;
}

/**
 * Summarize the session whose `.jsonl` lives at `logPath` into `indexDir`,
 * returning the written summary (or undefined when the log is missing/empty).
 * Idempotent: re-writing the same session overwrites its entry rather than
 * duplicating. `now` is injectable for deterministic tests.
 */
export function summarizeSessionIntoIndex(
  sessionId: string,
  logPath: string,
  indexDir: string,
  now: () => Date = () => new Date(),
): SessionSummary | undefined {
  if (!existsSync(logPath)) return undefined;
  const events = parseSessionLog(readFileSync(logPath, "utf-8"));
  if (events.length === 0) return undefined;
  const summary = summarizeSession(sessionId, events, { now });
  mkdirSync(indexDir, { recursive: true });
  writeFileSync(join(indexDir, `${sessionId}.json`), `${JSON.stringify(summary, null, 2)}\n`, {
    mode: 0o600,
  });
  return summary;
}
