/**
 * Loop contract 0.4 (Batch F, item 6) — `crewhaus compile --emit-as cf-worker`.
 *
 * The compiler-worker's `POST /compile { emitAs: "cf-worker" }` branch drives
 * `lower()` + the three `target-cf-worker-*` emitters directly (bypassing
 * `compile()`, which always emits the LOCAL bundle). This module is the same
 * switch, so `crewhaus compile --emit-as cf-worker <spec>` produces the exact
 * bundle the studio's remote compile serves — a builder can emit a Cloudflare
 * Worker locally without a round-trip to the hosted compiler.
 *
 * It is a deliberate mirror of the compiler-worker's private `handleCompile`
 * cf-worker arm (same offline scope gate via `assertToolScopesStrict`, same
 * per-target dispatch, same unsupported-target message). Keeping the switch in
 * two places is a known seam: see the handoff note in the CLI return — the
 * intended end state is one exported `emitCfWorkerBundle` in a shared package
 * that BOTH the Worker and the CLI call, retiring this copy.
 *
 * Pillar 1 (the compiler is the protagonist): each case hands the emitter its
 * typed IR variant, narrowed on the `target` discriminant — never the raw
 * spec.
 */
import { type Bundle, assertToolScopesStrict } from "@crewhaus/compiler";
import { CompilerError } from "@crewhaus/errors";
import type { IrNode } from "@crewhaus/ir";
import { emitCfWorkerCli } from "@crewhaus/target-cf-worker-cli";
import { emitCfWorkerGraph } from "@crewhaus/target-cf-worker-graph";
import { emitCfWorkerWorkflow } from "@crewhaus/target-cf-worker-workflow";

/**
 * Target shapes the cf-worker emit path supports today. The daemon/multi-stage
 * shapes (channel, managed, crew, …) have no cf-worker emitter yet; the switch
 * below rejects them with a clear message rather than silently falling through.
 */
export const CF_WORKER_EMIT_TARGETS = ["cli", "workflow", "graph"] as const;

export type CfWorkerEmitOptions = {
  /** Origins the generated Worker accepts on `/chat` (baked into the bundle). */
  readonly allowedOrigins?: readonly string[];
  /** Emit a generated README.md into the bundle (item 42). Default true; the
   *  CLI's `--no-readme` threads `false` here. */
  readonly readme?: boolean;
};

/**
 * Lowered-IR → cf-worker `Bundle`, mirroring the compiler-worker's cf-worker
 * emit arm. Runs the SAME offline sink-scope gate the Worker applies
 * (`assertToolScopesStrict`, since this bypasses `compile()`'s built-in one),
 * then dispatches on the IR's `target` discriminant. Throws `CompilerError`
 * (a `CrewhausError`, so the CLI routes it through `die()` for a clean
 * one-liner) on an unsupported target.
 */
export function emitCfWorkerBundle(ir: IrNode, opts: CfWorkerEmitOptions = {}): Bundle {
  // FR-002 — Pillar 3 sink-side gate. This path drives lower()+emit directly
  // (bypassing compile()), so apply the SAME offline scope audit
  // compile({ strict: true }) runs over the lowered IR: an outward-reaching
  // sink whose scope:"external" cannot be verified offline is rejected here
  // too, exactly as the compiler-worker's cf-worker branch does.
  assertToolScopesStrict(ir);
  const emitOpts = {
    ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
    ...(opts.readme !== undefined ? { readme: opts.readme } : {}),
  };
  switch (ir.target) {
    case "cli":
      return emitCfWorkerCli(ir, emitOpts);
    case "workflow":
      return emitCfWorkerWorkflow(ir, emitOpts);
    case "graph":
      return emitCfWorkerGraph(ir, emitOpts);
    default:
      throw new CompilerError(
        `cf-worker emit supports target=${CF_WORKER_EMIT_TARGETS.join("|")}, got ${ir.target}`,
      );
  }
}
