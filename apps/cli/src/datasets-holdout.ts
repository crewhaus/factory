/**
 * `crewhaus datasets holdout` and `crewhaus datasets uses`: the pure halves.
 *
 * A holdout is the promotion-only split: a new version moves a seeded
 * selection of train+dev cases into it (`createHoldoutVersion` in
 * dataset-ops), and every read of it, or of the test split, leaves one line
 * in the version's use ledger (`recordHeldOutUse` in dataset-registry). These
 * helpers render what the CLI prints, so a test can read them without
 * running the CLI.
 */
import type { CreatedHoldout } from "@crewhaus/dataset-ops/datasets";
import {
  type HeldOutPurpose,
  type HeldOutSplit,
  type HeldOutUse,
  type HeldOutUsesReport,
  countHeldOutUses,
} from "@crewhaus/dataset-registry";

/** What `datasets holdout` prints once the new version is written. */
export function holdoutCreatedLines(name: string, created: CreatedHoldout): string[] {
  const r = created.record;
  return [
    `[datasets] holdout ${name}@${r.version} from ${name}@${created.source}: ` +
      `${created.moved} case(s) held out (${created.fromTrain} from train, ${created.fromDev} from dev) — ` +
      `train ${r.splits.train.length} / dev ${r.splits.dev.length} / test ${r.splits.test?.length ?? 0} / holdout ${r.splits.holdout?.length ?? 0}`,
    `[datasets] ${name}@${created.source} is unchanged. A bare registry:${name} now resolves to ${r.version}, so its cases changed: the next \`crewhaus eval --gate\` asks for \`--rebaseline --reason cases-changed\`.`,
    "[datasets] the holdout is read only by a change's promotion check (`crewhaus changes check`) and `crewhaus datasets release --split holdout`; every read is counted (`crewhaus datasets uses`).",
  ];
}

/** Use lines purpose by purpose, for one split. */
export function usesByPurpose(
  report: HeldOutUsesReport,
  split: HeldOutSplit,
): Array<{ purpose: HeldOutPurpose; count: number }> {
  const counts = new Map<HeldOutPurpose, number>();
  for (const u of report.uses) {
    if (u.split !== split) continue;
    counts.set(u.purpose, (counts.get(u.purpose) ?? 0) + 1);
  }
  if (split === "test" && report.legacyReleases.length > 0) {
    counts.set("release", (counts.get("release") ?? 0) + report.legacyReleases.length);
  }
  return [...counts.entries()]
    .map(([purpose, count]) => ({ purpose, count }))
    .sort((a, b) => b.count - a.count || (a.purpose < b.purpose ? -1 : 1));
}

/** `datasets uses --json`: the report, newest first, with counts. */
export function usesJson(
  name: string,
  version: string,
  report: HeldOutUsesReport,
): Record<string, unknown> {
  return {
    name,
    version,
    present: report.present,
    counts: {
      test: countHeldOutUses(report, "test"),
      holdout: countHeldOutUses(report, "holdout"),
    },
    byPurpose: {
      test: usesByPurpose(report, "test"),
      holdout: usesByPurpose(report, "holdout"),
    },
    uses: [...report.uses].reverse(),
    legacyReleases: [...report.legacyReleases].reverse(),
    skipped: report.skipped,
    truncated: report.truncated,
    ...(report.note !== undefined ? { note: report.note } : {}),
  };
}

function useLine(u: HeldOutUse): string {
  const parts = [u.at, u.split, u.purpose, `via ${u.via}`];
  if (u.runId !== undefined) parts.push(`run ${u.runId}`);
  if (u.change !== undefined) parts.push(`change ${u.change}`);
  return `  ${parts.join("  ")}`;
}

/** `datasets uses` as text: counts first, then every use, newest first. */
export function usesLines(name: string, version: string, report: HeldOutUsesReport): string[] {
  const lines: string[] = [];
  const test = countHeldOutUses(report, "test");
  const holdout = countHeldOutUses(report, "holdout");
  if (!report.present && report.legacyReleases.length === 0) {
    lines.push(
      `[datasets] uses ${name}@${version}: no held-out reads recorded yet — a read of #test (\`crewhaus eval --allow-test-split\`, \`crewhaus datasets release\`) or of the holdout (\`crewhaus changes check\`) adds one`,
    );
    if (report.note !== undefined) lines.push(`[datasets] note: ${report.note}`);
    return lines;
  }
  lines.push(`[datasets] uses ${name}@${version}: test ${test}, holdout ${holdout}`);
  for (const split of ["test", "holdout"] as const) {
    const by = usesByPurpose(report, split);
    if (by.length === 0) continue;
    lines.push(`  ${split}: ${by.map((b) => `${b.purpose} ${b.count}`).join(", ")}`);
  }
  for (const u of [...report.uses].reverse()) lines.push(useLine(u));
  for (const r of [...report.legacyReleases].reverse()) {
    lines.push(`  ${r.ts}  test  release  (recorded before use lines)  run ${r.runId}`);
  }
  if (report.skipped > 0) {
    lines.push(`[datasets] ${report.skipped} line(s) were not a well-formed use and were skipped`);
  }
  if (report.truncated) {
    lines.push("[datasets] the ledger is longer than this read — the counts above are a floor");
  }
  if (report.note !== undefined) lines.push(`[datasets] note: ${report.note}`);
  return lines;
}

/**
 * How many times a split was released: release-purpose use lines for that
 * split, plus (for test) the legacy `releases[]` entries no use line names.
 */
export function releaseUseCount(report: HeldOutUsesReport, split: HeldOutSplit): number {
  return countHeldOutUses(report, split, "release");
}

/**
 * How many times a split was released, when the ledger was read whole:
 * `undefined` when the report is truncated or carries a note, since a count
 * from part of the ledger is not the count.
 */
export function releaseCountOf(report: HeldOutUsesReport, split: HeldOutSplit): number | undefined {
  if (report.truncated || report.note !== undefined) return undefined;
  return releaseUseCount(report, split);
}

/** What `datasets release` does about a split's release count. */
export type ReleaseGate =
  | { readonly refuse: string }
  | { readonly warn: string }
  | { readonly count: number };

/**
 * A known release count passes through; a count that cannot be determined
 * refuses unless `force` is set, and then warns.
 */
export function releaseGate(
  report: HeldOutUsesReport,
  split: HeldOutSplit,
  force: boolean,
): ReleaseGate {
  const count = releaseCountOf(report, split);
  if (count !== undefined) return { count };
  const why = report.note ?? "the use ledger is longer than one read";
  return force
    ? {
        warn: `how many times the ${split} split was released cannot be determined (${why}) — releasing it anyway under --force`,
      }
    : {
        refuse: `how many times the ${split} split was released cannot be determined (${why}) — pass --force to release it anyway`,
      };
}
