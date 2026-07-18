/**
 * Loop contract 0.4 (Batch F, temporal contract / G61 exactly-once half) —
 * a DURABLE {@link IdempotencyStore} plus the env-driven factory the emitted
 * graph / workflow bundles select their store with.
 *
 * `withIdempotency` (see `./index`) dedups a node/step by (runId, name,
 * attempt), but its default {@link InMemoryIdempotencyStore} evaporates when
 * the process exits — so it only guards against in-process double-invocation.
 * For crash-resume exactly-once the record has to OUTLIVE the process: a
 * restart re-executing the same run must find the prior attempt's cached
 * result. {@link FileIdempotencyStore} persists one JSON file per key under a
 * spec-scoped directory so a `bun agent.ts` restart (same runId) skips
 * already-completed work instead of re-running its side effects.
 *
 * This is best-effort exactly-once, not transactional: a crash in the window
 * between a node's external side effect and the store write still re-runs on
 * resume (at-least-once). The durable record strictly TIGHTENS the guarantee
 * over the in-memory default; it cannot make a non-transactional external
 * effect perfectly exactly-once.
 *
 * Selection mirrors the channel daemon's `CREWHAUS_DEDUP_STORE` convention:
 *   - `memory` (default) — in-memory, no cross-restart resume.
 *   - `file:<dir>` / `file` — durable JSON records under
 *     `<dir>/<spec>/` (default dir `.crewhaus/idempotency`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type IdempotencyKey,
  type IdempotencyRecord,
  type IdempotencyStore,
  InMemoryIdempotencyStore,
} from "./index";

function safeSegment(spec: string): string {
  const cleaned = spec.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned.length > 0 ? cleaned : "spec";
}

/**
 * A filesystem-backed idempotency store: one `<key>.json` per record under
 * `dir`. `get` fails safe (a missing/corrupt file reads as "no record", so a
 * torn write re-runs rather than throwing); `put` is a single atomic-enough
 * `writeFileSync`.
 */
export class FileIdempotencyStore implements IdempotencyStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  private pathFor(key: IdempotencyKey): string {
    return join(this.dir, `${key}.json`);
  }
  async get(key: IdempotencyKey): Promise<IdempotencyRecord | undefined> {
    const p = this.pathFor(key);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf-8")) as IdempotencyRecord;
    } catch {
      return undefined;
    }
  }
  async put(record: IdempotencyRecord): Promise<void> {
    writeFileSync(this.pathFor(record.key), JSON.stringify(record));
  }
}

const DEFAULT_IDEMPOTENCY_DIR = join(".crewhaus", "idempotency");

/**
 * Build the idempotency store the bundle's durable-execution wrapping uses,
 * from `env.CREWHAUS_IDEMPOTENCY_STORE`. Records are namespaced by `spec` so
 * two shapes sharing a working directory never collide. Throws on an
 * unrecognised value so a typo fails loudly at boot rather than silently
 * degrading exactly-once to in-memory.
 */
export function createIdempotencyStore(
  spec: string,
  env: Record<string, string | undefined> = process.env,
): IdempotencyStore {
  const raw = env["CREWHAUS_IDEMPOTENCY_STORE"] ?? "memory";
  if (raw === "memory") return new InMemoryIdempotencyStore();
  if (raw === "file") {
    return new FileIdempotencyStore(join(DEFAULT_IDEMPOTENCY_DIR, safeSegment(spec)));
  }
  if (raw.startsWith("file:")) {
    const base = raw.slice("file:".length);
    const dir = base.length > 0 ? base : DEFAULT_IDEMPOTENCY_DIR;
    return new FileIdempotencyStore(join(dir, safeSegment(spec)));
  }
  throw new Error(
    `[durable-execution] unknown CREWHAUS_IDEMPOTENCY_STORE "${raw}" — use "memory" (default) or "file:<dir>".`,
  );
}
