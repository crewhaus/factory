/**
 * Item 1 — the `feedback.autoDistill` consumer + the REPL exit-rating
 * gating logic. Gives the parsed-but-inert spec flag its first reader:
 *
 *   - **autoDistill**: at CLI `run` teardown (NOT a spawned hook — hooks
 *     run credential-stripped), when the accumulated feedback store holds
 *     ≥ N unprocessed `user_feedback` records, the existing `distill()`
 *     runs over ALL sessions — always PII/secret-redacted (B23: the
 *     teardown is unattended, so there is no opt-out) — and the result is
 *     registered as a new
 *     auto-bumped version of the `<specName>-ratings` registry dataset —
 *     immediately consumable as `--dataset registry:<specName>-ratings`
 *     (the item-12 shorthand `eval`/`optimize` already speak). The spec's
 *     `autoDistill` is a plain boolean, so the threshold defaults to
 *     {@link DEFAULT_AUTODISTILL_THRESHOLD} (env-tunable via
 *     `CREWHAUS_AUTODISTILL_THRESHOLD`).
 *
 *   - **Watermark** (`.crewhaus/feedback/.distill-state.json`): one small
 *     JSON file holding the ISO timestamp of the newest feedback record
 *     folded into the last auto-distill. "Unprocessed" = records with a
 *     strictly greater `ts`. The trigger counts only unprocessed records,
 *     but each distill re-reads EVERYTHING — the registry version is always
 *     a full rebuild (merge semantics live in `mergeFeedback`), so the
 *     watermark only rate-limits registrations, never shapes the dataset.
 *     A failed registration leaves the watermark untouched (retried next
 *     run); a distill that matched zero turns advances it (those records
 *     are unmatchable — their sessions are gone — so retrying is noise).
 *
 * The block's OTHER consumer — the one-keystroke `rate this session? [g]ood /
 * [b]ad / [enter] skip` prompt at clean REPL exit — moved to
 * @crewhaus/runtime-core (`exit-rating.ts`) so a COMPILED bundle asks it too;
 * see the note at the bottom of this file.
 *
 * Kept in a module with no import-time side effects (the CLI entry file
 * runs an argv switch on import), mirroring `eval-history.ts` /
 * `datasets.ts`. Filesystem access is limited to the watermark file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatasetRegistry } from "@crewhaus/dataset-registry";
import type { DatasetRecord } from "@crewhaus/dataset-registry";
import type { IrFeedback } from "@crewhaus/ir";
import { redactDatasetText } from "./dataset-audit";
import { DEFAULT_SPLIT_SPEC, registerDataset } from "./datasets";
import { type FeedbackRecord, type SessionTurn, distill } from "./feedback";
import { isRegistrySafeName } from "./regression-pin";

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

export type AutoDistillDecision = {
  readonly run: boolean;
  readonly reason: string;
};

/** Whether the teardown should distill: the spec opted in
 *  (`feedback.autoDistill: true`, block not disabled) AND enough
 *  unprocessed ratings accumulated. */
export function shouldAutoDistill(opts: {
  readonly feedback: IrFeedback | undefined;
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

// -------- the consumer --------

export type MaybeAutoDistillOptions = {
  readonly specName: string;
  readonly feedback: IrFeedback | undefined;
  /** All sessions' turns (tagged with the sessionId join key). */
  readonly turns: ReadonlyArray<SessionTurn>;
  /** The accumulated store: in-transcript `user_feedback` records plus the
   *  web-UI `.crewhaus/feedback/*.jsonl` records. */
  readonly records: ReadonlyArray<FeedbackRecord>;
  readonly registry: DatasetRegistry;
  /** Watermark file path (see {@link DISTILL_STATE_RELPATH}). */
  readonly stateFilePath: string;
  /** Env for the threshold/opt-outs; defaults to process.env. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Positive-sample cutoff forwarded to distill(); default 0.7 (matches
   *  `crewhaus distill --min-score`). */
  readonly minScore?: number;
  readonly now?: () => Date;
  /** Line sink; defaults to stdout. */
  readonly write?: (line: string) => void;
};

export type MaybeAutoDistillResult = {
  readonly ran: boolean;
  readonly reason: string;
  readonly registered?: { readonly name: string; readonly version: string };
};

/**
 * The teardown consumer. One printed line per outcome that did anything;
 * silent when the trigger simply hasn't accumulated yet. Best-effort by
 * contract — the CALLER wraps it so a failure can never turn a successful
 * session into a non-zero exit.
 */
export async function maybeAutoDistill(
  opts: MaybeAutoDistillOptions,
): Promise<MaybeAutoDistillResult> {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const env = opts.env ?? process.env;
  const threshold = resolveAutoDistillThreshold(env);
  const state = readDistillState(opts.stateFilePath);
  const unprocessed = countUnprocessed(opts.records, state?.lastProcessedTs);
  const decision = shouldAutoDistill({ feedback: opts.feedback, unprocessed, threshold });
  if (!decision.run) return { ran: false, reason: decision.reason };

  const name = ratingsDatasetName(opts.specName);
  if (!isRegistrySafeName(name)) {
    write(
      `[feedback] auto-distill skipped: spec name "${opts.specName}" can't form a registry dataset name ("${name}")`,
    );
    return { ran: false, reason: "spec name is not registry-safe" };
  }

  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const watermark = newestTs(opts.records) ?? nowIso;

  // Full rebuild over EVERYTHING (see the module doc): merge semantics stay
  // in mergeFeedback, and each registered version is self-contained. B23 —
  // this consumer runs unattended at teardown, so it ALWAYS redacts (there
  // is no --no-redact here): raw turn text and corrections must never land
  // in the auto-registered ratings dataset.
  const result = distill(opts.turns, opts.records, {
    minScore: opts.minScore ?? 0.7,
    redact: redactDatasetText,
  });
  if (result.samples.length === 0) {
    // The ratings exist but none joined to a transcript turn (sessions
    // purged/rotated). Advance the watermark so the same unmatchable
    // records don't re-trigger a doomed distill on every run.
    writeDistillState(opts.stateFilePath, {
      schemaVersion: 1,
      lastProcessedTs: watermark,
      processedCount: opts.records.length,
      ...(state?.lastRegistered !== undefined ? { lastRegistered: state.lastRegistered } : {}),
    });
    write(
      "[feedback] auto-distill: no rated turn matched a transcript — nothing registered (watermark advanced)",
    );
    return { ran: false, reason: "no rated turns matched the transcripts" };
  }

  // Register FIRST, advance the watermark only on success — a transient
  // registry failure retries on the next teardown instead of losing the
  // trigger.
  let record: DatasetRecord;
  try {
    record = await registerDataset({
      registry: opts.registry,
      name,
      samples: result.samples,
      splitSpec: DEFAULT_SPLIT_SPEC,
    });
  } catch (err) {
    write(
      `[feedback] auto-distill failed to register ${name}: ${err instanceof Error ? err.message : String(err)} (will retry next run)`,
    );
    return { ran: false, reason: "registry put failed" };
  }
  writeDistillState(opts.stateFilePath, {
    schemaVersion: 1,
    lastProcessedTs: watermark,
    processedCount: opts.records.length,
    lastRegistered: { name: record.name, version: record.version, at: nowIso },
  });
  write(
    `[feedback] auto-distilled ${result.stats.matchedTurns} rating(s) → registry:${record.name}@${record.version} ` +
      `(train ${record.splits.train.length} / dev ${record.splits.dev.length} / test ${record.splits.test?.length ?? 0})`,
  );
  return {
    ran: true,
    reason: decision.reason,
    registered: { name: record.name, version: record.version },
  };
}

// -------- REPL exit rating prompt --------
//
// MOVED to @crewhaus/runtime-core (`src/exit-rating.ts`). The prompt used to
// be gated + read here and driven from the CLI's post-session teardown, which
// is exactly why a COMPILED cli bundle had no rating capture: the cli emitter
// dropped the `feedback:` block and only `crewhaus run` implemented it. The
// prompt belongs to the REPL, and the REPL is `runChatLoop`, so both surfaces
// now reach it by threading `feedback` into the loop. The opt-out env is
// re-exported below so this module's autoDistill docs stay self-contained.
export { NO_EXIT_RATING_ENV } from "@crewhaus/runtime-core";
