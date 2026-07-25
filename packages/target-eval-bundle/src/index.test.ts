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

/**
 * Item 15 — a standalone bundle used to write its run directory and nothing
 * else, so `crewhaus eval-report history` / `baseline set` / the regression
 * gate could not see a single bundle run. The emitted bundle now appends to
 * the SAME `.crewhaus/evals/index.jsonl` the `crewhaus eval` path writes,
 * through eval-report's shared recorder (one wire format, one history).
 */
describe("target-eval-bundle — run history (item 15)", () => {
  test("agent.ts records the finished run through eval-report's shared recorder", () => {
    const code = emitEval(makeIr()).files[0]?.content ?? "";
    expect(code).toContain('import { recordEvalRun } from "@crewhaus/eval-report";');
    expect(code).toContain("recordEvalRun(result, {");
    expect(code).toContain("specName: SPEC_NAME,");
    // The run dir's parent IS the evals dir, so a tenant-rebased run records
    // into that tenant's history rather than the global one.
    expect(code).toContain("outDir: absOutDir,");
    expect(code).toContain("evalsDir: dirname(absOutDir),");
  });

  test("the recorded datasetHash is the registry's own content digest", () => {
    const code = emitEval(makeIr()).files[0]?.content ?? "";
    // Same function `crewhaus eval --dataset registry:<name>@<version>#<split>`
    // hashes with — a bundle run and a CLI run of the same registry dataset
    // record the same identity instead of two incomparable digests.
    expect(code).toContain(
      "const record = await registry.getRecord(DATASET.name, DATASET.version)",
    );
    expect(code).toContain("const datasetHash = overallDatasetHash(record, [DATASET.split]);");
    expect(code).toContain("datasetHash,");
  });

  test("the same digest is threaded into run.json, so `eval --sentinel` can use it", () => {
    const code = emitEval(makeIr()).files[0]?.content ?? "";
    const optsAt = code.indexOf("concurrency: CONCURRENCY,");
    const recordAt = code.indexOf("recordEvalRun(result");
    // `datasetHash` appears BOTH in the runEval opts (→ run.json/results.json)
    // and in the history entry — one identity, two artifacts.
    expect(code.indexOf("datasetHash,", optsAt)).toBeLessThan(recordAt);
    expect(code.indexOf("datasetHash,", recordAt)).toBeGreaterThan(recordAt);
  });

  test("a failed index append never fails an eval that already scored", () => {
    const code = emitEval(makeIr()).files[0]?.content ?? "";
    const recordAt = code.indexOf("recordEvalRun(result");
    expect(recordAt).toBeGreaterThan(-1);
    // The append sits inside a try/catch that only warns on stderr…
    expect(code).toContain("could not record run in the history index");
    // …and the machine-readable stdout line still prints afterwards.
    expect(code.indexOf("JSON.stringify({\n    runId: result.runId")).toBeGreaterThan(recordAt);
  });

  test("emitted agent.ts is syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const code = emitEval(makeIr()).files[0]?.content ?? "";
    expect(() => t.transformSync(code)).not.toThrow();
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
