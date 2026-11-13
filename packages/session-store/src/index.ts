/**
 * Catalog R7 `session-store` — short-term session metadata persisted as
 * one JSON file per session under `.crewhaus/sessions/<id>.json`.
 *
 * Session shape: `{ id, createdAt, updatedAt, name, target, model, lastTurnIndex }`.
 * `id` follows the format `sess_<16 hex>` (8 random bytes hex-encoded);
 * the prefix is preserved across the codebase so log lines stay scannable.
 *
 * `list()` performs TTL eviction as a side-effect: any `.json` file whose
 * filesystem `mtime` is older than `now - ttlDays * 86_400_000` ms is
 * `unlink`-ed (along with its sibling `<id>.jsonl` event log and
 * `<id>.events.jsonl` watchme trace log) before the
 * surviving sessions are returned. Eviction key is mtime — not the in-file
 * `updatedAt` — so that `touch -t YYYYMMDD0000 <id>.json` is a sufficient
 * way to test or force expiry from the shell.
 *
 * Atomic writes: every `create`/`update` writes to a temp created with
 * `O_EXCL|O_NOFOLLOW` under a random name beside `<id>.json`, and renames it
 * into place (@crewhaus/tool-safety's `writeFileSafe`). Until 0.7.1 the temp
 * was the fixed name `<id>.json.tmp`, opened through any link: a model that
 * could plant a symlink there (GitApplyPatch creates one from a patch) had the
 * runtime's own per-turn save overwrite a file anywhere the process could
 * write. A symlink, FIFO or directory at `<id>.json` itself is refused on
 * write and on read, naming the file and the reason.
 *
 * Path-traversal guard: every public method that consumes an `id` validates
 * it against `/^sess_[0-9a-f]{16}$/`. A malformed id throws `RuntimeError`
 * before any filesystem access.
 *
 * References: `claude-code/utils/sessionStorage.ts`, `agent-framework/_sessions.py`.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  type DecisionBinding,
  type DecisionClass,
  SESSION_ID_RE as ID_REGEX,
  type ReceiptVia,
  type SupersedeReason,
  type VerifyApprovers,
  type VerifyReason,
} from "@crewhaus/control-contract";
import { RuntimeError } from "@crewhaus/errors";
import {
  type ContainedRead,
  type SafeFsFailure,
  appendContained,
  openForReadFd,
  openForReadSync,
  writeFileSafe,
} from "@crewhaus/tool-safety/fs";
import {
  type ApprovalDecisions,
  allowSingleOwner,
  createApprovalWriter,
  sweepApprovals,
} from "./approvals/decide";
import {
  approvalIsExpired,
  foldReadOnly,
  foldWithClaims,
  readApprovalsFile,
  recordInScope,
} from "./approvals/fold";
import { fencePath } from "./fence";

export { APPROVAL_ID_RE, SESSION_ID_RE } from "@crewhaus/control-contract";

export const DEFAULT_ROOT_DIR = ".crewhaus/sessions";
export const DEFAULT_TTL_DAYS = 30;
const MS_PER_DAY = 86_400_000;

export type Session = {
  readonly id: string;
  readonly createdAt: string;
  updatedAt: string;
  name: string;
  target: string;
  /**
   * The declared primary model — a plain string, and it STAYS one:
   * `isSessionShape` requires it (`--resume` and every channel-thread resume
   * would break otherwise), so the 0.6.0 hybrid fields below are additive.
   */
  model: string;
  lastTurnIndex: number;
  // ---- 0.6.0 (design §7.2.1, §8.1) — additive, both OPTIONAL. Session files
  // written before this release keep parsing; readers that build rows from an
  // explicit key list (hangar-server's `listSessions`) are unaffected. ----
  /**
   * A per-session `/model <arm>` directive pin: the roster arm id (profile
   * name or spec model string) the user asked to stick to. Written by the
   * directive seam (`/model auto` clears it); read back through
   * {@link resolveSessionPin}, which treats the on-disk value as UNTRUSTED
   * (type check + roster membership) rather than trusting it because it came
   * off disk.
   */
  pin?: string;
  /**
   * Every wire model id that has SERVED this session, in first-seen order —
   * the durable answer to "which models did this conversation actually use"
   * when a pool, tiers or a failover chain make `model` only the declared
   * primary. Maintained through {@link mergeSessionModels}.
   */
  models?: string[];
};

export type SessionStoreOptions = {
  readonly rootDir?: string;
  readonly ttlDays?: number;
  readonly now?: () => Date;
};

export type CreateOpts = {
  readonly id?: string;
  readonly name: string;
  readonly target: string;
  readonly model: string;
};

/**
 * What `update()` accepts. 0.6.0 widens the `Pick` with the two additive
 * fields: `pin` also accepts `null`, which REMOVES the key (the `/model auto`
 * clear) — `undefined` in a patch means "leave as is", so a distinct clear
 * value is needed.
 */
export type SessionPatch = Partial<
  Pick<Session, "name" | "target" | "model" | "lastTurnIndex" | "models">
> & { pin?: string | null };

/**
 * 0.6.0 (design §7.2.1) — read a session's `/model` pin as UNTRUSTED input.
 * Returns the pin only when it is a string AND names an arm in `roster` (the
 * spec's declared profile names / candidate model strings); otherwise falls
 * back to auto (`pin: undefined`) with a recorded `reason`, so a hand-edited
 * or stale session file can never steer routing to an arm the spec does not
 * declare. An absent pin is auto with no reason.
 */
export function resolveSessionPin(
  session: Pick<Session, "pin">,
  roster: ReadonlyArray<string>,
): { readonly pin: string | undefined; readonly reason?: string } {
  const raw: unknown = session.pin;
  if (raw === undefined) return { pin: undefined };
  if (typeof raw !== "string" || raw.length === 0) {
    return { pin: undefined, reason: "session pin is not a string — falling back to auto" };
  }
  if (!roster.includes(raw)) {
    return {
      pin: undefined,
      reason: `session pin "${raw}" is not in the roster — falling back to auto`,
    };
  }
  return { pin: raw };
}

/**
 * 0.6.0 (design §8.1) — fold a served wire model id into a session's
 * `models` list: first-seen order, no duplicates, the input never mutated.
 * Returns the same array instance when nothing changed so a writer can skip
 * the `update()` round-trip.
 */
export function mergeSessionModels(
  existing: ReadonlyArray<string> | undefined,
  served: string,
): string[] {
  const base = existing ?? [];
  if (base.includes(served)) return base as string[];
  return [...base, served];
}

export interface SessionStore {
  create(opts: CreateOpts): Promise<Session>;
  get(id: string): Promise<Session | null>;
  list(): Promise<Session[]>;
  update(id: string, patch: SessionPatch): Promise<Session>;
  delete(id: string): Promise<void>;
}

/**
 * The largest session record `get()` reads. A record is a few hundred bytes of
 * metadata; anything near this is not one, and is refused rather than buffered.
 */
const MAX_SESSION_RECORD_BYTES = 1024 * 1024;

/**
 * How many times a session record is opened before a read that keeps landing
 * on a replaced file is refused. See {@link readRecord}.
 */
export const SESSION_READ_ATTEMPTS = 5;

/**
 * Read the record at `absPath`, never through a link at the name: a planted
 * `<id>.json -> elsewhere` would hand `--resume` another file's bytes. A link,
 * FIFO or directory there, or a file over {@link MAX_SESSION_RECORD_BYTES}, is
 * refused outright.
 *
 * `changed` is different: the name was checked and then opened, and the file
 * opened is not the one checked. Every `update()` produces exactly that, since
 * it replaces the record by renaming a new file over it, so a `get()` that
 * overlaps a turn's save (a channel gateway handling the next message on the
 * same thread does) saw it and threw. The read is repeated, up to
 * {@link SESSION_READ_ATTEMPTS} times, and only a name that keeps changing is
 * refused. The open is synchronous, so a writer in this process cannot land
 * between the check and the open; another process can, rarely.
 */
function readRecord(absPath: string): ContainedRead {
  let read: ContainedRead = openRecord(absPath);
  for (let attempt = 1; attempt < SESSION_READ_ATTEMPTS; attempt++) {
    if (read.ok || read.code !== "changed") return read;
    read = openRecord(absPath);
  }
  return read;
}

function openRecord(absPath: string): ContainedRead {
  return openForReadSync(dirname(absPath), basename(absPath), {
    maxBytes: MAX_SESSION_RECORD_BYTES,
    followLeafSymlink: false,
  });
}

/**
 * Write `data` at the absolute `absPath`, rooted at its own directory: the temp
 * is random and `O_EXCL|O_NOFOLLOW`, and a link, FIFO or directory at the name
 * is refused. The directory itself may be a link (an operator can keep the
 * store elsewhere); it is resolved first, as the store's root.
 */
function writeContained(absPath: string, data: string, what: string): void {
  const written = writeFileSafe(dirname(absPath), basename(absPath), data, {
    overwrite: true,
    mode: 0o600,
  });
  if (!written.ok) throw refusal("write", what, absPath, written);
}

/** The error for a store file tool-safety refused: the file and the reason. */
function refusal(op: string, what: string, absPath: string, failure: SafeFsFailure): RuntimeError {
  return new RuntimeError(
    `session-store: refusing to ${op} ${what} at ${absPath}: ${failure.reason} (code ${failure.code})`,
  );
}

function sessionPath(rootDir: string, id: string): string {
  return fencePath(resolve(rootDir, `${id}.json`));
}

function sessionLogPath(rootDir: string, id: string): string {
  return fencePath(resolve(rootDir, `${id}.jsonl`));
}

function sessionEventsPath(rootDir: string, id: string): string {
  return fencePath(resolve(rootDir, `${id}.events.jsonl`));
}

/**
 * The TTL-eviction pass shared by `list()` and `evictExpiredSessions()`.
 * Walks `rootDir` and unlinks every `sess_<16 hex>.json` whose filesystem
 * mtime is older than `cutoffMs` (along with its sibling `.jsonl` event
 * log and `.events.jsonl` watchme trace log). Ids in `pinnedIds` are never
 * evicted (they count as survivors) —
 * the `.crewhaus/retention.json` pin contract threaded through by
 * `evictExpiredSessions`. Returns the evicted ids plus the ids that
 * survive, so `list()` can read the survivors without a second directory
 * walk.
 */
/**
 * Item #57 — a hook fired for each session that is ABOUT to be evicted, before
 * its `.json` + `.jsonl` are unlinked. Lets a caller summarize the transcript
 * into a durable index so long-term knowledge survives raw-transcript
 * retention. Given the session id and the root dir it lives under (so the
 * callback can read the sibling `.jsonl`). Best-effort: a throwing hook is
 * caught and never blocks the eviction. Absent → behaviour unchanged.
 */
export type BeforeEvictHook = (sessionId: string, rootDir: string) => Promise<void>;

async function sweepExpired(
  rootDir: string,
  cutoffMs: number,
  pinnedIds?: ReadonlySet<string>,
  onBeforeEvict?: BeforeEvictHook,
): Promise<{ evictedIds: string[]; survivorIds: string[] }> {
  let entries: string[];
  try {
    entries = await readdir(rootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { evictedIds: [], survivorIds: [] };
    }
    throw err;
  }
  const evictedIds: string[] = [];
  const survivorIds: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_REGEX.test(id)) continue;
    const fullPath = sessionPath(rootDir, id);
    let mtimeMs: number;
    try {
      const st = await stat(fullPath);
      mtimeMs = st.mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    if (mtimeMs < cutoffMs) {
      if (pinnedIds?.has(id)) {
        // Pinned in .crewhaus/retention.json — expired but never evicted.
        survivorIds.push(id);
        continue;
      }
      // Item #57 — summarize into the durable index BEFORE unlinking, so the
      // harness retains long-term knowledge past raw-transcript retention. The
      // hook runs while both the `.json` and `.jsonl` still exist. Best-effort:
      // a throwing hook must not block eviction (an unbounded transcript is a
      // worse failure than a missing index entry).
      if (onBeforeEvict !== undefined) {
        await onBeforeEvict(id, rootDir).catch(() => undefined);
      }
      // Evict: unlink the session file and any sibling event/trace logs.
      await unlink(fullPath).catch(() => undefined);
      await unlink(sessionLogPath(rootDir, id)).catch(() => undefined);
      await unlink(sessionEventsPath(rootDir, id)).catch(() => undefined);
      evictedIds.push(id);
      continue;
    }
    survivorIds.push(id);
  }
  return { evictedIds, survivorIds };
}

export type EvictExpiredSessionsOptions = SessionStoreOptions & {
  /**
   * Session ids that must survive eviction even when expired — the
   * `.crewhaus/retention.json` `pins` contract. Additive: omitted, the
   * behaviour is unchanged. (`list()`'s implicit eviction takes no pins;
   * daemon janitors and the retention CLI, which both read the config file,
   * thread them through here.)
   */
  readonly pinnedIds?: ReadonlyArray<string>;
  /**
   * Item #57 — fired for each session about to be evicted, before its files
   * are unlinked. The daemon janitor / retention CLI thread a summarizer here
   * so an expiring transcript is first folded into a durable index. Best-effort
   * (a throwing hook never blocks eviction). Absent → behaviour unchanged.
   */
  readonly onBeforeEvict?: BeforeEvictHook;
};

/**
 * Run the TTL-eviction pass standalone — exactly `list()`'s eviction
 * side-effect (mtime-keyed, unlinks `.json` + sibling
 * `.jsonl`/`.events.jsonl`) without
 * reading or parsing the surviving sessions. Daemon shapes that never call
 * `list()` (managed gateway, channel bots, batch workers) invoke this from
 * `runtime-core`'s boot-time janitor so idle transcripts still expire.
 * Returns the evicted session ids.
 */
export async function evictExpiredSessions(
  opts: EvictExpiredSessionsOptions = {},
): Promise<{ evictedIds: string[] }> {
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const now = opts.now ?? (() => new Date());
  const cutoff = now().getTime() - ttlDays * MS_PER_DAY;
  const pinned = opts.pinnedIds !== undefined ? new Set(opts.pinnedIds) : undefined;
  const { evictedIds } = await sweepExpired(rootDir, cutoff, pinned, opts.onBeforeEvict);
  return { evictedIds };
}

export function createSessionStore(opts: SessionStoreOptions = {}): SessionStore {
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const now = opts.now ?? (() => new Date());

  function pathFor(id: string): string {
    return sessionPath(rootDir, id);
  }

  function logPathFor(id: string): string {
    return sessionLogPath(rootDir, id);
  }

  function validateId(id: string): void {
    if (!ID_REGEX.test(id)) {
      throw new RuntimeError(`session-store: invalid sessionId "${id}" — expected sess_<16 hex>`);
    }
  }

  function generateId(): string {
    return `sess_${randomBytes(8).toString("hex")}`;
  }

  async function writeAtomic(session: Session): Promise<void> {
    await mkdir(rootDir, { recursive: true });
    writeContained(pathFor(session.id), JSON.stringify(session, null, 2), "the session record");
  }

  async function readSession(id: string): Promise<Session | null> {
    const absPath = pathFor(id);
    // The read itself is synchronous (see readRecord); yield first, as the
    // asynchronous read before it did, so a caller reading many sessions
    // (list()) or reading in a loop never starves the event loop.
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    if (!existsSync(dirname(absPath))) return null;
    const read = readRecord(absPath);
    if (!read.ok) {
      if (read.code === "not-found") return null;
      throw refusal("read", `session "${id}"`, absPath, read);
    }
    if (read.truncated) {
      throw new RuntimeError(
        `session-store: session "${id}" is larger than ${MAX_SESSION_RECORD_BYTES} bytes, so it is not a session record`,
      );
    }
    return parseSession(read.text, id);
  }

  function parseSession(raw: string, id: string): Session {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new RuntimeError(`session-store: malformed JSON for "${id}"`, err);
    }
    if (!isSessionShape(parsed)) {
      throw new RuntimeError(`session-store: unexpected JSON shape for "${id}"`);
    }
    return normalizeAdditiveFields(parsed);
  }

  return {
    async create(createOpts: CreateOpts): Promise<Session> {
      const id = createOpts.id ?? generateId();
      validateId(id);
      const isoNow = now().toISOString();
      const session: Session = {
        id,
        createdAt: isoNow,
        updatedAt: isoNow,
        name: createOpts.name,
        target: createOpts.target,
        model: createOpts.model,
        lastTurnIndex: 0,
      };
      await writeAtomic(session);
      return session;
    },

    async get(id: string): Promise<Session | null> {
      validateId(id);
      return readSession(id);
    },

    async list(): Promise<Session[]> {
      const cutoff = now().getTime() - ttlDays * MS_PER_DAY;
      const { survivorIds } = await sweepExpired(rootDir, cutoff);
      const survivors: Session[] = [];
      for (const id of survivorIds) {
        try {
          const session = await readSession(id);
          if (session !== null) survivors.push(session);
        } catch (err) {
          // Best-effort: an unreadable record should not abort the listing.
          // The error says why (malformed JSON, or a refused link or FIFO).
          console.error(
            `session-store: skipping session "${id}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      survivors.sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      );
      return survivors;
    },

    async update(id: string, patch: SessionPatch): Promise<Session> {
      validateId(id);
      const current = await readSession(id);
      if (current === null) {
        throw new RuntimeError(`session-store: cannot update missing session "${id}"`);
      }
      const { pin, ...rest } = patch;
      // 0.6.0 — `pin: null` clears (the key is OMITTED, not set to undefined,
      // so a cleared file is byte-identical to one never pinned); a string
      // sets; `undefined`/absent leaves the current pin alone.
      const { pin: currentPin, ...currentWithoutPin } = current;
      const nextPin = pin === null ? undefined : pin === undefined ? currentPin : pin;
      const next: Session = {
        ...currentWithoutPin,
        ...rest,
        ...(nextPin !== undefined ? { pin: nextPin } : {}),
        updatedAt: now().toISOString(),
      };
      await writeAtomic(next);
      return next;
    },

    async delete(id: string): Promise<void> {
      validateId(id);
      await unlink(pathFor(id)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
      });
      await unlink(logPathFor(id)).catch(() => undefined);
      // Same sibling the TTL sweep unlinks (sweepExpired above): once the
      // `.json` is gone the sweep's `sess_*.json` walk can never re-match this
      // id, so an explicit delete() (retention sweep / janitor) is the only
      // thing that can reclaim the watchme trace sibling — it must, or the file
      // outlives the user's retention policy forever.
      await unlink(sessionEventsPath(rootDir, id)).catch(() => undefined);
    },
  };
}

// -------- Item #57: summarize-before-evict durable index --------

/** A parsed session event-log line. */
export type SessionLogEvent = { readonly kind?: string; readonly payload?: unknown };

/** A compact, durable index entry for one session — what survives past the
 *  raw transcript's TTL. */
export type SessionSummary = {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  /** Number of user-text turns in the session. */
  readonly turnCount: number;
  /** Unique tool names the assistant called, verbatim, first-seen order. */
  readonly toolsUsed: readonly string[];
  /** Count of positive vs negative user ratings on this session's turns. */
  readonly ratings: { readonly positive: number; readonly negative: number };
  /** A short outcome line — the final assistant answer, clipped. */
  readonly outcome: string;
  /** Up to a few key facts (first-line of each turn's final answer), clipped. */
  readonly keyFacts: readonly string[];
  /** Whether the run recorded a runtime `error` event. */
  readonly hadError: boolean;
  /** ISO timestamp the summary was produced. */
  readonly summarizedAt: string;
};

export const SESSION_SUMMARY_SCHEMA_VERSION = 1 as const;

function clipLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

function firstText(payload: unknown): string {
  const content = (payload as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = (content as Array<{ type?: string; text?: string }>)
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    return texts.join("\n");
  }
  return "";
}

/**
 * Summarize a session's raw event log into a compact, durable `SessionSummary`.
 * Deterministic (no model call): counts user-text turns, collects the tool
 * names the assistant called, tallies positive/negative `user_feedback`
 * ratings, records whether a runtime `error` fired, and keeps the last
 * assistant answer as the outcome plus a few per-turn key facts. `now` is
 * injectable for deterministic tests.
 */
export function summarizeSession(
  sessionId: string,
  events: readonly SessionLogEvent[],
  opts: { now?: () => Date; maxFacts?: number } = {},
): SessionSummary {
  const now = opts.now ?? (() => new Date());
  const maxFacts = opts.maxFacts ?? 5;
  let turnCount = 0;
  const toolsUsed: string[] = [];
  const toolSeen = new Set<string>();
  let positive = 0;
  let negative = 0;
  let hadError = false;
  let lastAnswer = "";
  const keyFacts: string[] = [];
  let inTurn = false;

  for (const ev of events) {
    if (ev.kind === "user_message") {
      const p = ev.payload as { synthetic?: unknown; content?: unknown } | undefined;
      if (p?.synthetic === true) continue;
      const content = p?.content;
      const isToolResultOnly =
        Array.isArray(content) &&
        (content as Array<{ type?: string }>).every((b) => b.type === "tool_result");
      if (isToolResultOnly) continue;
      const text = firstText(ev.payload);
      // A string, or an array with ≥1 text block, opens a turn.
      if (typeof content === "string" || text !== "") {
        turnCount += 1;
        inTurn = true;
      }
    } else if (ev.kind === "assistant_message" && inTurn) {
      const content = (ev.payload as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const b of content as Array<{ type?: string; name?: string }>) {
          if (b.type === "tool_use" && typeof b.name === "string" && !toolSeen.has(b.name)) {
            toolSeen.add(b.name);
            toolsUsed.push(b.name);
          }
        }
      }
      const text = firstText(ev.payload);
      if (text !== "") {
        lastAnswer = text;
        if (keyFacts.length < maxFacts) {
          const firstLine = text
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.length > 0);
          if (firstLine !== undefined) {
            const fact = clipLine(firstLine, 160);
            if (!keyFacts.includes(fact)) keyFacts.push(fact);
          }
        }
      }
    } else if (ev.kind === "error") {
      hadError = true;
    } else if (ev.kind === "user_feedback") {
      const rating = (ev.payload as { rating?: { thumbs?: string; stars?: number } } | undefined)
        ?.rating;
      if (rating !== undefined) {
        if (rating.thumbs === "up" || (typeof rating.stars === "number" && rating.stars >= 4)) {
          positive += 1;
        } else if (
          rating.thumbs === "down" ||
          (typeof rating.stars === "number" && rating.stars <= 2)
        ) {
          negative += 1;
        }
      }
    }
  }

  return {
    schemaVersion: SESSION_SUMMARY_SCHEMA_VERSION,
    sessionId,
    turnCount,
    toolsUsed,
    ratings: { positive, negative },
    outcome: clipLine(lastAnswer, 240),
    keyFacts,
    hadError,
    summarizedAt: now().toISOString(),
  };
}

// -------- durable sessions index (item #57 glue, lifted from apps/cli in
// v0.3.0 PR 14 so the dream engine's fold-in step can reuse it — the CLI
// re-exports these unchanged) --------

/** The index directory name, relative to a session root's PARENT
 *  `.crewhaus` dir (`.crewhaus/sessions-index/`). */
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
 *
 * 0.7.1: the index entry is written rooted at `indexDir`'s PARENT (the
 * harness `.crewhaus`), with the relative path `sessions-index/<id>.json`, so
 * the lazily created index directory is contained too: a symlink planted at
 * `.crewhaus/sessions-index` pointing out of `.crewhaus` is refused, where a
 * write rooted at the index directory itself followed it as the root and put
 * the model's final text in a file of its choosing. The parent is the
 * operator's, and may itself be a link. The log is read without following a
 * link at its name, since the summary feeds session recall into later
 * prompts.
 */
export function summarizeSessionIntoIndex(
  sessionId: string,
  logPath: string,
  indexDir: string,
  now: () => Date = () => new Date(),
): SessionSummary | undefined {
  const text = readSessionLog(logPath);
  if (text === undefined) return undefined;
  const events = parseSessionLog(text);
  if (events.length === 0) return undefined;
  const summary = summarizeSession(sessionId, events, { now });
  const dir = resolve(indexDir);
  const root = dirname(dir);
  mkdirSync(root, { recursive: true });
  const target = resolve(dir, `${sessionId}.json`);
  const written = writeFileSafe(
    root,
    relative(root, target),
    `${JSON.stringify(summary, null, 2)}\n`,
    { overwrite: true, mode: 0o600, createParents: true },
  );
  if (!written.ok) throw refusal("write", "the session summary", target, written);
  return summary;
}

/**
 * A session log's text, or undefined when there is none. A link, FIFO or
 * directory at the name is refused (thrown), never read.
 */
function readSessionLog(logPath: string): string | undefined {
  const abs = resolve(logPath);
  const opened = openForReadFd(dirname(abs), basename(abs), { followLeafSymlink: false });
  if (!opened.ok) {
    if (opened.code === "not-found") return undefined;
    throw refusal("read", "the session log", abs, opened);
  }
  try {
    return readFileSync(opened.fd, "utf-8");
  } finally {
    closeSync(opened.fd);
  }
}

function isSessionShape(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  // 0.6.0 — `pin` / `models` are deliberately NOT part of the shape check: a
  // malformed additive field must never make a session unreadable (which
  // would break `--resume`); `normalizeAdditiveFields` drops it instead.
  return (
    typeof v["id"] === "string" &&
    typeof v["createdAt"] === "string" &&
    typeof v["updatedAt"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["target"] === "string" &&
    typeof v["model"] === "string" &&
    typeof v["lastTurnIndex"] === "number"
  );
}

/**
 * 0.6.0 — coerce the two additive fields on load: a non-string `pin` is
 * dropped, a `models` that is not an array of strings is dropped (a mixed
 * array keeps its string members). Everything else passes through untouched,
 * so a 0.5.x file round-trips byte-identically through `update()`.
 */
function normalizeAdditiveFields(session: Session): Session {
  const { pin, models, ...rest } = session as Record<string, unknown> & Session;
  const hasPin = "pin" in session;
  const hasModels = "models" in session;
  if (!hasPin && !hasModels) return session;
  const validPin = typeof pin === "string" ? { pin } : {};
  const validModels = Array.isArray(models)
    ? { models: (models as unknown[]).filter((m): m is string => typeof m === "string") }
    : {};
  return { ...rest, ...validPin, ...validModels } as Session;
}

// ===========================================================================
// Loop contract 0.4 (Batch C, G11) — pending-approval persistence.
//
// When a tool permission resolves to `ask` on a NON-interactive surface and
// `permissions.ask_mode` is `"pause"`, runtime-core persists a
// `PendingApproval` here, parks the run, and re-reads on the next execution to
// re-resolve the call. The record lives in ONE append-only JSONL file beside
// the session `.json`/`.jsonl` files (`<rootDir>/approvals.jsonl`). Keyed on
// `(toolName, inputHash)` — NOT on session — so a grant persisted by one run is
// found by the next run that re-issues the same call. TTL'd on the same
// mtime-independent clock as sessions: a record whose `createdAt` is older than
// `ttlDays` is treated as absent, and dropped by the boot sweep.
//
// 0.9.0 (#507, #513) — the first decision wins, on every surface. Reads fold
// first-decision-wins with the decision claims applied (`./approvals/fold`),
// and never rewrite the file. Every write takes `approvals.d/lock`, a decision
// is an exclusive claim, and a content-free decision log records each step
// (`./approvals/decide`, `./approvals/log`).
// ===========================================================================

/** The out-of-band decision recorded on a parked approval. */
export type ApprovalDecision = "grant" | "deny";

/**
 * One path a parked call names, as the permission gate read it, and the
 * absolute place(s) it landed: the entry itself and, when that is a symlink,
 * its target. A place the gate could not work out reads `unresolved:<path>`.
 */
export type ApprovalPlace = {
  readonly path: string;
  readonly at: ReadonlyArray<string>;
};

/**
 * 0.7.1 — the approval a park was asked in place of: one for the same call,
 * granted or still waiting, made while the call landed somewhere else (a
 * symlink on its path has moved since). Kept on the new record so a surface
 * can say why the same call is asked again, and where it was approved.
 */
export type SupersededApproval = {
  readonly id: string;
  /** Its decision when the new park was made; absent while it was still waiting. */
  readonly decision?: ApprovalDecision;
  /** Where the call landed then; absent on a record written before approvals were bound. */
  readonly places?: ReadonlyArray<ApprovalPlace>;
};

/**
 * One parked tool-approval request. `id` (`appr_<16 hex>`) is the stable key
 * the `approval_requested`/`approval_resolved` trace events and the CLI/Slack
 * approval verbs reference. `inputHash` is `hashApprovalInput(toolName, input)`
 * — the cross-session key a grant/deny is matched on. `decision` is unset
 * while pending and set once resolved out of band; `consumedAt` is stamped
 * when a one-shot grant is spent so a later identical call re-asks.
 */
export type PendingApproval = {
  readonly id: string;
  readonly toolName: string;
  readonly inputHash: string;
  /** The tool input verbatim, so an approver can inspect what they're granting. */
  readonly input?: unknown;
  /**
   * 0.7.1 — where the call acted when it was parked: every path the
   * permission gate read for it, and where each one landed (absolute, every
   * symlink followed). The decision on this record covers the call only
   * while it still lands there; when a link has moved it since, the call is
   * asked again. Absent on a record written before 0.7.1 bound approvals to
   * a place (see runtime-core).
   */
  readonly places?: ReadonlyArray<ApprovalPlace>;
  /**
   * 0.7.1 — set when this park asks again for a call already approved (or
   * already waiting) where it landed before: the approval it was asked in
   * place of, and where that one landed.
   */
  readonly supersedes?: SupersededApproval;
  readonly runId: string;
  readonly sessionId: string;
  /** Free-form non-interactive surface classifier (`"single-turn"`, `"daemon"`, …). */
  readonly surface: string;
  readonly createdAt: string;
  decision?: ApprovalDecision;
  decidedBy?: string;
  decidedAt?: string;
  /** Set when a one-shot `grant` has been spent by a run (re-ask on next call). */
  consumedAt?: string;
  /**
   * #383 — set when a `grant` was recorded as a STANDING allow
   * (`crewhaus approvals grant <id> --always`, the Slack "Always allow"
   * button). The resolving surface also persists an `alwaysAllow` rule for
   * the tool into the harness's `.crewhaus/settings.json` — THAT rule
   * carries the standing behavior, pre-deciding future calls before this
   * store is consulted. The grant record itself stays one-shot (consumed on
   * use like any grant), so removing the rule fully revokes the standing
   * allow; the flag exists for display and audit provenance. Absent on
   * plain one-shot grants and denies.
   */
  always?: boolean;
  // ---- 0.9.0 (#507, #513) — additive, all OPTIONAL. `isPendingApprovalShape`
  // checks only the seven required strings, so 0.8.x readers keep reading. ----
  /**
   * The decider as a stored actor: a `prn_` member id or `local:#<keyed digest>`
   * of the local user, never a raw `local:` identity and never free text.
   * `decidedBy` stays the display name, and carries no authority.
   */
  readonly decidedByPrincipal?: string;
  /** The door the decision came through (`home`, `cli`, `slack`, …). */
  readonly decidedVia?: ReceiptVia;
  /**
   * What replaced this request: the fresh request parked in its place
   * (`crewhaus approvals supersede`, or a grant whose revisions moved), or, when
   * `supersededReason` is `run-cancelled`, the run whose cancel withdrew it. A
   * withdrawn request has no replacement.
   */
  readonly supersededBy?: string;
  /** Why it was replaced: a code from a closed list. */
  readonly supersededReason?: SupersedeReason;
  /** A pending request deferred until this instant (`crewhaus approvals defer`). */
  readonly deferredUntil?: string;
  /**
   * The lowest class that may decide it, set when it is parked. Absent counts as
   * `operator`. Classes bite once a harness has members; until then the owner
   * decides everything.
   */
  readonly requiredClass?: DecisionClass;
  /**
   * What a grant on it is good for: the scope it was asked in (`resumeScope`), the
   * run that parked, the deployment and spec it was asked under when known, a
   * version of the resource when the tool reports one, and a keyed digest of where
   * the call lands. Absent on a record parked before 0.9.0, which counts as bound
   * to its session.
   */
  readonly binding?: DecisionBinding;
  /** A keyed digest of the binding, which every later decision-log line for it carries. */
  readonly bindingDigest?: string;
  /** The run that spent the grant. */
  readonly consumedByRun?: string;
};

/**
 * A binding as a park hands it to `persist`: the store fills in the keyed parts
 * (`placesDigest`, and the record's `bindingDigest`), since only it holds the key.
 */
export type UnsealedBinding = Omit<DecisionBinding, "placesDigest"> & {
  readonly placesDigest?: string;
};

/** What `persist` takes: a record whose binding the store seals when it parks it. */
export type ApprovalToPersist = Omit<PendingApproval, "binding"> & {
  readonly binding?: UnsealedBinding;
};

/** Where a spend happens, and what it is checked against (see `consume`). */
export type ConsumeRequest = {
  /** The run spending it: the top run, as the run ledger names it. */
  readonly runId: string;
  /** The scope the spending run is in. */
  readonly resumeScope: string;
  /** The parked run this one continues, when it is a continuation. */
  readonly continues?: string;
  readonly deploymentId?: string;
  readonly specHash?: string;
  /** The version of the resource the tool reports now; absent when it reports none. */
  readonly resourceRevision?: string;
  /** Where the call lands now. */
  readonly places: ReadonlyArray<ApprovalPlace>;
  /** Who may decide in this harness now: the caller reads the harness's projection. */
  readonly approvers: VerifyApprovers;
  /** Where the spend comes from, for the decision log; the record's surface when absent. */
  readonly surface?: string;
  /**
   * `false` when no run waits on the answer (a call a rule already allows): a
   * refusal is logged and nothing is superseded, so no request reaches the inbox.
   */
  readonly reask?: false;
};

export type ConsumeAnswer =
  | { readonly outcome: "consumed"; readonly record: PendingApproval }
  | {
      readonly outcome: "refused";
      readonly reason: VerifyReason;
      readonly record: PendingApproval;
      /** The request parked in its place, when the refusal retired the grant. */
      readonly fresh?: PendingApproval;
    }
  | { readonly outcome: "not-found"; readonly record: null };

export type SupersedeRunRequest = {
  readonly reason: "run-cancelled";
  readonly via?: ReceiptVia;
};

/**
 * The persistence seam runtime-core's `approvals` option consumes. The
 * concrete `createPendingApprovalStore` implements this over a JSONL file;
 * tests may inject an in-memory twin. `persist` appends a line, and the fold
 * governs it: until a record is decided its newest line wins; once it is
 * decided a later line may only add `consumedAt` (so a one-shot grant is
 * consumed by re-persisting the record with `consumedAt` set) or mark it
 * superseded.
 */
export interface PendingApprovalStore {
  /**
   * Append a `PendingApproval`; the fold governs what it changes. A record's
   * binding is sealed here (its places digest and `bindingDigest`). An undecided
   * line for a request already decided or withdrawn writes nothing.
   */
  persist(approval: ApprovalToPersist): Promise<void>;
  /**
   * The current record for `(toolName, inputHash)`: the newest non-consumed,
   * non-superseded, non-expired match (pending or resolved), or `null`. The
   * runtime branches on the returned `decision`. With `resumeScope`, only a
   * record bound to that scope matches (`recordInScope`): a record parked before
   * grants were bound counts as bound to its session.
   */
  get(
    toolName: string,
    inputHash: string,
    opts?: { readonly resumeScope?: string },
  ): Promise<PendingApproval | null>;
  /**
   * Record an out-of-band decision on the approval `id` (the CLI/Slack verb
   * path), first-wins. Returns the updated record ONLY when this call decided
   * it; `null` when the id is unknown, already decided, spent, superseded or
   * expired — the channel `ApprovalStore` contract, so a duplicate resolve (a
   * button retry, two surfaces racing) is a no-op and the first decision
   * stands. `opts.always` marks a `grant` as a standing allow (#383) —
   * recorded on the record verbatim; ignored for `deny`. `opts.via` names the
   * surface it came through.
   */
  resolve(
    id: string,
    decision: ApprovalDecision,
    by: string,
    opts?: { readonly always?: boolean; readonly via?: ReceiptVia },
  ): Promise<PendingApproval | null>;
  /**
   * Every live approval (not expired, not superseded), newest-touched first.
   * A read: it never rewrites the backing file. Expired records are dropped
   * by the locked boot sweep (`evictExpiredApprovals`), which logs each one
   * first.
   */
  list(): Promise<PendingApproval[]>;
  /**
   * Spend a grant: the checks a grant must pass just before the call it covers
   * runs, made under the lock, then an exclusive claim, so exactly one caller
   * spends it, across processes. A refusal leaves it unspent; one that retires it
   * also parks the request asked in its place. Optional: a store without it
   * spends a grant once per process only.
   */
  consume?(id: string, request: ConsumeRequest): Promise<ConsumeAnswer>;
  /**
   * Withdraw what the runs named were waiting on, when they are cancelled: every
   * request bound to one of them that is pending, or granted and unspent, is
   * superseded `run-cancelled`, naming the first canonical run id. Nothing is
   * asked in its place. Optional, like `consume`.
   */
  supersedeRun?(
    runIds: readonly string[],
    request: SupersedeRunRequest,
  ): Promise<{ readonly superseded: string[] }>;
}

export { DEFAULT_APPROVALS_FILENAME } from "./approvals/log";

/**
 * Stable canonical JSON — object keys sorted recursively — so a tool input
 * hashes identically regardless of key insertion order. Used only to derive
 * the approval key; not a general serializer.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * The cross-session key a grant/deny is matched on: a SHA-256 hex digest of
 * the canonical `(toolName, input)` pair. Exported so runtime-core (which
 * parks and re-resolves) and any approval surface (CLI/Slack, which resolve)
 * compute the identical key.
 */
export function hashApprovalInput(toolName: string, input: unknown): string {
  return createHash("sha256").update(stableStringify({ toolName, input })).digest("hex");
}

export type PendingApprovalStoreOptions = {
  readonly rootDir?: string;
  readonly ttlDays?: number;
  readonly now?: () => Date;
};

/**
 * Sweep expired pending approvals WITHOUT listing them — the approvals
 * counterpart to {@link evictExpiredSessions}, and for the same reason.
 *
 * `list()` was the only operation that ever pruned this log, and its only
 * production callers are the human-invoked `crewhaus approvals list|show`
 * verbs, so on an unattended harness nothing compacted it at all: a full
 * park→grant→consume cycle appends three lines, a consumed or expired record
 * makes the next identical call mint a fresh id and append again, and `get`
 * re-folds the entire file on every `ask`.
 *
 * The retention angle is the sharper one. Each record embeds the raw tool
 * input, and nothing in the harness's retention machinery could reach it:
 * `evictExpiredSessions`, `SessionStore.delete()` and `crewhaus retention
 * sweep|purge` all key on `sess_<16 hex>.json`, and the retention inventory
 * classifies `approvals.jsonl` as "not a session artifact" and skips it. An
 * operator could purge a session for compliance while the tool input that
 * session tried to run survived indefinitely in a sibling file, with mode
 * 0600 as the only control.
 */
export async function evictExpiredApprovals(
  opts: PendingApprovalStoreOptions = {},
): Promise<{ evictedIds: string[] }> {
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const now = opts.now ?? (() => new Date());
  const cutoffMs = now().getTime() - ttlDays * MS_PER_DAY;
  // Under the lock: each dropped record is logged (`expire`, `evict`) before
  // the file is rewritten with the folded survivors. A root with no approvals
  // is left alone, and nothing is created there.
  const { evictedIds } = await sweepApprovals(rootDir, cutoffMs, now);
  return { evictedIds };
}

/**
 * The file-backed store: the runtime's seam plus the decision lifecycle, and the session
 * root it keeps its files in, so a surface can decide on the same root.
 */
export type FilePendingApprovalStore = PendingApprovalStore &
  ApprovalDecisions & { readonly rootDir: string };

/** Newest-touched first: a decision counts from when it was made. */
function touchedAt(approval: PendingApproval): number {
  const at = Date.parse(approval.decidedAt ?? approval.createdAt);
  return Number.isFinite(at) ? at : 0;
}

/**
 * A file-backed {@link PendingApprovalStore}: one append-only JSONL beside the
 * session files, plus `approvals.d/` for the lock, the decision claims, the
 * decision log and its key. Reads fold first-decision-wins with the claims
 * applied and never write; every write takes the lock. The tenant fence from
 * the session store applies — every path resolves inside `rootDir`.
 */
export function createPendingApprovalStore(
  opts: PendingApprovalStoreOptions = {},
): FilePendingApprovalStore {
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const now = opts.now ?? (() => new Date());
  const cutoffMs = (): number => now().getTime() - ttlDays * MS_PER_DAY;
  const writer = createApprovalWriter({ rootDir, ttlDays, now });

  return {
    rootDir,
    persist: writer.persist,
    decide: writer.decide,
    supersede: writer.supersede,
    defer: writer.defer,
    consume: writer.consume,
    supersedeRun: writer.supersedeRun,

    async get(
      toolName: string,
      inputHash: string,
      getOpts?: { readonly resumeScope?: string },
    ): Promise<PendingApproval | null> {
      const read = readApprovalsFile(rootDir);
      if (read.state === "absent") return null;
      if (read.state === "unreadable") {
        throw new RuntimeError(`session-store: refusing to read the approvals log: ${read.reason}`);
      }
      // Claims are read only for the records this call could return.
      const match = (a: PendingApproval): boolean =>
        a.toolName === toolName && a.inputHash === inputHash;
      const candidates = foldWithClaims(rootDir, read.objects, { select: match }).records;
      const cutoff = cutoffMs();
      let best: PendingApproval | null = null;
      let bestAt = -1;
      for (const approval of candidates) {
        if (!match(approval)) continue;
        if (approval.consumedAt !== undefined) continue;
        if (approval.supersededBy !== undefined) continue;
        if (approvalIsExpired(approval, cutoff)) continue;
        const scope = getOpts?.resumeScope;
        if (scope !== undefined && !recordInScope(approval, scope)) continue;
        // Newest-touched wins: a fresh decision supersedes an older pending.
        const at = touchedAt(approval);
        if (at >= bestAt) {
          bestAt = at;
          best = approval;
        }
      }
      return best;
    },

    async resolve(
      id: string,
      decision: ApprovalDecision,
      by: string,
      opts?: { readonly always?: boolean; readonly via?: ReceiptVia },
    ): Promise<PendingApproval | null> {
      const answer = await writer.decide(
        id,
        {
          choice: decision,
          actor: { display: by },
          ...(opts?.via !== undefined ? { via: opts.via } : {}),
          // #383 — a standing allow only ever rides on a grant.
          ...(opts?.always === true ? { always: true } : {}),
        },
        { authorize: allowSingleOwner },
      );
      return answer.outcome === "decided" ? answer.record : null;
    },

    async list(): Promise<PendingApproval[]> {
      const folded = foldReadOnly(rootDir);
      if (folded.state === "unreadable") {
        throw new RuntimeError(
          `session-store: refusing to read the approvals log: ${folded.reason ?? "unreadable"}`,
        );
      }
      const cutoff = cutoffMs();
      const live = folded.records.filter(
        (a) => a.supersededBy === undefined && !approvalIsExpired(a, cutoff),
      );
      return live.sort((a, b) => touchedAt(b) - touchedAt(a));
    },
  };
}

export {
  type ApprovalActor,
  type ApprovalAuthorizer,
  type ApprovalDecisions,
  type ApprovalOp,
  type AuthorizeAnswer,
  type AuthorizeRequest,
  type DecideAnswer,
  type DecideRequest,
  type DeferAnswer,
  type DeferRequest,
  DEFER_REASONS,
  SUPERSEDE_REASONS,
  type SupersedeAnswer,
  type SupersedeRequest,
  allowSingleOwner,
  generateApprovalId,
  parseDeferUntil,
} from "./approvals/decide";
export {
  type ApprovalFold,
  type ClaimFault,
  type ClaimFold,
  type FoldOptions,
  type ReadOnlyFold,
  foldApprovalRecords,
  foldReadOnly,
  foldWithClaims,
  parseDecisionClaim,
  parseSupersedeClaim,
  recordInScope,
} from "./approvals/fold";
export {
  ACTION_DIGEST_LABEL,
  APPROVALS_CLAIMS_DIR,
  BINDING_DIGEST_LABEL,
  APPROVALS_DIGEST_KEY_FILE,
  APPROVALS_DIRNAME,
  APPROVALS_LOCK_FILE,
  DECISION_LOG_DIR,
  type DecisionLogLine,
  LOCAL_ACTOR_LABEL,
  PLACES_DIGEST_LABEL,
  approvalsDigestKey,
  approvalsLedger,
  bindingDigestOf,
  inputDigestOf,
  placesDigestOf,
  sealBinding,
  storedLocalActor,
} from "./approvals/log";
export {
  type HarnessSessionRoot,
  SESSION_DIR_ENV,
  resolveHarnessSessionRoot,
} from "./approvals/root";
export {
  type ApprovalPrincipal,
  NO_PRINCIPAL_REASON,
  needsClassReason,
  principalAuthorizer,
} from "./approvals/authorize";
