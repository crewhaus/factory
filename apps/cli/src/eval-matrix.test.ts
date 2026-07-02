/**
 * Unit tests for the item-11 `eval --models` matrix plumbing: model-list
 * parsing/validation against the router grammar, flag incompatibility,
 * slug generation (+ collision handling), the cost-tracker pricing seam,
 * and cell-failure isolation in the matrix loop.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import {
  MatrixArgError,
  assertMatrixFlagsCompatible,
  assignCellSlugs,
  cellCrashReason,
  defaultMatrixPricing,
  modelSlug,
  parseModelsFlag,
  runMatrixCells,
} from "./eval-matrix";

function makeSummary(model: string, passRate = 1): EvalRunSummary {
  return {
    runId: "run_aaaa1111aaaa1111",
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:30Z",
    samples: [],
    aggregates: {
      passRate,
      meanScore: passRate,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: 200,
      totalTokens: { input: 100, output: 200 },
      errorCount: 0,
    },
    config: {
      specHash: "abc123",
      datasetName: "fixture",
      graderNames: ["exact"],
      model,
      concurrency: 4,
    },
    outDir: "<tmp>",
  };
}

/** A summary whose samples errored (invoker failures the runner absorbed). */
function makeErroredSummary(model: string, errored: number, total: number): EvalRunSummary {
  const base = makeSummary(model, 0);
  const samples = Array.from({ length: total }, (_, i) => ({
    sampleId: `s${i + 1}`,
    sessionId: `sess_${String(i).padStart(16, "0")}`,
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:00:01Z",
    latencyMs: 0,
    turns: 0,
    tokens: { input: 0, output: 0 },
    model,
    agentOutput: "",
    grades: {
      overall: { passed: false, score: 0, rationale: "" },
      perGrader: [],
    },
    ...(i < errored ? { error: "401 invalid api key" } : {}),
  }));
  return {
    ...base,
    samples,
    aggregates: { ...base.aggregates, errorCount: errored },
  };
}

describe("parseModelsFlag", () => {
  test("parses a comma-separated list across the router grammar", () => {
    expect(
      parseModelsFlag("claude-sonnet-4-5,openai/gpt-4o,bedrock/us.anthropic.claude-sonnet-4"),
    ).toEqual(["claude-sonnet-4-5", "openai/gpt-4o", "bedrock/us.anthropic.claude-sonnet-4"]);
  });

  test("trims whitespace and tolerates a trailing comma", () => {
    expect(parseModelsFlag(" claude-haiku-4-5 , gemini/gemini-2.5-flash ,")).toEqual([
      "claude-haiku-4-5",
      "gemini/gemini-2.5-flash",
    ]);
  });

  test("fails fast on a typo before any cell runs", () => {
    expect(() => parseModelsFlag("claude-sonnet-4-5,gpt-4o")).toThrow(MatrixArgError);
    expect(() => parseModelsFlag("claude-sonnet-4-5,gpt-4o")).toThrow(/unrecognised model string/);
  });

  test("rejects an empty list and duplicates", () => {
    expect(() => parseModelsFlag(" , ,")).toThrow(/comma-separated list/);
    expect(() => parseModelsFlag("claude-sonnet-4-5,claude-sonnet-4-5")).toThrow(
      /duplicate model "claude-sonnet-4-5"/,
    );
  });
});

describe("assertMatrixFlagsCompatible", () => {
  test("rejects --gate and --no-promote; allows neither", () => {
    expect(() => assertMatrixFlagsCompatible({ gate: true, noPromote: false })).toThrow(
      /--models is incompatible with --gate/,
    );
    expect(() => assertMatrixFlagsCompatible({ gate: false, noPromote: true })).toThrow(
      /--models is incompatible with --no-promote/,
    );
    expect(() => assertMatrixFlagsCompatible({ gate: false, noPromote: false })).not.toThrow();
  });
});

describe("modelSlug / assignCellSlugs", () => {
  test("sanitizes router-grammar strings into readable directory names", () => {
    expect(modelSlug("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(modelSlug("openai/gpt-4o")).toBe("openai_gpt-4o");
    expect(modelSlug("bedrock/us.anthropic.claude-sonnet-4")).toBe(
      "bedrock_us.anthropic.claude-sonnet-4",
    );
    expect(modelSlug("local/llama3.2@http://localhost:11434/v1")).toBe(
      "local_llama3.2_http_localhost_11434_v1",
    );
  });

  test("falls back to a stable hash name when nothing safe survives", () => {
    const slug = modelSlug("///");
    expect(slug).toMatch(/^model_[0-9a-f]{8}$/);
    expect(modelSlug("///")).toBe(slug);
    // never a path-traversal hazard
    expect(modelSlug("..")).toMatch(/^model_[0-9a-f]{8}$/);
  });

  test("colliding slugs get deterministic numeric suffixes", () => {
    const slugs = assignCellSlugs(["openai/gpt.4o", "openai/gpt_4o", "openai/gpt-4o"]);
    expect(slugs.get("openai/gpt.4o")).toBe("openai_gpt.4o");
    expect(slugs.get("openai/gpt_4o")).toBe("openai_gpt_4o");
    expect(slugs.get("openai/gpt-4o")).toBe("openai_gpt-4o");
    const collide = assignCellSlugs(["openai/gpt@4o", "openai/gpt#4o"]);
    expect(collide.get("openai/gpt@4o")).toBe("openai_gpt_4o");
    expect(collide.get("openai/gpt#4o")).toBe("openai_gpt_4o_2");
  });
});

describe("defaultMatrixPricing", () => {
  const pricing = defaultMatrixPricing();

  test("prices known models via the versioned cost-tracker table", () => {
    // claude-sonnet-4-5: $3/M input, $15/M output → micros = in×3 + out×15
    expect(pricing("claude-sonnet-4-5", { input: 1000, output: 2000 })).toBe(1000 * 3 + 2000 * 15);
    // provider-prefixed grammar resolves too (openai/gpt-4o: $2.5/M + $10/M)
    expect(pricing("openai/gpt-4o", { input: 1000, output: 1000 })).toBe(2500 + 10000);
  });

  test("returns undefined (n/a) for unpriced or unparseable models", () => {
    // groq routes via the openai provider but has no pricing row
    expect(pricing("groq/llama-3.3-70b", { input: 1000, output: 1000 })).toBeUndefined();
    expect(pricing("not-a-model", { input: 1, output: 1 })).toBeUndefined();
  });
});

describe("cellCrashReason", () => {
  test("all-errored → reason; partial or empty → undefined", () => {
    expect(cellCrashReason(makeErroredSummary("m", 2, 2))).toBe(
      "all 2 sample(s) errored (first: 401 invalid api key)",
    );
    expect(cellCrashReason(makeErroredSummary("m", 1, 2))).toBeUndefined();
    expect(cellCrashReason(makeSummary("m"))).toBeUndefined();
  });
});

describe("runMatrixCells", () => {
  test("isolates a crashing cell and continues the remaining models", async () => {
    const models = ["claude-sonnet-4-5", "openai/gpt-4o", "claude-haiku-4-5"];
    const lines: string[] = [];
    const cells = await runMatrixCells({
      models,
      slugs: assignCellSlugs(models),
      rootDir: "/tmp/matrix-root",
      write: (l) => lines.push(l),
      runCell: async (model) => {
        if (model === "openai/gpt-4o") throw new Error("404 model not found");
        return makeSummary(model);
      },
    });

    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.model)).toEqual(models);
    expect(cells[0]?.summary?.config.model).toBe("claude-sonnet-4-5");
    expect(cells[0]?.error).toBeUndefined();
    expect(cells[1]?.summary).toBeUndefined();
    expect(cells[1]?.error).toBe("404 model not found");
    expect(cells[2]?.summary?.config.model).toBe("claude-haiku-4-5");
    expect(lines.some((l) => l.includes("cell FAILED (404 model not found)"))).toBe(true);
  });

  test("cells run in their own <root>/<slug> directories", async () => {
    const models = ["claude-sonnet-4-5", "openai/gpt-4o"];
    const seen: string[] = [];
    const cells = await runMatrixCells({
      models,
      slugs: assignCellSlugs(models),
      rootDir: "/tmp/matrix-root",
      write: () => {},
      runCell: async (model, cellOutDir) => {
        seen.push(cellOutDir);
        return makeSummary(model);
      },
    });
    expect(seen).toEqual([
      join("/tmp/matrix-root", "claude-sonnet-4-5"),
      join("/tmp/matrix-root", "openai_gpt-4o"),
    ]);
    expect(cells.map((c) => c.outDir)).toEqual(seen);
  });

  test("all samples erroring (absorbed bad credentials) becomes a cell failure", async () => {
    const models = ["openai/gpt-4o", "claude-sonnet-4-5"];
    const cells = await runMatrixCells({
      models,
      slugs: assignCellSlugs(models),
      rootDir: "/tmp/matrix-root",
      write: () => {},
      runCell: async (model) =>
        model === "openai/gpt-4o" ? makeErroredSummary(model, 2, 2) : makeSummary(model),
    });
    expect(cells[0]?.summary).toBeUndefined();
    expect(cells[0]?.error).toBe("all 2 sample(s) errored (first: 401 invalid api key)");
    expect(cells[1]?.summary?.config.model).toBe("claude-sonnet-4-5");
  });

  test("partial sample errors stay a normal 'ran with failing samples' cell", async () => {
    const models = ["openai/gpt-4o"];
    const cells = await runMatrixCells({
      models,
      slugs: assignCellSlugs(models),
      rootDir: "/tmp/matrix-root",
      write: () => {},
      runCell: async (model) => makeErroredSummary(model, 1, 3),
    });
    expect(cells[0]?.error).toBeUndefined();
    expect(cells[0]?.summary?.aggregates.errorCount).toBe(1);
  });

  test("non-Error throws are stringified into the error row", async () => {
    const models = ["claude-sonnet-4-5"];
    const cells = await runMatrixCells({
      models,
      slugs: assignCellSlugs(models),
      rootDir: "/tmp/matrix-root",
      write: () => {},
      runCell: async () => {
        throw "string blowup";
      },
    });
    expect(cells[0]?.error).toBe("string blowup");
  });
});
