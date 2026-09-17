/**
 * Text extraction from PDF content streams.
 *
 * ## What it does
 *
 * Interprets the text-showing part of the content-stream language —
 * `BT`/`ET`, `Tf`, `Td`, `TD`, `Tm`, `T*`, `TL`, `Tc`, `Tw`, `Tz`, `Ts`,
 * `Tj`, `TJ`, `'` and `"` — while tracking the current transformation matrix
 * through `cm`, `q` and `Q`, and recursing into form XObjects (`Do`), which
 * is where a surprising amount of real text lives. Character codes are
 * mapped to Unicode through, in order of preference: the font's `/ToUnicode`
 * CMap, its `/Encoding` (`WinAnsiEncoding`, `MacRomanEncoding`,
 * `StandardEncoding`, plus `/Differences`), or Latin-1 as a last resort.
 *
 * Line and word breaks are RECONSTRUCTED from geometry, because a PDF has no
 * concept of either: a glyph is drawn at a point. A new line is emitted when
 * the text position moves vertically by more than half the font size, and a
 * space when the horizontal gap between one run's end and the next run's
 * start exceeds a fraction of it. Glyph widths come from `/Widths` (simple
 * fonts) or `/W` and `/DW` (CID fonts), falling back to 500/1000 em.
 *
 * ## What it does NOT do — say so, do not guess
 *
 * - ENCRYPTED documents: refused outright, not attempted.
 * - SCANNED pages with no text layer: there is nothing to extract, and the
 *   honest answer is "this page has no text layer", which is what the caller
 *   gets — never an empty string presented as the document's content.
 * - CID/CJK fonts WITHOUT a `/ToUnicode` map: the character codes are glyph
 *   ids in an embedded subset font, and no reader can recover text from them
 *   without parsing the embedded font program. Those runs are reported as
 *   unmappable rather than rendered as mojibake.
 * - Ligature glyphs beyond the five Latin ones, dingbat and symbol fonts,
 *   and any custom glyph name outside the table below plus the `uniXXXX`
 *   forms.
 * - Reading ORDER for multi-column layouts and tables. Output follows the
 *   order the content stream draws in, which is usually but not always
 *   reading order. Nothing here re-flows columns.
 * - Vertical writing mode (`/WMode 1`).
 */
import {
  type PdfDict,
  type PdfDocument,
  PdfError,
  PdfFilterError,
  PdfLexer,
  type PdfPage,
  type PdfValue,
  isArray,
  isDict,
  isName,
  isStream,
  isString,
  latin1,
  numberOf,
} from "./pdf";

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

// ---------------------------------------------------------------------------
// encodings
// ---------------------------------------------------------------------------

/**
 * Encoding tables are written as CODE POINTS rather than string literals.
 * Half of these characters are invisible or look identical to a neighbour in
 * a source file, and a table you cannot proofread is a table with a silent
 * error in it.
 */
const WIN_ANSI_HIGH: ReadonlyArray<number> = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/** MacRomanEncoding for 0x80 and above. */
const MAC_ROMAN_HIGH: ReadonlyArray<number> = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3,
  0x00e5, 0x00e7, 0x00e9, 0x00e8, 0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
  0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc, 0x2020, 0x00b0, 0x00a2, 0x00a3,
  0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa,
  0x00ba, 0x03a9, 0x00e6, 0x00f8, 0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
  0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153, 0x2013, 0x2014, 0x201c, 0x201d,
  0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce,
  0x00cf, 0x00cc, 0x00d3, 0x00d4, 0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

/**
 * Glyph names that appear in `/Differences` often enough to matter. The full
 * Adobe Glyph List has thousands of entries; this is the working subset,
 * plus the `uniXXXX` and `uXXXX` forms, which cover everything else a
 * well-formed producer emits.
 */
const GLYPH_CODES: Readonly<Record<string, number>> = {
  space: 0x20,
  exclam: 0x21,
  quotedbl: 0x22,
  numbersign: 0x23,
  dollar: 0x24,
  percent: 0x25,
  ampersand: 0x26,
  quotesingle: 0x27,
  parenleft: 0x28,
  parenright: 0x29,
  asterisk: 0x2a,
  plus: 0x2b,
  comma: 0x2c,
  hyphen: 0x2d,
  period: 0x2e,
  slash: 0x2f,
  zero: 0x30,
  one: 0x31,
  two: 0x32,
  three: 0x33,
  four: 0x34,
  five: 0x35,
  six: 0x36,
  seven: 0x37,
  eight: 0x38,
  nine: 0x39,
  colon: 0x3a,
  semicolon: 0x3b,
  less: 0x3c,
  equal: 0x3d,
  greater: 0x3e,
  question: 0x3f,
  at: 0x40,
  bracketleft: 0x5b,
  backslash: 0x5c,
  bracketright: 0x5d,
  asciicircum: 0x5e,
  underscore: 0x5f,
  grave: 0x60,
  braceleft: 0x7b,
  bar: 0x7c,
  braceright: 0x7d,
  asciitilde: 0x7e,
  exclamdown: 0x00a1,
  cent: 0x00a2,
  sterling: 0x00a3,
  yen: 0x00a5,
  section: 0x00a7,
  copyright: 0x00a9,
  guillemotleft: 0x00ab,
  registered: 0x00ae,
  degree: 0x00b0,
  plusminus: 0x00b1,
  paragraph: 0x00b6,
  periodcentered: 0x00b7,
  guillemotright: 0x00bb,
  questiondown: 0x00bf,
  multiply: 0x00d7,
  germandbls: 0x00df,
  divide: 0x00f7,
  quoteleft: 0x2018,
  quoteright: 0x2019,
  quotesinglbase: 0x201a,
  quotedblleft: 0x201c,
  quotedblright: 0x201d,
  quotedblbase: 0x201e,
  dagger: 0x2020,
  daggerdbl: 0x2021,
  bullet: 0x2022,
  endash: 0x2013,
  emdash: 0x2014,
  ellipsis: 0x2026,
  perthousand: 0x2030,
  fraction: 0x2044,
  Euro: 0x20ac,
  trademark: 0x2122,
  minus: 0x2212,
  ff: 0xfb00,
  fi: 0xfb01,
  fl: 0xfb02,
  ffi: 0xfb03,
  ffl: 0xfb04,
};

function glyphToUnicode(name: string): string | undefined {
  const known = GLYPH_CODES[name];
  if (known !== undefined) return String.fromCodePoint(known);
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni?.[1] !== undefined) return String.fromCodePoint(Number.parseInt(uni[1], 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u?.[1] !== undefined) return String.fromCodePoint(Number.parseInt(u[1], 16));
  if (name.length === 1) return name;
  return undefined;
}

// ---------------------------------------------------------------------------
// fonts
// ---------------------------------------------------------------------------

type Font = {
  readonly name: string;
  /** Bytes per character code: 1 for simple fonts, 2 for Identity CID fonts. */
  readonly codeBytes: number;
  readonly toUnicode: Map<number, string> | null;
  readonly simpleEncoding: Map<number, string> | null;
  readonly widths: Map<number, number>;
  readonly defaultWidth: number;
  /** Set when the font's codes cannot be mapped to text at all. */
  readonly unmappable: boolean;
};

/** Parse the `beginbfchar` / `beginbfrange` sections of a ToUnicode CMap. */
export function parseToUnicodeCMap(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToString = (hex: string): string => {
    if (hex.length <= 2) return String.fromCharCode(Number.parseInt(hex, 16));
    let out = "";
    for (let i = 0; i + 3 < hex.length; i += 4) {
      out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
    }
    return out;
  };
  const charBlock = /beginbfchar([\s\S]*?)endbfchar/g;
  for (;;) {
    const block = charBlock.exec(text);
    if (block === null) break;
    const pair = /<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\/(\S+))/g;
    for (;;) {
      const m = pair.exec(block[1] ?? "");
      if (m === null) break;
      const code = Number.parseInt(m[1] as string, 16);
      const value = m[2] !== undefined ? hexToString(m[2]) : (glyphToUnicode(m[3] ?? "") ?? "");
      if (value !== "") map.set(code, value);
    }
  }
  const rangeBlock = /beginbfrange([\s\S]*?)endbfrange/g;
  for (;;) {
    const block = rangeBlock.exec(text);
    if (block === null) break;
    const body = block[1] ?? "";
    // Both `<lo> <hi> <dst>` and `<lo> <hi> [<d1> <d2> ...]` are legal.
    const simple = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    for (;;) {
      const m = simple.exec(body);
      if (m === null) break;
      const lo = Number.parseInt(m[1] as string, 16);
      const hi = Number.parseInt(m[2] as string, 16);
      const dst = hexToString(m[3] as string);
      if (hi < lo || hi - lo > 65535) continue;
      for (let c = lo; c <= hi; c++) {
        if (dst.length === 1) map.set(c, String.fromCharCode(dst.charCodeAt(0) + (c - lo)));
        else map.set(c, dst);
      }
    }
    const listed = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g;
    for (;;) {
      const m = listed.exec(body);
      if (m === null) break;
      const lo = Number.parseInt(m[1] as string, 16);
      const items = (m[3] ?? "").match(/<([0-9A-Fa-f]+)>/g) ?? [];
      for (const [i, item] of items.entries()) map.set(lo + i, hexToString(item.slice(1, -1)));
    }
  }
  return map;
}

function baseEncoding(name: string | null): Map<number, string> {
  const map = new Map<number, string>();
  for (let c = 32; c < 127; c++) map.set(c, String.fromCharCode(c));
  if (name === "MacRomanEncoding") {
    for (let c = 128; c < 256; c++) {
      map.set(c, String.fromCodePoint(MAC_ROMAN_HIGH[c - 128] ?? c));
    }
    return map;
  }
  // WinAnsiEncoding and StandardEncoding agree with Latin-1 over the high
  // range for everything this package can meaningfully report; the CP1252
  // block is the only part worth special-casing.
  for (let c = 160; c < 256; c++) map.set(c, String.fromCharCode(c));
  if (name === "WinAnsiEncoding" || name === null) {
    for (let c = 128; c < 160; c++) {
      const code = WIN_ANSI_HIGH[c - 128];
      if (code !== undefined) map.set(c, String.fromCodePoint(code));
    }
  }
  return map;
}

function loadFont(doc: PdfDocument, name: string, dict: PdfDict): Font {
  const isType0 = isName(doc.get(dict, "Subtype"), "Type0");
  let toUnicode: Map<number, string> | null = null;
  const toUnicodeStream = doc.get(dict, "ToUnicode");
  if (isStream(toUnicodeStream)) {
    try {
      toUnicode = parseToUnicodeCMap(latin1(doc.decode(toUnicodeStream)));
    } catch {
      toUnicode = null;
    }
  }
  const widths = new Map<number, number>();
  let defaultWidth = 500;
  let simpleEncoding: Map<number, string> | null = null;

  if (isType0) {
    const descendantFonts = doc.get(dict, "DescendantFonts");
    const descendant = isArray(descendantFonts) ? doc.resolve(descendantFonts[0] ?? null) : null;
    if (isDict(descendant)) {
      defaultWidth = numberOf(doc.get(descendant, "DW"), 1000);
      const w = doc.get(descendant, "W");
      if (isArray(w)) {
        // /W interleaves `c [w1 w2 ...]` and `cFirst cLast w` forms.
        let i = 0;
        while (i < w.length) {
          const first = numberOf(doc.resolve(w[i] ?? null), Number.NaN);
          const second = doc.resolve(w[i + 1] ?? null);
          if (isArray(second)) {
            for (const [k, item] of second.entries()) {
              widths.set(first + k, numberOf(doc.resolve(item), defaultWidth));
            }
            i += 2;
          } else {
            const last = numberOf(second, Number.NaN);
            const width = numberOf(doc.resolve(w[i + 2] ?? null), defaultWidth);
            if (Number.isFinite(first) && Number.isFinite(last) && last - first < 65536) {
              for (let c = first; c <= last; c++) widths.set(c, width);
            }
            i += 3;
          }
        }
      }
    }
  } else {
    const encoding = doc.get(dict, "Encoding");
    let baseName: string | null = null;
    let differences: PdfValue = null;
    if (isName(encoding)) baseName = encoding.name;
    else if (isDict(encoding)) {
      const base = doc.get(encoding, "BaseEncoding");
      if (isName(base)) baseName = base.name;
      differences = doc.get(encoding, "Differences");
    }
    simpleEncoding = baseEncoding(baseName);
    if (isArray(differences)) {
      let code = 0;
      for (const item of differences) {
        const value = doc.resolve(item);
        if (typeof value === "number") code = Math.trunc(value);
        else if (isName(value)) {
          const mapped = glyphToUnicode(value.name);
          if (mapped !== undefined) simpleEncoding.set(code, mapped);
          else simpleEncoding.delete(code);
          code += 1;
        }
      }
    }
    const firstChar = numberOf(doc.get(dict, "FirstChar"), 0);
    const widthArray = doc.get(dict, "Widths");
    if (isArray(widthArray)) {
      for (const [i, item] of widthArray.entries()) {
        widths.set(firstChar + i, numberOf(doc.resolve(item), 500));
      }
    }
    const descriptor = doc.get(dict, "FontDescriptor");
    if (isDict(descriptor)) defaultWidth = numberOf(doc.get(descriptor, "MissingWidth"), 500);
  }
  return {
    name,
    codeBytes: isType0 ? 2 : 1,
    toUnicode,
    simpleEncoding,
    widths,
    defaultWidth,
    unmappable: isType0 && toUnicode === null,
  };
}

const FALLBACK_FONT: Font = {
  name: "(no font selected)",
  codeBytes: 1,
  toUnicode: null,
  simpleEncoding: baseEncoding(null),
  widths: new Map(),
  defaultWidth: 500,
  unmappable: false,
};

// ---------------------------------------------------------------------------
// the interpreter
// ---------------------------------------------------------------------------

export type PageText = {
  readonly text: string;
  /** True when the page drew any non-blank glyph at all. */
  readonly hasTextLayer: boolean;
  /** Human-readable notes about what could not be extracted. */
  readonly notes: ReadonlyArray<string>;
};

type State = {
  ctm: Matrix;
  font: Font;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScale: number;
  leading: number;
  rise: number;
};

/** Extract one page's text. */
export function extractPageText(doc: PdfDocument, page: PdfPage): PageText {
  if (doc.encrypted) {
    throw new PdfError("this pdf is encrypted; text extraction is refused rather than guessed");
  }
  const notes = new Set<string>();
  const pieces: string[] = [];
  let drewGlyph = false;
  let lastY = Number.NaN;
  let lastEndX = 0;

  const emit = (text: string, x: number, y: number, size: number): void => {
    if (text === "") return;
    if (!Number.isNaN(lastY) && Math.abs(y - lastY) > Math.max(1, size * 0.5)) {
      // The baseline moved: a new line. A move UP is usually a new column or
      // a header drawn late; both read better as a break than as a space.
      pieces.push("\n");
    } else if (pieces.length > 0 && x - lastEndX > size * 0.18 && !text.startsWith(" ")) {
      pieces.push(" ");
    }
    pieces.push(text);
    lastY = y;
  };

  const run = (
    content: Uint8Array,
    resources: PdfDict | null,
    state: State,
    depth: number,
  ): void => {
    if (depth > 8) {
      notes.add("form XObjects nested deeper than 8 levels were not followed");
      return;
    }
    const fonts = new Map<string, Font>();
    const fontDict = resources === null ? null : doc.get(resources, "Font");
    const lookupFont = (name: string): Font => {
      const cached = fonts.get(name);
      if (cached !== undefined) return cached;
      let font = FALLBACK_FONT;
      if (isDict(fontDict)) {
        const entry = doc.get(fontDict, name);
        if (isDict(entry)) font = loadFont(doc, name, entry);
      }
      fonts.set(name, font);
      return font;
    };

    const lexer = new PdfLexer(content, 0);
    const stack: PdfValue[] = [];
    const graphicsStack: State[] = [];
    let current = state;
    let textMatrix: Matrix = IDENTITY;
    let lineMatrix: Matrix = IDENTITY;

    const showText = (bytes: Uint8Array): void => {
      const font = current.font;
      const step = font.codeBytes;
      let out = "";
      let unmapped = 0;
      let advance = 0;
      for (let i = 0; i + step <= bytes.length; i += step) {
        const code =
          step === 2 ? ((bytes[i] as number) << 8) | (bytes[i + 1] as number) : (bytes[i] as number);
        let glyph: string | undefined;
        if (font.toUnicode !== null) glyph = font.toUnicode.get(code);
        if (glyph === undefined && font.simpleEncoding !== null) {
          glyph = font.simpleEncoding.get(code);
        }
        if (glyph === undefined && font.unmappable) unmapped += 1;
        if (glyph !== undefined) {
          out += glyph;
          if (glyph.trim() !== "") drewGlyph = true;
        }
        const width = font.widths.get(code) ?? font.defaultWidth;
        advance +=
          ((width / 1000) * current.fontSize +
            current.charSpacing +
            (step === 1 && code === 32 ? current.wordSpacing : 0)) *
          current.horizontalScale;
      }
      if (unmapped > 0) {
        const plural = unmapped === 1 ? "" : "s";
        notes.add(
          `font ${font.name} is a CID font with no /ToUnicode map; ${unmapped} character${plural} could not be mapped to text`,
        );
      }
      const device = multiply(textMatrix, current.ctm);
      const scale = device[0] === 0 ? 1 : Math.abs(device[0]);
      const size = Math.abs(current.fontSize * (device[3] === 0 ? 1 : device[3]));
      emit(out, device[4], device[5], size === 0 ? 12 : size);
      lastEndX = device[4] + advance * scale;
      textMatrix = multiply([1, 0, 0, 1, advance, 0], textMatrix);
    };

    const num = (fromTop: number): number => {
      const value = stack[stack.length - fromTop];
      return typeof value === "number" ? value : 0;
    };

    while (lexer.pos < content.length) {
      lexer.skipWhitespace();
      if (lexer.pos >= content.length) break;
      const b = content[lexer.pos] as number;
      // Operands look like objects; operators are bare keywords.
      const isOperandStart =
        b === 0x2f ||
        b === 0x28 ||
        b === 0x3c ||
        b === 0x5b ||
        (b >= 0x30 && b <= 0x39) ||
        b === 0x2b ||
        b === 0x2d ||
        b === 0x2e;
      if (isOperandStart) {
        const before = lexer.pos;
        try {
          stack.push(lexer.parseValue());
        } catch {
          lexer.pos = before + 1;
        }
        if (lexer.pos <= before) lexer.pos = before + 1;
        if (stack.length > 512) stack.splice(0, stack.length - 512);
        continue;
      }
      const op = lexer.readToken();
      switch (op) {
        case "q":
          graphicsStack.push({ ...current });
          break;
        case "Q": {
          const popped = graphicsStack.pop();
          if (popped !== undefined) current = popped;
          break;
        }
        case "cm":
          current.ctm = multiply([num(6), num(5), num(4), num(3), num(2), num(1)], current.ctm);
          break;
        case "BT":
          textMatrix = IDENTITY;
          lineMatrix = IDENTITY;
          break;
        case "Tf": {
          const fontName = stack[stack.length - 2];
          current.fontSize = num(1);
          current.font = isName(fontName) ? lookupFont(fontName.name) : FALLBACK_FONT;
          break;
        }
        case "Td":
          lineMatrix = multiply([1, 0, 0, 1, num(2), num(1)], lineMatrix);
          textMatrix = lineMatrix;
          break;
        case "TD":
          current.leading = -num(1);
          lineMatrix = multiply([1, 0, 0, 1, num(2), num(1)], lineMatrix);
          textMatrix = lineMatrix;
          break;
        case "Tm":
          lineMatrix = [num(6), num(5), num(4), num(3), num(2), num(1)];
          textMatrix = lineMatrix;
          break;
        case "T*":
          lineMatrix = multiply([1, 0, 0, 1, 0, -current.leading], lineMatrix);
          textMatrix = lineMatrix;
          break;
        case "TL":
          current.leading = num(1);
          break;
        case "Tc":
          current.charSpacing = num(1);
          break;
        case "Tw":
          current.wordSpacing = num(1);
          break;
        case "Tz":
          current.horizontalScale = num(1) / 100;
          break;
        case "Ts":
          current.rise = num(1);
          break;
        case "Tj": {
          const value = stack[stack.length - 1];
          if (isString(value)) showText(value.bytes);
          break;
        }
        case "'": {
          lineMatrix = multiply([1, 0, 0, 1, 0, -current.leading], lineMatrix);
          textMatrix = lineMatrix;
          const value = stack[stack.length - 1];
          if (isString(value)) showText(value.bytes);
          break;
        }
        case '"': {
          current.wordSpacing = num(3);
          current.charSpacing = num(2);
          lineMatrix = multiply([1, 0, 0, 1, 0, -current.leading], lineMatrix);
          textMatrix = lineMatrix;
          const value = stack[stack.length - 1];
          if (isString(value)) showText(value.bytes);
          break;
        }
        case "TJ": {
          const array = stack[stack.length - 1];
          if (isArray(array)) {
            for (const item of array) {
              if (isString(item)) showText(item.bytes);
              else if (typeof item === "number") {
                // A negative adjustment moves the pen forward by item/1000
                // of an em; that is how a PDF usually expresses a space.
                const shift = (-item / 1000) * current.fontSize * current.horizontalScale;
                textMatrix = multiply([1, 0, 0, 1, shift, 0], textMatrix);
                lastEndX += shift;
              }
            }
          }
          break;
        }
        case "Do": {
          const name = stack[stack.length - 1];
          if (!isName(name) || resources === null) break;
          const xobjects = doc.get(resources, "XObject");
          if (!isDict(xobjects)) break;
          const target = doc.get(xobjects, name.name);
          if (!isStream(target)) break;
          if (!isName(doc.get(target.dict, "Subtype"), "Form")) break;
          let data: Uint8Array;
          try {
            data = doc.decode(target);
          } catch (err) {
            if (!(err instanceof PdfFilterError)) throw err;
            notes.add(`form XObject /${name.name} could not be decoded: ${err.message}`);
            break;
          }
          const formResources = doc.get(target.dict, "Resources");
          const matrixValue = doc.get(target.dict, "Matrix");
          let ctm = current.ctm;
          if (isArray(matrixValue) && matrixValue.length === 6) {
            const m = matrixValue.map((v) => numberOf(doc.resolve(v), 0));
            ctm = multiply(
              [
                m[0] as number,
                m[1] as number,
                m[2] as number,
                m[3] as number,
                m[4] as number,
                m[5] as number,
              ],
              ctm,
            );
          }
          run(data, isDict(formResources) ? formResources : resources, { ...current, ctm }, depth + 1);
          break;
        }
        case "BI":
          // An inline image's binary payload would lex as garbage; skip it.
          lexer.pos = findInlineImageEnd(content, lexer.pos);
          notes.add("inline images were skipped");
          break;
        default:
          break;
      }
      stack.length = 0;
    }
  };

  let content: Uint8Array;
  try {
    content = doc.pageContent(page);
  } catch (err) {
    if (err instanceof PdfFilterError) {
      return { text: "", hasTextLayer: false, notes: [err.message] };
    }
    throw err;
  }
  run(
    content,
    page.resources,
    {
      ctm: IDENTITY,
      font: FALLBACK_FONT,
      fontSize: 12,
      charSpacing: 0,
      wordSpacing: 0,
      horizontalScale: 1,
      leading: 0,
      rise: 0,
    },
    0,
  );

  const text = pieces
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, hasTextLayer: drewGlyph, notes: [...notes].sort() };
}

/** Find the `EI` that closes an inline image, skipping its binary payload. */
function findInlineImageEnd(content: Uint8Array, from: number): number {
  // Data begins after `ID` plus one whitespace byte; `EI` must be preceded
  // by whitespace and followed by whitespace or the end of the stream.
  let i = from;
  while (i + 1 < content.length && !(content[i] === 0x49 && content[i + 1] === 0x44)) i += 1;
  i += 3;
  while (i + 1 < content.length) {
    if (
      content[i] === 0x45 &&
      content[i + 1] === 0x49 &&
      (content[i - 1] ?? 32) <= 32 &&
      (content[i + 2] ?? 32) <= 32
    ) {
      return i + 2;
    }
    i += 1;
  }
  return content.length;
}

export type DocumentPageText = {
  readonly page: number;
  readonly text: string;
  readonly hasTextLayer: boolean;
};

/** Extract several pages, honouring a character budget across the whole run. */
export function extractDocumentText(
  doc: PdfDocument,
  pageNumbers: ReadonlyArray<number>,
  maxChars: number,
): { pages: DocumentPageText[]; notes: string[]; truncated: boolean } {
  const pages = doc.pages();
  const out: DocumentPageText[] = [];
  const notes = new Set<string>();
  let spent = 0;
  let truncated = false;
  for (const number of pageNumbers) {
    const page = pages[number - 1];
    if (page === undefined) continue;
    const result = extractPageText(doc, page);
    for (const note of result.notes) notes.add(`page ${number}: ${note}`);
    let text = result.text;
    if (spent + text.length > maxChars) {
      text = text.slice(0, Math.max(0, maxChars - spent));
      truncated = true;
    }
    spent += text.length;
    out.push({ page: number, text, hasTextLayer: result.hasTextLayer });
    if (truncated) break;
  }
  return { pages: out, notes: [...notes].sort(), truncated };
}
