/**
 * Section 29 — `target-eval-bundle` tests:
 *  - T1 generated bundle structure
 *  - T3 compile + run EVAL target end-to-end (via spec → ir → emit)
 */
import { describe, expect, test } from "bun:test";
import type { IrEvalV0 } from "@crewhaus/ir";
import { emitEval } from "./index";

function makeIr(overrides: Partial<IrEvalV0> = {}): IrEvalV0 {
  return {
    version: 0,
    name: "smoke-eval",
    target: "eval",
    agent: {
      model: "claude-opus-4-7",
      instructions: "answer briefly",
      tools: [],
    },
    dataset: { name: "smoke-eval", version: "v1", split: "dev" },
    graders: [{ name: "exact_match" }],
    concurrency: 4,
    ...overrides,
  };
}

describe("target-eval-bundle — T1 emitted bundle structure", () => {
  test("emitEval returns agent.ts plus the generated README.md (item 42)", () => {
    const ir = makeIr();
    const bundle = emitEval(ir);
    expect(bundle.files.length).toBe(2);
    expect(bundle.files[0]?.path).toBe("agent.ts");
    expect(bundle.files[1]?.path).toBe("README.md");
  });

  test("readme: false restores the single-file bundle (item 42 opt-out)", () => {
    const bundle = emitEval(makeIr(), { readme: false });
    expect(bundle.files.length).toBe(1);
    expect(bundle.files[0]?.path).toBe("agent.ts");
  });

  test("agent.ts imports dataset-registry, eval-grader, eval-runner", () => {
    const bundle = emitEval(makeIr());
    const code = bundle.files[0]?.content ?? "";
    expect(code).toContain("@crewhaus/dataset-registry");
    expect(code).toContain("@crewhaus/eval-grader");
    expect(code).toContain("@crewhaus/eval-runner");
  });

  test("agent.ts contains the spec model + instructions verbatim", () => {
    const ir = makeIr({
      agent: {
        model: "claude-opus-4-7",
        instructions: "answer in 5 words",
        tools: [],
      },
    });
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(code).toContain("claude-opus-4-7");
    expect(code).toContain("answer in 5 words");
  });

  test("agent.ts emits seed line when seed is set", () => {
    const ir = makeIr({ seed: 42 });
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(code).toContain("seed: 42");
  });

  test("agent.ts skips seed line when seed is undefined", () => {
    const ir = makeIr();
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(code).not.toContain("seed: ");
  });

  test("agent.ts contains the dataset name + split", () => {
    const ir = makeIr({
      dataset: { name: "math-bench", version: "v3", split: "dev" },
    });
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(code).toContain('"name":"math-bench"');
    expect(code).toContain('"split":"dev"');
  });

  test("split: test threads the registry's allowTestSplit escape hatch (spec-declared opt-in)", () => {
    const ir = makeIr({
      dataset: { name: "release-gate", version: "v2", split: "test" },
    });
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(code).toContain(
      "registry.get(DATASET.name, DATASET.version, DATASET.split, { allowTestSplit: true })",
    );
  });

  test("train/dev splits keep the guarded three-argument get() byte-identical", () => {
    for (const split of ["train", "dev"] as const) {
      const ir = makeIr({ dataset: { name: "smoke-eval", version: "v1", split } });
      const code = emitEval(ir).files[0]?.content ?? "";
      expect(code).toContain("registry.get(DATASET.name, DATASET.version, DATASET.split)");
      expect(code).not.toContain("allowTestSplit");
    }
  });

  test("agent.ts contains every grader name", () => {
    const ir = makeIr({
      graders: [{ name: "exact_match" }, { name: "regex", opts: { pattern: "\\d+" } }],
    });
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(code).toContain("exact_match");
    expect(code).toContain("regex");
  });

  test("escapes special characters in instructions", () => {
    const ir = makeIr({
      agent: {
        model: "claude-opus-4-7",
        instructions: 'with "quotes" and\nnewline',
        tools: [],
      },
    });
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(code).toContain('with \\"quotes\\"');
    expect(code).toContain("\\nnewline");
  });
});

describe("emitEval — failure_taxonomy ignored-note (item 23)", () => {
  test("agent.ts carries the ignored-taxonomy note when the spec declares one", () => {
    const ir = makeIr({
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    });
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(code).toContain("failure_taxonomy configured but target-eval does not yet wire it up");
  });

  test("no note when the spec omits failure_taxonomy", () => {
    expect(emitEval(makeIr()).files[0]?.content ?? "").not.toContain("failure_taxonomy configured");
  });
});
