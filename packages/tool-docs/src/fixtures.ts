/**
 * Binary fixtures, BUILT rather than committed.
 *
 * A checked-in .docx or .pdf is an opaque blob: nobody can see what a test
 * is actually asserting about, and nobody can adjust it. Every fixture here
 * is constructed byte by byte from readable parts, so a test that says "a
 * workbook whose A1 is a shared string and whose B2 is a date serial" has
 * that workbook written out in front of it.
 *
 * This file is shipped rather than kept under a test extension because the
 * type checker should check it too, and because the PDF builder below is the
 * only independent writer this package has for verifying its own reader.
 */
import { deflateSync } from "node:zlib";
import { XML_DECL, utf8 } from "./lib/ooxml";
import { type ZipInput, writeZip } from "./lib/zip";

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function types(overrides: ReadonlyArray<string>): string {
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`;
}

function rootRels(type: string, target: string): string {
  return `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/${type}" Target="${target}"/><Relationship Id="rId2" Type="${RELS_NS}/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
}

function coreProps(title: string, creator: string): string {
  return `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>${title}</dc:title><dc:creator>${creator}</dc:creator><dcterms:created>2024-01-15T09:00:00Z</dcterms:created></cp:coreProperties>`;
}

/**
 * A .docx with one heading, one body paragraph, a two-item bullet list and a
 * 2x2 table — written by hand rather than through `writeDocx`, so that
 * reading is tested against something other than this package's own writer.
 */
export function sampleDocx(): Uint8Array {
  const W =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:xml="http://www.w3.org/XML/1998/namespace"';
  const document = `${XML_DECL}<w:document ${W}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Revenue was </w:t></w:r><w:r><w:t>up.</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Second point</w:t></w:r></w:p><w:p><w:r><w:t>Before</w:t></w:r><w:tab/><w:r><w:t>after</w:t></w:r><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
  const styles = `${XML_DECL}<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style></w:styles>`;
  const numbering = `${XML_DECL}<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  const parts: ZipInput[] = [
    {
      name: "[Content_Types].xml",
      data: utf8(
        types([
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        ]),
      ),
    },
    { name: "_rels/.rels", data: utf8(rootRels("officeDocument", "word/document.xml")) },
    { name: "word/document.xml", data: utf8(document) },
    { name: "word/styles.xml", data: utf8(styles) },
    { name: "word/numbering.xml", data: utf8(numbering) },
    { name: "word/footnotes.xml", data: utf8(`${XML_DECL}<w:footnotes ${W}/>`) },
    { name: "docProps/core.xml", data: utf8(coreProps("Quarterly Report", "A. Author")) },
  ];
  return writeZip(parts);
}

/**
 * A .xlsx with a shared-string table, a numeric cell, a boolean, a formula
 * with a cached value, an inline string and a date-formatted serial.
 */
export function sampleXlsx(): Uint8Array {
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const workbook = `${XML_DECL}<workbook ${NS} ${R}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const workbookRels = `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${OFFICE_REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const shared = `${XML_DECL}<sst ${NS} count="3" uniqueCount="3"><si><t>Region</t></si><si><t>North</t></si><si><r><t>Mixed</t></r><r><t> format</t></r></si></sst>`;
  // Style 1 is numFmtId 14 (a built-in date format); style 2 is a custom one.
  const styles = `${XML_DECL}<styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="165" formatCode="yyyy&quot;-&quot;mm"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/></cellXfs></styleSheet>`;
  const sheet1 = `${XML_DECL}<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>120.5</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" s="1"><v>45306</v></c><c r="E2"><f>B2*2</f><v>241</v></c></row><row r="4"><c r="A4" t="s"><v>2</v></c><c r="C4" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>`;
  const sheet2 = `${XML_DECL}<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>second sheet</t></is></c></row></sheetData></worksheet>`;
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: utf8(
        types([
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        ]),
      ),
    },
    { name: "_rels/.rels", data: utf8(rootRels("officeDocument", "xl/workbook.xml")) },
    { name: "xl/workbook.xml", data: utf8(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(workbookRels) },
    { name: "xl/sharedStrings.xml", data: utf8(shared) },
    { name: "xl/styles.xml", data: utf8(styles) },
    { name: "xl/worksheets/sheet1.xml", data: utf8(sheet1) },
    { name: "xl/worksheets/sheet2.xml", data: utf8(sheet2) },
    { name: "docProps/core.xml", data: utf8(coreProps("Numbers", "A. Author")) },
  ]);
}

/**
 * A .pptx whose `sldIdLst` puts `slide2.xml` FIRST, so a reader that orders
 * slides by part name gets it wrong and a reader that follows the
 * relationships gets it right.
 */
export function samplePptx(): Uint8Array {
  const P =
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const presentation = `${XML_DECL}<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`;
  const presentationRels = `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/slide" Target="slides/slide2.xml"/></Relationships>`;
  const slide = (title: string, body: string): string =>
    `${XML_DECL}<p:sld ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${body}</a:t></a:r><a:br/><a:r><a:t>second line</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const notes = `${XML_DECL}<p:notes ${P}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:txBody><a:p><a:r><a:t>remember the demo</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`;
  const slide2Rels = `${XML_DECL}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`;
  return writeZip([
    {
      name: "[Content_Types].xml",
      data: utf8(
        types([
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
        ]),
      ),
    },
    { name: "_rels/.rels", data: utf8(rootRels("officeDocument", "ppt/presentation.xml")) },
    { name: "ppt/presentation.xml", data: utf8(presentation) },
    { name: "ppt/_rels/presentation.xml.rels", data: utf8(presentationRels) },
    { name: "ppt/slides/slide1.xml", data: utf8(slide("Second Slide", "later content")) },
    { name: "ppt/slides/slide2.xml", data: utf8(slide("First Slide", "earlier content")) },
    { name: "ppt/slides/_rels/slide2.xml.rels", data: utf8(slide2Rels) },
    { name: "ppt/notesSlides/notesSlide1.xml", data: utf8(notes) },
    { name: "docProps/core.xml", data: utf8(coreProps("Deck", "A. Author")) },
  ]);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export type PdfFixturePage = {
  /** The page's content stream, as operators. */
  readonly content: string;
  /** Include an /F1 Helvetica resource. A page with no font draws no text. */
  readonly withFont?: boolean;
  readonly mediaBox?: readonly [number, number, number, number];
  readonly rotate?: number;
};

export type PdfFixtureOptions = {
  readonly pages: ReadonlyArray<PdfFixturePage>;
  /** Compress every content stream with FlateDecode. */
  readonly compress?: boolean;
  /** Add an /Encrypt entry to the trailer, as a protected document has. */
  readonly encrypted?: boolean;
  readonly title?: string;
  /** Write a deliberately wrong /Length, to exercise the repair path. */
  readonly lieAboutLength?: boolean;
  /** A `/ToUnicode` CMap for /F1, mapping codes to other characters. */
  readonly toUnicode?: string;
};

/**
 * Build a PDF from parts, with a correct classic cross-reference table.
 *
 * This is an INDEPENDENT writer: it shares no code with `lib/pdf-write.ts`,
 * so a test that reads what this produces is testing the reader rather than
 * testing that the writer and reader agree with each other.
 */
export function samplePdf(options: PdfFixtureOptions): Uint8Array {
  const deflate = (bytes: Uint8Array): Uint8Array => new Uint8Array(deflateSync(bytes));
  const encoder = new TextEncoder();
  const objects: Array<Uint8Array> = [];
  const add = (body: Uint8Array | string): number => {
    objects.push(typeof body === "string" ? encoder.encode(body) : body);
    return objects.length; // object numbers are 1-based
  };

  // Reserve 1 = catalog and 2 = page tree so the page objects can point back.
  add("");
  add("");
  const fontNum = add(
    options.toUnicode === undefined ? "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>" : "",
  );
  let toUnicodeNum = 0;
  if (options.toUnicode !== undefined) {
    const cmapBytes = encoder.encode(options.toUnicode);
    const body = options.compress === true ? deflate(cmapBytes) : cmapBytes;
    const header = encoder.encode(
      `<</Length ${body.length}${options.compress === true ? " /Filter /FlateDecode" : ""}>>\nstream\n`,
    );
    const tail = encoder.encode("\nendstream");
    const joined = new Uint8Array(header.length + body.length + tail.length);
    joined.set(header, 0);
    joined.set(body, header.length);
    joined.set(tail, header.length + body.length);
    toUnicodeNum = add(joined);
    objects[fontNum - 1] = encoder.encode(
      `<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode ${toUnicodeNum} 0 R>>`,
    );
  }

  const pageNums: number[] = [];
  for (const page of options.pages) {
    const raw = encoder.encode(page.content);
    const body = options.compress === true ? deflate(raw) : raw;
    const declared = options.lieAboutLength === true ? body.length + 40 : body.length;
    const header = encoder.encode(
      `<</Length ${declared}${options.compress === true ? " /Filter /FlateDecode" : ""}>>\nstream\n`,
    );
    const tail = encoder.encode("\nendstream");
    const stream = new Uint8Array(header.length + body.length + tail.length);
    stream.set(header, 0);
    stream.set(body, header.length);
    stream.set(tail, header.length + body.length);
    const contentNum = add(stream);
    const box = page.mediaBox ?? [0, 0, 612, 792];
    const resources = page.withFont === false ? "<<>>" : `<</Font <</F1 ${fontNum} 0 R>>>>`;
    pageNums.push(
      add(
        `<</Type /Page /Parent 2 0 R /MediaBox [${box.join(" ")}] ${
          page.rotate === undefined ? "" : `/Rotate ${page.rotate} `
        }/Resources ${resources} /Contents ${contentNum} 0 R>>`,
      ),
    );
  }
  objects[0] = encoder.encode("<</Type /Catalog /Pages 2 0 R>>");
  objects[1] = encoder.encode(
    `<</Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length}>>`,
  );
  let infoNum = 0;
  if (options.title !== undefined) {
    infoNum = add(`<</Title (${options.title}) /Producer (fixture)>>`);
  }
  let encryptNum = 0;
  if (options.encrypted === true) {
    encryptNum = add("<</Filter /Standard /V 2 /R 3 /Length 128 /P -4>>");
  }

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const emit = (text: string | Uint8Array): void => {
    const bytes = typeof text === "string" ? encoder.encode(text) : text;
    chunks.push(bytes);
    offset += bytes.length;
  };
  emit("%PDF-1.4\n");
  const offsets: number[] = [];
  for (const [i, body] of objects.entries()) {
    offsets.push(offset);
    emit(`${i + 1} 0 obj\n`);
    emit(body);
    emit("\nendobj\n");
  }
  const xrefAt = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) xref += `${String(at).padStart(10, "0")} 00000 n \n`;
  emit(xref);
  emit(
    `trailer\n<</Size ${objects.length + 1} /Root 1 0 R${
      infoNum > 0 ? ` /Info ${infoNum} 0 R` : ""
    }${encryptNum > 0 ? ` /Encrypt ${encryptNum} 0 R` : ""}>>\nstartxref\n${xrefAt}\n%%EOF\n`,
  );
  const out = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The content stream of a page that says `text` at a readable size. */
export function textPageContent(lines: ReadonlyArray<string>): string {
  const escaped = lines.map((line) => line.replace(/\\/g, "\\\\").replace(/([()])/g, "\\$1"));
  const body = escaped
    .map((line, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${line}) Tj ET`)
    .join("\n");
  return `${body}\n`;
}
