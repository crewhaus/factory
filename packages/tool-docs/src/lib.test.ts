/**
 * Unit tests for the readers and writers in `./lib`.
 *
 * Every binary fixture is CONSTRUCTED here or in `./fixtures`, never
 * committed, so each test states the bytes it is asserting about. Where a
 * format has a rule that is easy to get subtly wrong — Excel's phantom leap
 * day, iCalendar's unfolding, a zip's lying central directory — there is a
 * test for the rule itself rather than only for the happy path.
 */
import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { sampleDocx, samplePdf, samplePptx, sampleXlsx, textPageContent } from "./fixtures";
import { diffLines, diffStats, normalizeLine, renderUnified, wordCounts } from "./lib/diff";
import { docxPlainText, readDocx, writeDocx } from "./lib/docx";
import {
  escapeText,
  foldLine,
  parseComponents,
  parseContentLine,
  readEvents,
  readVcards,
  toCalendarValue,
  unescapeText,
  unfold,
  writeCalendar,
} from "./lib/ical";
import {
  decodeEncodedWords,
  decodeQuotedPrintable,
  parseAddressList,
  parseHeaderBlock,
  parseMailDate,
  parseMessage,
  parseParameterHeader,
  splitMbox,
  stripHtml,
} from "./lib/mail";
import { assertSafePartNames, relsPathFor, resolvePartPath } from "./lib/ooxml";
import { parsePdf } from "./lib/pdf";
import { extractPageText, parseToUnicodeCMap } from "./lib/pdf-text";
import { buildPdf, parsePageRange } from "./lib/pdf-write";
import { readPptx } from "./lib/pptx";
import {
  columnIndex,
  columnName,
  isDateFormatCode,
  isoToSerial,
  readXlsx,
  serialToIso,
  writeXlsx,
} from "./lib/xlsx";
import { descendants, escapeXml, parseXml, rootElement, textOf } from "./lib/xml";
import { ZipArchive, crc32, writeZip } from "./lib/zip";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const open = (bytes: Uint8Array): ZipArchive => ZipArchive.open(bytes);

/** Rewrite every central-directory record in place, for the zip tests. */
function patchCentralDirectory(
  bytes: Uint8Array,
  edit: (view: DataView, at: number) => void,
): Uint8Array {
  const patched = Uint8Array.from(bytes);
  const view = new DataView(patched.buffer);
  for (let i = 0; i + 3 < patched.length; i++) {
    if (
      patched[i] === 0x50 &&
      patched[i + 1] === 0x4b &&
      patched[i + 2] === 0x01 &&
      patched[i + 3] === 0x02
    ) {
      edit(view, i);
    }
  }
  return patched;
}

describe("zip", () => {
  test("a written archive reads back, deflated and stored alike", () => {
    const bytes = writeZip([
      { name: "a.txt", data: utf8("hello hello hello hello") },
      { name: "b.bin", data: Uint8Array.from([1, 2, 3]), store: true },
    ]);
    const zip = open(bytes);
    expect(zip.sortedNames()).toEqual(["a.txt", "b.bin"]);
    expect(new TextDecoder().decode(zip.read("a.txt"))).toBe("hello hello hello hello");
    expect([...zip.read("b.bin")]).toEqual([1, 2, 3]);
  });

  test("writing is deterministic: the same parts produce the same bytes", () => {
    const parts = [{ name: "x", data: utf8("same") }];
    expect([...writeZip(parts)]).toEqual([...writeZip(parts)]);
  });

  test("crc32 matches the format's own check vector", () => {
    expect(crc32(utf8("123456789")).toString(16)).toBe("cbf43926");
  });

  test("a file that is not a zip is refused by name", () => {
    expect(() => open(utf8("not a zip at all, just some text padding............"))).toThrow(
      /not a zip archive/,
    );
  });

  test("an entry with an unsupported compression method is refused, not guessed at", () => {
    const bytes = writeZip([{ name: "a", data: utf8("x") }]);
    const patched = patchCentralDirectory(bytes, (view, at) => view.setUint16(at + 10, 12, true));
    expect(() => open(patched).read("a")).toThrow(/compression method 12/);
  });

  test("an encrypted entry is refused rather than returned empty", () => {
    const bytes = writeZip([{ name: "a", data: utf8("secret") }]);
    const patched = patchCentralDirectory(bytes, (view, at) => view.setUint16(at + 8, 1, true));
    expect(() => open(patched).read("a")).toThrow(/encrypted/);
  });

  test("a zip bomb is refused at the declared size, before anything is inflated", () => {
    // 4 MB of zeros compresses to a few kilobytes; the cap here is 64 KB.
    const bomb = writeZip([{ name: "big", data: new Uint8Array(4 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(64 * 1024);
    const zip = ZipArchive.open(bomb, {
      maxArchiveBytes: 1024 * 1024,
      maxEntryBytes: 64 * 1024,
      maxTotalBytes: 64 * 1024,
      maxEntries: 16,
    });
    expect(() => zip.read("big")).toThrow(/over the 65536 per-entry limit/);
  });

  test("a central directory that understates a size cannot get past the inflate cap", () => {
    const bytes = writeZip([{ name: "lie", data: new Uint8Array(1024 * 1024) }]);
    // Claim the entry decompresses to ten bytes; it decompresses to a megabyte.
    const patched = patchCentralDirectory(bytes, (view, at) => view.setUint32(at + 24, 10, true));
    const zip = ZipArchive.open(patched, {
      maxArchiveBytes: 4 * 1024 * 1024,
      maxEntryBytes: 4096,
      maxTotalBytes: 4096,
      maxEntries: 16,
    });
    expect(() => zip.read("lie")).toThrow(/failed to decompress|past the/);
  });

  test("raw deflate is what a zip member holds, which is what the reader expects", () => {
    expect(deflateRawSync(Buffer.from("x"))[0]).not.toBe(0x78);
  });

  test("too many entries is refused before the directory is walked", () => {
    const bytes = writeZip([1, 2, 3].map((n) => ({ name: `f${n}`, data: utf8("x") })));
    expect(() =>
      ZipArchive.open(bytes, {
        maxArchiveBytes: 1024,
        maxEntryBytes: 1024,
        maxTotalBytes: 1024,
        maxEntries: 2,
      }),
    ).toThrow(/over the 2 limit/);
  });

  test("a missing entry names itself", () => {
    expect(() => open(writeZip([{ name: "a", data: utf8("x") }])).read("b")).toThrow(
      /no entry named "b"/,
    );
  });
});

describe("xml", () => {
  test("elements, attributes, CDATA and entities", () => {
    const root = rootElement(
      parseXml(`<r a="1" b='two &amp; more'><c/><d><![CDATA[<raw>]]></d><e>&#65;&#x42;</e></r>`),
    );
    expect(root.name).toBe("r");
    expect(root.attributes["b"]).toBe("two & more");
    expect(textOf(root)).toBe("<raw>AB");
    expect(descendants(root, "c").length).toBe(1);
  });

  test("a DOCTYPE with an internal subset is refused — this is the XXE surface", () => {
    expect(() => parseXml(`<!DOCTYPE r [<!ENTITY x "boom">]><r>&x;</r>`)).toThrow(
      /internal subset is refused/,
    );
  });

  test("an undefined entity is an error, not a silent empty string", () => {
    expect(() => parseXml("<r>&nope;</r>")).toThrow(/undefined entity/);
  });

  test("a mismatched closing tag is an error", () => {
    expect(() => parseXml("<a><b></a></b>")).toThrow(/does not match/);
  });

  test("an unclosed element is an error", () => {
    expect(() => parseXml("<a><b></b>")).toThrow(/never closed/);
  });

  test("nesting deeper than the limit is refused", () => {
    const deep = `${"<a>".repeat(40)}${"</a>".repeat(40)}`;
    expect(() => parseXml(deep, { maxChars: 1000, maxDepth: 10, maxNodes: 1000 })).toThrow(
      /nests deeper than 10/,
    );
  });

  test("a document larger than the character cap is refused before parsing", () => {
    expect(() => parseXml("<a/>", { maxChars: 2, maxDepth: 10, maxNodes: 10 })).toThrow(
      /over the 2 limit/,
    );
  });

  test("escaping covers the five entities and drops forbidden control characters", () => {
    expect(escapeXml(`a<b>&"'`)).toBe("a&lt;b&gt;&amp;&quot;&apos;");
    expect(escapeXml(`keep\ttab${String.fromCharCode(1)}drop`)).toBe("keep\ttabdrop");
  });

  test("a leading byte-order mark is not part of the first element's name", () => {
    expect(rootElement(parseXml(`${String.fromCharCode(0xfeff)}<a/>`)).name).toBe("a");
  });
});

describe("ooxml package plumbing", () => {
  test("a relationship target resolves against the part that declared it", () => {
    expect(resolvePartPath("ppt/presentation.xml", "slides/slide1.xml")).toBe(
      "ppt/slides/slide1.xml",
    );
    expect(resolvePartPath("ppt/slides/slide1.xml", "../notesSlides/n.xml")).toBe(
      "ppt/notesSlides/n.xml",
    );
    expect(resolvePartPath("ppt/presentation.xml", "/docProps/core.xml")).toBe("docProps/core.xml");
  });

  test("the .rels part for a part is beside it, in _rels", () => {
    expect(relsPathFor("word/document.xml")).toBe("word/_rels/document.xml.rels");
    expect(relsPathFor("")).toBe("_rels/.rels");
  });

  test("a package member whose name escapes its container is refused whole", () => {
    const bytes = writeZip([
      { name: "word/document.xml", data: utf8("<a/>") },
      { name: "../../etc/passwd", data: utf8("x") },
    ]);
    expect(() => assertSafePartNames(open(bytes))).toThrow(/would escape its container/);
  });
});

describe("docx", () => {
  const doc = readDocx(open(sampleDocx()));

  test("a styled heading reports its level and its display name", () => {
    expect(doc.blocks[0]).toMatchObject({
      kind: "paragraph",
      headingLevel: 1,
      styleName: "heading 1",
    });
  });

  test("xml:space=preserve keeps the space that joins two runs", () => {
    expect(doc.blocks[1]).toMatchObject({ text: "Revenue was up." });
  });

  test("list membership resolves through numbering.xml to bullet or ordered", () => {
    expect(doc.blocks[2]).toMatchObject({ list: { format: "bullet", level: 0 } });
    expect(doc.blocks[3]).toMatchObject({ list: { format: "ordered" } });
  });

  test("a tab between runs survives and a tracked deletion does not", () => {
    expect(doc.blocks[4]).toMatchObject({ text: "Before\tafter" });
  });

  test("a table comes back as rows of cell text", () => {
    expect(doc.blocks[5]).toEqual({
      kind: "table",
      rows: [
        ["Region", "Total"],
        ["North", "120"],
      ],
    });
  });

  test("core properties are read and parts that were not folded in are named", () => {
    expect(doc.properties["title"]).toBe("Quarterly Report");
    expect(doc.unreadParts).toEqual(["footnotes"]);
  });

  test("plain text joins blocks by line and tables by tab", () => {
    expect(docxPlainText(doc).split("\n")[5]).toBe("Region\tTotal");
  });

  test("what DocxWrite produces, DocxRead reads back", () => {
    const bytes = writeDocx([
      { type: "heading", text: "Title", level: 2 },
      { type: "paragraph", text: "Body text" },
      { type: "list", items: ["one", "two"], ordered: true },
      {
        type: "table",
        rows: [
          ["h", "i"],
          ["a", "b"],
        ],
        header: true,
      },
    ]);
    const round = readDocx(open(bytes));
    expect(round.blocks[0]).toMatchObject({ headingLevel: 2, text: "Title" });
    expect(round.blocks[2]).toMatchObject({ text: "one", list: { format: "ordered" } });
    expect(round.blocks[4]).toEqual({
      kind: "table",
      rows: [
        ["h", "i"],
        ["a", "b"],
      ],
    });
  });

  test("writing is deterministic, because no timestamp comes from the clock", () => {
    const blocks = [{ type: "paragraph" as const, text: "same" }];
    expect([...writeDocx(blocks)]).toEqual([...writeDocx(blocks)]);
  });

  test("a newline in a paragraph becomes a real line break", () => {
    const round = readDocx(open(writeDocx([{ type: "paragraph", text: "one\ntwo" }])));
    expect(round.blocks[0]).toMatchObject({ text: "one\ntwo" });
  });

  test("a package that is not a .docx says so", () => {
    expect(() => readDocx(open(writeZip([{ name: "a.txt", data: utf8("x") }])))).toThrow(
      /no main document part/,
    );
  });
});

describe("xlsx date serials", () => {
  test("serial 1 is 1900-01-01, before the phantom day", () => {
    expect(serialToIso(1, false)).toBe("1900-01-01");
  });

  test("serial 60 is Excel's phantom 1900-02-29 and has no real date", () => {
    expect(serialToIso(60, false)).toBeNull();
  });

  test("serial 61 is 1900-03-01, after the off-by-one the bug introduces", () => {
    expect(serialToIso(61, false)).toBe("1900-03-01");
  });

  test("a modern serial converts exactly", () => {
    expect(serialToIso(45306, false)).toBe("2024-01-15");
  });

  test("a fractional serial keeps the time of day", () => {
    expect(serialToIso(45306.5, false)).toBe("2024-01-15T12:00:00Z");
  });

  test("the 1904 system has no phantom day and is offset by 1462 days", () => {
    expect(serialToIso(0, true)).toBe("1904-01-01");
    expect(serialToIso(43844, true)).toBe(serialToIso(43844 + 1462, false));
  });

  test("ISO to serial round-trips on both sides of the phantom day", () => {
    for (const iso of ["1900-01-01", "1900-03-01", "2024-01-15", "1999-12-31"]) {
      const serial = isoToSerial(iso);
      expect(serial).not.toBeNull();
      expect(serialToIso(serial as number, false)).toBe(iso);
    }
  });

  test("a date format is recognised, and a date token inside a literal is not", () => {
    expect(isDateFormatCode("yyyy-mm-dd")).toBe(true);
    expect(isDateFormatCode("[$-409]h:mm AM/PM")).toBe(true);
    expect(isDateFormatCode(`0.00" days"`)).toBe(false);
    expect(isDateFormatCode("#,##0")).toBe(false);
  });

  test("column letters and indexes round-trip past Z", () => {
    expect(columnIndex("A1")).toBe(0);
    expect(columnIndex("Z9")).toBe(25);
    expect(columnIndex("AA1")).toBe(26);
    expect(columnName(0)).toBe("A");
    expect(columnName(26)).toBe("AA");
    expect(columnName(701)).toBe("ZZ");
  });
});

describe("xlsx reading", () => {
  const workbook = readXlsx(open(sampleXlsx()), { maxRowsPerSheet: 100, maxColumns: 50 });
  const data = workbook.sheets[0];

  test("sheets come back in workbook order, by relationship", () => {
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(["Data", "Notes"]);
  });

  test("shared strings, inline strings and rich-text runs all resolve", () => {
    expect(data?.rows[0]?.[0]).toBe("Region");
    expect(data?.rows[0]?.[1]).toBe("Total");
    expect(data?.rows[3]?.[0]).toBe("Mixed format");
  });

  test("numbers stay numbers and booleans stay booleans", () => {
    expect(data?.rows[1]?.[1]).toBe(120.5);
    expect(data?.rows[1]?.[2]).toBe(true);
  });

  test("a date-formatted serial becomes an ISO date", () => {
    expect(data?.rows[1]?.[3]).toBe("2024-01-15");
  });

  test("an error cell reports its error text rather than null", () => {
    expect(data?.rows[3]?.[2]).toBe("#DIV/0!");
  });

  test("a formula is reported with its cached value, never evaluated", () => {
    expect(data?.formulas).toEqual([{ ref: "E2", formula: "=B2*2", cachedValue: 241 }]);
  });

  test("a skipped row is materialised so row indexes mean something", () => {
    expect(data?.rows.length).toBe(4);
    expect(data?.rows[2]?.every((cell) => cell === null)).toBe(true);
  });

  test("rows are padded to the widest row in the sheet", () => {
    const widths = new Set(data?.rows.map((row) => row.length));
    expect(widths.size).toBe(1);
  });

  test("selecting sheets by name reads only those", () => {
    const only = readXlsx(open(sampleXlsx()), {
      sheetNames: ["Notes"],
      maxRowsPerSheet: 10,
      maxColumns: 10,
    });
    expect(only.sheets.map((sheet) => sheet.name)).toEqual(["Notes"]);
  });

  test("the row limit truncates and says so", () => {
    const limited = readXlsx(open(sampleXlsx()), { maxRowsPerSheet: 1, maxColumns: 10 });
    expect(limited.sheets[0]?.truncated).toBe(true);
  });

  test("what XlsxWrite produces, XlsxRead reads back, types and all", () => {
    const bytes = writeXlsx([
      {
        name: "S",
        rows: [
          ["name", "count", "ok", "when"],
          ["a", 3, false, "2024-03-01"],
          [null, -1.5, true, "2024-03-02T06:30:00Z"],
        ],
        header: true,
        dateColumns: [3],
      },
    ]);
    const round = readXlsx(open(bytes), { maxRowsPerSheet: 10, maxColumns: 10 });
    expect(round.sheets[0]?.rows[1]).toEqual(["a", 3, false, "2024-03-01"]);
    expect(round.sheets[0]?.rows[2]).toEqual([null, -1.5, true, "2024-03-02T06:30:00Z"]);
  });

  test("writing is deterministic", () => {
    const sheets = [
      { name: "S", rows: [["x", 1]] as ReadonlyArray<ReadonlyArray<string | number>> },
    ];
    expect([...writeXlsx(sheets)]).toEqual([...writeXlsx(sheets)]);
  });

  test("a package that is not a workbook says so", () => {
    expect(() =>
      readXlsx(open(writeZip([{ name: "a.txt", data: utf8("x") }])), {
        maxRowsPerSheet: 1,
        maxColumns: 1,
      }),
    ).toThrow(/no workbook part/);
  });
});

describe("pptx", () => {
  const slides = readPptx(open(samplePptx()), true);

  test("slides are ordered by the presentation, not by part name", () => {
    expect(slides.map((slide) => slide.part)).toEqual([
      "ppt/slides/slide2.xml",
      "ppt/slides/slide1.xml",
    ]);
    expect(slides.map((slide) => slide.title)).toEqual(["First Slide", "Second Slide"]);
  });

  test("shapes carry their placeholder role", () => {
    expect(slides[0]?.shapes.map((shape) => shape.role)).toEqual(["title", "body"]);
  });

  test("a break inside a paragraph becomes a newline", () => {
    expect(slides[0]?.shapes[1]?.text).toBe("earlier content\nsecond line");
  });

  test("notes are included only when asked for", () => {
    expect(slides[0]?.notes).toBe("remember the demo");
    expect(readPptx(open(samplePptx()), false)[0]?.notes).toBeUndefined();
  });

  test("a package that is not a deck says so", () => {
    expect(() => readPptx(open(writeZip([{ name: "a.txt", data: utf8("x") }])), false)).toThrow(
      /no presentation part/,
    );
  });
});

describe("pdf reading", () => {
  test("a plain document reports its pages and its metadata", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: textPageContent(["Hello"]) }], title: "T" }),
    );
    expect(doc.pages().length).toBe(1);
    expect(doc.info()["Title"]).toBe("T");
    expect(doc.encrypted).toBe(false);
  });

  test("text comes back with line breaks reconstructed from the glyph positions", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: textPageContent(["First line", "Second line"]) }] }),
    );
    const page = doc.pages()[0];
    expect(page).toBeDefined();
    const result = extractPageText(doc, page as NonNullable<typeof page>);
    expect(result.text).toBe("First line\nSecond line");
    expect(result.hasTextLayer).toBe(true);
  });

  test("a FlateDecode content stream reads the same as an uncompressed one", () => {
    const content = textPageContent(["Compressed content"]);
    const plain = parsePdf(samplePdf({ pages: [{ content }] }));
    const zipped = parsePdf(samplePdf({ pages: [{ content }], compress: true }));
    const a = plain.pages()[0];
    const b = zipped.pages()[0];
    expect(extractPageText(plain, a as NonNullable<typeof a>).text).toBe(
      extractPageText(zipped, b as NonNullable<typeof b>).text,
    );
  });

  test("a stream whose /Length lies is repaired by finding endstream", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: textPageContent(["Bad length"]) }], lieAboutLength: true }),
    );
    const page = doc.pages()[0];
    expect(extractPageText(doc, page as NonNullable<typeof page>).text).toBe("Bad length");
  });

  test("an encrypted document is detected and text extraction refuses", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: textPageContent(["secret"]) }], encrypted: true }),
    );
    expect(doc.encrypted).toBe(true);
    const page = doc.pages()[0];
    expect(() => extractPageText(doc, page as NonNullable<typeof page>)).toThrow(/encrypted/);
  });

  test("a page that draws no glyphs reports no text layer, which is the honest answer", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: "0 0 1 rg 10 10 100 100 re f\n", withFont: false }] }),
    );
    const page = doc.pages()[0];
    const result = extractPageText(doc, page as NonNullable<typeof page>);
    expect(result.hasTextLayer).toBe(false);
    expect(result.text).toBe("");
  });

  test("a TJ array's kerning gap becomes a space", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: "BT /F1 12 Tf 72 700 Td [(one) -600 (two)] TJ ET\n" }] }),
    );
    const page = doc.pages()[0];
    expect(extractPageText(doc, page as NonNullable<typeof page>).text).toBe("one two");
  });

  test("a ToUnicode CMap overrides the font's encoding", () => {
    const cmap = [
      "/CIDInit /ProcSet findresource begin",
      "1 begincmap",
      "2 beginbfchar",
      "<0041> <0391>",
      "<0042> <0392>",
      "endbfchar",
      "endcmap",
    ].join("\n");
    const doc = parsePdf(
      samplePdf({ pages: [{ content: "BT /F1 12 Tf 72 700 Td (AB) Tj ET\n" }], toUnicode: cmap }),
    );
    const page = doc.pages()[0];
    // 0x391 and 0x392 are Greek capital alpha and beta.
    expect(extractPageText(doc, page as NonNullable<typeof page>).text).toBe(
      String.fromCodePoint(0x391, 0x392),
    );
  });

  test("page geometry and rotation are read, inheriting where the page is silent", () => {
    const doc = parsePdf(
      samplePdf({
        pages: [{ content: textPageContent(["x"]), mediaBox: [0, 0, 595, 842], rotate: 90 }],
      }),
    );
    expect(doc.pages()[0]?.mediaBox).toEqual([0, 0, 595, 842]);
    expect(doc.pages()[0]?.rotate).toBe(90);
  });

  test("a file with no PDF header is refused", () => {
    expect(() => parsePdf(utf8("just text"))).toThrow(/not a pdf/);
  });

  test("a bfrange maps a whole span of codes", () => {
    const map = parseToUnicodeCMap("beginbfrange\n<0041> <0043> <0061>\nendbfrange");
    expect(map.get(0x41)).toBe("a");
    expect(map.get(0x43)).toBe("c");
  });

  test("a bfrange with an explicit list maps each code in turn", () => {
    const map = parseToUnicodeCMap("beginbfrange\n<0030> <0031> [<0058> <0059>]\nendbfrange");
    expect(map.get(0x30)).toBe("X");
    expect(map.get(0x31)).toBe("Y");
  });
});

describe("pdf page ranges and rebuilding", () => {
  const threePages = samplePdf({
    pages: [1, 2, 3].map((n) => ({ content: textPageContent([`Page ${n}`]) })),
  });

  test("a range expands in the order written, and out-of-range is an error", () => {
    expect(parsePageRange("1-2,3", 3)).toEqual([1, 2, 3]);
    expect(parsePageRange("3,1", 3)).toEqual([3, 1]);
    expect(parsePageRange("2-", 3)).toEqual([2, 3]);
    expect(parsePageRange("-2", 3)).toEqual([1, 2]);
    expect(() => parsePageRange("4", 3)).toThrow(/out of range/);
    expect(() => parsePageRange("x", 3)).toThrow(/not a page or page range/);
  });

  test("a split contains exactly the selected pages, in the order asked for", () => {
    const doc = parsePdf(threePages);
    const out = parsePdf(buildPdf([{ doc, pages: [3, 1] }]));
    expect(out.pages().length).toBe(2);
    expect(out.pages().map((page) => extractPageText(out, page).text)).toEqual([
      "Page 3",
      "Page 1",
    ]);
  });

  test("a merge concatenates sources and keeps each page's own text", () => {
    const a = parsePdf(threePages);
    const b = parsePdf(samplePdf({ pages: [{ content: textPageContent(["Other document"]) }] }));
    const out = parsePdf(
      buildPdf([
        { doc: a, pages: [2] },
        { doc: b, pages: [1] },
      ]),
    );
    expect(out.pages().map((page) => extractPageText(out, page).text)).toEqual([
      "Page 2",
      "Other document",
    ]);
  });

  test("the rebuilt file carries page geometry across explicitly", () => {
    const doc = parsePdf(
      samplePdf({
        pages: [{ content: textPageContent(["x"]), mediaBox: [0, 0, 300, 400], rotate: 270 }],
      }),
    );
    const out = parsePdf(buildPdf([{ doc, pages: [1] }]));
    expect(out.pages()[0]?.mediaBox).toEqual([0, 0, 300, 400]);
    expect(out.pages()[0]?.rotate).toBe(270);
  });

  test("rebuilding is deterministic when the date is supplied", () => {
    const doc = parsePdf(threePages);
    const options = { date: "D:20240115120000Z" };
    expect([...buildPdf([{ doc, pages: [1] }], options)]).toEqual([
      ...buildPdf([{ doc, pages: [1] }], options),
    ]);
  });

  test("an encrypted source is refused rather than written out broken", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: textPageContent(["x"]) }], encrypted: true }),
    );
    expect(() => buildPdf([{ doc, pages: [1] }])).toThrow(/encrypted/);
  });

  test("a compressed source rebuilds without recompressing, and still reads", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: textPageContent(["Kept compressed"]) }], compress: true }),
    );
    const out = parsePdf(buildPdf([{ doc, pages: [1] }]));
    const page = out.pages()[0];
    expect(extractPageText(out, page as NonNullable<typeof page>).text).toBe("Kept compressed");
  });

  test("an empty selection is an error, not an empty file", () => {
    const doc = parsePdf(threePages);
    expect(() => buildPdf([{ doc, pages: [] }])).toThrow(/selection is empty/);
  });
});

describe("mail headers", () => {
  test("a folded header is unfolded into one value", () => {
    const headers = parseHeaderBlock("Subject: a very\r\n  long subject\r\nTo: x@y");
    expect(headers[0]).toEqual({ name: "Subject", value: "a very long subject" });
    expect(headers.length).toBe(2);
  });

  test("repeated headers keep their order", () => {
    const headers = parseHeaderBlock("Received: one\nReceived: two");
    expect(headers.map((h) => h.value)).toEqual(["one", "two"]);
  });

  test("an encoded-word is decoded in both the B and the Q form", () => {
    const notes = new Set<string>();
    expect(decodeEncodedWords("=?utf-8?B?SGVsbG8=?=", notes)).toBe("Hello");
    expect(decodeEncodedWords("=?utf-8?Q?Hello_World?=", notes)).toBe("Hello World");
  });

  test("whitespace between two adjacent encoded-words is dropped, as the RFC says", () => {
    const notes = new Set<string>();
    expect(decodeEncodedWords("=?utf-8?Q?one?= =?utf-8?Q?two?=", notes)).toBe("onetwo");
    expect(decodeEncodedWords("=?utf-8?Q?one?= plain", notes)).toBe("one plain");
  });

  test("an unknown charset falls back to Latin-1 and says so", () => {
    const notes = new Set<string>();
    decodeEncodedWords("=?x-made-up?B?QQ==?=", notes);
    expect([...notes].join(" ")).toMatch(/not supported here/);
  });

  test("quoted-printable decodes soft breaks and hex escapes", () => {
    const text = new TextDecoder().decode(decodeQuotedPrintable("caf=C3=A9 =\r\nwrapped"));
    expect(text).toBe("café wrapped");
  });

  test("an address list splits on commas outside quotes and angle brackets", () => {
    const notes = new Set<string>();
    const addresses = parseAddressList(`"Doe, Jane" <jane@x.test>, bob@y.test`, notes);
    expect(addresses).toEqual([
      { name: "Doe, Jane", address: "jane@x.test" },
      { address: "bob@y.test" },
    ]);
  });

  test("a group address list is flattened to its members", () => {
    const notes = new Set<string>();
    expect(parseAddressList("Team: a@x.test, b@x.test;", notes).map((a) => a.address)).toEqual([
      "a@x.test",
      "b@x.test",
    ]);
  });

  test("dates parse with numeric offsets, obsolete zones and two-digit years", () => {
    expect(parseMailDate("Mon, 15 Jan 2024 09:30:00 +0100")).toBe("2024-01-15T08:30:00.000Z");
    expect(parseMailDate("15 Jan 2024 09:30:00 EST")).toBe("2024-01-15T14:30:00.000Z");
    expect(parseMailDate("Tue, 1 Feb 99 00:00:00 GMT")).toBe("1999-02-01T00:00:00.000Z");
    expect(parseMailDate("not a date")).toBeUndefined();
  });

  test("a parameter header splits values and honours RFC 2231 continuations", () => {
    const simple = parseParameterHeader(`text/plain; charset="utf-8"; name=a.txt`);
    expect(simple.value).toBe("text/plain");
    expect(simple.params["charset"]).toBe("utf-8");
    const continued = parseParameterHeader(`attachment; filename*0="long-"; filename*1="name.txt"`);
    expect(continued.params["filename"]).toBe("long-name.txt");
    const extended = parseParameterHeader(`attachment; filename*=utf-8''caf%C3%A9.txt`);
    expect(extended.params["filename"]).toBe("café.txt");
  });
});

describe("mail messages", () => {
  const multipart = [
    "From: Jane <jane@x.test>",
    "To: bob@y.test, =?utf-8?Q?Ann=C3=A9?= <anne@y.test>",
    "Subject: =?utf-8?B?U3VtbWFyeSDinJM=?=",
    "Date: Mon, 15 Jan 2024 09:30:00 +0000",
    "Message-ID: <abc@x.test>",
    'Content-Type: multipart/mixed; boundary="SEP"',
    "",
    "preamble text",
    "--SEP",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "caf=C3=A9 body",
    "--SEP",
    "Content-Type: application/pdf; name=report.pdf",
    "Content-Disposition: attachment; filename=report.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "SGVsbG8gUERG",
    "--SEP--",
    "",
  ].join("\r\n");

  const options = { includeBodies: true, maxParts: 50, maxDepth: 6, maxBodyChars: 10_000 };
  const message = parseMessage(multipart, options);

  test("the subject's encoded-word is decoded", () => {
    expect(message.subject).toBe("Summary ✓");
  });

  test("the date becomes an ISO instant", () => {
    expect(message.date).toBe("2024-01-15T09:30:00.000Z");
  });

  test("addresses are parsed, including an encoded display name", () => {
    expect(message.to).toEqual([
      { address: "bob@y.test" },
      { name: "Anné", address: "anne@y.test" },
    ]);
  });

  test("a multipart body splits into its parts and the preamble is not one", () => {
    expect(message.parts.map((part) => part.contentType)).toEqual([
      "text/plain",
      "application/pdf",
    ]);
  });

  test("a quoted-printable text part is decoded with its charset", () => {
    expect(message.parts[0]?.text).toBe("café body");
  });

  test("an attachment reports metadata and its decoded size, but never its bytes", () => {
    expect(message.parts[1]).toMatchObject({
      filename: "report.pdf",
      isAttachment: true,
      // "SGVsbG8gUERG" is "Hello PDF": nine bytes once decoded.
      size: 9,
    });
    expect(message.parts[1]?.text).toBeUndefined();
  });

  test("plain text prefers the text/plain part", () => {
    expect(message.parts.find((part) => part.contentType === "text/plain")?.text).toBe("café body");
  });

  test("a nested multipart is walked", () => {
    const nested = [
      'Content-Type: multipart/mixed; boundary="OUT"',
      "",
      "--OUT",
      'Content-Type: multipart/alternative; boundary="IN"',
      "",
      "--IN",
      "Content-Type: text/plain",
      "",
      "inner text",
      "--IN--",
      "--OUT--",
      "",
    ].join("\r\n");
    const parsed = parseMessage(nested, options);
    expect(parsed.parts.map((part) => part.contentType)).toEqual(["text/plain"]);
    expect(parsed.parts[0]?.text).toBe("inner text");
  });

  test("a message with no headers says so rather than pretending to be mail", () => {
    expect(parseMessage("just a body", options).notes.join(" ")).toMatch(/no headers/);
  });

  test("html is reduced to text when there is no plain part", () => {
    expect(stripHtml("<p>one</p><p>two &amp; three</p>")).toBe("one\ntwo & three");
  });
});

describe("mbox", () => {
  const mbox = [
    "From jane@x.test Mon Jan 15 09:30:00 2024",
    "Subject: first",
    "",
    "body one",
    ">From the escaped line",
    "",
    "From bob@y.test Mon Jan 15 10:00:00 2024",
    "Subject: second",
    "",
    "body two",
    "",
  ].join("\n");

  test("messages split on a From line that follows a blank line", () => {
    const messages = splitMbox(mbox, 100);
    expect(messages.length).toBe(2);
    expect(messages[0]?.separator).toBe("From jane@x.test Mon Jan 15 09:30:00 2024");
  });

  test("an escaped >From line is unescaped in the message body", () => {
    expect(splitMbox(mbox, 100)[0]?.raw).toContain("\nFrom the escaped line");
  });

  test("byte offsets point at the separator lines", () => {
    const messages = splitMbox(mbox, 100);
    expect(messages[0]?.byteOffset).toBe(0);
    expect(mbox.slice(messages[1]?.byteOffset ?? 0, 4 + (messages[1]?.byteOffset ?? 0))).toBe(
      "From",
    );
  });

  test("the message limit stops the split", () => {
    expect(splitMbox(mbox, 1).length).toBe(1);
  });
});

describe("iCalendar", () => {
  test("unfolding removes exactly one whitespace character, not all of it", () => {
    expect(unfold("DESCRIPTION:one\r\n  two")).toEqual(["DESCRIPTION:one two"]);
    expect(unfold("DESCRIPTION:one\r\n\ttwo")).toEqual(["DESCRIPTION:onetwo"]);
  });

  test("a content line splits into name, parameters and value", () => {
    const line = parseContentLine(`ATTENDEE;CN="Doe, Jane";ROLE=REQ-PARTICIPANT:mailto:j@x.test`);
    expect(line?.name).toBe("ATTENDEE");
    expect(line?.params["CN"]).toEqual(["Doe, Jane"]);
    expect(line?.value).toBe("mailto:j@x.test");
  });

  test("text escapes round-trip", () => {
    const raw = "a, b; c\\d\ne";
    expect(unescapeText(escapeText(raw))).toBe(raw);
  });

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "X-WR-CALNAME:Team",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Berlin",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:1@x.test",
    "SUMMARY:Sprint review\\, week 3",
    "DESCRIPTION:Line one\\nLine two",
    "DTSTART;TZID=Europe/Berlin:20240115T090000",
    "DTEND;TZID=Europe/Berlin:20240115T100000",
    "LOCATION:Room 2",
    "RRULE:FREQ=WEEKLY;COUNT=10",
    "ATTENDEE;CN=Jane;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:jane@x.test",
    "ORGANIZER;CN=Bob:mailto:bob@x.test",
    "CATEGORIES:work,planning",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER;RELATED=START:-PT15M",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:2@x.test",
    "SUMMARY:All day",
    "DTSTART;VALUE=DATE:20240201",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const parsed = readEvents(parseComponents(ics, 12, 10_000));

  test("events are read with their text unescaped", () => {
    expect(parsed.events.length).toBe(2);
    expect(parsed.events[0]?.summary).toBe("Sprint review, week 3");
    expect(parsed.events[0]?.description).toBe("Line one\nLine two");
  });

  test("a zoned time keeps its TZID and is NOT converted", () => {
    expect(parsed.events[0]?.start).toEqual({
      raw: "20240115T090000",
      timezone: "Europe/Berlin",
      dateOnly: false,
    });
  });

  test("a date-only value gets an unambiguous ISO date", () => {
    expect(parsed.events[1]?.start).toMatchObject({ iso: "2024-02-01", dateOnly: true });
  });

  test("a UTC value gets an ISO instant", () => {
    const utc = readEvents(
      parseComponents(
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20240115T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
        12,
        100,
      ),
    );
    expect(utc.events[0]?.start?.iso).toBe("2024-01-15T09:00:00Z");
  });

  test("attendees, organizer, categories and alarms come through", () => {
    expect(parsed.events[0]?.attendees).toEqual([
      { address: "jane@x.test", name: "Jane", status: "ACCEPTED", rsvp: true },
    ]);
    expect(parsed.events[0]?.organizer?.address).toBe("bob@x.test");
    expect(parsed.events[0]?.categories).toEqual(["work", "planning"]);
    expect(parsed.events[0]?.alarms).toEqual([
      { action: "DISPLAY", trigger: "-PT15M (START)", description: undefined },
    ]);
  });

  test("a recurrence rule is carried as text, not expanded", () => {
    expect(parsed.events[0]?.rrule).toBe("FREQ=WEEKLY;COUNT=10");
  });

  test("the presence of a VTIMEZONE is reported so the caller is not misled", () => {
    expect(parsed.hasTimezones).toBe(true);
    expect(parsed.calendarNames).toEqual(["Team"]);
  });

  test("folding happens at 75 octets, counting bytes rather than characters", () => {
    const line = `DESCRIPTION:${"é".repeat(60)}`;
    const folded = foldLine(line);
    for (const part of folded.split("\r\n")) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(unfold(folded)).toEqual([line]);
  });

  test("an ISO value converts to the right calendar form", () => {
    expect(toCalendarValue("2024-01-15")).toEqual({ value: "20240115", dateOnly: true });
    expect(toCalendarValue("2024-01-15T09:30:00Z")).toEqual({
      value: "20240115T093000Z",
      dateOnly: false,
    });
    expect(() => toCalendarValue("nope")).toThrow(/not an ISO-8601/);
  });

  test("what IcsWrite produces, IcsParse reads back", () => {
    const text = writeCalendar(
      [
        {
          uid: "u1",
          summary: "Review, with a comma",
          start: "2024-01-15T09:00:00Z",
          end: "2024-01-15T10:00:00Z",
          description: "Two\nlines",
          location: "Room 2",
          attendees: ["jane@x.test"],
          rrule: "FREQ=DAILY;COUNT=3",
          alarmMinutesBefore: 15,
        },
        { uid: "u2", summary: "All day", start: "2024-02-01" },
      ],
      { stamp: "2024-01-01T00:00:00Z", calendarName: "Round trip" },
    );
    const round = readEvents(parseComponents(text, 12, 10_000));
    expect(round.events[0]?.summary).toBe("Review, with a comma");
    expect(round.events[0]?.description).toBe("Two\nlines");
    expect(round.events[0]?.start?.iso).toBe("2024-01-15T09:00:00Z");
    expect(round.events[0]?.alarms[0]?.trigger).toBe("-PT15M");
    expect(round.events[1]?.start?.dateOnly).toBe(true);
    expect(text.endsWith("\r\n")).toBe(true);
  });

  test("writing the same events twice writes the same bytes", () => {
    const events = [{ uid: "u", summary: "s", start: "2024-01-15T09:00:00Z" }];
    const options = { stamp: "2024-01-01T00:00:00Z" };
    expect(writeCalendar(events, options)).toBe(writeCalendar(events, options));
  });

  test("components nesting past the limit are refused", () => {
    const deep = `${"BEGIN:X\r\n".repeat(20)}${"END:X\r\n".repeat(20)}`;
    expect(() => parseComponents(deep, 5, 1000)).toThrow(/nest deeper than 5/);
  });
});

describe("vCard", () => {
  const vcf = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Jane Doe",
    "N:Doe;Jane;Q;Dr.;PhD",
    "ORG:Acme;Research",
    "TITLE:Engineer",
    "EMAIL;TYPE=WORK:jane@x.test",
    "EMAIL;TYPE=HOME:jane@home.test",
    "TEL;TYPE=CELL:+1 555 0100",
    "ADR;TYPE=WORK:;;1 Main St;Springfield;IL;62704;USA",
    "URL:https://x.test",
    "CATEGORIES:colleague,engineering",
    "PHOTO;ENCODING=b:AAAA",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:4.0",
    "FN:Bob",
    "END:VCARD",
    "",
  ].join("\r\n");

  const cards = readVcards(parseComponents(vcf, 12, 10_000));

  test("several cards in one file all come back", () => {
    expect(cards.length).toBe(2);
    expect(cards.map((card) => card.formattedName)).toEqual(["Jane Doe", "Bob"]);
  });

  test("the structured name splits into its five fields", () => {
    expect(cards[0]?.name).toEqual({
      family: "Doe",
      given: "Jane",
      additional: "Q",
      prefix: "Dr.",
      suffix: "PhD",
    });
  });

  test("typed emails and phones keep their types, sorted", () => {
    expect(cards[0]?.emails).toEqual([
      { value: "jane@x.test", types: ["work"] },
      { value: "jane@home.test", types: ["home"] },
    ]);
    expect(cards[0]?.phones[0]?.value).toBe("+1 555 0100");
  });

  test("a structured address splits into its parts", () => {
    expect(cards[0]?.addresses[0]).toMatchObject({
      street: "1 Main St",
      locality: "Springfield",
      region: "IL",
      postalCode: "62704",
      country: "USA",
    });
  });

  test("a photo is reported as present, never inlined", () => {
    expect(cards[0]?.hasPhoto).toBe(true);
    expect(JSON.stringify(cards[0])).not.toContain("AAAA");
  });

  test("a multi-part organisation is joined readably", () => {
    expect(cards[0]?.organization).toBe("Acme, Research");
  });
});

describe("diff", () => {
  test("stats count added, removed and unchanged lines", () => {
    const a = ["one", "two", "three"];
    const b = ["one", "TWO", "three", "four"];
    const ops = diffLines(a, b, a, b);
    expect(diffStats(ops)).toEqual({ added: 2, removed: 1, unchanged: 2 });
  });

  test("normalisation lets a re-wrapped line count as unchanged", () => {
    expect(normalizeLine("  a   b  ", true, false)).toBe("a b");
    expect(normalizeLine("A B", false, true)).toBe("a b");
  });

  test("the unified render marks each side and elides unchanged runs", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8"];
    const b = ["1", "2", "3", "4", "5", "6", "7", "X"];
    const rendered = renderUnified(diffLines(a, b, a, b), "left", "right", 1);
    expect(rendered.startsWith("--- left\n+++ right")).toBe(true);
    expect(rendered).toContain("-8");
    expect(rendered).toContain("+X");
    expect(rendered).toContain("@@ ...");
  });

  test("word counts are a magnitude, and an empty document has none", () => {
    expect(wordCounts("one two  three")).toBe(3);
    expect(wordCounts("   ")).toBe(0);
  });
});

describe("pdf object streams", () => {
  /**
   * A PDF 1.5+ file keeps most of its small objects inside an object stream
   * (`/Type /ObjStm`) instead of writing them directly, so a reader that only
   * scans for `N G obj` never sees them. This builds one by hand — with no
   * cross-reference table at all, which is also the repair path — and puts
   * the page's FONT inside it, so the text only comes out if the object
   * stream was expanded.
   */
  function pdfWithObjectStream(): Uint8Array {
    const encoder = new TextEncoder();
    const inner = "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>";
    const header = "7 0 ";
    const objStmBody = `${header}${inner}`;
    const content = "BT /F1 12 Tf 72 700 Td (Inside a stream) Tj ET\n";
    const parts = [
      "%PDF-1.5\n",
      "1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n",
      "2 0 obj\n<</Type /Pages /Kids [4 0 R] /Count 1>>\nendobj\n",
      `3 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`,
      "4 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 7 0 R>>>> /Contents 3 0 R>>\nendobj\n",
      `5 0 obj\n<</Type /ObjStm /N 1 /First ${header.length} /Length ${objStmBody.length}>>\nstream\n${objStmBody}\nendstream\nendobj\n`,
      "trailer\n<</Size 8 /Root 1 0 R>>\n%%EOF\n",
    ];
    return encoder.encode(parts.join(""));
  }

  test("an object that lives inside an object stream is found and used", () => {
    const doc = parsePdf(pdfWithObjectStream());
    expect(doc.pages().length).toBe(1);
    const page = doc.pages()[0];
    const result = extractPageText(doc, page as NonNullable<typeof page>);
    expect(result.text).toBe("Inside a stream");
    expect(result.hasTextLayer).toBe(true);
  });

  test("a file with no cross-reference table still reads, which is the repair path", () => {
    const doc = parsePdf(pdfWithObjectStream());
    expect(doc.objects.size).toBeGreaterThanOrEqual(6);
  });
});

/**
 * Hostile input, and the rules that are easy to get wrong in the direction
 * that still passes a round trip.
 *
 * Each fixture here is built from the SPECIFICATION's own definition rather
 * than from what this package happens to produce: a round trip through a
 * writer and a reader that share a wrong assumption agrees with itself.
 */
describe("pdf stream filters against the specification", () => {
  /** Wrap `body` as object 1's stream, so `decode` can be pointed at it. */
  function streamPdf(dict: string, body: Uint8Array): Uint8Array {
    const enc = new TextEncoder();
    const head = enc.encode(`%PDF-1.4\n1 0 obj\n${dict}\nstream\n`);
    const tail = enc.encode("\nendstream\nendobj\ntrailer<</Root 9 0 R>>\n%%EOF\n");
    const out = new Uint8Array(head.length + body.length + tail.length);
    out.set(head, 0);
    out.set(body, head.length);
    out.set(tail, head.length + body.length);
    return out;
  }

  function decodeFilter(filter: string, body: Uint8Array, parms = ""): Uint8Array {
    const dict = `<</Length ${body.length} /Filter /${filter}${parms}>>`;
    const doc = parsePdf(streamPdf(dict, body));
    const stream = doc.objects.get(1);
    if (stream === undefined || !("kind" in (stream as object))) {
      throw new Error("fixture did not parse as a stream");
    }
    return doc.decode(stream as Parameters<typeof doc.decode>[0]);
  }

  test("RunLengthDecode: a literal run and a repeat run, per the spec's own encoding", () => {
    // PDF 32000-1 section 7.4.5: a length byte 0-127 means the next
    // length+1 bytes are literal; 129-255 means the next byte repeats
    // 257-length times; 128 ends the stream.
    const encoded = Uint8Array.from([2, 0x41, 0x42, 0x43, 254, 0x58, 128, 0x99]);
    const decoded = decodeFilter("RunLengthDecode", encoded);
    expect(new TextDecoder().decode(decoded)).toBe("ABCXXX");
  });

  test("a RunLengthDecode bomb is refused DURING the decode, not after it", () => {
    // 600k two-byte repeat runs expand 64:1 — about 77 MB, past the 64 MB
    // cap. Decoding into a number[] first cost ~2 GB resident before the
    // length check could see it; the cap has to bite as the bytes are made.
    const pairs: number[] = [];
    for (let i = 0; i < 600_000; i++) pairs.push(129, 0x41);
    expect(() => decodeFilter("RunLengthDecode", Uint8Array.from(pairs))).toThrow(
      /decodes past the \d+ byte limit/,
    );
  });

  test("ASCIIHexDecode pairs hex digits and pads a lone final digit with zero", () => {
    // "Hello" is 48 65 6C 6C 6F; whitespace between digits is ignored and
    // '>' ends the data. A trailing odd digit is padded, so "4>" is 0x40.
    expect(
      new TextDecoder().decode(decodeFilter("ASCIIHexDecode", utf8("48 65 6c6C 6F>rest"))),
    ).toBe("Hello");
    expect(Array.from(decodeFilter("ASCIIHexDecode", utf8("4>")))).toEqual([0x40]);
  });

  test("ASCII85Decode against a vector derived from the base-85 definition", () => {
    // "Man " is 0x4D616E20 = 1298230816; in base 85 that is
    // 24,73,80,78,61, and adding 33 to each gives "9jqo^".
    expect(new TextDecoder().decode(decodeFilter("ASCII85Decode", utf8("9jqo^~>")))).toBe("Man ");
    // A partial group of n characters yields n-1 bytes: "sure." is
    // "F*2M7" for "sure" plus "/c" for the final ".".
    expect(new TextDecoder().decode(decodeFilter("ASCII85Decode", utf8("F*2M7/c~>")))).toBe(
      "sure.",
    );
    // 'z' stands for four zero bytes.
    expect(Array.from(decodeFilter("ASCII85Decode", utf8("z~>")))).toEqual([0, 0, 0, 0]);
  });

  test("an ASCII85 group larger than 32 bits is refused rather than wrapped round", () => {
    // "uuuuu" is 84,84,84,84,84 -> 84*(85^4+85^3+85^2+85+1) = 4,382,979,004,
    // past 0xFFFFFFFF. `>>>` would have emitted four plausible, wrong bytes.
    expect(() => decodeFilter("ASCII85Decode", utf8("uuuuu~>"))).toThrow(/larger than 32 bits/);
  });

  test("a single leftover ASCII85 character is refused, because it encodes nothing", () => {
    expect(() => decodeFilter("ASCII85Decode", utf8("9jqo^9~>"))).toThrow(/leftover character/);
  });

  test("predictor parameters out of range are refused with a located error", () => {
    const body = utf8("00>");
    for (const [parms, pattern] of [
      ["/Predictor 12 /Columns 400000000", /\/Columns 400000000 is outside/],
      ["/Predictor 12 /Columns -5", /\/Columns -5 is outside/],
      ["/Predictor 12 /Colors 100000 /BitsPerComponent 16", /\/Colors 100000 is outside/],
      ["/Predictor 12 /BitsPerComponent 7", /\/BitsPerComponent 7 is not one of/],
    ] as const) {
      expect(() => decodeFilter("ASCIIHexDecode", body, ` /DecodeParms <<${parms}>>`)).toThrow(
        pattern,
      );
    }
  });
});

describe("pdf page tree", () => {
  test("a page tree that revisits nodes exponentially is refused, not walked", () => {
    // Forty levels, each listing the next twice: 2^40 walks for a 2 KB file.
    // Nothing in it is a cycle, so a visited-set alone does not stop it.
    let src = "%PDF-1.4\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n";
    const levels = 40;
    for (let i = 2; i < 2 + levels; i++) {
      src += `${i} 0 obj\n<</Type /Pages /Kids [${i + 1} 0 R ${i + 1} 0 R] /Count 2>>\nendobj\n`;
    }
    src += `${2 + levels} 0 obj\n<</Type /Pages /Kids [] /Count 0>>\nendobj\n`;
    src += "trailer<</Root 1 0 R>>\n%%EOF\n";
    const doc = parsePdf(utf8(src));
    const started = Date.now();
    expect(() => doc.pages()).toThrow(/page tree visits more than/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("an ordinary page tree is nowhere near the visit budget", () => {
    const doc = parsePdf(
      samplePdf({ pages: [{ content: textPageContent(["one"]) }, { content: "" }] }),
    );
    expect(doc.pages().length).toBe(2);
  });
});

describe("iCalendar escaping against RFC 5545 section 3.3.11", () => {
  test("the four escaped characters are written as the RFC spells them", () => {
    // BACKSLASH, SEMICOLON, COMMA and newline. A round trip cannot see a
    // missing semicolon escape, because unescaping passes a bare `;` back
    // through, so this asserts the literal characters instead.
    expect(escapeText("a;b")).toBe("a\\;b");
    expect(escapeText("a,b")).toBe("a\\,b");
    expect(escapeText("a\\b")).toBe("a\\\\b");
    expect(escapeText("a\nb")).toBe("a\\nb");
    expect(escapeText("a\r\nb")).toBe("a\\nb");
    expect(escapeText("one; two, three\\four")).toBe("one\\; two\\, three\\\\four");
  });

  test("a semicolon in a summary survives the file as one value", () => {
    const ics = writeCalendar(
      [{ uid: "u", summary: "Budget; Q3", start: "2024-01-15T09:00:00Z" }],
      { stamp: "2024-01-15T09:00:00Z" },
    );
    expect(ics).toContain("SUMMARY:Budget\\; Q3");
    expect(readEvents(parseComponents(ics, 12, 1000)).events[0]?.summary).toBe("Budget; Q3");
  });

  test("a line break in a non-text property is refused, not written out as more properties", () => {
    const base = { uid: "u", summary: "s", start: "2024-01-15T09:00:00Z" };
    const stamp = { stamp: "2024-01-15T09:00:00Z" };
    for (const event of [
      { ...base, organizer: "a@b.test\r\nSUMMARY:INJECTED" },
      { ...base, attendees: ["a@b.test\nX-EVIL:1"] },
      { ...base, rrule: "FREQ=DAILY\r\nEND:VEVENT" },
      { ...base, timezone: "Europe/Berlin\r\nX-EVIL:1" },
    ]) {
      expect(() => writeCalendar([event], stamp)).toThrow(/line break or NUL/);
    }
  });

  test("a summary carrying a newline becomes an escaped one, never a second line", () => {
    const ics = writeCalendar(
      [{ uid: "u", summary: "one\r\nSUMMARY:two", start: "2024-01-15T09:00:00Z" }],
      { stamp: "2024-01-15T09:00:00Z" },
    );
    const summaries = ics.split("\r\n").filter((line) => line.startsWith("SUMMARY:"));
    expect(summaries).toEqual(["SUMMARY:one\\nSUMMARY:two"]);
  });

  test("a date-only DTSTAMP is refused: a stamp is an instant", () => {
    expect(() =>
      writeCalendar([{ uid: "u", summary: "s", start: "2024-01-15" }], { stamp: "2024-01-15" }),
    ).toThrow(/DTSTAMP must be an instant/);
  });
});

describe("xml error positions", () => {
  test("a tag spanning several lines does not double-count them", () => {
    // The mismatched `</a>` is on line 5. Counting the newlines inside the
    // opening tag twice reported it on line 7.
    const source = "<a\n  b='1'\n  c='2'>\n<d>\n</a>";
    expect(() => parseXml(source)).toThrow(/\(line 5\)/);
  });

  test("an error inside a multi-line tag names the line it is really on", () => {
    expect(() => parseXml("<a\n  b\n  c='2'>\n</a>")).toThrow(/\(line 3\)/);
  });
});

describe("xlsx row limits", () => {
  /** A one-sheet workbook whose sheetData is exactly `sheetData`. */
  function workbookWith(sheetData: string): ZipArchive {
    const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const rels = "http://schemas.openxmlformats.org/package/2006/relationships";
    const office = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    return open(
      writeZip([
        {
          name: "_rels/.rels",
          data: utf8(
            `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
          ),
        },
        {
          name: "xl/workbook.xml",
          data: utf8(
            `<workbook ${NS} ${R}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
          ),
        },
        {
          name: "xl/_rels/workbook.xml.rels",
          data: utf8(
            `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
          ),
        },
        {
          name: "xl/worksheets/sheet1.xml",
          data: utf8(`<worksheet ${NS}><sheetData>${sheetData}</sheetData></worksheet>`),
        },
      ]),
    );
  }

  test("a row gap past the limit truncates and SAYS so, rather than moving the row", () => {
    // Row 900000 cannot be materialised under a 10-row limit. Padding up to
    // the limit and then pushing the row put its data at index 10 while
    // reporting `truncated: false` — the row number silently became a lie.
    const zip = workbookWith(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>' +
        '<row r="900000"><c r="A900000" t="inlineStr"><is><t>far</t></is></c></row>',
    );
    const sheet = readXlsx(zip, { maxRowsPerSheet: 10, maxColumns: 10 }).sheets[0];
    expect(sheet?.truncated).toBe(true);
    expect(sheet?.rows.length).toBeLessThanOrEqual(10);
    expect(sheet?.rows.at(-1)).not.toEqual(["far"]);
  });

  test("a gap that fits is still materialised, so row indexes keep meaning", () => {
    const zip = workbookWith(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>' +
        '<row r="4"><c r="A4" t="inlineStr"><is><t>fourth</t></is></c></row>',
    );
    const sheet = readXlsx(zip, { maxRowsPerSheet: 100, maxColumns: 10 }).sheets[0];
    expect(sheet?.truncated).toBe(false);
    expect(sheet?.rows.length).toBe(4);
    expect(sheet?.rows[3]).toEqual(["fourth"]);
  });
});

describe("page selections and form XObjects are bounded", () => {
  test("a selection that repeats a range past the ceiling is refused", () => {
    const spec = Array.from({ length: 200 }, () => "1-1000").join(",");
    expect(() => parsePageRange(spec, 1000)).toThrow(/more than 100000 pages is refused/);
  });

  test("an ordinary repeated selection still works", () => {
    expect(parsePageRange("3,1-2,3", 5)).toEqual([3, 1, 2, 3]);
  });

  test("a content stream naming one form thousands of times decodes it once", () => {
    // 20 000 `Do` operators over the same form. Without a cache each one
    // re-inflates the form's stream; the text is drawn 20 000 times either
    // way, so this asserts the time rather than the output.
    const draw = "BT /F1 12 Tf 72 700 Td (x) Tj ET";
    const form = `5 0 obj\n<</Type /XObject /Subtype /Form /Length ${draw.length}>>\nstream\n${draw}\nendstream\nendobj`;
    const content = Array.from({ length: 20_000 }, () => "/Fm Do").join("\n");
    const src = [
      "%PDF-1.4",
      "1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj",
      "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj",
      "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</XObject <</Fm 5 0 R>>>> /Contents 4 0 R>>\nendobj",
      `4 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj`,
      form,
      "trailer<</Root 1 0 R>>\n%%EOF",
      "",
    ].join("\n");
    const doc = parsePdf(utf8(src));
    const page = doc.pages()[0];
    if (page === undefined) throw new Error("fixture has no page");
    const started = Date.now();
    const result = extractPageText(doc, page);
    expect(result.hasTextLayer).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
