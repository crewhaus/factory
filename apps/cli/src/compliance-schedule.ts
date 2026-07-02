/**
 * Item 34 — scheduling ergonomics for `crewhaus compliance evidence`,
 * factored out of the entry file `index.ts` (which runs a top-level argv
 * switch and so cannot be imported by a test without executing the CLI).
 * Side-effect-free and directly unit-testable, mirroring `scope-audit.ts` /
 * `audit-verify.ts`.
 *
 * A cron job cannot hardcode `--period 2026-Q3` — it would silently collect
 * the wrong quarter after a boundary. `--period current` resolves the
 * current quarter from the clock in the same `YYYY-QN` label format the
 * command already accepts (see `runCompliance`'s usage example), using UTC
 * to match the audit log's UTC day rotation.
 */

/** `YYYY-QN` label for the quarter containing `date`, in UTC. */
export function currentQuarterPeriod(date: Date): string {
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}`;
}

/**
 * Resolve the raw `--period` flag value: the literal `current` becomes the
 * clock's current quarter; any other label passes through verbatim (the
 * collector's `writeBundle` still path-validates it downstream).
 */
export function resolvePeriodFlag(value: string, now: () => Date = () => new Date()): string {
  return value === "current" ? currentQuarterPeriod(now()) : value;
}

/** The slice of an EvidenceBundle the empty-evidence gate needs. */
export type BundleCount = {
  readonly frameworkId: string;
  readonly controlId: string;
  readonly recordCount: number;
};

/**
 * `framework/control` ids of every collected bundle with zero records — the
 * evidence gaps that fail a scheduled run (a control that collected nothing
 * is a control an auditor cannot be shown; exiting 0 would hide that until
 * audit time). Order-preserving so the failure message mirrors collection
 * order.
 */
export function findEmptyControls(bundles: ReadonlyArray<BundleCount>): ReadonlyArray<string> {
  return bundles.filter((b) => b.recordCount === 0).map((b) => `${b.frameworkId}/${b.controlId}`);
}
