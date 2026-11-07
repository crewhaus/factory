/**
 * The report-only accessibility baseline: its format, its diff, and its checks.
 * A later gate reads this exact format.
 */
import { AXE_TAGS } from "./axe";

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

/** Why a baseline's text is not one, or nothing when it is. */
export function baselineProblems(text: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return ["it is not JSON"];
  }
  if (parsed === null || typeof parsed !== "object") return ["it is not an object"];
  const report = parsed as Partial<AxeReport>;
  const problems: string[] = [];
  if (report.schema !== 1) problems.push(`schema is ${String(report.schema)}, not 1`);
  if (typeof report.axe !== "string" || report.axe === "") problems.push("axe names no version");
  if (JSON.stringify(report.tags) !== JSON.stringify(AXE_TAGS)) {
    problems.push(`tags are ${JSON.stringify(report.tags)}, not the known set`);
  }
  const rows = report.rows;
  if (rows === undefined || rows === null || typeof rows !== "object") {
    problems.push("rows is not an object");
    return problems;
  }
  const keys = Object.keys(rows);
  if (keys.length === 0) problems.push("rows is empty");
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    problems.push("rows are not sorted");
  }
  for (const key of keys) {
    if (key.split("|").length !== 3) problems.push(`row ${key} is not template|theme|width`);
    const row = rows[key] as unknown;
    if (row === null || typeof row !== "object") {
      problems.push(`row ${key} is not an object`);
      continue;
    }
    const rules = Object.keys(row);
    if (JSON.stringify(rules) !== JSON.stringify([...rules].sort())) {
      problems.push(`row ${key}'s rules are not sorted`);
    }
    for (const rule of rules) {
      const count = (row as Record<string, unknown>)[rule];
      if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) {
        problems.push(`row ${key} counts ${rule} as ${String(count)}`);
      }
    }
  }
  return problems;
}

export type BaselineDiff = {
  /** A row, or a rule in a row, the baseline does not hold. */
  readonly new: readonly string[];
  readonly increased: readonly string[];
  readonly decreased: readonly string[];
  /** A row, or a rule in a row, the report no longer holds. */
  readonly gone: readonly string[];
};

/** Compare a report with the baseline. Report only: nothing here is ever fatal. */
export function diffAgainstBaseline(baseline: AxeReport, report: AxeReport): BaselineDiff {
  const diff = {
    new: [] as string[],
    increased: [] as string[],
    decreased: [] as string[],
    gone: [] as string[],
  };
  for (const key of Object.keys(report.rows).sort()) {
    const was = baseline.rows[key];
    const now = report.rows[key] ?? {};
    if (was === undefined) {
      diff.new.push(`row ${key}`);
      continue;
    }
    for (const rule of Object.keys(now).sort()) {
      const before = was[rule];
      const after = now[rule] as number;
      if (before === undefined) diff.new.push(`${key}: ${rule} (${after})`);
      else if (after > before) diff.increased.push(`${key}: ${rule} ${before} to ${after}`);
      else if (after < before) diff.decreased.push(`${key}: ${rule} ${before} to ${after}`);
    }
    for (const rule of Object.keys(was).sort()) {
      if (now[rule] === undefined) diff.gone.push(`${key}: ${rule} (${was[rule]})`);
    }
  }
  for (const key of Object.keys(baseline.rows).sort()) {
    if (report.rows[key] === undefined) diff.gone.push(`row ${key}`);
  }
  return diff;
}

/** Node totals by rule across a report's rows. */
export function reportTotals(report: AxeReport): Readonly<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const row of Object.values(report.rows)) {
    for (const [rule, count] of Object.entries(row)) totals[rule] = (totals[rule] ?? 0) + count;
  }
  return Object.fromEntries(Object.entries(totals).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The diff as markdown, for a CI step summary. */
export function diffMarkdown(diff: BaselineDiff, report: AxeReport): string {
  const section = (title: string, lines: readonly string[]): string =>
    lines.length === 0
      ? ""
      : `\n**${title} (${lines.length})**\n\n${lines.map((line) => `- \`${line}\``).join("\n")}\n`;
  const totals = Object.entries(reportTotals(report))
    .map(([rule, count]) => `\`${rule}\` ${count}`)
    .join(", ");
  return [
    "## Accessibility report (never fails the build)\n",
    `${Object.keys(report.rows).length} rows. Nodes by rule: ${totals === "" ? "none" : totals}.\n`,
    section("New against the baseline", diff.new),
    section("Increased", diff.increased),
    section("Decreased", diff.decreased),
    section("No longer found", diff.gone),
  ].join("");
}
