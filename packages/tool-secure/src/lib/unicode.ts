/**
 * The characters a human reviewer cannot see, and the ones they see wrong.
 *
 * Two different attacks share this file. Invisible characters hide a payload
 * from the person reviewing a document; confusable characters show that
 * person one thing while the bytes say another (`раypal.com` with a Cyrillic
 * `р`). Both are structural, so both can be detected without judgement —
 * which is the only reason they belong in a deterministic package.
 *
 * ## Confusable folding: the exact pipeline
 *
 * Per code point, in order, with offsets preserved because every step maps
 * ONE source code point to a replacement string:
 *
 *   1. ASCII (U+0000–U+007F) is passed through untouched.
 *   2. An entry in `CONFUSABLES` below wins. That table is hand-curated for
 *      the Latin-lookalike code points in Cyrillic, Greek and a few symbol
 *      blocks — the ones that actually turn up in domain and identifier
 *      spoofing.
 *   3. Otherwise the code point is normalized NFKD and any combining marks
 *      (U+0300–U+036F) are dropped; if what remains is pure printable ASCII
 *      it is used. This is what folds `é`→`e`, `ﬁ`→`fi`, `Ａ`→`A`, `𝐀`→`A`
 *      and `①`→`1`, without a table.
 *   4. Anything left is reported as `unfolded` and passed through unchanged.
 *
 * ## What this is NOT
 *
 * It is not UTS #39. The full Unicode confusables data is thousands of
 * mappings across every script; `CONFUSABLES` is a curated subset and step 3
 * is an approximation of it. A string this function leaves alone is not
 * thereby "safe" — `mixedScriptRuns` exists because whole-script confusables
 * (a domain written entirely in Cyrillic) fold to nothing at all and are
 * only visible as a script mismatch.
 */

export type InvisibleClass =
  | "zero-width"
  | "bidi-control"
  | "soft-hyphen"
  | "variation-selector"
  | "tag"
  | "format-other"
  | "control"
  | "unusual-space"
  | "private-use";

export type InvisibleHit = {
  readonly codePoint: number;
  /** `U+200B` form, for grepping and for issue reports. */
  readonly label: string;
  readonly name: string;
  readonly class: InvisibleClass;
  readonly start: number;
  readonly end: number;
};

/** Named code points. Anything outside this table is classified by range. */
const NAMED: ReadonlyMap<number, { name: string; class: InvisibleClass }> = new Map([
  [0x00ad, { name: "SOFT HYPHEN", class: "soft-hyphen" as const }],
  [0x061c, { name: "ARABIC LETTER MARK", class: "bidi-control" as const }],
  [0x180e, { name: "MONGOLIAN VOWEL SEPARATOR", class: "zero-width" as const }],
  [0x200b, { name: "ZERO WIDTH SPACE", class: "zero-width" as const }],
  [0x200c, { name: "ZERO WIDTH NON-JOINER", class: "zero-width" as const }],
  [0x200d, { name: "ZERO WIDTH JOINER", class: "zero-width" as const }],
  [0x200e, { name: "LEFT-TO-RIGHT MARK", class: "bidi-control" as const }],
  [0x200f, { name: "RIGHT-TO-LEFT MARK", class: "bidi-control" as const }],
  [0x202a, { name: "LEFT-TO-RIGHT EMBEDDING", class: "bidi-control" as const }],
  [0x202b, { name: "RIGHT-TO-LEFT EMBEDDING", class: "bidi-control" as const }],
  [0x202c, { name: "POP DIRECTIONAL FORMATTING", class: "bidi-control" as const }],
  [0x202d, { name: "LEFT-TO-RIGHT OVERRIDE", class: "bidi-control" as const }],
  [0x202e, { name: "RIGHT-TO-LEFT OVERRIDE", class: "bidi-control" as const }],
  [0x2060, { name: "WORD JOINER", class: "zero-width" as const }],
  [0x2061, { name: "FUNCTION APPLICATION", class: "format-other" as const }],
  [0x2062, { name: "INVISIBLE TIMES", class: "format-other" as const }],
  [0x2063, { name: "INVISIBLE SEPARATOR", class: "format-other" as const }],
  [0x2064, { name: "INVISIBLE PLUS", class: "format-other" as const }],
  [0x2066, { name: "LEFT-TO-RIGHT ISOLATE", class: "bidi-control" as const }],
  [0x2067, { name: "RIGHT-TO-LEFT ISOLATE", class: "bidi-control" as const }],
  [0x2068, { name: "FIRST STRONG ISOLATE", class: "bidi-control" as const }],
  [0x2069, { name: "POP DIRECTIONAL ISOLATE", class: "bidi-control" as const }],
  [0xfeff, { name: "ZERO WIDTH NO-BREAK SPACE (BOM)", class: "zero-width" as const }],
  [0xfffc, { name: "OBJECT REPLACEMENT CHARACTER", class: "format-other" as const }],
]);

/** Spaces that are not U+0020 and read as one. */
const UNUSUAL_SPACES: ReadonlyMap<number, string> = new Map([
  [0x00a0, "NO-BREAK SPACE"],
  [0x2000, "EN QUAD"],
  [0x2001, "EM QUAD"],
  [0x2002, "EN SPACE"],
  [0x2003, "EM SPACE"],
  [0x2004, "THREE-PER-EM SPACE"],
  [0x2005, "FOUR-PER-EM SPACE"],
  [0x2006, "SIX-PER-EM SPACE"],
  [0x2007, "FIGURE SPACE"],
  [0x2008, "PUNCTUATION SPACE"],
  [0x2009, "THIN SPACE"],
  [0x200a, "HAIR SPACE"],
  [0x202f, "NARROW NO-BREAK SPACE"],
  [0x205f, "MEDIUM MATHEMATICAL SPACE"],
  [0x3000, "IDEOGRAPHIC SPACE"],
]);

function classify(cp: number): { name: string; class: InvisibleClass } | undefined {
  const named = NAMED.get(cp);
  if (named) return named;
  const space = UNUSUAL_SPACES.get(cp);
  if (space) return { name: space, class: "unusual-space" };
  // C0 and C1 controls, minus tab / newline / carriage return, which are text.
  if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f)) {
    return { name: "CONTROL CHARACTER", class: "control" };
  }
  if (cp >= 0xfe00 && cp <= 0xfe0f) return { name: "VARIATION SELECTOR", class: "variation-selector" };
  if (cp >= 0xe0100 && cp <= 0xe01ef) {
    return { name: "VARIATION SELECTOR SUPPLEMENT", class: "variation-selector" };
  }
  // The tag block: a full ASCII alphabet that renders as nothing at all.
  if (cp >= 0xe0000 && cp <= 0xe007f) return { name: "TAG CHARACTER", class: "tag" };
  if (cp >= 0xe000 && cp <= 0xf8ff) return { name: "PRIVATE USE", class: "private-use" };
  if (cp >= 0xf0000 && cp <= 0x10fffd) return { name: "SUPPLEMENTARY PRIVATE USE", class: "private-use" };
  return undefined;
}

/** `U+200B`-style label. */
export function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Every invisible or deceptive-whitespace code point, in document order. */
export function scanInvisible(text: string): InvisibleHit[] {
  const hits: InvisibleHit[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    const found = classify(cp);
    if (found) {
      hits.push({
        codePoint: cp,
        label: codePointLabel(cp),
        name: found.name,
        class: found.class,
        start: i,
        end: i + width,
      });
    }
    i += width;
  }
  return hits;
}

/**
 * Bidi controls that are opened and never closed within their line.
 *
 * This is the Trojan Source shape (CVE-2021-42574): an override opened in a
 * comment reorders the code after it without any visible trace. Balance is
 * checked per line because that is the unit a reviewer reads.
 */
export function unbalancedBidi(text: string): Array<{ line: number; open: number; close: number }> {
  const OPEN = new Set([0x202a, 0x202b, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068]);
  const CLOSE = new Set([0x202c, 0x2069]);
  const out: Array<{ line: number; open: number; close: number }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let open = 0;
    let close = 0;
    for (const ch of line) {
      const cp = ch.codePointAt(0) ?? 0;
      if (OPEN.has(cp)) open++;
      else if (CLOSE.has(cp)) close++;
    }
    if (open !== close) out.push({ line: i + 1, open, close });
  }
  return out;
}

/**
 * Hand-curated Latin lookalikes with no compatibility decomposition, so
 * step 3 of the pipeline cannot reach them. Cyrillic and Greek dominate
 * because they are what registrars and identifier spoofing actually use.
 */
export const CONFUSABLES: ReadonlyMap<string, string> = new Map<string, string>([
  // Cyrillic
  ["А", "A"], ["В", "B"], ["Е", "E"], ["Ѕ", "S"], ["І", "I"], ["Ј", "J"], ["К", "K"],
  ["М", "M"], ["Н", "H"], ["О", "O"], ["Р", "P"], ["С", "C"], ["Т", "T"], ["У", "Y"],
  ["Х", "X"], ["Ԛ", "Q"], ["Ԝ", "W"], ["Ӏ", "I"],
  ["а", "a"], ["в", "b"], ["е", "e"], ["ё", "e"], ["ѕ", "s"], ["і", "i"], ["ј", "j"],
  ["к", "k"], ["м", "m"], ["н", "h"], ["о", "o"], ["р", "p"], ["с", "c"], ["т", "t"],
  ["у", "y"], ["х", "x"], ["ԁ", "d"], ["һ", "h"], ["ӏ", "l"], ["ѡ", "w"], ["ԍ", "g"],
  // Greek
  ["Α", "A"], ["Β", "B"], ["Ε", "E"], ["Ζ", "Z"], ["Η", "H"], ["Ι", "I"], ["Κ", "K"],
  ["Μ", "M"], ["Ν", "N"], ["Ο", "O"], ["Ρ", "P"], ["Τ", "T"], ["Υ", "Y"], ["Χ", "X"],
  ["Ϲ", "C"], ["α", "a"], ["ε", "e"], ["ι", "i"], ["κ", "k"], ["ν", "v"], ["ο", "o"],
  ["ρ", "p"], ["τ", "t"], ["υ", "u"], ["χ", "x"], ["ϲ", "c"], ["ϳ", "j"],
  // Armenian, Georgian and Cherokee lookalikes that reach domain names
  ["ա", "w"], ["օ", "o"], ["ѵ", "v"], ["Ꭺ", "A"], ["Ꮯ", "C"], ["Ꮋ", "H"], ["Ꮖ", "I"],
  // Punctuation and symbols that read as ASCII
  ["‐", "-"], ["‑", "-"], ["‒", "-"], ["–", "-"], ["—", "-"], ["―", "-"], ["−", "-"],
  ["’", "'"], ["‘", "'"], ["‚", "'"], ["′", "'"], ["ʼ", "'"], ["ˈ", "'"],
  ["“", '"'], ["”", '"'], ["„", '"'], ["″", '"'],
  ["⁄", "/"], ["∕", "/"], ["⧸", "/"], ["∶", ":"], ["․", "."], ["。", "."], ["｡", "."],
  ["ǀ", "l"], ["ł", "l"], ["ℓ", "l"],
]);

export type FoldChange = {
  readonly start: number;
  readonly end: number;
  readonly from: string;
  readonly fromLabel: string;
  readonly to: string;
  readonly step: "confusable-table" | "nfkd-ascii";
};

export type FoldResult = {
  readonly text: string;
  readonly changes: ReadonlyArray<FoldChange>;
  /** Non-ASCII code points the pipeline could not fold, with their offsets. */
  readonly unfolded: ReadonlyArray<{ start: number; label: string; char: string }>;
};

const COMBINING = /[̀-ͯ]/g;

/** Fold one non-ASCII code point via NFKD, or undefined when it will not reduce. */
function nfkdToAscii(char: string): string | undefined {
  const decomposed = char.normalize("NFKD").replace(COMBINING, "");
  if (decomposed.length === 0) return undefined;
  // Printable ASCII only: a decomposition to a control character is not a fold.
  for (let i = 0; i < decomposed.length; i++) {
    const code = decomposed.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return undefined;
  }
  return decomposed;
}

/** Apply the documented four-step pipeline, keeping source offsets exact. */
export function foldConfusables(text: string): FoldResult {
  const changes: FoldChange[] = [];
  const unfolded: Array<{ start: number; label: string; char: string }> = [];
  let out = "";
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    const char = text.slice(i, i + width);
    if (cp <= 0x7f) {
      out += char;
      i += width;
      continue;
    }
    const mapped = CONFUSABLES.get(char);
    if (mapped !== undefined) {
      changes.push({
        start: i,
        end: i + width,
        from: char,
        fromLabel: codePointLabel(cp),
        to: mapped,
        step: "confusable-table",
      });
      out += mapped;
      i += width;
      continue;
    }
    const decomposed = nfkdToAscii(char);
    if (decomposed !== undefined) {
      changes.push({
        start: i,
        end: i + width,
        from: char,
        fromLabel: codePointLabel(cp),
        to: decomposed,
        step: "nfkd-ascii",
      });
      out += decomposed;
      i += width;
      continue;
    }
    unfolded.push({ start: i, label: codePointLabel(cp), char });
    out += char;
    i += width;
  }
  return { text: out, changes, unfolded };
}

export type Script =
  | "Latin"
  | "Cyrillic"
  | "Greek"
  | "Armenian"
  | "Hebrew"
  | "Arabic"
  | "Devanagari"
  | "Thai"
  | "Georgian"
  | "Han"
  | "Hiragana"
  | "Katakana"
  | "Hangul"
  | "Cherokee"
  | "Common"
  | "Other";

const SCRIPT_RANGES: ReadonlyArray<[number, number, Script]> = [
  [0x0041, 0x005a, "Latin"],
  [0x0061, 0x007a, "Latin"],
  [0x00c0, 0x024f, "Latin"],
  [0x1e00, 0x1eff, "Latin"],
  [0x0370, 0x03ff, "Greek"],
  [0x1f00, 0x1fff, "Greek"],
  [0x0400, 0x052f, "Cyrillic"],
  [0x2de0, 0x2dff, "Cyrillic"],
  [0x0530, 0x058f, "Armenian"],
  [0x0590, 0x05ff, "Hebrew"],
  [0x0600, 0x06ff, "Arabic"],
  [0x0750, 0x077f, "Arabic"],
  [0x0900, 0x097f, "Devanagari"],
  [0x0e00, 0x0e7f, "Thai"],
  [0x10a0, 0x10ff, "Georgian"],
  [0x13a0, 0x13ff, "Cherokee"],
  [0x3040, 0x309f, "Hiragana"],
  [0x30a0, 0x30ff, "Katakana"],
  [0x3400, 0x4dbf, "Han"],
  [0x4e00, 0x9fff, "Han"],
  [0x1100, 0x11ff, "Hangul"],
  [0xac00, 0xd7af, "Hangul"],
];

/**
 * A deliberately coarse script lookup: the blocks that matter for spoofing,
 * with digits, ASCII punctuation and spaces as `Common` so they never make a
 * token look mixed.
 */
export function scriptOf(cp: number): Script {
  if (cp <= 0x7f) {
    const isAsciiLetter = (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
    return isAsciiLetter ? "Latin" : "Common";
  }
  for (const [lo, hi, script] of SCRIPT_RANGES) {
    if (cp >= lo && cp <= hi) return script;
  }
  return "Other";
}

export type MixedRun = {
  readonly text: string;
  readonly start: number;
  readonly scripts: ReadonlyArray<Script>;
};

/**
 * Runs of non-space characters that draw on more than one script.
 *
 * The classic phish is one Cyrillic letter inside an otherwise Latin word;
 * that shows up here even when it folds cleanly, and it shows up for
 * whole-script spoofs too, which fold to nothing.
 */
export function mixedScriptRuns(text: string): MixedRun[] {
  const runs: MixedRun[] = [];
  let start = -1;
  let buffer = "";
  let scripts = new Set<Script>();
  const flush = (): void => {
    if (start >= 0 && scripts.size > 1) {
      runs.push({ text: buffer, start, scripts: [...scripts].sort() });
    }
    start = -1;
    buffer = "";
    scripts = new Set<Script>();
  };
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    const width = cp > 0xffff ? 2 : 1;
    const char = text.slice(i, i + width);
    if (/\s/.test(char)) {
      flush();
    } else {
      if (start < 0) start = i;
      buffer += char;
      const script = scriptOf(cp);
      if (script !== "Common") scripts.add(script);
    }
    i += width;
  }
  flush();
  return runs;
}
