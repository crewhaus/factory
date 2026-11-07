/**
 * Recording a `crewhaus datasets release`.
 *
 * A release entry says "this version's test split was evaluated, and this is
 * what it scored". A run that measured nothing cannot say that, so it is refused
 * for the same reasons a baseline pin is. The refusal is an answer, not a rollback:
 * the run did read the split, and the caller says so.
 */
import { type DatasetRecord, appendReleaseEntry } from "@crewhaus/dataset-registry";
import { type RunIndexEntry, pinRefusal } from "@crewhaus/eval-report";

export type RecordReleaseOutcome =
  | { readonly ok: true; readonly record: DatasetRecord }
  | { readonly ok: false; readonly reason: string };

export function recordRelease(opts: {
  readonly entry: RunIndexEntry;
  readonly rootDir: string;
  readonly name: string;
  readonly version: string;
}): RecordReleaseOutcome {
  const { entry, rootDir, name, version } = opts;
  const refusal = pinRefusal(entry);
  if (refusal !== undefined) return { ok: false, reason: refusal.reason };
  return {
    ok: true,
    record: appendReleaseEntry({
      rootDir,
      name,
      version,
      entry: { version, runId: entry.runId, ts: entry.ts, passRate: entry.passRate },
    }),
  };
}
