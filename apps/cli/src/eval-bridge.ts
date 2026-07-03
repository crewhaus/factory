/**
 * Item 10 — `crewhaus compile --with-eval-harness`: auto-generate an eval
 * bridge (a `target: eval` bundle) for ANY shape's spec.
 *
 * `crewhaus eval` / `optimize` / `flywheel` hard-error on non-cli targets, so
 * the ~13 non-cli shapes (channel-bot, voice, managed, onchain, …) cannot
 * consume their own distilled Slack/web-UI feedback through the eval loop.
 * The eval bridge closes that gap: it PROJECTS a shape's lowered IR into a
 * sibling `IrEvalV0` — reusing the SAME agent model/instructions/tools — so
 * `target-eval-bundle` can emit a first-class eval bundle that drives the
 * shape's own datasets + graders.
 *
 * Two pieces live here, both side-effect-free (the CLI entry file does the IO
 * — `mkdirSync`/`writeFileSync` of the emitted bundle):
 *
 *   1. `projectEvalIr(ir, opts)` — the IR → IrEvalV0 projection. Variant-
 *      agnostic: it pulls `{ model, instructions, tools }` off whichever agent
 *      sub-shape the source variant carries (cli/channel/managed/voice/browser/
 *      onchain/onchain-game/batch/research all carry a top-level `agent`).
 *      Shapes with NO single agent (workflow/graph/crew/pipeline are
 *      multi-stage) throw a clear diagnostic — their eval bridge is a per-step
 *      concern, deferred.
 *
 *   2. `selectInvoker(target)` — names the per-shape AgentInvoker strategy the
 *      eval run should wrap the shape's runtime with (via the eval-runner
 *      `opts.invoker` seam). The emitted bundle drives the default single-turn
 *      `runChatLoop` invoker (correct for the one-shot shapes); this mapping
 *      records the runtime seam each shape's eval should ideally wrap so the
 *      bundle README + the CLI report point the author at it. Deterministic and
 *      exhaustive over the shape set.
 */
import type { IrNode } from "@crewhaus/ir";

/** Thrown on an un-projectable shape / malformed bridge options. The CLI entry
 *  file routes it through `die()`; tests assert on `.message`. */
export class EvalBridgeError extends Error {
  override readonly name = "EvalBridgeError";
}

/** The projected eval IR — structurally an `IrEvalV0` (target: "eval"). Kept as
 *  a local type so this module needs no value import from `@crewhaus/ir`. */
export type ProjectedEvalIr = {
  readonly version: 0;
  readonly name: string;
  readonly target: "eval";
  readonly agent: {
    readonly model: string;
    readonly instructions: string;
    readonly tools: readonly string[];
  };
  readonly dataset: {
    readonly name: string;
    readonly version: string;
    readonly split: "train" | "dev" | "test";
  };
  readonly graders: readonly { readonly name: string; readonly opts?: Record<string, unknown> }[];
  readonly concurrency: number;
  readonly seed?: number;
};

/** The per-shape invoker strategy an eval run should wrap the shape with. Each
 *  entry names the runtime seam the shape resumes/steps through so a downstream
 *  invoker (via eval-runner `opts.invoker`) can drive it deterministically. */
export type InvokerStrategy = {
  /** The source shape this strategy is for. */
  readonly target: string;
  /** Stable id for the invoker approach (used in README + report text). */
  readonly kind:
    | "single-turn-chat-loop"
    | "channel-resume-turn"
    | "voice-replay"
    | "gateway-request"
    | "chain-trigger"
    | "batch-item";
  /** One-line human description of what the invoker wraps. */
  readonly description: string;
};

/**
 * Shapes that carry a single top-level `agent { model, instructions, tools }`
 * and can therefore be projected 1:1 into an eval bundle. Multi-stage shapes
 * (workflow/graph/crew/pipeline) are intentionally excluded — their eval
 * bridge is a per-step projection, out of scope for slice 1.
 */
const PROJECTABLE_TARGETS: ReadonlySet<string> = new Set([
  "cli",
  "channel",
  "managed",
  "voice",
  "browser",
  "onchain",
  "onchain-game",
  "batch",
  "research",
]);

/** Multi-stage shapes with no single agent — a clearer error than "no model". */
const MULTISTAGE_TARGETS: ReadonlyMap<string, string> = new Map([
  ["workflow", "steps"],
  ["graph", "nodes"],
  ["crew", "roles"],
  ["pipeline", "stages"],
]);

export type ProjectEvalOptions = {
  /**
   * Dataset the eval bundle consumes. Defaults to `<specName>-eval` @ v1 on the
   * dev split — the convention `dataset mine` / `distill --register` write to,
   * so a shape's distilled feedback is discoverable without extra config.
   */
  readonly datasetName?: string;
  readonly datasetVersion?: string;
  readonly datasetSplit?: "train" | "dev" | "test";
  /**
   * Grader names for the projected bundle. Defaults to a single
   * `substring_match` (a registry built-in) so the bundle compiles + runs
   * credential-free; authors swap in their own graders.yaml-derived names.
   */
  readonly graders?: readonly { readonly name: string; readonly opts?: Record<string, unknown> }[];
  readonly concurrency?: number;
  readonly seed?: number;
};

type GraderEntry = { readonly name: string; readonly opts?: Record<string, unknown> };
const DEFAULT_GRADERS: readonly GraderEntry[] = [{ name: "substring_match" }];
const DEFAULT_CONCURRENCY = 2;

/**
 * Pull `{ model, instructions, tools }` off a lowered IR node, variant-
 * agnostically. Returns undefined for shapes with no single agent sub-shape.
 */
function extractAgent(
  ir: IrNode,
): { model: string; instructions: string; tools: readonly string[] } | undefined {
  const node = ir as {
    agent?: { model?: unknown; instructions?: unknown; tools?: unknown };
    tools?: unknown;
  };
  const agent = node.agent;
  if (agent === undefined || typeof agent !== "object") return undefined;
  if (typeof agent.model !== "string" || typeof agent.instructions !== "string") return undefined;
  // Tools may live on `agent.tools` (eval/browser/channel/onchain/…) or on a
  // sibling top-level `tools` (some variants). Prefer the agent-scoped list.
  const tools = Array.isArray(agent.tools)
    ? agent.tools
    : Array.isArray(node.tools)
      ? node.tools
      : [];
  return {
    model: agent.model,
    instructions: agent.instructions,
    tools: (tools as unknown[]).filter((t): t is string => typeof t === "string"),
  };
}

/**
 * Project a lowered IR node of ANY projectable shape into an `IrEvalV0`. The
 * eval bundle emitted from the result reuses the source shape's agent verbatim,
 * so the shape is evaluated on the exact model/instructions/tools it ships.
 *
 * Throws `EvalBridgeError` when the source is already `target: eval` (nothing to
 * bridge) or is a multi-stage shape with no single agent.
 */
export function projectEvalIr(ir: IrNode, opts: ProjectEvalOptions = {}): ProjectedEvalIr {
  if (ir.target === "eval") {
    throw new EvalBridgeError(
      `spec "${ir.name}" is already target: eval — no eval bridge needed (compile it directly)`,
    );
  }
  if (ir.target === "cli") {
    throw new EvalBridgeError(
      `spec "${ir.name}" is target: cli — use \`crewhaus eval\` directly (the eval bridge is for non-cli shapes)`,
    );
  }
  const multistage = MULTISTAGE_TARGETS.get(ir.target);
  if (multistage !== undefined) {
    throw new EvalBridgeError(
      `spec "${ir.name}" is target: ${ir.target} — a multi-stage shape (${multistage}) has no single agent to project; per-step eval bridges are not yet supported`,
    );
  }
  if (!PROJECTABLE_TARGETS.has(ir.target)) {
    throw new EvalBridgeError(
      `spec "${ir.name}" target: ${ir.target} is not projectable into an eval bridge`,
    );
  }
  const agent = extractAgent(ir);
  if (agent === undefined) {
    throw new EvalBridgeError(
      `spec "${ir.name}" (target: ${ir.target}) has no agent { model, instructions } to project into an eval bridge`,
    );
  }
  const graders =
    opts.graders !== undefined && opts.graders.length > 0 ? opts.graders : DEFAULT_GRADERS;
  const projected: ProjectedEvalIr = {
    version: 0,
    name: ir.name,
    target: "eval",
    agent: { model: agent.model, instructions: agent.instructions, tools: agent.tools },
    dataset: {
      name: opts.datasetName ?? `${ir.name}-eval`,
      version: opts.datasetVersion ?? "v1",
      split: opts.datasetSplit ?? "dev",
    },
    graders: graders.map((g) => ({
      name: g.name,
      ...(g.opts !== undefined ? { opts: g.opts } : {}),
    })),
    concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  };
  return projected;
}

/**
 * Select the per-shape AgentInvoker strategy an eval run should wrap the
 * shape's runtime with. Exhaustive over the projectable shapes; unknown shapes
 * fall back to the single-turn chat loop (the eval-runner default invoker).
 */
export function selectInvoker(target: string): InvokerStrategy {
  switch (target) {
    case "channel":
      return {
        target,
        kind: "channel-resume-turn",
        description:
          "wrap the channel-bot single-turn resume path (channel-adapter runTurn) so each dataset sample is a fresh inbound message",
      };
    case "voice":
      return {
        target,
        kind: "voice-replay",
        description:
          "replay recorded call-session transcripts through the voice runtime (see `crewhaus eval --voice`)",
      };
    case "managed":
      return {
        target,
        kind: "gateway-request",
        description:
          "drive the managed gateway's run handler per sample (one authenticated request per dataset row)",
      };
    case "onchain":
    case "onchain-game":
      return {
        target,
        kind: "chain-trigger",
        description:
          "invoke the onchain daemon's trigger handler per sample against a simulated chain adapter (no live broadcast)",
      };
    case "batch":
      return {
        target,
        kind: "batch-item",
        description: "run one batch-worker item per dataset sample through the queue consumer",
      };
    default:
      return {
        target,
        kind: "single-turn-chat-loop",
        description:
          "single-turn runChatLoop over the shape's agent (the eval-runner default invoker)",
      };
  }
}

/** Where the eval bridge bundle is written, relative to the primary out-dir. */
export const EVAL_BRIDGE_SUBDIR = "eval";

/**
 * Render the one-line summary the CLI prints after emitting an eval bridge, so
 * the author knows which invoker seam to wrap for a faithful eval.
 */
export function describeBridge(projected: ProjectedEvalIr, strategy: InvokerStrategy): string {
  return (
    `eval bridge for target: ${strategy.target} → dataset ${projected.dataset.name}@${projected.dataset.version}` +
    `#${projected.dataset.split}, graders [${projected.graders.map((g) => g.name).join(", ")}]; ` +
    `invoker: ${strategy.kind} (${strategy.description})`
  );
}
