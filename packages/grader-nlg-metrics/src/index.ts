import { GraderError } from "@crewhaus/eval-grader";
import type { GradeResult, Grader, RunResult, Sample } from "@crewhaus/eval-grader";

/**
 * Catalog R15 `grader-nlg-metrics` — Section 38 production NLG metric graders.
 *
 * Pure-TypeScript implementations of:
 *   ROUGE-1 / ROUGE-2 / ROUGE-L (Lin 2004, F-measure variant — uses
 *     LCS for ROUGE-L)
 *   BLEU-1 / BLEU-2 / BLEU-3 / BLEU-4 (Papineni et al 2002, with
 *     standard +1 modified n-gram precision smoothing and brevity
 *     penalty)
 *   METEOR (simplified Banerjee/Lavie 2005, F = (P*R)/(α*P+(1-α)*R)
 *     over unigram alignments + chunk penalty γ*(chunks/matches)^β;
 *     defaults α=0.9 β=3 γ=0.5)
 *
 * Each grader returns a `Grader` (function shape) that pulls the
 * reference from `sample.expected_output`. Throws `GraderError` if
 * the sample is missing `expected_output`. Threshold maps to the
 * pass/fail boundary: score ≥ threshold ⇒ passed.
 *
 * Register via §29 grader-registry:
 *   import { rougeL } from "@crewhaus/grader-nlg-metrics";
 *   registry.register("rouge_l", rougeL({ threshold: 0.8 }));
 *
 * Layer R15. Pairs with `eval-grader` (R-eval) and `grader-registry`
 * (§29 — pluggable named-grader registry).
 */

export type NlgMetricOptions = {
  /** 0..1 pass/fail boundary. Default 0.5 — callers should pin for production. */
  readonly threshold?: number;
  /** Override the per-call reference (else falls back to `sample.expected_output`). */
  readonly reference?: string;
  /** Lowercase before tokenizing. Defaults to true. */
  readonly lowercase?: boolean;
};

export type MeteorOptions = NlgMetricOptions & {
  readonly alpha?: number;
  readonly beta?: number;
  readonly gamma?: number;
};

const DEFAULT_THRESHOLD = 0.5;

function tokenize(text: string, lowercase = true): string[] {
  const t = lowercase ? text.toLowerCase() : text;
  return t
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(" ")
    .filter((s) => s.length > 0);
}

function ngrams(tokens: string[], n: number): Map<string, number> {
  const counts = new Map<string, number>();
  if (tokens.length < n) return counts;
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join(" ");
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function fMeasure(p: number, r: number, beta = 1): number {
  if (p === 0 && r === 0) return 0;
  const b2 = beta * beta;
  return ((1 + b2) * p * r) / (b2 * p + r);
}

function rougeN(reference: string, hypothesis: string, n: number, lowercase: boolean): number {
  const refTok = tokenize(reference, lowercase);
  const hypTok = tokenize(hypothesis, lowercase);
  const refGrams = ngrams(refTok, n);
  const hypGrams = ngrams(hypTok, n);
  if (refGrams.size === 0 || hypGrams.size === 0) return 0;
  let overlap = 0;
  for (const [gram, hypCount] of hypGrams) {
    const refCount = refGrams.get(gram) ?? 0;
    overlap += Math.min(refCount, hypCount);
  }
  let refTotal = 0;
  for (const v of refGrams.values()) refTotal += v;
  let hypTotal = 0;
  for (const v of hypGrams.values()) hypTotal += v;
  const recall = overlap / refTotal;
  const precision = overlap / hypTotal;
  return fMeasure(precision, recall);
}

function lcsLen(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  // Two-row DP, O(min(|a|,|b|)) memory.
  let prev = new Array<number>(b.length + 1).fill(0);
  let curr = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
      } else {
        const left = curr[j - 1] ?? 0;
        const up = prev[j] ?? 0;
        curr[j] = Math.max(left, up);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[b.length] ?? 0;
}

function rougeLScore(reference: string, hypothesis: string, lowercase: boolean): number {
  const refTok = tokenize(reference, lowercase);
  const hypTok = tokenize(hypothesis, lowercase);
  if (refTok.length === 0 || hypTok.length === 0) return 0;
  const lcs = lcsLen(refTok, hypTok);
  const recall = lcs / refTok.length;
  const precision = lcs / hypTok.length;
  return fMeasure(precision, recall);
}

function modifiedPrecision(
  reference: string,
  hypothesis: string,
  n: number,
  lowercase: boolean,
): { match: number; total: number } {
  const refTok = tokenize(reference, lowercase);
  const hypTok = tokenize(hypothesis, lowercase);
  const refGrams = ngrams(refTok, n);
  const hypGrams = ngrams(hypTok, n);
  let total = 0;
  for (const v of hypGrams.values()) total += v;
  let match = 0;
  for (const [g, h] of hypGrams) {
    const r = refGrams.get(g) ?? 0;
    match += Math.min(r, h);
  }
  return { match, total };
}

function bleuScore(reference: string, hypothesis: string, n: number, lowercase: boolean): number {
  const refTok = tokenize(reference, lowercase);
  const hypTok = tokenize(hypothesis, lowercase);
  if (hypTok.length === 0) return 0;
  let logSum = 0;
  for (let k = 1; k <= n; k++) {
    const { match, total } = modifiedPrecision(reference, hypothesis, k, lowercase);
    // +1 smoothing (NIST-style) keeps the score finite when a higher-order
    // n-gram is missing entirely. Ratio is (match+1)/(total+1).
    const ratio = (match + 1) / (total + 1);
    logSum += Math.log(ratio);
  }
  const geo = Math.exp(logSum / n);
  // Brevity penalty: c = hypothesis len; r = reference len.
  const c = hypTok.length;
  const r = refTok.length;
  const bp = c > r ? 1 : Math.exp(1 - r / c);
  return geo * bp;
}

function meteorScore(
  reference: string,
  hypothesis: string,
  alpha: number,
  beta: number,
  gamma: number,
  lowercase: boolean,
): number {
  const refTok = tokenize(reference, lowercase);
  const hypTok = tokenize(hypothesis, lowercase);
  if (refTok.length === 0 || hypTok.length === 0) return 0;
  // Greedy left-to-right alignment of hypothesis tokens to reference
  // tokens — each ref token can match at most once.
  const used = new Array<boolean>(refTok.length).fill(false);
  const matches: Array<{ hypIdx: number; refIdx: number }> = [];
  for (let i = 0; i < hypTok.length; i++) {
    for (let j = 0; j < refTok.length; j++) {
      if (used[j]) continue;
      if (hypTok[i] === refTok[j]) {
        matches.push({ hypIdx: i, refIdx: j });
        used[j] = true;
        break;
      }
    }
  }
  const m = matches.length;
  if (m === 0) return 0;
  const p = m / hypTok.length;
  const r = m / refTok.length;
  if (p === 0 || r === 0) return 0;
  const fmean = (p * r) / (alpha * p + (1 - alpha) * r);
  // Chunks: count maximal runs of matches that are adjacent in BOTH
  // hypothesis order AND reference order.
  let chunks = 1;
  for (let k = 1; k < matches.length; k++) {
    const cur = matches[k];
    const prev = matches[k - 1];
    if (cur === undefined || prev === undefined) continue;
    if (cur.hypIdx !== prev.hypIdx + 1 || cur.refIdx !== prev.refIdx + 1) {
      chunks += 1;
    }
  }
  const fragRatio = chunks / m;
  const penalty = gamma * fragRatio ** beta;
  return fmean * (1 - penalty);
}

function resolveReference(opts: NlgMetricOptions, sample: Sample): string {
  const ref = opts.reference ?? sample.expected_output;
  if (typeof ref !== "string" || ref.length === 0) {
    throw new GraderError(
      `${opts.reference !== undefined ? "options.reference" : "sample.expected_output"} is required`,
    );
  }
  return ref;
}

function makeGrader(
  metricName: string,
  computeScore: (ref: string, hyp: string) => number,
  threshold: number,
): Grader {
  return async (sample: Sample, runResult: RunResult): Promise<GradeResult> => {
    const ref = resolveReference({ reference: undefined }, sample);
    const score = computeScore(ref, runResult.agentOutput);
    return {
      passed: score >= threshold,
      score,
      rationale: `${metricName} score ${score.toFixed(4)} (threshold ${threshold.toFixed(2)})`,
    };
  };
}

export function rouge1(opts: NlgMetricOptions = {}): Grader {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const lowercase = opts.lowercase !== false;
  return async (sample, runResult) => {
    const ref = resolveReference(opts, sample);
    const score = rougeN(ref, runResult.agentOutput, 1, lowercase);
    return {
      passed: score >= threshold,
      score,
      rationale: `ROUGE-1 ${score.toFixed(4)} (threshold ${threshold.toFixed(2)})`,
    };
  };
}

export function rouge2(opts: NlgMetricOptions = {}): Grader {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const lowercase = opts.lowercase !== false;
  return async (sample, runResult) => {
    const ref = resolveReference(opts, sample);
    const score = rougeN(ref, runResult.agentOutput, 2, lowercase);
    return {
      passed: score >= threshold,
      score,
      rationale: `ROUGE-2 ${score.toFixed(4)} (threshold ${threshold.toFixed(2)})`,
    };
  };
}

export function rougeL(opts: NlgMetricOptions = {}): Grader {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const lowercase = opts.lowercase !== false;
  return async (sample, runResult) => {
    const ref = resolveReference(opts, sample);
    const score = rougeLScore(ref, runResult.agentOutput, lowercase);
    return {
      passed: score >= threshold,
      score,
      rationale: `ROUGE-L ${score.toFixed(4)} (threshold ${threshold.toFixed(2)})`,
    };
  };
}

export function bleu(n: 1 | 2 | 3 | 4, opts: NlgMetricOptions = {}): Grader {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const lowercase = opts.lowercase !== false;
  return async (sample, runResult) => {
    const ref = resolveReference(opts, sample);
    const score = bleuScore(ref, runResult.agentOutput, n, lowercase);
    return {
      passed: score >= threshold,
      score,
      rationale: `BLEU-${n} ${score.toFixed(4)} (threshold ${threshold.toFixed(2)})`,
    };
  };
}

export function bleu1(opts: NlgMetricOptions = {}): Grader {
  return bleu(1, opts);
}
export function bleu2(opts: NlgMetricOptions = {}): Grader {
  return bleu(2, opts);
}
export function bleu3(opts: NlgMetricOptions = {}): Grader {
  return bleu(3, opts);
}
export function bleu4(opts: NlgMetricOptions = {}): Grader {
  return bleu(4, opts);
}

export function meteor(opts: MeteorOptions = {}): Grader {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const lowercase = opts.lowercase !== false;
  const alpha = opts.alpha ?? 0.9;
  const beta = opts.beta ?? 3;
  const gamma = opts.gamma ?? 0.5;
  return async (sample, runResult) => {
    const ref = resolveReference(opts, sample);
    const score = meteorScore(ref, runResult.agentOutput, alpha, beta, gamma, lowercase);
    return {
      passed: score >= threshold,
      score,
      rationale: `METEOR ${score.toFixed(4)} (threshold ${threshold.toFixed(2)})`,
    };
  };
}

export {
  rougeN as _rougeNForTest,
  rougeLScore as _rougeLScoreForTest,
  bleuScore as _bleuScoreForTest,
  meteorScore as _meteorScoreForTest,
  tokenize as _tokenizeForTest,
  makeGrader as _makeGraderForTest,
};
