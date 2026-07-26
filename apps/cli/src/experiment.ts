import { join } from "node:path";
/**
 * E50 — `crewhaus experiment <status|record|assign>`: deterministic
 * per-request version selection plus per-version outcome accounting, reported
 * with the Wave-1 Wilson intervals and an explicit refusal to declare a winner
 * below a minimum n.
 *
 * The whole verb lives here rather than in `index.ts` (which runs an argv
 * switch on import and so cannot be imported by a test): the report math is
 * pure over already-loaded tallies, and the command itself takes injected
 * stdout/stderr writers and throws `CrewhausError` instead of calling the
 * entry file's `die`, so `index.ts` keeps only the dispatch arm.
 *
 * HONEST BOUNDARY. The ledger records outcomes that something ELSE attributed
 * to a version — `deploy canary --traffic-split`'s per-version eval samples,
 * or whatever a serving integration reports through `crewhaus experiment
 * record`. CrewHaus does not intercept live requests, so this report never
 * claims a "live traffic experiment"; it says exactly which observations it
 * counted and where they came from — the per-version `sources` breakdown and
 * the `boundary` note both ride the `--json` payload, not just the table.
 *
 * INDEPENDENCE. Wilson intervals assume independent observations, so `status`
 * collapses repeat EVAL measurements of the same (version, dataset sample)
 * before tallying (`dedupeExperimentOutcomes`). Without that, a four-step
 * canary ramp — which evals both versions at every step over one fixed
 * dataset — would report 4N per version and name a "winner" on an interval
 * ~2× narrower than the evidence supports.
 */
import {
  DEFAULT_EXPERIMENTS_DIR,
  type VariantTally,
  appendExperimentOutcome,
  dedupeExperimentOutcomes,
  listExperiments,
  readExperimentAssignment,
  readExperimentOutcomes,
  selectExperimentVariant,
  tallyExperimentOutcomes,
} from "@crewhaus/canary-controller";
import { CrewhausError } from "@crewhaus/errors";
import { wilsonCI95 } from "@crewhaus/eval-runner";
import type { ParsedArgs } from "@crewhaus/infra-utils";

/**
 * Minimum observations PER VERSION before a winner may be declared. 30 is
 * the conventional floor for the normal approximation the Wilson interval
 * leans on; below it the interval is so wide that "no difference" is the only
 * honest reading anyway, and callers override it with `--min-n`.
 */
export const DEFAULT_MIN_EXPERIMENT_N = 30;

/**
 * The one-line caveat the human table always prints, carried on the report
 * itself so `--json` — the surface most likely to be piped into a dashboard
 * or quoted onward — cannot ship the verdict without it.
 */
export const EXPERIMENT_BOUNDARY_NOTE =
  "these are outcomes REPORTED against each version (`deploy canary --traffic-split` " +
  "eval samples and/or `crewhaus experiment record`); CrewHaus does not intercept live " +
  "requests, so this is not a live-traffic experiment unless your own serving boundary " +
  "made it one";

export type VariantStatus = {
  readonly version: string;
  readonly n: number;
  readonly successes: number;
  readonly successRate: number;
  /** Wilson 95% interval on the success rate. Absent when n = 0. */
  readonly ci95?: readonly [number, number];
  readonly meanScore?: number;
  readonly meanRating?: number;
  /**
   * Where this version's n came from — `{eval: 20}` (offline re-runs of a
   * fixed dataset) reads very differently from `{serving: 20}` (live
   * outcomes), and a machine consumer must be able to tell them apart.
   */
  readonly sources: Readonly<Record<string, number>>;
  /** successRate − control.successRate. Absent on the control row. */
  readonly successRateDelta?: number;
  /** meanRating − control.meanRating, when both sides carry ratings. */
  readonly ratingDelta?: number;
  /** meanScore − control.meanScore, when both sides carry scores. */
  readonly scoreDelta?: number;
  /** True when this version has fewer than `minN` observations. */
  readonly underpowered: boolean;
  /**
   * Interval comparison against the control: `better` / `worse` only when the
   * two Wilson intervals do NOT overlap, `inconclusive` otherwise. Absent on
   * the control row and whenever either side is underpowered (we refuse to
   * classify what we refuse to call).
   */
  readonly comparison?: "better" | "worse" | "inconclusive";
};

export type ExperimentStatusReport = {
  readonly name: string;
  /** The version every other row is compared against (the first recorded). */
  readonly control: string;
  readonly variants: ReadonlyArray<VariantStatus>;
  readonly minN: number;
  readonly totalObservations: number;
  /**
   * `insufficient-data` — at least one version is below `minN`, so no winner
   * is declared. `winner` — exactly one version's interval sits strictly
   * above the control's. `no-difference` — everyone is powered and no
   * interval separates.
   */
  readonly verdict: "insufficient-data" | "winner" | "no-difference";
  readonly winner?: string;
  /** One-line explanation of the verdict, naming the sample sizes. */
  readonly reason: string;
  /**
   * {@link EXPERIMENT_BOUNDARY_NOTE} — always present, so `--json` carries
   * the same caveat the table prints.
   */
  readonly boundary: string;
  /**
   * Repeat measurements dropped before tallying (see
   * `dedupeExperimentOutcomes`). Present only when > 0.
   */
  readonly duplicatesCollapsed?: number;
};

/**
 * Build the report. `control` defaults to the first version in `tallies`
 * (the ledger's first-appearance order, which for a canary is the baseline).
 */
export function buildExperimentStatus(args: {
  readonly name: string;
  readonly tallies: ReadonlyArray<VariantTally>;
  readonly minN?: number;
  readonly control?: string;
  /** Repeat measurements the caller dropped before tallying. */
  readonly duplicatesCollapsed?: number;
}): ExperimentStatusReport {
  const minN = args.minN ?? DEFAULT_MIN_EXPERIMENT_N;
  const tallies = args.tallies;
  const collapsed =
    args.duplicatesCollapsed !== undefined && args.duplicatesCollapsed > 0
      ? { duplicatesCollapsed: args.duplicatesCollapsed }
      : {};
  if (tallies.length === 0) {
    return {
      name: args.name,
      control: "",
      variants: [],
      minN,
      totalObservations: 0,
      verdict: "insufficient-data",
      reason: `no outcomes recorded for experiment "${args.name}" — nothing to compare`,
      boundary: EXPERIMENT_BOUNDARY_NOTE,
      ...collapsed,
    };
  }
  const controlVersion =
    args.control !== undefined && tallies.some((t) => t.version === args.control)
      ? args.control
      : (tallies[0] as VariantTally).version;
  const control = tallies.find((t) => t.version === controlVersion) as VariantTally;
  const controlCi = wilsonCI95(control.successes, control.n);

  const variants: VariantStatus[] = tallies.map((t) => {
    const ci = wilsonCI95(t.successes, t.n);
    const isControl = t.version === controlVersion;
    const underpowered = t.n < minN;
    let comparison: VariantStatus["comparison"];
    if (!isControl) {
      if (underpowered || control.n < minN || ci === undefined || controlCi === undefined) {
        comparison = undefined;
      } else if (ci[0] > controlCi[1]) {
        comparison = "better";
      } else if (ci[1] < controlCi[0]) {
        comparison = "worse";
      } else {
        comparison = "inconclusive";
      }
    }
    return {
      version: t.version,
      n: t.n,
      successes: t.successes,
      successRate: t.successRate,
      sources: t.sources,
      underpowered,
      ...(ci !== undefined ? { ci95: ci } : {}),
      ...(t.meanScore !== undefined ? { meanScore: t.meanScore } : {}),
      ...(t.meanRating !== undefined ? { meanRating: t.meanRating } : {}),
      ...(isControl ? {} : { successRateDelta: t.successRate - control.successRate }),
      ...(!isControl && t.meanRating !== undefined && control.meanRating !== undefined
        ? { ratingDelta: t.meanRating - control.meanRating }
        : {}),
      ...(!isControl && t.meanScore !== undefined && control.meanScore !== undefined
        ? { scoreDelta: t.meanScore - control.meanScore }
        : {}),
      ...(comparison !== undefined ? { comparison } : {}),
    };
  });

  const totalObservations = tallies.reduce((sum, t) => sum + t.n, 0);
  const underpowered = variants.filter((v) => v.underpowered);
  if (underpowered.length > 0) {
    const sizes = variants.map((v) => `${v.version}=${v.n}`).join(", ");
    return {
      name: args.name,
      control: controlVersion,
      variants,
      minN,
      totalObservations,
      verdict: "insufficient-data",
      reason: `refusing to declare a winner: ${underpowered
        .map((v) => v.version)
        .join(
          ", ",
        )} below the ${minN}-observation minimum (n: ${sizes}); collect more outcomes or lower --min-n deliberately`,
      boundary: EXPERIMENT_BOUNDARY_NOTE,
      ...collapsed,
    };
  }
  const better = variants.filter((v) => v.comparison === "better");
  if (better.length === 1) {
    const win = better[0] as VariantStatus;
    return {
      name: args.name,
      control: controlVersion,
      variants,
      minN,
      totalObservations,
      verdict: "winner",
      winner: win.version,
      reason:
        `${win.version} beats control ${controlVersion}: 95% intervals do not overlap ` +
        `(${fmtPct(win.successRate)} [${fmtCi(win.ci95)}] vs ${fmtPct(control.successRate)} ` +
        `[${fmtCi(variants.find((v) => v.version === controlVersion)?.ci95)}], n=${win.n} vs ${control.n})`,
      boundary: EXPERIMENT_BOUNDARY_NOTE,
      ...collapsed,
    };
  }
  if (better.length > 1) {
    const sizes = better.map((v) => `${v.version} (n=${v.n})`).join(", ");
    return {
      name: args.name,
      control: controlVersion,
      variants,
      minN,
      totalObservations,
      verdict: "no-difference",
      reason: `${better.length} versions beat control ${controlVersion} (${sizes}) — no single winner; compare them against each other with --control`,
      boundary: EXPERIMENT_BOUNDARY_NOTE,
      ...collapsed,
    };
  }
  const sizes = variants.map((v) => `${v.version}=${v.n}`).join(", ");
  return {
    name: args.name,
    control: controlVersion,
    variants,
    minN,
    totalObservations,
    verdict: "no-difference",
    reason: `no version separates from control ${controlVersion} at 95% confidence (n: ${sizes})`,
    boundary: EXPERIMENT_BOUNDARY_NOTE,
    ...collapsed,
  };
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtCi(ci: readonly [number, number] | undefined): string {
  if (ci === undefined) return "n/a";
  return `${(ci[0] * 100).toFixed(1)}–${(ci[1] * 100).toFixed(1)}%`;
}

/** `eval:20 serving:5`, sorted, so provenance is visible in the table too. */
function fmtSources(sources: Readonly<Record<string, number>>): string {
  const entries = Object.entries(sources).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "—";
  return entries.map(([k, n]) => `${k}:${n}`).join(" ");
}

function fmtDelta(v: number | undefined, scale: "pct" | "raw"): string {
  if (v === undefined) return "";
  const sign = v > 0 ? "+" : "";
  return scale === "pct" ? `${sign}${(v * 100).toFixed(1)}pp` : `${sign}${v.toFixed(2)}`;
}

/** Render the report as stdout lines (no trailing newlines). */
export function formatExperimentStatus(report: ExperimentStatusReport): string[] {
  const lines: string[] = [];
  lines.push(`[experiment] ${report.name} — control ${report.control || "(none)"}`);
  if (report.variants.length === 0) {
    lines.push(`[experiment] ${report.reason}`);
    return lines;
  }
  const header = [
    "version",
    "n",
    "success",
    "rate",
    "95% CI",
    "Δrate",
    "score",
    "rating",
    "sources",
    "vs ctl",
  ];
  const rows = report.variants.map((v) => [
    v.version,
    String(v.n),
    String(v.successes),
    fmtPct(v.successRate),
    fmtCi(v.ci95),
    v.version === report.control ? "—" : fmtDelta(v.successRateDelta, "pct"),
    v.meanScore !== undefined ? v.meanScore.toFixed(2) : "—",
    v.meanRating !== undefined ? v.meanRating.toFixed(2) : "—",
    fmtSources(v.sources),
    v.version === report.control ? "control" : (v.comparison ?? "—"),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cells: ReadonlyArray<string>): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? c.length))
      .join("  ")
      .trimEnd();
  lines.push(`  ${pad(header)}`);
  for (const row of rows) lines.push(`  ${pad(row)}`);
  lines.push(`[experiment] verdict: ${report.verdict} — ${report.reason}`);
  if (report.duplicatesCollapsed !== undefined) {
    const why =
      "already-observed (version, sample) pairs — a re-measured dataset sample is not an " +
      "independent observation, and counting it would narrow the intervals above.";
    lines.push(
      `[experiment] collapsed ${report.duplicatesCollapsed} repeat eval measurement(s) of ${why}`,
    );
  }
  lines.push(`[experiment] note: ${report.boundary} — see \`crewhaus experiment --help\`.`);
  return lines;
}

/**
 * E50 — `crewhaus experiment <status|record|assign> ...`.
 *
 * HONEST BOUNDARY (repeated here because it is the thing most likely to be
 * over-claimed): CrewHaus does not intercept live requests. `assign` is the
 * deterministic decision function a serving integration calls; `record` is
 * how that integration reports an outcome back; `status` is the read model
 * over what was recorded. Nothing in the shipped serving surfaces
 * (gateway-server's RunHandler, the managed daemon, the channel bots)
 * consults an assignment on its own — wiring one in is an explicit
 * integration, not something a flag turns on.
 */
export type ExperimentIo = {
  readonly stdout?: (chunk: string) => void;
  readonly stderr?: (chunk: string) => void;
  /** Overrides `process.cwd()` for the default ledger root. */
  readonly cwd?: string;
};

export function runExperimentCommand(
  args: ParsedArgs,
  action: string,
  io: ExperimentIo = {},
): void {
  const out = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const err = io.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  // Failures throw `CrewhausError`; the dispatch arm in index.ts turns that
  // into the usual one-line `die`. Keeping `die` out of this module is what
  // lets it be imported by a test at all.
  const fail = (message: string): never => {
    throw new CrewhausError("config", message);
  };
  if (args.flags["help"] || action === "" || action.startsWith("-")) {
    // Assembled as lines (not a `+` chain) so the one interpolated default
    // does not turn the whole block into a concatenation lint violation.
    out(
      `${[
        "usage:",
        "  crewhaus experiment status [--name <n>]      per-version outcome/rating deltas",
        "       [--control <version>] [--min-n N]        with Wilson 95% intervals; refuses to",
        "       [--json] [--dir <root>]                  name a winner below --min-n per version",
        `                                                (default --min-n ${DEFAULT_MIN_EXPERIMENT_N})`,
        "  crewhaus experiment record --name <n>        append ONE outcome for a version",
        "       --version <v> --outcome pass|fail        (this is how a serving integration",
        "       [--score F] [--rating F] [--key K]        reports back)",
        "       [--source <s>] [--dir <root>]",
        "  crewhaus experiment assign --name <n>        print the version a request key maps to,",
        "       --key <request-key> [--dir <root>]       deterministically (sha256 bucket)",
        "",
        "  WHAT THIS IS. Two halves of an A/B experiment CrewHaus can actually reach:",
        "  (1) SELECTION — a stable request key always maps to the same variant version,",
        "      in every process, with no shared state (`assign`, and the same hash the",
        "      canary controller's route() uses); (2) ACCOUNTING — an append-only ledger",
        "      of per-version outcomes under .crewhaus/experiments/<name>.jsonl, folded",
        "      by `status` into success rates, mean scores/ratings and their deltas.",
        "",
        "  INDEPENDENCE. `status` collapses repeat EVAL measurements of the same",
        "  (version, dataset sample) — re-running a ramp re-measures the same fixed",
        "  samples, and counting those as independent observations would narrow the",
        "  95% intervals on evidence that did not grow. Serving/CLI records are never",
        "  collapsed: there a repeated key is a repeated REQUEST.",
        "",
        "  WHAT THIS IS NOT. It does NOT split live traffic. No CrewHaus serving surface",
        "  consults the assignment file today, and `target: cli` has no live request",
        "  stream at all. An operator gets the decision function and the ledger; routing",
        "  real requests through them is an explicit integration at your serving boundary.",
        "",
        "  `crewhaus deploy canary --traffic-split` writes the assignment and records each",
        "  ramp step's per-version EVAL samples into the ledger, so `status` has real",
        "  per-version outcomes without any serving integration at all.",
      ].join("\n")}\n`,
    );
    return;
  }
  const dirFlag = args.flags["dir"];
  const dir =
    typeof dirFlag === "string" ? dirFlag : join(io.cwd ?? process.cwd(), DEFAULT_EXPERIMENTS_DIR);

  // `--name` is optional when exactly one experiment exists — the common case
  // after a single `deploy canary --traffic-split`. Otherwise the ambiguity is
  // resolved by naming the candidates rather than guessing.
  const resolveName = (): string => {
    const nameFlag = args.flags["name"];
    if (typeof nameFlag === "string" && nameFlag !== "") return nameFlag;
    const known = listExperiments(dir);
    if (known.length === 1) return known[0] as string;
    if (known.length === 0) {
      fail(`no experiments under ${dir} — run \`crewhaus deploy canary --traffic-split\` first`);
    }
    return fail(`--name is required (experiments under ${dir}: ${known.join(", ")})`);
  };

  if (action === "status") {
    const name = resolveName();
    const minNFlag = args.flags["min-n"];
    let minN = DEFAULT_MIN_EXPERIMENT_N;
    if (typeof minNFlag === "string") {
      const v = Number(minNFlag);
      if (!Number.isInteger(v) || v < 1)
        fail(`invalid --min-n "${minNFlag}" — must be an integer >= 1`);
      minN = v;
    }
    const controlFlag = args.flags["control"];
    // Repeat measurements of the SAME (version, dataset sample) are collapsed
    // before tallying — a 4-step ramp evals both versions at every step, and
    // re-invoking the ramp appends another full pass. Treating those as
    // independent would shrink the Wilson half-width ~2× at 4N and let an
    // 8-sample dataset clear `--min-n 30`. Serving records never collapse
    // (there a repeated key is a repeated REQUEST); see the helper's docs.
    const { records, collapsed } = dedupeExperimentOutcomes(readExperimentOutcomes(name, dir));
    const report = buildExperimentStatus({
      name,
      tallies: tallyExperimentOutcomes(records),
      minN,
      duplicatesCollapsed: collapsed,
      ...(typeof controlFlag === "string" ? { control: controlFlag } : {}),
    });
    if (args.flags["json"] === true) {
      out(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    for (const line of formatExperimentStatus(report)) out(`${line}\n`);
    return;
  }

  if (action === "record") {
    const name = resolveName();
    const version = args.flags["version"];
    const outcomeFlag = args.flags["outcome"];
    if (typeof version !== "string" || version === "") fail("missing --version <v>");
    if (outcomeFlag !== "pass" && outcomeFlag !== "fail")
      fail(`--outcome must be "pass" or "fail" (got ${JSON.stringify(outcomeFlag ?? null)})`);
    const numeric = (flag: string): number | undefined => {
      const raw = args.flags[flag];
      if (typeof raw !== "string") return undefined;
      const v = Number(raw);
      if (!Number.isFinite(v)) fail(`invalid --${flag} "${raw}" — must be a finite number`);
      return v;
    };
    const score = numeric("score");
    if (score !== undefined && (score < 0 || score > 1))
      fail(`invalid --score "${score}" — the score scale is 0..1`);
    appendExperimentOutcome(
      {
        ts: new Date().toISOString(),
        experiment: name,
        version: version as string,
        outcome: outcomeFlag === "pass" ? "success" : "failure",
        ...(typeof args.flags["key"] === "string" ? { requestKey: args.flags["key"] } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(numeric("rating") !== undefined ? { rating: numeric("rating") as number } : {}),
        source: typeof args.flags["source"] === "string" ? args.flags["source"] : "cli",
      },
      dir,
    );
    out(`[experiment] recorded ${outcomeFlag} for ${name}@${version}\n`);
    return;
  }

  if (action === "assign") {
    const name = resolveName();
    const key = args.flags["key"];
    if (typeof key !== "string" || key === "") fail("missing --key <request-key>");
    const assignment = readExperimentAssignment(name, dir);
    if (assignment === undefined) {
      const why =
        "either no ramp has written one (`crewhaus deploy canary --traffic-split`), or a ramp " +
        "concluded: a promotion or rollback RETIRES the assignment, because both end states " +
        "pin a single version and there is no split left to serve";
      fail(`no variant assignment for experiment "${name}" under ${dir} — ${why}`);
      return;
    }
    const selection = selectExperimentVariant(assignment, key as string);
    out(`${selection.version}\n`);
    // The assignment's provenance rides the note so a stale split is visible
    // to the human reading it. Deliberately NOT cross-checked against the env
    // pin: an experiment name is only the spec name by DEFAULT (`--experiment`
    // overrides it), so a name→spec→pin lookup would be a guess, and a
    // confident wrong "your assignment disagrees with prod" is worse than the
    // dated facts. A concluded ramp removes the file, which is the real guard.
    const weights = assignment.variants.map((v) => `${v.version}=${v.weight}%`).join(" ");
    err(
      `[experiment] ${name}: key "${key}" → bucket ${selection.bucket} → ${selection.version} (deterministic; CrewHaus does not route live requests — this is the decision function your serving boundary calls)\n` +
        `[experiment] assignment: ${weights}${assignment.env !== undefined ? ` · env ${assignment.env}` : ""} · updatedAt ${assignment.updatedAt || "(unrecorded)"} — verify this still matches the version you intend to serve\n`,
    );
    return;
  }
  fail(`unknown experiment action "${action}" (expected: status | record | assign)`);
}
