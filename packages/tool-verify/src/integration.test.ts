import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * The tools driven the way the runtime drives them, and the gate they exist
 * to be: run something, then decide whether it is done.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { VERIFY_TOOLS } from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of VERIFY_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-verify-int-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(VERIFY_TOOLS.length);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    writeFileSync(join(workspace, "f.txt"), "x");
    const result = await executeTool(
      lookup("AcceptanceCheck"),
      { checks: [{ kind: "fileExists", path: "f.txt" }] },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"ok":true');
  });

  test("an unknown check kind is rejected before execute", async () => {
    const result = await executeTool(
      lookup("AcceptanceCheck"),
      { checks: [{ kind: "fileIsBlue", path: "f.txt" }] },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    writeFileSync(join(workspace, "f.txt"), "hello\n");
    writeFileSync(join(workspace, "g.txt"), "hello\n");
    mkdirSync(join(workspace, "docs"));
    writeFileSync(join(workspace, "docs/a.md"), "# T\n");
    const inputs: Record<string, unknown> = {
      AcceptanceCheck: { checks: [{ kind: "fileExists", path: "f.txt" }] },
      ChecksumVerify: { write: true, files: ["f.txt"] },
      CitationLint: { text: "no citations here" },
      FactCrossCheck: { text: "no citations here" },
      GoldenCompare: { actual: "hello\n", golden: "g.txt" },
      GoldenUpdate: { actual: "hello\n", golden: "written.txt" },
      MarkdownLinkCheck: { path: "docs" },
      SeoLint: {
        html: '<html lang="en"><head><title>T</title></head><body><h1>T</h1></body></html>',
      },
    };
    for (const tool of VERIFY_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });
});

describe("the gate these exist to be", () => {
  test("accept a reviewed baseline, then catch the next real change through the noise", async () => {
    const run1 =
      "build 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d in 1.2s at 2026-01-01T00:00:00Z\nresult: ok\n";
    const normalize = ["timestamps", "durations", "hashes"];

    // 1. The first output is reviewed and accepted as the baseline.
    const accepted = await executeTool(
      lookup("GoldenUpdate"),
      { actual: run1, golden: "run.golden", normalize },
      { toolUseId: "g1" },
    );
    expect(JSON.parse(accepted.content).created).toBe(true);

    // 2. A later run differs in every varying part and nothing else. It
    //    matches, which is the whole reason for normalizing.
    const run2 =
      "build 9f8e7d6c5b4a39281706f5e4d3c2b1a0 in 3.7s at 2026-06-06T12:34:56Z\nresult: ok\n";
    const same = await executeTool(
      lookup("GoldenCompare"),
      { actual: run2, golden: "run.golden", normalize },
      { toolUseId: "g2" },
    );
    expect(JSON.parse(same.content).match).toBe(true);

    // 3. A run that differs in something real is caught, at the line.
    const run3 = run2.replace("result: ok", "result: FAILED");
    const changed = await executeTool(
      lookup("GoldenCompare"),
      { actual: run3, golden: "run.golden", normalize },
      { toolUseId: "g3" },
    );
    const diff = JSON.parse(changed.content);
    expect(diff.match).toBe(false);
    expect(diff.differences[0]).toMatchObject({ expected: "result: ok", actual: "result: FAILED" });

    // 4. And the definition of done is a list of checks, not an opinion.
    writeFileSync(join(workspace, "out.txt"), "shipped\n");
    const done = await executeTool(
      lookup("AcceptanceCheck"),
      {
        checks: [
          { kind: "fileExists", path: "out.txt" },
          { kind: "fileContains", path: "out.txt", text: "shipped" },
          { kind: "fileAbsent", path: "out.txt.tmp" },
        ],
      },
      { toolUseId: "g4" },
    );
    expect(JSON.parse(done.content)).toMatchObject({ ok: true, checked: 3, failed: 0 });
  });
});

describe("the two citation gates in order", () => {
  test("a marker with a source behind it can still be a claim the source does not make", async () => {
    // CitationLint answers "is there a source"; FactCrossCheck answers "does
    // it say this". A brief passes the first and fails the second all the
    // time — that gap is the reason the second one exists.
    writeFileSync(join(workspace, "source.md"), "Deployments were rolled back twice in March.\n");
    const brief = "Deployments were rolled back four times in March [1].\n\n[1]: ./source.md\n";
    writeFileSync(join(workspace, "brief.md"), brief);

    const lint = await executeTool(
      lookup("CitationLint"),
      { file: "brief.md" },
      { toolUseId: "c1" },
    );
    expect(JSON.parse(lint.content)).toMatchObject({ ok: true, undefinedMarkers: [] });

    const cross = await executeTool(
      lookup("FactCrossCheck"),
      { file: "brief.md" },
      { toolUseId: "c2" },
    );
    const report = JSON.parse(cross.content);
    expect(report.ok).toBe(false);
    expect(report.claims[0].verdict).toBe("notFound");
    expect(report.claims[0].sources[0].missing).toEqual(["four", "time"]);
    // And the verdict says what it does not mean.
    expect(report.note).toContain("never that the source disagrees");
  });
});
