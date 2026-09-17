/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Each test builds a throwaway directory under the OS temp dir and chdir's
 * into it, because the workspace root is `process.cwd()` and that is the
 * boundary every path in this package is checked against. Nothing is ever
 * written inside the repository, and every fixture is constructed in the
 * test rather than committed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { sampleDocx, samplePdf, samplePptx, sampleXlsx, textPageContent } from "./fixtures";
import {
  DOCS_TOOLS,
  detectKind,
  documentDiff,
  documentTextTool,
  docxRead,
  docxWrite,
  emlParse,
  icsParse,
  icsWrite,
  mboxSplit,
  pdfInfo,
  pdfMerge,
  pdfSplit,
  pdfText,
  pptxRead,
  vcardParse,
  xlsxRead,
  xlsxWrite,
} from "./index";

const originalCwd = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-docs-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** Tools return compact JSON or plain text; parse it when it is JSON. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function run(tool: (typeof DOCS_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function place(name: string, bytes: Uint8Array | string): string {
  writeFileSync(path.join(tmp, name), bytes);
  return name;
}

describe("package-wide contract", () => {
  test("every tool is exported in DOCS_TOOLS", () => {
    expect(DOCS_TOOLS.length).toBe(16);
  });

  test("names are unique and PascalCase", () => {
    const names = DOCS_TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every description's second sentence tells the caller when to use it", () => {
    for (const tool of DOCS_TOOLS) {
      const sentences = tool.description.split(". ");
      expect({ name: tool.name, starts: sentences[1]?.startsWith("Use ") }).toEqual({
        name: tool.name,
        starts: true,
      });
    }
  });

  test("nothing here crosses a network or process boundary", () => {
    for (const tool of DOCS_TOOLS) {
      expect({ name: tool.name, scope: tool.scope, io: tool.ioCapability }).toEqual({
        name: tool.name,
        scope: "internal",
        io: undefined,
      });
    }
  });

  test("readers are read-only and concurrency-safe; writers are destructive and neither", () => {
    const writers = new Set(["DocxWrite", "XlsxWrite", "IcsWrite", "PdfSplit", "PdfMerge"]);
    for (const tool of DOCS_TOOLS) {
      const expected = writers.has(tool.name)
        ? { readOnly: false, destructive: true, concurrencySafe: false }
        : { readOnly: true, destructive: false, concurrencySafe: true };
      expect({
        name: tool.name,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        concurrencySafe: tool.concurrencySafe,
      }).toEqual({ name: tool.name, ...expected });
    }
  });

  test("every schema rejects a wrong-typed path", () => {
    for (const tool of DOCS_TOOLS) {
      expect(tool.inputSchema.safeParse({ path: 42 }).success).toBe(false);
    }
  });

  test("a path outside the workspace is refused, not read", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-docs-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.docx"), sampleDocx());
      const result = await run(docxRead, { path: path.join(outside, "secret.docx") });
      expect(String(result)).toMatch(/escapes the workspace root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a missing file is an answer, not a crash", async () => {
    expect(String(await run(docxRead, { path: "nope.docx" }))).toMatch(/no such file/);
  });
});

describe("format detection", () => {
  test("a file is identified by its bytes, not by its extension", () => {
    expect(detectKind("actually-a-pdf.docx", samplePdf({ pages: [{ content: "" }] }))).toBe("pdf");
    expect(detectKind("sheet.bin", sampleXlsx())).toBe("xlsx");
    expect(detectKind("deck.bin", samplePptx())).toBe("pptx");
    expect(detectKind("doc.bin", sampleDocx())).toBe("docx");
  });

  test("text formats are told apart by their first lines", () => {
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(detectKind("x.ics", encode("BEGIN:VCALENDAR\r\nEND:VCALENDAR"))).toBe("ics");
    expect(detectKind("x.vcf", encode("BEGIN:VCARD\r\nEND:VCARD"))).toBe("vcf");
    expect(detectKind("x.eml", encode("Subject: hi\n\nbody"))).toBe("eml");
    expect(detectKind("x.txt", encode("plain words"))).toBe("text");
    expect(detectKind("x.html", encode("<html><body>hi</body></html>"))).toBe("html");
  });

  test("binary rubbish is not claimed as text", () => {
    expect(detectKind("x.bin", Uint8Array.from([1, 0, 2, 0, 3]))).toBeNull();
  });
});

describe("DocxRead and DocxWrite", () => {
  test("a document reads into blocks with headings, lists and tables", async () => {
    const result = await run(docxRead, { path: place("a.docx", sampleDocx()) });
    expect(result.blockCount).toBe(6);
    expect(result.blocks[0]).toMatchObject({ headingLevel: 1 });
    expect(result.properties.title).toBe("Quarterly Report");
    expect(result.notReadParts).toEqual(["footnotes"]);
  });

  test("asText returns text a caller can paste onward", async () => {
    const text = await run(docxRead, { path: place("a.docx", sampleDocx()), asText: true });
    expect(text).toContain("Quarterly Report");
    expect(text).toContain("Region\tTotal");
  });

  test("maxBlocks truncates and says so", async () => {
    const result = await run(docxRead, { path: place("a.docx", sampleDocx()), maxBlocks: 2 });
    expect(result.truncated).toBe(true);
    expect(result.blocks.length).toBe(2);
  });

  test("writing then reading round-trips the content", async () => {
    const written = await run(docxWrite, {
      path: "out.docx",
      blocks: [
        { type: "heading", text: "Report", level: 1 },
        { type: "paragraph", text: "Body" },
        { type: "list", items: ["a", "b"] },
      ],
      title: "Report",
      created: "2024-01-15T09:00:00Z",
    });
    expect(written.path).toBe("out.docx");
    const back = await run(docxRead, { path: "out.docx" });
    expect(back.blocks.map((block: { text: string }) => block.text)).toEqual([
      "Report",
      "Body",
      "a",
      "b",
    ]);
    expect(back.properties.title).toBe("Report");
  });

  test("an existing file is not clobbered unless overwrite is passed", async () => {
    place("out.docx", "not a docx");
    const blocks = [{ type: "paragraph", text: "x" }];
    expect(String(await run(docxWrite, { path: "out.docx", blocks }))).toMatch(/already exists/);
    const forced = await run(docxWrite, { path: "out.docx", blocks, overwrite: true });
    expect(forced.bytes).toBeGreaterThan(0);
  });

  test("a file that is not a package is refused by name", async () => {
    expect(String(await run(docxRead, { path: place("a.docx", "hello") }))).toMatch(
      /not a zip archive/,
    );
  });
});

describe("XlsxRead and XlsxWrite", () => {
  test("a workbook reads into typed rows with formulas alongside", async () => {
    const result = await run(xlsxRead, { path: place("a.xlsx", sampleXlsx()) });
    expect(result.sheets[0].name).toBe("Data");
    expect(result.sheets[0].rows[1][1]).toBe(120.5);
    expect(result.sheets[0].formulas[0]).toEqual({
      ref: "E2",
      formula: "=B2*2",
      cachedValue: 241,
    });
    expect(result.dateSystem).toBe("1900");
  });

  test("a sheet can be selected by name", async () => {
    const result = await run(xlsxRead, { path: place("a.xlsx", sampleXlsx()), sheets: ["Notes"] });
    expect(result.sheets.length).toBe(1);
    expect(result.sheets[0].rows[0][0]).toBe("second sheet");
  });

  test("writing then reading keeps numbers, booleans and named date columns", async () => {
    await run(xlsxWrite, {
      path: "out.xlsx",
      sheets: [
        {
          name: "Sheet1",
          rows: [
            ["name", "n", "ok", "when"],
            ["a", 2, true, "2024-05-06"],
          ],
          header: true,
          dateColumns: [3],
        },
      ],
    });
    const back = await run(xlsxRead, { path: "out.xlsx" });
    expect(back.sheets[0].rows[1]).toEqual(["a", 2, true, "2024-05-06"]);
  });

  test("a sheet name longer than Excel allows is rejected by the schema", () => {
    expect(
      xlsxWrite.inputSchema.safeParse({
        path: "x.xlsx",
        sheets: [{ name: "x".repeat(40), rows: [] }],
      }).success,
    ).toBe(false);
  });
});

describe("PptxRead", () => {
  test("slides come back in presentation order with their titles", async () => {
    const result = await run(pptxRead, { path: place("a.pptx", samplePptx()) });
    expect(result.slideCount).toBe(2);
    expect(result.slides.map((slide: { title: string }) => slide.title)).toEqual([
      "First Slide",
      "Second Slide",
    ]);
  });

  test("notes are opt-in", async () => {
    const without = await run(pptxRead, { path: place("a.pptx", samplePptx()) });
    expect(without.slides[0].notes).toBeUndefined();
    const withNotes = await run(pptxRead, {
      path: place("b.pptx", samplePptx()),
      includeNotes: true,
    });
    expect(withNotes.slides[0].notes).toBe("remember the demo");
  });

  test("asText renders a readable outline", async () => {
    const text = await run(pptxRead, { path: place("a.pptx", samplePptx()), asText: true });
    expect(text.startsWith("# Slide 1: First Slide")).toBe(true);
  });
});

describe("PdfInfo and PdfText", () => {
  const threePages = (): Uint8Array =>
    samplePdf({ pages: [1, 2, 3].map((n) => ({ content: textPageContent([`Page ${n}`]) })) });

  test("info reports pages, sizes and which pages carry text", async () => {
    const result = await run(pdfInfo, { path: place("a.pdf", threePages()) });
    expect(result.pageCount).toBe(3);
    expect(result.pagesWithTextLayer).toBe(3);
    expect(result.pages[0]).toMatchObject({ page: 1, widthPt: 612, heightPt: 792, rotate: 0 });
    expect(result.encrypted).toBe(false);
  });

  test("a scan is called a scan rather than reported as empty", async () => {
    const scanned = samplePdf({
      pages: [{ content: "0 0 1 rg 10 10 100 100 re f\n", withFont: false }],
    });
    const info = await run(pdfInfo, { path: place("scan.pdf", scanned) });
    expect(info.pagesWithTextLayer).toBe(0);
    expect(info.textLayer).toMatch(/would need OCR/);
    const text = await run(pdfText, { path: "scan.pdf" });
    expect(JSON.stringify(text)).toMatch(/most likely a scan/);
  });

  test("an encrypted pdf is reported, and its text is refused", async () => {
    const encrypted = samplePdf({
      pages: [{ content: textPageContent(["secret"]) }],
      encrypted: true,
    });
    const info = await run(pdfInfo, { path: place("e.pdf", encrypted) });
    expect(info.encrypted).toBe(true);
    expect(String(await run(pdfText, { path: "e.pdf" }))).toMatch(/encrypted/);
  });

  test("text extraction honours a page range and can key by page", async () => {
    place("a.pdf", threePages());
    expect(await run(pdfText, { path: "a.pdf", pages: "2" })).toBe("Page 2");
    const perPage = await run(pdfText, { path: "a.pdf", pages: "3,1", perPage: true });
    expect(perPage.pages.map((page: { page: number }) => page.page)).toEqual([3, 1]);
  });

  test("a bad page range is an answer, not a crash", async () => {
    place("a.pdf", threePages());
    expect(String(await run(pdfText, { path: "a.pdf", pages: "9" }))).toMatch(/out of range/);
  });

  test("maxChars truncates and says so", async () => {
    place("a.pdf", threePages());
    const result = await run(pdfText, { path: "a.pdf", maxChars: 4 });
    expect(result.truncated).toBe(true);
  });

  test("a file that is not a pdf is refused by name", async () => {
    expect(String(await run(pdfInfo, { path: place("a.pdf", "hello") }))).toMatch(/not a pdf/);
  });
});

describe("PdfSplit and PdfMerge", () => {
  const threePages = (): Uint8Array =>
    samplePdf({ pages: [1, 2, 3].map((n) => ({ content: textPageContent([`Page ${n}`]) })) });

  test("a split writes only the selected pages, in the order asked for", async () => {
    place("a.pdf", threePages());
    const result = await run(pdfSplit, { path: "a.pdf", pages: "3,1", output: "out.pdf" });
    expect(result.pages).toBe(2);
    expect(await run(pdfText, { path: "out.pdf" })).toBe("Page 3\n\nPage 1");
  });

  test("the split says plainly what it dropped", async () => {
    place("a.pdf", threePages());
    const result = await run(pdfSplit, { path: "a.pdf", pages: "1", output: "out.pdf" });
    expect(result.dropped).toMatch(/annotations/);
  });

  test("a merge concatenates whole files and selected ranges alike", async () => {
    place("a.pdf", threePages());
    place("b.pdf", samplePdf({ pages: [{ content: textPageContent(["Other"]) }] }));
    const result = await run(pdfMerge, {
      inputs: [{ path: "a.pdf", pages: "2" }, { path: "b.pdf" }],
      output: "merged.pdf",
    });
    expect(result.pages).toBe(2);
    expect(await run(pdfText, { path: "merged.pdf" })).toBe("Page 2\n\nOther");
  });

  test("an encrypted source is refused rather than written out broken", async () => {
    place("e.pdf", samplePdf({ pages: [{ content: textPageContent(["x"]) }], encrypted: true }));
    expect(String(await run(pdfSplit, { path: "e.pdf", pages: "1", output: "o.pdf" }))).toMatch(
      /encrypted/,
    );
  });

  test("an existing output is not clobbered unless overwrite is passed", async () => {
    place("a.pdf", threePages());
    place("out.pdf", "existing");
    expect(String(await run(pdfSplit, { path: "a.pdf", pages: "1", output: "out.pdf" }))).toMatch(
      /already exists/,
    );
    await run(pdfSplit, { path: "a.pdf", pages: "1", output: "out.pdf", overwrite: true });
    expect(statSync(path.join(tmp, "out.pdf")).size).toBeGreaterThan(100);
  });

  test("an output path outside the workspace is refused", async () => {
    place("a.pdf", threePages());
    const result = await run(pdfSplit, {
      path: "a.pdf",
      pages: "1",
      output: "../escaped.pdf",
    });
    expect(String(result)).toMatch(/escapes the workspace root/);
  });

  test("the same split written twice is byte-identical", async () => {
    place("a.pdf", threePages());
    await run(pdfSplit, { path: "a.pdf", pages: "1", output: "x.pdf", date: "D:20240101000000Z" });
    await run(pdfSplit, { path: "a.pdf", pages: "1", output: "y.pdf", date: "D:20240101000000Z" });
    expect([...readFileSync(path.join(tmp, "x.pdf"))]).toEqual([
      ...readFileSync(path.join(tmp, "y.pdf")),
    ]);
  });
});

describe("EmlParse and MboxSplit", () => {
  const eml = [
    "From: Jane <jane@x.test>",
    "To: bob@y.test",
    "Subject: =?utf-8?B?SGVsbG8=?=",
    "Date: Mon, 15 Jan 2024 09:30:00 +0000",
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain",
    "",
    "the body",
    "--B",
    "Content-Type: application/pdf",
    "Content-Disposition: attachment; filename=r.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    "SGVsbG8=",
    "--B--",
    "",
  ].join("\r\n");

  test("a message parses into addresses, subject, date and parts", async () => {
    const result = await run(emlParse, { path: place("m.eml", eml) });
    expect(result.subject).toBe("Hello");
    expect(result.date).toBe("2024-01-15T09:30:00.000Z");
    expect(result.from).toEqual([{ name: "Jane", address: "jane@x.test" }]);
    expect(result.attachmentCount).toBe(1);
    expect(result.parts[1].filename).toBe("r.pdf");
  });

  test("bodies are opt-in and attachment bytes are never returned", async () => {
    const without = await run(emlParse, { path: place("m.eml", eml) });
    expect(without.parts[0].text).toBeUndefined();
    const withBodies = await run(emlParse, { path: "m.eml", includeBodies: true });
    expect(withBodies.parts[0].text).toBe("the body");
    expect(JSON.stringify(withBodies)).not.toContain("SGVsbG8=");
  });

  test("a message can be passed as content instead of a path", async () => {
    const result = await run(emlParse, { content: eml, asText: true });
    expect(result).toBe("the body");
  });

  test("passing both a path and content is a caller mistake with a clear answer", async () => {
    expect(String(await run(emlParse, { path: place("m.eml", eml), content: eml }))).toMatch(
      /either path or content/,
    );
  });

  test("an mbox lists its messages with offsets, and one can be extracted", async () => {
    const mbox = [
      "From jane@x.test Mon Jan 15 09:30:00 2024",
      "Subject: first",
      "",
      "one",
      "",
      "From bob@y.test Mon Jan 15 10:00:00 2024",
      "Subject: second",
      "",
      "two",
      "",
    ].join("\n");
    const listing = await run(mboxSplit, { path: place("a.mbox", mbox) });
    expect(listing.messageCount).toBe(2);
    expect(listing.messages[1].subject).toBe("second");
    const extracted = await run(mboxSplit, { path: "a.mbox", extract: 2 });
    expect(extracted).toContain("Subject: second");
    expect(String(await run(mboxSplit, { path: "a.mbox", extract: 9 }))).toMatch(/does not exist/);
  });

  test("a file with no From lines says what an mbox message looks like", async () => {
    expect(String(await run(mboxSplit, { path: place("a.mbox", "nothing here") }))).toMatch(
      /begins with a 'From ' line/,
    );
  });
});

describe("IcsParse, IcsWrite and VcardParse", () => {
  test("a calendar parses into events with attendees and alarms", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:1@x.test",
      "SUMMARY:Stand-up",
      "DTSTART:20240115T090000Z",
      "DTEND:20240115T091500Z",
      "RRULE:FREQ=DAILY",
      "ATTENDEE;CN=Jane:mailto:jane@x.test",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const result = await run(icsParse, { path: place("a.ics", ics) });
    expect(result.eventCount).toBe(1);
    expect(result.events[0].summary).toBe("Stand-up");
    expect(result.events[0].start.iso).toBe("2024-01-15T09:00:00Z");
    expect(result.events[0].rrule).toBe("FREQ=DAILY");
  });

  test("a calendar with timezone definitions warns that offsets are not applied", async () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "DTSTART;TZID=Europe/Berlin:20240115T090000",
      "SUMMARY:Local",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const result = await run(icsParse, { path: place("a.ics", ics) });
    expect(result.note).toMatch(/NOT applied/);
    expect(result.events[0].start.timezone).toBe("Europe/Berlin");
  });

  test("writing then parsing round-trips an event", async () => {
    await run(icsWrite, {
      path: "out.ics",
      stamp: "2024-01-01T00:00:00Z",
      calendarName: "Team",
      events: [
        {
          uid: "u1",
          summary: "Review; with a semicolon",
          start: "2024-01-15T09:00:00Z",
          end: "2024-01-15T10:00:00Z",
          attendees: ["jane@x.test"],
          alarmMinutesBefore: 10,
        },
      ],
    });
    const back = await run(icsParse, { path: "out.ics" });
    expect(back.events[0].summary).toBe("Review; with a semicolon");
    expect(back.events[0].attendees[0].address).toBe("jane@x.test");
    expect(back.calendarNames).toEqual(["Team"]);
  });

  test("an unparseable start date is an answer, not a crash", async () => {
    const result = await run(icsWrite, {
      path: "out.ics",
      stamp: "2024-01-01T00:00:00Z",
      events: [{ uid: "u", summary: "s", start: "the fifteenth" }],
    });
    expect(String(result)).toMatch(/not an ISO-8601/);
  });

  test("contacts parse into names, emails and phones", async () => {
    const vcf = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:Jane Doe",
      "N:Doe;Jane;;;",
      "EMAIL;TYPE=WORK:jane@x.test",
      "TEL;TYPE=CELL:+15550100",
      "END:VCARD",
      "",
    ].join("\r\n");
    const result = await run(vcardParse, { path: place("a.vcf", vcf) });
    expect(result.cardCount).toBe(1);
    expect(result.cards[0].formattedName).toBe("Jane Doe");
    expect(result.cards[0].emails[0]).toEqual({ value: "jane@x.test", types: ["work"] });
  });
});

describe("DocumentText and DocumentDiff", () => {
  test("every supported format goes in and text comes out", async () => {
    place("a.docx", sampleDocx());
    place("a.xlsx", sampleXlsx());
    place("a.pptx", samplePptx());
    place("a.pdf", samplePdf({ pages: [{ content: textPageContent(["Pdf text"]) }] }));
    place("a.txt", "just words");
    expect(await run(documentTextTool, { path: "a.docx" })).toContain("Quarterly Report");
    expect(await run(documentTextTool, { path: "a.xlsx" })).toContain("# Data");
    expect(await run(documentTextTool, { path: "a.pptx" })).toContain("First Slide");
    expect(await run(documentTextTool, { path: "a.pdf" })).toBe("Pdf text");
    expect(await run(documentTextTool, { path: "a.txt" })).toBe("just words");
  });

  test("the detected kind is reported on request", async () => {
    place("a.docx", sampleDocx());
    const result = await run(documentTextTool, { path: "a.docx", withMetadata: true });
    expect(result.kind).toBe("docx");
  });

  test("a scanned pdf reports why there is no text", async () => {
    place(
      "scan.pdf",
      samplePdf({ pages: [{ content: "1 0 0 RG 5 w 10 10 m 100 100 l S\n", withFont: false }] }),
    );
    const result = await run(documentTextTool, { path: "scan.pdf" });
    expect(JSON.stringify(result.notes)).toMatch(/needs OCR/);
  });

  test("an unsupported file says so instead of returning rubbish", async () => {
    writeFileSync(path.join(tmp, "a.bin"), Uint8Array.from([0, 1, 2, 0, 3]));
    expect(String(await run(documentTextTool, { path: "a.bin" }))).toMatch(
      /not a format this tool reads/,
    );
  });

  test("two revisions of a document diff to counts plus a unified diff", async () => {
    place(
      "a.pdf",
      samplePdf({ pages: [{ content: textPageContent(["Alpha", "Beta", "Gamma"]) }] }),
    );
    place(
      "b.pdf",
      samplePdf({ pages: [{ content: textPageContent(["Alpha", "Delta", "Gamma"]) }] }),
    );
    const result = await run(documentDiff, { a: "a.pdf", b: "b.pdf" });
    expect(result).toMatchObject({ added: 1, removed: 1, unchanged: 2, identical: false });
    expect(result.diff).toContain("-Beta");
    expect(result.diff).toContain("+Delta");
  });

  test("identical documents report identical, with no diff body", async () => {
    const bytes = samplePdf({ pages: [{ content: textPageContent(["Same"]) }] });
    place("a.pdf", bytes);
    place("b.pdf", bytes);
    const result = await run(documentDiff, { a: "a.pdf", b: "b.pdf" });
    expect(result.identical).toBe(true);
    expect(result.diff).toBeUndefined();
  });

  test("documents in different formats can be compared", async () => {
    place("a.docx", sampleDocx());
    place("a.txt", "Quarterly Report");
    const result = await run(documentDiff, { a: "a.docx", b: "a.txt", statsOnly: true });
    expect(result.a.kind).toBe("docx");
    expect(result.b.kind).toBe("text");
    expect(result.unchanged).toBe(1);
  });

  test("ignoring whitespace keeps a re-wrapped line from reading as a rewrite", async () => {
    place("a.txt", "one   two\nthree");
    place("b.txt", "one two\nthree");
    const strict = await run(documentDiff, { a: "a.txt", b: "b.txt", ignoreWhitespace: false });
    expect(strict.identical).toBe(false);
    const relaxed = await run(documentDiff, { a: "a.txt", b: "b.txt" });
    expect(relaxed.identical).toBe(true);
  });
});

/**
 * The boundary, reached the way an attacker would: not with a `..` in the
 * string, but with a link that lives inside the workspace and points out of
 * it. The lexical check passes; only the realpath check refuses it.
 */
describe("containment through a symlink", () => {
  test("reading through an in-workspace link that points outside is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-docs-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.docx"), sampleDocx());
      symlinkSync(path.join(outside, "secret.docx"), path.join(tmp, "innocent.docx"));
      const result = await run(docxRead, { path: "innocent.docx" });
      expect(String(result)).toMatch(/escapes the workspace root/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("writing through an in-workspace link to an outside directory is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-docs-outside-"));
    try {
      symlinkSync(outside, path.join(tmp, "elsewhere"));
      const result = await run(icsWrite, {
        path: "elsewhere/planted.ics",
        stamp: "2024-01-15T09:00:00Z",
        events: [{ uid: "u", summary: "s", start: "2024-01-15T09:00:00Z" }],
      });
      expect(String(result)).toMatch(/escapes the workspace root/);
      expect(existsSync(path.join(outside, "planted.ics"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a traversal in the middle of a path is refused as well as a leading one", async () => {
    for (const bad of ["sub/../../escape.docx", "/etc/hosts", "./a/../../b.docx"]) {
      expect(String(await run(docxRead, { path: bad }))).toMatch(/escapes the workspace root/);
    }
  });
});

describe("PdfInfo tells 'no text layer' apart from 'could not tell'", () => {
  test("a page whose content stream will not decode is not reported as a scan", async () => {
    // The content stream declares a PNG predictor with an impossible
    // /Colors, so decoding refuses. Reporting hasTextLayer:false here would
    // send the caller to OCR over what is really an unreadable stream.
    const enc = new TextEncoder();
    const body = enc.encode("00");
    const src = [
      "%PDF-1.4",
      "1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj",
      "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj",
      "3 0 obj\n<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R>>\nendobj",
      `4 0 obj\n<</Length ${body.length} /Filter /ASCIIHexDecode /DecodeParms <</Predictor 12 /Colors 99>>>>\nstream\n00\nendstream\nendobj`,
      "trailer<</Root 1 0 R>>\n%%EOF",
      "",
    ].join("\n");
    const result = await run(pdfInfo, { path: place("odd.pdf", enc.encode(src)) });
    expect(result.pageCount).toBe(1);
    expect(result.pages[0].hasTextLayer).toBeNull();
    expect(result.pagesNotDetermined).toBe(1);
    expect(result.textLayer).not.toMatch(/most likely a scan/);
    expect(String(result.probeFailures[0])).toMatch(/\/Colors 99 is outside/);
  });

  test("a genuine scan still says so plainly", async () => {
    const result = await run(pdfInfo, {
      path: place("scan.pdf", samplePdf({ pages: [{ content: "1 0 0 1 0 0 cm" }] })),
    });
    expect(result.pages[0].hasTextLayer).toBe(false);
    expect(result.textLayer).toMatch(/most likely a scan/);
  });
});

describe("truncation is never silent", () => {
  const long = (marker: string): string =>
    `${Array.from({ length: 400 }, (_u, i) => `line ${i} of the document`).join("\n")}\n${marker}`;

  test("DocumentText says it truncated instead of returning a shortened document as the text", async () => {
    const result = await run(documentTextTool, {
      path: place("long.txt", long("TAIL-A")),
      maxChars: 200,
    });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(200);
    expect(String(result.notes.join(" "))).toMatch(/truncated at 200 characters/);
  });

  test("DocumentDiff does not call two truncated documents identical", async () => {
    // The two files differ only in their last line, past the budget.
    const a = place("a.txt", long("TAIL-A"));
    const b = place("b.txt", long("TAIL-B"));
    const result = await run(documentDiff, { a, b, maxChars: 200 });
    expect(result.identical).toBeNull();
    expect(result.comparedTextIdentical).toBe(true);
    expect(result.a.truncated).toBe(true);
    expect(String(result.notes.join(" "))).toMatch(/truncated before comparing/);
  });

  test("with room for the whole document, identical is a real claim again", async () => {
    const a = place("a2.txt", long("TAIL"));
    const b = place("b2.txt", long("TAIL"));
    const result = await run(documentDiff, { a, b, maxChars: 200_000 });
    expect(result.identical).toBe(true);
    expect(result.comparedTextIdentical).toBeUndefined();
  });

  test("a pdf cut short at the character budget says which pages it got through", async () => {
    const pdf = samplePdf({
      pages: [
        { content: textPageContent(["page one text here"]) },
        { content: textPageContent(["page two text here"]) },
      ],
    });
    const result = await run(documentTextTool, { path: place("two.pdf", pdf), maxChars: 12 });
    expect(result.truncated).toBe(true);
    expect(String(result.notes.join(" "))).toMatch(/truncated at 12 characters, after 1 of 2/);
  });
});
