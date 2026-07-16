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
  classifyCellError,
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
function makeErroredSummary(
  model: string,
  errored: number,
  total: number,
  errorMsg = "401 invalid api key",
): EvalRunSummary {
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
    ...(i < errored ? { error: errorMsg } : {}),
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

describe("classifyCellError", () => {
  test("systemic: auth / bad request / missing model — re-running won't help", () => {
    for (const msg of [
      "401 invalid x-api-key",
      "403 Forbidden",
      "404 model not found",
      "unknown model 'gpt-9'",
      "400 invalid_request_error: unsupported model",
    ]) {
      expect(classifyCellError(msg)).toBe("systemic");
    }
  });

  test("billing: quota / credit exhaustion — re-running won't help (add credits)", () => {
    for (const msg of [
      // The real OpenAI out-of-funds message: a 429 that is NOT a rate limit.
      "429 You exceeded your current quota, please check your plan and billing details.",
      "402 payment required",
      "insufficient_quota: your credit balance is too low",
      "400 Your credit balance is too low to access the Anthropic API",
      "429 Resource has been exhausted (e.g. check quota).",
      "ServiceQuotaExceededException: ...",
    ]) {
      expect(classifyCellError(msg)).toBe("billing");
    }
  });

  test("transient: genuine rate limits, overloads, 5xx, network blips — re-running might help", () => {
    for (const msg of [
      "429 Too Many Requests",
      "Rate limit reached for gpt-4o, please try again in 20ms",
      "529 Overloaded",
      "500 internal server error",
      "503 service unavailable",
      "overloaded_error",
      "request timed out",
      "ECONNRESET: socket hang up",
    ]) {
      expect(classifyCellError(msg)).toBe("transient");
    }
  });

  test("unknown: text matching no bucket", () => {
    expect(classifyCellError("something inexplicable happened")).toBe("unknown");
    expect(classifyCellError("")).toBe("unknown");
  });
});

describe("cellCrashReason", () => {
  test("all-errored → classified reason; partial or empty → undefined", () => {
    // Systemic first error (a bad credential) — flagged as such.
    expect(cellCrashReason(makeErroredSummary("m", 2, 2))).toBe(
      "all 2 sample(s) errored (first: 401 invalid api key) — looks systemic (auth/config/model); " +
        "re-running won't help — check the model id and credentials",
    );
    expect(cellCrashReason(makeErroredSummary("m", 1, 2))).toBeUndefined();
    expect(cellCrashReason(makeSummary("m"))).toBeUndefined();
  });

  test("a 1-sample cell felled by a transient blip reads differently from a bad credential", () => {
    // The documented limitation: with 1 sample, a transient error and a bad
    // credential are otherwise indistinguishable (1 sample, 1 error). The
    // classified reason tells them apart.
    const transient = cellCrashReason(makeErroredSummary("m", 1, 1, "529 Overloaded"));
    expect(transient).toBe(
      "all 1 sample(s) errored (first: 529 Overloaded) — looks like a transient provider error; " +
        "re-run to confirm",
    );
    const systemic = cellCrashReason(makeErroredSummary("m", 1, 1, "401 invalid api key"));
    expect(systemic).toContain("looks systemic");
    expect(transient).not.toBe(systemic);
  });

  test("a 429 quota-exhaustion is billing, NOT a transient rate limit (don't say 're-run')", () => {
    // Regression guard: the real OpenAI out-of-funds error is a 429 whose
    // correct remedy is 'add credits', never 're-run to confirm'.
    const reason = cellCrashReason(
      makeErroredSummary(
        "m",
        1,
        1,
        "429 You exceeded your current quota, please check your plan and billing details.",
      ),
    );
    expect(reason).toContain("quota/billing limit");
    expect(reason).not.toContain("re-run to confirm");
  });

  test("an unrecognized error keeps the bare reason (no misleading hint)", () => {
    expect(cellCrashReason(makeErroredSummary("m", 1, 1, "kaboom"))).toBe(
      "all 1 sample(s) errored (first: kaboom)",
    );
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
    expect(cells[0]?.error).toBe(
      "all 2 sample(s) errored (first: 401 invalid api key) — looks systemic (auth/config/model); " +
        "re-running won't help — check the model id and credentials",
    );
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
