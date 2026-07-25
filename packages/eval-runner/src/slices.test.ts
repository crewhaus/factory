/**
 * B13 — metadata slice aggregation: the `computeSlices` grouping rules
 * (string values only; missing keys skip the sample; empty → omitted) and
 * the runEval wiring (metadata carried into SampleResult, `slices` in
 * results.json, `sliceKeys` override + validation, and the no-metadata
 * byte-compat guarantee).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type AgentInvoker, runEval } from "./index";
import { DEFAULT_SLICE_KEYS, computeSlices } from "./slices";
import type { SampleResult } from "./types";

const SPEC = `name: slices-test
target: cli
agent:
  model: claude-opus-4-7
  instructions: test
`;

function narrowToAgent(ir: IrNode): IrV0 {
  if (ir.target !== "cli") throw new Error(`expected target:cli, got ${ir.target}`);
  return ir;
}

async function* yieldSamples(samples: Sample[]): AsyncIterable<Sample> {
  for (const s of samples) yield s;
}

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-slices-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const GRADERS = "graders:\n  - name: m\n    type: exact_match\n";

function result(overrides: Partial<SampleResult> & { sampleId: string }): SampleResult {
  return {
    sessionId: "sess",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    latencyMs: 10,
    turns: 1,
    tokens: { input: 0, output: 0 },
    model: "m",
    agentOutput: "",
    grades: { overall: { passed: true, score: 1, rationale: "ok" }, perGrader: [] },
    ...overrides,
  };
}

describe("computeSlices (B13)", () => {
  test("groups by string metadata values; count/passRate/meanScore per group", () => {
    const slices = computeSlices(
      [
        result({ sampleId: "a", metadata: { difficulty: "easy" } }),
        result({ sampleId: "b", metadata: { difficulty: "easy" } }),
        result({
          sampleId: "c",
          metadata: { difficulty: "hard" },
          grades: { overall: { passed: false, score: 0.4, rationale: "no" }, perGrader: [] },
        }),
      ],
      ["difficulty"],
    );
    expect(slices).toEqual({
      difficulty: {
        easy: { sampleCount: 2, passRate: 1, meanScore: 1 },
        hard: { sampleCount: 1, passRate: 0, meanScore: 0.4 },
      },
    });
  });

  test("non-string metadata values are provenance, not slice labels", () => {
    const slices = computeSlices(
      [
        result({ sampleId: "a", metadata: { difficulty: 3 } }),
        result({ sampleId: "b", metadata: { difficulty: ["easy"] } }),
        result({ sampleId: "c", metadata: { difficulty: { level: "easy" } } }),
        result({ sampleId: "d", metadata: { difficulty: "easy" } }),
      ],
      ["difficulty"],
    );
    expect(slices?.["difficulty"]).toEqual({
      easy: { sampleCount: 1, passRate: 1, meanScore: 1 },
    });
  });

  test("samples missing the key just skip that grouping; keys with no groups are omitted", () => {
    const slices = computeSlices(
      [
        result({ sampleId: "a", metadata: { family: "billing" } }),
        result({ sampleId: "b" }), // no metadata at all
      ],
      DEFAULT_SLICE_KEYS,
    );
    expect(Object.keys(slices ?? {})).toEqual(["family"]);
    expect(slices?.["family"]?.["billing"]?.sampleCount).toBe(1);
  });

  test("nothing sliced → undefined (not an empty record)", () => {
    expect(computeSlices([result({ sampleId: "a" })], DEFAULT_SLICE_KEYS)).toBeUndefined();
    expect(computeSlices([], ["difficulty"])).toBeUndefined();
  });

  test("errored samples count as failures; abstained ones leave the denominator", () => {
    const slices = computeSlices(
      [
        result({ sampleId: "a", metadata: { difficulty: "hard" } }),
        result({
          sampleId: "b",
          metadata: { difficulty: "hard" },
          error: "boom",
          grades: { overall: { passed: false, score: 0, rationale: "err" }, perGrader: [] },
        }),
        result({
          sampleId: "c",
          metadata: { difficulty: "hard" },
          grades: {
            overall: { passed: false, score: 0, rationale: "?", abstained: true },
            perGrader: [],
          },
        }),
      ],
      ["difficulty"],
    );
    const hard = slices?.["difficulty"]?.["hard"];
    // 3 members; abstained c leaves the denominator → 1 pass / 2 graded.
    // meanScore averages the scored samples only (a): errored b produced no
    // gradeable output and abstained c's 0 is a placeholder.
    expect(hard).toEqual({ sampleCount: 3, passRate: 0.5, meanScore: 1 });
  });

  test("values are emitted in sorted order for stable results.json", () => {
    const slices = computeSlices(
      [
        result({ sampleId: "a", metadata: { language: "sv" } }),
        result({ sampleId: "b", metadata: { language: "de" } }),
        result({ sampleId: "c", metadata: { language: "en" } }),
      ],
      ["language"],
    );
    expect(Object.keys(slices?.["language"] ?? {})).toEqual(["de", "en", "sv"]);
  });
});

describe("runEval — slices wiring (B13)", () => {
  // Echo the expectation unless the sample flags itself wrong (a boolean —
  // deliberately NOT a string, so it never becomes a slice label).
  const invoker: AgentInvoker = async ({ sample }) => ({
    agentOutput: sample.metadata?.["wrong"] === true ? "WRONG" : (sample.expected_output ?? ""),
    events: [],
  });

  test("metadata rides into SampleResult and default-key slices land in results.json", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "sliced",
        samples: yieldSamples([
          {
            id: "s1",
            input: "x",
            expected_output: "x",
            metadata: { difficulty: "easy", rev: 3 },
          },
          {
            id: "s2",
            input: "y",
            expected_output: "y",
            metadata: { difficulty: "hard", wrong: true },
          },
        ]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });

    expect(summary.samples.find((s) => s.sampleId === "s1")?.metadata).toEqual({
      difficulty: "easy",
      rev: 3,
    });
    expect(summary.slices).toEqual({
      difficulty: {
        easy: { sampleCount: 1, passRate: 1, meanScore: 1 },
        hard: { sampleCount: 1, passRate: 0, meanScore: 0 },
      },
    });

    // Persisted results.json carries the same block.
    const persisted = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8"));
    expect(persisted.slices.difficulty.easy.sampleCount).toBe(1);
  });

  test("sliceKeys overrides the defaults", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "sliced-custom",
        samples: yieldSamples([
          {
            id: "s1",
            input: "x",
            expected_output: "x",
            metadata: { difficulty: "easy", region: "eu" },
          },
        ]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir, sliceKeys: ["region"] },
    });
    expect(Object.keys(summary.slices ?? {})).toEqual(["region"]);
  });

  test("metadata-less datasets omit slices entirely (pre-B13 shape)", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(GRADERS);
    const summary = await runEval({
      ir,
      dataset: {
        name: "plain",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "x" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir },
    });
    expect("slices" in summary).toBe(false);
    expect("metadata" in (summary.samples[0] ?? {})).toBe(false);
    const persisted = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8"));
    expect("slices" in persisted).toBe(false);
  });

  test("a blank slice key is a loud config error at run start", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const { compiled } = parseGradersConfig(GRADERS);
    await expect(
      runEval({
        ir,
        dataset: {
          name: "bad-keys",
          samples: yieldSamples([{ id: "s1", input: "x", expected_output: "x" }]),
        },
        compiledGraders: compiled,
        opts: { invoker, outDir, sliceKeys: ["difficulty", " "] },
      }),
    ).rejects.toThrow(/sliceKeys/);
  });
});
