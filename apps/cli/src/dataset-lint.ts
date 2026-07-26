/**
 * B26 + NEW-HUNT-10 + B18 — the offline dataset lint engine behind
 * `crewhaus dataset lint` and the `crewhaus eval` preflight. Every rule is
 * pure and model-free (nothing leaves the process):
 *
 *   duplicate-id              same sample id twice in one dataset (ERROR —
 *                             per-sample artifact dirs collide and the
 *                             id-keyed flip detection the strict gate relies
 *                             on silently corrupts)
 *   cross-version-id-reuse    an id reused in another version of the same
 *                             registry dataset with DIFFERENT content
 *                             (warning — switching versions makes the gate
 *                             flip-compare two different questions under one
 *                             id; identical content across versions is
 *                             normal lineage and never flagged)
 *   near-duplicate-input      two samples whose normalized token sets
 *                             overlap ≥ {@link NEAR_DUP_THRESHOLD} (warning
 *                             — duplicated content overweights slices)
 *   grader-gold-mismatch      gold-needing graders (exact_match /
 *                             expected_contains, plus registry `nlg.*` /
 *                             `semantic.similarity` refs without an
 *                             `opts.reference` override — those packs
 *                             throw per sample without a gold) declared
 *                             while samples carry no expected_output
 *                             (ERROR when NO sample has a gold —
 *                             all-fail-by-construction; warning when only
 *                             some lack it)
 *   expected-tools-no-tools   samples declare expected_tools but the
 *                             conventional spec exposes no tools (warning)
 *   provenance-source         `metadata.source` outside the B22 taxonomy
 *                             (warning, offenders listed)
 *   empty-gold                expected_output present but empty/whitespace
 *                             (ERROR — a vacuous gold trivially matches
 *                             `expected_contains`)
 *   canary-leak               a B18 canary phrase from the dataset found in
 *                             the spec text or a few-shot pool (ERROR —
 *                             eval content leaked into the prompt)
 *
 * Kept side-effect-free mirroring `dataset-audit.ts`: the CLI face (context
 * discovery — cwd spec, conventional graders, few-shot pools — and exit
 * codes) lives in `index.ts`.
 */
import { hashSample } from "@crewhaus/dataset-registry";
import type { Sample } from "@crewhaus/eval-dataset";
import { SOURCE_TAXONOMY, sampleSource } from "./datasets";

export type LintSeverity = "error" | "warning";

export type LintRule =
  | "duplicate-id"
  | "cross-version-id-reuse"
  | "near-duplicate-input"
  | "grader-gold-mismatch"
  | "expected-tools-no-tools"
  | "provenance-source"
  | "empty-gold"
  | "canary-leak";

export type LintFinding = {
  readonly rule: LintRule;
  readonly severity: LintSeverity;
  readonly message: string;
  /** The offending sample ids, when the rule names specific samples. */
  readonly sampleIds?: ReadonlyArray<string>;
};

/** How many sample ids a finding message spells out before eliding. */
const LINT_MAX_IDS = 8;

/** Token-overlap threshold for the near-duplicate warning (locked ≥ 0.9). */
export const NEAR_DUP_THRESHOLD = 0.9;

/** Pairwise-comparison budget for the near-dup scan — beyond it the scan is
 *  skipped with a note rather than stalling lint on a 100k-row dataset. */
const NEAR_DUP_MAX_COMPARISONS = 4_000_000;

function idList(ids: ReadonlyArray<string>): string {
  const shown = ids.slice(0, LINT_MAX_IDS).join(", ");
  return ids.length > LINT_MAX_IDS ? `${shown} +${ids.length - LINT_MAX_IDS} more` : shown;
}

// -------- rule: duplicate ids --------

/** Duplicate ids within one dataset — one ERROR finding per duplicated id. */
export function findDuplicateIds(samples: ReadonlyArray<Sample>): LintFinding[] {
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  const findings: LintFinding[] = [];
  for (const [id, n] of counts) {
    if (n < 2) continue;
    findings.push({
      rule: "duplicate-id",
      severity: "error",
      message: `duplicate sample id "${id}" (${n} occurrences) — per-sample artifact dirs collide and id-keyed regression flips corrupt`,
      sampleIds: [id],
    });
  }
  return findings;
}

// -------- rule: cross-version id reuse --------

/**
 * Ids reused in OTHER versions of the same registry dataset with DIFFERENT
 * content (`hashSample` divergence). Same-content reuse across versions is
 * the normal lineage of an append-only registry and never flagged.
 */
export function findCrossVersionIdReuse(
  current: { readonly version: string; readonly samples: ReadonlyArray<Sample> },
  others: ReadonlyArray<{ readonly version: string; readonly samples: ReadonlyArray<Sample> }>,
): LintFinding[] {
  const currentById = new Map(current.samples.map((s) => [s.id, hashSample(s)]));
  const findings: LintFinding[] = [];
  for (const other of others) {
    const clashing: string[] = [];
    for (const s of other.samples) {
      const hash = currentById.get(s.id);
      if (hash !== undefined && hash !== hashSample(s)) clashing.push(s.id);
    }
    if (clashing.length === 0) continue;
    findings.push({
      rule: "cross-version-id-reuse",
      severity: "warning",
      message: `${clashing.length} id(s) reused with different content vs version ${other.version}: ${idList(clashing)} — switching versions flip-compares different questions under one id`,
      sampleIds: clashing,
    });
  }
  return findings;
}

// -------- rule: near-duplicate inputs --------

/** Normalized token set: lowercased, split on non-alphanumerics. */
export function normalizedTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t !== ""),
  );
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Pairs of samples whose normalized input token overlap is ≥ `threshold`
 * (Jaccard). Canary samples are exempt (their inputs are engineered hex).
 * Bounded by {@link NEAR_DUP_MAX_COMPARISONS} — an oversized dataset skips
 * the scan with a note finding rather than an O(n²) stall.
 */
export function findNearDuplicates(
  samples: ReadonlyArray<Sample>,
  threshold: number = NEAR_DUP_THRESHOLD,
): LintFinding[] {
  const eligible = samples.filter((s) => sampleSource(s) !== "canary");
  const pairsNeeded = (eligible.length * (eligible.length - 1)) / 2;
  if (pairsNeeded > NEAR_DUP_MAX_COMPARISONS) {
    return [
      {
        rule: "near-duplicate-input",
        severity: "warning",
        message: `near-duplicate scan skipped: ${eligible.length} samples need ${pairsNeeded} comparisons (cap ${NEAR_DUP_MAX_COMPARISONS})`,
      },
    ];
  }
  const tokens = eligible.map((s) => normalizedTokens(s.input));
  const findings: LintFinding[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const a = tokens[i] as Set<string>;
    for (let j = i + 1; j < eligible.length; j++) {
      const b = tokens[j] as Set<string>;
      // Size prefilter: overlap can't reach the threshold when the smaller
      // set is under threshold × the larger (Jaccard ≤ min/max).
      const [lo, hi] = a.size <= b.size ? [a.size, b.size] : [b.size, a.size];
      if (hi === 0 || lo / hi < threshold) continue;
      const overlap = jaccard(a, b);
      if (overlap < threshold) continue;
      const idA = (eligible[i] as Sample).id;
      const idB = (eligible[j] as Sample).id;
      findings.push({
        rule: "near-duplicate-input",
        severity: "warning",
        message: `near-duplicate inputs "${idA}" / "${idB}" (token overlap ${overlap.toFixed(2)}) — duplicated content overweights slices and pass rates`,
        sampleIds: [idA, idB],
      });
    }
  }
  return findings;
}

// -------- rule: grader ↔ dataset mismatch --------

/** The graders.yaml grader types whose grading REQUIRES `expected_output`. */
export const GOLD_NEEDING_GRADER_TYPES: ReadonlyArray<string> = [
  "exact_match",
  "expected_contains",
];

/** The view of a graders.yaml the lint rules need — derivable from
 *  `GradersConfig.graders` without importing the compile machinery. */
export type LintGraderSpec = {
  readonly name: string;
  readonly type: string;
  /** `type: "registry"` entries — the registry pack ref (e.g. "nlg.rougeL"),
   *  so the gold-mismatch rule can recognize gold-needing first-party packs. */
  readonly registryGrader?: string;
  /** `type: "registry"` entries — the entry's `opts` declare a `reference`
   *  override, so grading no longer reads `sample.expected_output`. */
  readonly hasReferenceOverride?: boolean;
};

/**
 * Map one parsed graders.yaml entry (any variant of the GraderSpec union —
 * structural, so this module needs no `@crewhaus/eval-grader` import) to the
 * lint view. Registry entries keep their pack ref and whether `opts` carry a
 * `reference` override; every other variant is (name, type) as before.
 */
export function lintGraderSpecOf(g: {
  readonly name: string;
  readonly type: string;
  readonly grader?: string;
  readonly opts?: Readonly<Record<string, unknown>>;
}): LintGraderSpec {
  if (g.type !== "registry" || g.grader === undefined) return { name: g.name, type: g.type };
  return {
    name: g.name,
    type: g.type,
    registryGrader: g.grader,
    ...(g.opts !== undefined && g.opts["reference"] !== undefined
      ? { hasReferenceOverride: true }
      : {}),
  };
}

/**
 * Does this grader require `expected_output` on every graded sample?
 * True for the deterministic gold-matching types, and for `type: registry`
 * entries naming a first-party pack whose grading throws without a gold —
 * every `nlg.*` metric and `semantic.similarity` resolve their reference as
 * `opts.reference ?? sample.expected_output` and raise a per-sample
 * GraderError when both are absent (burning the full agent spend before any
 * grade lands). An `opts.reference` override lifts the requirement. Unknown
 * / third-party registry refs are NEVER assumed gold-needing, so foreign
 * packs can't false-positive.
 *
 * D44 — exported so `eval coverage --graders` reports the SAME gold-needing
 * set this lint enforces (two surfaces, one predicate).
 */
export function graderNeedsGold(g: LintGraderSpec): boolean {
  if (GOLD_NEEDING_GRADER_TYPES.includes(g.type)) return true;
  if (g.type !== "registry" || g.hasReferenceOverride === true) return false;
  const ref = g.registryGrader;
  return ref !== undefined && (ref.startsWith("nlg.") || ref === "semantic.similarity");
}

/** How a gold-needing grader is named in findings: the registry ref when
 *  there is one (more actionable than the bare "registry" type). */
function describeGrader(g: LintGraderSpec): string {
  return `"${g.name}" (${g.registryGrader ?? g.type})`;
}

/**
 * Gold-needing graders vs gold-less samples. ERROR when NO sample carries a
 * gold (every one of those graders fails by construction — the run burns
 * spend to measure nothing); warning when only some samples lack it (those
 * samples auto-fail, which may or may not be intended).
 */
export function findGraderGoldMismatch(
  samples: ReadonlyArray<Sample>,
  graders: ReadonlyArray<LintGraderSpec>,
): LintFinding[] {
  const goldNeeding = graders.filter(graderNeedsGold);
  if (goldNeeding.length === 0) return [];
  const goldless = samples.filter(
    (s) =>
      sampleSource(s) !== "canary" &&
      (s.expected_output === undefined || s.expected_output.trim() === ""),
  );
  if (goldless.length === 0) return [];
  const graderNames = goldNeeding.map(describeGrader).join(", ");
  const nonCanary = samples.filter((s) => sampleSource(s) !== "canary").length;
  const allGoldless = goldless.length === nonCanary;
  return [
    {
      rule: "grader-gold-mismatch",
      severity: allGoldless ? "error" : "warning",
      message: allGoldless
        ? `grader(s) ${graderNames} need expected_output but NO sample carries one — every sample fails by construction`
        : `grader(s) ${graderNames} need expected_output but ${goldless.length}/${nonCanary} sample(s) carry none — those samples auto-fail: ${idList(goldless.map((s) => s.id))}`,
      sampleIds: goldless.map((s) => s.id),
    },
  ];
}

/**
 * Samples declare `expected_tools` but the conventional spec exposes no
 * tools — `tool_call_sequence` graders and toolCallAccuracy can never match.
 * Only fires when the caller POSITIVELY knows the spec is tool-less
 * (`specHasTools === false`); unknown spec → no finding.
 */
export function findExpectedToolsNoTools(
  samples: ReadonlyArray<Sample>,
  specHasTools: boolean | undefined,
): LintFinding[] {
  if (specHasTools !== false) return [];
  const withTools = samples.filter(
    (s) => s.expected_tools !== undefined && s.expected_tools.length > 0,
  );
  if (withTools.length === 0) return [];
  return [
    {
      rule: "expected-tools-no-tools",
      severity: "warning",
      message: `${withTools.length} sample(s) declare expected_tools but the spec exposes no tools — tool expectations can never be met: ${idList(withTools.map((s) => s.id))}`,
      sampleIds: withTools.map((s) => s.id),
    },
  ];
}

// -------- rule: provenance taxonomy --------

/** B22 — `metadata.source` values outside {@link SOURCE_TAXONOMY} (warning,
 *  one finding per distinct off-taxonomy value, offenders listed). */
export function findOffTaxonomyProvenance(samples: ReadonlyArray<Sample>): LintFinding[] {
  const byValue = new Map<string, string[]>();
  for (const s of samples) {
    const source = sampleSource(s);
    if (source === undefined || SOURCE_TAXONOMY.includes(source)) continue;
    const ids = byValue.get(source);
    if (ids !== undefined) ids.push(s.id);
    else byValue.set(source, [s.id]);
  }
  const findings: LintFinding[] = [];
  for (const [value, ids] of byValue) {
    findings.push({
      rule: "provenance-source",
      severity: "warning",
      message: `metadata.source "${value}" is outside the provenance taxonomy (${SOURCE_TAXONOMY.join(" | ")}) — ${ids.length} sample(s): ${idList(ids)}`,
      sampleIds: ids,
    });
  }
  return findings;
}

// -------- rule: empty golds --------

/** `expected_output` present but empty/whitespace — a vacuous gold that
 *  trivially satisfies `expected_contains` and can never satisfy a human. */
export function findEmptyGolds(samples: ReadonlyArray<Sample>): LintFinding[] {
  const empty = samples.filter(
    (s) => s.expected_output !== undefined && s.expected_output.trim() === "",
  );
  if (empty.length === 0) return [];
  return [
    {
      rule: "empty-gold",
      severity: "error",
      message: `${empty.length} sample(s) carry an empty-string expected_output — a vacuous gold (drop the field or fill it in): ${idList(empty.map((s) => s.id))}`,
      sampleIds: empty.map((s) => s.id),
    },
  ];
}

// -------- rule: canary leaks (B18) --------

/** The 32-hex canary phrase embedded in a canary sample's input (see
 *  `canarySample` in ./datasets). */
const CANARY_PHRASE_RE = /\b[0-9a-f]{32}\b/;

/** The canary phrases a sample set carries: (sampleId, phrase) per
 *  `metadata.source: "canary"` sample whose input embeds a 32-hex phrase. */
export function canaryPhrasesIn(
  samples: ReadonlyArray<Sample>,
): Array<{ sampleId: string; phrase: string }> {
  const out: Array<{ sampleId: string; phrase: string }> = [];
  for (const s of samples) {
    if (sampleSource(s) !== "canary") continue;
    const m = CANARY_PHRASE_RE.exec(s.input);
    if (m !== null) out.push({ sampleId: s.id, phrase: m[0] });
  }
  return out;
}

/** One scannable prompt-side text (spec yaml, a few-shot pool file, …). */
export type LeakScanText = {
  /** Human-readable origin, e.g. `crewhaus.yaml` or the pool path. */
  readonly label: string;
  readonly text: string;
};

/**
 * B18 — the contamination scan: any canary phrase found in prompt-side text
 * is an ERROR (the phrase exists nowhere but the dataset, so its appearance
 * in instructions or a few-shot pool proves eval content leaked).
 */
export function findCanaryLeaks(
  phrases: ReadonlyArray<{ sampleId: string; phrase: string }>,
  texts: ReadonlyArray<LeakScanText>,
): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const { sampleId, phrase } of phrases) {
    for (const { label, text } of texts) {
      if (!text.includes(phrase)) continue;
      findings.push({
        rule: "canary-leak",
        severity: "error",
        message: `canary phrase from sample "${sampleId}" found in ${label} — eval content leaked into the prompt (contamination)`,
        sampleIds: [sampleId],
      });
    }
  }
  return findings;
}

// -------- orchestration --------

export type LintDatasetOptions = {
  readonly samples: ReadonlyArray<Sample>;
  /** Graders to check compatibility against (absent → rule skipped). */
  readonly graders?: ReadonlyArray<LintGraderSpec>;
  /** Whether the conventional spec exposes tools (undefined → unknown →
   *  the expected-tools rule is skipped). */
  readonly specHasTools?: boolean;
  /** Prompt-side texts for the canary leak scan (spec yaml, few-shot pools). */
  readonly leakScanTexts?: ReadonlyArray<LeakScanText>;
  /** Other versions of the same registry dataset for cross-version id
   *  checks (absent for file datasets). */
  readonly otherVersions?: ReadonlyArray<{
    readonly version: string;
    readonly samples: ReadonlyArray<Sample>;
  }>;
  /** The linted version (labels cross-version findings). */
  readonly version?: string;
};

/** Run every offline rule the provided context enables, error findings
 *  first (stable within severity). */
export function lintDataset(opts: LintDatasetOptions): LintFinding[] {
  const findings: LintFinding[] = [
    ...findDuplicateIds(opts.samples),
    ...(opts.otherVersions !== undefined
      ? findCrossVersionIdReuse(
          { version: opts.version ?? "current", samples: opts.samples },
          opts.otherVersions,
        )
      : []),
    ...findNearDuplicates(opts.samples),
    ...(opts.graders !== undefined ? findGraderGoldMismatch(opts.samples, opts.graders) : []),
    ...findExpectedToolsNoTools(opts.samples, opts.specHasTools),
    ...findOffTaxonomyProvenance(opts.samples),
    ...findEmptyGolds(opts.samples),
    ...findCanaryLeaks(canaryPhrasesIn(opts.samples), opts.leakScanTexts ?? []),
  ];
  // Errors first; original rule order otherwise (sort is stable).
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

/** Render findings as CLI lines (severity-tagged, one per finding). */
export function renderLintFindings(findings: ReadonlyArray<LintFinding>, label: string): string[] {
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  const suffix = findings.length === 0 ? " — clean" : "";
  const lines = [`[dataset lint] ${label}: ${errors} error(s), ${warnings} warning(s)${suffix}`];
  for (const f of findings) {
    lines.push(`  ${f.severity === "error" ? "ERROR" : "warn "} ${f.rule}: ${f.message}`);
  }
  return lines;
}

// -------- eval preflight (NEW-HUNT-10, lint-lite) --------

export type PreflightSample = {
  readonly id: string;
  readonly hasGold: boolean;
  /** B18 — canary tripwires are gold-less BY DESIGN and excluded from the
   *  gold-mismatch math (they never count toward "goldless"). */
  readonly isCanary?: boolean;
};

export type PreflightResult = {
  /** Refusal reasons — `crewhaus eval` dies on any (pre-spend), unless
   *  `--no-preflight`. */
  readonly refusals: string[];
  /** Non-fatal notes, printed to stderr. */
  readonly warnings: string[];
};

/**
 * NEW-HUNT-10 — the lint-lite `crewhaus eval` runs BEFORE any model spend:
 * duplicate sample ids (always a refusal — the run's own artifacts would
 * corrupt) and the grader↔dataset gold mismatch (a refusal only when NO
 * sample carries a gold — the run measures nothing by construction; partial
 * gold-lessness is a warning, since mixed datasets can be intentional).
 * Deliberately streaming-friendly: consumes only (id, hasGold) pairs so the
 * file path can preflight without materializing sample bodies.
 */
export function preflightLint(
  samples: ReadonlyArray<PreflightSample>,
  graders: ReadonlyArray<LintGraderSpec>,
): PreflightResult {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (n < 2) continue;
    refusals.push(
      `duplicate sample id "${id}" (${n} occurrences) — per-sample artifact dirs would collide and the baseline gate's flip detection would corrupt`,
    );
  }
  const goldNeeding = graders.filter(graderNeedsGold);
  if (goldNeeding.length > 0) {
    const gradeable = samples.filter((s) => s.isCanary !== true);
    const goldless = gradeable.filter((s) => !s.hasGold).length;
    const graderNames = goldNeeding.map(describeGrader).join(", ");
    if (goldless === gradeable.length && gradeable.length > 0) {
      refusals.push(
        `grader(s) ${graderNames} need expected_output but NO sample carries one — every sample would fail by construction`,
      );
    } else if (goldless > 0) {
      warnings.push(
        `[eval] preflight warning: grader(s) ${graderNames} need expected_output but ${goldless}/${gradeable.length} sample(s) carry none — those samples auto-fail`,
      );
    }
  }
  return { refusals, warnings };
}
