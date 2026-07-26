/**
 * Read the accumulated rating corpus off disk.
 *
 * Two sinks, exactly the pair `crewhaus distill` reads:
 *   - `<sessionsDir>/<id>.jsonl` — the durable transcripts, which carry
 *     BOTH the conversation turns and any in-transcript `user_feedback`
 *     events (the exit-rating prompt, `crewhaus rate`, channel reactions).
 *   - `.crewhaus/feedback/*.jsonl` — the bare-record sink the web-UI host and
 *     the managed gateway write (no event-log handle there).
 *
 * WHERE the transcripts live is NOT a constant: the runtime resolves it
 * through `resolveSessionRootDir` (tenant scope → `CREWHAUS_SESSION_DIR` →
 * `<cwd>/.crewhaus/sessions`), and the janitor's own session sweep mirrors
 * that chain. This collector therefore takes the SAME inputs — an explicit
 * dirs list, a managed daemon's `tenantsRootDir` (enumerated per call, like
 * the janitor and the dream step), or the env-then-default fallback — so a
 * daemon can never read a different sessions root than the one its turns
 * were written to. Reading the wrong root is not a benign miss: it makes
 * every rating look unmatchable, and the caller's watermark would then burn
 * them (see `janitor-step.ts`'s zero-transcript guard).
 *
 * Everything is best-effort: a vanished, truncated or hand-edited file
 * contributes what it can and never throws, because the only callers are an
 * unattended teardown and a daemon janitor tick.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type FeedbackRecord,
  type LoggedEvent,
  type SessionTurn,
  deriveTurns,
  extractFeedbackRecords,
} from "./feedback";

/** Session-id grammar (`@crewhaus/session-store`'s `generateId`). */
const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

export const SESSIONS_SUBDIR = join(".crewhaus", "sessions");
export const FEEDBACK_SUBDIR = join(".crewhaus", "feedback");

/** The env var the runtime's `resolveSessionRootDir` and the janitor's own
 *  session sweep both honor. */
export const SESSION_DIR_ENV = "CREWHAUS_SESSION_DIR";

/** Parse a JSONL body into objects, dropping malformed/non-object lines. */
export function parseJsonlObjects(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === "object") out.push(value);
    } catch {
      // A hand-edited or torn line must never abort a janitor tick.
    }
  }
  return out;
}

/** `sess_*` ids with a transcript under `<sessionsDir>`. */
export function listSessionIds(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return [];
  try {
    return readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -".jsonl".length))
      .filter((id) => SESSION_ID_REGEX.test(id))
      .sort();
  } catch {
    return [];
  }
}

export type CollectedFeedback = {
  readonly turns: ReadonlyArray<SessionTurn>;
  readonly records: ReadonlyArray<FeedbackRecord>;
  /** Sessions whose transcript was readable. Zero means the swept roots hold
   *  NO transcript at all — which a caller must treat as "cannot join yet",
   *  not "these ratings are unmatchable" (see `janitor-step.ts`). */
  readonly sessionCount: number;
  /** The session roots actually swept (resolved absolute), for diagnostics. */
  readonly sessionsDirs: ReadonlyArray<string>;
};

export type CollectFeedbackOptions = {
  /** Explicit session roots to sweep. Wins over every other input — the
   *  emitter/test seam for "I already know where transcripts live". */
  readonly sessionsDirs?: ReadonlyArray<string>;
  /** Managed daemons: `<tenantsRootDir>/<tenantId>/sessions` for every tenant
   *  directory, ENUMERATED PER CALL (a tenant that first authenticated after
   *  boot is covered) — the same sweep `createJanitor`'s `tenantsRootDir` and
   *  `createDreamJanitorStep` perform. */
  readonly tenantsRootDir?: string;
  /** Env consulted for {@link SESSION_DIR_ENV}; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/** `<tenantsRootDir>/<tenant>/sessions` for every tenant subdirectory. */
export function listTenantSessionsDirs(tenantsRootDir: string): string[] {
  if (!existsSync(tenantsRootDir)) return [];
  try {
    return readdirSync(tenantsRootDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => resolve(tenantsRootDir, e.name, "sessions"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The session roots one collection sweeps, mirroring the runtime's
 * `resolveSessionRootDir` precedence: explicit dirs → per-tenant roots →
 * `CREWHAUS_SESSION_DIR` → `<rootDir>/.crewhaus/sessions`. A `tenantsRootDir`
 * suppresses the single-root fallback exactly like the janitor's own sweep
 * (a tenant-scoped daemon has no non-tenant session root).
 */
export function resolveSessionsDirs(rootDir: string, opts: CollectFeedbackOptions = {}): string[] {
  if (opts.sessionsDirs !== undefined && opts.sessionsDirs.length > 0) {
    return dedupeDirs(opts.sessionsDirs);
  }
  if (opts.tenantsRootDir !== undefined) return listTenantSessionsDirs(opts.tenantsRootDir);
  const env = opts.env ?? process.env;
  const fromEnv = env[SESSION_DIR_ENV];
  return [
    fromEnv !== undefined && fromEnv !== "" ? resolve(fromEnv) : resolve(rootDir, SESSIONS_SUBDIR),
  ];
}

function dedupeDirs(dirs: ReadonlyArray<string>): string[] {
  const seen = new Map<string, string>();
  for (const d of dirs) {
    const abs = resolve(d);
    if (!seen.has(abs)) seen.set(abs, abs);
  }
  return [...seen.values()];
}

/**
 * Collect every rated turn + rating under a harness root — the exact pair
 * `distill()` takes. The feedback sink is always `<rootDir>/.crewhaus/feedback`
 * (that is where every writer puts it); only the TRANSCRIPT roots vary, per
 * {@link resolveSessionsDirs}.
 */
export function collectFeedbackFromDisk(
  rootDir: string,
  opts: CollectFeedbackOptions = {},
): CollectedFeedback {
  const sessionsDirs = resolveSessionsDirs(rootDir, opts);
  const turns: SessionTurn[] = [];
  const records: FeedbackRecord[] = [];
  const seenSessions = new Set<string>();
  let sessionCount = 0;
  for (const sessionsDir of sessionsDirs) {
    for (const id of listSessionIds(sessionsDir)) {
      // One session id can only have one transcript; a duplicate across roots
      // would double every turn (and therefore every distilled sample).
      if (seenSessions.has(id)) continue;
      let events: LoggedEvent[];
      try {
        events = parseJsonlObjects(
          readFileSync(join(sessionsDir, `${id}.jsonl`), "utf-8"),
        ) as LoggedEvent[];
      } catch {
        continue; // Evicted between listing and read — skip, never abort.
      }
      seenSessions.add(id);
      sessionCount += 1;
      for (const t of deriveTurns(events)) turns.push({ ...t, sessionId: id });
      records.push(...extractFeedbackRecords(events));
    }
  }
  records.push(...readFeedbackDir(join(rootDir, FEEDBACK_SUBDIR)));
  return { turns, records, sessionCount, sessionsDirs };
}

/** Bare `FeedbackRecord`s from `<feedbackDir>/*.jsonl` (the web-UI / gateway
 *  sink, which has no event-log handle). */
export function readFeedbackDir(feedbackDir: string): FeedbackRecord[] {
  if (!existsSync(feedbackDir)) return [];
  const objects: unknown[] = [];
  let files: string[];
  try {
    files = readdirSync(feedbackDir);
  } catch {
    return [];
  }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      objects.push(...parseJsonlObjects(readFileSync(join(feedbackDir, f), "utf-8")));
    } catch {
      // Unreadable sink file — skip it.
    }
  }
  return extractFeedbackRecords(objects);
}
