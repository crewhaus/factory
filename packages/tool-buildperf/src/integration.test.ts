import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { BUILDPERF_TOOLS } from "./index";

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
  for (const tool of BUILDPERF_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-buildperf-int-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(BUILDPERF_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of BUILDPERF_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    mkdirSync(join(workspace, "dist"));
    writeFileSync(join(workspace, "dist", "app.js"), "export const a = 1;\n".repeat(50));
    const inputs: Record<string, unknown> = {
      BundleSizeCheck: { files: ["dist/app.js"] },
      BenchmarkCompare: {
        benchmarks: [{ name: "b", base: [1, 2, 3], head: [1, 2, 3] }],
        noiseFloorPercent: 2,
      },
      FlakyTestDetect: { runs: [{ tests: [{ id: "t", status: "pass" }] }] },
    };
    for (const tool of BUILDPERF_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("BenchmarkCompare"),
      { benchmarks: [{ name: "b", base: "not an array", head: [1] }], noiseFloorPercent: 1 },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(true);
  });

  test("the required noise floor is enforced by the schema, not by a default", async () => {
    const benchmarks = [{ name: "b", base: [1, 2], head: [1, 2] }];
    const without = await executeTool(
      lookup("BenchmarkCompare"),
      { benchmarks },
      {
        toolUseId: "t2a",
      },
    );
    // The executor's message names the tool, not the field, so the missing
    // floor is pinned differentially: the ONLY difference between these two
    // calls is the floor, and it decides whether the call is dispatchable.
    const with_ = await executeTool(
      lookup("BenchmarkCompare"),
      { benchmarks, noiseFloorPercent: 2 },
      { toolUseId: "t2b" },
    );
    expect({ without: without.isError, with: with_.isError }).toEqual({
      without: true,
      with: false,
    });
  });

  test("files and directory together are refused by the schema", async () => {
    const result = await executeTool(
      lookup("BundleSizeCheck"),
      { files: ["dist/app.js"], directory: "dist" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("exactly one");
  });

  test("join=custom without a pattern is refused by the schema", async () => {
    const result = await executeTool(
      lookup("BundleSizeCheck"),
      { files: ["dist/app.js"], join: "custom" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("joinPattern");
  });

  test("a containment escape is an error result, not a crash", async () => {
    const result = await executeTool(
      lookup("BundleSizeCheck"),
      { files: ["../../etc/passwd"] },
      { toolUseId: "t5" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace");
  });
});

describe("the gate these exist for", () => {
  test("a size baseline from another compression level fails the gate as indeterminate, not as green", async () => {
    // The sequence a merge gate actually runs: measure, compare, decide. The
    // decision here is "I cannot tell you", and it must not read as a pass.
    mkdirSync(join(workspace, "dist"));
    writeFileSync(join(workspace, "dist", "app.js"), "export const a = 1;\n".repeat(500));
    const first = await executeTool(
      lookup("BundleSizeCheck"),
      { files: ["dist/app.js"], level: 9 },
      { toolUseId: "g1" },
    );
    const baseline = JSON.parse(first.content) as Record<string, unknown>;

    const same = await executeTool(
      lookup("BundleSizeCheck"),
      { files: ["dist/app.js"], level: 9, baseline },
      { toolUseId: "g2" },
    );
    expect(JSON.parse(same.content).verdict).toBe("pass");

    const other = await executeTool(
      lookup("BundleSizeCheck"),
      { files: ["dist/app.js"], level: 6, baseline },
      { toolUseId: "g3" },
    );
    const report = JSON.parse(other.content);
    expect(report.verdict).toBe("indeterminate");
    expect(report.comparison.status).toBe("refused");
    expect(other.content).not.toContain("deltaPercent");
  });

  test("the three tools agree on what a run of five cannot establish", async () => {
    // Five samples cannot support a significance call, and five runs cannot
    // pin a failure rate. Both tools say so in their own vocabulary rather
    // than producing a number, which is the property the package is for.
    const bench = await executeTool(
      lookup("BenchmarkCompare"),
      {
        benchmarks: [{ name: "parse", base: [10, 11, 12, 13, 14], head: [20, 21, 22, 23, 24] }],
        noiseFloorPercent: 1,
      },
      { toolUseId: "g4" },
    );
    expect(JSON.parse(bench.content).verdict).toBe("inconclusive");

    const flaky = await executeTool(
      lookup("FlakyTestDetect"),
      {
        runs: (["fail", "fail", "fail", "pass", "pass"] as const).map((status) => ({
          tests: [{ id: "t", status }],
        })),
      },
      { toolUseId: "g5" },
    );
    const report = JSON.parse(flaky.content);
    expect(report.tests[0].failureRate.width).toBeGreaterThan(0.6);
    expect(report.tests[0].why).toContain("interval");
  });
});
