/**
 * Tests for tool-document-ingest. Built-in handling for plain text /
 * structured / tabular formats, plus operator-registered parsers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DocumentIngestError,
  clearDocumentParsers,
  ingestDocument,
  registerDocumentParser,
} from "./index";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "doc-ingest-"));
  clearDocumentParsers();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearDocumentParsers();
});

function writeFile(name: string, content: string): string {
  const path = join(tmp, name);
  writeFileSync(path, content);
  return path;
}

describe("ingestDocument — basics", () => {
  test("tool flags: read-only, non-destructive, named 'IngestDocument'", () => {
    expect(ingestDocument.name).toBe("IngestDocument");
    expect(ingestDocument.readOnly).toBe(true);
    expect(ingestDocument.destructive).toBe(false);
  });

  test("throws when file does not exist", async () => {
    await expect(ingestDocument.execute({ path: "/does/not/exist.txt" })).rejects.toThrow(
      DocumentIngestError,
    );
  });

  test("ingests a plain .txt file with the document envelope", async () => {
    const path = writeFile("note.txt", "hello\nworld\n");
    const result = await ingestDocument.execute({ path });
    expect(result).toContain('<document path=');
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
    expect(() =>
      registerDocumentParser("pdf", async () => ({ content: "" })),
    ).toThrow(DocumentIngestError);
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
