/**
 * Section 29 — `target-eval-bundle`. Single-file `agent.ts` codegen for
 * the `target: "eval"` shape. The emitted bundle:
 *   1. Loads the dataset via `@crewhaus/dataset-registry`
 *   2. Looks up each grader by name via `@crewhaus/grader-registry` —
 *      built-ins from §16 are auto-registered by the eval-runner package
 *   3. Drives `@crewhaus/eval-runner.runEval` with `concurrency` + `seed`
 *   4. Writes the result summary to `.crewhaus/evals/<runId>/`
 *   5. Appends the run to `.crewhaus/evals/index.jsonl` — the SAME run
 *      history `crewhaus eval` writes (audit item 15). Before this, a
 *      bundle wrote its run directory and nothing else, so
 *      `crewhaus eval-report history`, `baseline set` and the regression
 *      gate could not see a single bundle run: the same eval had two
 *      histories depending on how it was launched, and the ~13 non-cli
 *      shapes (whose ONLY eval path is a compiled bundle, via
 *      `compile --with-eval-harness`) had none at all.
 */
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrEvalV0,
  renderBundleReadme,
} from "@crewhaus/ir";
import type { EvalBridge } from "./runtime";

/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — `emitEval` options. `bridge`
 * (set only by the CLI's `compile --with-eval-harness` path) marks the bundle
 * as an eval BRIDGE for the named source shape: the generated bundle then
 *   - imports the compiled runtime entry (`bridge.entryImport`, when the
 *     shape has one) and drives it per sample via `createBridgeInvoker`
 *     through the eval-runner `opts.invoker` seam — the shape's ACTUAL
 *     compiled runtime runs, not a bare single-turn chat projection;
 *   - wraps the dataset in `guardHistorySamples`, so history-carrying
 *     samples against an entry-driven, non-chat shape fail loudly at load
 *     (entry-less bridges keep the runner's native B14 history seeding).
 * Absent (plain `target: eval` specs), the emission is unchanged.
 */
export type EmitEvalOptions = EmitReadmeOptions & {
  readonly bridge?: EvalBridge;
  /**
   * C33 — the crewhaus version that EMITTED this bundle, baked in so the
   * bundle's own `run.json`/`results.json` carry `config.cliVersion` exactly
   * as a `crewhaus eval` run does. Without it a bundle row sat beside CLI
   * rows in the same `index.jsonl` with a systematically emptier
   * reproducibility manifest. Omitted ⇒ the field is absent, as before.
   */
  readonly cliVersion?: string;
};

export function emitEval(ir: IrEvalV0, opts: EmitEvalOptions = {}): Bundle {
  const bridge = opts.bridge;
  const seedLine = ir.seed !== undefined ? `  seed: ${ir.seed},\n` : "";
  const toolsLine = ir.agent.tools.length > 0 ? `  // Tools: ${ir.agent.tools.join(", ")}\n` : "";
  // A spec that DECLARES `split: test` is the explicit release-gate opt-in,
  // so the emitted bundle passes the registry's allowTestSplit escape hatch
  // (without it the guarded get() throws at runtime with no way out). Other
  // splits keep the three-argument call byte-identical.
  const allowTestArg = ir.dataset.split === "test" ? ", { allowTestSplit: true }" : "";
  const gradersJson = JSON.stringify(ir.graders, null, 2)
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");
  // D37 — failure_taxonomy is WIRED: the taxonomy lands on the synthesized
  // IR below, so the eval-runner classifies errored samples into
  // `SampleResult.failureClass` (results.json) and suppresses the noise
  // auto-retry for `recovery: fail` classes — exactly the `crewhaus eval`
  // path's semantics. (The pre-Wave-4 "ignored" warning comment is gone.)
  const hasTaxonomy = ir.failureTaxonomy !== undefined && ir.failureTaxonomy.length > 0;
  const taxonomyConst = hasTaxonomy
    ? `// D37 — the spec's failure_taxonomy: classified retry suppression +\n// failure classes in results.json, exactly as \`crewhaus eval\` wires it.\nconst FAILURE_TAXONOMY = ${JSON.stringify(ir.failureTaxonomy)};\n`
    : "";
  const taxonomyIrLine = hasTaxonomy ? "\n    failureTaxonomy: FAILURE_TAXONOMY," : "";
  // Cluster S — bridge plumbing (see EmitEvalOptions above).
  // The honesty note every generated bundle carries about what a BUNDLE run
  // is not: `--repeats` (C34 flake detection), `--record-tools`/
  // `--replay-tools` (NEW-HUNT-4) and `--resume` (NEW-HUNT-6) are
  // `crewhaus eval` flags with no bundle argv, and record/replay is
  // structurally unreachable for an entry-driven bridge anyway (runEval
  // refuses `invoker` + a recording dir — the cassette wraps WIRED tools,
  // and a bridged shape runs its own). Stating it here keeps the gap a
  // documented contract instead of a silent one.
  const capabilityNote =
    "// Bundle scope: this run has no --repeats (so no flake detection), no\n" +
    "// --record-tools/--replay-tools and no --resume. Those are `crewhaus eval`\n" +
    "// (target: cli) features; run the spec through the CLI when you need them.\n";
  const bridgeNote =
    bridge !== undefined
      ? `// Eval bridge: projected from target: ${bridge.sourceTarget} — invoker: ${bridge.kind}.\n${capabilityNote}`
      : capabilityNote;
  const bridgeImports =
    bridge === undefined
      ? ""
      : bridge.entryImport !== undefined
        ? `import { createBridgeInvoker, guardHistorySamples } from "@crewhaus/target-eval-bundle/runtime";\nimport * as __entry from ${escapeJsonString(bridge.entryImport)};\n`
        : `import { guardHistorySamples } from "@crewhaus/target-eval-bundle/runtime";\n`;
  const bridgeConsts =
    bridge === undefined
      ? ""
      : `const BRIDGE = { sourceTarget: ${escapeJsonString(bridge.sourceTarget)}, kind: ${escapeJsonString(bridge.kind)}, chatCapable: ${bridge.chatCapable}${bridge.entryImport !== undefined ? `, entryImport: ${escapeJsonString(bridge.entryImport)}` : ""} } as const;\n${
          bridge.entryImport !== undefined
            ? "// The bridged shape's ACTUAL compiled runtime drives every sample.\nconst __invoker = createBridgeInvoker(BRIDGE, __entry);\n"
            : ""
        }`;
  const samplesExpr =
    bridge !== undefined
      ? `guardHistorySamples(registry.get(DATASET.name, DATASET.version, DATASET.split${allowTestArg}), BRIDGE)`
      : `registry.get(DATASET.name, DATASET.version, DATASET.split${allowTestArg})`;
  const invokerLine =
    bridge !== undefined && bridge.entryImport !== undefined ? "      invoker: __invoker,\n" : "";
  // C33 — the reproducibility manifest half only the emitter knows. bun
  // version + platform are computed inside runEval, so this completes it.
  const cliVersionLine =
    opts.cliVersion !== undefined
      ? `      cliVersion: ${escapeJsonString(opts.cliVersion)},\n`
      : "";
  const content = `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: eval, ir version: 0)
${bridgeNote}import { dirname, resolve } from "node:path";
import { createFileBackedRegistry, overallDatasetHash } from "@crewhaus/dataset-registry";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { recordEvalRun } from "@crewhaus/eval-report";
import { runEval } from "@crewhaus/eval-runner";
${bridgeImports}
const SPEC_NAME = ${escapeJsonString(ir.name)};
const MODEL = ${escapeJsonString(ir.agent.model)};
const INSTRUCTIONS = ${escapeJsonString(ir.agent.instructions)};
const DATASET = ${JSON.stringify(ir.dataset)} as const;
const GRADER_CONFIGS = ${JSON.stringify(ir.graders)};
const AGENT_TOOLS = ${JSON.stringify(ir.agent.tools)};
const CONCURRENCY = ${ir.concurrency};
${taxonomyConst}${bridgeConsts}${toolsLine}
async function main(): Promise<void> {
  const registry = createFileBackedRegistry({
    rootDir: process.env["CREWHAUS_DATASETS_DIR"] ?? resolve(process.cwd(), ".crewhaus", "datasets"),
  });
  // Build a mini graders.yaml so we can reuse parseGradersConfig directly.
  // The IR's graders[i].name is the type discriminator — emit both name
  // (label) and type (discriminator), with opts inlined as sibling keys.
  const gradersYaml = "graders:\\n" +
    GRADER_CONFIGS.map((g: { name: string; opts?: Record<string, unknown> }) => {
      const optsLines = g.opts
        ? Object.entries(g.opts).map(([k, v]) => \`    \${k}: \${JSON.stringify(v)}\`)
        : [];
      return [\`  - name: \${g.name}\`, \`    type: \${g.name}\`, ...optsLines].join("\\n");
    }).join("\\n");
  const { compiled } = parseGradersConfig(gradersYaml);
  // The registry record behind DATASET — read once so the run-history entry
  // below can carry the same content digest \`crewhaus eval --dataset
  // registry:<name>@<version>#<split>\` records. A missing record throws the
  // registry's own "dataset … not found" here, before the agent is wired.
  const record = await registry.getRecord(DATASET.name, DATASET.version);
  const datasetHash = overallDatasetHash(record, [DATASET.split]);
  const ir = {
    version: 0 as const,
    name: SPEC_NAME,
    target: "cli" as const,
    agent: { model: MODEL, instructions: INSTRUCTIONS },
    tools: AGENT_TOOLS,
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},${taxonomyIrLine}
  };
  const result = await runEval({
    ir,
    dataset: {
      name: DATASET.name,
      samples: ${samplesExpr},
    },
    compiledGraders: compiled,
    opts: {
      concurrency: CONCURRENCY,
      // Recorded into run.json/results.json exactly as \`crewhaus eval\` does,
      // so a bundle run pinned as a baseline still has the dataset identity
      // \`eval --sentinel\` compares against.
      datasetHash,
${cliVersionLine}${invokerLine}${seedLine}    },
  });
  // Run history — the same \`.crewhaus/evals/index.jsonl\` \`crewhaus eval\`
  // appends to, so \`crewhaus eval-report history\`, \`baseline set\` and the
  // regression gate see this run exactly like a CLI-launched one. The run
  // dir's PARENT is the evals dir by construction, so a tenant-rebased run
  // records into that tenant's history rather than the global one.
  // Best-effort: bookkeeping must never fail an eval that already scored.
  const absOutDir = resolve(result.outDir);
  try {
    recordEvalRun(result, {
      specName: SPEC_NAME,
      datasetHash,
      outDir: absOutDir,
      evalsDir: dirname(absOutDir),
    });
  } catch (err) {
    process.stderr.write(\`eval bundle: could not record run in the history index: \${err instanceof Error ? err.message : String(err)}\\n\`);
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    runId: result.runId,
    passRate: result.aggregates.passRate,
    samples: result.samples.length,
    outDir: result.outDir,
  }));
}

main().catch((err) => {
  process.stderr.write(\`eval bundle error: \${err instanceof Error ? err.stack ?? err.message : String(err)}\\n\`);
  process.exit(1);
});
`;
  const files = [
    {
      path: "agent.ts",
      content,
    },
  ];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    // Cluster S — a bridged bundle imports the PARENT bundle (`../agent.ts` /
    // `../eval-entry.ts`), whose own `@crewhaus/*` imports resolve from
    // `<parent>/node_modules`, NOT from `<parent>/eval/node_modules`. Running
    // the documented `bun install && bun agent.ts` here alone therefore dies
    // with `Cannot find module '@crewhaus/runtime-core'` out of ../agent.ts —
    // so the Run section names both installs.
    const bridged = bridge !== undefined && bridge.entryImport !== undefined;
    files.push({
      path: "README.md",
      content: renderBundleReadme(
        ir,
        bridged
          ? {
              usage: {
                heading: "Run",
                body: [
                  "```sh",
                  "cd .. && bun install && cd -   # first run only — this eval bundle drives the",
                  `                               # PARENT bundle (${bridge?.entryImport}); its`,
                  "                               # dependencies resolve from ../node_modules",
                  "bun install   # first run only — installs this eval bundle's dependencies",
                  "bun agent.ts",
                  "```",
                ].join("\n"),
              },
            }
          : {},
      ),
    });
  }
  return { files };
}

// Cluster S (D36 + NEW-shape-1) — the eval-entry re-emission dispatch
// `compile({ evalEntry: true })` calls, plus a convenience re-export of the
// bridge's runtime helpers for in-repo callers.
//
// NOTE: the GENERATED bundle imports those helpers from the `./runtime`
// SUBPATH, not from here. This entry point statically imports all five shape
// codegen packages (via bridge-emit), so importing the two runtime helpers
// through it would make every bridged bundle load target-workflow,
// target-graph, target-crew, target-pipeline and target-channel-bot at boot
// just to get `createBridgeInvoker`. `runtime.ts`'s only non-type import is
// `@crewhaus/tenancy`.
export { emitSourceBundleWithEvalEntry } from "./bridge-emit";
export {
  EvalBridgeRuntimeError,
  createBridgeInvoker,
  guardHistorySamples,
  type BridgeHistoryMessage,
  type BridgeInvokeRequest,
  type BridgeInvokeResult,
  type BridgeInvoker,
  type BridgeInvokerKind,
  type BridgeSample,
  type CreateBridgeInvokerOptions,
  type EvalBridge,
} from "./runtime";
