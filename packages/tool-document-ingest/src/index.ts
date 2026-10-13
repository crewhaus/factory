/**
 * Catalog R3 — tool-document-ingest. M4.3 of the heavy-hitter plan.
 *
 * `IngestDocument(path)` reads a file from the user's host and returns
 * its content plus structured metadata (line count, byte size, MIME
 * guess, optional chunks).
 *
 * v0 supported formats — handled inline, zero extra deps:
 *   - .txt, .md, .mdx — plain UTF-8 text
 *   - .csv, .tsv — text plus row count
 *   - .json, .yaml, .yml — text plus parse-validation
 *   - .log, .out — plain text
 *
 * Stubbed formats — return a clear "needs operator-registered parser"
 * error pointing at `registerDocumentParser(ext, parser)`:
 *   - .pdf, .docx, .doc, .xlsx, .xls, .pptx, .epub
 *
 * Why no pdf-parse / mammoth / xlsx deps in v0: those packages weigh
 * several MB each and have native sub-deps. Operators who need them
 * can register their own parser via `registerDocumentParser`; the
 * tool's contract stays the same.
 *
 * Security note: the path is user-controlled (the model supplies it, and
 * the model may be steered by injected content). Two defenses apply:
 *   1. Containment — the path is resolved against `process.cwd()` and
 *      rejected if it escapes the workspace root, lexically (`..` or
 *      absolute escapes) or via an in-root symlink whose real target
 *      lies outside (CWE-59). See `resolveSafe` below.
 *   2. Output classification — the runtime classifies the OUTPUT via
 *      boundary-classifier with the existing `tool` origin (Pillar 3);
 *      file contents may contain anything (e.g. a prompt-injecting PDF).
 */
import { existsSync, statSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { openForReadSync, resolveContained } from "@crewhaus/tool-safety/fs";
import { z } from "zod";

export type DocumentParserResult = {
  readonly content: string;
  /** Optional structured metadata to surface to the model. */
  readonly metadata?: Record<string, unknown>;
};

/**
 * An operator-registered parser. It reads `path` itself, so it owns the
 * memory it uses: `options.maxBytes` is the caller's budget, and a parser
 * that can stop early (a PDF page limit, a streamed reader) should. Its
 * output is cut to `maxBytes` either way.
 */
export type DocumentParser = (
  path: string,
  options: { readonly maxBytes: number },
) => Promise<DocumentParserResult> | DocumentParserResult;

export class DocumentIngestError extends CrewhausError {
  override readonly name = "DocumentIngestError";
  constructor(message: string, cause?: unknown) {
    super("tool", message, cause);
  }
}

export class ToolPermissionError extends CrewhausError {
  override readonly name = "ToolPermissionError";
  readonly toolName: string;
  readonly path: string;

  constructor(toolName: string, attemptedPath: string) {
    super(
      "tool",
      `tool "${toolName}" rejected path "${attemptedPath}": resolved location escapes the workspace root`,
    );
    this.toolName = toolName;
    this.path = attemptedPath;
  }
}

/**
 * Resolve `rel` against the workspace root and reject anything that escapes.
 * Where the path physically lands is tool-safety's `resolveContained`, the
 * resolver every file tool in the workspace now shares.
 */
function resolveSafe(toolName: string, rel: string, root: string = process.cwd()): string {
  const rootResolved = resolve(root);
  const abs = resolve(rootResolved, rel);
  // 1) Lexical containment — fast path; rejects `..` and absolute escapes.
  //    The trailing `sep` avoids the `/root` vs `/root-sibling` pitfall.
  if (abs !== rootResolved && !abs.startsWith(`${rootResolved}${sep}`)) {
    throw new ToolPermissionError(toolName, rel);
  }
  // 2) Symlink-aware containment (CWE-59). The lexical check above is fooled
  //    by an in-root symlink that points outside the workspace, so re-check
  //    where the path PHYSICALLY lands. The leaf may not exist (the
  //    file-not-found error comes after containment so escaping paths never
  //    leak existence info). tool-safety walks it one component at a time,
  //    as the kernel does, following dangling links too; the copy that lived
  //    here folded a dangling link's target as text (C068). Fails closed.
  const resolved = resolveContained(rootResolved, abs);
  if (!resolved.ok) throw new ToolPermissionError(toolName, rel);
  return resolved.real;
}

/**
 * At most `maxBytes` of a contained file, read through tool-safety's
 * `openForReadSync`: the whole path resolved physically and required to land
 * inside the workspace, a FIFO or device refused before it is opened, a link
 * swapped in afterwards refused on the descriptor, and never more than
 * `maxBytes` + 1 bytes read, whatever the file's size. 0.7.0 allocated the
 * whole file, decoded it, counted it and parsed it, and only then cut the
 * result to `maxBytes`: a 300 MiB log read with `maxBytes: 1000` cost
 * 1.5 GiB of memory, and a file over 4 GiB could not be read at all.
 *
 * The text is cut on a character boundary: a multi-byte character the cut
 * would split is left out, never turned into U+FFFD.
 */
function readPrefix(
  given: string,
  maxBytes: number,
): { readonly text: string; readonly size: number; readonly truncated: boolean } {
  const read = openForReadSync(process.cwd(), given, { maxBytes });
  if (!read.ok) {
    if (read.code === "escapes-root") throw new ToolPermissionError("IngestDocument", given);
    if (read.code === "not-found") throw new DocumentIngestError(`file not found: ${given}`);
    throw new DocumentIngestError(read.reason);
  }
  return { text: read.text, size: read.size, truncated: read.truncated };
}

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".mdx", ".log", ".out", ".rst"]);
const TABULAR_EXTENSIONS = new Set([".csv", ".tsv"]);
const STRUCTURED_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const STUB_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".epub"]);

const customParsers = new Map<string, DocumentParser>();

/**
 * Register a parser for a file extension. Operators who need PDF/docx
 * support wire their preferred library here:
 *
 *   import pdfParse from "pdf-parse";
 *   registerDocumentParser(".pdf", async (path) => {
 *     const buf = await fs.readFile(path);
 *     const { text, numpages } = await pdfParse(buf);
 *     return { content: text, metadata: { pages: numpages } };
 *   });
 *
 * Extension is matched case-insensitively. Must start with ".".
 */
export function registerDocumentParser(ext: string, parser: DocumentParser): void {
  if (!ext.startsWith(".")) {
    throw new DocumentIngestError(`extension must start with "." (got "${ext}")`);
  }
  customParsers.set(ext.toLowerCase(), parser);
}

/**
 * Clear all registered parsers. For tests.
 */
export function clearDocumentParsers(): void {
  customParsers.clear();
}

const inputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("Workspace-relative path to the file. Paths escaping the workspace are rejected."),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(10_000_000)
    .optional()
    .describe(
      "Most bytes read from the file, and returned. Default 1MB. A larger file is truncated with a notice, and its line and row counts describe the part that was read.",
    ),
});

const DEFAULT_MAX_BYTES = 1_000_000;

export const ingestDocument: RegisteredTool = buildTool({
  name: "IngestDocument",
  description:
    "Read a file inside the workspace and return its content with structured metadata. Paths escaping the workspace root are rejected. Supports plain text, CSV/TSV, JSON, YAML out of the box; PDF/docx/xlsx need an operator-registered parser.",
  inputSchema,
  readOnly: true,
  destructive: false,
  execute: async (input) => {
    const abs = resolveSafe("IngestDocument", input.path);
    if (!existsSync(abs)) {
      throw new DocumentIngestError(`file not found: ${abs}`);
    }
    const stat = statSync(abs);
    if (!stat.isFile()) {
      throw new DocumentIngestError(`not a regular file: ${abs}`);
    }
    const ext = extname(abs).toLowerCase();
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

    // Operator-registered parser takes priority over built-in handling.
    const customParser = customParsers.get(ext);
    if (customParser !== undefined) {
      // A registered parser reads the file itself, so the tool cannot bound
      // what it holds; it is told the budget, and its output is cut to it.
      const result = await customParser(abs, { maxBytes });
      return renderResult({
        path: abs,
        content: result.content,
        metadata: { ext, size: stat.size, ...result.metadata },
        maxBytes,
      });
    }

    if (STUB_EXTENSIONS.has(ext)) {
      throw new DocumentIngestError(
        `extension "${ext}" needs a parser registered via registerDocumentParser(). See @crewhaus/tool-document-ingest README for the pdf-parse / mammoth / xlsx setup.`,
      );
    }

    if (
      TEXT_EXTENSIONS.has(ext) ||
      TABULAR_EXTENSIONS.has(ext) ||
      STRUCTURED_EXTENSIONS.has(ext) ||
      ext === ""
    ) {
      const read = readPrefix(input.path, maxBytes);
      const raw = read.text;
      // When only a prefix was read, every count describes that prefix and
      // says so: a model told `"lines":50` of a million-line log would be
      // told something false.
      const metadata: Record<string, unknown> = {
        ext: ext || "(none)",
        size: read.size,
        lines: countLines(raw),
        ...(read.truncated ? { linesPartial: true } : {}),
      };
      if (TABULAR_EXTENSIONS.has(ext)) {
        const delim = ext === ".tsv" ? "\t" : ",";
        const lines = raw.split("\n").filter((l) => l.length > 0);
        metadata["rows"] = lines.length;
        if (read.truncated) metadata["rowsPartial"] = true;
        metadata["columns"] = (lines[0] ?? "").split(delim).length;
      }
      if (STRUCTURED_EXTENSIONS.has(ext)) {
        if (ext === ".json") {
          if (read.truncated) {
            // A prefix of a JSON document never parses, so "false" would be
            // a verdict about the cut, not the file.
            metadata["valid_json"] = null;
            metadata["validation"] =
              "skipped: the file is larger than maxBytes, so only part of it was read";
          } else {
            try {
              JSON.parse(raw);
              metadata["valid_json"] = true;
            } catch (err) {
              metadata["valid_json"] = false;
              metadata["parse_error"] = (err as Error).message.slice(0, 200);
            }
          }
        }
      }
      return renderResult({
        path: abs,
        content: raw,
        metadata,
        maxBytes,
        truncated: read.truncated,
      });
    }

    throw new DocumentIngestError(
      `extension "${ext}" is not handled by built-in ingest. Register a parser via registerDocumentParser("${ext}", …), or rename to .txt/.md if it's plain text.`,
    );
  },
});

function renderResult(args: {
  readonly path: string;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly maxBytes: number;
  /** Set when the content is already a cut prefix of the file. */
  readonly truncated?: boolean;
}): string {
  let content = args.content;
  let truncated = args.truncated === true;
  if (args.truncated === undefined) {
    // A parser's output: cut once. A prefix of maxBytes UTF-16 units encodes
    // to at least maxBytes UTF-8 bytes, so the whole string is never encoded.
    const encoded = Buffer.from(content.slice(0, args.maxBytes + 1), "utf-8");
    if (encoded.length > args.maxBytes || content.length > args.maxBytes + 1) {
      content = encoded.subarray(0, utf8Cut(encoded, args.maxBytes)).toString("utf-8");
      truncated = true;
    }
  }
  const lines: string[] = [
    `<document path="${args.path}" name="${basename(args.path)}">`,
    `metadata: ${JSON.stringify(args.metadata)}${truncated ? ` (TRUNCATED to ${args.maxBytes} bytes)` : ""}`,
    "---",
    content,
    "</document>",
  ];
  return lines.join("\n");
}

/**
 * The longest prefix of `bytes` of at most `max` bytes that ends on a UTF-8
 * character boundary: a character the cut would split is left out.
 */
function utf8Cut(bytes: Uint8Array, max: number): number {
  if (bytes.length <= max) return bytes.length;
  let end = max;
  // bytes[end] is the first byte left out; while it continues a character,
  // that character started inside the prefix and must go too.
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end -= 1;
  return end;
}

/** Lines in `s`, found with indexOf rather than a walk over every code point. */
function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let at = s.indexOf("\n"); at !== -1; at = s.indexOf("\n", at + 1)) n++;
  // A trailing newline is a line terminator, not a 4th empty line.
  if (s.endsWith("\n")) n--;
  return n;
}
