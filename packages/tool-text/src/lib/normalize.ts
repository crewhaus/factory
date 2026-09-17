import { escapeFor } from "./format";

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
    out = out
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n");
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

/**
 * Replace terms using operator-supplied mappings, longest term first so a
 * multi-word entry wins over a substring of itself. Whole-word by default,
 * which is what stops "AI" rewriting the middle of "CHAIN".
 */
export function glossaryReplace(
  text: string,
  mapping: Readonly<Record<string, string>>,
  wholeWord: boolean,
  caseSensitive: boolean,
): { text: string; replacements: Record<string, number> } {
  const replacements: Record<string, number> = {};
  let out = text;
  for (const term of Object.keys(mapping).sort((a, b) => b.length - a.length)) {
    const escaped = escapeFor(term, "regex");
    const source = wholeWord ? `(?<![\\w-])${escaped}(?![\\w-])` : escaped;
    const re = new RegExp(source, caseSensitive ? "g" : "gi");
    let count = 0;
    out = out.replace(re, () => {
      count++;
      return mapping[term] as string;
    });
    if (count > 0) replacements[term] = count;
  }
  return { text: out, replacements };
}
