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
};

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
  { name: "trailingWhitespace", pattern: /[ \t]+$/gm, with: "" },
  { name: "crlf", pattern: /\r\n/g, with: "\n" },
  { name: "blankLines", pattern: /\n{3,}/g, with: "\n\n" },
];

export function normalizeOutput(text: string, options: NormalizeOptions): NormalizeResult {
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
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, rule.flags ?? "g");
    } catch (err) {
      throw new Error(`replace rule ${i} has an invalid pattern: ${(err as Error).message}`);
    }
    let count = 0;
    out = out.replace(re, () => {
      count++;
      return rule.with;
    });
    if (count > 0) applied[`replace[${i}]`] = count;
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
