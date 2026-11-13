/**
 * The accessibility report: its format, and the summary a CI step shows. The
 * gate (`gate.ts`) reads this format: every row must be empty. There is no
 * committed baseline: every route the console serves is in the gate.
 */

export type AxeReport = {
  readonly schema: 1;
  readonly axe: string;
  readonly tags: readonly string[];
  /** `template|theme|width` to rule id to node count. */
  readonly rows: Readonly<Record<string, Readonly<Record<string, number>>>>;
};

export const rowKey = (template: string, theme: string, width: number): string =>
  `${template}|${theme}|${width}`;

/** Put a report's keys in order, so its text changes only when its content does. */
export function sortReport(report: AxeReport): AxeReport {
  const rows: Record<string, Record<string, number>> = {};
  for (const key of Object.keys(report.rows).sort()) {
    const row = report.rows[key] ?? {};
    rows[key] = Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((rule) => [rule, row[rule] as number]),
    );
  }
  return { schema: report.schema, axe: report.axe, tags: report.tags, rows };
}

/** Node totals by rule across a report's rows. */
export function reportTotals(report: AxeReport): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const row of Object.values(report.rows)) {
    for (const [rule, count] of Object.entries(row)) totals[rule] = (totals[rule] ?? 0) + count;
  }
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** What the gate found, for the summary's heading. */
export type GateSummary = {
  readonly gated: number;
  readonly failures: number;
  readonly missing: number;
};

/** The gate's result as markdown, for a CI step summary. */
export function gateMarkdown(report: AxeReport, gate: GateSummary): string {
  const totals = Object.entries(reportTotals(report))
    .map(([rule, count]) => `\`${rule}\` ${count}`)
    .join(", ");
  const verdict =
    gate.failures === 0 && gate.missing === 0
      ? `**Gate passed:** ${gate.gated} routes have no violation in either theme at either width.\n\n`
      : `**Gate failed:** ${gate.failures} violation(s) and ${gate.missing} missing row(s) across the ${gate.gated} routes.\n\n`;
  return [
    "## Accessibility gate\n",
    verdict,
    `${Object.keys(report.rows).length} rows. Nodes by rule: ${totals === "" ? "none" : totals}.\n`,
  ].join("");
}
