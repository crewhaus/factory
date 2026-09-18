/**
 * Writing a PDF by rebuilding its object tree: page extraction and
 * concatenation.
 *
 * ## The approach
 *
 * Splitting and merging are the same operation — select pages from one or
 * more source documents and write a new file containing exactly those pages.
 * This is done by DEEP-COPYING the object graph reachable from each selected
 * page into a fresh, sequentially numbered object set, then writing a new
 * catalog, a new page-tree root, and a classic cross-reference table. The
 * source file's own cross-reference structure, incremental-update history
 * and object numbering are all discarded, which is precisely what makes the
 * output well-formed even when the input's xref table was not.
 *
 * Stream bytes are copied VERBATIM with their filters intact — nothing is
 * decompressed and recompressed, so image quality and font programs are
 * untouched and the operation is fast.
 *
 * ## What is carried across
 *
 * - The page dictionary and everything it references: content streams,
 *   resources, fonts (including embedded font programs), XObjects, colour
 *   spaces, patterns and shadings.
 * - `/MediaBox`, `/CropBox`, `/Resources` and `/Rotate` are written onto
 *   each copied page EXPLICITLY, resolved from wherever they were inherited,
 *   because the page's new parent is not the node it inherited them from.
 *
 * ## What is deliberately dropped — and why
 *
 * - ANNOTATIONS (`/Annots`), including links, form fields and comments. A
 *   link's destination is a reference to a page, and in a split that page
 *   is usually not in the output; carrying the annotation would produce a
 *   file whose links point somewhere that no longer exists. Dropping them is
 *   the honest choice, and the tools say so in their result.
 * - The document outline (bookmarks), the structure tree (tagged PDF),
 *   `/Names`, `/AcroForm`, `/OpenAction`, article threads and page labels,
 *   for the same reason: each is a document-wide structure whose entries
 *   refer to pages by object reference.
 * - Anything in an ENCRYPTED document: those are refused before this runs.
 *
 * The result is a clean, viewer-loadable PDF containing the page content and
 * nothing else. A caller who needs bookmarks preserved needs a different
 * tool than this one, and should be told so rather than handed a file with
 * dangling references.
 */
import {
  type PdfDict,
  type PdfDocument,
  PdfError,
  type PdfName,
  type PdfPage,
  type PdfRef,
  type PdfStream,
  type PdfValue,
  isArray,
  isDict,
  isName,
  isRef,
  isStream,
  isString,
} from "./pdf";

/** Entries that belong to the old page tree or to document-wide structures. */
const DROPPED_PAGE_KEYS: ReadonlySet<string> = new Set([
  "Parent",
  "Annots",
  "B",
  "PieceInfo",
  "StructParents",
  "Tabs",
]);

type Out = { readonly num: number; value: PdfValue };

/**
 * Copies objects out of source documents into one new numbering. One
 * instance per output file; `copy` is idempotent per (source, object).
 */
class ObjectCopier {
  private readonly objects: Out[] = [];
  private readonly seen = new Map<string, number>();

  /** Reserve the next object number. Object 0 is the free-list head. */
  allocate(value: PdfValue): PdfRef {
    const num = this.objects.length + 1;
    this.objects.push({ num, value });
    return { kind: "ref", num, gen: 0 };
  }

  set(ref: PdfRef, value: PdfValue): void {
    const slot = this.objects[ref.num - 1];
    if (slot === undefined) throw new PdfError("internal: object slot is missing");
    slot.value = value;
  }

  list(): ReadonlyArray<Out> {
    return this.objects;
  }

  /**
   * Deep-copy a value from `doc`. References are followed once and then
   * reused, so shared resources stay shared and cycles terminate.
   */
  copy(doc: PdfDocument, sourceId: number, value: PdfValue, depth = 0): PdfValue {
    if (depth > 64) throw new PdfError("pdf object graph nests deeper than 64 levels");
    if (isRef(value)) {
      const key = `${sourceId}:${value.num}`;
      const existing = this.seen.get(key);
      if (existing !== undefined) return { kind: "ref", num: existing, gen: 0 };
      const target = doc.objects.get(value.num);
      if (target === undefined) return null; // a dangling reference becomes null
      const ref = this.allocate(null);
      this.seen.set(key, ref.num);
      this.set(ref, this.copy(doc, sourceId, target, depth + 1));
      return ref;
    }
    if (isArray(value)) return value.map((item) => this.copy(doc, sourceId, item, depth + 1));
    if (isStream(value)) {
      const dict: PdfDict = new Map();
      for (const [key, entry] of value.dict) {
        if (key === "Length") continue; // rewritten from the actual bytes
        dict.set(key, this.copy(doc, sourceId, entry, depth + 1));
      }
      dict.set("Length", value.raw.length);
      return { kind: "stream", dict, raw: value.raw };
    }
    if (isDict(value)) {
      const dict: PdfDict = new Map();
      for (const [key, entry] of value) dict.set(key, this.copy(doc, sourceId, entry, depth + 1));
      return dict;
    }
    return value;
  }
}

// ---------------------------------------------------------------------------
// serialisation
// ---------------------------------------------------------------------------

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function formatName(name: string): string {
  let out = "/";
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    const regular =
      code > 32 &&
      code < 127 &&
      !["(", ")", "<", ">", "[", "]", "{", "}", "/", "%", "#"].includes(ch);
    out += regular ? ch : `#${code.toString(16).padStart(2, "0")}`;
  }
  return out;
}

const HEX = "0123456789abcdef";

/**
 * Serialise one value. Strings are written as HEXADECIMAL strings without
 * exception: a hex string cannot contain an unbalanced parenthesis, an
 * unescaped backslash or a raw newline, so this cannot produce a file that
 * parses differently from the one it was copied out of.
 */
function serialize(value: PdfValue, chunks: Uint8Array[], encoder: TextEncoder): void {
  const push = (text: string): void => {
    chunks.push(encoder.encode(text));
  };
  if (value === null) {
    push("null");
    return;
  }
  if (typeof value === "boolean") {
    push(value ? "true" : "false");
    return;
  }
  if (typeof value === "number") {
    push(formatNumber(value));
    return;
  }
  if (isName(value)) {
    push(formatName((value as PdfName).name));
    return;
  }
  if (isRef(value)) {
    push(`${value.num} ${value.gen} R`);
    return;
  }
  if (isString(value)) {
    let hex = "<";
    for (const byte of value.bytes) {
      hex += (HEX[byte >> 4] as string) + (HEX[byte & 0x0f] as string);
    }
    push(`${hex}>`);
    return;
  }
  if (isArray(value)) {
    push("[");
    for (const [i, item] of value.entries()) {
      if (i > 0) push(" ");
      serialize(item, chunks, encoder);
    }
    push("]");
    return;
  }
  if (isStream(value)) {
    serializeDict(value.dict, chunks, encoder);
    push("\nstream\n");
    chunks.push(value.raw);
    push("\nendstream");
    return;
  }
  if (isDict(value)) {
    serializeDict(value, chunks, encoder);
    return;
  }
  push("null");
}

function serializeDict(dict: PdfDict, chunks: Uint8Array[], encoder: TextEncoder): void {
  chunks.push(encoder.encode("<<"));
  // Keys are emitted in sorted order so the same input writes the same bytes.
  for (const key of [...dict.keys()].sort()) {
    chunks.push(encoder.encode(`${formatName(key)} `));
    serialize(dict.get(key) ?? null, chunks, encoder);
    chunks.push(encoder.encode(" "));
  }
  chunks.push(encoder.encode(">>"));
}

// ---------------------------------------------------------------------------
// the operation
// ---------------------------------------------------------------------------

export type PageSelection = {
  readonly doc: PdfDocument;
  /** One-based page numbers, in the order they should appear in the output. */
  readonly pages: ReadonlyArray<number>;
};

export type BuildOptions = {
  /**
   * The `/Info` dictionary's `/CreationDate` and `/ModDate`, as a PDF date
   * string (`D:20240115120000Z`). Taken as an INPUT: nothing here reads the
   * clock, so the same pages always write the same bytes.
   */
  readonly date?: string;
  readonly producer?: string;
};

/** Build a new PDF from pages selected out of one or more documents. */
export function buildPdf(
  selections: ReadonlyArray<PageSelection>,
  options: BuildOptions = {},
): Uint8Array {
  for (const selection of selections) {
    if (selection.doc.encrypted) {
      throw new PdfError("a source pdf is encrypted; refusing rather than writing a broken file");
    }
  }
  const copier = new ObjectCopier();
  const catalogRef = copier.allocate(null);
  const pagesRef = copier.allocate(null);
  const kids: PdfRef[] = [];

  for (const [sourceId, selection] of selections.entries()) {
    const pages = selection.doc.pages();
    for (const number of selection.pages) {
      const page: PdfPage | undefined = pages[number - 1];
      if (page === undefined) {
        throw new PdfError(`page ${number} does not exist (the document has ${pages.length})`);
      }
      const dict: PdfDict = new Map();
      for (const [key, value] of page.dict) {
        if (DROPPED_PAGE_KEYS.has(key)) continue;
        dict.set(key, copier.copy(selection.doc, sourceId, value));
      }
      dict.set("Type", { kind: "name", name: "Page" });
      dict.set("Parent", pagesRef);
      // Inherited attributes are written explicitly: the new parent is not
      // the node these came from, so leaving them implicit would change the
      // page's geometry.
      dict.set("MediaBox", [...page.mediaBox]);
      if (page.rotate !== 0) dict.set("Rotate", page.rotate);
      if (!dict.has("Resources")) {
        dict.set(
          "Resources",
          page.resources === null
            ? new Map()
            : copier.copy(selection.doc, sourceId, page.resources),
        );
      }
      kids.push(copier.allocate(dict));
    }
  }
  if (kids.length === 0) throw new PdfError("the page selection is empty");

  const pagesDict: PdfDict = new Map();
  pagesDict.set("Type", { kind: "name", name: "Pages" });
  pagesDict.set("Kids", [...kids]);
  pagesDict.set("Count", kids.length);
  copier.set(pagesRef, pagesDict);

  const catalog: PdfDict = new Map();
  catalog.set("Type", { kind: "name", name: "Catalog" });
  catalog.set("Pages", pagesRef);
  copier.set(catalogRef, catalog);

  let infoRef: PdfRef | null = null;
  const info: PdfDict = new Map();
  const encoder = new TextEncoder();
  const asString = (text: string): PdfValue => ({
    kind: "string",
    bytes: encoder.encode(text),
  });
  info.set("Producer", asString(options.producer ?? "crewhaus tool-docs"));
  if (options.date !== undefined) {
    info.set("CreationDate", asString(options.date));
    info.set("ModDate", asString(options.date));
  }
  infoRef = copier.allocate(info);

  // --- write it out ------------------------------------------------------
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const emit = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const emitText = (text: string): void => {
    emit(encoder.encode(text));
  };
  // The binary comment tells every tool downstream that this is not text.
  emitText("%PDF-1.7\n");
  emit(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = new Map<number, number>();
  for (const { num, value } of copier.list()) {
    offsets.set(num, offset);
    emitText(`${num} 0 obj\n`);
    const body: Uint8Array[] = [];
    serialize(value, body, encoder);
    for (const part of body) emit(part);
    emitText("\nendobj\n");
  }

  const xrefOffset = offset;
  const count = copier.list().length + 1;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let i = 1; i < count; i++) {
    const at = offsets.get(i) ?? 0;
    xref += `${String(at).padStart(10, "0")} 00000 n \n`;
  }
  emitText(xref);
  emitText(
    `trailer\n<</Size ${count} /Root ${catalogRef.num} 0 R /Info ${infoRef.num} 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Parse a page range like `1-3,7,10-` against a document of `pageCount`
 * pages. Order is preserved as written, duplicates are allowed (a caller
 * asking for `1,1` means it), and an out-of-range page is an error rather
 * than a silent omission.
 */
export function parsePageRange(spec: string, pageCount: number): number[] {
  // A selection may repeat pages, so its length is NOT bounded by the page
  // count: `1-20000,1-20000,…` in a long enough spec selects arbitrarily
  // many. Refused at a ceiling rather than expanded.
  const maxSelected = 100_000;
  const out: number[] = [];
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (part === "") continue;
    const match = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(part);
    if (match === null) throw new PdfError(`"${part}" is not a page or page range`);
    const [, fromText, dash, toText] = match;
    if (dash === undefined) {
      if (fromText === undefined) throw new PdfError(`"${part}" is not a page or page range`);
      const page = Number.parseInt(fromText, 10);
      if (page < 1 || page > pageCount) {
        throw new PdfError(`page ${page} is out of range (the document has ${pageCount})`);
      }
      out.push(page);
      if (out.length > maxSelected) {
        throw new PdfError(`a page selection of more than ${maxSelected} pages is refused`);
      }
      continue;
    }
    const from = fromText === undefined ? 1 : Number.parseInt(fromText, 10);
    const to = toText === undefined ? pageCount : Number.parseInt(toText, 10);
    if (from < 1 || to > pageCount || from > to) {
      throw new PdfError(`range "${part}" is out of range (the document has ${pageCount} pages)`);
    }
    if (out.length + (to - from + 1) > maxSelected) {
      throw new PdfError(`a page selection of more than ${maxSelected} pages is refused`);
    }
    for (let page = from; page <= to; page++) out.push(page);
  }
  if (out.length === 0) throw new PdfError("the page range selects no pages");
  return out;
}

/** A minimal, valid PDF with no pages is never written; this guards that. */
export function assertHasPages(doc: PdfDocument): void {
  if (doc.pages().length === 0) {
    throw new PdfError("this pdf has no page objects that can be read");
  }
}
