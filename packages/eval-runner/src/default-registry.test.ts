/**
 * Loop contract 0.4 (Batch B, G14) — the default GraderRegistry: the six
 * specialty packs registered under namespaced names, `.crewhaus/graders`
 * plugin discovery on top, and `runEval` constructing it automatically
 * when a graders file declares `type: registry` and the caller supplied
 * no registry of its own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import type { Sample } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import type { IrNode, IrV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { defaultGraderRegistry } from "./default-registry";
import { type AgentInvoker, runEval } from "./index";

const SPEC = `name: default-registry-test
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
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-defreg-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const RUN_RESULT = {
  agentOutput: "the quick brown fox",
  events: [],
  transcript: [],
  toolCalls: [],
  turns: 1,
  latencyMs: 1,
};

describe("defaultGraderRegistry (G14)", () => {
  test("registers all six specialty packs under namespaced names", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const names = registry.list();
    // One representative name per pack + the full nlg surface.
    for (const expected of [
      "continuity.reAskRate",
      "continuity.pickupSuccess",
      "twelve.contextRelevance",
      "twelve.p99LatencyMs",
      "nlg.rouge1",
      "nlg.rouge2",
      "nlg.rougeL",
      "nlg.bleu1",
      "nlg.bleu2",
      "nlg.bleu3",
      "nlg.bleu4",
      "nlg.meteor",
      "semantic.similarity",
      "multimodal.imageSimilarity",
      "multimodal.imageOcrThenGrade",
      "multimodal.audioTranscriptMatch",
      "safety.piiLeak",
      "safety.toxicity",
      "safety.bias",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("nlg.rougeL grades for real at pack defaults", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const grader = registry.lookup("nlg.rougeL");
    const sample: Sample = { id: "s", input: "x", expected_output: "the quick brown fox" };
    const result = await grader(sample, RUN_RESULT);
    expect(result.passed).toBe(true);
    expect(result.score).toBeCloseTo(1);
  });

  test("safety.piiLeak grades for real with the built-in detectors", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const grader = registry.lookup("safety.piiLeak");
    const sample: Sample = { id: "s", input: "x" };
    const leak = await grader(sample, { ...RUN_RESULT, agentOutput: "mail bob@example.com now" });
    expect(leak.passed).toBe(false);
    const clean = await grader(sample, RUN_RESULT);
    expect(clean.passed).toBe(true);
  });

  test("dep-requiring graders are registered as wiring-explaining throwers", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const sample: Sample = { id: "s", input: "x" };
    expect(registry.lookup("safety.toxicity")(sample, RUN_RESULT)).rejects.toThrow(/Classifier/);
    expect(registry.lookup("multimodal.imageOcrThenGrade")(sample, RUN_RESULT)).rejects.toThrow(
      /ocr/,
    );
  });

  test("semantic.similarity without the embedder env is a loud, teaching error", async () => {
    const prev = process.env["CREWHAUS_EVAL_EMBEDDER"];
    // Empty string counts as unset (assigning undefined would coerce to the
    // literal string "undefined" on process.env).
    process.env["CREWHAUS_EVAL_EMBEDDER"] = "";
    try {
      const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
      const sample: Sample = { id: "s", input: "x", expected_output: "y" };
      expect(registry.lookup("semantic.similarity")(sample, RUN_RESULT)).rejects.toThrow(
        /CREWHAUS_EVAL_EMBEDDER/,
      );
    } finally {
      if (prev !== undefined) process.env["CREWHAUS_EVAL_EMBEDDER"] = prev;
    }
  });

  test("plugin graders are discovered last and override pack names", async () => {
    const root = newTempRoot();
    const pluginRoot = join(root, ".crewhaus", "graders");
    mkdirSync(join(pluginRoot, "custom"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "custom", "index.ts"),
      `export default [
  { name: "custom.always", grader: async () => ({ passed: true, score: 1, rationale: "plugin" }) },
  { name: "nlg.rougeL", grader: async () => ({ passed: true, score: 0.42, rationale: "override" }) },
];
`,
    );
    const registry = await defaultGraderRegistry({ cwd: root });
    expect(registry.has("custom.always")).toBe(true);
    const sample: Sample = { id: "s", input: "x", expected_output: "zzz" };
    const overridden = await registry.lookup("nlg.rougeL")(sample, RUN_RESULT);
    expect(overridden.rationale).toBe("override");
  });
});

describe("runEval — automatic default registry (G14)", () => {
  test("a `type: registry` graders file works without RunEvalOptions.graderRegistry", async () => {
    const outDir = newTempRoot();
    const cwd = newTempRoot(); // no .crewhaus/graders here — packs only
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const invoker: AgentInvoker = async ({ sample }) => ({
      agentOutput: sample.expected_output ?? "",
      events: [],
    });
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: rouge\n    type: registry\n    grader: nlg.rougeL\n",
    );
    const summary = await runEval({
      ir,
      dataset: {
        name: "reg-auto",
        samples: yieldSamples([{ id: "s1", input: "x", expected_output: "hello world" }]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir, cwd },
    });
    expect(summary.aggregates.passRate).toBe(1);
    expect(summary.samples[0]?.grades.perGrader[0]?.name).toBe("rouge");
    expect(summary.samples[0]?.grades.perGrader[0]?.rationale).toMatch(/ROUGE-L/);
  });

  test("an unknown registry name fails at run start, listing the vocabulary", async () => {
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const invoker: AgentInvoker = async () => ({ agentOutput: "y", events: [] });
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: nope\n    type: registry\n    grader: no.suchGrader\n",
    );
    await expect(
      runEval({
        ir,
        dataset: {
          name: "reg-miss",
          samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
        },
        compiledGraders: compiled,
        opts: { invoker, outDir: newTempRoot(), cwd: newTempRoot() },
      }),
    ).rejects.toThrow(/no grader registered as "no.suchGrader".*registered graders:.*nlg.rougeL/);
  });

  test("an explicit graderRegistry still wins wholesale", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const invoker: AgentInvoker = async () => ({ agentOutput: "y", events: [] });
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: rouge\n    type: registry\n    grader: nlg.rougeL\n",
    );
    // A caller registry WITHOUT nlg.rougeL: the default must not paper over
    // the caller's explicit choice.
    const lookedUp: string[] = [];
    await expect(
      runEval({
        ir,
        dataset: {
          name: "reg-explicit",
          samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
        },
        compiledGraders: compiled,
        opts: {
          invoker,
          outDir,
          graderRegistry: {
            lookup: (name: string) => {
              lookedUp.push(name);
              throw new Error(`no grader registered as "${name}"`);
            },
          },
        },
      }),
    ).rejects.toThrow(/no grader registered as "nlg.rougeL"/);
    expect(lookedUp).toEqual(["nlg.rougeL"]);
  });
});
