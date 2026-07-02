/**
 * Ops item 36 — boot-time self-heal janitor for daemon shapes.
 *
 * Daemon-shaped harnesses (managed gateway, channel bots, batch workers)
 * accumulate rot that nothing cleans up:
 *
 *   1. Crash-leaked durable-state reservations. `@crewhaus/durable-state`'s
 *      own header documents that a process dying between `tryReserve` and
 *      `release` leaks its reservation in the sqlite backend and that
 *      "single-writer deployments can call `clearReservations()` at boot" —
 *      until this module, nothing did, so leaked reservations silently ate
 *      tenant budgets across restarts.
 *   2. Unbounded transcripts. Session TTL eviction only fires as a
 *      `sessionStore.list()` side-effect; daemons route turns by session id
 *      (`get`/`create`, never `list`)… except through `runChatLoop`'s own
 *      housekeeping `list()`, which only runs when traffic arrives. An idle
 *      or crash-looping daemon never evicts.
 *   3. Orphaned `tool_use` entries. A crash mid-turn can persist an
 *      `assistant_message` whose `tool_use` never got a `tool_result`.
 *
 * `createJanitor(opts).runOnce()` performs the three steps, each
 * individually try/caught (a throwing step is reported and never aborts the
 * others), and `start(intervalMs)` re-runs them on a timer (unref'd, so the
 * janitor never keeps a finished process alive — the batch worker's
 * idle-exit path still exits cleanly).
 *
 * Step semantics:
 *
 *   - reservation_cleanup: runs at most ONCE per janitor (first successful
 *     run, retried after errors), even though `runOnce` re-fires hourly.
 *     `clearReservations()` zeroes ALL reservations — leaked *and live* —
 *     so re-clearing while requests are in flight would briefly disable the
 *     gateway's reserve-ahead TOCTOU guard. At boot the process is the only
 *     writer (single-writer contract from durable-state's header) and every
 *     reservation is by definition leaked; later there is no way to tell
 *     leaked from live, so later runs report `skipped`.
 *   - session_ttl_eviction: `@crewhaus/session-store`'s
 *     `evictExpiredSessions()` — exactly `list()`'s mtime-keyed eviction
 *     side-effect without reading the survivors.
 *   - orphan_tool_use_sweep: DETECT-AND-REPORT ONLY, by explicit judgment.
 *     Repairing on disk was considered and rejected: (a) `--resume` already
 *     self-heals — `replayMessageHistory` runs `sanitizeOrphanToolUses`
 *     before any resumed history reaches the model, so an on-disk orphan
 *     bricks nothing; (b) the `.jsonl` transcript is an append-only record
 *     that feedback/rating/cost surfaces (`crewhaus distill`, `rate`,
 *     `cost-summary`) read — rewriting history would corrupt those
 *     consumers' view for zero resume benefit; (c) a rewrite races the
 *     daemon's own `appendFileSync` on live sessions (read-modify-rename
 *     drops concurrently appended lines). The sweep is bounded (most recent
 *     N logs per root) and skips logs modified inside a quiet period, since
 *     a mid-turn session transiently looks orphaned between the assistant
 *     append and its tool_result append.
 *
 * Every step's outcome is returned in the `JanitorRunResult` and — when a
 * `TraceEventBus` is supplied — published as a `janitor_action` trace event.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { openEventLog } from "@crewhaus/event-log";
import { DEFAULT_ROOT_DIR, evictExpiredSessions } from "@crewhaus/session-store";
import type { TraceEventBus } from "@crewhaus/trace-event-bus";

const SESSION_LOG_REGEX = /^(sess_[0-9a-f]{16})\.jsonl$/;
const DEFAULT_ORPHAN_SCAN_LIMIT = 20;
const DEFAULT_ORPHAN_QUIET_PERIOD_MS = 5 * 60_000;

/**
 * Structural subset of `@crewhaus/durable-state`'s `BudgetStore` — declared
 * here (mirroring `JustificationAuditSink`) so runtime-core does not take a
 * dependency on durable-state. Only target-managed wires a real store.
 */
export type JanitorReservationStore = {
  clearReservations(): Promise<void>;
};

export type JanitorStepName =
  | "reservation_cleanup"
  | "session_ttl_eviction"
  | "orphan_tool_use_sweep";

export type JanitorStepStatus = "ok" | "skipped" | "error";

export type JanitorStepResult = {
  readonly step: JanitorStepName;
  readonly status: JanitorStepStatus;
  /** Step tally: sessions evicted / orphaned tool_use ids found. */
  readonly count?: number;
  /** Skip reason, error message, or sweep stats. */
  readonly detail?: string;
};

export type JanitorRunResult = {
  readonly startedAt: string;
  readonly durationMs: number;
  readonly steps: ReadonlyArray<JanitorStepResult>;
};

export type CreateJanitorOptions = {
  /**
   * Durable-state budget store whose crash-leaked reservations are cleared
   * on the first successful run. Omitted (the default for channel/batch
   * daemons, which carry no budget store) the step reports `skipped`.
   */
  readonly budgetStore?: JanitorReservationStore;
  /**
   * Session directories to sweep — TTL eviction and the orphan scan both
   * walk every listed root. Default: the single root `runChatLoop` itself
   * would use outside a tenant scope (`CREWHAUS_SESSION_DIR` or
   * `.crewhaus/sessions`). The managed target passes its per-tenant
   * `sessionRoot`s instead.
   */
  readonly sessionRootDirs?: ReadonlyArray<string>;
  /** TTL for session eviction. Default: session-store's own (30 days). */
  readonly sessionTtlDays?: number;
  /**
   * Most recent N session logs scanned per root for orphaned tool_use
   * entries. Bounds the sweep on long-lived hosts. Default 20; 0 disables
   * the orphan step entirely.
   */
  readonly orphanScanLimit?: number;
  /**
   * Logs modified within this window are presumed live (a mid-turn session
   * transiently looks orphaned) and are skipped. Default 5 minutes.
   */
  readonly orphanQuietPeriodMs?: number;
  /** Optional trace bus — one `janitor_action` event per step per run. */
  readonly bus?: TraceEventBus;
  /** Test seam: clock. */
  readonly now?: () => Date;
};

export type Janitor = {
  /** Run all steps once. Never rejects — failures land in the result. */
  runOnce(): Promise<JanitorRunResult>;
  /** Re-run `runOnce` every `intervalMs` (unref'd). `<= 0` is a no-op. */
  start(intervalMs: number): void;
  /** Cancel the interval started by `start`. Idempotent. */
  stop(): void;
};

/** Scan one session's `.jsonl` for assistant `tool_use` ids with no answering `tool_result`. */
async function countOrphanToolUses(sessionId: string, rootDir: string): Promise<number> {
  const log = await openEventLog(sessionId, { rootDir });
  const toolUseIds: string[] = [];
  const answered = new Set<string>();
  // Mirror `replayMessageHistory`: events nested inside a2a_turn_start/
  // sub_agent_start brackets belong to a peer/sub-agent transcript, not the
  // outer history — only depth-0 messages count. Orphan detection then
  // mirrors `sanitizeOrphanToolUses`: an assistant tool_use is orphaned when
  // no message anywhere carries a tool_result with its id.
  let depth = 0;
  try {
    for await (const ev of log.read()) {
      if (ev.kind === "a2a_turn_start" || ev.kind === "sub_agent_start") {
        depth += 1;
        continue;
      }
      if (ev.kind === "a2a_turn_end" || ev.kind === "sub_agent_end") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth > 0) continue;
      if (ev.kind !== "user_message" && ev.kind !== "assistant_message") continue;
      const content = (ev.payload as { content?: unknown } | null)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; id?: unknown; tool_use_id?: unknown };
        if (ev.kind === "assistant_message" && b.type === "tool_use" && typeof b.id === "string") {
          toolUseIds.push(b.id);
        }
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          answered.add(b.tool_use_id);
        }
      }
    }
  } finally {
    await log.close();
  }
  return toolUseIds.filter((id) => !answered.has(id)).length;
}

export function createJanitor(opts: CreateJanitorOptions = {}): Janitor {
  const now = opts.now ?? (() => new Date());
  // Same non-tenant fallback chain as `resolveSessionRootDir` (the janitor
  // runs at boot, outside any tenant scope; a cycle-free inline keeps this
  // module import-independent of index.ts).
  const rootDirs: ReadonlyArray<string> =
    opts.sessionRootDirs !== undefined && opts.sessionRootDirs.length > 0
      ? opts.sessionRootDirs
      : [process.env["CREWHAUS_SESSION_DIR"] ?? DEFAULT_ROOT_DIR];
  const orphanScanLimit = opts.orphanScanLimit ?? DEFAULT_ORPHAN_SCAN_LIMIT;
  const orphanQuietPeriodMs = opts.orphanQuietPeriodMs ?? DEFAULT_ORPHAN_QUIET_PERIOD_MS;

  let reservationsCleared = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let tickInFlight = false;

  function report(result: JanitorStepResult): JanitorStepResult {
    if (opts.bus !== undefined) {
      opts.bus.publish({
        ...opts.bus.envelope(now()),
        kind: "janitor_action",
        step: result.step,
        status: result.status,
        ...(result.count !== undefined ? { count: result.count } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      });
    }
    return result;
  }

  async function reservationCleanup(): Promise<JanitorStepResult> {
    const step = "reservation_cleanup" as const;
    if (opts.budgetStore === undefined) {
      return { step, status: "skipped", detail: "no budget store provided" };
    }
    if (reservationsCleared) {
      // Boot-only by design: after boot there is no way to tell a leaked
      // reservation from a live in-flight one, and re-clearing would zero
      // live reservations (see module header).
      return { step, status: "skipped", detail: "already cleared at boot" };
    }
    await opts.budgetStore.clearReservations();
    reservationsCleared = true;
    return { step, status: "ok", detail: "cleared crash-leaked reservations" };
  }

  async function sessionTtlEviction(): Promise<JanitorStepResult> {
    const step = "session_ttl_eviction" as const;
    let evicted = 0;
    for (const rootDir of rootDirs) {
      const result = await evictExpiredSessions({
        rootDir,
        ...(opts.sessionTtlDays !== undefined ? { ttlDays: opts.sessionTtlDays } : {}),
        now,
      });
      evicted += result.evictedIds.length;
    }
    return {
      step,
      status: "ok",
      count: evicted,
      detail: `evicted ${evicted} expired session(s) across ${rootDirs.length} root(s)`,
    };
  }

  async function orphanToolUseSweep(): Promise<JanitorStepResult> {
    const step = "orphan_tool_use_sweep" as const;
    if (orphanScanLimit <= 0) {
      return { step, status: "skipped", detail: "orphanScanLimit is 0" };
    }
    const cutoff = now().getTime() - orphanQuietPeriodMs;
    let scanned = 0;
    let skippedActive = 0;
    let unreadable = 0;
    let orphans = 0;
    const affected: string[] = [];
    for (const rootDir of rootDirs) {
      let entries: string[];
      try {
        entries = await readdir(rootDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      const candidates: Array<{ id: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        const match = entry.match(SESSION_LOG_REGEX);
        const id = match?.[1];
        if (id === undefined) continue;
        let mtimeMs: number;
        try {
          const st = await stat(join(rootDir, entry));
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
        if (mtimeMs > cutoff) {
          // Presumed live — a mid-turn session transiently has an
          // unanswered tool_use between the assistant append and the
          // tool_result append.
          skippedActive += 1;
          continue;
        }
        candidates.push({ id, mtimeMs });
      }
      candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { id } of candidates.slice(0, orphanScanLimit)) {
        try {
          const found = await countOrphanToolUses(id, rootDir);
          scanned += 1;
          if (found > 0) {
            orphans += found;
            affected.push(id);
          }
        } catch {
          // Malformed log — report-only sweep must not fail on it.
          unreadable += 1;
        }
      }
    }
    const detailParts = [
      `${orphans} orphaned tool_use id(s) in ${affected.length}/${scanned} scanned log(s)`,
    ];
    if (affected.length > 0) detailParts.push(`sessions: ${affected.slice(0, 5).join(", ")}`);
    if (skippedActive > 0) detailParts.push(`${skippedActive} recently-active log(s) skipped`);
    if (unreadable > 0) detailParts.push(`${unreadable} unreadable log(s) skipped`);
    detailParts.push("report-only: resume self-heals via sanitizeOrphanToolUses");
    return { step, status: "ok", count: orphans, detail: detailParts.join("; ") };
  }

  async function runStep(
    step: JanitorStepName,
    fn: () => Promise<JanitorStepResult>,
  ): Promise<JanitorStepResult> {
    try {
      return report(await fn());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return report({ step, status: "error", detail: message });
    }
  }

  async function runOnce(): Promise<JanitorRunResult> {
    const startedAt = now().toISOString();
    const t0 = performance.now();
    const steps: JanitorStepResult[] = [
      await runStep("reservation_cleanup", reservationCleanup),
      await runStep("session_ttl_eviction", sessionTtlEviction),
      await runStep("orphan_tool_use_sweep", orphanToolUseSweep),
    ];
    return { startedAt, durationMs: performance.now() - t0, steps };
  }

  return {
    runOnce,
    start(intervalMs: number): void {
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
      if (timer !== undefined) return;
      timer = setInterval(() => {
        if (tickInFlight) return;
        tickInFlight = true;
        void runOnce().finally(() => {
          tickInFlight = false;
        });
      }, intervalMs);
      // Never keep a finished process alive — the batch worker's idle-exit
      // path returns from main() with the janitor still scheduled.
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
