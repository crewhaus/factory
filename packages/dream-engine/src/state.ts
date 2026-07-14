/**
 * Dream schedule state + window idempotency (v0.3.0 design §6.2).
 *
 * State lives at `.crewhaus/dream/<spec>/state.json` — proof the dream
 * actually ran: when, with what outcome, what the deterministic phase
 * counted, and which toolUseIds the model phase left as evidence.
 *
 * Mutual exclusion is TWO mechanisms, deliberately layered:
 *
 *   1. a `run.lock` advisory file lock (the §7.6 policy via infra-utils)
 *      serializes concurrent runs in-flight — a janitor tick, a GH-Actions
 *      cron, and a `crewhaus dream` invocation cannot execute at once;
 *   2. a WINDOW idempotency key — `dream:<spec>:<floor(now/everyMs)>`
 *      through durable-execution's `withIdempotency`, backed by the small
 *      file store below — makes the second arrival in a window a cached
 *      no-op rather than a queued re-run, so double-fire is impossible even
 *      across process restarts (including under `fleet run` parallelism —
 *      the store's read-modify-write holds the shared infra-utils lock).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IdempotencyRecord, IdempotencyStore } from "@crewhaus/durable-execution";
import { CrewhausError } from "@crewhaus/errors";
import { withFileLock } from "@crewhaus/infra-utils";
import type { DreamPhase1Counts } from "./phase1";

/** How a dream run ended. `deterministic`/`full` are the success outcomes
 *  that consume the schedule window; a refusal consumes it too (the pricing
 *  table is fixed for the process lifetime — retrying cannot succeed), while
 *  `model_failed` (a transient provider error) deliberately does NOT, so the
 *  next tick retries. */
export type DreamOutcome = "deterministic" | "full" | "model_refused_unpriced" | "model_failed";

/** The `.crewhaus/dream/<spec>/state.json` record (design §6.2). */
export type DreamState = {
  readonly schemaVersion: 1;
  /** ISO start time of the last attempted run. */
  readonly lastRunAt: string;
  readonly lastOutcome: DreamOutcome;
  readonly phase1Counts: DreamPhase1Counts;
  /** Successful toolUseIds from the last model phase (empty otherwise). */
  readonly lastEvidence: readonly string[];
};

export const DREAM_STATE_FILENAME = "state.json";
export const DREAM_IDEMPOTENCY_FILENAME = "idempotency.json";

export class DreamStateError extends CrewhausError {
  override readonly name = "DreamStateError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/** The consolidation window this instant falls into. Fixed epoch-anchored
 *  flooring: every process on every host computes the same window for the
 *  same clock, which is what makes the idempotency key collision-exact. */
export function dreamWindowIndex(nowMs: number, everyMs: number): number {
  return Math.floor(nowMs / everyMs);
}

/** `dream:<spec>:<windowIndex>` — the idempotency graph-run id (§6.2). */
export function dreamWindowKey(specName: string, nowMs: number, everyMs: number): string {
  return `dream:${specName}:${dreamWindowIndex(nowMs, everyMs)}`;
}

export async function readDreamState(dreamDir: string): Promise<DreamState | null> {
  const path = join(dreamDir, DREAM_STATE_FILENAME);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new DreamStateError(`dream-engine: cannot read ${path}`, err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A torn state file (crashed writer pre-rename never produces this, but
    // a hand-edit can): treat as never-ran rather than wedging the schedule.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const s = parsed as Record<string, unknown>;
  if (typeof s["lastRunAt"] !== "string" || typeof s["lastOutcome"] !== "string") return null;
  return parsed as DreamState;
}

/** tmp+rename atomic — a reader never observes a torn state.json. */
export async function writeDreamState(dreamDir: string, state: DreamState): Promise<void> {
  const path = join(dreamDir, DREAM_STATE_FILENAME);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, path);
}

type IdempotencyFileShape = {
  version: 1;
  records: Record<string, IdempotencyRecord>;
};

/** Keep the file small: prune to the most recent N records by completedAt. */
const DEFAULT_MAX_IDEMPOTENCY_RECORDS = 24;

/**
 * A small durable `IdempotencyStore` over one JSON file (next to
 * state.json), for durable-execution's `withIdempotency`. Writes hold the
 * §7.6 advisory lock from infra-utils and land tmp+rename atomic, so
 * parallel writers (fleet run, janitor + cron) never tear the file; reads
 * are lock-free (they only ever see a fully-renamed file).
 */
export function createFileIdempotencyStore(
  path: string,
  opts: { readonly maxRecords?: number } = {},
): IdempotencyStore {
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_IDEMPOTENCY_RECORDS;

  async function readAll(): Promise<IdempotencyFileShape> {
    if (!existsSync(path)) return { version: 1, records: {} };
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && "records" in parsed) {
        return parsed as IdempotencyFileShape;
      }
    } catch {
      // Unreadable → treated as empty; the next put rewrites it whole.
    }
    return { version: 1, records: {} };
  }

  return {
    async get(key) {
      const all = await readAll();
      return all.records[key];
    },
    async put(record) {
      await withFileLock(
        `${path}.lock`,
        async () => {
          const all = await readAll();
          all.records[record.key] = record;
          const entries = Object.entries(all.records).sort(([, a], [, b]) =>
            b.completedAt.localeCompare(a.completedAt),
          );
          const pruned = Object.fromEntries(entries.slice(0, maxRecords));
          await mkdir(dirname(path), { recursive: true });
          const tmpPath = `${path}.tmp`;
          await writeFile(tmpPath, `${JSON.stringify({ version: 1, records: pruned })}\n`, {
            mode: 0o600,
          });
          await rename(tmpPath, path);
        },
        {
          label: "dream-engine",
          createError: (message) => new DreamStateError(message),
        },
      );
    },
  };
}
