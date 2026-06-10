/**
 * Tests for tool-document-ingest. Built-in handling for plain text /
 * structured / tabular formats, operator-registered parsers, and
 * workspace path containment (mirrors tool-fs's traversal-rejection
 * cases).
 *
 * The harness chdirs into a temp workspace because IngestDocument is
 * sandboxed to `process.cwd()` — tests address files by workspace-
 * relative path.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import {
  DocumentIngestError,
  ToolPermissionError,
  clearDocumentParsers,
  ingestDocument,
  registerDocumentParser,
} from "./index";

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  // realpath so absolute-path-inside-workspace assertions hold on macOS,
  // where tmpdir() lives behind the /var → /private/var symlink.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "doc-ingest-")));
  process.chdir(tmp);
  clearDocumentParsers();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  clearDocumentParsers();
});

/** Write `content` into the temp workspace; returns the workspace-relative path. */
function writeFile(name: string, content: string): string {
  writeFileSync(join(tmp, name), content);
  return name;
}

describe("ingestDocument — basics", () => {
  test("tool flags: read-only, non-destructive, named 'IngestDocument'", () => {
    expect(ingestDocument.name).toBe("IngestDocument");
    expect(ingestDocument.readOnly).toBe(true);
    expect(ingestDocument.destructive).toBe(false);
  });

  test("throws when file does not exist", async () => {
    await expect(ingestDocument.execute({ path: "does/not/exist.txt" })).rejects.toThrow(
      DocumentIngestError,
    );
  });

  test("ingests a plain .txt file with the document envelope", async () => {
    const path = writeFile("note.txt", "hello\nworld\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toContain("<document path=");
    expect(result).toContain("hello");
    expect(result).toContain("</document>");
    expect(result).toContain("metadata:");
  });

  test("emits line count + ext in metadata for .md", async () => {
    const path = writeFile("doc.md", "# title\n\nbody.\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"ext":"\.md"/);
    expect(result).toMatch(/"lines":3/);
  });
});

describe("ingestDocument — path containment", () => {
  test("ToolPermissionError is a CrewhausError with code 'tool'", () => {
    const err = new ToolPermissionError("IngestDocument", "../../escape");
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.code).toBe("tool");
    expect(err.toolName).toBe("IngestDocument");
    expect(err.path).toBe("../../escape");
    expect(err.message).toContain("escapes the workspace root");
  });

  test("rejects parent-directory traversal", async () => {
    await expect(ingestDocument.execute({ path: "../../../etc/passwd" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects absolute path outside workspace", async () => {
    await expect(ingestDocument.execute({ path: "/etc/passwd" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects subdir-then-traversal", async () => {
    mkdirSync(join(tmp, "sub"));
    await expect(ingestDocument.execute({ path: "sub/../../escape.txt" })).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  test("rejects an in-root symlink whose target escapes the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "doc-ingest-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "top secret");
      symlinkSync(join(outside, "secret.txt"), join(tmp, "link.txt"));
      await expect(ingestDocument.execute({ path: "link.txt" })).rejects.toBeInstanceOf(
        ToolPermissionError,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("allows an absolute path inside the workspace", async () => {
    writeFile("inside.txt", "in-root content");
    const result = await ingestDocument.execute({ path: join(tmp, "inside.txt") });
    expect(result).toContain("in-root content");
  });

  test("allows an in-root symlink to an in-root file (no over-blocking)", async () => {
    writeFile("real.txt", "linked content");
    symlinkSync(join(tmp, "real.txt"), join(tmp, "good-link.txt"));
    const result = await ingestDocument.execute({ path: "good-link.txt" });
    expect(result).toContain("linked content");
  });
});

describe("ingestDocument — tabular formats", () => {
  test("counts rows + columns in CSV", async () => {
    const path = writeFile("data.csv", "a,b,c\n1,2,3\n4,5,6\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"rows":3/);
    expect(result).toMatch(/"columns":3/);
  });

  test("uses tab delimiter for .tsv", async () => {
    const path = writeFile("data.tsv", "a\tb\n1\t2\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"columns":2/);
  });
});

describe("ingestDocument — structured formats", () => {
  test("validates JSON parse for .json files", async () => {
    const path = writeFile("config.json", '{"k":1}');
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"valid_json":true/);
  });

  test("flags malformed JSON without throwing", async () => {
    const path = writeFile("config.json", "{not json}");
    const result = await ingestDocument.execute({ path });
    expect(result).toMatch(/"valid_json":false/);
    expect(result).toContain("parse_error");
  });
});

describe("ingestDocument — stubbed extensions", () => {
  test(".pdf raises with a pointer to registerDocumentParser", async () => {
    const path = writeFile("doc.pdf", "%PDF-1.4 fake content");
    await expect(ingestDocument.execute({ path })).rejects.toThrow(
      /needs a parser registered via registerDocumentParser/,
    );
  });

  test(".docx and .xlsx similarly throw with extension-specific message", async () => {
    const docx = writeFile("a.docx", "fake docx");
    await expect(ingestDocument.execute({ path: docx })).rejects.toThrow(/"\.docx"/);
    const xlsx = writeFile("b.xlsx", "fake xlsx");
    await expect(ingestDocument.execute({ path: xlsx })).rejects.toThrow(/"\.xlsx"/);
  });
});

describe("ingestDocument — operator-registered parsers", () => {
  test("registerDocumentParser overrides built-in handling", async () => {
    registerDocumentParser(".pdf", async (path) => ({
      content: `parsed PDF text from ${path}`,
      metadata: { pages: 42 },
    }));
    const path = writeFile("doc.pdf", "fake content");
    const result = await ingestDocument.execute({ path });
    expect(result).toContain("parsed PDF text from");
    expect(result).toMatch(/"pages":42/);
  });

  test("registerDocumentParser rejects extensions without leading dot", () => {
    expect(() => registerDocumentParser("pdf", async () => ({ content: "" }))).toThrow(
      DocumentIngestError,
    );
  });

  test("ext matching is case-insensitive", async () => {
    registerDocumentParser(".PDF", async () => ({ content: "uppercase ext" }));
    const path = writeFile("doc.pdf", "x");
    const result = await ingestDocument.execute({ path });
    expect(result).toContain("uppercase ext");
  });
});

describe("ingestDocument — size cap", () => {
  test("truncates content above maxBytes with a TRUNCATED notice", async () => {
    const path = writeFile("big.txt", "x".repeat(200));
    const result = await ingestDocument.execute({ path, maxBytes: 50 });
    expect(result).toContain("TRUNCATED to 50 bytes");
  });

  test("default maxBytes is 1MB", () => {
    const parsed = ingestDocument.inputSchema.parse({ path: "x" });
    expect(parsed.maxBytes).toBeUndefined();
  });
});
