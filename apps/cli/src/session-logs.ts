/**
 * Which files under a harness's `.crewhaus/sessions` are session transcripts.
 *
 * Its own module because it is filesystem logic that several commands share
 * and one that a test must be able to call: `apps/cli/src/index.ts` runs the
 * CLI on import, so anything reachable only from there cannot be unit-tested.
 *
 * WHY THE SHAPE, NOT THE EXTENSION. `@crewhaus/session-store` puts the
 * approvals log in this directory ON PURPOSE — `DEFAULT_ROOT_DIR` is
 * `.crewhaus/sessions` and `DEFAULT_APPROVALS_FILENAME` is `approvals.jsonl`
 * — so every harness that has ever parked an approval has a `.jsonl` here
 * that is not a transcript. Four callers globbed `*.jsonl` and took the
 * basename as the session id, so the approvals log became a session called
 * "approvals": `tools audit` reported "across 2 session(s)" for a harness
 * with one, `--sessions N` spent a slot of its window on it, and
 * `permissions suggest`, `doctor` and `mcp doctor` each read it as a
 * transcript that happened to contain nothing they wanted.
 *
 * The extension was never the right key and the store's own layout says so.
 *
 * Safe to filter on the id shape because it is the shape the rest of the
 * system already enforces: `--resume` refuses an id that does not match it,
 * and `@crewhaus/data-retention-engine` exports the same regex for the same
 * reason. A transcript whose name is not a session id is not a transcript
 * this CLI wrote.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The `sess_<16 hex>` session-id shape, shared with `@crewhaus/session-store`.
 *
 * Deliberately a copy rather than an import: `apps/cli` does not otherwise
 * depend on `@crewhaus/data-retention-engine`, and taking a package
 * dependency for one regex is a worse trade than a duplicate this small.
 * `session-logs.test.ts` pins the two spellings against each other so the
 * copy cannot drift silently.
 */
export const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

/** One session transcript: where it is, whose it is, and how recent. */
export type SessionLog = {
  readonly file: string;
  readonly sessionId: string;
  readonly mtimeMs: number;
};

/**
 * The session transcripts in `sessionsDir`, newest first.
 *
 * "Recent" is by mtime: session ids are random hex, so name order carries no
 * recency. A missing directory is an empty list, and the caller decides
 * whether that is an error.
 */
export function rankedSessionLogs(sessionsDir: string): SessionLog[] {
  if (!existsSync(sessionsDir)) return [];
  return (
    readdirSync(sessionsDir)
      // An early-out, NOT the check: it saves a `statSync` on unrelated files,
      // and removing it changes no result, because the id test below is what
      // does the work. `sess_<16hex>.json` loses six characters to the slice
      // and comes out fifteen hex long, so the sidecar fails the shape either
      // way. Said plainly because a mutation that deletes this line leaves the
      // suite green, and a reader deserves to know that is expected.
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, sessionId: name.slice(0, -".jsonl".length) }))
      .filter((entry) => SESSION_ID_REGEX.test(entry.sessionId))
      .map((entry) => {
        const file = join(sessionsDir, entry.name);
        return { file, sessionId: entry.sessionId, mtimeMs: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  );
}
