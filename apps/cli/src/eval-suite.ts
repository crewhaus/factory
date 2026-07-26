/**
 * NEW-HUNT-8 — `crewhaus eval suite <suite.yaml> [--tier …]`: the eval SUITE
 * manifest and its CI tiering.
 *
 * Until now `crewhaus eval` took exactly one `--dataset` and one `--graders`
 * per invocation, so the report's CI-tiering practice (a small fast suite on
 * every change, a medium one nightly, the full one on release candidates)
 * could only be hand-composed in CI YAML — with no single verdict across the
 * pieces. A suite manifest names TIERS, each tier a list of entries, each
 * entry a (dataset, graders) pair plus the run flags that belong to it:
 *
 *   name: brewbird
 *   spec: crewhaus.yaml           # default spec for every entry
 *   tiers:
 *     fast:
 *       - name: smoke
 *         dataset: eval/smoke.jsonl
 *         graders: eval/graders.yaml
 *         seed: 1
 *         concurrency: 1
 *         thresholds: { min_pass_rate: 0.8 }
 *     nightly:
 *       - name: full
 *         dataset: registry:brewbird-golden
 *         graders: eval/graders.yaml
 *         repeats: 3
 *         gate: true
 *
 * Tier names are a fixed vocabulary (`fast` / `nightly` / `release`): the
 * point of the feature is a SHARED CI ladder, and a free-form name would let
 * every repo invent its own and lose the meaning of `--tier fast`.
 *
 * Two gating mechanisms, deliberately distinct:
 *   - `thresholds` are ABSOLUTE floors evaluated by this module from the
 *     entry's own results.json. They gate from run one, including in a fresh
 *     CI workspace with no history.
 *   - `gate: true` is the EXISTING (spec, dataset) baseline regression gate,
 *     unchanged — this module adds no gating semantics of its own to it. In a
 *     fresh workspace there is no pinned baseline, so it passes vacuously
 *     until something pins one (which is exactly what the scaffolded CI
 *     workflow's base-branch run does).
 *
 * Every entry must declare at least one of the two — an entry with neither
 * can never fail, so its PASS would be a green light nobody earned (and the
 * scaffolded CI job makes it a required check). That is refused at parse
 * time, exactly like a baseline-only ceiling without `gate: true`.
 *
 * A tier passes only when EVERY entry passes. Kept side-effect-free (the CLI
 * entry file runs an argv switch on import): the run loop, filesystem and
 * process exit live in `apps/cli/src/index.ts`.
 */
import type { ParsedArgs } from "@crewhaus/infra-utils";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Thrown on an invalid manifest, unknown tier or unusable entry. The CLI
 *  entry file routes it through `die()`. */
export class EvalSuiteError extends Error {
  override readonly name = "EvalSuiteError";
}

/** The governed CI ladder. */
export const SUITE_TIERS = ["fast", "nightly", "release"] as const;
export type SuiteTier = (typeof SUITE_TIERS)[number];

/** `--tier`'s default: the per-change rung. */
export const DEFAULT_SUITE_TIER: SuiteTier = "fast";

const ThresholdsSchema = z
  .object({
    /** Absolute pass-rate floor for the entry, 0..1. */
    min_pass_rate: z.number().min(0).max(1).optional(),
    /** Absolute mean-score floor for the entry (rubric-scaled). */
    min_mean_score: z.number().min(0).optional(),
    /** Ceilings threaded into the entry's own `crewhaus eval` invocation —
     *  they join the BASELINE gate, so they need `gate: true` to bite. */
    max_p95_latency_ms: z.number().min(0).optional(),
    max_cost_usd: z.number().min(0).optional(),
  })
  .strict();

const EntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
        "entry names become directory names — letters, digits, _ and - only",
      ),
    dataset: z.string().min(1),
    graders: z.string().min(1),
    /** Per-entry spec override (default: the manifest's `spec`). */
    spec: z.string().min(1).optional(),
    seed: z.number().int().optional(),
    repeats: z.number().int().min(1).optional(),
    concurrency: z.number().int().min(1).optional(),
    /** Metadata keys to slice by, as a list (rendered to `--slice a,b`). */
    slice: z.array(z.string().min(1)).min(1).optional(),
    /** Opt into the existing (spec, dataset) baseline regression gate. */
    gate: z.boolean().optional(),
    /** Explicit opt-in for a `#test` registry ref, mirroring `eval`. */
    allow_test_split: z.boolean().optional(),
    thresholds: ThresholdsSchema.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    // `max_p95_latency_ms` / `max_cost_usd` are criteria of the BASELINE
    // gate (they thread into `eval --max-*`, whose verdict only maps to a
    // failure under `--gate`). Declaring one without `gate: true` would be
    // dead config that reads like a ceiling — refuse it instead, and name
    // the absolute floors that need no baseline.
    const baselineOnly = (["max_p95_latency_ms", "max_cost_usd"] as const).filter(
      (k) => entry.thresholds?.[k] !== undefined,
    );
    if (baselineOnly.length > 0 && entry.gate !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["thresholds", baselineOnly[0] as string],
        message: `entry "${entry.name}": ${baselineOnly.join(" / ")} are criteria of the (spec, dataset) BASELINE gate — declare \`gate: true\` on the entry, or use min_pass_rate / min_mean_score for absolute floors that need no baseline`,
      });
    }
    // An entry with NEITHER gating mechanism can never fail: no thresholds
    // to breach and no baseline gate to regress against, so `passed` is true
    // whatever it measured — and the tier line reports PASS while the
    // scaffolded workflow treats it as a required check. That is the same
    // dead-config class the refusal above exists for, one level up: refuse
    // it at parse time rather than shipping a green light nobody earned.
    const hasFloor =
      entry.thresholds !== undefined &&
      Object.values(entry.thresholds).some((v) => v !== undefined);
    if (!hasFloor && entry.gate !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gate"],
        message: `entry "${entry.name}" declares no gating criteria — it can never fail, so its PASS would mean nothing. Add \`thresholds: {min_pass_rate: …}\` (absolute, bites from run one) or \`gate: true\` (the (spec, dataset) baseline regression gate)`,
      });
    }
  });

export const SuiteManifestSchema = z
  .object({
    name: z.string().min(1).optional(),
    /** Default spec for every entry that declares none. */
    spec: z.string().min(1).optional(),
    tiers: z
      .object({
        fast: z.array(EntrySchema).min(1).optional(),
        nightly: z.array(EntrySchema).min(1).optional(),
        release: z.array(EntrySchema).min(1).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const declared = SUITE_TIERS.filter((t) => manifest.tiers[t] !== undefined);
    if (declared.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tiers"],
        message: `declare at least one tier (${SUITE_TIERS.join(" | ")})`,
      });
    }
    for (const tier of declared) {
      const seen = new Set<string>();
      for (const entry of manifest.tiers[tier] ?? []) {
        if (seen.has(entry.name)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["tiers", tier],
            message: `duplicate entry name "${entry.name}" — entry names are the run directories`,
          });
        }
        seen.add(entry.name);
      }
    }
  });

export type SuiteManifest = z.infer<typeof SuiteManifestSchema>;
export type SuiteEntry = z.infer<typeof EntrySchema>;
export type SuiteThresholds = z.infer<typeof ThresholdsSchema>;

/** Parse a suite manifest. Strict: an unknown key (a typo'd `threshold:`, a
 *  tier named `smoke`) is a loud refusal, never a silently skipped gate. */
export function parseSuiteManifest(yamlText: string): SuiteManifest {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new EvalSuiteError(`suite manifest is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = SuiteManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new EvalSuiteError(`invalid suite manifest: ${issues}`);
  }
  return parsed.data;
}

/** Validate a `--tier` value against the governed vocabulary. */
export function parseTierFlag(value: string | undefined): SuiteTier {
  if (value === undefined) return DEFAULT_SUITE_TIER;
  const tier = SUITE_TIERS.find((t) => t === value.trim());
  if (tier === undefined) {
    throw new EvalSuiteError(`unknown --tier "${value}" — must be ${SUITE_TIERS.join(" | ")}`);
  }
  return tier;
}

/** The tier's entries, or a refusal that names what the manifest DOES carry
 *  (an empty tier is a config mistake, never a vacuous pass). */
export function selectTier(manifest: SuiteManifest, tier: SuiteTier): ReadonlyArray<SuiteEntry> {
  const entries = manifest.tiers[tier];
  if (entries === undefined || entries.length === 0) {
    const declared = SUITE_TIERS.filter((t) => (manifest.tiers[t]?.length ?? 0) > 0);
    throw new EvalSuiteError(
      `suite declares no "${tier}" tier — declared tiers: ${declared.length > 0 ? declared.join(", ") : "(none)"}`,
    );
  }
  return entries;
}

/** The spec an entry runs against: `--spec` override > entry > manifest. */
export function specForEntry(
  manifest: SuiteManifest,
  entry: SuiteEntry,
  override?: string,
): string {
  const spec = override ?? entry.spec ?? manifest.spec;
  if (spec === undefined) {
    throw new EvalSuiteError(
      `entry "${entry.name}" has no spec — declare \`spec:\` on the entry or at the top of the suite (or pass --spec)`,
    );
  }
  return spec;
}

/**
 * Lower one entry to the `crewhaus eval` argument shape. Building ParsedArgs
 * directly (rather than a string argv) keeps this pure and lets the CLI hand
 * it to the very same run path a hand-typed `crewhaus eval` takes — one
 * implementation, one set of semantics.
 */
export function buildEntryEvalArgs(opts: {
  readonly manifest: SuiteManifest;
  readonly entry: SuiteEntry;
  readonly specOverride?: string;
  /** The entry's run directory (the suite root plus the entry name). */
  readonly outDir: string;
}): ParsedArgs {
  const { entry } = opts;
  const flags: Record<string, string | boolean> = {
    dataset: entry.dataset,
    graders: entry.graders,
    out: opts.outDir,
  };
  if (entry.seed !== undefined) flags["seed"] = String(entry.seed);
  if (entry.repeats !== undefined) flags["repeats"] = String(entry.repeats);
  if (entry.concurrency !== undefined) flags["concurrency"] = String(entry.concurrency);
  if (entry.slice !== undefined) flags["slice"] = entry.slice.join(",");
  if (entry.gate === true) flags["gate"] = true;
  if (entry.allow_test_split === true) flags["allow-test-split"] = true;
  if (entry.thresholds?.max_p95_latency_ms !== undefined) {
    flags["max-p95-latency-ms"] = String(entry.thresholds.max_p95_latency_ms);
  }
  if (entry.thresholds?.max_cost_usd !== undefined) {
    flags["max-cost-usd"] = String(entry.thresholds.max_cost_usd);
  }
  return {
    positional: [specForEntry(opts.manifest, entry, opts.specOverride)],
    flags,
  };
}

// -------- preflight --------

/**
 * Refuse a suite whose file references do not exist BEFORE the first entry
 * spends anything — the whole point of a tier is that it runs unattended, and
 * a typo'd graders path in entry 3 must not surface after entries 1–2 have
 * already been paid for. Registry refs (`registry:…`) and http(s) datasets
 * are resolved at run time and skipped here.
 */
export function suitePreflight(opts: {
  readonly manifest: SuiteManifest;
  readonly entries: ReadonlyArray<SuiteEntry>;
  readonly specOverride?: string;
  readonly exists: (path: string) => boolean;
}): string[] {
  const refusals: string[] = [];
  for (const entry of opts.entries) {
    let spec: string;
    try {
      spec = specForEntry(opts.manifest, entry, opts.specOverride);
    } catch (err) {
      refusals.push((err as Error).message);
      continue;
    }
    if (!opts.exists(spec)) refusals.push(`entry "${entry.name}": spec not found — ${spec}`);
    if (!opts.exists(entry.graders)) {
      refusals.push(`entry "${entry.name}": graders not found — ${entry.graders}`);
    }
    const isRef = /^(registry:|https?:\/\/)/.test(entry.dataset);
    if (!isRef && !opts.exists(entry.dataset)) {
      refusals.push(`entry "${entry.name}": dataset not found — ${entry.dataset}`);
    }
  }
  return refusals;
}

// -------- verdicts --------

/** The aggregates a suite reads back from an entry's `results.json`. */
export type EntryAggregates = {
  readonly passRate: number;
  readonly meanScore: number;
  readonly sampleCount: number;
  /** NEW-HUNT-3 — a budget-aborted run: its aggregates are not a measurement. */
  readonly partial?: boolean;
};

/**
 * Project a parsed `results.json` onto the aggregates a suite gates on, or
 * `undefined` when the file is not a measurement (no numeric aggregates).
 *
 * `partial` is read STRUCTURALLY, never by key presence: the runner writes it
 * as an OBJECT (`{completedSamples, totalSamples}`) and omits the key on a
 * complete run, so a `partial: false` from any future producer must not be
 * mistaken for a budget-exhausted run — this is the one consumer that
 * hard-FAILS an entry on it, so it is the one that pins the invariant.
 */
export function entryAggregatesFromResults(raw: unknown): EntryAggregates | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const results = raw as {
    aggregates?: { passRate?: unknown; meanScore?: unknown };
    samples?: unknown;
    partial?: unknown;
  };
  const passRate = results.aggregates?.passRate;
  const meanScore = results.aggregates?.meanScore;
  if (typeof passRate !== "number" || typeof meanScore !== "number") return undefined;
  const partial = results.partial;
  const isPartial = typeof partial === "object" && partial !== null;
  return {
    passRate,
    meanScore,
    sampleCount: Array.isArray(results.samples) ? results.samples.length : 0,
    ...(isPartial ? { partial: true } : {}),
  };
}

export type SuiteEntryOutcome = {
  readonly name: string;
  readonly dataset: string;
  readonly graders: string;
  readonly outDir: string;
  readonly passed: boolean;
  /** Why the entry failed — threshold breaches, the baseline gate's reason,
   *  or the error that stopped it. Empty when it passed. */
  readonly failures: ReadonlyArray<string>;
  readonly aggregates?: EntryAggregates;
  /** True when the entry did not produce results at all (crash/config). */
  readonly errored: boolean;
};

/** Absolute-threshold evaluation for one entry. A PARTIAL run always fails:
 *  its pass rate is deflated by synthetic errors, so "it cleared the floor"
 *  would be a number nobody can stand behind. */
export function evaluateEntryThresholds(
  aggregates: EntryAggregates,
  thresholds: SuiteThresholds | undefined,
): string[] {
  const failures: string[] = [];
  if (aggregates.partial === true) {
    failures.push("run is PARTIAL (budget exhausted) — an incomplete measurement cannot pass");
  }
  if (thresholds?.min_pass_rate !== undefined && aggregates.passRate < thresholds.min_pass_rate) {
    failures.push(
      `pass_rate ${(aggregates.passRate * 100).toFixed(1)}% < min_pass_rate ${(thresholds.min_pass_rate * 100).toFixed(1)}%`,
    );
  }
  if (
    thresholds?.min_mean_score !== undefined &&
    aggregates.meanScore < thresholds.min_mean_score
  ) {
    failures.push(
      `mean_score ${aggregates.meanScore.toFixed(3)} < min_mean_score ${thresholds.min_mean_score.toFixed(3)}`,
    );
  }
  return failures;
}

export type SuiteResult = {
  readonly suiteName: string;
  readonly tier: SuiteTier;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outDir: string;
  readonly passed: boolean;
  readonly entries: ReadonlyArray<SuiteEntryOutcome>;
};

/** A tier passes only when EVERY entry passed — the suite verdict is an AND,
 *  because a tier exists to be one required check. */
export function aggregateSuite(opts: {
  readonly suiteName: string;
  readonly tier: SuiteTier;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outDir: string;
  readonly entries: ReadonlyArray<SuiteEntryOutcome>;
}): SuiteResult {
  return {
    suiteName: opts.suiteName,
    tier: opts.tier,
    startedAt: opts.startedAt,
    endedAt: opts.endedAt,
    outDir: opts.outDir,
    passed: opts.entries.length > 0 && opts.entries.every((e) => e.passed),
    entries: opts.entries,
  };
}

/** The suite summary block (stdout + the text half of `suite.json`). */
export function renderSuiteSummary(result: SuiteResult): string {
  const lines: string[] = [];
  lines.push(
    `[suite] ${result.suiteName} tier=${result.tier}: ${result.passed ? "PASS" : "FAIL"} ` +
      `(${result.entries.filter((e) => e.passed).length}/${result.entries.length} entries passed)`,
  );
  for (const entry of result.entries) {
    const agg =
      entry.aggregates !== undefined
        ? `pass_rate ${(entry.aggregates.passRate * 100).toFixed(1)}%  mean ${entry.aggregates.meanScore.toFixed(3)}  n=${entry.aggregates.sampleCount}`
        : "no results";
    lines.push(`  ${entry.passed ? "PASS" : "FAIL"}  ${entry.name.padEnd(16)} ${agg}`);
    for (const failure of entry.failures) lines.push(`        ${failure}`);
  }
  lines.push(`[suite] summary: ${result.outDir}/suite.json`);
  return `${lines.join("\n")}\n`;
}
