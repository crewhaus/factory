/**
 * The auto-distill TRIGGER: "≥ N unprocessed ratings since the last
 * distillation", plus the small watermark file that makes it idempotent.
 *
 * Extracted from `apps/cli/src/autodistill.ts` (which now re-exports it) so
 * the CLI teardown consumer and the D39 daemon janitor step share ONE
 * implementation and ONE state file: once any consumer lands a batch, the
 * others see nothing unprocessed and register nothing new.
 *
 * WHAT THE WATERMARK IS NOT: a lock. The sequence is an unsynchronized
 * read-modify-write (`readDistillState` → `distill` → `registry.put` →
 * `writeDistillState`), so two consumers that OVERLAP in the same harness
 * dir — a cron `crewhaus distill` racing a janitor tick, or two `crewhaus
 * run` teardowns in a shared checkout — can both read the same watermark and
 * both register a version. The consequence is a duplicate registry version
 * built from the same ratings (each version is a self-contained full
 * rebuild), not lost or double-counted feedback. Serialized consumers — the
 * ordinary case — never double-register.
 *
 * Watermark semantics (`.crewhaus/feedback/.distill-state.json`): one small
 * JSON record holding the ISO timestamp of the newest feedback record folded
 * into the last auto-distill. "Unprocessed" = records with a strictly greater
 * `ts`. The trigger counts only unprocessed records, but each distill re-reads
 * EVERYTHING — the registry version is always a full rebuild — so the
 * watermark only rate-limits registrations, never shapes the dataset. A failed
 * registration leaves the watermark untouched (retried next tick); a distill
 * that matched zero turns advances it (those records are unmatchable — their
 * sessions are gone — so retrying is noise).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FeedbackRecord } from "./feedback";

/** Default "≥ N unprocessed ratings" trigger (the spec's `autoDistill` is a
 *  plain boolean and carries no threshold of its own). */
export const DEFAULT_AUTODISTILL_THRESHOLD = 5;

/** Env override for the trigger threshold. */
export const AUTODISTILL_THRESHOLD_ENV = "CREWHAUS_AUTODISTILL_THRESHOLD";

/** The watermark file, relative to the harness cwd. */
export const DISTILL_STATE_RELPATH = join(".crewhaus", "feedback", ".distill-state.json");

/** The registry dataset autoDistill maintains for a spec. */
export function ratingsDatasetName(specName: string): string {
  return `${specName}-ratings`;
}

// -------- watermark state --------

export type DistillState = {
  readonly schemaVersion: 1;
  /** ISO ts of the newest feedback record folded into the last auto-distill;
   *  records with a STRICTLY greater ts count as unprocessed. */
  readonly lastProcessedTs: string;
  /** How many records the last auto-distill saw in total (informational). */
  readonly processedCount: number;
  /** The last registry version this consumer produced (informational). */
  readonly lastRegistered?: {
    readonly name: string;
    readonly version: string;
    readonly at: string;
  };
};

/** Narrow parsed JSON to a DistillState; undefined on any malformation (a
 *  corrupt watermark degrades to "everything is unprocessed", never throws). */
export function parseDistillState(text: string): DistillState | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v["schemaVersion"] !== 1) return undefined;
  if (typeof v["lastProcessedTs"] !== "string") return undefined;
  if (typeof v["processedCount"] !== "number") return undefined;
  return value as DistillState;
}

export function readDistillState(path: string): DistillState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseDistillState(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

export function writeDistillState(path: string, state: DistillState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** Records newer than the watermark (strict ISO-string comparison — the
 *  capture surfaces all stamp `new Date().toISOString()`, which compares
 *  lexicographically). No watermark → everything is unprocessed. */
export function countUnprocessed(
  records: ReadonlyArray<FeedbackRecord>,
  lastProcessedTs: string | undefined,
): number {
  if (lastProcessedTs === undefined) return records.length;
  return records.filter((r) => r.ts > lastProcessedTs).length;
}

export function newestTs(records: ReadonlyArray<FeedbackRecord>): string | undefined {
  let max: string | undefined;
  for (const r of records) {
    if (max === undefined || r.ts > max) max = r.ts;
  }
  return max;
}

// -------- trigger decision --------

export function resolveAutoDistillThreshold(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[AUTODISTILL_THRESHOLD_ENV];
  if (raw === undefined || raw === "") return DEFAULT_AUTODISTILL_THRESHOLD;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return DEFAULT_AUTODISTILL_THRESHOLD;
  return n;
}

/** The subset of the spec's `feedback:` block (IR `IrFeedback`) the trigger
 *  reads. Declared structurally so this package does not depend on
 *  `@crewhaus/ir` (and a compiled bundle can hand it a literal). */
export type AutoDistillFeedback = {
  readonly enabled?: boolean;
  readonly autoDistill?: boolean;
};

export type AutoDistillDecision = {
  readonly run: boolean;
  readonly reason: string;
};

/** Whether this tick should distill: the spec opted in
 *  (`feedback.autoDistill: true`, block not disabled) AND enough
 *  unprocessed ratings accumulated. */
export function shouldAutoDistill(opts: {
  readonly feedback: AutoDistillFeedback | undefined;
  readonly unprocessed: number;
  readonly threshold: number;
}): AutoDistillDecision {
  if (opts.feedback === undefined) {
    return { run: false, reason: "spec has no feedback block" };
  }
  if (opts.feedback.enabled === false) {
    return { run: false, reason: "feedback block is disabled (enabled: false)" };
  }
  if (opts.feedback.autoDistill !== true) {
    return { run: false, reason: "feedback.autoDistill is not enabled" };
  }
  if (opts.unprocessed < opts.threshold) {
    return {
      run: false,
      reason: `${opts.unprocessed} unprocessed rating(s) < threshold ${opts.threshold}`,
    };
  }
  return {
    run: true,
    reason: `${opts.unprocessed} unprocessed rating(s) ≥ threshold ${opts.threshold}`,
  };
}
