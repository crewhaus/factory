/**
 * Making output comparable across runs.
 *
 * A golden file containing a timestamp, a temporary path or a generated id
 * fails on its second run and every run after. The usual answer is to stop
 * using goldens; the better one is to replace the parts that are allowed to
 * vary with a marker, so a diff shows only what actually changed.
 *
 * Every rule is opt-in and named in the result with a count. A normalizer
 * that quietly rewrote output would let a real regression hide inside a
 * masked span, which is the one failure worse than a brittle golden.
 */
import { type RegexSession, describeRegexOutcome, runRegex } from "@crewhaus/tool-safety/regex";

export const NORMALIZERS = [
  "timestamps",
  "durations",
  "uuids",
  "hashes",
  "absolutePaths",
  "ports",
  "ansi",
  "trailingWhitespace",
  "crlf",
  "blankLines",
] as const;
export type Normalizer = (typeof NORMALIZERS)[number];

export type NormalizeOptions = {
  readonly apply: ReadonlyArray<Normalizer>;
  /** Replaced with `<root>`, so a checkout's location does not matter. */
  readonly root?: string;
  /** Caller rules, applied after the builtin ones. */
  readonly replace?: ReadonlyArray<{
    readonly pattern: string;
    readonly with: string;
    readonly flags?: string;
  }>;
  /**
   * Where caller rules run. A caller's pattern runs in a terminable worker
   * under a deadline (`@crewhaus/tool-safety/regex`), never synchronously on
   * this thread: `^(a+)+$` over 40 characters, or `a*a*a*b` over 1,000,
   * held the harness for seconds to minutes. Pass a session to reuse one
   * worker across many texts (a tree compare), and the tool's abort signal.
   */
  readonly regex?: {
    readonly session?: RegexSession;
    readonly signal?: AbortSignal;
    readonly runawayKey?: string;
  };
};

/** Longest text a caller's replace rule runs over: GoldenCompare's own input cap. */
export const MAX_REPLACE_INPUT_CHARS = 16 * 1024 * 1024;
/** How long one caller rule may take over one text before it is undetermined. */
export const REPLACE_DEADLINE_MS = 5_000;

/**
 * A caller's replace rule that could not be applied: refused as invalid or
 * catastrophic, or not finished in time. The text it would have produced is
 * unknown, so nothing may be compared or stored from it.
 */
export class ReplaceRuleError extends Error {
  override readonly name = "ReplaceRuleError";
}

export type NormalizeResult = {
  readonly text: string;
  /** How many substitutions each rule made, so a mask is never invisible. */
  readonly applied: Readonly<Record<string, number>>;
};

/**
 * The ANSI escape, built from its code point.
 *
 * Written as an escape inside a regex literal, the formatter rewrites it
 * into the raw byte, and a source file carrying a control character is not
 * parsed identically by every JavaScript engine — that exact rewrite broke
 * this repository's CI once. Interpolating a runtime value also stops the
 * formatter folding the `new RegExp` back into a literal.
 */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, "g");

/**
 * The builtin rules.
 *
 * Each is anchored tightly enough not to eat neighbouring text: a rule that
 * masked more than it should would hide a regression inside the mask.
 */
const RULES: ReadonlyArray<{ name: Normalizer; pattern: RegExp; with: string }> = [
  {
    name: "timestamps",
    pattern: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?/g,
    with: "<timestamp>",
  },
  { name: "durations", pattern: /\b\d+(?:\.\d+)?\s?(?:ms|s|m|h)\b/g, with: "<duration>" },
  {
    name: "uuids",
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    with: "<uuid>",
  },
  { name: "hashes", pattern: /\b[0-9a-f]{32,128}\b/g, with: "<hash>" },
  { name: "ports", pattern: /:\d{4,5}\b/g, with: ":<port>" },
  { name: "ansi", pattern: ANSI, with: "" },
  // Tried only from the start of a run: `/[ \t]+$/gm` retried from every
  // space of a long run that does not end the line, which is quadratic.
  { name: "trailingWhitespace", pattern: /(?<![ \t])[ \t]+$/gm, with: "" },
  { name: "crlf", pattern: /\r\n/g, with: "\n" },
  { name: "blankLines", pattern: /\n{3,}/g, with: "\n\n" },
];

export async function normalizeOutput(
  text: string,
  options: NormalizeOptions,
): Promise<NormalizeResult> {
  const applied: Record<string, number> = {};
  let out = text;

  // Paths first: a temporary directory often contains digits a later rule
  // would mask, leaving the path unrecognisable and unmatchable.
  if (
    options.apply.includes("absolutePaths") &&
    options.root !== undefined &&
    options.root !== ""
  ) {
    const count = out.split(options.root).length - 1;
    if (count > 0) {
      out = out.split(options.root).join("<root>");
      applied["absolutePaths"] = count;
    }
  }

  for (const rule of RULES) {
    if (!options.apply.includes(rule.name)) continue;
    let count = 0;
    out = out.replace(rule.pattern, () => {
      count++;
      return rule.with;
    });
    if (count > 0) applied[rule.name] = count;
  }

  for (const [i, rule] of (options.replace ?? []).entries()) {
    const request = {
      op: "replace" as const,
      pattern: rule.pattern,
      flags: rule.flags ?? "g",
      input: out,
      // `with` is literal text, as it always was: `$` has no meaning in it.
      replacement: rule.with.replaceAll("$", "$$$$"),
      deadlineMs: REPLACE_DEADLINE_MS,
      maxInputChars: MAX_REPLACE_INPUT_CHARS,
      maxOutputChars: 2 * MAX_REPLACE_INPUT_CHARS,
      ...(options.regex?.signal === undefined ? {} : { signal: options.regex.signal }),
      ...(options.regex?.runawayKey === undefined ? {} : { runawayKey: options.regex.runawayKey }),
    };
    const outcome =
      options.regex?.session === undefined
        ? await runRegex(request)
        : await options.regex.session.run(request);
    if (outcome.status === "rejected") {
      throw new ReplaceRuleError(`replace rule ${i} has an invalid pattern: ${outcome.reason}`);
    }
    if (outcome.status !== "ok") {
      throw new ReplaceRuleError(
        `replace rule ${i} could not be applied, so the normalized text is unknown: ${describeRegexOutcome(outcome)}`,
      );
    }
    out = outcome.result.output;
    if (outcome.result.replacements > 0) applied[`replace[${i}]`] = outcome.result.replacements;
  }

  return { text: out, applied };
}

export type LineDiff = {
  readonly line: number;
  readonly expected: string | null;
  readonly actual: string | null;
};

/**
 * The first differing lines.
 *
 * A golden diff that prints the whole file is a golden diff nobody reads;
 * the first few differences are what identify the change.
 */
export function firstDifferences(expected: string, actual: string, limit: number): LineDiff[] {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const out: LineDiff[] = [];
  for (let i = 0; i < Math.max(a.length, b.length) && out.length < limit; i++) {
    if (a[i] === b[i]) continue;
    out.push({ line: i + 1, expected: a[i] ?? null, actual: b[i] ?? null });
  }
  return out;
}
