/**
 * Shared limits and identifiers for the Hangar server.
 *
 * Every JSONL reader in this package is capped and torn-line tolerant: a
 * runaway transcript can never make a fleet paint unbounded, and one torn
 * line never hides the rest of a file. The caps are exported so the UI (and
 * tests) can say honestly when a view was truncated.
 */

/** Wire-protocol version reported by `GET /api/version`. */
export const PROTOCOL_V = 1;

/**
 * Package version reported by `GET /api/version` when the caller supplies
 * none. Read from this package's own package.json rather than duplicated as
 * a literal: the release train bumps package.json, and a hand-maintained
 * copy would silently drift. Static import — a compiled binary embeds it.
 */
import pkg from "../package.json" with { type: "json" };

export const HANGAR_SERVER_VERSION: string =
  typeof pkg.version === "string" ? pkg.version : "0.0.0";

/** Default TCP port for the manager console (`127.0.0.1:4200`). */
export const DEFAULT_HANGAR_PORT = 4200;

/**
 * Socket idle timeout for the manager server, in seconds (Bun's maximum).
 *
 * The live run feed is an SSE stream over a daemon that is SUPPOSED to be
 * quiet — a `heartbeat: every 60s` shape emits nothing in between. Bun's 10 s
 * default therefore severs exactly the connections the console exists to
 * hold open, and the client has no reconnect. Paired with the stream's own
 * `: ping` keep-alive (`SSE_HEARTBEAT_MS`), which must stay well under this.
 */
export const SSE_IDLE_TIMEOUT_SECONDS = 255;

/** Hard cap on JSONL LINES parsed from any single file. */
export const MAX_JSONL_LINES = 5000;

/** Hard cap on BYTES read from any single JSONL/text file (8 MiB). A file
 *  larger than this is read up to the cap and flagged truncated; the final
 *  partial line is dropped rather than parsed torn. */
export const MAX_JSONL_BYTES = 8 * 1024 * 1024;

/** Cap on raw lines returned by the `?raw=1` transcript escape hatch. */
export const MAX_RAW_LINES = 1000;

/** Cap on plain-text bytes returned for a single memory/state document. */
export const MAX_TEXT_BYTES = 256 * 1024;

/** Cap on folded memory items returned per memory file. */
export const MAX_MEMORY_ITEMS = 500;

/** Cap on tail lines returned from watchme observations/judgments. */
export const MAX_TAIL_LINES = 50;

/** Session file-name shapes (the session-store on-disk contract). */
export const SESSION_ID_RE = /^sess_[0-9a-f]{16}$/;
export const SESSION_JSON_RE = /^sess_[0-9a-f]{16}\.json$/;
export const SESSION_JSONL_RE = /^sess_[0-9a-f]{16}\.jsonl$/;

/** Eval run-directory id shape (the eval-runner on-disk contract). */
export const RUN_ID_RE = /^run_[0-9a-f]{16}$/;

/** Conservative shape for ids that name a file/dir INSIDE a harness tree
 *  (eval sample ids, wiki slugs, dream spec dirs, memory file stems): one
 *  path segment, no leading dot, no separators — checked BEFORE the
 *  realpath-containment guard, never instead of it. */
export const SAFE_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The env var a harness's `.env` may use to relocate its session root
 *  (resolved relative to the harness dir; honored only when the resolved
 *  root stays inside the harness dir). */
export const SESSION_DIR_ENV = "CREWHAUS_SESSION_DIR";
