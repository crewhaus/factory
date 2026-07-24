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
 * Atomic writes: every `create`/`update` writes to `<id>.json.tmp` and then
 * `rename`s, mirroring the `tool-fs` atomic-write pattern.
 *
 * Path-traversal guard: every public method that consumes an `id` validates
 * it against `/^sess_[0-9a-f]{16}$/`. A malformed id throws `RuntimeError`
 * before any filesystem access.
 *
 * References: `claude-code/utils/sessionStorage.ts`, `agent-framework/_sessions.py`.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { RuntimeError } from "@crewhaus/errors";
import { assertSamePath, currentTenantContext, requireTenant } from "@crewhaus/tenancy";

export const DEFAULT_ROOT_DIR = ".crewhaus/sessions";
export const DEFAULT_TTL_DAYS = 30;
const ID_REGEX = /^sess_[0-9a-f]{16}$/;
const MS_PER_DAY = 86_400_000;

export type Session = {
  readonly id: string;
  readonly createdAt: string;
  updatedAt: string;
  name: string;
  target: string;
  model: string;
  lastTurnIndex: number;
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

export type SessionPatch = Partial<Pick<Session, "name" | "target" | "model" | "lastTurnIndex">>;

export interface SessionStore {
  create(opts: CreateOpts): Promise<Session>;
  get(id: string): Promise<Session | null>;
  list(): Promise<Session[]>;
  update(id: string, patch: SessionPatch): Promise<Session>;
  delete(id: string): Promise<void>;
}

// When a tenant context is active, fail closed on any resolved path that
// escapes the tenant's sessionRoot (CWE-1230). Outside a tenant scope (the
// common CLI case) this is a no-op so non-tenant behaviour is unchanged.
function fencePath(absPath: string): string {
  if (currentTenantContext() !== undefined) {
    assertSamePath(absPath, requireTenant().sessionRoot);
  }
  return absPath;
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
    const finalPath = pathFor(session.id);
    const tmpPath = `${finalPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(session, null, 2), { mode: 0o600 });
    await rename(tmpPath, finalPath);
  }

  async function readSession(id: string): Promise<Session | null> {
    let raw: string;
    try {
      raw = await readFile(pathFor(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return parseSession(raw, id);
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
    return parsed;
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
          // Best-effort: a malformed file should not abort the listing.
          console.error(`session-store: skipping malformed session "${id}"`, err);
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
      const next: Session = {
        ...current,
        ...patch,
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

function isSessionShape(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
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

// ===========================================================================
// Loop contract 0.4 (Batch C, G11) — pending-approval persistence.
//
// When a tool permission resolves to `ask` on a NON-interactive surface and
// `permissions.ask_mode` is `"pause"`, runtime-core persists a
// `PendingApproval` here, parks the run, and re-reads on the next execution to
// re-resolve the call. The record lives in ONE append-only JSONL file beside
// the session `.json`/`.jsonl` files (`<rootDir>/approvals.jsonl`), folded
// last-wins per `id` on read. Keyed on `(toolName, inputHash)` — NOT on
// session — so a grant persisted by one run is found by the next run that
// re-issues the same call. TTL'd on the same mtime-independent clock as
// sessions: a record whose `createdAt` is older than `ttlDays` is treated as
// absent (and compacted away by `list()`).
// ===========================================================================

/** The out-of-band decision recorded on a parked approval. */
export type ApprovalDecision = "grant" | "deny";

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
};

/**
 * The persistence seam runtime-core's `approvals` option consumes. The
 * concrete `createPendingApprovalStore` implements this over a JSONL file;
 * tests may inject an in-memory twin. `persist` is an upsert (last-wins by
 * `id`), so a one-shot grant is consumed by re-persisting the record with
 * `consumedAt` set.
 */
export interface PendingApprovalStore {
  /** Append (upsert) a `PendingApproval`. */
  persist(approval: PendingApproval): Promise<void>;
  /**
   * The current record for `(toolName, inputHash)`: the newest non-consumed,
   * non-expired match (pending or resolved), or `null`. The runtime branches
   * on the returned `decision`.
   */
  get(toolName: string, inputHash: string): Promise<PendingApproval | null>;
  /**
   * Record an out-of-band decision on the approval `id` (the CLI/Slack verb
   * path). Returns the updated record, or `null` when no such id exists.
   */
  resolve(id: string, decision: ApprovalDecision, by: string): Promise<PendingApproval | null>;
  /**
   * Every live (non-expired) approval, newest-first. Compacts the backing
   * file as a side-effect (drops expired + superseded lines), mirroring
   * `SessionStore.list()`'s TTL eviction.
   */
  list(): Promise<PendingApproval[]>;
}

export const DEFAULT_APPROVALS_FILENAME = "approvals.jsonl";
const APPROVAL_ID_REGEX = /^appr_[0-9a-f]{16}$/;

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

function isPendingApprovalShape(value: unknown): value is PendingApproval {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["toolName"] === "string" &&
    typeof v["inputHash"] === "string" &&
    typeof v["runId"] === "string" &&
    typeof v["sessionId"] === "string" &&
    typeof v["surface"] === "string" &&
    typeof v["createdAt"] === "string"
  );
}

/**
 * A file-backed {@link PendingApprovalStore}: one append-only JSONL beside the
 * session files. Reads fold the log last-wins per `id`; `list()` additionally
 * compacts (atomic tmp+rename) and evicts records older than `ttlDays`. The
 * path-traversal fence + tenant fence from the session store apply — the file
 * always resolves inside `rootDir`.
 */
export function createPendingApprovalStore(
  opts: PendingApprovalStoreOptions = {},
): PendingApprovalStore {
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const now = opts.now ?? (() => new Date());
  const filePath = (): string => fencePath(resolve(rootDir, DEFAULT_APPROVALS_FILENAME));

  function validateId(id: string): void {
    if (!APPROVAL_ID_REGEX.test(id)) {
      throw new RuntimeError(`session-store: invalid approvalId "${id}" — expected appr_<16 hex>`);
    }
  }

  // Fold the append-only log into the latest record per id. A malformed line
  // never aborts the fold (best-effort, like session `list()`).
  async function foldAll(): Promise<Map<string, PendingApproval>> {
    let raw: string;
    try {
      raw = await readFile(filePath(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw err;
    }
    const byId = new Map<string, PendingApproval>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (isPendingApprovalShape(parsed)) byId.set(parsed.id, parsed);
    }
    return byId;
  }

  function isExpired(approval: PendingApproval, cutoffMs: number): boolean {
    const created = Date.parse(approval.createdAt);
    return Number.isFinite(created) && created < cutoffMs;
  }

  async function append(approval: PendingApproval): Promise<void> {
    await mkdir(rootDir, { recursive: true });
    await appendFile(filePath(), `${JSON.stringify(approval)}\n`, { mode: 0o600 });
  }

  return {
    async persist(approval: PendingApproval): Promise<void> {
      validateId(approval.id);
      await append(approval);
    },

    async get(toolName: string, inputHash: string): Promise<PendingApproval | null> {
      const cutoffMs = now().getTime() - ttlDays * MS_PER_DAY;
      const folded = await foldAll();
      let best: PendingApproval | null = null;
      let bestAt = -1;
      for (const approval of folded.values()) {
        if (approval.toolName !== toolName || approval.inputHash !== inputHash) continue;
        if (approval.consumedAt !== undefined) continue;
        if (isExpired(approval, cutoffMs)) continue;
        // Newest-touched wins: a fresh decision supersedes an older pending.
        const touchedAt = Date.parse(approval.decidedAt ?? approval.createdAt);
        const at = Number.isFinite(touchedAt) ? touchedAt : 0;
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
    ): Promise<PendingApproval | null> {
      validateId(id);
      const folded = await foldAll();
      const current = folded.get(id);
      if (current === undefined) return null;
      const updated: PendingApproval = {
        ...current,
        decision,
        decidedBy: by,
        decidedAt: now().toISOString(),
      };
      await append(updated);
      return updated;
    },

    async list(): Promise<PendingApproval[]> {
      const cutoffMs = now().getTime() - ttlDays * MS_PER_DAY;
      const folded = await foldAll();
      const live = [...folded.values()].filter((a) => !isExpired(a, cutoffMs));
      // Compact: rewrite the log with only the live, latest-per-id records so
      // it can't grow without bound. Atomic (tmp+rename); a concurrent append
      // racing the rewrite is the only loss window and approvals are low-rate.
      try {
        await mkdir(rootDir, { recursive: true });
        const finalPath = filePath();
        const tmpPath = `${finalPath}.tmp`;
        const body = live.map((a) => JSON.stringify(a)).join("\n");
        await writeFile(tmpPath, body.length > 0 ? `${body}\n` : "", { mode: 0o600 });
        await rename(tmpPath, finalPath);
      } catch (err) {
        // Best-effort compaction — a rewrite failure must not break listing.
        console.error("session-store: approvals compaction failed", err);
      }
      live.sort((a, b) => {
        const at = Date.parse(a.decidedAt ?? a.createdAt);
        const bt = Date.parse(b.decidedAt ?? b.createdAt);
        return bt - at;
      });
      return live;
    },
  };
}

/** Mint a fresh approval id in the `appr_<16 hex>` format the store validates. */
export function generateApprovalId(): string {
  return `appr_${randomBytes(8).toString("hex")}`;
}
