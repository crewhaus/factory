/**
 * @crewhaus/tool-docs — deterministic document tools.
 *
 * Office documents, PDFs, mail and calendars: the formats a harness is handed
 * and cannot read without either a model turn or a dependency. Everything
 * here is hand-written against the published format, with the supported
 * subset stated in each module and each tool refusing loudly rather than
 * returning a confidently wrong answer.
 *
 * Four properties hold across the package:
 *
 *   1. CONTAINMENT. Every caller-supplied path goes through `resolveSafe`,
 *      which refuses anything resolving outside `process.cwd()`, including
 *      via a symlink inside the workspace. An OOXML package whose member
 *      names would escape their container is refused whole.
 *   2. BOUNDED MEMORY. A file's size is checked before it is read, and every
 *      decompression is capped DURING the inflate (`maxOutputLength`), not
 *      after it — so a 200 KB zip bomb costs 200 KB, not 200 MB.
 *   3. DETERMINISM. Same bytes in, same bytes out. Listings are sorted with
 *      plain string comparison, nothing samples a random source, and every
 *      tool that needs a timestamp takes it as an INPUT.
 *   4. NO NETWORK, NO SUBPROCESS. Every tool is `scope: "internal"` with no
 *      `ioCapability`: these read and write local files and nothing else.
 *      The XML reader has no entity resolver, so a document cannot make this
 *      package fetch anything.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { diffLines, diffStats, normalizeLine, renderUnified, wordCounts } from "./lib/diff";
import { type DocxWriteBlock, docxPlainText, readDocx, writeDocx } from "./lib/docx";
import {
  CalendarError,
  type CalendarEvent,
  type EventInput,
  parseComponents,
  readEvents,
  readVcards,
  writeCalendar,
} from "./lib/ical";
import {
  MailError,
  type ParsedMessage,
  messagePlainText,
  parseMessage,
  splitMbox,
  stripHtml,
} from "./lib/mail";
import { DEFAULT_PDF_LIMITS, PdfError, parsePdf } from "./lib/pdf";
import { extractDocumentText } from "./lib/pdf-text";
import { assertHasPages, buildPdf, parsePageRange } from "./lib/pdf-write";
import { pptxPlainText, readPptx } from "./lib/pptx";
import { type CellValue, readXlsx, writeXlsx } from "./lib/xlsx";
import { XmlError } from "./lib/xml";
import { DEFAULT_ZIP_LIMITS, ZipArchive, ZipError, type ZipLimits } from "./lib/zip";
import { type SafePath, ToolPermissionError, resolveSafe } from "./paths";

/** Compact JSON — the reader is a model, and every byte returned is context. */
const json = (value: unknown): string => JSON.stringify(value);

/** Largest file any tool here will read into memory. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Default ceiling on returned text, so one call cannot fill a context window. */
const DEFAULT_MAX_CHARS = 200_000;

const LATIN1 = new TextDecoder("latin1" as ConstructorParameters<typeof TextDecoder>[0]);
const UTF8 = new TextDecoder("utf-8");

/**
 * Read a file after checking its size, so an enormous file is refused rather
 * than read and then rejected. The `stat` is on the RESOLVED path, which is
 * the same path the read uses.
 */
function readFileCapped(
  toolName: string,
  rel: string,
  maxBytes = MAX_FILE_BYTES,
): { path: SafePath; bytes: Uint8Array } {
  const path = resolveSafe(toolName, rel);
  const stats = statSync(path.real);
  if (stats.isDirectory()) throw new ToolInputError(`"${rel}" is a directory, not a file`);
  if (stats.size > maxBytes) {
    throw new ToolInputError(
      `"${rel}" is ${stats.size} bytes, over the ${maxBytes} limit for this tool`,
    );
  }
  return { path, bytes: new Uint8Array(readFileSync(path.real)) };
}

/** Write bytes to a contained path, refusing to clobber unless told to. */
function writeFileSafe(
  toolName: string,
  rel: string,
  data: Uint8Array | string,
  overwrite: boolean,
): SafePath {
  const path = resolveSafe(toolName, rel);
  if (!overwrite) {
    try {
      statSync(path.real);
      throw new ToolInputError(`"${rel}" already exists; pass overwrite to replace it`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  writeFileSync(path.real, data);
  return path;
}

/**
 * A caller mistake this package states in its own words: the wrong argument
 * combination, a file that is too big, a destination that already exists.
 * Distinct from a plain `Error` so that `explain` can tell a message written
 * FOR the caller apart from a bug's message, which was written for nobody.
 */
class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

/**
 * Turn an expected failure into a readable sentence. A caller mistake (a
 * malformed file, a path outside the workspace, a format this package does
 * not read) is an ANSWER, not a crash: the model gets told what went wrong
 * and can act on it.
 *
 * Anything NOT in that list is a bug in this package, and returning its
 * message would hand the caller `undefined is not an object` in the place
 * where a document's text belongs — indistinguishable from content. Those
 * are rethrown, which is how every other tool package here behaves.
 */
function explain(err: unknown): string | null {
  if (
    err instanceof ZipError ||
    err instanceof XmlError ||
    err instanceof PdfError ||
    err instanceof CalendarError ||
    err instanceof MailError ||
    err instanceof ToolPermissionError ||
    err instanceof ToolInputError
  ) {
    return err.message;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return `no such file: ${(err as NodeJS.ErrnoException).path ?? ""}`;
  if (code === "EACCES") return `permission denied: ${(err as NodeJS.ErrnoException).path ?? ""}`;
  if (code === "EISDIR") return "that path is a directory, not a file";
  if (code === "EPERM" || code === "EROFS") {
    return `cannot write there: ${(err as NodeJS.ErrnoException).path ?? ""}`;
  }
  return null;
}

/** Run a tool body, converting the expected failures into a readable string. */
async function attempt(body: () => string | Promise<string>): Promise<string> {
  try {
    return await body();
  } catch (err) {
    const message = explain(err);
    if (message === null) throw err;
    return message;
  }
}

function zipLimits(): ZipLimits {
  return DEFAULT_ZIP_LIMITS;
}

function openPackage(toolName: string, rel: string): { path: SafePath; zip: ZipArchive } {
  const { path, bytes } = readFileCapped(toolName, rel);
  return { path, zip: ZipArchive.open(bytes, zipLimits()) };
}

/** The formats `DocumentText` and `DocumentDiff` can dispatch on. */
export type DocumentKind =
  | "docx"
  | "xlsx"
  | "pptx"
  | "pdf"
  | "eml"
  | "mbox"
  | "ics"
  | "vcf"
  | "html"
  | "text";

/**
 * Identify a file by its MAGIC BYTES first and its extension second. A
 * `.docx` that is really a PDF is a real thing (people rename files), and
 * believing the extension would produce a confusing error from the wrong
 * reader.
 */
export function detectKind(name: string, bytes: Uint8Array): DocumentKind | null {
  const lower = name.toLowerCase();
  const head = LATIN1.decode(bytes.subarray(0, 512));
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
    return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // An OOXML package is a zip; which one it is depends on its parts.
    try {
      const zip = ZipArchive.open(bytes, zipLimits());
      const names = zip.sortedNames();
      if (names.some((n) => n.startsWith("word/"))) return "docx";
      if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
      if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
    } catch {
      return null;
    }
    return null;
  }
  if (/^BEGIN:VCALENDAR/im.test(head)) return "ics";
  if (/^BEGIN:VCARD/im.test(head)) return "vcf";
  if (/^From \S+/m.test(head) && lower.endsWith(".mbox")) return "mbox";
  if (/^(from|to|subject|date|message-id|received):/im.test(head)) return "eml";
  if (lower.endsWith(".mbox")) return "mbox";
  if (lower.endsWith(".eml")) return "eml";
  if (lower.endsWith(".ics")) return "ics";
  if (lower.endsWith(".vcf") || lower.endsWith(".vcard")) return "vcf";
  if (
    lower.endsWith(".html") ||
    lower.endsWith(".htm") ||
    /^\s*<(!doctype html|html)/i.test(head)
  ) {
    return "html";
  }
  // Anything that decodes as text is text; anything else is not ours.
  for (const byte of bytes.subarray(0, 4096)) {
    if (byte === 0) return null;
  }
  return "text";
}

const MAIL_PARSE_DEFAULTS = { maxParts: 200, maxDepth: 12 };

/** Extract plain text from any supported file. Shared by the two entry points. */
function documentText(
  toolName: string,
  rel: string,
  maxChars: number,
  pageRange?: string,
): { kind: DocumentKind; text: string; notes: string[]; truncated: boolean } {
  const { path, bytes } = readFileCapped(toolName, rel);
  const kind = detectKind(path.rel, bytes);
  if (kind === null) {
    throw new ToolInputError(
      `"${rel}" is not a format this tool reads (it is neither a PDF, an Office package, mail, a calendar, nor text)`,
    );
  }
  const notes: string[] = [];
  // Whether what comes back is the WHOLE document. A caller comparing two
  // truncated extractions and reading "identical" would be told something
  // that was never checked.
  let truncated = false;
  let text: string;
  switch (kind) {
    case "docx":
      text = docxPlainText(readDocx(ZipArchive.open(bytes, zipLimits())));
      break;
    case "pptx":
      text = pptxPlainText(readPptx(ZipArchive.open(bytes, zipLimits()), false));
      break;
    case "xlsx": {
      const workbook = readXlsx(ZipArchive.open(bytes, zipLimits()), {
        maxRowsPerSheet: 100_000,
        maxColumns: 1024,
      });
      text = workbook.sheets
        .map(
          (sheet) =>
            `# ${sheet.name}\n${sheet.rows
              .map((row) => row.map((cell) => (cell === null ? "" : String(cell))).join("\t"))
              .join("\n")}`,
        )
        .join("\n\n");
      break;
    }
    case "pdf": {
      const doc = parsePdf(bytes, DEFAULT_PDF_LIMITS);
      if (doc.encrypted) {
        throw new PdfError("this pdf is encrypted; its text cannot be read without the password");
      }
      const pageCount = doc.pages().length;
      const selection =
        pageRange === undefined
          ? Array.from({ length: pageCount }, (_unused, i) => i + 1)
          : parsePageRange(pageRange, pageCount);
      const extracted = extractDocumentText(doc, selection, maxChars);
      notes.push(...extracted.notes);
      if (extracted.truncated) {
        truncated = true;
        notes.push(
          `text truncated at ${maxChars} characters, after ${extracted.pages.length} of ${selection.length} selected pages`,
        );
      }
      if (extracted.pages.every((page) => !page.hasTextLayer)) {
        notes.push(
          "no page in this pdf has a text layer; it is most likely a scan, and extracting its text needs OCR, which this package does not do",
        );
      }
      text = extracted.pages.map((page) => page.text).join("\n\n");
      break;
    }
    case "eml": {
      const message = parseMessage(LATIN1.decode(bytes), {
        includeBodies: true,
        maxBodyChars: maxChars,
        ...MAIL_PARSE_DEFAULTS,
      });
      notes.push(...message.notes);
      text = `Subject: ${message.subject ?? "(none)"}\n\n${messagePlainText(message)}`;
      break;
    }
    case "mbox": {
      // Mail is bytes: Latin-1 round-trips every one of them, and each part's
      // real charset is applied once its own headers say what it is.
      const messages = splitMbox(LATIN1.decode(bytes), 1000);
      if (messages.length === 1000) {
        truncated = true;
        notes.push("stopped after 1000 messages; this mbox holds more");
      }
      text = messages
        .map((entry) => {
          const parsed = parseMessage(entry.raw, {
            includeBodies: true,
            maxBodyChars: 20_000,
            ...MAIL_PARSE_DEFAULTS,
          });
          return `--- message ${entry.index}: ${parsed.subject ?? "(no subject)"}\n${messagePlainText(parsed)}`;
        })
        .join("\n\n");
      break;
    }
    case "ics": {
      const { events } = readEvents(parseComponents(UTF8.decode(bytes), 12, 500_000));
      text = events
        .map((event) =>
          [
            event.summary ?? "(no summary)",
            event.start?.raw === undefined ? "" : `  start: ${event.start.raw}`,
            event.end?.raw === undefined ? "" : `  end:   ${event.end.raw}`,
            event.location === undefined ? "" : `  at:    ${event.location}`,
            event.description === undefined ? "" : `  ${event.description}`,
          ]
            .filter((line) => line !== "")
            .join("\n"),
        )
        .join("\n\n");
      break;
    }
    case "vcf": {
      const cards = readVcards(parseComponents(UTF8.decode(bytes), 12, 500_000));
      text = cards
        .map((card) =>
          [
            card.formattedName ?? "(no name)",
            ...card.emails.map((email) => `  ${email.value}`),
            ...card.phones.map((phone) => `  ${phone.value}`),
          ].join("\n"),
        )
        .join("\n\n");
      break;
    }
    case "html":
      text = stripHtml(UTF8.decode(bytes));
      break;
    default:
      text = UTF8.decode(bytes);
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
    notes.push(`text truncated at ${maxChars} characters`);
  }
  return { kind, text, notes, truncated };
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

export const docxRead: RegisteredTool = buildTool({
  name: "DocxRead",
  description:
    "Read a .docx into structured blocks: paragraphs with their style and heading level, lists, tables, and the document's core properties. Use to get at what a Word document actually says without opening Word or converting it first.",
  inputSchema: z.object({
    path: z.string().min(1).describe("path to a .docx file, inside the workspace"),
    asText: z
      .boolean()
      .optional()
      .describe("return plain text instead of blocks (tables become tab-separated rows)"),
    includeProperties: z.boolean().optional().describe("include core document properties"),
    maxBlocks: z.number().int().positive().max(100_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { zip } = openPackage("DocxRead", input.path);
      const doc = readDocx(zip);
      if (input.asText === true) return docxPlainText(doc);
      const maxBlocks = input.maxBlocks ?? 5000;
      const blocks = doc.blocks.slice(0, maxBlocks);
      return json({
        blockCount: doc.blocks.length,
        truncated: doc.blocks.length > blocks.length,
        ...(input.includeProperties === false ? {} : { properties: doc.properties }),
        notReadParts: doc.unreadParts,
        blocks,
      });
    }),
});

const docxBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    text: z.string(),
    level: z.number().int().min(1).max(6).optional(),
  }),
  z.object({ type: z.literal("paragraph"), text: z.string() }),
  z.object({
    type: z.literal("list"),
    items: z.array(z.string()).min(1),
    ordered: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("table"),
    rows: z.array(z.array(z.string())).min(1),
    header: z.boolean().optional(),
  }),
]);

export const docxWrite: RegisteredTool = buildTool({
  name: "DocxWrite",
  operativeArgs: [{ field: "path", kind: "path" }],
  description:
    "Write a .docx from structured content: headings, paragraphs, bullet or numbered lists, and tables. Use to hand somebody a real Word file; it produces a MINIMAL valid document with plain styling, not a re-render of an existing one.",
  inputSchema: z.object({
    path: z.string().min(1).describe("where to write the .docx, inside the workspace"),
    blocks: z.array(docxBlockSchema).min(1),
    title: z.string().optional(),
    creator: z.string().optional(),
    created: z
      .string()
      .optional()
      .describe("ISO-8601 instant stamped into the document; omit for no timestamp"),
    overwrite: z.boolean().optional(),
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const options: { title?: string; creator?: string; created?: string } = {};
      if (input.title !== undefined) options.title = input.title;
      if (input.creator !== undefined) options.creator = input.creator;
      if (input.created !== undefined) options.created = input.created;
      const bytes = writeDocx(input.blocks as DocxWriteBlock[], options);
      const path = writeFileSafe("DocxWrite", input.path, bytes, input.overwrite === true);
      return json({ path: path.rel, bytes: bytes.length, blocks: input.blocks.length });
    }),
});

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export const xlsxRead: RegisteredTool = buildTool({
  name: "XlsxRead",
  description:
    "Read a .xlsx into rows per sheet, with shared strings resolved, cell types honoured and date serials converted to ISO-8601. Use to get a spreadsheet's values; formulas are reported as their cached value with the formula text alongside, never evaluated.",
  inputSchema: z.object({
    path: z.string().min(1).describe("path to a .xlsx file, inside the workspace"),
    sheets: z
      .array(z.string())
      .optional()
      .describe("sheet names to read; all of them when omitted"),
    maxRows: z.number().int().positive().max(1_000_000).optional(),
    maxColumns: z.number().int().positive().max(16_384).optional(),
    includeFormulas: z.boolean().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { zip } = openPackage("XlsxRead", input.path);
      const options: {
        sheetNames?: string[];
        maxRowsPerSheet: number;
        maxColumns: number;
      } = {
        maxRowsPerSheet: input.maxRows ?? 5000,
        maxColumns: input.maxColumns ?? 512,
      };
      if (input.sheets !== undefined) options.sheetNames = input.sheets;
      const workbook = readXlsx(zip, options);
      return json({
        dateSystem: workbook.date1904 ? "1904" : "1900",
        properties: workbook.properties,
        sheets: workbook.sheets.map((sheet) => ({
          name: sheet.name,
          rowCount: sheet.rows.length,
          truncated: sheet.truncated,
          rows: sheet.rows,
          ...(input.includeFormulas === false || sheet.formulas.length === 0
            ? {}
            : { formulas: sheet.formulas }),
        })),
      });
    }),
});

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const xlsxWrite: RegisteredTool = buildTool({
  name: "XlsxWrite",
  operativeArgs: [{ field: "path", kind: "path" }],
  description:
    "Write a .xlsx from rows, with numbers, booleans and strings kept as their own cell types and an optional bold header row. Use to produce a spreadsheet somebody can open; ISO-8601 strings become real date cells only for the columns you name, never by guessing.",
  inputSchema: z.object({
    path: z.string().min(1).describe("where to write the .xlsx, inside the workspace"),
    sheets: z
      .array(
        z.object({
          name: z.string().min(1).max(31),
          rows: z.array(z.array(cellSchema)),
          header: z.boolean().optional().describe("render the first row bold"),
          dateColumns: z
            .array(z.number().int().min(0))
            .optional()
            .describe("zero-based columns whose ISO-8601 strings become date cells"),
        }),
      )
      .min(1),
    overwrite: z.boolean().optional(),
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const bytes = writeXlsx(
        input.sheets.map((sheet) => {
          const out: {
            name: string;
            rows: CellValue[][];
            header?: boolean;
            dateColumns?: number[];
          } = { name: sheet.name, rows: sheet.rows as CellValue[][] };
          if (sheet.header !== undefined) out.header = sheet.header;
          if (sheet.dateColumns !== undefined) out.dateColumns = sheet.dateColumns;
          return out;
        }),
      );
      const path = writeFileSafe("XlsxWrite", input.path, bytes, input.overwrite === true);
      return json({
        path: path.rel,
        bytes: bytes.length,
        sheets: input.sheets.map((sheet) => ({ name: sheet.name, rows: sheet.rows.length })),
      });
    }),
});

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

export const pptxRead: RegisteredTool = buildTool({
  name: "PptxRead",
  description:
    "Read a .pptx into slides, each with its title and the text of every shape, in presentation order. Use to find what a deck says without opening it; speaker notes are included on request.",
  inputSchema: z.object({
    path: z.string().min(1).describe("path to a .pptx file, inside the workspace"),
    includeNotes: z.boolean().optional(),
    asText: z.boolean().optional().describe("return plain text instead of per-slide structure"),
    maxSlides: z.number().int().positive().max(5000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { zip } = openPackage("PptxRead", input.path);
      const all = readPptx(zip, input.includeNotes === true);
      const slides = all.slice(0, input.maxSlides ?? 500);
      if (input.asText === true) return pptxPlainText(slides);
      return json({
        slideCount: all.length,
        truncated: all.length > slides.length,
        slides: slides.map((slide) => ({
          index: slide.index,
          title: slide.title,
          shapes: slide.shapes,
          ...(slide.notes === undefined ? {} : { notes: slide.notes }),
        })),
      });
    }),
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export const pdfInfo: RegisteredTool = buildTool({
  name: "PdfInfo",
  description:
    "Report a PDF's page count, page sizes, metadata, whether it is encrypted, and whether each page carries a text layer. Use before anything else, to find out whether a PDF's text can be read at all or whether it is a scan that would need OCR.",
  inputSchema: z.object({
    path: z.string().min(1).describe("path to a .pdf file, inside the workspace"),
    perPage: z
      .boolean()
      .optional()
      .describe("include a row per page; on by default under 200 pages"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { bytes } = readFileCapped("PdfInfo", input.path);
      const doc = parsePdf(bytes, DEFAULT_PDF_LIMITS);
      const pages = doc.pages();
      if (doc.encrypted) {
        return json({
          version: doc.version,
          encrypted: true,
          pageCount: pages.length,
          note: "this pdf is encrypted; nothing here decrypts it, so its text and metadata cannot be read",
        });
      }
      const perPage = input.perPage ?? pages.length <= 200;
      // Deciding whether a page has a text layer means extracting its text,
      // so a very long document is probed only at its head — and says so,
      // rather than reporting a count that covers less than it appears to.
      const probeLimit = 500;
      const probed = pages.slice(0, probeLimit);
      const probeFailures: string[] = [];
      const rows = probed.map((page) => {
        const [x0, y0, x1, y1] = page.mediaBox;
        const width = Math.abs(x1 - x0);
        const height = Math.abs(y1 - y0);
        // `hasTextLayer: null` is not `false`. A page whose content stream
        // could not be decoded has not been shown to be a scan, and reporting
        // it as "no text layer" would send the caller to OCR over what is
        // really an unsupported filter.
        let hasTextLayer: boolean | null;
        try {
          hasTextLayer =
            extractDocumentText(doc, [page.index], 4000).pages[0]?.hasTextLayer ?? false;
        } catch (err) {
          hasTextLayer = null;
          probeFailures.push(`page ${page.index}: ${(err as Error).message}`);
        }
        return {
          page: page.index,
          // Points, the PDF's own unit: 72 to the inch.
          widthPt: Math.round(width * 100) / 100,
          heightPt: Math.round(height * 100) / 100,
          rotate: page.rotate,
          hasTextLayer,
        };
      });
      const withText = rows.filter((row) => row.hasTextLayer === true).length;
      const undetermined = rows.filter((row) => row.hasTextLayer === null).length;
      return json({
        version: doc.version,
        encrypted: false,
        pageCount: pages.length,
        pagesWithTextLayer: withText,
        ...(pages.length > probed.length
          ? { textLayerProbedPages: probed.length, pagesNotProbed: pages.length - probed.length }
          : {}),
        ...(undetermined > 0
          ? {
              pagesNotDetermined: undetermined,
              probeFailures: probeFailures.slice(0, 20),
            }
          : {}),
        textLayer:
          withText === 0 && undetermined === 0
            ? "none — this is most likely a scan, and reading it would need OCR, which this package does not do"
            : withText === rows.length
              ? "every page"
              : `${withText} of ${rows.length} pages${
                  undetermined > 0
                    ? `, with ${undetermined} that could not be checked — those are NOT known to be scans`
                    : ""
                }`,
        metadata: doc.info(),
        ...(perPage ? { pages: rows } : {}),
      });
    }),
});

export const pdfText: RegisteredTool = buildTool({
  name: "PdfText",
  description:
    "Extract the text of a PDF, page by page, reconstructing line and word breaks from the glyph positions. Use to read a PDF's contents; it handles uncompressed and Flate content streams and simple font encodings, and says plainly when a page has no text layer instead of returning nothing.",
  inputSchema: z.object({
    path: z.string().min(1).describe("path to a .pdf file, inside the workspace"),
    pages: z
      .string()
      .optional()
      .describe("page range such as '1-3,7,10-'; every page when omitted"),
    perPage: z.boolean().optional().describe("return text keyed by page instead of one string"),
    maxChars: z.number().int().positive().max(2_000_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const { bytes } = readFileCapped("PdfText", input.path);
      const doc = parsePdf(bytes, DEFAULT_PDF_LIMITS);
      if (doc.encrypted) {
        return "this pdf is encrypted; nothing here decrypts it, so its text cannot be extracted";
      }
      const pageCount = doc.pages().length;
      if (pageCount === 0) return "this pdf has no readable page objects";
      const selection =
        input.pages === undefined
          ? Array.from({ length: pageCount }, (_unused, i) => i + 1)
          : parsePageRange(input.pages, pageCount);
      const result = extractDocumentText(doc, selection, input.maxChars ?? DEFAULT_MAX_CHARS);
      const withoutText = result.pages.filter((page) => !page.hasTextLayer).map((p) => p.page);
      const notes = [...result.notes];
      if (withoutText.length === result.pages.length) {
        notes.push(
          "no selected page has a text layer; this pdf is most likely a scan and would need OCR, which this package does not do",
        );
      } else if (withoutText.length > 0) {
        notes.push(`pages with no text layer: ${withoutText.join(", ")}`);
      }
      if (input.perPage === true) {
        return json({ truncated: result.truncated, notes, pages: result.pages });
      }
      const text = result.pages.map((page) => page.text).join("\n\n");
      if (notes.length === 0 && !result.truncated) return text;
      return json({ truncated: result.truncated, notes, text });
    }),
});

export const pdfSplit: RegisteredTool = buildTool({
  name: "PdfSplit",
  operativeArgs: [
    { field: "path", kind: "path" },
    { field: "output", kind: "path" },
  ],
  description:
    "Write a new PDF containing only the pages you select from an existing one. Use to pull a chapter or an exhibit out of a large PDF; the page tree is rebuilt from scratch, so the output is well-formed even when the input's cross-reference table was not.",
  inputSchema: z.object({
    path: z.string().min(1).describe("path to the source .pdf, inside the workspace"),
    pages: z.string().min(1).describe("page range such as '1-3,7,10-'"),
    output: z.string().min(1).describe("where to write the new .pdf, inside the workspace"),
    overwrite: z.boolean().optional(),
    date: z
      .string()
      .optional()
      .describe("PDF date string for the output's /CreationDate, e.g. D:20240115120000Z"),
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const { bytes } = readFileCapped("PdfSplit", input.path);
      const doc = parsePdf(bytes, DEFAULT_PDF_LIMITS);
      if (doc.encrypted) {
        return "this pdf is encrypted; refusing to split it rather than writing a broken file";
      }
      assertHasPages(doc);
      const selection = parsePageRange(input.pages, doc.pages().length);
      const options: { date?: string } = {};
      if (input.date !== undefined) options.date = input.date;
      const out = buildPdf([{ doc, pages: selection }], options);
      const path = writeFileSafe("PdfSplit", input.output, out, input.overwrite === true);
      return json({
        path: path.rel,
        pages: selection.length,
        bytes: out.length,
        dropped: "annotations, bookmarks, form fields and the structure tree",
      });
    }),
});

export const pdfMerge: RegisteredTool = buildTool({
  name: "PdfMerge",
  operativeArgs: [
    { field: "inputs.path", kind: "path" },
    { field: "output", kind: "path" },
  ],
  description:
    "Concatenate several PDFs, or selected pages of them, into one new file. Use to assemble an exhibit set or a combined report; each source's page objects are copied into a freshly built page tree, and annotations and bookmarks are dropped rather than left pointing at pages that are no longer there.",
  inputSchema: z.object({
    inputs: z
      .array(
        z.object({
          path: z.string().min(1),
          pages: z.string().optional().describe("page range; the whole file when omitted"),
        }),
      )
      .min(1),
    output: z.string().min(1).describe("where to write the merged .pdf, inside the workspace"),
    overwrite: z.boolean().optional(),
    date: z.string().optional().describe("PDF date string for the output's /CreationDate"),
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const selections = input.inputs.map((source) => {
        const { bytes } = readFileCapped("PdfMerge", source.path);
        const doc = parsePdf(bytes, DEFAULT_PDF_LIMITS);
        if (doc.encrypted) {
          throw new PdfError(`"${source.path}" is encrypted; refusing to merge it`);
        }
        assertHasPages(doc);
        const count = doc.pages().length;
        return {
          doc,
          pages:
            source.pages === undefined
              ? Array.from({ length: count }, (_unused, i) => i + 1)
              : parsePageRange(source.pages, count),
        };
      });
      const options: { date?: string } = {};
      if (input.date !== undefined) options.date = input.date;
      const out = buildPdf(selections, options);
      const path = writeFileSafe("PdfMerge", input.output, out, input.overwrite === true);
      return json({
        path: path.rel,
        pages: selections.reduce((total, s) => total + s.pages.length, 0),
        sources: selections.length,
        bytes: out.length,
        dropped: "annotations, bookmarks, form fields and the structure tree",
      });
    }),
});

// ---------------------------------------------------------------------------
// mail
// ---------------------------------------------------------------------------

function loadMailSource(
  toolName: string,
  path: string | undefined,
  content: string | undefined,
): string {
  if (path !== undefined && content !== undefined) {
    throw new ToolInputError("pass either path or content, not both");
  }
  if (content !== undefined) return content;
  if (path === undefined) throw new ToolInputError("pass either path or content");
  // Mail is bytes, not text: Latin-1 round-trips every byte, and the real
  // charset is applied per part once the headers say what it is.
  return LATIN1.decode(readFileCapped(toolName, path).bytes);
}

function summarizeMessage(message: ParsedMessage, includeBodies: boolean): unknown {
  const attachments = message.parts.filter((part) => part.isAttachment);
  return {
    ...(message.subject === undefined ? {} : { subject: message.subject }),
    ...(message.date === undefined ? {} : { date: message.date }),
    ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
    from: message.from,
    ...(message.to.length > 0 ? { to: message.to } : {}),
    ...(message.cc.length > 0 ? { cc: message.cc } : {}),
    ...(message.bcc.length > 0 ? { bcc: message.bcc } : {}),
    parts: message.parts.map((part) => ({
      contentType: part.contentType,
      encoding: part.encoding,
      size: part.size,
      isAttachment: part.isAttachment,
      ...(part.filename === undefined ? {} : { filename: part.filename }),
      ...(part.charset === undefined ? {} : { charset: part.charset }),
      ...(part.contentId === undefined ? {} : { contentId: part.contentId }),
      ...(includeBodies && part.text !== undefined ? { text: part.text } : {}),
    })),
    attachmentCount: attachments.length,
    ...(message.notes.length > 0 ? { notes: message.notes } : {}),
  };
}

export const emlParse: RegisteredTool = buildTool({
  name: "EmlParse",
  description:
    "Parse an RFC 5322 message into headers, addresses, subject, date, body parts and attachment metadata. Use to read a .eml file: encoded-word subjects are decoded, multipart bodies are walked, and quoted-printable and base64 parts are decoded, but attachment bytes are never returned.",
  inputSchema: z.object({
    path: z.string().min(1).optional().describe("path to a .eml file, inside the workspace"),
    content: z.string().optional().describe("the raw message, instead of a path"),
    includeBodies: z.boolean().optional().describe("include decoded text of text parts"),
    asText: z.boolean().optional().describe("return just the message's plain text"),
    allHeaders: z.boolean().optional().describe("include every header, not just the common ones"),
    maxBodyChars: z.number().int().positive().max(1_000_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const raw = loadMailSource("EmlParse", input.path, input.content);
      const includeBodies = input.includeBodies ?? input.asText === true;
      const message = parseMessage(raw, {
        includeBodies,
        maxBodyChars: input.maxBodyChars ?? DEFAULT_MAX_CHARS,
        ...MAIL_PARSE_DEFAULTS,
      });
      if (input.asText === true) return messagePlainText(message);
      const summary = summarizeMessage(message, includeBodies) as Record<string, unknown>;
      if (input.allHeaders === true) summary["headers"] = message.headers;
      return json(summary);
    }),
});

export const mboxSplit: RegisteredTool = buildTool({
  name: "MboxSplit",
  description:
    "Split an mbox file into its messages and list them with subject, sender, date and byte range. Use to find the message you want in an archive; pass extract to get one message's raw text back, without writing anything to disk.",
  inputSchema: z.object({
    path: z.string().min(1).describe("path to an mbox file, inside the workspace"),
    maxMessages: z.number().int().positive().max(100_000).optional(),
    extract: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("return this message's raw text (1-based) instead of the listing"),
    maxChars: z.number().int().positive().max(2_000_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const raw = LATIN1.decode(readFileCapped("MboxSplit", input.path).bytes);
      const messages = splitMbox(raw, input.maxMessages ?? 5000);
      if (messages.length === 0) {
        return "no messages found: an mbox message begins with a 'From ' line at the start of a line";
      }
      if (input.extract !== undefined) {
        const message = messages[input.extract - 1];
        if (message === undefined) {
          return `message ${input.extract} does not exist (this mbox has ${messages.length})`;
        }
        const limit = input.maxChars ?? DEFAULT_MAX_CHARS;
        return message.raw.length > limit ? message.raw.slice(0, limit) : message.raw;
      }
      return json({
        messageCount: messages.length,
        messages: messages.map((entry) => {
          const parsed = parseMessage(entry.raw, {
            includeBodies: false,
            maxBodyChars: 0,
            ...MAIL_PARSE_DEFAULTS,
          });
          return {
            index: entry.index,
            byteOffset: entry.byteOffset,
            byteLength: entry.byteLength,
            ...(parsed.subject === undefined ? {} : { subject: parsed.subject }),
            ...(parsed.date === undefined ? {} : { date: parsed.date }),
            from: parsed.from,
            attachments: parsed.parts.filter((part) => part.isAttachment).length,
          };
        }),
      });
    }),
});

// ---------------------------------------------------------------------------
// calendars and contacts
// ---------------------------------------------------------------------------

export const icsParse: RegisteredTool = buildTool({
  name: "IcsParse",
  description:
    "Parse an RFC 5545 calendar into events with summary, start, end, timezone, attendees, recurrence rule and alarms. Use to read a .ics invitation or feed; folded lines are unfolded correctly and recurrence rules are returned as text rather than expanded.",
  inputSchema: z.object({
    path: z.string().min(1).optional().describe("path to a .ics file, inside the workspace"),
    content: z.string().optional().describe("the calendar text, instead of a path"),
    maxEvents: z.number().int().positive().max(50_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const text =
        input.content ??
        (input.path === undefined
          ? (() => {
              throw new ToolInputError("pass either path or content");
            })()
          : UTF8.decode(readFileCapped("IcsParse", input.path).bytes));
      const components = parseComponents(text, 12, 500_000);
      const result = readEvents(components);
      const limit = input.maxEvents ?? 1000;
      const events: ReadonlyArray<CalendarEvent> = result.events.slice(0, limit);
      return json({
        eventCount: result.events.length,
        truncated: result.events.length > events.length,
        ...(result.calendarNames.length > 0 ? { calendarNames: result.calendarNames } : {}),
        ...(result.hasTimezones
          ? {
              note: "this calendar defines VTIMEZONEs; their offsets are NOT applied, so a zoned time is returned with its TZID as written",
            }
          : {}),
        ...(result.otherComponents.length > 0 ? { componentsNotRead: result.otherComponents } : {}),
        events,
      });
    }),
});

export const icsWrite: RegisteredTool = buildTool({
  name: "IcsWrite",
  operativeArgs: [{ field: "path", kind: "path" }],
  description:
    "Write an RFC 5545 calendar file from a list of events, with correct 75-octet line folding and text escaping. Use to produce an invitation or a feed another calendar application can import; the DTSTAMP is an input, so the same events always write the same bytes.",
  inputSchema: z.object({
    path: z.string().min(1).describe("where to write the .ics, inside the workspace"),
    stamp: z.string().min(1).describe("ISO-8601 instant used as DTSTAMP for every event"),
    calendarName: z.string().optional(),
    productId: z.string().optional(),
    overwrite: z.boolean().optional(),
    events: z
      .array(
        z.object({
          uid: z.string().min(1),
          summary: z.string().min(1),
          start: z.string().min(1).describe("YYYY-MM-DD for all-day, or an ISO-8601 instant"),
          end: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          status: z.enum(["TENTATIVE", "CONFIRMED", "CANCELLED"]).optional(),
          organizer: z.string().optional(),
          attendees: z.array(z.string()).optional(),
          rrule: z.string().optional().describe("an RRULE value, e.g. FREQ=WEEKLY;COUNT=10"),
          alarmMinutesBefore: z.number().int().min(0).max(40_320).optional(),
          timezone: z.string().optional().describe("a TZID for a zoned (non-UTC) start and end"),
        }),
      )
      .min(1),
  }),
  destructive: true,
  execute: async (input) =>
    attempt(() => {
      const options: { stamp: string; productId?: string; calendarName?: string } = {
        stamp: input.stamp,
      };
      if (input.productId !== undefined) options.productId = input.productId;
      if (input.calendarName !== undefined) options.calendarName = input.calendarName;
      const text = writeCalendar(input.events as ReadonlyArray<EventInput>, options);
      const path = writeFileSafe("IcsWrite", input.path, text, input.overwrite === true);
      return json({ path: path.rel, events: input.events.length, bytes: text.length });
    }),
});

export const vcardParse: RegisteredTool = buildTool({
  name: "VcardParse",
  description:
    "Parse an RFC 6350 contact file into names, emails, phones, addresses and organisations. Use to read a .vcf export; several cards in one file are all returned, and embedded photos are reported as present rather than inlined.",
  inputSchema: z.object({
    path: z.string().min(1).optional().describe("path to a .vcf file, inside the workspace"),
    content: z.string().optional().describe("the vCard text, instead of a path"),
    maxCards: z.number().int().positive().max(100_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const text =
        input.content ??
        (input.path === undefined
          ? (() => {
              throw new ToolInputError("pass either path or content");
            })()
          : UTF8.decode(readFileCapped("VcardParse", input.path).bytes));
      const all = readVcards(parseComponents(text, 12, 500_000));
      const cards = all.slice(0, input.maxCards ?? 2000);
      return json({
        cardCount: all.length,
        truncated: all.length > cards.length,
        cards,
      });
    }),
});

// ---------------------------------------------------------------------------
// format-agnostic entry points
// ---------------------------------------------------------------------------

export const documentTextTool: RegisteredTool = buildTool({
  name: "DocumentText",
  description:
    "Extract plain text from a document of any supported kind, dispatching on what the file actually is. Use when the format is not known up front, or does not matter: PDF, .docx, .xlsx, .pptx, mail, mbox, calendars, contacts, HTML and plain text all go in, text comes out.",
  inputSchema: z.object({
    path: z.string().min(1).describe("path to the document, inside the workspace"),
    maxChars: z.number().int().positive().max(2_000_000).optional(),
    pages: z.string().optional().describe("for a PDF, a page range such as '1-5'"),
    withMetadata: z
      .boolean()
      .optional()
      .describe("return the detected kind and any notes alongside the text"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const result = documentText(
        "DocumentText",
        input.path,
        input.maxChars ?? DEFAULT_MAX_CHARS,
        input.pages,
      );
      if (input.withMetadata === true || result.notes.length > 0 || result.truncated) {
        return json({
          kind: result.kind,
          truncated: result.truncated,
          notes: result.notes,
          text: result.text,
        });
      }
      return result.text;
    }),
});

export const documentDiff: RegisteredTool = buildTool({
  name: "DocumentDiff",
  description:
    "Compare two documents by their extracted text and report what changed, as counts plus a unified diff. Use to see what moved between two revisions of a contract, a report or a deck, even when the two files are in different formats.",
  inputSchema: z.object({
    a: z.string().min(1).describe("path to the original document"),
    b: z.string().min(1).describe("path to the changed document"),
    context: z.number().int().min(0).max(20).optional(),
    ignoreWhitespace: z.boolean().optional().describe("treat re-wrapped lines as unchanged"),
    ignoreCase: z.boolean().optional(),
    statsOnly: z.boolean().optional(),
    maxChars: z.number().int().positive().max(2_000_000).optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) =>
    attempt(() => {
      const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
      const left = documentText("DocumentDiff", input.a, maxChars);
      const right = documentText("DocumentDiff", input.b, maxChars);
      const notes = [...left.notes, ...right.notes];
      // Blank lines are formatting, not content; dropping them keeps a
      // re-paginated document from reading as a rewrite.
      const linesA = left.text.split("\n").filter((line) => line.trim() !== "");
      const linesB = right.text.split("\n").filter((line) => line.trim() !== "");
      const cells = (linesA.length + 1) * (linesB.length + 1);
      if (cells > 25_000_000) {
        return `these documents are too large to diff (${linesA.length} x ${linesB.length} lines) — narrow them first, for example with a page range`;
      }
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      const ignoreCase = input.ignoreCase === true;
      const keyA = linesA.map((line) => normalizeLine(line, ignoreWhitespace, ignoreCase));
      const keyB = linesB.map((line) => normalizeLine(line, ignoreWhitespace, ignoreCase));
      const ops = diffLines(linesA, linesB, keyA, keyB);
      const stats = diffStats(ops);
      const noChanges = stats.added + stats.removed === 0;
      // `identical` is a claim about the DOCUMENTS. If either extraction was
      // cut short at the character budget, the tails were never compared, so
      // the honest answer is that the part that was read matches — not that
      // the documents are the same.
      const partial = left.truncated || right.truncated;
      if (partial) {
        notes.push(
          "one or both documents were truncated before comparing, so this covers only the text that was read — raise maxChars or narrow with a page range",
        );
      }
      const summary = {
        a: {
          kind: left.kind,
          lines: linesA.length,
          words: wordCounts(left.text),
          ...(left.truncated ? { truncated: true } : {}),
        },
        b: {
          kind: right.kind,
          lines: linesB.length,
          words: wordCounts(right.text),
          ...(right.truncated ? { truncated: true } : {}),
        },
        ...stats,
        ...(partial
          ? { comparedTextIdentical: noChanges, identical: null }
          : { identical: noChanges }),
        ...(notes.length > 0 ? { notes } : {}),
      };
      if (input.statsOnly === true || noChanges) return json(summary);
      return json({
        ...summary,
        diff: renderUnified(ops, input.a, input.b, input.context ?? 3),
      });
    }),
});

/** Every tool this package registers, in the order a catalog should list them. */
export const DOCS_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  docxRead,
  docxWrite,
  documentDiff,
  documentTextTool,
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
]);
