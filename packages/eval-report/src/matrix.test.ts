/**
 * Unit tests for the item-11 model-matrix renderer: metric rows built from
 * synthetic run dirs (via loadRun, exactly like the CLI consumes cells),
 * pricing-miss "n/a" behavior, best-value highlighting in the JSON payload
 * and the HTML table, and error-cell isolation.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import {
  type MatrixCell,
  type MatrixPricingFn,
  type ModelMatrix,
  buildMatrix,
  formatUsd,
  loadRun,
  renderMatrix,
} from "./index";

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-eval-matrix-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function makeSampleResult(id: string, passed: boolean, score: number): SampleResult {
  return {
    sampleId: id,
    sessionId: `sess_${id.padEnd(16, "0")}`,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs: 100,
    turns: 1,
    tokens: { input: 10, output: 20 },
    model: "claude-opus-4-7",
    agentOutput: passed ? "correct" : "wrong",
    grades: {
      overall: { passed, score, rationale: passed ? "ok" : "wrong answer" },
      perGrader: [{ name: "exact", passed, score, rationale: "" }],
    },
  };
}

type SummaryOverrides = {
  readonly passRate?: number;
  readonly meanScore?: number;
  readonly p95LatencyMs?: number;
  readonly totalTokens?: { input: number; output: number };
  readonly errorCount?: number;
};

function makeRunSummary(
  runId: string,
  model: string,
  samples: SampleResult[],
  overrides: SummaryOverrides = {},
): EvalRunSummary {
  const passRate =
    samples.length === 0
      ? 0
      : samples.filter((s) => s.grades.overall.passed).length / samples.length;
  const meanScore =
    samples.length === 0
      ? 0
      : samples.reduce((s, x) => s + x.grades.overall.score, 0) / samples.length;
  return {
    runId,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:30Z",
    samples,
    aggregates: {
      passRate: overrides.passRate ?? passRate,
      meanScore: overrides.meanScore ?? meanScore,
      p50Turns: 1,
      p95Turns: 1,
      p50LatencyMs: 100,
      p95LatencyMs: overrides.p95LatencyMs ?? 100,
      totalTokens: overrides.totalTokens ?? {
        input: 10 * samples.length,
        output: 20 * samples.length,
      },
      errorCount: overrides.errorCount ?? 0,
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

function persistRun(dir: string, summary: EvalRunSummary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "results.json"), JSON.stringify(summary, null, 2));
}

/** Persist a synthetic run dir under `<root>/<slug>` and load it back the
 *  way the CLI does — so the matrix consumes real results.json aggregates. */
async function cellFromRunDir(
  root: string,
  model: string,
  slug: string,
  summary: EvalRunSummary,
): Promise<MatrixCell> {
  const outDir = join(root, slug);
  persistRun(outDir, summary);
  const loaded = await loadRun(outDir);
  return { model, slug, outDir, summary: loaded.summary };
}

/** Deterministic table-backed pricing: micro-USD per (input, output) token. */
const stubPricing: MatrixPricingFn = (model, tokens) => {
  const table: Record<string, { inPerTok: number; outPerTok: number }> = {
    "cheap-model": { inPerTok: 1, outPerTok: 5 },
    "pricey-model": { inPerTok: 15, outPerTok: 75 },
  };
  const row = table[model];
  if (row === undefined) return undefined;
  return Math.round(tokens.input * row.inPerTok + tokens.output * row.outPerTok);
};

describe("buildMatrix", () => {
  test("builds metric rows + cost projection from synthetic run dirs", async () => {
    const root = newTempRoot();
    const cheap = await cellFromRunDir(
      root,
      "cheap-model",
      "cheap-model",
      makeRunSummary("run_aaaa1111aaaa1111", "cheap-model", [
        makeSampleResult("s1", true, 1),
        makeSampleResult("s2", false, 0.2),
      ]),
    );
    const pricey = await cellFromRunDir(
      root,
      "pricey-model",
      "pricey-model",
      makeRunSummary(
        "run_bbbb2222bbbb2222",
        "pricey-model",
        [makeSampleResult("s1", true, 1), makeSampleResult("s2", true, 0.9)],
        { p95LatencyMs: 400 },
      ),
    );

    const matrix = buildMatrix([cheap, pricey], {
      pricing: stubPricing,
      now: () => new Date("2026-07-01T00:00:00Z"),
    });

    expect(matrix.generatedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(matrix.datasetName).toBe("fixture");
    expect(matrix.rows).toHaveLength(2);

    const [a, b] = matrix.rows;
    expect(a?.status).toBe("ok");
    expect(a?.runId).toBe("run_aaaa1111aaaa1111");
    expect(a?.passRate).toBe(0.5);
    expect(a?.meanScore).toBeCloseTo(0.6);
    expect(a?.sampleCount).toBe(2);
    expect(a?.totalTokens).toEqual({ input: 20, output: 40 });
    // 20×1 + 40×5 = 220 micro-USD over 2 samples → $/1k = 220 / (1000×2)
    expect(a?.costMicros).toBe(220);
    expect(a?.costPer1kSamplesUsd).toBeCloseTo(0.11);
    expect(b?.passRate).toBe(1);
    expect(b?.costMicros).toBe(20 * 15 + 40 * 75);
  });

  test("unknown-model pricing yields no cost fields (n/a), never a crash", async () => {
    const root = newTempRoot();
    const cell = await cellFromRunDir(
      root,
      "mystery/model",
      "mystery_model",
      makeRunSummary("run_cccc3333cccc3333", "mystery/model", [makeSampleResult("s1", true, 1)]),
    );
    const matrix = buildMatrix([cell], { pricing: stubPricing });
    const row = matrix.rows[0];
    expect(row?.status).toBe("ok");
    expect(row?.costMicros).toBeUndefined();
    expect(row?.costPer1kSamplesUsd).toBeUndefined();
    expect(matrix.best.costPer1kSamplesUsd).toEqual([]);

    const { html, json } = renderMatrix(matrix);
    expect(html).toContain("n/a");
    expect(JSON.parse(json).rows[0]).not.toHaveProperty("costMicros");
  });

  test("no pricing fn at all → cost columns are n/a", async () => {
    const root = newTempRoot();
    const cell = await cellFromRunDir(
      root,
      "cheap-model",
      "cheap-model",
      makeRunSummary("run_dddd4444dddd4444", "cheap-model", [makeSampleResult("s1", true, 1)]),
    );
    const matrix = buildMatrix([cell]);
    expect(matrix.rows[0]?.costPer1kSamplesUsd).toBeUndefined();
  });

  test("best per metric: max pass/score, min p95/cost, ties all listed, error cells never win", async () => {
    const root = newTempRoot();
    const cheap = await cellFromRunDir(
      root,
      "cheap-model",
      "cheap-model",
      makeRunSummary(
        "run_aaaa1111aaaa1111",
        "cheap-model",
        [makeSampleResult("s1", true, 1), makeSampleResult("s2", true, 1)],
        { p95LatencyMs: 100 },
      ),
    );
    const pricey = await cellFromRunDir(
      root,
      "pricey-model",
      "pricey-model",
      makeRunSummary(
        "run_bbbb2222bbbb2222",
        "pricey-model",
        [makeSampleResult("s1", true, 1), makeSampleResult("s2", true, 1)],
        { p95LatencyMs: 50 },
      ),
    );
    const broken: MatrixCell = {
      model: "broken/model",
      slug: "broken_model",
      outDir: join(root, "broken_model"),
      error: "401 invalid credentials",
    };

    const matrix = buildMatrix([cheap, pricey, broken], { pricing: stubPricing });
    // Identical pass rate + mean score → tie lists both, in row order.
    expect(matrix.best.passRate).toEqual(["cheap-model", "pricey-model"]);
    expect(matrix.best.meanScore).toEqual(["cheap-model", "pricey-model"]);
    expect(matrix.best.p95LatencyMs).toEqual(["pricey-model"]);
    expect(matrix.best.costPer1kSamplesUsd).toEqual(["cheap-model"]);
    // The error cell appears as a row but never wins a metric.
    expect(matrix.rows[2]?.status).toBe("error");
    expect(matrix.rows[2]?.error).toBe("401 invalid credentials");
    for (const winners of Object.values(matrix.best)) {
      expect(winners).not.toContain("broken/model");
    }
  });

  test("all cells errored → empty best lists, matrix still renders", () => {
    const matrix = buildMatrix([
      { model: "a-model", slug: "a-model", outDir: "/tmp/a", error: "boom" },
    ]);
    expect(matrix.best.passRate).toEqual([]);
    const { html } = renderMatrix(matrix);
    expect(html).toContain("Failed cells (1)");
    expect(html).toContain("boom");
  });
});

describe("renderMatrix", () => {
  async function twoModelMatrix(): Promise<ModelMatrix> {
    const root = newTempRoot();
    const cheap = await cellFromRunDir(
      root,
      "cheap-model",
      "cheap-model",
      makeRunSummary("run_aaaa1111aaaa1111", "cheap-model", [
        makeSampleResult("s1", true, 1),
        makeSampleResult("s2", false, 0),
      ]),
    );
    const pricey = await cellFromRunDir(
      root,
      "pricey-model",
      "pricey-model",
      makeRunSummary("run_bbbb2222bbbb2222", "pricey-model", [
        makeSampleResult("s1", true, 1),
        makeSampleResult("s2", true, 1),
      ]),
    );
    return buildMatrix([cheap, pricey], { pricing: stubPricing });
  }

  test("one table with best-value cells highlighted and per-cell report links", async () => {
    const matrix = await twoModelMatrix();
    const { html } = renderMatrix(matrix);
    expect(html).toContain("<table data-sortable>");
    // pricey-model wins passRate/meanScore; cheap-model wins cost — both
    // rows carry at least one highlighted cell.
    expect(html).toContain('class="best"');
    expect(html).toContain('<td class="best" data-sort="1">100.0%</td>');
    expect(html).toContain('href="cheap-model/index.html"');
    expect(html).toContain('href="pricey-model/index.html"');
  });

  test("json payload round-trips the matrix including the best map", async () => {
    const matrix = await twoModelMatrix();
    const parsed = JSON.parse(renderMatrix(matrix).json) as ModelMatrix;
    expect(parsed.best.passRate).toEqual(["pricey-model"]);
    expect(parsed.best.costPer1kSamplesUsd).toEqual(["cheap-model"]);
    expect(parsed.rows.map((r) => r.model)).toEqual(["cheap-model", "pricey-model"]);
  });

  test("model strings and error text are HTML-escaped", () => {
    const matrix = buildMatrix([
      {
        model: "<script>alert(1)</script>",
        slug: "hax",
        outDir: "/tmp/hax",
        error: '<img src=x onerror="pwn()">',
      },
    ]);
    const { html } = renderMatrix(matrix);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<img src=x onerror="pwn()">');
  });
});

describe("formatUsd", () => {
  test("scales precision with magnitude", () => {
    expect(formatUsd(123.4)).toBe("$123");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.00042)).toBe("$0.0004");
  });
});
