/**
 * B17 + B21 — dataset lifecycle read-side: the `crewhaus datasets status`
 * freshness/saturation report and the `crewhaus datasets card` markdown
 * datasheet. Side-effect-free (run-history entries + per-run outcomes are
 * injected) mirroring `datasets.ts`; the CLI face in `index.ts` wires
 * `readRunIndex`/`loadRun` and stdout.
 *
 * Freshness join (B17): a run-index entry belongs to `<name>@<version>` when
 * its recorded datasetName is exactly that, continues with `#<split>` (a
 * split-pinned run), or continues with `+` (the regression-union suffix) —
 * the same continuation grammar `datasetFilterMatches` uses. Saturation: a
 * sample id that appeared in ≥ 2 of the dataset's last N runs and passed
 * every time is "always-passing" — a candidate for rotation (it no longer
 * discriminates).
 */
import type { DatasetRecord, ReleaseEntry } from "@crewhaus/dataset-registry";
import type { LintFinding } from "./dataset-lint";
import { overallDatasetHash, splitsPresent } from "./datasets";

/** The slice of a run-index entry status/card consume (structural, so tests
 *  don't build full RunIndexEntry objects). */
export type StatusRunEntry = {
  readonly runId: string;
  readonly datasetName: string;
  readonly datasetHash: string;
  readonly ts: string;
  readonly outDir: string;
  readonly passRate: number;
};

/** Per-sample pass/fail outcome of one historical run (from results.json). */
export type RunSampleOutcome = {
  readonly sampleId: string;
  readonly passed: boolean;
};

/** Does this run-index datasetName belong to `<name>@<version>`? Exact, or
 *  continued by `#<split>` (split-pinned) / `+` (regression union). */
export function entryMatchesVersion(name: string, version: string, datasetName: string): boolean {
  const base = `${name}@${version}`;
  return (
    datasetName === base || datasetName.startsWith(`${base}#`) || datasetName.startsWith(`${base}+`)
  );
}

export type VersionStatus = {
  readonly version: string;
  readonly createdAt: string;
  /** Whole days since createdAt (floored, never negative). */
  readonly ageDays: number;
  readonly train: number;
  readonly dev: number;
  /** Absent when the version has no test split. */
  readonly test?: number;
  /** Run-history entries joined to this version (any split). */
  readonly runCount: number;
  /** ISO ts of the newest joined run, when any. */
  readonly lastRunTs?: string;
  /** Joined runs that consumed the locked `#test` split. */
  readonly testRunCount: number;
  /** NEW-HUNT-9 — sanctioned releases recorded on the record. */
  readonly releaseCount: number;
};

export type SaturationReport = {
  /** How many recent runs the pass/fail join actually loaded. */
  readonly runsConsidered: number;
  /** Sample ids that appeared in ≥ 2 considered runs and passed every
   *  time — saturated: they no longer discriminate. Sorted. */
  readonly alwaysPassing: ReadonlyArray<string>;
};

export type DatasetStatusReport = {
  readonly name: string;
  readonly versions: ReadonlyArray<VersionStatus>;
  /** Run-history entries joined to ANY version of the dataset. */
  readonly runsJoined: number;
  /** Total release entries across versions (the dataset's test burn). */
  readonly totalReleases: number;
  /** Absent when no joined run's outcomes could be loaded. */
  readonly saturation?: SaturationReport;
};

/** Default window for the saturation join (last N joined runs). */
export const STATUS_DEFAULT_LAST_N = 10;

export function ageDaysBetween(createdAt: string, now: Date): number {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}

export type ComputeDatasetStatusOptions = {
  readonly name: string;
  /** Every version's record, in version order. */
  readonly versions: ReadonlyArray<{ readonly version: string; readonly record: DatasetRecord }>;
  /** The run-history index, oldest first (readRunIndex order). */
  readonly entries: ReadonlyArray<StatusRunEntry>;
  readonly now: Date;
  /** Saturation window (default {@link STATUS_DEFAULT_LAST_N}). */
  readonly lastN?: number;
  /** Load one joined run's per-sample outcomes; undefined → run dir
   *  unreadable (skipped, best-effort like refresh-goldens). */
  readonly loadOutcomes: (outDir: string) => Promise<ReadonlyArray<RunSampleOutcome> | undefined>;
};

export async function computeDatasetStatus(
  opts: ComputeDatasetStatusOptions,
): Promise<DatasetStatusReport> {
  const versions: VersionStatus[] = [];
  // Filter the run-history index ONCE across all versions so `joined` keeps
  // the index's chronological (oldest-first) order — concatenating
  // per-version lists would put every v1 run before every v2 run, and the
  // saturation window below would then be a version-ordered tail rather
  // than the chronological last N runs when runs interleave across
  // versions (e.g. v1 baselines re-run after v2 evals started).
  const joined = opts.entries.filter((e) =>
    opts.versions.some(({ version }) => entryMatchesVersion(opts.name, version, e.datasetName)),
  );
  for (const { version, record } of opts.versions) {
    const mine = opts.entries.filter((e) => entryMatchesVersion(opts.name, version, e.datasetName));
    const last = mine[mine.length - 1];
    versions.push({
      version,
      createdAt: record.createdAt,
      ageDays: ageDaysBetween(record.createdAt, opts.now),
      train: record.splits.train.length,
      dev: record.splits.dev.length,
      ...(record.splits.test !== undefined ? { test: record.splits.test.length } : {}),
      runCount: mine.length,
      ...(last !== undefined ? { lastRunTs: last.ts } : {}),
      testRunCount: mine.filter((e) => e.datasetName.includes("#test")).length,
      releaseCount: (record.releases ?? []).length,
    });
  }

  // Saturation: join the last N runs' per-sample outcomes (`joined` is in
  // index order — oldest-first — so the tail IS the chronological last N).
  const window = joined.slice(-(opts.lastN ?? STATUS_DEFAULT_LAST_N));
  const appearances = new Map<string, { appeared: number; passed: number }>();
  let runsConsidered = 0;
  for (const entry of window) {
    const outcomes = await opts.loadOutcomes(entry.outDir);
    if (outcomes === undefined) continue;
    runsConsidered += 1;
    for (const o of outcomes) {
      const acc = appearances.get(o.sampleId) ?? { appeared: 0, passed: 0 };
      acc.appeared += 1;
      if (o.passed) acc.passed += 1;
      appearances.set(o.sampleId, acc);
    }
  }
  const alwaysPassing = [...appearances.entries()]
    .filter(([, a]) => a.appeared >= 2 && a.passed === a.appeared)
    .map(([id]) => id)
    .sort();

  return {
    name: opts.name,
    versions,
    runsJoined: joined.length,
    totalReleases: versions.reduce((sum, v) => sum + v.releaseCount, 0),
    ...(runsConsidered > 0 ? { saturation: { runsConsidered, alwaysPassing } } : {}),
  };
}

/** How many always-passing ids the status output spells out. */
const STATUS_MAX_IDS = 12;

/** Render the status report as CLI lines (the table rows are returned
 *  separately so `index.ts` can use its aligned writeTable). */
export function statusTableRows(report: DatasetStatusReport): string[][] {
  return report.versions.map((v) => [
    v.version,
    `${v.ageDays}d`,
    String(v.train),
    String(v.dev),
    v.test !== undefined ? String(v.test) : "-",
    String(v.runCount),
    v.lastRunTs ?? "-",
    v.testRunCount > 0 || v.releaseCount > 0 ? `${v.releaseCount} (${v.testRunCount} runs)` : "0",
  ]);
}

export function statusSummaryLines(report: DatasetStatusReport): string[] {
  const lines: string[] = [];
  lines.push(
    `[datasets] status ${report.name}: ${report.versions.length} version(s), ` +
      `${report.runsJoined} indexed run(s), test burn ${report.totalReleases} release(s)`,
  );
  const sat = report.saturation;
  if (sat === undefined) {
    lines.push(
      "[datasets] saturation: no readable run outcomes in the history window — nothing to report",
    );
    return lines;
  }
  if (sat.alwaysPassing.length === 0) {
    lines.push(
      `[datasets] saturation: no always-passing samples across the last ${sat.runsConsidered} run(s) — the set still discriminates`,
    );
    return lines;
  }
  const shown = sat.alwaysPassing.slice(0, STATUS_MAX_IDS).join(", ");
  const elided =
    sat.alwaysPassing.length > STATUS_MAX_IDS
      ? ` +${sat.alwaysPassing.length - STATUS_MAX_IDS} more`
      : "";
  lines.push(
    `[datasets] saturation: ${sat.alwaysPassing.length} sample(s) passed every one of the last ` +
      `${sat.runsConsidered} run(s) they appeared in (≥2 appearances) — rotation candidates: ${shown}${elided}`,
  );
  return lines;
}

// -------- dataset card (B21) --------

export type DatasetCardOptions = {
  readonly name: string;
  readonly version: string;
  readonly record: DatasetRecord;
  /** Provenance breakdown: `metadata.source` (or "(untagged)") → count. */
  readonly provenance: ReadonlyMap<string, number>;
  /** The offline lint findings (the card embeds a summary). */
  readonly lintFindings: ReadonlyArray<LintFinding>;
  /** Run-history entries joined to this version (any split). */
  readonly runCount: number;
  readonly now: Date;
};

/** Provenance breakdown over samples: source value (or "(untagged)") →
 *  count, insertion-ordered by first appearance. */
export function provenanceBreakdown(
  samples: ReadonlyArray<{ readonly metadata?: Readonly<Record<string, unknown>> }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of samples) {
    const v = s.metadata?.["source"];
    const key = typeof v === "string" ? v : "(untagged)";
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * Render the markdown datasheet. A generated ARTIFACT (stdout or `-o`) —
 * never mutates the record; the human commits it wherever cards live.
 */
export function renderDatasetCard(opts: DatasetCardOptions): string {
  const { record } = opts;
  const total =
    record.splits.train.length + record.splits.dev.length + (record.splits.test?.length ?? 0);
  const lines: string[] = [];
  lines.push(`# Dataset card — ${opts.name}@${opts.version}`);
  lines.push("");
  lines.push(`Generated ${opts.now.toISOString()} by \`crewhaus datasets card\`.`);
  lines.push("");
  lines.push("## Overview");
  lines.push("");
  lines.push(
    `- **Created:** ${record.createdAt} (${ageDaysBetween(record.createdAt, opts.now)} days ago)`,
  );
  lines.push(`- **Samples:** ${total}`);
  lines.push(
    `- **Content hash:** \`${overallDatasetHash(record, splitsPresent(record))}\` (all splits)`,
  );
  lines.push(`- **Indexed eval runs:** ${opts.runCount}`);
  lines.push(`- **Test-split burn:** ${(record.releases ?? []).length} release(s)`);
  lines.push("");
  lines.push("## Splits");
  lines.push("");
  lines.push("| split | samples | sampleHashes |");
  lines.push("| --- | ---: | ---: |");
  for (const split of splitsPresent(record)) {
    const n = record.splits[split]?.length ?? 0;
    const hashes = record.sampleHashes[split]?.length ?? 0;
    lines.push(`| ${split} | ${n} | ${hashes} |`);
  }
  lines.push("");
  lines.push("## Provenance (`metadata.source`)");
  lines.push("");
  lines.push("| source | samples | share |");
  lines.push("| --- | ---: | ---: |");
  for (const [source, count] of opts.provenance) {
    const pct = total === 0 ? 0 : (count / total) * 100;
    lines.push(`| ${source} | ${count} | ${pct.toFixed(0)}% |`);
  }
  lines.push("");
  lines.push("## Release history");
  lines.push("");
  const releases: ReadonlyArray<ReleaseEntry> = record.releases ?? [];
  if (releases.length === 0) {
    lines.push("Test split never released — the holdout is unspent.");
  } else {
    lines.push("| ts | run | pass rate |");
    lines.push("| --- | --- | ---: |");
    for (const r of releases) {
      lines.push(`| ${r.ts} | ${r.runId} | ${(r.passRate * 100).toFixed(1)}% |`);
    }
  }
  lines.push("");
  lines.push("## Lint");
  lines.push("");
  const errors = opts.lintFindings.filter((f) => f.severity === "error");
  const warnings = opts.lintFindings.filter((f) => f.severity === "warning");
  if (opts.lintFindings.length === 0) {
    lines.push("Clean — 0 errors, 0 warnings (`crewhaus dataset lint`).");
  } else {
    lines.push(
      `${errors.length} error(s), ${warnings.length} warning(s) (\`crewhaus dataset lint\`):`,
    );
    lines.push("");
    for (const f of opts.lintFindings) {
      lines.push(`- **${f.severity}** \`${f.rule}\` — ${f.message}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
