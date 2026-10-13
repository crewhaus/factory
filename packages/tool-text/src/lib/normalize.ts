/** CSI/SGR escapes emitted by terminals into captured output. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Strip ANSI escapes so a captured terminal log compares as plain text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Zero-width and bidirectional-control characters that survive copy-paste and
 * silently break diffs and equality checks. Built from explicit code points
 * rather than written as a character range: a range spanning the zero-width
 * joiner can split a joined sequence, which is what
 * `noMisleadingCharacterClass` warns about.
 */
const INVISIBLE_CODE_POINTS: ReadonlyArray<number> = [
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0xfeff, // byte-order mark
  0x2060, // word joiner
  0x180e, // Mongolian vowel separator
  0x202a, // bidi embedding and override
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066, // bidi isolates
  0x2067,
  0x2068,
  0x2069,
];
const INVISIBLE_PATTERN = new RegExp(
  INVISIBLE_CODE_POINTS.map((cp) => `\\u${cp.toString(16).padStart(4, "0")}`).join("|"),
  "g",
);

/**
 * `line` without its trailing spaces and tabs: what
 * `line.replace(/[ \t]+$/, "")` returned, in one pass from the end. That
 * pattern tries every start inside a run of blanks that is not at the end of
 * the line and rescans the rest of the run from each, so it was quadratic in
 * the run's length.
 */
export function withoutTrailingBlanks(line: string): string {
  let end = line.length;
  for (; end > 0; end--) {
    const c = line.charCodeAt(end - 1);
    if (c !== 0x20 && c !== 0x09) break;
  }
  return end === line.length ? line : line.slice(0, end);
}

export type NormalizeOptions = {
  readonly eol?: "lf" | "crlf";
  readonly trimTrailingWhitespace?: boolean;
  readonly collapseBlankLines?: boolean;
  readonly tabsToSpaces?: number;
  readonly stripAnsiCodes?: boolean;
  readonly stripInvisible?: boolean;
  readonly unicode?: "NFC" | "NFD" | "NFKC" | "NFKD";
  readonly ensureFinalNewline?: boolean;
  readonly lowercase?: boolean;
};

/**
 * Canonicalize text so two copies differing only in invisible ways compare
 * equal. Run this before hashing, diffing, or de-duplicating; it is why a
 * "file changed" check stops firing on a line-ending flip.
 */
export function normalizeText(text: string, opts: NormalizeOptions): string {
  let out = text;
  if (opts.stripAnsiCodes === true) out = stripAnsi(out);
  if (opts.stripInvisible === true) out = out.replace(INVISIBLE_PATTERN, "");
  if (opts.unicode !== undefined) out = out.normalize(opts.unicode);
  if (opts.tabsToSpaces !== undefined) out = out.replace(/\t/g, " ".repeat(opts.tabsToSpaces));
  // Fold to LF first so later rules see one shape, then convert at the end.
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (opts.trimTrailingWhitespace === true) {
    out = out.split("\n").map(withoutTrailingBlanks).join("\n");
  }
  if (opts.collapseBlankLines === true) out = out.replace(/\n{3,}/g, "\n\n");
  if (opts.lowercase === true) out = out.toLowerCase();
  if (opts.ensureFinalNewline === true && !out.endsWith("\n")) out += "\n";
  if (opts.eol === "crlf") out = out.replace(/\n/g, "\r\n");
  return out;
}

export type SortOptions = {
  readonly order?: "asc" | "desc";
  readonly unique?: boolean;
  readonly numeric?: boolean;
  readonly ignoreCase?: boolean;
  readonly field?: number;
  readonly delimiter?: string;
  readonly keepEmpty?: boolean;
};

/** Sort, de-duplicate, and optionally key lines by a delimited field. */
export function sortLines(text: string, opts: SortOptions): string[] {
  let lines = text.split("\n");
  if (opts.keepEmpty !== true) lines = lines.filter((l) => l.trim() !== "");
  const keyOf = (line: string): string => {
    const base =
      opts.field !== undefined ? (line.split(opts.delimiter ?? "\t")[opts.field] ?? "") : line;
    return opts.ignoreCase === true ? base.toLowerCase() : base;
  };
  if (opts.unique === true) {
    const seen = new Set<string>();
    lines = lines.filter((l) => {
      const k = keyOf(l);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  const sorted = [...lines].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (opts.numeric === true) {
      const na = Number.parseFloat(ka);
      const nb = Number.parseFloat(kb);
      const aNum = Number.isNaN(na) ? Number.POSITIVE_INFINITY : na;
      const bNum = Number.isNaN(nb) ? Number.POSITIVE_INFINITY : nb;
      if (aNum !== bNum) return aNum - bNum;
      return ka.localeCompare(kb);
    }
    return ka.localeCompare(kb);
  });
  return opts.order === "desc" ? sorted.reverse() : sorted;
}

/** GlossaryReplace's limit for its text: the default for what the mapping may grow it to. */
const GLOSSARY_LIMIT = 2_000_000;

/**
 * Each term is one pass over the whole text, so the passes together may
 * read this many times the limit: thousands of terms over a long document,
 * or a hundred over the longest text.
 */
const GLOSSARY_PASSES_PER_LIMIT = 100;

/**
 * Replace terms using operator-supplied mappings, longest term first so a
 * multi-word entry wins over a substring of itself. Whole-word by default,
 * which is what stops "AI" rewriting the middle of "CHAIN".
 *
 * Each term's pass also runs over what earlier terms put in, so a
 * replacement that holds the next term many times multiplied the text once
 * per term: a 382-byte call grew it to 639,999 characters, and a fifth term
 * to 12.8 million. The text may grow to `limit`, and the passes together may
 * read {@link GLOSSARY_PASSES_PER_LIMIT} times it; past either this throws
 * a sentence that says which, never a cut text.
 *
 * Each pass finds its term the way `new RegExp(<escaped term>, "g" | "gi")`
 * did, with `(?<![\w-])` and `(?![\w-])` around it for whole words — but
 * reads each unit of the text once, whatever the term ({@link replaceTerm}).
 */
export function glossaryReplace(
  text: string,
  mapping: Readonly<Record<string, string>>,
  wholeWord: boolean,
  caseSensitive: boolean,
  limit: number = GLOSSARY_LIMIT,
): { text: string; replacements: Record<string, number> } {
  const replacements: Record<string, number> = {};
  const terms = Object.keys(mapping).sort((a, b) => b.length - a.length);
  const budget = GLOSSARY_PASSES_PER_LIMIT * limit;
  let out = text;
  let read = 0;
  for (const term of terms) {
    if (read + out.length > budget) {
      throw new Error(
        `${terms.length} glossary terms over ${out.length} characters of text would read more than ${budget} characters, since each term is a pass over the whole text; send fewer terms or a shorter text`,
      );
    }
    read += out.length;
    // What the replacer returned before: a missing value reads "undefined".
    const value = String(mapping[term]);
    const replaced = replaceTerm(out, term, value, wholeWord, caseSensitive, limit);
    if (replaced.count > 0) replacements[term] = replaced.count;
    out = replaced.text;
  }
  return { text: out, replacements };
}

/** `[\w-]`: what a whole word may not touch. The regex `i` flag (without `u`) folds no other unit into it. */
function isWordUnit(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    c === 0x5f ||
    c === 0x2d
  );
}

/** Canonical code unit per code unit, filled on first use; -1 is "not yet". */
const CANONICAL = new Int32Array(0x10000).fill(-1);

/**
 * The code unit the regex `i` flag (without `u`) compares `c` as: the
 * ECMAScript Canonicalize — its upper case when that is one code unit, and not
 * ASCII for a non-ASCII `c` — as this engine's own tables have it. The
 * engine's case tables can be older than `toUpperCase`'s, so a pairing the
 * regex does not make is not made here either. The same function is in
 * tool-secure's `lib/literal.ts`; keep the two in step.
 */
function canonicalUnit(c: number): number {
  const known = CANONICAL[c] as number;
  if (known !== -1) return known;
  let out = c;
  if (c < 0x80) {
    if (c >= 0x61 && c <= 0x7a) out = c - 0x20;
  } else {
    const upper = String.fromCharCode(c).toUpperCase();
    if (upper.length === 1) {
      const u = upper.charCodeAt(0);
      if (u >= 0x80 && u !== c && regexFolds(c, u)) out = u;
    }
  }
  CANONICAL[c] = out;
  return out;
}

function regexFolds(a: number, b: number): boolean {
  return new RegExp(`^\\u${a.toString(16).padStart(4, "0")}$`, "i").test(String.fromCharCode(b));
}

const sameUnit = (c: number): number => c;

/**
 * `text` with `term` replaced by `value` wherever `new RegExp(<escaped
 * term>, caseSensitive ? "g" : "gi")` matched it — inside
 * `(?<![\w-])…(?![\w-])` when `wholeWord` — and how many times.
 *
 * That regex tried the whole term from every position of the text, so one
 * pass read the text's length times the term's. Here the term is found with
 * Knuth–Morris–Pratt, comparing code units folded as the `i` flag folds
 * them: each unit of the text is read once, and the comparisons that fail
 * are paid for by ones that matched. Every place the term occurs is found,
 * overlapping ones too, left to right; one is a match when it starts where
 * the last match ended or later and, for whole words, the units on either
 * side of it (in the text as it was, as the lookarounds read it) are not
 * `[\w-]`. That is the leftmost match from each place the regex resumed. The
 * empty term occurs before each unit and at the end, as an empty regex
 * matches.
 *
 * Case folds as the term on its own folded. JavaScriptCore folded some units
 * further when the pattern had the lookbehind, so with whole words the
 * Kelvin sign matched "k" and the long s "S", where the term on its own
 * never did; with whole words on or off, they now fold alike.
 *
 * Every match is as long as the term, so the text's growth only rises or
 * only falls: once past `limit` the whole pass ends past it, and this throws
 * at that match rather than build the text.
 */
function replaceTerm(
  text: string,
  term: string,
  value: string,
  wholeWord: boolean,
  caseSensitive: boolean,
  limit: number,
): { text: string; count: number } {
  const m = term.length;
  const n = text.length;
  const fold = caseSensitive ? sameUnit : canonicalUnit;
  const parts: string[] = [];
  let copied = 0;
  let count = 0;
  let grown = 0;
  const take = (start: number): void => {
    count++;
    grown += value.length - m;
    if (grown > 0 && n + grown > limit) {
      throw new Error(
        `the glossary would make the text longer than ${limit} characters, the limit for text; terms apply longest first, each to the text the ones before produced, so a replacement that holds a later term is replaced again`,
      );
    }
    parts.push(text.slice(copied, start), value);
    copied = start + m;
  };
  const clearOfWords = (start: number, end: number): boolean =>
    !wholeWord ||
    ((start === 0 || !isWordUnit(text.charCodeAt(start - 1))) &&
      (end === n || !isWordUnit(text.charCodeAt(end))));
  if (m === 0) {
    for (let i = 0; i <= n; i++) if (clearOfWords(i, i)) take(i);
  } else if (m <= n) {
    // For each prefix of the folded term, its longest proper border.
    const border = new Int32Array(m);
    for (let i = 1, k = 0; i < m; i++) {
      const c = fold(term.charCodeAt(i));
      while (k > 0 && fold(term.charCodeAt(k)) !== c) k = border[k - 1] as number;
      if (fold(term.charCodeAt(k)) === c) k += 1;
      border[i] = k;
    }
    let k = 0;
    for (let i = 0; i < n; i++) {
      const c = fold(text.charCodeAt(i));
      while (k > 0 && fold(term.charCodeAt(k)) !== c) k = border[k - 1] as number;
      if (fold(term.charCodeAt(k)) === c) k += 1;
      if (k === m) {
        const start = i + 1 - m;
        if (start >= copied && clearOfWords(start, i + 1)) {
          take(start);
          // The next match starts where this one ends.
          k = 0;
        } else {
          // Not a match here; one may still start inside it.
          k = border[m - 1] as number;
        }
      }
    }
  }
  if (count === 0) return { text, count };
  parts.push(text.slice(copied));
  return { text: parts.join(""), count };
}
