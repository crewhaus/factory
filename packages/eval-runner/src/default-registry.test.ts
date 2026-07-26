/**
 * Loop contract 0.4 (Batch B, G14) — the default GraderRegistry: the six
 * specialty packs registered under namespaced names, `.crewhaus/graders`
 * plugin discovery on top, and `runEval` constructing it automatically
 * when a graders file declares `type: registry` and the caller supplied
 * no registry of its own.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "safety.toxicity.heuristic",
      "safety.bias.heuristic",
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

  test("dep-requiring graders throw teaching errors naming their env wiring when unwired", async () => {
    const prevClassifier = process.env["CREWHAUS_EVAL_CLASSIFIER"];
    const prevVision = process.env["CREWHAUS_EVAL_VISION_MODEL"];
    process.env["CREWHAUS_EVAL_CLASSIFIER"] = "";
    process.env["CREWHAUS_EVAL_VISION_MODEL"] = "";
    try {
      const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
      const sample: Sample = { id: "s", input: "x" };
      // A7 — the teaching error names the env var, the explicit heuristic
      // name, and the plugin path.
      expect(registry.lookup("safety.toxicity")(sample, RUN_RESULT)).rejects.toThrow(
        /CREWHAUS_EVAL_CLASSIFIER.*safety\.toxicity\.heuristic.*Classifier/,
      );
      expect(registry.lookup("safety.bias")(sample, RUN_RESULT)).rejects.toThrow(
        /CREWHAUS_EVAL_CLASSIFIER/,
      );
      // A8 — OCR names its vision-model env var; STT stays the honest
      // thrower (no bundled adapter carries audio input).
      expect(registry.lookup("multimodal.imageOcrThenGrade")(sample, RUN_RESULT)).rejects.toThrow(
        /CREWHAUS_EVAL_VISION_MODEL.*ocr/,
      );
      expect(
        registry.lookup("multimodal.audioTranscriptMatch")(sample, RUN_RESULT),
      ).rejects.toThrow(/stt/);
    } finally {
      if (prevClassifier !== undefined) process.env["CREWHAUS_EVAL_CLASSIFIER"] = prevClassifier;
      if (prevVision !== undefined) process.env["CREWHAUS_EVAL_VISION_MODEL"] = prevVision;
    }
  });

  test("safety.*.heuristic grade offline with the honest keyword mocks (A7)", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const sample: Sample = { id: "s", input: "x" };
    const tox = registry.lookup("safety.toxicity.heuristic");
    const toxic = await tox(sample, { ...RUN_RESULT, agentOutput: "you stupid idiot, die" });
    expect(toxic.passed).toBe(false);
    const clean = await tox(sample, RUN_RESULT);
    expect(clean.passed).toBe(true);
    expect(clean.rationale).toContain("mock-toxicity");
    const biasG = registry.lookup("safety.bias.heuristic");
    const biased = await biasG(sample, { ...RUN_RESULT, agentOutput: "all women are bad drivers" });
    expect(biased.passed).toBe(false);
  });

  test("C35 — the run's judge-usage sink reaches the judge-backed classifiers", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    // Installed by runEval on whatever registry it uses; the lazy safety
    // graders read the holder at classify time, so a registry built before
    // the run (the CLI builds its own) still meters its judge calls.
    expect(registry.judgeUsage.sink).toBeUndefined();
    const sink = () => {};
    registry.setJudgeUsageSink(sink);
    expect(registry.judgeUsage.sink).toBe(sink);
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

describe("resolveWithOpts — pack opts parameterization (NEW-HUNT-7)", () => {
  test("nlg opts thread into the pack constructor and change the verdict", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const sample: Sample = { id: "s", input: "x", expected_output: "the quick brown fox jumps" };
    // Partial overlap: passes at the pack default 0.5, fails at 0.95.
    const relaxed = await registry.resolveWithOpts("nlg.rougeL", { threshold: 0.5 })(
      sample,
      RUN_RESULT,
    );
    expect(relaxed.passed).toBe(true);
    const strictG = await registry.resolveWithOpts("nlg.rougeL", { threshold: 0.95 })(
      sample,
      RUN_RESULT,
    );
    expect(strictG.passed).toBe(false);
  });

  test("nlg.meteor accepts its extra alpha/beta/gamma knobs, bounds-checked", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const sample: Sample = { id: "s", input: "x", expected_output: "the quick brown fox" };
    const graded = await registry.resolveWithOpts("nlg.meteor", { alpha: 0.8, gamma: 0.3 })(
      sample,
      RUN_RESULT,
    );
    expect(graded.passed).toBe(true);
    expect(() => registry.resolveWithOpts("nlg.meteor", { alpha: 2 })).toThrow(
      /invalid opts for "nlg.meteor"/,
    );
  });

  test("an unknown opt key for a known pack is a loud error naming the vocabulary", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    expect(() => registry.resolveWithOpts("nlg.rougeL", { treshold: 0.9 })).toThrow(
      /invalid opts for "nlg.rougeL".*accepted opts: threshold, reference, lowercase/,
    );
    expect(() => registry.resolveWithOpts("nlg.rougeL", { threshold: "high" })).toThrow(
      /invalid opts for "nlg.rougeL"/,
    );
  });

  test("multimodal.imageSimilarity and safety.piiLeak accept their construction opts", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    expect(typeof registry.resolveWithOpts("multimodal.imageSimilarity", { hashSize: 4 })).toBe(
      "function",
    );
    expect(() => registry.resolveWithOpts("multimodal.imageSimilarity", { hashSize: 2.5 })).toThrow(
      /invalid opts for "multimodal.imageSimilarity"/,
    );
    // aHash's (0, 16] bound is enforced at run start — an oversized hashSize
    // must reject HERE, not per-sample from inside the pack.
    expect(() => registry.resolveWithOpts("multimodal.imageSimilarity", { hashSize: 32 })).toThrow(
      /invalid opts for "multimodal\.imageSimilarity": hashSize:.*16/,
    );
    const pii = registry.resolveWithOpts("safety.piiLeak", { threshold: 0.5 });
    const sample: Sample = { id: "s", input: "x" };
    const leak = await pii(sample, { ...RUN_RESULT, agentOutput: "mail bob@example.com now" });
    expect(leak.passed).toBe(false);
  });

  test("packs without YAML-settable construction reject ALL opts, pointing at plugins", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    for (const name of [
      "twelve.contextRelevance",
      "continuity.reAskRate",
      "multimodal.audioTranscriptMatch",
    ]) {
      expect(() => registry.resolveWithOpts(name, { threshold: 0.5 })).toThrow(
        /accepts no opts.*\.crewhaus\/graders plugin/,
      );
    }
  });

  test("A7 opts: safety.toxicity/bias accept classifier+threshold, strictly validated", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    // Valid opts construct (the model is only resolved at first grade).
    expect(
      typeof registry.resolveWithOpts("safety.toxicity", {
        classifier: "openai/gpt-4o-mini",
        threshold: 0.7,
      }),
    ).toBe("function");
    expect(() => registry.resolveWithOpts("safety.toxicity", { model: "x" })).toThrow(
      /invalid opts for "safety\.toxicity".*accepted opts: classifier, threshold/,
    );
    expect(() => registry.resolveWithOpts("safety.bias", { threshold: 2 })).toThrow(
      /invalid opts for "safety\.bias"/,
    );
    // Heuristic names take only the gate.
    const strictTox = registry.resolveWithOpts("safety.toxicity.heuristic", { threshold: 0.4 });
    const sample: Sample = { id: "s", input: "x" };
    const graded = await strictTox(sample, { ...RUN_RESULT, agentOutput: "you stupid fool" });
    expect(graded.passed).toBe(false);
    expect(() =>
      registry.resolveWithOpts("safety.toxicity.heuristic", { classifier: "x" }),
    ).toThrow(/invalid opts for "safety\.toxicity\.heuristic".*accepted opts: threshold/);
  });

  test("A8 opts: imageOcrThenGrade accepts model/textGrader/lang; unknown textGrader is loud at first grade", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    expect(
      typeof registry.resolveWithOpts("multimodal.imageOcrThenGrade", {
        model: "claude-sonnet-4-5",
        textGrader: "nlg.rougeL",
        lang: "en",
      }),
    ).toBe("function");
    expect(() => registry.resolveWithOpts("multimodal.imageOcrThenGrade", { stt: "x" })).toThrow(
      /invalid opts for "multimodal\.imageOcrThenGrade".*accepted opts: model, textGrader, lang/,
    );
    const sample: Sample = { id: "s", input: "x" };
    // A bogus textGrader name fails loudly at FIRST grade (registry lookup),
    // before any model call.
    const badDelegate = registry.resolveWithOpts("multimodal.imageOcrThenGrade", {
      model: "claude-sonnet-4-5",
      textGrader: "nope.missing",
    });
    expect(badDelegate(sample, RUN_RESULT)).rejects.toThrow(/textGrader "nope\.missing"/);
    // Self-delegation is rejected instead of recursing.
    const selfDelegate = registry.resolveWithOpts("multimodal.imageOcrThenGrade", {
      model: "claude-sonnet-4-5",
      textGrader: "multimodal.imageOcrThenGrade",
    });
    expect(selfDelegate(sample, RUN_RESULT)).rejects.toThrow(/cannot name the OCR grader itself/);
  });

  test("semantic.similarity opts: embedder spec + threshold, no env var needed", async () => {
    const prev = process.env["CREWHAUS_EVAL_EMBEDDER"];
    process.env["CREWHAUS_EVAL_EMBEDDER"] = "";
    try {
      const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
      const sample: Sample = { id: "s", input: "x", expected_output: "the quick brown fox" };
      const graded = await registry.resolveWithOpts("semantic.similarity", {
        embedder: "mock/deterministic",
      })(sample, RUN_RESULT);
      expect(graded.passed).toBe(true); // identical text ⇒ cosine 1
      expect(graded.rationale).toMatch(/cosine/);
      // An impossible threshold flips the identical-text verdict.
      const strictG = await registry.resolveWithOpts("semantic.similarity", {
        embedder: "mock/deterministic",
        threshold: 1,
      })(sample, { ...RUN_RESULT, agentOutput: "entirely unrelated words" });
      expect(strictG.passed).toBe(false);
    } finally {
      if (prev !== undefined) process.env["CREWHAUS_EVAL_EMBEDDER"] = prev;
    }
  });

  test("semantic.similarity opts: disableFallback surfaces the embedder error (NEW-HUNT-5)", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const sample: Sample = { id: "s", input: "x", expected_output: "the quick brown fox" };
    // A local spec pointing at a closed port: embed() fails without any
    // external network. disableFallback turns that into a LOUD error…
    const loud = registry.resolveWithOpts("semantic.similarity", {
      embedder: "local/nope@http://127.0.0.1:1",
      disableFallback: true,
    });
    expect(loud(sample, RUN_RESULT)).rejects.toThrow(/embedder failed/);
    // …while the default silently degrades to the marked ROUGE-L verdict.
    const degraded = await registry.resolveWithOpts("semantic.similarity", {
      embedder: "local/nope@http://127.0.0.1:1",
    })(sample, RUN_RESULT);
    expect(degraded.rationale).toMatch(/^\[fallback ROUGE-L; embedder error: /);
  });

  test("plugin graders receive opts untouched as a third argument", async () => {
    const root = newTempRoot();
    const pluginRoot = join(root, ".crewhaus", "graders");
    mkdirSync(join(pluginRoot, "custom"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "custom", "index.ts"),
      `export default [
  { name: "custom.echoOpts", grader: async (_s, _r, opts) => ({ passed: true, score: 1, rationale: JSON.stringify(opts ?? null) }) },
  { name: "nlg.rougeL", grader: async (_s, _r, opts) => ({ passed: true, score: 1, rationale: "override " + JSON.stringify(opts ?? null) }) },
];
`,
    );
    const registry = await defaultGraderRegistry({ cwd: root });
    const sample: Sample = { id: "s", input: "x" };
    const echoed = await registry.resolveWithOpts("custom.echoOpts", { alpha: 1, mode: "x" })(
      sample,
      RUN_RESULT,
    );
    expect(echoed.rationale).toBe(JSON.stringify({ alpha: 1, mode: "x" }));
    // A plugin OVERRIDE of a pack name wins the opts contract too: raw
    // passthrough, no pack-schema validation — keys the pack would reject
    // reach the plugin verbatim.
    const overridden = await registry.resolveWithOpts("nlg.rougeL", { anything: true })(
      sample,
      RUN_RESULT,
    );
    expect(overridden.rationale).toBe(`override ${JSON.stringify({ anything: true })}`);
  });

  test("runEval threads graders.yaml opts end-to-end (YAML → verdict)", async () => {
    const outDir = newTempRoot();
    const cwd = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const invoker: AgentInvoker = async () => ({
      agentOutput: "the quick brown fox", // partial overlap with the gold
      events: [],
    });
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: rouge\n    type: registry\n    grader: nlg.rougeL\n    opts:\n      threshold: 0.95\n",
    );
    const summary = await runEval({
      ir,
      dataset: {
        name: "reg-opts",
        samples: yieldSamples([
          { id: "s1", input: "x", expected_output: "the quick brown fox jumps" },
        ]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir, cwd },
    });
    // The pack default (0.5) would pass this sample — the YAML opts must win.
    expect(summary.aggregates.passRate).toBe(0);
    expect(summary.samples[0]?.grades.perGrader[0]?.rationale).toMatch(/0\.95/);
  });

  test("runEval rejects opts loudly when the caller registry lacks resolveWithOpts", async () => {
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const invoker: AgentInvoker = async () => ({ agentOutput: "y", events: [] });
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: rouge\n    type: registry\n    grader: nlg.rougeL\n    opts:\n      threshold: 0.9\n",
    );
    await expect(
      runEval({
        ir,
        dataset: {
          name: "reg-opts-plain",
          samples: yieldSamples([{ id: "s1", input: "x", expected_output: "y" }]),
        },
        compiledGraders: compiled,
        opts: {
          invoker,
          outDir: newTempRoot(),
          graderRegistry: {
            lookup: () => async () => ({ passed: true, score: 1, rationale: "plain" }),
          },
        },
      }),
    ).rejects.toThrow(/no resolveWithOpts.*never silently dropped/);
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

// Evals Wave 2 (cluster C) — the runner-local A9/A10 packs.
describe("calibration.abstentionAware + consistency.paraphraseGroup packs (A9/A10)", () => {
  test("both packs are registered in the default registry", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    expect(registry.list()).toContain("calibration.abstentionAware");
    expect(registry.list()).toContain("consistency.paraphraseGroup");
  });

  test("calibration.abstentionAware opts thread via resolveWithOpts; typos are loud", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    const sample: Sample = { id: "s", input: "x", expected_output: "fox" };
    // Pack default (exact) fails the embedding answer; mode: contains passes.
    const exact = await registry.lookup("calibration.abstentionAware")(sample, RUN_RESULT);
    expect(exact.passed).toBe(false);
    const contains = await registry.resolveWithOpts("calibration.abstentionAware", {
      mode: "contains",
    })(sample, RUN_RESULT);
    expect(contains.passed).toBe(true);
    expect(() =>
      registry.resolveWithOpts("calibration.abstentionAware", { mode: "fuzzy" }),
    ).toThrow(/invalid opts for "calibration.abstentionAware"/);
    expect(() => registry.resolveWithOpts("calibration.abstentionAware", { treshold: 1 })).toThrow(
      /accepted opts: mode, caseInsensitive/,
    );
  });

  test("consistency.paraphraseGroup takes NO opts — an opts block loud-rejects", async () => {
    const registry = await defaultGraderRegistry({ pluginRoot: join(newTempRoot(), "nope") });
    expect(() =>
      registry.resolveWithOpts("consistency.paraphraseGroup", { anything: true }),
    ).toThrow(/accepts no opts/);
  });

  test("runEval end-to-end: both packs land their aggregates in results.json", async () => {
    const outDir = newTempRoot();
    const cwd = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const outputs: Record<string, string> = {
      v1: "the answer is 4",
      v2: "I don't know.",
      solo: "Paris",
    };
    const invoker: AgentInvoker = async (req) => ({
      agentOutput: outputs[req.sample.id] ?? "",
      events: [],
    });
    const { compiled } = parseGradersConfig(
      [
        "graders:",
        "  - name: fact",
        "    type: registry",
        "    grader: calibration.abstentionAware",
        "    opts:",
        "      mode: contains",
        "  - name: robustness",
        "    type: registry",
        "    grader: consistency.paraphraseGroup",
        "",
      ].join("\n"),
    );
    const summary = await runEval({
      ir,
      dataset: {
        name: "cluster-c",
        samples: yieldSamples([
          {
            id: "v1",
            input: "2+2?",
            expected_output: "4",
            metadata: { paraphrase_group: "g1" },
          },
          {
            id: "v2",
            input: "two plus two?",
            expected_output: "4",
            metadata: { paraphrase_group: "g1" },
          },
          {
            id: "solo",
            input: "capital of France?",
            expected_output: "Paris",
            metadata: { paraphrase_group: "g2" },
          },
        ]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir, cwd },
    });

    // A9 — v1/solo answered-correct, v2 declined.
    expect(summary.aggregates.calibration).toEqual({
      classifiedSamples: 3,
      answerRate: 2 / 3,
      abstentionRate: 1 / 3,
      accuracyWhenAnswered: 1,
    });
    // A10 — g1 split 1/2 ⇒ 0.5 consistency; the singleton g2 reads 1.0.
    expect(summary.aggregates.paraphraseConsistency).toEqual({
      groupCount: 2,
      consistencyByGroup: { g1: 0.5, g2: 1 },
      meanConsistency: 0.75,
    });
    // The persisted results.json carries both blocks verbatim.
    const persisted = JSON.parse(readFileSync(join(outDir, "results.json"), "utf-8"));
    expect(persisted.aggregates.calibration.answerRate).toBeCloseTo(2 / 3);
    expect(persisted.aggregates.paraphraseConsistency.meanConsistency).toBe(0.75);
    // Combine `all`: the declined sample fails its calibration grader.
    expect(summary.aggregates.passRate).toBeCloseTo(2 / 3);
  });

  test("runEval without the packs emits NEITHER aggregate key (byte-compat)", async () => {
    const outDir = newTempRoot();
    const ir = narrowToAgent(lower(parseSpec(SPEC)));
    const invoker: AgentInvoker = async () => ({ agentOutput: "the quick brown fox", events: [] });
    const { compiled } = parseGradersConfig(
      "graders:\n  - name: rouge\n    type: registry\n    grader: nlg.rougeL\n",
    );
    const summary = await runEval({
      ir,
      dataset: {
        name: "no-cluster-c",
        samples: yieldSamples([
          {
            id: "s1",
            input: "x",
            expected_output: "the quick brown fox",
            metadata: { paraphrase_group: "g1" },
          },
        ]),
      },
      compiledGraders: compiled,
      opts: { invoker, outDir, cwd: newTempRoot() },
    });
    // Lineage metadata alone must not conjure the aggregate — the pack is
    // the opt-in.
    expect("calibration" in summary.aggregates).toBe(false);
    expect("paraphraseConsistency" in summary.aggregates).toBe(false);
  });
});
