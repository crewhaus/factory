/**
 * `renderEvaluationWiring` — the codegen twin. Pinned two ways: the exact
 * text each emitter's options produce, and the text EVALUATED (the boot
 * line, the registration call, the merge expression run against a real
 * catalog and the real `wireEvaluation`), so what a bundle runs is what the
 * interpreter runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IrEvaluation } from "@crewhaus/ir";
import type { RunEvaluation } from "@crewhaus/runtime-core";
import { ToolCatalog } from "@crewhaus/tool-catalog";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { proofCheck, provabilityPreflight } from "@crewhaus/tool-proof";
import { MEETINGS, config, recordingBus, sumTool, tempDirs } from "./__fixtures__/helpers";
import { type EvaluationWiringOptions, renderEvaluationWiring } from "./render";
import { proofsDirName } from "./roots";
import { mergeGateTools, registerGateTools } from "./tools";
import { type WiredGates, wireEvaluation } from "./wire";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

const CLI: EvaluationWiringOptions = {
  catalogVar: "defaultCatalog",
  cwdExpr: "process.cwd()",
  footerTarget: "stream",
  indent: "  ",
};
const CHANNEL: EvaluationWiringOptions = {
  catalogVar: "config.tools",
  cwdExpr: "process.cwd()",
  footerTarget: "reply",
  indent: "        ",
  toolsInto: "list",
  sessionRootDirExpr: "config.sessionRootDir",
};
const MANAGED: EvaluationWiringOptions = {
  catalogVar: "defaultCatalog",
  cwdExpr: "process.cwd()",
  footerTarget: "reply",
  indent: "    ",
};

const CONTAINS: IrEvaluation = {
  grader: { type: "contains", value: "DONE" },
  onFail: "retry",
  maxRetries: 1,
};
const base = { name: "bot", agent: { model: "claude-sonnet-4-6" } };

describe("absent — every piece empty (bundles stay byte-identical)", () => {
  for (const [shape, opts] of [
    ["cli", CLI],
    ["channel", CHANNEL],
    ["managed", MANAGED],
  ] as const) {
    test(shape, () => {
      const wiring = renderEvaluationWiring(base, opts);
      expect(wiring.imports).toEqual([]);
      expect(wiring.bootBlock).toBe("");
      expect(wiring.field).toBe("");
      expect(wiring.toolsRegistration).toBe("");
      expect(wiring.toolsExpr("config.tools")).toBe("config.tools");
    });
  }
});

describe("evaluation only", () => {
  test("cli: the import, one boot line with cwd alone, the evaluation field, no tools", () => {
    const wiring = renderEvaluationWiring({ ...base, evaluation: CONTAINS }, CLI);
    expect(wiring.imports).toEqual([
      'import { wireEvaluation } from "@crewhaus/evaluation-service";',
    ]);
    expect(wiring.bootBlock).toBe(
      'const __gates = await wireEvaluation({"specName":"bot","primaryModel":"claude-sonnet-4-6","evaluation":{"grader":{"type":"contains","value":"DONE"},"onFail":"retry","maxRetries":1}}, { cwd: process.cwd() });',
    );
    expect(wiring.field).toBe("\n  evaluation: __gates.evaluation,");
    expect(wiring.toolsRegistration).toBe("");
  });

  test("channel / managed: the field at their indent; no list merge without provability", () => {
    const channel = renderEvaluationWiring({ ...base, evaluation: CONTAINS }, CHANNEL);
    expect(channel.field).toBe("\n        evaluation: __gates.evaluation,");
    expect(channel.imports).toEqual([
      'import { wireEvaluation } from "@crewhaus/evaluation-service";',
    ]);
    expect(channel.bootBlock).toEndWith(", { cwd: process.cwd() });");
    expect(channel.toolsExpr("config.tools")).toBe("config.tools");
    expect(renderEvaluationWiring({ ...base, evaluation: CONTAINS }, MANAGED).field).toBe(
      "\n    evaluation: __gates.evaluation,",
    );
  });
});

describe("provability", () => {
  const provability = config("grounded");
  const fragmentJson = JSON.stringify({
    specName: "bot",
    primaryModel: "claude-sonnet-4-6",
    provability,
  });

  test("cli: catalog + stream footer in the deps, the provability field, the registration call", () => {
    const wiring = renderEvaluationWiring({ ...base, provability }, CLI);
    expect(wiring.imports).toEqual([
      'import { registerGateTools, wireEvaluation } from "@crewhaus/evaluation-service";',
    ]);
    expect(wiring.bootBlock).toBe(
      `const __gates = await wireEvaluation(${fragmentJson}, { cwd: process.cwd(), catalog: defaultCatalog, footerTarget: "stream" });`,
    );
    expect(wiring.field).toBe("\n  provability: __gates.provability,");
    expect(wiring.toolsRegistration).toBe(
      [
        "// 0.8.0 — the proof tools, bound to this spec's provability block; a same-named",
        "// builtin listed in tools: is replaced (it would file proofs where the gate never looks).",
        "registerGateTools(defaultCatalog, __gates);",
      ].join("\n"),
    );
  });

  test("managed: the reply footer", () => {
    const wiring = renderEvaluationWiring({ ...base, provability }, MANAGED);
    expect(wiring.bootBlock).toBe(
      `const __gates = await wireEvaluation(${fragmentJson}, { cwd: process.cwd(), catalog: defaultCatalog, footerTarget: "reply" });`,
    );
    expect(wiring.field).toBe("\n    provability: __gates.provability,");
    expect(wiring.toolsRegistration).toEndWith("\nregisterGateTools(defaultCatalog, __gates);");
  });

  test("channel: list mode — mergeGateTools imported, the session root threaded, no catalog loop", () => {
    const wiring = renderEvaluationWiring({ ...base, provability }, CHANNEL);
    expect(wiring.imports).toEqual([
      'import { mergeGateTools, wireEvaluation } from "@crewhaus/evaluation-service";',
    ]);
    expect(wiring.bootBlock).toBe(
      `const __gates = await wireEvaluation(${fragmentJson}, { cwd: process.cwd(), catalog: config.tools, footerTarget: "reply", ...(config.sessionRootDir !== undefined ? { sessionRootDir: config.sessionRootDir } : {}) });`,
    );
    expect(wiring.toolsRegistration).toBe("");
    expect(wiring.toolsExpr("[...config.tools, ...__memTools]")).toBe(
      "mergeGateTools([...config.tools, ...__memTools], __gates)",
    );
  });

  test("both blocks: both fields, evaluation first", () => {
    const wiring = renderEvaluationWiring({ ...base, evaluation: CONTAINS, provability }, CLI);
    expect(wiring.field).toBe(
      "\n  evaluation: __gates.evaluation,\n  provability: __gates.provability,",
    );
  });

  test("user strings are JSON-escaped into the literal", () => {
    const wiring = renderEvaluationWiring(
      {
        name: 'evil"name',
        agent: { model: "m" },
        evaluation: {
          grader: { type: "llm_judge", criteria: 'say "yes"\nthen stop`${process.exit(1)}`' },
          threshold: 0.7,
          onFail: "retry",
          maxRetries: 1,
        },
      },
      CLI,
    );
    const literal = wiring.bootBlock.slice(
      "const __gates = await wireEvaluation(".length,
      wiring.bootBlock.indexOf(", { cwd:"),
    );
    expect(JSON.parse(literal).evaluation.grader.criteria).toBe(
      'say "yes"\nthen stop`${process.exit(1)}`',
    );
    expect(wiring.bootBlock).not.toContain("\nthen");
  });
});

/** Run an emitted boot block (+ registration) the way a bundle does, against a real catalog. */
async function runEmitted(
  code: string,
  catalog: ToolCatalog | ReadonlyArray<RegisteredTool>,
  cwd: string,
): Promise<WiredGates> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<WiredGates>;
  const fn = new AsyncFunction(
    "wireEvaluation",
    "registerGateTools",
    "mergeGateTools",
    "defaultCatalog",
    "config",
    "process",
    `${code}\nreturn __gates;`,
  );
  return fn(
    wireEvaluation,
    registerGateTools,
    mergeGateTools,
    catalog,
    { tools: catalog, sessionRootDir: undefined },
    { cwd: () => cwd },
  );
}

describe("the emitted text, evaluated", () => {
  const turn = (finalText: string) => ({
    finalText,
    messages: [],
    usage: { input: 0, output: 0 },
    bus: recordingBus().bus,
  });

  test("each grader type: the emitted boot line yields the same verdicts as the composition root", async () => {
    const graders: IrEvaluation[] = [
      CONTAINS,
      { grader: { type: "regex", value: "^\\d+$" }, onFail: "note", maxRetries: 0 },
      {
        grader: { type: "llm_judge", criteria: "c", judges: ["a", "b"], repeats: 3 },
        threshold: 0.8,
        onFail: "escalate",
        maxRetries: 1,
        escalateTo: "strong",
      },
    ];
    for (const evaluation of graders) {
      const wiring = renderEvaluationWiring({ ...base, evaluation }, CLI);
      const emitted = (await runEmitted(wiring.bootBlock, new ToolCatalog(), "/tmp"))
        .evaluation as RunEvaluation;
      const direct = (
        await wireEvaluation(
          { specName: "bot", primaryModel: base.agent.model, evaluation },
          { cwd: "/tmp" },
        )
      ).evaluation as RunEvaluation;
      const { evaluate: _a, ...emittedFields } = emitted;
      const { evaluate: _b, ...directFields } = direct;
      expect(emittedFields).toEqual(directFields);
      if (evaluation.grader.type !== "llm_judge") {
        for (const text of ["DONE", "12345", "nope"]) {
          expect(await emitted.evaluate(turn(text))).toEqual(await direct.evaluate(turn(text)));
        }
      }
    }
  });

  test("cli/managed: the registration loop puts the gate's tools on the catalog, replacing a listed builtin", async () => {
    const catalog = new ToolCatalog();
    catalog.register(provabilityPreflight);
    catalog.register(proofCheck);
    const wiring = renderEvaluationWiring({ ...base, provability: config("proven") }, CLI);
    const gates = await runEmitted(
      `${wiring.bootBlock}\n${wiring.toolsRegistration}`,
      catalog,
      "/tmp",
    );
    expect(
      catalog
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["ProofCheck", "ProofCheckers", "ProvabilityPreflight"]);
    // The spec-bound instances, not the builtin ones.
    expect(catalog.get("ProvabilityPreflight")).toBe(
      gates.tools.find((t) => t.name === "ProvabilityPreflight"),
    );
    expect(catalog.get("ProvabilityPreflight")).not.toBe(provabilityPreflight);
    expect(catalog.get("ProofCheck")).not.toBe(proofCheck);
    expect(gates.provability?.footerTarget).toBe("stream");
  });

  test("cli/managed below proven: a ProofCheck the spec listed is replaced too, though the level adds none", async () => {
    const catalog = new ToolCatalog();
    catalog.register(proofCheck);
    const wiring = renderEvaluationWiring({ ...base, provability: config("checked") }, MANAGED);
    const gates = await runEmitted(
      `${wiring.bootBlock}\n${wiring.toolsRegistration}`,
      catalog,
      "/tmp",
    );
    expect(
      catalog
        .list()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["ProofCheck", "ProvabilityPreflight"]);
    expect(catalog.get("ProofCheck")).not.toBe(proofCheck);
    expect(catalog.get("ProofCheck")).toBe(gates.proofTools.find((t) => t.name === "ProofCheck"));
  });

  test("channel: the emitted list merge keeps the run's tools and swaps in the gate's", async () => {
    const tools: RegisteredTool[] = [sumTool(), provabilityPreflight, proofCheck];
    const wiring = renderEvaluationWiring({ ...base, provability: config("grounded") }, CHANNEL);
    const merged = (await runEmitted(
      `${wiring.bootBlock}\nconst __merged = ${wiring.toolsExpr("config.tools")};\n__gates.merged = __merged;`,
      tools,
      "/tmp",
    )) as WiredGates & { merged: RegisteredTool[] };
    expect(merged.provability?.footerTarget).toBe("reply");
    expect(merged.merged.map((t) => t.name)).toEqual([
      "SumFake",
      "ProofCheck",
      "ProvabilityPreflight",
    ]);
    expect(merged.merged[1]).not.toBe(proofCheck);
    expect(merged.merged[2]).not.toBe(provabilityPreflight);
  });

  test("a spec name with a space (the spec schema allows one) boots, and its proofs file under the mapped name", async () => {
    const cwd = dirs.make();
    const catalog = new ToolCatalog();
    const wiring = renderEvaluationWiring(
      { ...base, name: "support bot", provability: config("proven") },
      CLI,
    );
    const gates = await runEmitted(
      `${wiring.bootBlock}\n${wiring.toolsRegistration}`,
      catalog,
      cwd,
    );
    const out = JSON.parse(
      (await (catalog.get("ProofCheck") as RegisteredTool).execute({
        checker: "builtin",
        ...MEETINGS,
      })) as string,
    ) as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    const bundle = await gates.provability?.verify({
      finalText: `${MEETINGS.claim.slice(0, -1)} [1].\n\n[1]: proof:${out.id}`,
      messages: [],
      usage: { input: 0, output: 0 },
      bus: recordingBus().bus,
      turnNumber: 1,
      retryIndex: 0,
    });
    expect(bundle?.verdict).toBe("pass");
    expect(
      existsSync(join(cwd, ".crewhaus", "proofs", proofsDirName("support bot"), "artifacts")),
    ).toBe(true);
  });
});
