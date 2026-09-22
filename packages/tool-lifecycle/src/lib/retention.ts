/**
 * Reading a retention selection well enough to refuse it.
 *
 * `@crewhaus/harness-lifecycle` decides WHAT a sweep or purge deletes: the
 * age rule, the pins, the audit windows, the audit-chain exclusion. None of
 * that is re-decided here. What this module adds is the question the package
 * does not answer — is this selection plausibly what the operator meant? —
 * and the two shapes of "no" that matter:
 *
 *   1. THE RULE SELECTED EVERYTHING. A window that expires every session in
 *      the store is either a deliberate wipe or a misconfiguration, and the
 *      two are indistinguishable from inside the rule. It has to be said out
 *      loud before the delete, not discovered after it.
 *   2. A TIMESTAMP IS NOT A DATE. A session whose mtime is at or near epoch
 *      zero is a broken clock, a failed copy or a restored archive — not data
 *      from 1970. Age rules read it as infinitely old and delete it first.
 *      There is deliberately no flag to wave this through: the fix is to
 *      repair or pin the record, not to confirm a number nobody believes.
 *
 * The selection itself comes from running the package's OWN dry run, so the
 * set being judged here is the set the real call will act on, produced by the
 * same code — not a preview re-derived beside it.
 */
import type { RetentionEnforcementReport } from "@crewhaus/harness-lifecycle";

/**
 * Timestamps at or below this are treated as broken rather than old:
 * 1971-01-01T00:00:00Z. A real harness session at or before that is not a
 * thing; a zeroed or truncated mtime lands here every time.
 *
 * The comparison is inclusive because every sentence describing this rule —
 * the tool's description, the refusal it prints — says "at or before", and a
 * boundary that the prose and the code disagree about is a boundary nobody
 * can reason about. Exactly `EPOCH_SANITY_MS` is a fabricated number, not
 * data from the first instant of 1971.
 */
export const EPOCH_SANITY_MS = Date.UTC(1971, 0, 1);

/** The shape of an inventory entry this module needs, structurally. */
export type InventorySession = {
  readonly sessionId: string;
  readonly record: { readonly id: string; readonly createdAt: number };
};

export type SelectedRecord = {
  readonly id: string;
  readonly createdAtMs: number;
  readonly paths: ReadonlyArray<string>;
};

export type Selection = {
  readonly records: ReadonlyArray<SelectedRecord>;
  readonly count: number;
  readonly oldestMs?: number;
  readonly newestMs?: number;
  /** Selected records whose timestamp is at or below {@link EPOCH_SANITY_MS}. */
  readonly epochZero: ReadonlyArray<SelectedRecord>;
  /**
   * Selected ids that were not in the inventory snapshot, so their age could
   * not be read. Not an empty set of timestamps — an unknown one.
   */
  readonly unknownTimestamp: ReadonlyArray<string>;
  readonly sessionsInStore: number;
};

/**
 * Join the package's deletion list to the inventory snapshot, so the caller
 * can be told not just HOW MANY records would go but how old the oldest and
 * newest of them are — the two numbers that make a misconfigured window
 * visible before it runs.
 */
export function summarizeSelection(
  report: RetentionEnforcementReport,
  sessions: ReadonlyArray<InventorySession>,
): Selection {
  const byId = new Map<string, InventorySession>();
  for (const s of sessions) byId.set(s.record.id, s);
  const records: SelectedRecord[] = [];
  const unknownTimestamp: string[] = [];
  for (const deletion of report.deleted) {
    const entry = byId.get(deletion.id);
    if (entry === undefined) {
      // The enforcement pass named a record the snapshot does not have. That
      // is a real divergence (a racing writer, a store that changed shape),
      // and it is reported rather than silently treated as age-zero.
      unknownTimestamp.push(deletion.id);
      continue;
    }
    records.push({ id: deletion.id, createdAtMs: entry.record.createdAt, paths: deletion.paths });
  }
  const times = records.map((r) => r.createdAtMs);
  return {
    records,
    count: report.deleted.length,
    ...(times.length > 0 ? { oldestMs: Math.min(...times), newestMs: Math.max(...times) } : {}),
    epochZero: records.filter((r) => r.createdAtMs <= EPOCH_SANITY_MS),
    unknownTimestamp,
    sessionsInStore: sessions.length,
  };
}

export type BreadthOptions = {
  readonly allowDeleteAll: boolean;
  readonly maxDeletions?: number;
  /** The parsed `before` cutoff, epoch ms, for a purge. */
  readonly cutoffMs?: number;
  readonly nowMs: number;
};

export type BreadthRefusal = { readonly code: "refused"; readonly reason: string };

/**
 * The refusals that keep a plausible-looking rule from taking the whole
 * store. Order matters: the broken-timestamp refusal comes first because it
 * explains WHY a rule that looks narrow selected everything.
 */
export function breadthRefusal(
  selection: Selection,
  opts: BreadthOptions,
): BreadthRefusal | undefined {
  if (selection.epochZero.length > 0) {
    const shown = selection.epochZero
      .slice(0, 5)
      .map((r) => `${r.id} (${new Date(r.createdAtMs).toISOString()})`)
      .join(", ");
    return {
      code: "refused",
      reason: `refusing to delete on an age rule while ${selection.epochZero.length} selected record(s) carry a timestamp at or before ${new Date(EPOCH_SANITY_MS).toISOString()}: ${shown}. A timestamp that low is a broken clock or a failed copy, not data that old, and every age rule reads it as infinitely old. Repair the timestamps, or pin those sessions in .crewhaus/retention.json, and run again. There is no flag to override this.`,
    };
  }
  if (selection.unknownTimestamp.length > 0) {
    return {
      code: "refused",
      reason: `refusing: ${selection.unknownTimestamp.length} selected record(s) were not in the inventory snapshot, so their age could not be read (${selection.unknownTimestamp.slice(0, 5).join(", ")}). Something is writing to the store during the sweep; re-run when it is quiet.`,
    };
  }
  if (
    opts.cutoffMs !== undefined &&
    opts.cutoffMs > opts.nowMs &&
    selection.count > 0 &&
    !opts.allowDeleteAll
  ) {
    return {
      code: "refused",
      reason: `refusing: the purge cutoff ${new Date(opts.cutoffMs).toISOString()} is in the future, so "older than the cutoff" means every record in the store that its retention window allows. Pass a past cutoff, or set allowDeleteAll to confirm.`,
    };
  }
  if (opts.maxDeletions !== undefined && selection.count > opts.maxDeletions) {
    return {
      code: "refused",
      reason: `refusing: the selection is ${selection.count} record(s), over the maxDeletions limit of ${opts.maxDeletions} this call set.`,
    };
  }
  if (
    !opts.allowDeleteAll &&
    selection.count > 0 &&
    selection.sessionsInStore > 0 &&
    selection.count === selection.sessionsInStore
  ) {
    const window =
      selection.oldestMs !== undefined && selection.newestMs !== undefined
        ? ` (oldest ${new Date(selection.oldestMs).toISOString()}, newest ${new Date(selection.newestMs).toISOString()})`
        : "";
    return {
      code: "refused",
      reason: `refusing: the age rule selects EVERY session in the store — ${selection.count} of ${selection.sessionsInStore}${window}. That is either a deliberate wipe or a misconfigured window, and this tool will not guess which. Set allowDeleteAll to confirm it is the former.`,
    };
  }
  return undefined;
}
