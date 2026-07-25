/**
 * NEW-HUNT-5 — run-level surfacing of the semantic.similarity ROUGE-L
 * fallback: the detection contract (prefix pinned against the pack's
 * exported constant), `detectSemanticFallback` over sample results, the
 * `[eval] warning:` line, the additive `aggregates.semanticFallback`
 * results.json block, and the end-to-end runEval stderr warning — the
 * runner is the seam, so CLI evals and compiled bundles inherit it alike.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { GraderRegistry } from "@crewhaus/grader-registry";
import {
  SEMANTIC_FALLBACK_RATIONALE_PREFIX as PACK_PREFIX,
  semanticSimilarity,
} from "@crewhaus/grader-semantic-similarity";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { aggregate } from "./aggregate";
import { type AgentInvoker, runEval } from "./index";
import {
  SEMANTIC_FALLBACK_RATIONALE_PREFIX,
  detectSemanticFallback,
  formatSemanticFallbackWarning,
} from "./semantic-fallback";
import type { SampleResult } from "./types";

const SPEC = `name: semantic-fallback-test
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
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-semfallback-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function sampleResult(
  sampleId: string,
  perGrader: Array<{ name: string; passed: boolean; score: number; rationale: string }>,
): SampleResult {
  return {
    sampleId,
    sessionId: "sess",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    latencyMs: 1000,
    turns: 1,
    tokens: { input: 1, output: 1 },
    model: "m",
    agentOutput: "out",
    grades: {
      overall: {
        passed: perGrader.every((g) => g.passed),
        score: perGrader[0]?.score ?? 0,
        rationale: perGrader.map((g) => g.rationale).join("; "),
      },
      perGrader,
    },
  };
}

describe("semantic-fallback detection contract (NEW-HUNT-5)", () => {
  test("the runner's prefix constant matches the pack's exported one", () => {
    // The constant is DUPLICATED (the runner must not import the pack
    // eagerly); this equality is the contract that keeps detection honest.
    expect(SEMANTIC_FALLBACK_RATIONALE_PREFIX).toBe(PACK_PREFIX);
  });

  test("detectSemanticFallback counts marked samples and extracts the embedder error", () => {
    const results = [
      sampleResult("s1", [
        { name: "sem", passed: true, score: 0.8, rationale: "cosine 0.8000 (threshold 0.70)" },
      ]),
      sampleResult("s2", [
        {
          name: "sem",
          passed: false,
          score: 0.2,
          rationale: `${SEMANTIC_FALLBACK_RATIONALE_PREFIX}quota exceeded (429)] ROUGE-L 0.20`,
        },
      ]),
      sampleResult("s3", [
        {
          name: "sem",
          passed: true,
          score: 0.7,
          rationale: `${SEMANTIC_FALLBACK_RATIONALE_PREFIX}quota exceeded (429)] ROUGE-L 0.70`,
        },
      ]),
    ];
    const fb = detectSemanticFallback(results);
    expect(fb).toEqual({
      sampleCount: 2,
      sampleIds: ["s2", "s3"],
      embedderError: "quota exceeded (429)",
    });
  });

  test("no marker ⇒ undefined (fallback-free runs stay byte-identical)", () => {
    const results = [
      sampleResult("s1", [{ name: "g", passed: true, score: 1, rationale: "exact match" }]),
    ];
    expect(detectSemanticFallback(results)).toBeUndefined();
    const aggregates = aggregate(results);
    expect("semanticFallback" in aggregates).toBe(false);
  });

  test("aggregate() attaches the additive semanticFallback block", () => {
    const results = [
      sampleResult("s1", [
        {
          name: "sem",
          passed: false,
          score: 0,
          rationale: `${SEMANTIC_FALLBACK_RATIONALE_PREFIX}missing API key] ROUGE-L 0.00`,
        },
      ]),
    ];
    const aggregates = aggregate(results);
    expect(aggregates.semanticFallback).toEqual({
      sampleCount: 1,
      sampleIds: ["s1"],
      embedderError: "missing API key",
    });
  });

  test("the warning line names count, embedder error, samples, and the opt-out", () => {
    const line = formatSemanticFallbackWarning({
      sampleCount: 2,
      sampleIds: ["s2", "s3"],
      embedderError: "quota exceeded (429)",
    });
    expect(line).toStartWith("[eval] warning: 2 sample(s) graded by ROUGE-L fallback");
    expect(line).toContain("quota exceeded (429)");
    expect(line).toContain("s2, s3");
    expect(line).toContain("disableFallback");
  });
});

describe("runEval — run-level fallback warning (NEW-HUNT-5)", () => {
  test("a real pack fallback lands in results.json AND on stderr", async () => {
    const registry = new GraderRegistry();
    // The REAL pack with an embedder that errors — the exact production
    // degradation (quota/network/key), minus the network.
    registry.register(
      "semantic.similarity",
      semanticSimilarity({
        embedder: {
          provider: "mock",
          model: "broken/embedder",
          embed: async () => {
            throw new Error("simulated quota exceeded");
          },
        },
      }),
    );
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: close\n    type: registry\n    grader: semantic.similarity\n",
    );
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.expected_output ?? "",
      events: [],
    });
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    let summary: Awaited<ReturnType<typeof runEval>>;
    try {
      summary = await runEval({
        ir: narrowToAgent(lower(parseSpec(SPEC))),
        dataset: {
          name: "fallback",
          samples: yieldSamples([
            { id: "s1", input: "x", expected_output: "hello world" },
            { id: "s2", input: "y", expected_output: "goodbye moon" },
          ]),
        },
        compiledGraders: compiled,
        opts: { invoker, outDir: newTempRoot(), graderRegistry: registry },
      });
    } finally {
      spy.mockRestore();
    }
    // Per-sample: the rationale prefix stays exactly as before.
    for (const s of summary.samples) {
      expect(s.grades.perGrader[0]?.rationale).toStartWith(SEMANTIC_FALLBACK_RATIONALE_PREFIX);
    }
    // Run level: the additive results.json block…
    expect(summary.aggregates.semanticFallback).toEqual({
      sampleCount: 2,
      sampleIds: ["s1", "s2"],
      embedderError: "simulated quota exceeded",
    });
    // …and the [eval] warning: stderr line, from the runner itself —
    // emitted EXACTLY ONCE per run (a regression moving the write into the
    // per-sample path would emit it per sample; joined-string toContain
    // could not catch that).
    const warningWrites = writes.filter((w) => w.includes("[eval] warning:"));
    expect(warningWrites).toHaveLength(1);
    const logged = writes.join("");
    expect(logged).toContain("[eval] warning: 2 sample(s) graded by ROUGE-L fallback");
    expect(logged).toContain("simulated quota exceeded");
    expect(logged).toContain("s1, s2");
  });
});
