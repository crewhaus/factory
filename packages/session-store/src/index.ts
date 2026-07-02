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
 * `unlink`-ed (along with its sibling `<id>.jsonl` event log) before the
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
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
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

/**
 * The TTL-eviction pass shared by `list()` and `evictExpiredSessions()`.
 * Walks `rootDir` and unlinks every `sess_<16 hex>.json` whose filesystem
 * mtime is older than `cutoffMs` (along with its sibling `.jsonl` event
 * log). Returns the evicted ids plus the ids that survive, so `list()` can
 * read the survivors without a second directory walk.
 */
async function sweepExpired(
  rootDir: string,
  cutoffMs: number,
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
      // Evict: unlink both the session file and any sibling event log.
      await unlink(fullPath).catch(() => undefined);
      await unlink(sessionLogPath(rootDir, id)).catch(() => undefined);
      evictedIds.push(id);
      continue;
    }
    survivorIds.push(id);
  }
  return { evictedIds, survivorIds };
}

/**
 * Run the TTL-eviction pass standalone — exactly `list()`'s eviction
 * side-effect (mtime-keyed, unlinks `.json` + sibling `.jsonl`) without
 * reading or parsing the surviving sessions. Daemon shapes that never call
 * `list()` (managed gateway, channel bots, batch workers) invoke this from
 * `runtime-core`'s boot-time janitor so idle transcripts still expire.
 * Returns the evicted session ids.
 */
export async function evictExpiredSessions(
  opts: SessionStoreOptions = {},
): Promise<{ evictedIds: string[] }> {
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  const ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
  const now = opts.now ?? (() => new Date());
  const cutoff = now().getTime() - ttlDays * MS_PER_DAY;
  const { evictedIds } = await sweepExpired(rootDir, cutoff);
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
    },
  };
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
