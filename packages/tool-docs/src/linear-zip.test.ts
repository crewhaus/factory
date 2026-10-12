/**
 * The zip reader inflates each compressed span once, and no more of them
 * than the archive holds, counted, never timed.
 *
 * A .pptx names its slides by relationship, and nothing stops a deck from
 * naming one slide part from every `p:sldId`, or a workbook one sheet part
 * from every `sheet`; any number of central-directory entries may also point
 * at one member's data. Each name was a fresh inflate of the whole
 * compressed span, and a span padded with empty stored blocks costs its
 * length to inflate while writing almost nothing, so the output limit never
 * stopped it: 400 references to a 10 KB slide in a 23 KB deck handed the
 * inflater 4 MB, and twice the references twice that. Now a span is
 * inflated once and kept, and the distinct spans inflated may come to no
 * more than the archive's own size, which members with their own data never
 * exceed. Every read still counts its output against the total limit.
 *
 * The reader 0.7.0 shipped is kept below as the reference.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { pptxRead } from "./index";
import { readPptx } from "./lib/pptx";
import { readXlsx } from "./lib/xlsx";
import {
  DEFAULT_ZIP_LIMITS,
  ZipArchive,
  ZipError,
  type ZipLimits,
  _setInflateRawForTest,
} from "./lib/zip";

// ---------------------------------------------------------------------------
// the reference
// ---------------------------------------------------------------------------

/** `ZipArchive.read` as 0.7.0 shipped it, over the same index: every read inflates. */
function referenceRead(
  data: Uint8Array,
  zip: ZipArchive,
  limits: ZipLimits,
  state: { spent: number },
  name: string,
): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const entry = zip.find(name);
  if (entry === undefined) throw new ZipError(`zip has no entry named "${name}"`);
  if (entry.encrypted) {
    throw new ZipError(`zip entry "${name}" is encrypted; this reader cannot decrypt it`);
  }
  if (entry.isDirectory) return new Uint8Array(0);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(
      `zip entry "${name}" uses compression method ${entry.method}; only stored (0) and deflate (8) are supported`,
    );
  }
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new ZipError(
      `zip entry "${name}" declares ${entry.uncompressedSize} bytes, over the ${limits.maxEntryBytes} per-entry limit`,
    );
  }
  const header = entry.localHeaderOffset;
  if (header + 30 > data.length || view.getUint32(header, true) !== 0x04034b50) {
    throw new ZipError(`zip entry "${name}" has no local file header where the index says`);
  }
  const dataStart =
    header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > data.length) {
    throw new ZipError(`zip entry "${name}" runs past the end of the file`);
  }
  const raw = data.subarray(dataStart, dataEnd);
  let out: Uint8Array;
  if (entry.method === 0) {
    out = raw;
  } else {
    try {
      out = inflateRawSync(raw, { maxOutputLength: limits.maxEntryBytes + 1 });
    } catch (err) {
      throw new ZipError(`zip entry "${name}" failed to decompress: ${(err as Error).message}`);
    }
  }
  if (out.length > limits.maxEntryBytes) {
    throw new ZipError(
      `zip entry "${name}" decompressed past the ${limits.maxEntryBytes} per-entry limit`,
    );
  }
  state.spent += out.length;
  if (state.spent > limits.maxTotalBytes) {
    throw new ZipError(
      `reading "${name}" would push this archive past the ${limits.maxTotalBytes} total decompressed limit`,
    );
  }
  return out;
}

/** xorshift32: the same cases on every run and every machine. */
function generator(seed: number): () => number {
  const state = { x: seed >>> 0 || 1 };
  return () => {
    state.x ^= state.x << 13;
    state.x >>>= 0;
    state.x ^= state.x >>> 17;
    state.x ^= state.x << 5;
    state.x >>>= 0;
    return state.x / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// building zips
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();
const bytesOf = (text: string): Uint8Array => ENCODER.encode(text);

type Part = {
  readonly name: string;
  /** 0 stored, 8 deflated, anything else unsupported. */
  readonly method: number;
  readonly data: Uint8Array;
  /** Index of an earlier part whose local header and data this entry points at. */
  readonly sharesWith?: number;
  /** The compressed size this entry states, when not its data's length. */
  readonly statedSize?: number;
  /** The uncompressed size this entry states. */
  readonly size?: number;
  readonly encrypted?: boolean;
};

/**
 * A zip whose central-directory entries say what `parts` says, which a zip
 * writer never would: entries that share another's data, or state a size
 * that is not their data's.
 */
function zipOf(parts: ReadonlyArray<Part>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let at = 0;
  for (const part of parts) {
    if (part.sharesWith !== undefined) {
      offsets.push(offsets[part.sharesWith] as number);
      continue;
    }
    const name = bytesOf(part.name);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, part.method, true);
    view.setUint32(18, part.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    offsets.push(at);
    chunks.push(local, part.data);
    at += local.length + part.data.length;
  }
  const central = parts.map((part, i) => {
    const source = part.sharesWith === undefined ? part : (parts[part.sharesWith] as Part);
    return centralEntry({
      name: part.name,
      method: source.method,
      compressedSize: part.statedSize ?? source.data.length,
      size: part.size ?? 1 << 16,
      offset: offsets[i] as number,
      encrypted: part.encrypted === true,
    });
  });
  return withDirectory(chunks, at, central);
}

/** One central-directory entry. */
function centralEntry(entry: {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  encrypted?: boolean;
}): Uint8Array {
  const name = bytesOf(entry.name);
  const out = new Uint8Array(46 + name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, entry.encrypted === true ? 1 : 0, true);
  view.setUint16(10, entry.method, true);
  view.setUint32(20, entry.compressedSize, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, entry.offset, true);
  out.set(name, 46);
  return out;
}

/** The local parts, then `central`, then the end record that points at it. */
function withDirectory(
  chunks: ReadonlyArray<Uint8Array>,
  at: number,
  central: ReadonlyArray<Uint8Array>,
): Uint8Array {
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, central.length, true);
  view.setUint16(10, central.length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, at, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of all) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** A deflate stream that writes `text` after `blocks` empty stored blocks, which read input and write nothing. */
function padded(text: string, blocks: number): Uint8Array {
  const stream = deflateRawSync(bytesOf(text));
  const out = new Uint8Array(blocks * 5 + stream.length);
  for (let i = 0; i < blocks; i++) out.set([0x00, 0x00, 0x00, 0xff, 0xff], i * 5);
  out.set(stream, blocks * 5);
  return out;
}

const DOCUMENT =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const SLIDE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide";
const SHEET = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const SLIDE_XML = `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>hi</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const relationships = (rows: ReadonlyArray<readonly [string, string, string]>): string =>
  `<Relationships>${rows.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join("")}</Relationships>`;
const presentation = (ids: ReadonlyArray<string>): string =>
  `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${ids.map((id, i) => `<p:sldId id="${256 + i}" r:id="${id}"/>`).join("")}</p:sldIdLst></p:presentation>`;

/** A deck whose `n` slide ids all name one slide part, padded with `blocks` empty blocks. */
function deckOfOneSlide(n: number, blocks: number): Uint8Array {
  return zipOf([
    {
      name: "_rels/.rels",
      method: 0,
      data: bytesOf(relationships([["r0", DOCUMENT, "ppt/presentation.xml"]])),
    },
    {
      name: "ppt/presentation.xml",
      method: 0,
      data: bytesOf(presentation(Array.from({ length: n }, () => "rId1"))),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      method: 0,
      data: bytesOf(relationships([["rId1", SLIDE, "slides/slide1.xml"]])),
    },
    { name: "ppt/slides/slide1.xml", method: 8, data: padded(SLIDE_XML, blocks) },
  ]);
}

/**
 * A deck of `n` slides, each its own part with its own local header, whose
 * data all lies in one padded stream: slide i starts i empty blocks into it,
 * so each is a different, valid stream over almost all of it. Each local
 * header's extra field reaches over the headers after it to where its data
 * starts.
 */
function deckOfOverlappingSlides(n: number, blocks: number): Uint8Array {
  const stream = padded(SLIDE_XML, blocks);
  const slide = (i: number): string => `slides/s${String(i).padStart(4, "0")}.xml`;
  const headerLength = 30 + bytesOf(`ppt/${slide(0)}`).length;
  const region = n * headerLength;
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const name = bytesOf(`ppt/${slide(i)}`);
    const local = new Uint8Array(headerLength);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 8, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, region + 5 * i - (i + 1) * headerLength, true);
    local.set(name, 30);
    chunks.push(local);
    central.push(
      centralEntry({
        name: `ppt/${slide(i)}`,
        method: 8,
        compressedSize: stream.length - 5 * i,
        size: 1 << 16,
        offset: i * headerLength,
      }),
    );
  }
  chunks.push(stream);
  let at = region + stream.length;
  const ids = Array.from({ length: n }, (_, i) => `rId${i}`);
  const stored: ReadonlyArray<readonly [string, string]> = [
    ["_rels/.rels", relationships([["r0", DOCUMENT, "ppt/presentation.xml"]])],
    ["ppt/presentation.xml", presentation(ids)],
    [
      "ppt/_rels/presentation.xml.rels",
      relationships(ids.map((id, i) => [id, SLIDE, slide(i)] as const)),
    ],
  ];
  for (const [storedName, text] of stored) {
    const name = bytesOf(storedName);
    const data = bytesOf(text);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    chunks.push(local, data);
    central.push(
      centralEntry({
        name: storedName,
        method: 0,
        compressedSize: data.length,
        size: data.length,
        offset: at,
      }),
    );
    at += local.length + data.length;
  }
  return withDirectory(chunks, at, central);
}

type Counted<T> = { readonly outcome: T | Error; readonly calls: number; readonly handed: number };

/** Stand in a counting inflater: how often it is called and the bytes it is handed. */
function countInflates(): { readonly calls: number; readonly handed: number } {
  const counter = { calls: 0, handed: 0 };
  _setInflateRawForTest(((data: Uint8Array, options?: { maxOutputLength?: number }) => {
    counter.calls += 1;
    counter.handed += data.length;
    return inflateRawSync(data, options);
  }) as typeof inflateRawSync);
  return counter;
}

/** Run `body` with the reader's inflater counted. Nothing is timed. */
function inflateWork<T>(body: () => T): Counted<T> {
  const counter = countInflates();
  try {
    return { outcome: body(), ...counter };
  } catch (err) {
    return { outcome: err as Error, ...counter };
  } finally {
    _setInflateRawForTest(undefined);
  }
}

/** {@link inflateWork} for a tool's `execute`. */
async function inflateWorkAsync<T>(body: () => Promise<T>): Promise<Counted<T>> {
  const counter = countInflates();
  try {
    return { outcome: await body(), ...counter };
  } catch (err) {
    return { outcome: err as Error, ...counter };
  } finally {
    _setInflateRawForTest(undefined);
  }
}

const OVERLAP = "overlaps the data of other entries";

// ---------------------------------------------------------------------------
// old against new
// ---------------------------------------------------------------------------

describe("each read gives what the 0.7.0 reader gave", () => {
  test("generated archives and reads: repeats, shared data, broken streams, every refusal", () => {
    const random = generator(83);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const text = (n: number): string => {
      let out = "";
      for (let i = 0; i < n; i++) out += pick(["a", "b", "<", ">", "é", " ", "\n"]);
      return out;
    };
    const KINDS = [
      "failed to decompress",
      "per-entry",
      "total",
      "no entry",
      "encrypted",
      "method",
    ] as const;
    const outcomes = new Map<string, number>();
    const note = (what: string): void => {
      const kind = what.startsWith("ok") ? "ok" : (KINDS.find((k) => what.includes(k)) ?? what);
      outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
    };
    const outcome = (read: () => Uint8Array): string => {
      try {
        return `ok ${Buffer.from(read()).toString("hex")}`;
      } catch (err) {
        if (!(err instanceof ZipError)) throw err;
        return `refused ${err.message}`;
      }
    };
    let reads = 0;
    let repeats = 0;
    let mismatches = 0;
    for (let archive = 0; archive < 1_500; archive++) {
      const parts: Part[] = [];
      for (let i = 0, n = 1 + Math.floor(random() * 6); i < n; i++) {
        const name = pick(["a.xml", "b.xml", "c/d.xml", "e/", `p${i}.xml`, `p${i}.xml`]);
        const own = parts.filter((p) => p.sharesWith === undefined);
        if (own.length > 0 && random() < 0.25) {
          const source = pick(own);
          parts.push({ ...source, name, sharesWith: parts.indexOf(source) });
          continue;
        }
        const body = bytesOf(text(Math.floor(random() * 300)));
        const roll = random();
        let data: Uint8Array = deflateRawSync(body, { level: Math.floor(random() * 10) });
        let method = 8;
        if (roll < 0.2) {
          data = body;
          method = 0;
        } else if (roll < 0.3) {
          data = data.subarray(0, Math.floor(random() * data.length));
        } else if (roll < 0.4 && data.length > 0) {
          data = Uint8Array.from(data);
          const k = Math.floor(random() * data.length);
          data[k] = (data[k] as number) ^ (1 << Math.floor(random() * 8));
        } else if (roll < 0.5) {
          data = padded(text(20), Math.floor(random() * 40));
        } else if (roll < 0.53) {
          method = 12;
        }
        parts.push({
          name,
          method,
          data,
          size: random() < 0.1 ? 1 << 20 : body.length,
          encrypted: random() < 0.03,
        });
      }
      const bytes = zipOf(parts);
      const limits: ZipLimits = {
        ...DEFAULT_ZIP_LIMITS,
        maxEntryBytes: pick([100, 300, 1 << 18]),
        maxTotalBytes: pick([200, 1_000, 1 << 18]),
      };
      const zip = ZipArchive.open(bytes, limits);
      const index = ZipArchive.open(bytes, limits);
      const state = { spent: 0 };
      const names = [...new Set(parts.map((p) => p.name)), "missing.xml"];
      const seen = new Set<string>();
      for (let r = 0, n = 1 + Math.floor(random() * 12); r < n; r++) {
        const name = pick(names);
        if (seen.has(name)) repeats += 1;
        seen.add(name);
        const expected = outcome(() => referenceRead(bytes, index, limits, state, name));
        const got = outcome(() => zip.read(name));
        reads += 1;
        if (got !== expected) mismatches += 1;
        note(expected);
      }
    }
    expect(mismatches).toBe(0);
    expect(reads).toBeGreaterThan(8_000);
    expect(repeats).toBeGreaterThan(3_000);
    // Every outcome is reached, and none is the new refusal: these archives
    // share data only whole, as a zip writer that deduplicates might.
    for (const kind of ["ok", ...KINDS]) expect(outcomes.get(kind) ?? 0).toBeGreaterThan(20);
    expect([...outcomes.keys()].filter((kind) => kind.includes(OVERLAP))).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// the input read
// ---------------------------------------------------------------------------

describe("a compressed span is inflated once, and no more of them than the archive holds", () => {
  test("a deck whose slide ids all name one padded slide: it is inflated once", () => {
    // Each slide id was a fresh inflate of the whole padded span.
    const counted = [100, 400].map((n) => {
      const zip = ZipArchive.open(deckOfOneSlide(n, 2_000));
      const span = zip.find("ppt/slides/slide1.xml")?.compressedSize ?? 0;
      return { n, span, ...inflateWork(() => readPptx(zip, false)) };
    });
    for (const { n, span, outcome, calls, handed } of counted) {
      expect(span).toBeGreaterThan(10_000);
      expect(calls).toBe(1);
      expect(handed).toBe(span);
      const slides = outcome as ReturnType<typeof readPptx>;
      expect(slides.length).toBe(n);
      expect(slides.every((slide) => slide.shapes[0]?.text === "hi")).toBe(true);
    }
  });

  test("a workbook whose sheets all name one padded sheet: it is inflated once", () => {
    const n = 200;
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hi</t></is></c></row></sheetData></worksheet>`;
    const sheets = Array.from({ length: n }, (_, i) => `<sheet name="S${i}" r:id="rId1"/>`);
    const zip = ZipArchive.open(
      zipOf([
        {
          name: "_rels/.rels",
          method: 0,
          data: bytesOf(relationships([["r0", DOCUMENT, "xl/workbook.xml"]])),
        },
        {
          name: "xl/workbook.xml",
          method: 0,
          data: bytesOf(`<workbook xmlns:r="r"><sheets>${sheets.join("")}</sheets></workbook>`),
        },
        {
          name: "xl/_rels/workbook.xml.rels",
          method: 0,
          data: bytesOf(relationships([["rId1", SHEET, "worksheets/sheet1.xml"]])),
        },
        { name: "xl/worksheets/sheet1.xml", method: 8, data: padded(sheet, 2_000) },
      ]),
    );
    const { outcome, calls, handed } = inflateWork(() =>
      readXlsx(zip, { maxRowsPerSheet: 10, maxColumns: 10 }),
    );
    expect(calls).toBe(1);
    expect(handed).toBe(zip.find("xl/worksheets/sheet1.xml")?.compressedSize ?? 0);
    const workbook = outcome as ReturnType<typeof readXlsx>;
    expect(workbook.sheets.length).toBe(n);
    expect(workbook.sheets.every((s) => s.rows[0]?.[0] === "hi")).toBe(true);
  });

  test("many names whose entries point at one member's data: it is inflated once", () => {
    const data = padded(SLIDE_XML, 2_000);
    const parts: Part[] = [{ name: "s0.xml", method: 8, data }];
    for (let i = 1; i < 300; i++) parts.push({ name: `s${i}.xml`, method: 8, data, sharesWith: 0 });
    const zip = ZipArchive.open(zipOf(parts));
    const { outcome, calls, handed } = inflateWork(() =>
      parts.map((part) => zip.readText(part.name)),
    );
    expect(calls).toBe(1);
    expect(handed).toBe(data.length);
    expect(outcome).toEqual(parts.map(() => SLIDE_XML));
  });

  test("slides whose data overlaps in one padded stream: the reading stops at the archive's size", () => {
    // Each slide is a different stream, so keeping what was inflated does
    // not help: n slides would hand the inflater n times the stream.
    const counted = [100, 200].map((n) => {
      const bytes = deckOfOverlappingSlides(n, 2_000);
      const zip = ZipArchive.open(bytes);
      return { bytes, ...inflateWork(() => readPptx(zip, false)) };
    });
    for (const { bytes, outcome, calls, handed } of counted) {
      expect(handed).toBeLessThanOrEqual(bytes.length);
      expect(calls).toBeGreaterThan(1);
      expect(outcome).toBeInstanceOf(ZipError);
      expect((outcome as Error).message).toContain(OVERLAP);
    }
  });

  test("a span is inflated when the distinct spans come to exactly the archive's size, and not one byte past", () => {
    // Entries that share one member's data at different stated lengths:
    // each is a span of its own. The stated sizes are fixed-width fields, so
    // the zip's length does not depend on them: build it once to learn it,
    // then state sizes that bring one span to exactly it and the next to one
    // byte past. A prefix of a stream does not inflate, but is read to learn
    // that, and counts.
    const data = padded(SLIDE_XML, 400);
    const n = 8;
    const build = (sizes: ReadonlyArray<number>): Uint8Array =>
      zipOf(
        sizes.map((size, i) => ({
          name: `s${i}`,
          method: 8,
          data,
          ...(i === 0 ? {} : { sharesWith: 0, statedSize: size }),
        })),
      );
    const length = build(Array.from({ length: n }, () => 0)).length;
    const exact = length - data.length;
    // The whole stream, the span that lands on the archive's size, one byte
    // past it, the empty span (nothing past), and the whole stream and the
    // span on the line again.
    const sizes = [data.length, exact, 1, 0, data.length, exact];
    while (sizes.length < n) sizes.push(sizes.length);
    const bytes = build(sizes);
    expect(bytes.length).toBe(length);
    expect(exact).toBeGreaterThan(1);
    expect(exact).toBeLessThan(data.length);
    const zip = ZipArchive.open(bytes);
    const steps = sizes.map((_, i) => {
      const { outcome, calls, handed } = inflateWork(() => zip.readText(`s${i}`));
      const said = outcome instanceof Error ? outcome.message : "read";
      const kind = said.includes(OVERLAP)
        ? "overlap"
        : said.includes("failed to decompress")
          ? "broken"
          : said;
      return `${calls}/${handed} ${kind}`;
    });
    expect(steps).toEqual([
      `1/${data.length} read`,
      // spent + size === the archive's size: handed to the inflater.
      `1/${exact} broken`,
      // spent + size === the archive's size + 1: refused unread.
      "0/0 overlap",
      "1/0 broken",
      // Inflated before, so kept, past the line or not, and so is a failure.
      "0/0 read",
      "0/0 broken",
      ...sizes.slice(6).map(() => "0/0 overlap"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// through the tool
// ---------------------------------------------------------------------------

describe("PptxRead on decks whose slides share data", () => {
  const originalCwd = process.cwd();
  const dir = { path: "" };
  beforeAll(() => {
    dir.path = mkdtempSync(path.join(tmpdir(), "crewhaus-docs-zip-"));
    process.chdir(dir.path);
  });
  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(dir.path, { recursive: true, force: true });
  });

  test("one slide named a thousand times is inflated once", async () => {
    writeFileSync(path.join(dir.path, "one.pptx"), deckOfOneSlide(1_000, 2_000));
    const read = await inflateWorkAsync(() => pptxRead.execute({ path: "one.pptx" }));
    expect(read.calls).toBe(1);
    const out = JSON.parse(String(read.outcome));
    expect(out.slideCount).toBe(1_000);
    expect(out.slides[499].shapes[0].text).toBe("hi");
  });

  test("slides whose data overlaps are refused, and the call says why", async () => {
    writeFileSync(path.join(dir.path, "overlap.pptx"), deckOfOverlappingSlides(100, 2_000));
    const refused = await inflateWorkAsync(() => pptxRead.execute({ path: "overlap.pptx" }));
    expect(String(refused.outcome)).toContain(OVERLAP);
  });
});
