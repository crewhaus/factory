/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { sampleDocx, samplePdf, samplePptx, sampleXlsx, textPageContent } from "./fixtures";
import { DOCS_TOOLS } from "./index";

let catalog: ToolCatalog;
const originalCwd = process.cwd();
let tmp: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:1@x.test",
  "SUMMARY:Stand-up",
  "DTSTART:20240115T090000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const VCF = ["BEGIN:VCARD", "VERSION:3.0", "FN:Jane Doe", "END:VCARD", ""].join("\r\n");

const EML = [
  "From: jane@x.test",
  "Subject: hello",
  "Date: Mon, 15 Jan 2024 09:30:00 +0000",
  "",
  "body",
  "",
].join("\r\n");

const MBOX = ["From jane@x.test Mon Jan 15 09:30:00 2024", "Subject: first", "", "one", ""].join(
  "\n",
);

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of DOCS_TOOLS) catalog.register(tool);
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-docs-int-"));
  process.chdir(tmp);
  const put = (name: string, data: Uint8Array | string): void => {
    writeFileSync(path.join(tmp, name), data);
  };
  put("a.docx", sampleDocx());
  put("a.xlsx", sampleXlsx());
  put("a.pptx", samplePptx());
  put(
    "a.pdf",
    samplePdf({ pages: [1, 2].map((n) => ({ content: textPageContent([`Page ${n}`]) })) }),
  );
  put("b.pdf", samplePdf({ pages: [{ content: textPageContent(["Other"]) }] }));
  put("a.ics", ICS);
  put("a.vcf", VCF);
  put("a.eml", EML);
  put("a.mbox", MBOX);
  put("a.txt", "plain words");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(DOCS_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of DOCS_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(lookup("DocxRead"), { path: "a.docx" }, { toolUseId: "t1" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Quarterly Report");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("DocxRead"), { path: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("DocxRead");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(lookup("PdfSplit"), { path: "a.pdf" }, { toolUseId: "t3" });
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("PdfInfo"),
      { path: "a.pdf" },
      { toolUseId: "t4", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("PdfInfo"),
      { path: "a.pdf" },
      { toolUseId: "t5", allowedPatterns: ["PdfInfo"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a path outside the workspace comes back as a result, not an exception", async () => {
    const result = await executeTool(
      lookup("DocumentText"),
      { path: "../../etc/hosts" },
      { toolUseId: "t6" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("escapes the workspace root");
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      DocxRead: { path: "a.docx" },
      DocxWrite: { path: "w.docx", blocks: [{ type: "paragraph", text: "x" }] },
      DocumentDiff: { a: "a.txt", b: "a.txt" },
      DocumentText: { path: "a.txt" },
      EmlParse: { path: "a.eml" },
      IcsParse: { path: "a.ics" },
      IcsWrite: {
        path: "w.ics",
        stamp: "2024-01-01T00:00:00Z",
        events: [{ uid: "u", summary: "s", start: "2024-01-15T09:00:00Z" }],
      },
      MboxSplit: { path: "a.mbox" },
      PdfInfo: { path: "a.pdf" },
      PdfMerge: { inputs: [{ path: "a.pdf" }, { path: "b.pdf" }], output: "m.pdf" },
      PdfSplit: { path: "a.pdf", pages: "1", output: "s.pdf" },
      PdfText: { path: "a.pdf" },
      PptxRead: { path: "a.pptx" },
      VcardParse: { path: "a.vcf" },
      XlsxRead: { path: "a.xlsx" },
      XlsxWrite: { path: "w.xlsx", sheets: [{ name: "S", rows: [["x"]] }] },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(DOCS_TOOLS.map((tool) => tool.name).sort());
    for (const tool of DOCS_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError, content: result.content }).toEqual({
        name: tool.name,
        isError: false,
        content: result.content,
      });
      // A readable refusal is still a failure for a call that should work.
      expect({
        name: tool.name,
        refused: /^(no such file|that path)/.test(result.content),
      }).toEqual({ name: tool.name, refused: false });
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = { path: "a.xlsx" };
    const a = await executeTool(lookup("XlsxRead"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("XlsxRead"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });

  test("a reader and the entry point agree about a document's text", async () => {
    const direct = await executeTool(
      lookup("PptxRead"),
      { path: "a.pptx", asText: true },
      { toolUseId: "e1" },
    );
    const viaEntryPoint = await executeTool(
      lookup("DocumentText"),
      { path: "a.pptx" },
      { toolUseId: "e2" },
    );
    expect(viaEntryPoint.content).toBe(direct.content);
  });

  test("a write, then a read of what was written, both go through the runtime", async () => {
    const written = await executeTool(
      lookup("DocxWrite"),
      {
        path: "report.docx",
        blocks: [
          { type: "heading", text: "Findings", level: 1 },
          { type: "table", rows: [["a", "b"]], header: true },
        ],
        created: "2024-01-15T09:00:00Z",
      },
      { toolUseId: "w1" },
    );
    expect(written.isError).toBe(false);
    const read = await executeTool(
      lookup("DocumentText"),
      { path: "report.docx" },
      { toolUseId: "w2" },
    );
    expect(read.content).toContain("Findings");
    expect(read.content).toContain("a\tb");
  });
});

// Regression — a RELATIVE symlink target must be resolved against the
// directory that actually CONTAINS the link, not the link's lexical parent.
// The two differ exactly when that parent is itself reached through a
// symlink, and the `readlink` hop is where it first matters: the leaf stays
// in the RESOLVED part of the path, so measuring it from the wrong directory
// names a location the caller's path does not lead to.
//
// Reading it lexically is not an escape — the mis-measured path is always an
// IN-ROOT one, so it passes containment and the tool does its I/O there. The
// cost is a write landing silently at the WRONG IN-WORKSPACE place, and a
// legitimate in-workspace relative dangling link being refused for the same
// bad arithmetic.
describe("integration: tool-docs relative dangling-link base", () => {
  test("an outward directory link holding a relative dangling link is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-docs-outside-"));
    try {
      mkdirSync(path.join(outside, "realdir"));
      // `pdir` leaves the workspace, so `l` really lives in <outside>/realdir
      // and "../escape.ics" truly names <outside>/escape.ics. Measured from
      // the LEXICAL parent <tmp>/pdir it reads as <tmp>/escape.ics — an
      // in-root path, which is how the wrong base turns this refusal into a
      // quiet write somewhere the caller's path never led.
      symlinkSync(path.join(outside, "realdir"), path.join(tmp, "pdir"));
      symlinkSync("../escape.ics", path.join(outside, "realdir", "l"));

      const result = await executeTool(
        lookup("IcsWrite"),
        {
          path: "pdir/l",
          stamp: "2024-01-01T00:00:00Z",
          events: [{ uid: "u", summary: "Stand-up", start: "2024-01-15T09:00:00Z" }],
        },
        { toolUseId: "relbase" },
      );
      // "pdir/l" is a plain workspace-relative path with no `..` and no root,
      // so the cheap lexical pre-check has nothing to catch: this refusal can
      // only have come from the symlink walk.
      expect(result.isError).toBe(false);
      expect(result.content).toMatch(/escapes the workspace root/);
      expect(existsSync(path.join(outside, "escape.ics"))).toBe(false);
      // Nor quietly redirected to the in-root path the lexical reading names.
      expect(existsSync(path.join(tmp, "escape.ics"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
