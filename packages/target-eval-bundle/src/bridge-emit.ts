/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — re-emit a source shape's
 * PRIMARY bundle with its eval-entry variant, for `crewhaus compile
 * --with-eval-harness`. The shapes whose compiled runtime the bridged eval
 * bundle must invoke in-process need an importable entry:
 *
 *   - workflow / graph / pipeline — their `agent.ts` gains an exported
 *     `runForEval` + an `import.meta.main` guard (gated emitter option);
 *   - crew / channel — an ADDITIVE `eval-entry.ts` file joins the bundle
 *     (daemon/orchestrator/agent files stay byte-identical);
 *   - managed — the existing `runOneTurn` export in its `agent.ts` already
 *     IS the entry (no re-emission needed → `undefined`);
 *   - every other shape drives the eval-runner default single-turn invoker
 *     over its projected agent (no re-emission → `undefined`).
 *
 * Returns `undefined` when the plain `compile()` bundle is already the right
 * artifact; the CLI then keeps it untouched.
 */
import type { Bundle, EmitReadmeOptions, IrNode } from "@crewhaus/ir";
import { emitChannelBot } from "@crewhaus/target-channel-bot";
import { emitCrew } from "@crewhaus/target-crew";
import { emitGraph } from "@crewhaus/target-graph";
import { emitPipeline } from "@crewhaus/target-pipeline";
import { emitWorkflow } from "@crewhaus/target-workflow";

export function emitSourceBundleWithEvalEntry(
  ir: IrNode,
  opts: EmitReadmeOptions = {},
): Bundle | undefined {
  switch (ir.target) {
    case "workflow":
      return emitWorkflow(ir, { ...opts, evalEntry: true });
    case "graph":
      return emitGraph(ir, { ...opts, evalEntry: true });
    case "crew":
      return emitCrew(ir, { ...opts, evalEntry: true });
    case "pipeline":
      return emitPipeline(ir, { ...opts, evalEntry: true });
    case "channel":
      return emitChannelBot(ir, { ...opts, evalEntry: true });
    default:
      return undefined;
  }
}
