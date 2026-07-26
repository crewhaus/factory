/**
 * C28 — `crewhaus eval plan`: the sample-size helper.
 *
 * Teams gate releases on eight-sample datasets and then wonder why the gate
 * is noisy. The arithmetic that answers "how many samples do I need to see
 * the regression I care about" is one line —
 *
 *     n ≈ z² · p(1−p) / e²
 *
 * — so this command computes it, prints every term it used, and says where
 * each number came from. Pure arithmetic: offline, credential-free, no model
 * call, no run. `--pilot <runDir>` reads a previous run's measured pass rate
 * (the p the formula wants); without it the planner uses p = 0.5, the
 * variance-maximizing worst case, and says so.
 *
 * Side-effect-free (the CLI entry file runs an argv switch on import) apart
 * from the injectable pilot reader, so the arithmetic is unit-testable
 * without touching the filesystem.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Thrown on unusable flags / an unreadable pilot run. The CLI routes it
 *  through `die()`; tests assert on `.message`. */
export class EvalPlanError extends Error {
  override readonly name = "EvalPlanError";
}

export type EvalPlanInput = {
  /** The smallest pass-rate change worth detecting, as a FRACTION (0.05 = 5
   *  percentage points). */
  readonly targetDelta: number;
  /** Two-sided confidence level, default 0.95. */
  readonly confidence?: number;
  /** Directory of a previous run whose measured pass rate seeds p. */
  readonly pilotRunDir?: string;
  /** Injectable pilot reader (defaults to reading `results.json`). */
  readonly readPilot?: (runDir: string) => string;
};

export type EvalPlan = {
  readonly targetDelta: number;
  readonly confidence: number;
  /** Two-sided normal critical value for {@link confidence}. */
  readonly z: number;
  /** The pass rate the variance term used. */
  readonly p: number;
  /** Where `p` came from. */
  readonly pSource: "pilot" | "worst-case";
  /** The pilot run's id, when a pilot supplied `p`. */
  readonly pilotRunId?: string;
  readonly pilotSampleCount?: number;
  /** Raw (unrounded) n from the formula. */
  readonly rawN: number;
  /** Required samples — `ceil(rawN)`. */
  readonly n: number;
  /**
   * Samples needed when COMPARING two runs (before vs after): each side
   * carries its own sampling error, so the same detectable delta needs
   * twice the variance budget — 2·n, the paired-comparison rule of thumb.
   */
  readonly nPerArmForComparison: number;
  /** The smallest delta the PILOT's own n could detect, when a pilot ran. */
  readonly pilotDetectableDelta?: number;
};

/**
 * Two-sided normal critical value z for a confidence level, via the
 * Beasley-Springer-Moro / Acklam rational approximation of the inverse
 * normal CDF (|error| < 1.15e-9 — far tighter than any sample-size decision
 * needs, and deterministic, unlike a table lookup that silently rounds an
 * unlisted confidence to the nearest listed one).
 */
export function zForConfidence(confidence: number): number {
  if (!(confidence > 0 && confidence < 1)) {
    throw new EvalPlanError(
      `--confidence must be strictly between 0 and 1 (got ${confidence}) — 0.95 means a 95% two-sided interval`,
    );
  }
  return inverseNormalCdf(1 - (1 - confidence) / 2);
}

const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

/** Φ⁻¹(q) for q in (0, 1) — Acklam's rational approximation. */
export function inverseNormalCdf(q: number): number {
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  const at = (arr: ReadonlyArray<number>, i: number): number => arr[i] as number;
  const tail = (s: number): number =>
    (((((at(C, 0) * s + at(C, 1)) * s + at(C, 2)) * s + at(C, 3)) * s + at(C, 4)) * s + at(C, 5)) /
    ((((at(D, 0) * s + at(D, 1)) * s + at(D, 2)) * s + at(D, 3)) * s + 1);
  if (q < pLow) return tail(Math.sqrt(-2 * Math.log(q)));
  if (q > pHigh) return -tail(Math.sqrt(-2 * Math.log(1 - q)));
  const s = q - 0.5;
  const r = s * s;
  return (
    ((((((at(A, 0) * r + at(A, 1)) * r + at(A, 2)) * r + at(A, 3)) * r + at(A, 4)) * r + at(A, 5)) *
      s) /
    (((((at(B, 0) * r + at(B, 1)) * r + at(B, 2)) * r + at(B, 3)) * r + at(B, 4)) * r + 1)
  );
}

/** The pilot fields the planner reads out of a run directory. */
type PilotSummary = {
  runId?: string;
  aggregates?: { passRate?: number };
  samples?: ReadonlyArray<unknown>;
};

function readPilotRun(
  runDir: string,
  read: (runDir: string) => string,
): { passRate: number; runId?: string; sampleCount?: number } {
  let text: string;
  try {
    text = read(runDir);
  } catch (err) {
    throw new EvalPlanError(
      `--pilot "${runDir}" is not a readable eval run directory (${err instanceof Error ? err.message : String(err)}) — point it at a directory containing results.json`,
    );
  }
  let parsed: PilotSummary;
  try {
    parsed = JSON.parse(text) as PilotSummary;
  } catch (err) {
    throw new EvalPlanError(
      `--pilot "${runDir}": results.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const passRate = parsed.aggregates?.passRate;
  if (typeof passRate !== "number" || !Number.isFinite(passRate) || passRate < 0 || passRate > 1) {
    throw new EvalPlanError(
      `--pilot "${runDir}": results.json has no usable aggregates.passRate — the pilot must be a completed eval run`,
    );
  }
  return {
    passRate,
    ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
    ...(Array.isArray(parsed.samples) ? { sampleCount: parsed.samples.length } : {}),
  };
}

/**
 * The plan: n ≈ z²·p(1−p)/e², with p from the pilot when given and the
 * worst-case 0.5 otherwise.
 */
export function planSampleSize(input: EvalPlanInput): EvalPlan {
  const e = input.targetDelta;
  if (!Number.isFinite(e) || e <= 0 || e >= 1) {
    throw new EvalPlanError(
      `--target-delta must be a fraction strictly between 0 and 1 (got ${JSON.stringify(e)}) — 0.05 means "detect a 5 percentage-point change"`,
    );
  }
  const confidence = input.confidence ?? 0.95;
  const z = zForConfidence(confidence);

  let p = 0.5;
  let pSource: EvalPlan["pSource"] = "worst-case";
  let pilotRunId: string | undefined;
  let pilotSampleCount: number | undefined;
  if (input.pilotRunDir !== undefined) {
    const read =
      input.readPilot ?? ((dir: string) => readFileSync(join(dir, "results.json"), "utf-8"));
    const pilot = readPilotRun(input.pilotRunDir, read);
    p = pilot.passRate;
    pSource = "pilot";
    pilotRunId = pilot.runId;
    pilotSampleCount = pilot.sampleCount;
  }

  const rawN = (z * z * p * (1 - p)) / (e * e);
  const n = Math.max(1, Math.ceil(rawN));
  const pilotDetectableDelta =
    pilotSampleCount !== undefined && pilotSampleCount > 0
      ? z * Math.sqrt((p * (1 - p)) / pilotSampleCount)
      : undefined;
  return {
    targetDelta: e,
    confidence,
    z,
    p,
    pSource,
    ...(pilotRunId !== undefined ? { pilotRunId } : {}),
    ...(pilotSampleCount !== undefined ? { pilotSampleCount } : {}),
    rawN,
    n,
    nPerArmForComparison: Math.max(1, Math.ceil(rawN * 2)),
    ...(pilotDetectableDelta !== undefined ? { pilotDetectableDelta } : {}),
  };
}

const pp = (fraction: number): string => `${(fraction * 100).toFixed(1)}pp`;

/** z_β for 80% power — the conventional target when a paper says "powered". */
export const Z_POWER_80 = 0.8416212335729143;

/**
 * How much bigger n must be to DETECT a delta of e with ~80% power rather
 * than merely estimate the rate to ±e: the interval formula uses z_α², a
 * two-sided test at that α with power 1−β uses (z_α+z_β)². At 95%/80% that
 * is ≈2.04×; at 99% it is ≈1.76×, which is why it is computed from the
 * plan's own z instead of quoted as a flat "2×".
 */
export function powerFactor(z: number): number {
  const ratio = (z + Z_POWER_80) / z;
  return ratio * ratio;
}

/** {@link powerFactor} applied to the plan's raw n, rounded up. */
export function powerAdjustedN(plan: EvalPlan): number {
  return Math.max(1, Math.ceil(plan.rawN * powerFactor(plan.z)));
}

/**
 * Render the plan so it TEACHES: every term, its source, the substituted
 * arithmetic, and the two caveats that decide whether the number is usable
 * (a comparison needs both sides; a pilot's own n bounds what it could ever
 * have detected).
 */
export function renderEvalPlan(plan: EvalPlan): string {
  const lines: string[] = [];
  lines.push("eval sample-size plan");
  lines.push(
    "  formula:          n ≈ z² · p(1−p) / e²   (normal approximation to a binomial proportion)",
  );
  lines.push(
    `  z:                ${plan.z.toFixed(3)}   (two-sided ${(plan.confidence * 100).toFixed(1)}% confidence)`,
  );
  lines.push(
    plan.pSource === "pilot"
      ? `  p:                ${plan.p.toFixed(3)}   (pilot ${plan.pilotRunId ?? "run"}${
          plan.pilotSampleCount !== undefined ? `, n=${plan.pilotSampleCount}` : ""
        } measured pass rate)`
      : "  p:                0.500   (worst case — no --pilot; p(1−p) is largest at 0.5, so this over-estimates on purpose)",
  );
  lines.push(
    `  e:                ${plan.targetDelta.toFixed(3)}   (${pp(plan.targetDelta)} — the smallest change worth detecting)`,
  );
  lines.push(
    `  n = ${plan.z.toFixed(3)}² · ${plan.p.toFixed(3)}·${(1 - plan.p).toFixed(3)} / ${plan.targetDelta.toFixed(3)}² = ${plan.rawN.toFixed(2)} → ${plan.n} samples`,
  );
  lines.push("");
  lines.push(
    `  → grade ${plan.n} samples to pin the pass rate to ±${pp(plan.targetDelta)} at ${(plan.confidence * 100).toFixed(0)}% confidence.`,
  );
  lines.push(
    `  → comparing TWO runs (before vs after) doubles the variance: budget ~${plan.nPerArmForComparison} samples per run.`,
  );
  if (plan.pilotDetectableDelta !== undefined && plan.pilotSampleCount !== undefined) {
    lines.push(
      `  → the pilot's own n=${plan.pilotSampleCount} can only resolve ±${pp(plan.pilotDetectableDelta)} — ` +
        `${plan.pilotDetectableDelta > plan.targetDelta ? "too coarse for" : "already fine enough for"} a ${pp(plan.targetDelta)} target.`,
    );
  }
  lines.push(
    "  Caveat: this sizes ONE pass-rate estimate under i.i.d. sampling. Correlated samples",
  );
  lines.push(
    "  (paraphrases of one prompt), flaky samples, and judge noise all need more, not fewer.",
  );
  // The formula carries no power term (z_β), so at exactly n a true delta of
  // e clears the interval about half the time. Saying so is the whole point
  // of a metric-literacy command — an "n to detect e" that silently means
  // "50% chance of detecting e" is exactly the kind of number this verb
  // exists to stop people from trusting.
  lines.push(
    `  Caveat: this sizes an ESTIMATE's WIDTH, not a test's POWER — it has no z_β term, so at`,
  );
  lines.push(
    `  n=${plan.n} a true ${pp(plan.targetDelta)} change is detected only ~50% of the time. For ~80% power use`,
  );
  lines.push(
    `  (z_α+z_β)² in place of z_α²: ~${powerAdjustedN(plan)} samples (${(powerFactor(plan.z)).toFixed(2)}× these). Compounds with the`,
  );
  lines.push("  two-run doubling above when you want both.");
  return `${lines.join("\n")}\n`;
}
