import type { z } from "zod";
import { GraderError } from "./errors";
import { evalJsonPath } from "./json-path";
import type { GradeResult, Grader } from "./types";

const PASS: GradeResult = { passed: true, score: 1, rationale: "" };

function fail(rationale: string, score = 0): GradeResult {
  return { passed: false, score, rationale };
}

function pass(rationale = ""): GradeResult {
  return rationale === "" ? PASS : { passed: true, score: 1, rationale };
}

// -------- exactMatch --------

export type ExactMatchOptions = {
  /** Trim whitespace before comparing (default: true). */
  readonly trim?: boolean;
  /** Case-insensitive comparison (default: false). */
  readonly caseInsensitive?: boolean;
};

export function exactMatch(opts: ExactMatchOptions = {}): Grader {
  const trim = opts.trim ?? true;
  const ci = opts.caseInsensitive ?? false;
  return async (sample, run) => {
    const expected = sample.expected_output;
    if (expected === undefined) {
      return fail("exactMatch: sample has no expected_output");
    }
    const a = transform(run.agentOutput, trim, ci);
    const b = transform(expected, trim, ci);
    if (a === b) return pass(`output matched expected (${expected.length} chars)`);
    return fail(`expected "${truncate(expected)}" got "${truncate(run.agentOutput)}"`);
  };
}

// -------- contains --------

export type ContainsOptions = {
  readonly substring: string;
  readonly caseInsensitive?: boolean;
};

export function contains(opts: ContainsOptions): Grader {
  const ci = opts.caseInsensitive ?? false;
  const needle = ci ? opts.substring.toLowerCase() : opts.substring;
  return async (_sample, run) => {
    const haystack = ci ? run.agentOutput.toLowerCase() : run.agentOutput;
    if (haystack.includes(needle)) return pass(`output contains "${truncate(opts.substring)}"`);
    return fail(`output missing "${truncate(opts.substring)}"`);
  };
}

// -------- regex --------

export function regex(pattern: RegExp | string, flags?: string): Grader {
  const re = typeof pattern === "string" ? new RegExp(pattern, flags) : pattern;
  return async (_sample, run) => {
    // `test` mutates `lastIndex` on global/sticky regexes, which would make a
    // reused grader instance flip-flop pass/fail across samples. Reset to keep
    // each invocation independent and deterministic.
    re.lastIndex = 0;
    if (re.test(run.agentOutput)) return pass(`output matches /${re.source}/${re.flags}`);
    return fail(`output does not match /${re.source}/${re.flags}`);
  };
}

// -------- jsonPath --------

export type JsonPathOptions = {
  readonly path: string;
  /** If supplied, the resolved value(s) must equal `expected`. Otherwise a non-empty
   * match set is sufficient. */
  readonly expected?: unknown;
};

export function jsonPath(opts: JsonPathOptions): Grader {
  return async (_sample, run) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.agentOutput);
    } catch (err) {
      return fail(`agentOutput is not valid JSON: ${(err as Error).message}`);
    }
    let matches: unknown[];
    try {
      matches = evalJsonPath(parsed, opts.path);
    } catch (err) {
      return fail(`jsonPath compile failed: ${(err as Error).message}`);
    }
    if (matches.length === 0) {
      return fail(`jsonPath ${opts.path} matched no nodes`);
    }
    if (opts.expected === undefined) {
      return pass(`jsonPath ${opts.path} matched ${matches.length} node(s)`);
    }
    const ok = matches.some((m) => deepEqual(m, opts.expected));
    if (ok) return pass(`jsonPath ${opts.path} matched expected value`);
    return fail(
      `jsonPath ${opts.path} expected ${JSON.stringify(opts.expected)} but matched ${JSON.stringify(matches)}`,
    );
  };
}

// -------- schema --------

/**
 * Validates that `agentOutput`, parsed as JSON, conforms to the given Zod schema.
 */
export function schema(zodSchema: z.ZodTypeAny): Grader {
  return async (_sample, run) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.agentOutput);
    } catch (err) {
      return fail(`agentOutput is not valid JSON: ${(err as Error).message}`);
    }
    const result = zodSchema.safeParse(parsed);
    if (result.success) return pass("output validates against schema");
    return fail(`schema validation failed: ${result.error.message}`);
  };
}

// -------- toolCallSequence --------

export type ToolCallSequenceOptions = {
  /** Names of tools the agent should have called, in order. */
  readonly expected: ReadonlyArray<string>;
  /**
   * "exact": tool sequence must equal `expected` (length and order both matter).
   * "subseq": `expected` must appear as a (possibly non-contiguous) subsequence.
   * "set": every name in `expected` must appear at least once (order ignored).
   * Default: "subseq".
   */
  readonly mode?: "exact" | "subseq" | "set";
};

export function toolCallSequence(opts: ToolCallSequenceOptions): Grader {
  const mode = opts.mode ?? "subseq";
  return async (_sample, run) => {
    const actual = run.toolCalls.map((c) => c.toolName);
    if (mode === "exact") {
      if (
        actual.length === opts.expected.length &&
        actual.every((name, i) => name === opts.expected[i])
      ) {
        return pass(`tool sequence matched: ${actual.join(" → ")}`);
      }
      return fail(
        `tool sequence mismatch: expected [${opts.expected.join(", ")}] got [${actual.join(", ")}]`,
      );
    }
    if (mode === "set") {
      const actualSet = new Set(actual);
      const missing = opts.expected.filter((n) => !actualSet.has(n));
      if (missing.length === 0) return pass(`all expected tools present: ${actual.join(", ")}`);
      return fail(`missing tools: ${missing.join(", ")} (saw: ${actual.join(", ")})`);
    }
    // "subseq"
    let i = 0;
    for (const name of actual) {
      if (i < opts.expected.length && name === opts.expected[i]) i += 1;
    }
    if (i === opts.expected.length) {
      return pass(`tool subsequence matched: ${opts.expected.join(" → ")}`);
    }
    return fail(
      `tool subsequence not found: expected [${opts.expected.join(", ")}] got [${actual.join(", ")}]`,
    );
  };
}

// -------- composers --------

export function all(
  graders: ReadonlyArray<{ name?: string; grader: Grader }> | ReadonlyArray<Grader>,
): Grader {
  const list = normalizeList(graders);
  return async (sample, run) => {
    const results: GradeResult[] = [];
    for (const g of list) results.push(await g.grader(sample, run));
    const passed = results.every((r) => r.passed);
    const score = results.length === 0 ? 1 : Math.min(...results.map((r) => r.score));
    return {
      passed,
      score,
      rationale: results
        .map((r, i) => `[${list[i]?.name ?? `g${i}`}: ${r.passed ? "✓" : "✗"}] ${r.rationale}`)
        .join(" & "),
    };
  };
}

export function any(
  graders: ReadonlyArray<{ name?: string; grader: Grader }> | ReadonlyArray<Grader>,
): Grader {
  const list = normalizeList(graders);
  return async (sample, run) => {
    const results: GradeResult[] = [];
    for (const g of list) results.push(await g.grader(sample, run));
    const passed = results.some((r) => r.passed);
    const score = results.length === 0 ? 0 : Math.max(...results.map((r) => r.score));
    return {
      passed,
      score,
      rationale: results
        .map((r, i) => `[${list[i]?.name ?? `g${i}`}: ${r.passed ? "✓" : "✗"}] ${r.rationale}`)
        .join(" | "),
    };
  };
}

export type WeightedEntry = {
  readonly name?: string;
  readonly grader: Grader;
  readonly weight: number;
};

export function weighted(entries: ReadonlyArray<WeightedEntry>, threshold = 0.5): Grader {
  if (entries.length === 0) {
    throw new GraderError("weighted: at least one entry required");
  }
  const totalWeight = entries.reduce((acc, e) => acc + e.weight, 0);
  if (totalWeight <= 0) {
    throw new GraderError(`weighted: total weight must be > 0 (got ${totalWeight})`);
  }
  return async (sample, run) => {
    const results: GradeResult[] = [];
    for (const e of entries) results.push(await e.grader(sample, run));
    const score =
      results.reduce((acc, r, i) => acc + r.score * (entries[i]?.weight ?? 0), 0) / totalWeight;
    const passed = score >= threshold;
    return {
      passed,
      score,
      rationale: results
        .map(
          (r, i) =>
            `[${entries[i]?.name ?? `g${i}`} w=${entries[i]?.weight} s=${r.score.toFixed(2)}] ${r.rationale}`,
        )
        .join(" + "),
    };
  };
}

/** Wrap a grader with a stable name for use in composers' rationales. */
export function byName(name: string, grader: Grader): { name: string; grader: Grader } {
  return { name, grader };
}

// -------- helpers --------

function normalizeList(
  graders: ReadonlyArray<{ name?: string; grader: Grader }> | ReadonlyArray<Grader>,
): ReadonlyArray<{ name?: string; grader: Grader }> {
  return graders.map((g) => (typeof g === "function" ? { grader: g } : g));
}

function transform(s: string, trim: boolean, ci: boolean): string {
  let out = s;
  if (trim) out = out.trim();
  if (ci) out = out.toLowerCase();
  return out;
}

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(ao[k], bo[k]));
}

// Re-export so combine helper users can use the `pass` shape if they want.
export type { GradeResult } from "./types";
