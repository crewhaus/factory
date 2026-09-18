/**
 * WordprocessingML (.docx) — reading a document into structure, and writing
 * a minimal one.
 *
 * ## What reading produces
 *
 * A flat, ordered list of blocks: paragraphs (with their style id, resolved
 * style name, heading level and list membership) and tables (as rows of cell
 * text). That is the shape a caller actually wants — "what does this
 * document say, and how is it organised" — rather than a DOM.
 *
 * ## Supported on read
 *
 * - `word/document.xml` body content: `w:p` paragraphs and `w:tbl` tables,
 *   in document order, including tables nested in cells.
 * - Run content: `w:t` (honouring `xml:space="preserve"`), `w:tab` -> a tab,
 *   `w:br` and `w:cr` -> a newline, `w:noBreakHyphen` -> `-`, and the symbol
 *   run `w:sym` -> its character when it is in the normal Unicode range.
 *   Runs inside `w:hyperlink`, `w:ins` (tracked insertion) and `w:smartTag`
 *   are included; runs inside `w:del` (tracked deletion) are NOT, because
 *   the document as it reads is the accepted text.
 * - Heading level from `w:pPr/w:outlineLvl` when present, else from a style
 *   id or style name matching `Heading N` / `heading N` / `Title`.
 * - List membership from `w:pPr/w:numPr` (`w:numId`, `w:ilvl`), resolved
 *   through `word/numbering.xml` to `bullet` or `ordered` where that part
 *   exists.
 * - Style ids resolved to display names through `word/styles.xml`.
 * - Core and app properties via `docProps/`.
 *
 * ## Not supported on read — stated rather than faked
 *
 * - Headers, footers, footnotes, endnotes and comments are separate parts
 *   and are not merged into the body flow. `DocxRead` reports whether they
 *   exist so a caller is not misled about completeness.
 * - Field codes (`PAGE`, `TOC`, cross-references) yield their cached result
 *   text only; `w:instrText` itself is excluded.
 * - Text boxes, SmartArt, chart labels, and any text living in DrawingML is
 *   not extracted.
 * - Formatting (bold, colour, fonts, spacing) is discarded entirely.
 */
import { XML_DECL, assertSafePartNames, readCoreProperties, relationshipMap, utf8 } from "./ooxml";
import {
  type XmlElement,
  childNamed,
  descendants,
  escapeXml,
  isElement,
  parseXml,
  rootElement,
} from "./xml";
import { type ZipArchive, ZipError, type ZipInput, writeZip } from "./zip";

export type DocxParagraph = {
  readonly kind: "paragraph";
  readonly text: string;
  readonly styleId?: string;
  readonly styleName?: string;
  readonly headingLevel?: number;
  readonly list?: { readonly level: number; readonly numId: string; readonly format: string };
};

export type DocxTable = {
  readonly kind: "table";
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
};

export type DocxBlock = DocxParagraph | DocxTable;

export type DocxDocument = {
  readonly blocks: ReadonlyArray<DocxBlock>;
  readonly properties: Record<string, string>;
  /** Parts that exist but are not folded into `blocks`, so callers know. */
  readonly unreadParts: ReadonlyArray<string>;
};

const MAIN_DOCUMENT_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";

/** Locate the main document part through `_rels/.rels`, not by convention. */
export function mainDocumentPart(zip: ZipArchive): string {
  for (const rel of relationshipMap(zip, "").values()) {
    if (rel.type === MAIN_DOCUMENT_REL && !rel.external) return rel.target;
  }
  if (zip.has("word/document.xml")) return "word/document.xml";
  throw new ZipError("this package declares no main document part (is it really a .docx?)");
}

/** styleId -> display name, from `word/styles.xml`. */
function styleNames(zip: ZipArchive, stylesPart: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!zip.has(stylesPart)) return out;
  const root = rootElement(parseXml(zip.readText(stylesPart)));
  for (const style of descendants(root, "w:style")) {
    const id = style.attributes["w:styleId"];
    const name = childNamed(style, "w:name")?.attributes["w:val"];
    if (id !== undefined && name !== undefined) out.set(id, name);
  }
  return out;
}

/** numId -> numbering format at each level, from `word/numbering.xml`. */
function numberingFormats(zip: ZipArchive, part: string): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  if (!zip.has(part)) return out;
  const root = rootElement(parseXml(zip.readText(part)));
  const abstract = new Map<string, Map<number, string>>();
  for (const a of descendants(root, "w:abstractNum")) {
    const id = a.attributes["w:abstractNumId"];
    if (id === undefined) continue;
    const levels = new Map<number, string>();
    for (const lvl of descendants(a, "w:lvl")) {
      const ilvl = Number.parseInt(lvl.attributes["w:ilvl"] ?? "0", 10);
      const fmt = childNamed(lvl, "w:numFmt")?.attributes["w:val"];
      if (Number.isFinite(ilvl) && fmt !== undefined) levels.set(ilvl, fmt);
    }
    abstract.set(id, levels);
  }
  for (const num of descendants(root, "w:num")) {
    const numId = num.attributes["w:numId"];
    const abstractId = childNamed(num, "w:abstractNumId")?.attributes["w:val"];
    if (numId === undefined || abstractId === undefined) continue;
    const levels = abstract.get(abstractId);
    if (levels !== undefined) out.set(numId, levels);
  }
  return out;
}

function textContent(element: XmlElement): string {
  let out = "";
  for (const child of element.children) if (!isElement(child)) out += child.text;
  return out;
}

/**
 * The text of one run-bearing element. Walks children in order so a tab
 * between two `w:t` runs lands where the document puts it.
 */
function runText(element: XmlElement): string {
  let out = "";
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue;
      switch (child.name) {
        case "w:t":
          // `xml:space="preserve"` is the only thing that keeps a leading or
          // trailing space in a run; without it Word means the trimmed text.
          out +=
            child.attributes["xml:space"] === "preserve"
              ? textContent(child)
              : textContent(child).trim();
          break;
        case "w:tab":
          out += "\t";
          break;
        case "w:br":
        case "w:cr":
          out += "\n";
          break;
        case "w:noBreakHyphen":
          out += "-";
          break;
        case "w:sym": {
          const code = child.attributes["w:char"];
          if (code !== undefined) {
            const value = Number.parseInt(code, 16);
            // Symbol fonts map into the private use area (0xF0xx); there is
            // no faithful Unicode for those, so they are dropped.
            if (Number.isFinite(value) && value < 0xf000) out += String.fromCodePoint(value);
          }
          break;
        }
        case "w:del":
        case "w:instrText":
        case "w:delText":
          break; // tracked deletions and field codes are not body text
        default:
          walk(child);
      }
    }
  };
  walk(element);
  return out;
}

function headingLevelOf(
  paragraph: XmlElement,
  styleId: string | undefined,
  styleName: string | undefined,
): number | undefined {
  const pPr = childNamed(paragraph, "w:pPr");
  const outlineVal =
    pPr === undefined ? undefined : childNamed(pPr, "w:outlineLvl")?.attributes["w:val"];
  if (outlineVal !== undefined) {
    const level = Number.parseInt(outlineVal, 10);
    // outlineLvl is 0-based and 9 means "body text".
    if (Number.isFinite(level) && level >= 0 && level <= 8) return level + 1;
  }
  for (const candidate of [styleName, styleId]) {
    if (candidate === undefined) continue;
    const match = /^heading\s*([1-9])$/i.exec(candidate.trim());
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
    if (/^title$/i.test(candidate.trim())) return 1;
  }
  return undefined;
}

function parseParagraph(
  paragraph: XmlElement,
  styles: Map<string, string>,
  numbering: Map<string, Map<number, string>>,
): DocxParagraph {
  const pPr = childNamed(paragraph, "w:pPr");
  const styleId = pPr === undefined ? undefined : childNamed(pPr, "w:pStyle")?.attributes["w:val"];
  const styleName = styleId === undefined ? undefined : styles.get(styleId);
  const headingLevel = headingLevelOf(paragraph, styleId, styleName);
  const numPr = pPr === undefined ? undefined : childNamed(pPr, "w:numPr");
  let list: DocxParagraph["list"];
  if (numPr !== undefined) {
    const numId = childNamed(numPr, "w:numId")?.attributes["w:val"];
    const ilvl = Number.parseInt(childNamed(numPr, "w:ilvl")?.attributes["w:val"] ?? "0", 10);
    const level = Number.isFinite(ilvl) ? ilvl : 0;
    if (numId !== undefined) {
      const fmt = numbering.get(numId)?.get(level);
      list = {
        level,
        numId,
        format: fmt === undefined ? "unknown" : fmt === "bullet" ? "bullet" : "ordered",
      };
    }
  }
  const block: {
    kind: "paragraph";
    text: string;
    styleId?: string;
    styleName?: string;
    headingLevel?: number;
    list?: DocxParagraph["list"];
  } = { kind: "paragraph", text: runText(paragraph) };
  if (styleId !== undefined) block.styleId = styleId;
  if (styleName !== undefined) block.styleName = styleName;
  if (headingLevel !== undefined) block.headingLevel = headingLevel;
  if (list !== undefined) block.list = list;
  return block;
}

function parseTable(table: XmlElement): DocxTable {
  const rows: string[][] = [];
  for (const tr of table.children) {
    if (!isElement(tr) || tr.name !== "w:tr") continue;
    const cells: string[] = [];
    for (const tc of tr.children) {
      if (!isElement(tc) || tc.name !== "w:tc") continue;
      // A cell holds paragraphs (and possibly nested tables); joining the
      // paragraphs with a newline keeps a multi-paragraph cell readable.
      const parts: string[] = [];
      for (const child of tc.children) {
        if (!isElement(child)) continue;
        if (child.name === "w:p" || child.name === "w:tbl") parts.push(runText(child));
      }
      cells.push(parts.join("\n").trim());
    }
    rows.push(cells);
  }
  return { kind: "table", rows };
}

/** Read a .docx package into blocks and properties. */
export function readDocx(zip: ZipArchive): DocxDocument {
  assertSafePartNames(zip);
  const documentPart = mainDocumentPart(zip);
  const dir = documentPart.slice(0, documentPart.lastIndexOf("/") + 1);
  const styles = styleNames(zip, `${dir}styles.xml`);
  const numbering = numberingFormats(zip, `${dir}numbering.xml`);
  const root = rootElement(parseXml(zip.readText(documentPart)));
  const body = childNamed(root, "w:body");
  const blocks: DocxBlock[] = [];
  if (body !== undefined) {
    const walk = (parent: XmlElement): void => {
      for (const child of parent.children) {
        if (!isElement(child)) continue;
        if (child.name === "w:p") blocks.push(parseParagraph(child, styles, numbering));
        else if (child.name === "w:tbl") blocks.push(parseTable(child));
        // `w:sdt` (a content control) wraps real content one level down.
        else if (child.name === "w:sdt" || child.name === "w:sdtContent") walk(child);
      }
    };
    walk(body);
  }
  const unread = new Set<string>();
  for (const entry of zip.sortedNames()) {
    const base = entry.slice(entry.lastIndexOf("/") + 1);
    if (base === "footnotes.xml") unread.add("footnotes");
    else if (base === "endnotes.xml") unread.add("endnotes");
    else if (base === "comments.xml") unread.add("comments");
    else if (/^header\d*\.xml$/.test(base)) unread.add("headers");
    else if (/^footer\d*\.xml$/.test(base)) unread.add("footers");
  }
  return {
    blocks,
    properties: readCoreProperties(zip),
    unreadParts: [...unread].sort(),
  };
}

/** Plain text of a parsed document: one block per line, tables as TSV rows. */
export function docxPlainText(doc: DocxDocument): string {
  const lines: string[] = [];
  for (const block of doc.blocks) {
    if (block.kind === "paragraph") lines.push(block.text);
    else for (const row of block.rows) lines.push(row.join("\t"));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/**
 * A block of content to write. This is the whole vocabulary: `DocxWrite`
 * produces a MINIMAL VALID document, not a faithful re-render of an
 * arbitrary one. There is no styling, no images, no sections, no headers.
 */
export type DocxWriteBlock =
  | { readonly type: "heading"; readonly text: string; readonly level?: number }
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "list"; readonly items: ReadonlyArray<string>; readonly ordered?: boolean }
  | {
      readonly type: "table";
      readonly rows: ReadonlyArray<ReadonlyArray<string>>;
      readonly header?: boolean;
    };

export type DocxWriteOptions = {
  readonly title?: string;
  readonly creator?: string;
  /**
   * The ISO-8601 instant stamped into `docProps/core.xml`. Taken as an
   * INPUT, never from the clock, so the same content writes the same bytes.
   */
  readonly created?: string;
};

type ParagraphOptions = {
  readonly style?: string;
  readonly numId?: number;
  readonly level?: number;
  /** Direct run formatting, used for a table's header row. */
  readonly bold?: boolean;
};

function paragraphXml(text: string, options: ParagraphOptions = {}): string {
  const props: string[] = [];
  if (options.style !== undefined) props.push(`<w:pStyle w:val="${escapeXml(options.style)}"/>`);
  if (options.numId !== undefined) {
    props.push(
      `<w:numPr><w:ilvl w:val="${options.level ?? 0}"/><w:numId w:val="${options.numId}"/></w:numPr>`,
    );
  }
  const pPr = props.length > 0 ? `<w:pPr>${props.join("")}</w:pPr>` : "";
  const rPr = options.bold === true ? "<w:rPr><w:b/></w:rPr>" : "";
  // Split on newlines so an embedded line break becomes a real `w:br`.
  const runs = text
    .split("\n")
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join("<w:br/>");
  return `<w:p>${pPr}<w:r>${rPr}${runs}</w:r></w:p>`;
}

const BORDER_SIDES = ["top", "left", "bottom", "right", "insideH", "insideV"] as const;

function tableXml(rows: ReadonlyArray<ReadonlyArray<string>>, header: boolean): string {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return "";
  // 9360 twentieths of a point is the usable width of a US-Letter page with
  // one-inch margins; a fixed grid keeps the output predictable.
  const colWidth = Math.floor(9360 / width);
  const grid = Array.from({ length: width }, () => `<w:gridCol w:w="${colWidth}"/>`).join("");
  const borders = BORDER_SIDES.map(
    (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`,
  ).join("");
  const body = rows
    .map((row, rowIndex) => {
      const cells = Array.from({ length: width }, (_unused, i) => {
        const cellText = row[i] ?? "";
        const bold = header && rowIndex === 0;
        return `<w:tc><w:tcPr><w:tcW w:w="${colWidth}" w:type="dxa"/></w:tcPr>${paragraphXml(cellText, { bold })}</w:tc>`;
      }).join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function stylesXml(): string {
  const heading = (n: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${n - 1}"/><w:spacing w:before="${Math.max(120, 360 - n * 40)}" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="${Math.max(22, 40 - n * 4)}"/></w:rPr></w:style>`;
  const headings = [1, 2, 3, 4, 5, 6].map(heading).join("");
  return `${XML_DECL}<w:styles ${W_NS}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>${headings}</w:styles>`;
}

/**
 * Two abstract numberings — a bullet list and a decimal list — each with
 * three levels. Written unconditionally so a list block renders as a real
 * Word list rather than a paragraph that begins with a dash.
 */
function numberingXml(): string {
  const levels = (fmt: string, bullet: string): string =>
    [0, 1, 2]
      .map((i) => {
        const text = fmt === "bullet" ? bullet : `%${i + 1}.`;
        return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${escapeXml(text)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
      })
      .join("");
  return `${XML_DECL}<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels("bullet", "•")}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels("decimal", "")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
}

function corePropsXml(options: DocxWriteOptions): string {
  const field = (tag: string, value: string | undefined, attrs = ""): string =>
    value === undefined || value === "" ? "" : `<${tag}${attrs}>${escapeXml(value)}</${tag}>`;
  const stamp = options.created;
  const dateAttr = ' xsi:type="dcterms:W3CDTF"';
  return `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${field("dc:title", options.title)}${field("dc:creator", options.creator)}${field("cp:lastModifiedBy", options.creator)}${field("dcterms:created", stamp, dateAttr)}${field("dcterms:modified", stamp, dateAttr)}</cp:coreProperties>`;
}

/** Build a .docx. The bytes are a pure function of the arguments. */
export function writeDocx(
  blocks: ReadonlyArray<DocxWriteBlock>,
  options: DocxWriteOptions = {},
): Uint8Array {
  const body: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading": {
        const level = Math.min(6, Math.max(1, block.level ?? 1));
        body.push(paragraphXml(block.text, { style: `Heading${level}` }));
        break;
      }
      case "paragraph":
        body.push(paragraphXml(block.text));
        break;
      case "list":
        for (const item of block.items) {
          body.push(
            paragraphXml(item, {
              style: "ListParagraph",
              numId: block.ordered === true ? 2 : 1,
            }),
          );
        }
        break;
      case "table":
        body.push(tableXml(block.rows, block.header === true));
        break;
    }
  }
  // A section-properties block is required for a document Word will open.
  const sectPr =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  const documentXml = `${XML_DECL}<w:document ${W_NS}><w:body>${body.join("")}${sectPr}</w:body></w:document>`;

  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${MAIN_DOCUMENT_REL}" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const docRels = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;

  const parts: ZipInput[] = [
    { name: "[Content_Types].xml", data: utf8(contentTypes) },
    { name: "_rels/.rels", data: utf8(rootRels) },
    { name: "word/document.xml", data: utf8(documentXml) },
    { name: "word/_rels/document.xml.rels", data: utf8(docRels) },
    { name: "word/styles.xml", data: utf8(stylesXml()) },
    { name: "word/numbering.xml", data: utf8(numberingXml()) },
    { name: "docProps/core.xml", data: utf8(corePropsXml(options)) },
  ];
  return writeZip(parts);
}
