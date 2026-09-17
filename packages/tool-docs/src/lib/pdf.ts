/**
 * A PDF object reader: lexer, object model, page tree and stream filters.
 *
 * ## The approach, and why
 *
 * A PDF is a set of numbered objects plus a cross-reference index saying
 * where each one starts. Real-world PDFs have broken indexes constantly —
 * concatenated files, truncated downloads, generators that miscount bytes —
 * and every viewer therefore has a "repair" path that ignores the index and
 * scans for objects. This reader does the scan FIRST, sequentially, skipping
 * over each stream's data using its own `/Length` so that an `obj` token
 * inside compressed bytes is never mistaken for an object header. The
 * cross-reference index is used only for what the scan cannot see: objects
 * stored inside object streams (`/Type /ObjStm`), and the trailer's `/Root`.
 *
 * A later definition of an object number wins, which is what an incremental
 * update means.
 *
 * ## Supported
 *
 * - All eight object types: null, boolean, number, string (literal and
 *   hexadecimal), name, array, dictionary, stream — plus indirect
 *   references.
 * - Cross-reference STREAMS (`/Type /XRef`, PDF 1.5+), including the PNG
 *   predictors used to compress them, for the sole purpose of finding object
 *   streams and the document catalog.
 * - Object streams: their contents are parsed and merged into the object map.
 * - Stream filters: `FlateDecode` (with PNG and TIFF predictors),
 *   `LZWDecode`, `ASCIIHexDecode`, `ASCII85Decode` and `RunLengthDecode`,
 *   including filter chains.
 * - The page tree, with `/Resources`, `/MediaBox`, `/CropBox` and `/Rotate`
 *   inherited from ancestor nodes as the specification requires.
 * - Text strings in metadata, decoded from UTF-16BE (with BOM) or
 *   PDFDocEncoding.
 *
 * ## Not supported — each refuses rather than guessing
 *
 * - ENCRYPTED documents. A `/Encrypt` entry in the trailer is detected and
 *   reported, and every content operation refuses. There is no decryption
 *   here, not even for the empty user password, because a tool that
 *   sometimes opens protected files teaches callers the wrong thing.
 * - `JPXDecode`, `DCTDecode`, `JBIG2Decode` and `CCITTFaxDecode` — these are
 *   image codecs. Their streams are left compressed; no text lives in them.
 * - Linearisation hints, incremental-update history, digital signatures,
 *   tagged-PDF structure trees, and generation numbers (objects are keyed by
 *   number alone, which is what every real file relies on anyway).
 */
import { inflateRawSync, inflateSync } from "node:zlib";

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

export type PdfName = { readonly kind: "name"; readonly name: string };
export type PdfRef = { readonly kind: "ref"; readonly num: number; readonly gen: number };
export type PdfString = { readonly kind: "string"; readonly bytes: Uint8Array };
export type PdfDict = Map<string, PdfValue>;
export type PdfStream = {
  readonly kind: "stream";
  readonly dict: PdfDict;
  readonly raw: Uint8Array;
};
export type PdfValue =
  | null
  | boolean
  | number
  | PdfName
  | PdfRef
  | PdfString
  | PdfValue[]
  | PdfDict
  | PdfStream;

export function isName(v: PdfValue | undefined, name?: string): v is PdfName {
  return (
    typeof v === "object" &&
    v !== null &&
    v !== undefined &&
    "kind" in v &&
    v.kind === "name" &&
    (name === undefined || v.name === name)
  );
}
export function isRef(v: PdfValue | undefined): v is PdfRef {
  return typeof v === "object" && v !== null && v !== undefined && "kind" in v && v.kind === "ref";
}
export function isString(v: PdfValue | undefined): v is PdfString {
  return typeof v === "object" && v !== null && v !== undefined && "kind" in v && v.kind === "string";
}
export function isStream(v: PdfValue | undefined): v is PdfStream {
  return typeof v === "object" && v !== null && v !== undefined && "kind" in v && v.kind === "stream";
}
export function isDict(v: PdfValue | undefined): v is PdfDict {
  return v instanceof Map;
}
export function isArray(v: PdfValue | undefined): v is PdfValue[] {
  return Array.isArray(v);
}

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(byte: number): boolean {
  return !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
}

/** A one-pass reader over the file's bytes. */
export class PdfLexer {
  readonly bytes: Uint8Array;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  private byte(at = this.pos): number {
    return this.bytes[at] ?? -1;
  }

  skipWhitespace(): void {
    for (;;) {
      while (this.pos < this.bytes.length && WHITESPACE.has(this.byte())) this.pos += 1;
      if (this.byte() !== 0x25) return; // '%' comment runs to end of line
      while (this.pos < this.bytes.length && this.byte() !== 10 && this.byte() !== 13) {
        this.pos += 1;
      }
    }
  }

  /** The next regular-character run, e.g. `obj`, `endobj`, `R`, `true`. */
  readToken(): string {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.bytes.length && isRegular(this.byte())) this.pos += 1;
    if (this.pos === start) {
      this.pos += 1;
      return String.fromCharCode(this.byte(start));
    }
    return latin1(this.bytes.subarray(start, this.pos));
  }

  peekToken(): string {
    const save = this.pos;
    const token = this.readToken();
    this.pos = save;
    return token;
  }

  /** Parse one object at the current position. */
  parseValue(depth = 0): PdfValue {
    if (depth > 64) throw new PdfError("pdf object nests deeper than 64 levels");
    this.skipWhitespace();
    const b = this.byte();
    if (b < 0) throw new PdfError("unexpected end of pdf while reading an object");
    if (b === 0x2f) return this.parseName();
    if (b === 0x28) return this.parseLiteralString();
    if (b === 0x5b) return this.parseArray(depth);
    if (b === 0x3c) {
      return this.byte(this.pos + 1) === 0x3c ? this.parseDict(depth) : this.parseHexString();
    }
    if (b === 0x5d || b === 0x3e || b === 0x29) {
      throw new PdfError(`unexpected '${String.fromCharCode(b)}' in pdf object`);
    }
    const token = this.readToken();
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      const value = Number.parseFloat(token);
      // `12 0 R` — an integer followed by an integer and `R` is a reference.
      if (/^\d+$/.test(token)) {
        const save = this.pos;
        const genToken = this.readToken();
        if (/^\d+$/.test(genToken)) {
          const rToken = this.readToken();
          if (rToken === "R") {
            return { kind: "ref", num: value, gen: Number.parseInt(genToken, 10) };
          }
        }
        this.pos = save;
      }
      return value;
    }
    throw new PdfError(`unrecognised pdf token "${token.slice(0, 32)}"`);
  }

  parseName(): PdfName {
    this.pos += 1; // '/'
    let out = "";
    while (this.pos < this.bytes.length && isRegular(this.byte())) {
      const b = this.byte();
      if (b === 0x23 && this.pos + 2 < this.bytes.length) {
        // `#xx` escapes any byte in a name.
        const hex = latin1(this.bytes.subarray(this.pos + 1, this.pos + 3));
        const code = Number.parseInt(hex, 16);
        if (Number.isFinite(code)) {
          out += String.fromCharCode(code);
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(b);
      this.pos += 1;
    }
    return { kind: "name", name: out };
  }

  parseLiteralString(): PdfString {
    this.pos += 1; // '('
    const out: number[] = [];
    let nesting = 0;
    while (this.pos < this.bytes.length) {
      const b = this.byte();
      this.pos += 1;
      if (b === 0x5c) {
        const esc = this.byte();
        this.pos += 1;
        switch (esc) {
          case 0x6e:
            out.push(10);
            break;
          case 0x72:
            out.push(13);
            break;
          case 0x74:
            out.push(9);
            break;
          case 0x62:
            out.push(8);
            break;
          case 0x66:
            out.push(12);
            break;
          case 10:
            break; // line continuation
          case 13:
            if (this.byte() === 10) this.pos += 1;
            break;
          default:
            if (esc >= 0x30 && esc <= 0x37) {
              let octal = esc - 0x30;
              for (let k = 0; k < 2; k++) {
                const next = this.byte();
                if (next < 0x30 || next > 0x37) break;
                octal = octal * 8 + (next - 0x30);
                this.pos += 1;
              }
              out.push(octal & 0xff);
            } else out.push(esc);
        }
        continue;
      }
      if (b === 0x28) nesting += 1;
      if (b === 0x29) {
        if (nesting === 0) break;
        nesting -= 1;
      }
      out.push(b);
    }
    return { kind: "string", bytes: Uint8Array.from(out) };
  }

  parseHexString(): PdfString {
    this.pos += 1; // '<'
    const digits: string[] = [];
    while (this.pos < this.bytes.length && this.byte() !== 0x3e) {
      const ch = String.fromCharCode(this.byte());
      if (/[0-9A-Fa-f]/.test(ch)) digits.push(ch);
      this.pos += 1;
    }
    this.pos += 1; // '>'
    if (digits.length % 2 === 1) digits.push("0"); // an odd digit is padded
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.parseInt(`${digits[2 * i]}${digits[2 * i + 1]}`, 16);
    }
    return { kind: "string", bytes: out };
  }

  parseArray(depth: number): PdfValue[] {
    this.pos += 1; // '['
    const out: PdfValue[] = [];
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.bytes.length) throw new PdfError("unterminated pdf array");
      if (this.byte() === 0x5d) {
        this.pos += 1;
        return out;
      }
      if (out.length > 200_000) throw new PdfError("pdf array is implausibly large");
      out.push(this.parseValue(depth + 1));
    }
  }

  parseDict(depth: number): PdfDict | PdfStream {
    this.pos += 2; // '<<'
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.bytes.length) throw new PdfError("unterminated pdf dictionary");
      if (this.byte() === 0x3e && this.byte(this.pos + 1) === 0x3e) {
        this.pos += 2;
        break;
      }
      if (this.byte() !== 0x2f) {
        throw new PdfError("pdf dictionary key is not a name");
      }
      const key = this.parseName().name;
      dict.set(key, this.parseValue(depth + 1));
    }
    const save = this.pos;
    if (this.readToken() !== "stream") {
      this.pos = save;
      return dict;
    }
    // The keyword is followed by CRLF or LF (never CR alone, per the spec,
    // though a stray CR is tolerated here).
    if (this.byte() === 13) this.pos += 1;
    if (this.byte() === 10) this.pos += 1;
    const start = this.pos;
    const declared = dict.get("Length");
    let end = -1;
    if (typeof declared === "number" && declared >= 0 && start + declared <= this.bytes.length) {
      const probe = new PdfLexer(this.bytes, start + declared);
      if (probe.peekToken() === "endstream") end = start + declared;
    }
    if (end < 0) {
      // Either /Length was indirect or it lied. Find the keyword instead —
      // this is the single most common repair a PDF reader performs.
      end = indexOfBytes(this.bytes, ENDSTREAM, start);
      if (end < 0) throw new PdfError("pdf stream has no endstream keyword");
      let trimmed = end;
      if (this.bytes[trimmed - 1] === 10) trimmed -= 1;
      if (this.bytes[trimmed - 1] === 13) trimmed -= 1;
      end = trimmed;
    }
    const raw = this.bytes.subarray(start, end);
    this.pos = end;
    const after = indexOfBytes(this.bytes, ENDSTREAM, end);
    this.pos = after < 0 ? end : after + ENDSTREAM.length;
    return { kind: "stream", dict, raw };
  }
}

const ENDSTREAM = new TextEncoder().encode("endstream");
const OBJ = new TextEncoder().encode("obj");
const TRAILER = new TextEncoder().encode("trailer");

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0] as number;
  const limit = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= limit; i++) {
    if (haystack[i] !== first) continue;
    let k = 1;
    while (k < needle.length && haystack[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

export function latin1(bytes: Uint8Array): string {
  let out = "";
  // Chunked so a large stream does not blow the argument limit.
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

/** Undo a PNG or TIFF predictor, as `/DecodeParms` describes it. */
function unpredict(data: Uint8Array, predictor: number, colors: number, bpc: number, columns: number): Uint8Array {
  if (predictor <= 1) return data;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) {
    // TIFF predictor: horizontal differencing, only the 8-bit case is common.
    if (bpc !== 8) throw new PdfError(`TIFF predictor with ${bpc} bits per component is not supported`);
    const out = Uint8Array.from(data);
    for (let r = 0; r + rowLength <= out.length; r += rowLength) {
      for (let i = bpp; i < rowLength; i++) {
        out[r + i] = ((out[r + i] as number) + (out[r + i - bpp] as number)) & 0xff;
      }
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  let prev = new Uint8Array(rowLength);
  for (let r = 0; r < rows; r++) {
    const tag = data[r * (rowLength + 1)] as number;
    const row = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const cur = new Uint8Array(rowLength);
    for (let i = 0; i < rowLength; i++) {
      const raw = row[i] ?? 0;
      const left = i >= bpp ? (cur[i - bpp] as number) : 0;
      const up = prev[i] as number;
      const upLeft = i >= bpp ? (prev[i - bpp] as number) : 0;
      switch (tag) {
        case 0:
          cur[i] = raw;
          break;
        case 1:
          cur[i] = (raw + left) & 0xff;
          break;
        case 2:
          cur[i] = (raw + up) & 0xff;
          break;
        case 3:
          cur[i] = (raw + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const best = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          cur[i] = (raw + best) & 0xff;
          break;
        }
        default:
          throw new PdfError(`unknown PNG predictor tag ${tag}`);
      }
    }
    out.set(cur, r * rowLength);
    prev = cur;
  }
  return out;
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i] as number;
    if (WHITESPACE.has(b)) continue;
    if (b === 0x7e) break; // '~>' terminator
    if (b === 0x7a && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (b < 0x21 || b > 0x75) throw new PdfError("invalid character in an ASCII85 stream");
    tuple = tuple * 85 + (b - 0x21);
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    for (let i = 0; i < count - 1; i++) out.push(bytes[i] as number);
  }
  return Uint8Array.from(out);
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const digits: string[] = [];
  for (const b of data) {
    if (b === 0x3e) break;
    const ch = String.fromCharCode(b);
    if (/[0-9A-Fa-f]/.test(ch)) digits.push(ch);
  }
  if (digits.length % 2 === 1) digits.push("0");
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(`${digits[2 * i]}${digits[2 * i + 1]}`, 16);
  }
  return out;
}

function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const len = data[i] as number;
    i += 1;
    if (len === 128) break;
    if (len < 128) {
      for (let k = 0; k <= len; k++) out.push(data[i + k] ?? 0);
      i += len + 1;
    } else {
      const b = data[i] ?? 0;
      for (let k = 0; k < 257 - len; k++) out.push(b);
      i += 1;
    }
  }
  return Uint8Array.from(out);
}

/** LZW as PDF uses it: 8-bit input, variable code width, early change. */
function lzwDecode(data: Uint8Array, earlyChange: number, maxBytes: number): Uint8Array {
  const out: number[] = [];
  let dictionary: number[][] = [];
  const reset = (): void => {
    dictionary = [];
    for (let i = 0; i < 256; i++) dictionary.push([i]);
    dictionary.push([], []); // 256 = clear, 257 = EOD
  };
  reset();
  let codeWidth = 9;
  let previous: number[] | null = null;
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i <= data.length; i++) {
    if (i < data.length) {
      buffer = (buffer << 8) | (data[i] as number);
      bits += 8;
    } else if (bits < codeWidth) break;
    while (bits >= codeWidth) {
      const code = (buffer >> (bits - codeWidth)) & ((1 << codeWidth) - 1);
      bits -= codeWidth;
      if (code === 256) {
        reset();
        codeWidth = 9;
        previous = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry: number[];
      const known = dictionary[code];
      if (known !== undefined && code < dictionary.length && (code < 256 || known.length > 0)) {
        entry = known;
      } else if (previous !== null) {
        entry = [...previous, previous[0] as number];
      } else {
        throw new PdfError("LZW stream starts with an undefined code");
      }
      for (const b of entry) out.push(b);
      if (out.length > maxBytes) throw new PdfError("LZW stream expands past the decode limit");
      if (previous !== null) dictionary.push([...previous, entry[0] as number]);
      previous = entry;
      const limit = dictionary.length + earlyChange;
      if (limit >= 512 && codeWidth === 9) codeWidth = 10;
      else if (limit >= 1024 && codeWidth === 10) codeWidth = 11;
      else if (limit >= 2048 && codeWidth === 11) codeWidth = 12;
    }
  }
  return Uint8Array.from(out);
}

/** Filters this reader deliberately leaves alone: they carry image data. */
export const IMAGE_FILTERS: ReadonlySet<string> = new Set([
  "DCTDecode",
  "JPXDecode",
  "JBIG2Decode",
  "CCITTFaxDecode",
]);

export class PdfFilterError extends PdfError {}

/**
 * Decode a stream through its filter chain. `maxBytes` caps the output and
 * is passed into the inflater, so a compression bomb aborts mid-stream.
 */
export function decodeStream(
  stream: PdfStream,
  resolve: (v: PdfValue) => PdfValue,
  maxBytes: number,
): Uint8Array {
  const filterValue = resolve(stream.dict.get("Filter") ?? null);
  const filters: string[] = [];
  if (isName(filterValue)) filters.push(filterValue.name);
  else if (isArray(filterValue)) {
    for (const f of filterValue) {
      const r = resolve(f);
      if (isName(r)) filters.push(r.name);
    }
  }
  const parmsValue = resolve(stream.dict.get("DecodeParms") ?? stream.dict.get("DP") ?? null);
  const parmsList: PdfValue[] = isArray(parmsValue) ? parmsValue : [parmsValue];

  let data = stream.raw;
  for (const [i, filter] of filters.entries()) {
    if (IMAGE_FILTERS.has(filter)) {
      throw new PdfFilterError(`stream uses the image filter ${filter}; it holds no text`);
    }
    switch (filter) {
      case "FlateDecode":
      case "Fl":
        try {
          data = new Uint8Array(inflateSync(data, { maxOutputLength: maxBytes }));
        } catch {
          // Some producers omit the zlib header. Raw inflate is the fallback
          // every viewer uses before giving up.
          try {
            data = new Uint8Array(inflateRawSync(data, { maxOutputLength: maxBytes }));
          } catch (err) {
            throw new PdfFilterError(`FlateDecode failed: ${(err as Error).message}`);
          }
        }
        break;
      case "LZWDecode":
      case "LZW": {
        const parms = resolve(parmsList[i] ?? null);
        const early = isDict(parms) ? numberOf(resolve(parms.get("EarlyChange") ?? null), 1) : 1;
        data = lzwDecode(data, early === 0 ? 0 : 1, maxBytes);
        break;
      }
      case "ASCII85Decode":
      case "A85":
        data = ascii85Decode(data);
        break;
      case "ASCIIHexDecode":
      case "AHx":
        data = asciiHexDecode(data);
        break;
      case "RunLengthDecode":
      case "RL":
        data = runLengthDecode(data);
        break;
      case "Crypt":
        throw new PdfFilterError("stream uses the Crypt filter; the document is encrypted");
      default:
        throw new PdfFilterError(`unsupported stream filter ${filter}`);
    }
    if (data.length > maxBytes) {
      throw new PdfFilterError(`stream decoded past the ${maxBytes} byte limit`);
    }
    const parms = resolve(parmsList[i] ?? null);
    if (isDict(parms)) {
      const predictor = numberOf(resolve(parms.get("Predictor") ?? null), 1);
      if (predictor > 1) {
        data = unpredict(
          data,
          predictor,
          numberOf(resolve(parms.get("Colors") ?? null), 1),
          numberOf(resolve(parms.get("BitsPerComponent") ?? null), 8),
          numberOf(resolve(parms.get("Columns") ?? null), 1),
        );
      }
    }
  }
  return data;
}

export function numberOf(value: PdfValue, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * A PDF text string as text. Strings are UTF-16BE when they start with the
 * byte-order mark and PDFDocEncoding otherwise; PDFDocEncoding agrees with
 * Latin-1 over the range metadata actually uses.
 */
export function pdfStringToText(value: PdfString): string {
  const b = value.bytes;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let out = "";
    for (let i = 2; i + 1 < b.length; i += 2) {
      out += String.fromCharCode(((b[i] as number) << 8) | (b[i + 1] as number));
    }
    return out;
  }
  return latin1(b);
}

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

export type PdfLimits = {
  readonly maxFileBytes: number;
  readonly maxObjects: number;
  readonly maxStreamBytes: number;
  readonly maxPages: number;
};

export const DEFAULT_PDF_LIMITS: PdfLimits = Object.freeze({
  maxFileBytes: 128 * 1024 * 1024,
  maxObjects: 500_000,
  maxStreamBytes: 64 * 1024 * 1024,
  maxPages: 20_000,
});

export type PdfPage = {
  readonly index: number;
  readonly dict: PdfDict;
  /** MediaBox as [x0,y0,x1,y1], inherited if the page does not carry one. */
  readonly mediaBox: readonly [number, number, number, number];
  readonly rotate: number;
  readonly resources: PdfDict | null;
};

export class PdfDocument {
  readonly bytes: Uint8Array;
  readonly objects: Map<number, PdfValue>;
  readonly trailer: PdfDict;
  readonly encrypted: boolean;
  readonly version: string;
  readonly limits: PdfLimits;
  private pagesCache: PdfPage[] | null = null;

  constructor(
    bytes: Uint8Array,
    objects: Map<number, PdfValue>,
    trailer: PdfDict,
    version: string,
    limits: PdfLimits,
  ) {
    this.bytes = bytes;
    this.objects = objects;
    this.trailer = trailer;
    this.version = version;
    this.limits = limits;
    this.encrypted = trailer.has("Encrypt");
  }

  /** Follow indirect references until a direct value is reached. */
  resolve = (value: PdfValue): PdfValue => {
    let current = value;
    for (let i = 0; i < 64; i++) {
      if (!isRef(current)) return current;
      const next = this.objects.get(current.num);
      if (next === undefined) return null;
      current = next;
    }
    throw new PdfError("indirect reference chain is longer than 64 links");
  };

  get(dict: PdfDict, key: string): PdfValue {
    return this.resolve(dict.get(key) ?? null);
  }

  decode(stream: PdfStream): Uint8Array {
    return decodeStream(stream, this.resolve, this.limits.maxStreamBytes);
  }

  /** The document catalog, found through the trailer's `/Root`. */
  catalog(): PdfDict | null {
    const root = this.resolve(this.trailer.get("Root") ?? null);
    if (isDict(root)) return root;
    // No usable /Root: fall back to the object that says it is the catalog.
    for (const [, value] of [...this.objects].sort((a, b) => a[0] - b[0])) {
      if (isDict(value) && isName(value.get("Type") ?? null, "Catalog")) return value;
    }
    return null;
  }

  /**
   * The pages, in order, with `/Resources`, `/MediaBox`, `/CropBox` and
   * `/Rotate` inherited from ancestors as the specification requires.
   */
  pages(): PdfPage[] {
    if (this.pagesCache !== null) return this.pagesCache;
    const out: PdfPage[] = [];
    const catalog = this.catalog();
    const seen = new Set<PdfDict>();
    const walk = (
      node: PdfValue,
      inherited: { mediaBox: PdfValue; resources: PdfValue; rotate: PdfValue },
      depth: number,
    ): void => {
      if (depth > 64 || out.length >= this.limits.maxPages) return;
      const dict = this.resolve(node);
      if (!isDict(dict) || seen.has(dict)) return;
      const next = {
        mediaBox: dict.get("MediaBox") ?? inherited.mediaBox,
        resources: dict.get("Resources") ?? inherited.resources,
        rotate: dict.get("Rotate") ?? inherited.rotate,
      };
      const kids = this.get(dict, "Kids");
      if (isArray(kids) && !isName(dict.get("Type") ?? null, "Page")) {
        seen.add(dict);
        for (const kid of kids) walk(kid, next, depth + 1);
        seen.delete(dict);
        return;
      }
      if (!isName(dict.get("Type") ?? null, "Page") && !dict.has("Contents")) return;
      const box = this.resolve(next.mediaBox);
      const numbers: number[] = [];
      if (isArray(box)) for (const v of box) numbers.push(numberOf(this.resolve(v), 0));
      // US Letter is the fallback every viewer uses for a missing MediaBox.
      const mediaBox: [number, number, number, number] =
        numbers.length === 4
          ? [numbers[0] as number, numbers[1] as number, numbers[2] as number, numbers[3] as number]
          : [0, 0, 612, 792];
      const resources = this.resolve(next.resources);
      out.push({
        index: out.length + 1,
        dict,
        mediaBox,
        rotate: ((numberOf(this.resolve(next.rotate), 0) % 360) + 360) % 360,
        resources: isDict(resources) ? resources : null,
      });
    };
    if (catalog !== null) {
      walk(catalog.get("Pages") ?? null, { mediaBox: null, resources: null, rotate: null }, 0);
    }
    if (out.length === 0) {
      // A file whose catalog is unusable still has page objects in it.
      for (const [, value] of [...this.objects].sort((a, b) => a[0] - b[0])) {
        if (isDict(value) && isName(value.get("Type") ?? null, "Page")) {
          walk(value, { mediaBox: null, resources: null, rotate: null }, 0);
        }
      }
    }
    this.pagesCache = out;
    return out;
  }

  /** The concatenated, decoded content streams of one page. */
  pageContent(page: PdfPage): Uint8Array {
    const contents = this.get(page.dict, "Contents");
    const streams: PdfStream[] = [];
    if (isStream(contents)) streams.push(contents);
    else if (isArray(contents)) {
      for (const item of contents) {
        const s = this.resolve(item);
        if (isStream(s)) streams.push(s);
      }
    }
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const stream of streams) {
      const data = this.decode(stream);
      total += data.length + 1;
      if (total > this.limits.maxStreamBytes) {
        throw new PdfError("page content exceeds the decode limit");
      }
      parts.push(data, Uint8Array.from([10]));
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /** `/Info` metadata as plain strings, sorted by key. */
  info(): Record<string, string> {
    const info = this.resolve(this.trailer.get("Info") ?? null);
    const out: Record<string, string> = {};
    if (!isDict(info)) return out;
    for (const key of [...info.keys()].sort()) {
      const value = this.resolve(info.get(key) ?? null);
      if (isString(value)) {
        const text = pdfStringToText(value).trim();
        if (text !== "") out[key] = text;
      } else if (isName(value)) out[key] = `/${value.name}`;
      else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
    }
    return out;
  }
}

/** Parse a PDF file. See the module comment for the strategy. */
export function parsePdf(bytes: Uint8Array, limits: PdfLimits = DEFAULT_PDF_LIMITS): PdfDocument {
  if (bytes.length > limits.maxFileBytes) {
    throw new PdfError(`pdf is ${bytes.length} bytes, over the ${limits.maxFileBytes} limit`);
  }
  const header = latin1(bytes.subarray(0, Math.min(1024, bytes.length)));
  const headerAt = header.indexOf("%PDF-");
  if (headerAt < 0) throw new PdfError("not a pdf (no %PDF- header in the first 1024 bytes)");
  const version = (/^%PDF-(\d+\.\d+)/.exec(header.slice(headerAt)) ?? [])[1] ?? "unknown";

  const objects = new Map<number, PdfValue>();
  const trailer: PdfDict = new Map();
  const objStreams: PdfStream[] = [];

  // Sequential scan for `N G obj`, jumping over each stream's data.
  let at = 0;
  while (at < bytes.length && objects.size < limits.maxObjects) {
    const found = indexOfBytes(bytes, OBJ, at);
    if (found < 0) break;
    // `obj` must be a whole token: `endobj` is filtered out by the backward
    // walk below (no digits before it), but `objxyz` has to be rejected here.
    const after = bytes[found + 3];
    if (after !== undefined && isRegular(after)) {
      at = found + OBJ.length;
      continue;
    }
    // Walk back over the generation and object numbers to the header start.
    let k = found;
    while (k > 0 && WHITESPACE.has(bytes[k - 1] as number)) k -= 1;
    const genEnd = k;
    while (k > 0 && (bytes[k - 1] as number) >= 0x30 && (bytes[k - 1] as number) <= 0x39) k -= 1;
    const genStart = k;
    while (k > 0 && WHITESPACE.has(bytes[k - 1] as number)) k -= 1;
    const numEnd = k;
    while (k > 0 && (bytes[k - 1] as number) >= 0x30 && (bytes[k - 1] as number) <= 0x39) k -= 1;
    const numStart = k;
    if (genStart === genEnd || numStart === numEnd) {
      at = found + OBJ.length;
      continue;
    }
    const num = Number.parseInt(latin1(bytes.subarray(numStart, numEnd)), 10);
    const lexer = new PdfLexer(bytes, found + OBJ.length);
    let value: PdfValue;
    try {
      value = lexer.parseValue();
    } catch {
      at = found + OBJ.length;
      continue;
    }
    objects.set(num, value);
    if (isStream(value) && isName(lexerResolveType(value), "ObjStm")) objStreams.push(value);
    at = Math.max(lexer.pos, found + OBJ.length);
  }

  // The trailer: classic `trailer << … >>` dictionaries, then any xref
  // stream's own dictionary. Later ones win, matching incremental updates.
  let trailerAt = 0;
  for (;;) {
    const found = indexOfBytes(bytes, TRAILER, trailerAt);
    if (found < 0) break;
    trailerAt = found + TRAILER.length;
    try {
      const dict = new PdfLexer(bytes, trailerAt).parseValue();
      if (isDict(dict)) for (const [key, value] of dict) trailer.set(key, value);
    } catch {
      // A "trailer" that is not followed by a dictionary is not a trailer.
    }
  }
  for (const [, value] of objects) {
    if (isStream(value) && isName(value.dict.get("Type") ?? null, "XRef")) {
      for (const key of ["Root", "Info", "Encrypt", "Size", "ID"]) {
        const entry = value.dict.get(key);
        if (entry !== undefined && !trailer.has(key)) trailer.set(key, entry);
      }
    }
  }

  const doc = new PdfDocument(bytes, objects, trailer, version, limits);

  // Object streams hold the objects a 1.5+ file does not write directly.
  for (const stream of objStreams) {
    if (doc.encrypted) break; // their contents are encrypted too
    let data: Uint8Array;
    try {
      data = doc.decode(stream);
    } catch {
      continue;
    }
    const count = numberOf(doc.get(stream.dict, "N"), 0);
    const first = numberOf(doc.get(stream.dict, "First"), 0);
    const headerLexer = new PdfLexer(data, 0);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      const objNum = Number.parseInt(headerLexer.readToken(), 10);
      const offset = Number.parseInt(headerLexer.readToken(), 10);
      if (!Number.isFinite(objNum) || !Number.isFinite(offset)) break;
      pairs.push([objNum, offset]);
    }
    for (const [objNum, offset] of pairs) {
      if (objects.has(objNum)) continue; // a direct definition wins
      try {
        objects.set(objNum, new PdfLexer(data, first + offset).parseValue());
      } catch {
        // A malformed member does not invalidate the rest of the stream.
      }
    }
  }
  // /Root may itself live in an object stream, so re-check after expansion.
  if (!trailer.has("Root")) {
    for (const [num, value] of [...objects].sort((a, b) => a[0] - b[0])) {
      if (isDict(value) && isName(value.get("Type") ?? null, "Catalog")) {
        trailer.set("Root", { kind: "ref", num, gen: 0 });
        break;
      }
    }
  }
  return new PdfDocument(bytes, objects, trailer, version, limits);
}

function lexerResolveType(stream: PdfStream): PdfValue {
  return stream.dict.get("Type") ?? null;
}
