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

  test("C33 — the emitting version rides into run.json, like a `crewhaus eval` run", () => {
    // Without this a bundle row sat beside CLI rows in the same index.jsonl
    // with a systematically emptier reproducibility manifest (bunVersion and
    // platform are computed inside runEval; cliVersion only the emitter knows).
    const code = emitEval(makeIr(), { cliVersion: "0.4.0" }).files[0]?.content ?? "";
    expect(code).toContain('cliVersion: "0.4.0",');
    // Omitted ⇒ absent, so a library caller's bundle is unchanged.
    expect(emitEval(makeIr()).files[0]?.content ?? "").not.toContain("cliVersion:");
  });

  test("the bundle states which `crewhaus eval` features it does NOT have", () => {
    // Flake detection needs --repeats, determinism needs --replay-tools and
    // partial-run economics need --resume; the generated bundle exposes no
    // argv for any of them (and record/replay is structurally unreachable
    // for an entry-driven bridge). A documented gap, not a silent one.
    const code = emitEval(makeIr()).files[0]?.content ?? "";
    expect(code).toContain("--repeats");
    expect(code).toContain("--replay-tools");
    expect(code).toContain("--resume");
    expect(code).toContain("`crewhaus eval`");
  });
});

describe("emitEval — failure_taxonomy is WIRED (D37)", () => {
  test("a declared taxonomy lands on the synthesized IR runEval consumes", () => {
    const ir = makeIr({
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    });
    const code = emitEval(ir).files[0]?.content ?? "";
    // The taxonomy const embeds the declared classes verbatim…
    expect(code).toContain("const FAILURE_TAXONOMY = ");
    expect(code).toContain('"class":"rate_limited"');
    // …and threads onto the IR literal, where the eval-runner's classified
    // retry suppression + `SampleResult.failureClass` machinery reads it —
    // the same semantics as the `crewhaus eval` CLI path.
    expect(code).toContain("failureTaxonomy: FAILURE_TAXONOMY,");
    // The pre-Wave-4 "ignored" warning comment is gone.
    expect(code).not.toContain(
      "failure_taxonomy configured but target-eval does not yet wire it up",
    );
  });

  test("taxonomy-carrying emission stays syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    const ir = makeIr({
      failureTaxonomy: [{ class: "provider_down", pattern: "/503|overloaded/", recovery: "fail" }],
    });
    const code = emitEval(ir).files[0]?.content ?? "";
    expect(() => t.transformSync(code)).not.toThrow();
  });

  test("no taxonomy ⇒ no taxonomy lines (byte-identical posture)", () => {
    const code = emitEval(makeIr()).files[0]?.content ?? "";
    expect(code).not.toContain("FAILURE_TAXONOMY");
    expect(code).not.toContain("failureTaxonomy:");
  });
});

/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — bridged emission: the bundle
 * imports the compiled runtime entry and drives it per sample through the
 * eval-runner invoker seam; history-carrying samples gate at dataset load.
 */
describe("emitEval — bridge mode (cluster S)", () => {
  const workflowBridge = {
    sourceTarget: "workflow",
    kind: "workflow-run",
    chatCapable: false,
    entryImport: "../agent.ts",
  } as const;

  test("no bridge ⇒ emission carries no bridge plumbing (byte-identical posture)", () => {
    const code = emitEval(makeIr()).files[0]?.content ?? "";
    expect(code).not.toContain("BRIDGE");
    expect(code).not.toContain("createBridgeInvoker");
    expect(code).not.toContain("guardHistorySamples");
    expect(code).not.toContain("__entry");
  });

  test("an entry-driven bridge imports the compiled runtime and wires the invoker", () => {
    const code = emitEval(makeIr(), { bridge: workflowBridge }).files[0]?.content ?? "";
    // The RUNTIME subpath, not the package root: the root entry statically
    // imports all five shape codegen packages (bridge-emit), so importing it
    // would make every bridged bundle load the whole codegen tree at boot for
    // two helpers. `runtime.ts`'s only non-type import is @crewhaus/tenancy.
    expect(code).toContain(
      'import { createBridgeInvoker, guardHistorySamples } from "@crewhaus/target-eval-bundle/runtime";',
    );
    expect(code).toContain('import * as __entry from "../agent.ts";');
    expect(code).toContain(
      'const BRIDGE = { sourceTarget: "workflow", kind: "workflow-run", chatCapable: false, entryImport: "../agent.ts" } as const;',
    );
    expect(code).toContain("const __invoker = createBridgeInvoker(BRIDGE, __entry);");
    expect(code).toContain("invoker: __invoker,");
    // Dataset load runs through the history gate.
    expect(code).toContain(
      "samples: guardHistorySamples(registry.get(DATASET.name, DATASET.version, DATASET.split), BRIDGE),",
    );
    // The header names the projection.
    expect(code).toContain(
      "// Eval bridge: projected from target: workflow — invoker: workflow-run.",
    );
  });

  test("a non-entry bridge gates history but keeps the default invoker", () => {
    const code =
      emitEval(makeIr(), {
        bridge: { sourceTarget: "voice", kind: "voice-replay", chatCapable: true },
      }).files[0]?.content ?? "";
    expect(code).toContain(
      'import { guardHistorySamples } from "@crewhaus/target-eval-bundle/runtime";',
    );
    expect(code).not.toContain("createBridgeInvoker");
    expect(code).not.toContain("__entry");
    expect(code).not.toContain("invoker: __invoker");
    expect(code).toContain("chatCapable: true } as const;");
  });

  test("bridged emission is syntactically valid TypeScript", () => {
    const t = new Bun.Transpiler({ loader: "ts" });
    for (const bridge of [
      workflowBridge,
      {
        sourceTarget: "managed",
        kind: "gateway-request",
        chatCapable: true,
        entryImport: "../agent.ts",
      } as const,
      { sourceTarget: "batch", kind: "batch-item", chatCapable: false } as const,
    ]) {
      const code = emitEval(makeIr(), { bridge }).files[0]?.content ?? "";
      expect(() => t.transformSync(code)).not.toThrow();
    }
  });

  test("bridge + declared taxonomy compose", () => {
    const ir = makeIr({
      failureTaxonomy: [{ class: "rate_limited", pattern: "/429/", recovery: "retry" }],
    });
    const code = emitEval(ir, { bridge: workflowBridge }).files[0]?.content ?? "";
    expect(code).toContain("failureTaxonomy: FAILURE_TAXONOMY,");
    expect(code).toContain("const __invoker = createBridgeInvoker(BRIDGE, __entry);");
  });
});
