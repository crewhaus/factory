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
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";

export type DocumentParserResult = {
  readonly content: string;
  /** Optional structured metadata to surface to the model. */
  readonly metadata?: Record<string, unknown>;
};

export type DocumentParser = (path: string) => Promise<DocumentParserResult> | DocumentParserResult;

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
 * Mirrors `tool-fs`'s `resolveSafe` — duplicated here (like `tool-image`)
 * rather than extracted to a shared package; keep the copies in sync.
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
  //    the REAL path. The leaf may not exist (the file-not-found error comes
  //    after containment so escaping paths never leak existence info), so
  //    resolve the deepest existing ancestor and re-append the missing tail.
  //    Fails closed if realpath errors for any reason other than the walk.
  let real: string;
  try {
    const rootReal = realpathSync(rootResolved);
    let probe = abs;
    const tail: string[] = [];
    while (!existsSync(probe)) {
      tail.unshift(basename(probe));
      const parent = dirname(probe);
      if (parent === probe) break; // reached the filesystem root
      probe = parent;
    }
    real = tail.length > 0 ? join(realpathSync(probe), ...tail) : realpathSync(probe);
    if (real !== rootReal && !real.startsWith(`${rootReal}${sep}`)) {
      throw new ToolPermissionError(toolName, rel);
    }
  } catch (err) {
    if (err instanceof ToolPermissionError) throw err;
    throw new ToolPermissionError(toolName, rel);
  }
  // Return the validated REAL path; the read below opens it with O_NOFOLLOW so a
  // leaf swapped to a symlink after this check (TOCTOU/CWE-367) is rejected.
  return real;
}

/**
 * Read a resolveSafe-validated text file with O_NOFOLLOW so a leaf swapped to a
 * symlink after the containment check is rejected rather than followed out of
 * the workspace. (Custom parsers read the resolved realpath themselves and are
 * out of this guard's scope.)
 */
function readTextNoFollow(absPath: string): string {
  let fd: number;
  try {
    fd = openSync(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ToolPermissionError("IngestDocument", absPath);
    }
    throw err;
  }
  try {
    const { size } = fstatSync(fd);
    const b = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, b, offset, size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return b.toString("utf-8", 0, offset);
  } finally {
    closeSync(fd);
  }
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
    .describe("Hard cap. Default 1MB. Files larger than this are truncated with a notice."),
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
      const result = await customParser(abs);
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
      const raw = readTextNoFollow(abs);
      const metadata: Record<string, unknown> = {
        ext: ext || "(none)",
        size: stat.size,
        lines: countLines(raw),
      };
      if (TABULAR_EXTENSIONS.has(ext)) {
        const delim = ext === ".tsv" ? "\t" : ",";
        const lines = raw.split("\n").filter((l) => l.length > 0);
        metadata["rows"] = lines.length;
        metadata["columns"] = (lines[0] ?? "").split(delim).length;
      }
      if (STRUCTURED_EXTENSIONS.has(ext)) {
        if (ext === ".json") {
          try {
            JSON.parse(raw);
            metadata["valid_json"] = true;
          } catch (err) {
            metadata["valid_json"] = false;
            metadata["parse_error"] = (err as Error).message.slice(0, 200);
          }
        }
      }
      return renderResult({ path: abs, content: raw, metadata, maxBytes });
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
}): string {
  let content = args.content;
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > args.maxBytes) {
    content = Buffer.from(content, "utf-8").subarray(0, args.maxBytes).toString("utf-8");
    truncated = true;
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

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (const ch of s) {
    if (ch === "\n") n++;
  }
  // A trailing newline is a line terminator, not a 4th empty line.
  if (s.endsWith("\n")) n--;
  return n;
}
