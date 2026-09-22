/**
 * Getting session logs off disk and into the shape `@crewhaus/harness-advice`
 * mines.
 *
 * `harness-advice` is deliberately pure — `aggregateAsks` takes
 * `SessionEvents[]` and never touches a filesystem, which is what let it be
 * lifted out of `apps/cli` and reached from a tool package at all. This module
 * is the I/O half the CLI keeps in `readRecentSessionEvents`, and NOTHING more:
 * the parse is harness-advice's own `parseJsonlObjects`, and no rule about what
 * a `permission` line means lives here.
 *
 * WHAT IT ADDS OVER THE CLI'S VERSION, and why. `readRecentSessionEvents` reads
 * each file whole with `readFileSync` and throws away what it could not parse.
 * Both are wrong for a tool whose output a model will act on:
 *
 *   - a log it cannot open throws, and the whole call dies rather than mining
 *     the other nineteen sessions;
 *   - a log it CAN open is read entirely, so one enormous transcript is an
 *     unbounded allocation inside a tool call;
 *   - a line that does not parse is dropped with no count, so a run of torn
 *     lines looks exactly like a quiet session — and "this tool was never
 *     denied" is then an artefact of the lines that went missing, not a fact.
 *
 * So: capped reads, per-file failures collected rather than thrown, and every
 * line that was skipped counted so the caller can say the mining window was
 * incomplete.
 */
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { type SessionEvents, parseJsonlObjects } from "@crewhaus/harness-advice";
import { APPROVALS_FILENAME } from "./approvals";
import { readTailCapped } from "./jsonl";
import { compareStrings } from "./unknown";

/** One session transcript. Past this the tail is mined and the cut reported. */
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;

/**
 * NOT EVERY `.jsonl` IN THE SESSION ROOT IS A SESSION.
 * `@crewhaus/session-store` puts three kinds of file there: the transcript
 * `<id>.jsonl` this mines, the watch-me trace sibling `<id>.events.jsonl`
 * (`attachWatchmeCapture`), and the `approvals.jsonl` ledger the other two
 * tools in this package read. Mining all three is not merely untidy:
 *
 *   - `available` would count files that are not sessions, and `mined` would
 *     name session ids (`sess_x.events`, `approvals`) that do not exist;
 *   - worse, they COMPETE for the `sessions: N` window. Ranking is by mtime,
 *     and `approvals.jsonl` is written the moment a run parks — so it is
 *     routinely the newest file in the directory and takes the first slot,
 *     pushing a real transcript out. On a harness with watch-me enabled the
 *     siblings take half the window. The ask/deny counts that decide whether
 *     a standing grant is proposed would then be mined from a fraction of the
 *     history the caller asked for, with nothing saying so.
 *
 * A DENYLIST, not an allowlist: the two names are ones this repository defines,
 * while a transcript's name belongs to the store and has had more than one
 * vintage. Excluding what is known not to be a session cannot drop one.
 */
export function isSessionLogName(name: string): boolean {
  if (!name.endsWith(".jsonl")) return false;
  if (name === APPROVALS_FILENAME) return false;
  if (name.endsWith(".events.jsonl")) return false;
  return true;
}

/** Default number of most-recent sessions mined, mirroring the CLI's
 *  `DEFAULT_PERMISSIONS_SESSIONS`. */
export const DEFAULT_SESSION_LIMIT = 20;

export type SessionReadFailure = {
  /** The log's filename — never an absolute path, which is host layout. */
  readonly file: string;
  readonly reason: string;
};

export type SessionsRead = {
  readonly sessions: readonly SessionEvents[];
  /** Every SESSION log seen in the directory ({@link isSessionLogName}),
   *  whether or not it was mined. */
  readonly available: number;
  /** Logs that could not be read at all. */
  readonly failures: readonly SessionReadFailure[];
  /** Logs whose read hit the byte cap: their older records were not mined. */
  readonly truncatedFiles: readonly string[];
  /** Lines inside the mined window that did not parse, across all files. */
  readonly tornLines: number;
  /** True when the directory itself is not there. */
  readonly missingDir: boolean;
  /** Set when the directory exists but could not be listed. */
  readonly unreadableDir?: string;
};

/**
 * Read the `limit` most recent session logs under `dirReal`.
 *
 * Recency is mtime, as the CLI's miner uses, with the FILENAME as the tiebreak.
 * Without that tiebreak two logs written in the same millisecond — which a test
 * fixture and a fast run both produce — order by whatever `readdir` returned,
 * and the same directory mines differently on two hosts.
 */
export function readRecentSessions(dirReal: string, limit: number | "all"): SessionsRead {
  let names: string[];
  try {
    names = readdirSync(dirReal).filter(isSessionLogName);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        sessions: [],
        available: 0,
        failures: [],
        truncatedFiles: [],
        tornLines: 0,
        missingDir: true,
      };
    }
    return {
      sessions: [],
      available: 0,
      failures: [],
      truncatedFiles: [],
      tornLines: 0,
      missingDir: false,
      unreadableDir: `the sessions directory could not be listed (${code ?? "an unidentified error"})`,
    };
  }

  const failures: SessionReadFailure[] = [];
  const ranked: Array<{ file: string; mtimeMs: number }> = [];
  for (const file of names.sort(compareStrings)) {
    try {
      ranked.push({ file, mtimeMs: statSync(path.join(dirReal, file)).mtimeMs });
    } catch (err) {
      // A log that cannot be STATTED cannot be ranked. Mining it anyway would
      // put an unplaceable file in the "20 most recent" window and push out one
      // whose place is known, so it is reported instead of guessed at.
      failures.push({
        file,
        reason: `could not be examined (${(err as NodeJS.ErrnoException).code ?? "an unidentified error"}), so it has no place in the recency order`,
      });
    }
  }
  ranked.sort((a, b) => b.mtimeMs - a.mtimeMs || compareStrings(a.file, b.file));

  const chosen = limit === "all" ? ranked : ranked.slice(0, Math.max(0, limit));
  const sessions: SessionEvents[] = [];
  const truncatedFiles: string[] = [];
  let tornLines = 0;
  for (const { file } of chosen) {
    const read = readTailCapped(path.join(dirReal, file), MAX_SESSION_BYTES);
    if (read.state.kind === "missing") {
      failures.push({ file, reason: "the log was removed between listing it and reading it" });
      continue;
    }
    if (read.state.kind === "unreadable") {
      failures.push({ file, reason: read.state.reason });
      continue;
    }
    let text = read.text;
    if (read.truncated) {
      truncatedFiles.push(file);
      // The tail read began mid-file: drop the torn first line rather than
      // counting it as a parse failure that did not happen.
      const firstBreak = text.indexOf("\n");
      text = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }
    // The PARSE is harness-advice's — this package does not own what a session
    // line is. The count of what it dropped is ours, because it does not keep one.
    const objects = parseJsonlObjects(text);
    const nonEmptyLines = text.split("\n").filter((l) => l.trim() !== "").length;
    tornLines += Math.max(0, nonEmptyLines - objects.length);
    sessions.push({ sessionId: file.replace(/\.jsonl$/, ""), objects });
  }

  return {
    sessions,
    available: names.length,
    failures: failures.sort((a, b) => compareStrings(a.file, b.file)),
    truncatedFiles: truncatedFiles.sort(compareStrings),
    tornLines,
    missingDir: false,
  };
}
