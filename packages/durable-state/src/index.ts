/**
 * `@crewhaus/durable-state` — pluggable dedup + budget stores (audit
 * follow-up R3).
 *
 * Two pieces of security-relevant state were in-memory per process:
 *
 *   1. Webhook replay-dedup (the channel-bot gateway's LRU `Set` of
 *      idempotency keys). A daemon restart or a second replica forgets every
 *      seen key, so a captured webhook can be replayed against the fresh
 *      process inside its signature replay-window.
 *   2. Tenant budget accounting (gateway-server's recorded + in-flight
 *      reservation maps, PR #206). Each replica enforces the budget against
 *      its own counters only — N replicas multiply every tenant budget by N.
 *
 * This package defines the store interfaces those consumers now accept, plus
 * two built-in backends:
 *
 *   - In-memory (default, behavior-preserving): exactly the structures the
 *     consumers used inline, factored behind the interface.
 *   - `bun:sqlite` (zero new dependencies — built into Bun): durable across
 *     restarts and shared across processes ON ONE HOST. WAL journaling, a
 *     busy timeout, and IMMEDIATE transactions make the check-and-record /
 *     check-and-reserve operations atomic across concurrent processes (the
 *     write lock is held across the read and the write).
 *
 * Multi-HOST deployments need a network store (Redis, Postgres); implement
 * these interfaces against it — the consumers don't care. Follows the
 * checkpoint-store pluggable-adapter pattern.
 *
 * Crash residual (documented): a process that dies between `tryReserve` and
 * `release` leaks its reservation in the sqlite backend (in-memory state
 * dies with the process; durable state doesn't). Reservations are
 * request-scoped and small; single-writer deployments can call
 * `clearReservations()` at boot, and operators can do the same from tooling
 * after draining traffic.
 */
import { Database } from "bun:sqlite";
import { CrewhausError } from "@crewhaus/errors";

export class DurableStateError extends CrewhausError {
  override readonly name = "DurableStateError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

// ---------------------------------------------------------------------------
// Dedup store
// ---------------------------------------------------------------------------

export interface DedupStore {
  /**
   * Atomic check-and-record. Returns `true` when `key` was already recorded
   * (caller should treat the event as a duplicate and skip it), `false` when
   * this call recorded it first. MUST be atomic across concurrent callers —
   * for the same key, exactly one concurrent `remember` returns `false`.
   */
  remember(key: string): Promise<boolean>;
  /** Drop all recorded keys. Tests/operator tooling. */
  clear(): Promise<void>;
  /** Release any underlying resources. Idempotent. */
  close(): Promise<void>;
}

export type InMemoryDedupStoreOptions = {
  /** Max keys remembered before oldest-first eviction. Default 10 000. */
  readonly capacity?: number;
};

/**
 * Bounded insertion-ordered set — the exact structure the channel-bot
 * gateway used inline. Volatile: restarts forget everything (the adapters'
 * signature replay-windows bound that exposure).
 */
export class InMemoryDedupStore implements DedupStore {
  private readonly seen = new Set<string>();
  private readonly capacity: number;

  constructor(opts: InMemoryDedupStoreOptions = {}) {
    this.capacity = opts.capacity ?? 10_000;
  }

  async remember(key: string): Promise<boolean> {
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value as string | undefined;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  async clear(): Promise<void> {
    this.seen.clear();
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

export type SqliteDedupStoreOptions = {
  /** Database file path. All processes on the host must use the same path. */
  readonly path: string;
  /**
   * How long a recorded key stays a duplicate. Default 24 h — comfortably
   * past every adapter's signature replay-window, which is the window an
   * attacker can replay a captured webhook within anyway.
   */
  readonly ttlMs?: number;
  /** SQLite busy timeout — how long a writer waits for the lock. Default 5 s. */
  readonly busyTimeoutMs?: number;
  /** Test seam: clock. */
  readonly _now?: () => number;
};

/**
 * Cross-process dedup on one host. `remember` runs prune + insert in a
 * single IMMEDIATE transaction: the write lock is held across both, so two
 * processes racing on the same key serialize — exactly one inserts
 * (`changes === 1`) and the other observes the existing row. The prune
 * inside the same transaction also closes the check/prune/insert race the
 * design review flagged.
 */
export class SqliteDedupStore implements DedupStore {
  private readonly db: Database;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly rememberTx: (key: string) => boolean;
  private closed = false;

  constructor(opts: SqliteDedupStoreOptions) {
    this.db = new Database(opts.path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    this.db.run(
      "CREATE TABLE IF NOT EXISTS dedup (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.now = opts._now ?? Date.now;
    const prune = this.db.prepare("DELETE FROM dedup WHERE expires_at <= ?");
    const insert = this.db.prepare("INSERT OR IGNORE INTO dedup (key, expires_at) VALUES (?, ?)");
    const tx = this.db.transaction((key: string): boolean => {
      const t = this.now();
      prune.run(t);
      const r = insert.run(key, t + this.ttlMs);
      return r.changes === 0; // 0 changes = row existed = already seen
    });
    this.rememberTx = (key) => tx.immediate(key) as boolean;
  }

  async remember(key: string): Promise<boolean> {
    return this.rememberTx(key);
  }

  async clear(): Promise<void> {
    this.db.run("DELETE FROM dedup");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Budget store
// ---------------------------------------------------------------------------

export type UsageDelta = {
  readonly input: number;
  readonly output: number;
};

export type BudgetLimits = {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
};

export type TryReserveResult =
  | { readonly ok: true }
  | {
      /** Which dimension exceeded, with the totals for the error message. */
      readonly ok: false;
      readonly reason: "input" | "output";
      readonly total: number;
      readonly limit: number;
    };

export interface BudgetStore {
  /**
   * Atomically reserve `delta` for `tenantId` if recorded + reserved +
   * delta stays under `limits` on BOTH dimensions; nothing is reserved on
   * failure. MUST be atomic across concurrent callers — two reservations
   * that individually fit but jointly exceed must not both succeed.
   */
  tryReserve(tenantId: string, delta: UsageDelta, limits: BudgetLimits): Promise<TryReserveResult>;
  /** Release a reservation made by `tryReserve` (clamped at zero). */
  release(tenantId: string, delta: UsageDelta): Promise<void>;
  /** Add actual usage to the tenant's recorded running total. */
  recordUsage(tenantId: string, delta: UsageDelta): Promise<void>;
  /** Recorded usage (excludes in-flight reservations). */
  usage(tenantId: string): Promise<{ input: number; output: number }>;
  /**
   * Zero ALL reservations. Crash recovery for the durable backend: a process
   * that died mid-request leaks its reservation. Call at boot when this
   * process is the only writer, or from operator tooling after draining.
   */
  clearReservations(): Promise<void>;
  /** Drop all state. Tests. */
  clear(): Promise<void>;
  /** Release any underlying resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * The exact recorded/reserved maps gateway-server used inline (PR #206),
 * factored behind the interface. Single-process semantics are unchanged:
 * synchronous map operations make every method trivially atomic.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly recorded = new Map<string, { input: number; output: number }>();
  private readonly reserved = new Map<string, { input: number; output: number }>();

  async tryReserve(
    tenantId: string,
    delta: UsageDelta,
    limits: BudgetLimits,
  ): Promise<TryReserveResult> {
    const used = this.recorded.get(tenantId) ?? { input: 0, output: 0 };
    const res = this.reserved.get(tenantId) ?? { input: 0, output: 0 };
    const totalInput = used.input + res.input + delta.input;
    const totalOutput = used.output + res.output + delta.output;
    if (totalInput >= limits.maxInputTokens) {
      return { ok: false, reason: "input", total: totalInput, limit: limits.maxInputTokens };
    }
    if (totalOutput >= limits.maxOutputTokens) {
      return { ok: false, reason: "output", total: totalOutput, limit: limits.maxOutputTokens };
    }
    if (delta.input !== 0 || delta.output !== 0) {
      this.reserved.set(tenantId, {
        input: res.input + delta.input,
        output: res.output + delta.output,
      });
    }
    return { ok: true };
  }

  async release(tenantId: string, delta: UsageDelta): Promise<void> {
    if (delta.input === 0 && delta.output === 0) return;
    const cur = this.reserved.get(tenantId) ?? { input: 0, output: 0 };
    const next = {
      input: Math.max(0, cur.input - delta.input),
      output: Math.max(0, cur.output - delta.output),
    };
    if (next.input === 0 && next.output === 0) this.reserved.delete(tenantId);
    else this.reserved.set(tenantId, next);
  }

  async recordUsage(tenantId: string, delta: UsageDelta): Promise<void> {
    const cur = this.recorded.get(tenantId) ?? { input: 0, output: 0 };
    this.recorded.set(tenantId, {
      input: cur.input + delta.input,
      output: cur.output + delta.output,
    });
  }

  async usage(tenantId: string): Promise<{ input: number; output: number }> {
    return this.recorded.get(tenantId) ?? { input: 0, output: 0 };
  }

  async clearReservations(): Promise<void> {
    this.reserved.clear();
  }

  async clear(): Promise<void> {
    this.recorded.clear();
    this.reserved.clear();
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

export type SqliteBudgetStoreOptions = {
  /** Database file path. All processes on the host must use the same path. */
  readonly path: string;
  /** SQLite busy timeout — how long a writer waits for the lock. Default 5 s. */
  readonly busyTimeoutMs?: number;
};

/**
 * Cross-process budget accounting on one host. `tryReserve` runs
 * read-check-update in a single IMMEDIATE transaction, so two processes
 * whose reservations individually fit but jointly exceed serialize on the
 * write lock — the second sees the first's reservation and is refused.
 */
export class SqliteBudgetStore implements BudgetStore {
  private readonly db: Database;
  private readonly reserveTx: (
    tenantId: string,
    delta: UsageDelta,
    limits: BudgetLimits,
  ) => TryReserveResult;
  private readonly releaseTx: (tenantId: string, delta: UsageDelta) => void;
  private closed = false;

  constructor(opts: SqliteBudgetStoreOptions) {
    this.db = new Database(opts.path);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
    this.db.run(`CREATE TABLE IF NOT EXISTS budget (
      tenant_id TEXT PRIMARY KEY,
      recorded_input INTEGER NOT NULL DEFAULT 0,
      recorded_output INTEGER NOT NULL DEFAULT 0,
      reserved_input INTEGER NOT NULL DEFAULT 0,
      reserved_output INTEGER NOT NULL DEFAULT 0
    )`);

    const select = this.db.prepare(
      "SELECT recorded_input, recorded_output, reserved_input, reserved_output FROM budget WHERE tenant_id = ?",
    );
    const upsertReserve = this.db.prepare(`INSERT INTO budget
        (tenant_id, reserved_input, reserved_output) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        reserved_input = reserved_input + excluded.reserved_input,
        reserved_output = reserved_output + excluded.reserved_output`);
    const releaseUpdate = this.db.prepare(`UPDATE budget SET
        reserved_input = MAX(0, reserved_input - ?),
        reserved_output = MAX(0, reserved_output - ?)
      WHERE tenant_id = ?`);

    type Row = {
      recorded_input: number;
      recorded_output: number;
      reserved_input: number;
      reserved_output: number;
    };

    const reserveTxn = this.db.transaction(
      (tenantId: string, delta: UsageDelta, limits: BudgetLimits): TryReserveResult => {
        const row = (select.get(tenantId) as Row | null) ?? {
          recorded_input: 0,
          recorded_output: 0,
          reserved_input: 0,
          reserved_output: 0,
        };
        const totalInput = row.recorded_input + row.reserved_input + delta.input;
        const totalOutput = row.recorded_output + row.reserved_output + delta.output;
        if (totalInput >= limits.maxInputTokens) {
          return { ok: false, reason: "input", total: totalInput, limit: limits.maxInputTokens };
        }
        if (totalOutput >= limits.maxOutputTokens) {
          return {
            ok: false,
            reason: "output",
            total: totalOutput,
            limit: limits.maxOutputTokens,
          };
        }
        if (delta.input !== 0 || delta.output !== 0) {
          upsertReserve.run(tenantId, delta.input, delta.output);
        }
        return { ok: true };
      },
    );
    this.reserveTx = (tenantId, delta, limits) =>
      reserveTxn.immediate(tenantId, delta, limits) as TryReserveResult;

    const releaseTxn = this.db.transaction((tenantId: string, delta: UsageDelta): void => {
      releaseUpdate.run(delta.input, delta.output, tenantId);
    });
    this.releaseTx = (tenantId, delta) => {
      releaseTxn.immediate(tenantId, delta);
    };
  }

  async tryReserve(
    tenantId: string,
    delta: UsageDelta,
    limits: BudgetLimits,
  ): Promise<TryReserveResult> {
    return this.reserveTx(tenantId, delta, limits);
  }

  async release(tenantId: string, delta: UsageDelta): Promise<void> {
    if (delta.input === 0 && delta.output === 0) return;
    this.releaseTx(tenantId, delta);
  }

  async recordUsage(tenantId: string, delta: UsageDelta): Promise<void> {
    this.db
      .prepare(`INSERT INTO budget
        (tenant_id, recorded_input, recorded_output) VALUES (?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        recorded_input = recorded_input + excluded.recorded_input,
        recorded_output = recorded_output + excluded.recorded_output`)
      .run(tenantId, delta.input, delta.output);
  }

  async usage(tenantId: string): Promise<{ input: number; output: number }> {
    const row = this.db
      .prepare("SELECT recorded_input, recorded_output FROM budget WHERE tenant_id = ?")
      .get(tenantId) as { recorded_input: number; recorded_output: number } | null;
    return row === null
      ? { input: 0, output: 0 }
      : { input: row.recorded_input, output: row.recorded_output };
  }

  async clearReservations(): Promise<void> {
    this.db.run("UPDATE budget SET reserved_input = 0, reserved_output = 0");
  }

  async clear(): Promise<void> {
    this.db.run("DELETE FROM budget");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Spec-string factories — env-driven backend selection for generated daemons.
// ---------------------------------------------------------------------------

function parseSpec(spec: string): { backend: "memory" } | { backend: "sqlite"; path: string } {
  if (spec === "memory") return { backend: "memory" };
  if (spec.startsWith("sqlite:")) {
    const path = spec.slice("sqlite:".length);
    if (path === "") {
      throw new DurableStateError(`invalid store spec "${spec}": sqlite: needs a file path`);
    }
    return { backend: "sqlite", path };
  }
  throw new DurableStateError(`invalid store spec "${spec}": expected "memory" or "sqlite:<path>"`);
}

/** Build a DedupStore from a spec string: `"memory"` or `"sqlite:<path>"`. */
export function createDedupStore(
  spec: string,
  opts: { capacity?: number; ttlMs?: number } = {},
): DedupStore {
  const parsed = parseSpec(spec);
  if (parsed.backend === "memory") {
    return new InMemoryDedupStore(opts.capacity !== undefined ? { capacity: opts.capacity } : {});
  }
  return new SqliteDedupStore({
    path: parsed.path,
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
}

/** Build a BudgetStore from a spec string: `"memory"` or `"sqlite:<path>"`. */
export function createBudgetStore(spec: string): BudgetStore {
  const parsed = parseSpec(spec);
  if (parsed.backend === "memory") return new InMemoryBudgetStore();
  return new SqliteBudgetStore({ path: parsed.path });
}
