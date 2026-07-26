/**
 * Item 10 — `crewhaus compile --with-eval-harness`: auto-generate an eval
 * bridge (a `target: eval` bundle) for ANY shape's spec.
 *
 * `crewhaus eval` / `optimize` / `flywheel` hard-error on non-cli targets, so
 * the non-cli shapes (channel-bot, voice, managed, workflow, crew, …) cannot
 * consume their own distilled Slack/web-UI feedback through the eval loop.
 * The eval bridge closes that gap: it PROJECTS a shape's lowered IR into a
 * sibling `IrEvalV0` so `target-eval-bundle` can emit a first-class eval
 * bundle that drives the shape's own datasets + graders.
 *
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — the bridge is RUNTIME-
 * INVOKING: bridged bundles no longer impersonate every shape as a bare
 * single-turn chat over `{ model, instructions, tools }`. Per-shape
 * strategies (the `selectInvoker` table below is the machine copy):
 *
 *   - workflow → `workflow-run`: the primary bundle re-emits with an
 *     exported `runForEval`; each sample runs the compiled step sequence
 *     end-to-end (sample.input = the step-1 trigger input), the FINAL step's
 *     output is graded, and step trace events land on the runner's
 *     per-sample bus (RunResult.events).
 *   - graph → `graph-run`: `runForEval` drives the compiled graph to
 *     `run_done` from sample.input on the per-sample RunContext; the final
 *     state JSON is graded. A HITL pause fails the sample loudly (approvals
 *     cannot resolve headless).
 *   - crew → `crew-run`: an additive `eval-entry.ts` runs one crew turn
 *     through the compiled orchestrator + role definitions with the SAME run
 *     options the daemon assembles; `crew_done.finalOutput` is graded. The
 *     runner's sessionId/sessionRootDir thread into the crew's real session
 *     machinery (transcript captured); crew trace events stay on the
 *     orchestrator's internal bus in this slice.
 *   - pipeline → `pipeline-query`: module-scope indexing runs once at entry
 *     import (the deployed boot); each sample is one single-turn query
 *     through the SAME agent + Retrieve tool the REPL serves. Chat-capable:
 *     sample `history` seeds the conversation.
 *   - channel → `channel-resume-turn`: an additive `eval-entry.ts` delivers
 *     sample.input as a fresh inbound message through the bot's REAL
 *     `createAgent().runTurn` (inbound classification, session resume
 *     machinery, in-loop evaluation block) with the adapter/webhook layer
 *     stubbed as a loopback. Chat-capable: `history` pre-seeds the session
 *     transcript so the real resume path replays it. v0 residue: the
 *     daemon's mcp_servers/knowledge boots are not mirrored (generated
 *     notes surface each), and runTurn's internal RunContext keeps trace
 *     events off the runner bus (the transcript is the captured artifact).
 *   - managed → `gateway-request`: the compiled `agent.ts` already exports
 *     `runOneTurn` (the gateway's dispatcher); the bridge drives it per
 *     sample under an isolated per-sample tenant, with the per-sample
 *     RunContext/sessionRootDir/history threaded through `extraOptions`.
 *     Chat-capable.
 *   - voice → `voice-replay` (documented): the honest voice path is
 *     `crewhaus eval --voice` over recorded call sessions; the bridged
 *     bundle runs the shape's agent through the single-turn loop with its
 *     real tools as a text projection. Chat-capable (a voice agent is a
 *     conversation).
 *   - onchain / onchain-game → `chain-trigger` (documented): the bridged
 *     bundle evals the daemon's agent through the single-turn loop with its
 *     real tools; the chain trigger daemon / simulated chain adapter is not
 *     driven in this slice. Not chat-capable.
 *   - batch → `batch-item` (documented): one sample per queue item through
 *     the single-turn loop with the worker's real tools; the queue consumer
 *     framing is not driven. Not chat-capable.
 *   - research / browser → `single-turn-chat-loop`: their compiled runtime
 *     IS one agent loop over the same wired tools; the default invoker (via
 *     the runner's wireRunOnce) is the shape's own runtime seam minus the
 *     stdin/driver framing. Not chat-capable.
 *
 * Sample `history` is REJECTED loudly at dataset load
 * (target-eval-bundle's `guardHistorySamples`) only where there is nowhere to
 * put it: an entry-driven runtime that consumes a single trigger input
 * (workflow-run / graph-run / crew-run). The chat-capable kinds seed it into
 * the shape's own conversation, and the entry-LESS kinds (voice / onchain /
 * onchain-game / batch / research / browser) run the eval-runner's default
 * single-turn invoker, which is itself a chat loop and seeds `history`
 * natively (Wave-3 B14) — `chatCapable: false` there is a statement about the
 * SHAPE, not a reason to drop a shipped runner capability.
 *
 * Two pieces live here, both side-effect-free (the CLI entry file does the
 * IO — `mkdirSync`/`writeFileSync` of the emitted bundle):
 *
 *   1. `projectEvalIr(ir, opts)` — the IR → IrEvalV0 projection. Single-agent
 *      shapes project `{ model, instructions, tools }` verbatim. The four
 *      multi-stage shapes (workflow/graph/crew/pipeline) project a bridge
 *      descriptor agent: pipeline keeps its real chat agent; workflow/graph/
 *      crew synthesize instructions naming the driven bundle (their agent is
 *      never invoked — the runtime entry is) with the entry stage's model as
 *      the recorded model identity. The source spec's `failure_taxonomy`
 *      rides the projection, so bridged bundles classify failures too (D37).
 *   2. `selectInvoker(target)` — the per-shape strategy: invoker kind, the
 *      compiled entry the bundle imports (when runtime-invoking), and
 *      chat-capability for the history gate.
 */
import { createHash } from "node:crypto";
import type { IrFailureTaxonomy, IrNode } from "@crewhaus/ir";

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
  /** D37 — the source spec's failure taxonomy, carried into the bundle so
   *  errored samples classify exactly as `crewhaus eval` classifies them. */
  readonly failureTaxonomy?: IrFailureTaxonomy;
};

/** The per-shape invoker strategy an eval run wraps the shape with. Entry-
 *  driven kinds carry the compiled entry module the bundle imports; the rest
 *  document the (real-tools) single-turn fallback with its fidelity note. */
export type InvokerStrategy = {
  /** The source shape this strategy is for. */
  readonly target: string;
  /** Stable id for the invoker approach (used in README + report text AND as
   *  the generated bundle's dispatch key). */
  readonly kind:
    | "single-turn-chat-loop"
    | "channel-resume-turn"
    | "voice-replay"
    | "gateway-request"
    | "chain-trigger"
    | "batch-item"
    | "workflow-run"
    | "graph-run"
    | "crew-run"
    | "pipeline-query";
  /** One-line human description of what the invoker wraps. */
  readonly description: string;
  /** May sample `history` seed this shape? Non-chat shapes reject
   *  history-carrying samples loudly at dataset load. */
  readonly chatCapable: boolean;
  /** Relative import (from the eval bundle dir) of the compiled runtime
   *  entry module, for the runtime-invoking kinds. */
  readonly entryImport?: string;
};

/**
 * Shapes that carry a single top-level `agent { model, instructions, tools }`
 * and therefore project 1:1 into the eval bundle's agent block.
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

/** Multi-stage shapes — bridged by DRIVING their compiled runtime (cluster S
 *  lifted the former rejection); the map records each shape's stage noun for
 *  diagnostics + synthesized instructions. */
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
   * `expected_contains` (the deterministic gold-substring built-in) so the
   * bundle compiles + runs credential-free; authors swap in their own
   * graders.yaml-derived names. (Cluster S fixed the previous default,
   * `substring_match` — not a real grader type, so every default bridged
   * bundle failed grader parsing at boot.)
   */
  readonly graders?: readonly { readonly name: string; readonly opts?: Record<string, unknown> }[];
  readonly concurrency?: number;
  readonly seed?: number;
};

type GraderEntry = { readonly name: string; readonly opts?: Record<string, unknown> };
const DEFAULT_GRADERS: readonly GraderEntry[] = [{ name: "expected_contains" }];
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

/** One driven stage, reduced to the fields that change what the runtime does. */
type StageIdentity = {
  readonly name?: string;
  readonly model?: string;
  readonly instructions?: string;
  readonly tools?: readonly string[];
};

/**
 * Digest the stages the bridged runtime actually executes.
 *
 * The descriptor agent block is never used as a chat prompt, but it IS what
 * the run-history `specHash` digests (eval-runner hashes
 * {name,target,model,instructions,tools}). Without this, every bridged
 * multi-stage eval recorded a specHash invariant to step/node/role
 * instructions, tools and per-stage models — two materially different
 * workflows would share a baseline, and cluster R's `--resume` guard would
 * happily resume a run across a full rewrite. Folding the digest into the
 * descriptor instructions restores the documented contract ("changes on every
 * instruction edit") for bridged bundles too.
 */
function stageDigest(stages: readonly StageIdentity[]): string {
  const canonical = JSON.stringify(
    stages.map((s) => [s.name ?? "", s.model ?? "", s.instructions ?? "", [...(s.tools ?? [])]]),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Cluster S — the multi-stage projection: the recorded agent block is a
 * bridge DESCRIPTOR (the runtime entry is what actually runs), so pipeline
 * keeps its real chat agent while workflow/graph/crew record the entry
 * stage's model plus synthesized instructions naming the driven bundle and
 * carrying a digest of every driven stage (so run identity tracks the real
 * runtime — see `stageDigest`).
 * Throws when the entry stage cannot be resolved (malformed direct IR — the
 * spec parser guarantees it otherwise).
 */
function extractMultistageAgent(ir: IrNode): {
  model: string;
  instructions: string;
  tools: readonly string[];
} {
  if (ir.target === "pipeline") {
    // The pipeline's runtime IS its chat agent (+ Retrieve over the indexed
    // corpus) — keep the real block.
    return { model: ir.agent.model, instructions: ir.agent.instructions, tools: [] };
  }
  const describe = (unit: string, stages: readonly StageIdentity[], model: string | undefined) => {
    if (model === undefined) {
      throw new EvalBridgeError(
        `spec "${ir.name}" (target: ${ir.target}) has no resolvable entry ${unit} to project — the IR is malformed`,
      );
    }
    return {
      model,
      instructions: `[eval bridge] multi-stage ${ir.target} "${ir.name}" (${stages.length} ${unit}s) — samples are driven end-to-end through the compiled bundle's runtime entry; per-${unit} instructions live in the primary bundle. This descriptor block is recorded for run identity and is never used as a chat prompt. ${unit} digest: ${stageDigest(stages)} (covers every ${unit}'s name, model, instructions and tools, so the recorded specHash moves whenever the driven runtime does).`,
      tools: [] as readonly string[],
    };
  };
  if (ir.target === "workflow") {
    return describe("step", ir.steps, ir.steps[0]?.model);
  }
  if (ir.target === "graph") {
    const entry = ir.nodes.find((n) => n.name === ir.entry);
    return describe("node", ir.nodes, entry?.model ?? ir.nodes[0]?.model);
  }
  if (ir.target === "crew") {
    const entry = ir.roles.find((r) => r.name === ir.entry);
    return describe("role", ir.roles, entry?.model ?? ir.roles[0]?.model);
  }
  throw new EvalBridgeError(`spec "${ir.name}" target: ${ir.target} is not a multi-stage shape`);
}

/**
 * Project a lowered IR node of ANY bridgeable shape into an `IrEvalV0`.
 * Single-agent shapes reuse the source agent verbatim; the four multi-stage
 * shapes (cluster S) project a bridge-descriptor agent — the emitted bundle
 * drives their compiled runtime, so the shape is evaluated on exactly the
 * artifact it ships.
 *
 * Throws `EvalBridgeError` when the source is already `target: eval` (nothing
 * to bridge) or `target: cli` (use `crewhaus eval` directly).
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
  const multistage = MULTISTAGE_TARGETS.has(ir.target);
  if (!multistage && !PROJECTABLE_TARGETS.has(ir.target)) {
    throw new EvalBridgeError(
      `spec "${ir.name}" target: ${ir.target} is not projectable into an eval bridge`,
    );
  }
  let agent: { model: string; instructions: string; tools: readonly string[] };
  if (multistage) {
    agent = extractMultistageAgent(ir);
  } else {
    const extracted = extractAgent(ir);
    if (extracted === undefined) {
      throw new EvalBridgeError(
        `spec "${ir.name}" (target: ${ir.target}) has no agent { model, instructions } to project into an eval bridge`,
      );
    }
    agent = extracted;
  }
  const graders =
    opts.graders !== undefined && opts.graders.length > 0 ? opts.graders : DEFAULT_GRADERS;
  // D37 — the source spec's failure taxonomy rides the projection so the
  // emitted bundle classifies errored samples exactly as `crewhaus eval`
  // would (every bridgeable variant carries the optional field).
  const failureTaxonomy = (ir as { failureTaxonomy?: IrFailureTaxonomy }).failureTaxonomy;
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
    ...(failureTaxonomy !== undefined && failureTaxonomy.length > 0 ? { failureTaxonomy } : {}),
  };
  return projected;
}

/**
 * Select the per-shape invoker strategy. Runtime-invoking kinds carry the
 * compiled entry the bundle imports; documented kinds fall back to the
 * single-turn loop over the shape's REAL wired tools, with the fidelity gap
 * named in the description. Exhaustive over the bridgeable shapes; unknown
 * shapes fall back to the single-turn chat loop.
 */
export function selectInvoker(target: string): InvokerStrategy {
  switch (target) {
    case "workflow":
      return {
        target,
        kind: "workflow-run",
        chatCapable: false,
        entryImport: "../agent.ts",
        description:
          "run the compiled workflow end-to-end per sample (runForEval in ../agent.ts): sample.input is the step-1 trigger input, the final step's output is graded, step trace events land in RunResult.events",
      };
    case "graph":
      return {
        target,
        kind: "graph-run",
        chatCapable: false,
        entryImport: "../agent.ts",
        description:
          "drive the compiled graph to run_done from sample.input per sample (runForEval in ../agent.ts); the final state JSON is graded and node/judge trace events land in RunResult.events (a HITL pause fails the sample loudly)",
      };
    case "crew":
      return {
        target,
        kind: "crew-run",
        chatCapable: false,
        entryImport: "../eval-entry.ts",
        description:
          "run one crew turn per sample through the compiled orchestrator + roles with the daemon's run options (runForEval in ../eval-entry.ts); crew_done.finalOutput is graded and the crew transcript lands in the sample artifacts",
      };
    case "pipeline":
      return {
        target,
        kind: "pipeline-query",
        chatCapable: true,
        entryImport: "../agent.ts",
        description:
          "feed sample.input (plus any sample history) through the indexed pipeline agent + Retrieve tool (runForEval in ../agent.ts; module-scope indexing runs once at entry import — the deployed boot)",
      };
    case "channel":
      return {
        target,
        kind: "channel-resume-turn",
        chatCapable: true,
        entryImport: "../eval-entry.ts",
        description:
          "deliver sample.input as a fresh inbound message through the compiled bot's real runTurn (inbound classification + session resume machinery; adapter/webhook layer stubbed as a loopback; sample history pre-seeds the session transcript)",
      };
    case "voice":
      return {
        target,
        kind: "voice-replay",
        chatCapable: true,
        description:
          "replay recorded call-session transcripts through `crewhaus eval --voice` (the honest voice path); this bridged bundle runs the voice agent through the single-turn loop with its real tools as a text projection",
      };
    case "managed":
      return {
        target,
        kind: "gateway-request",
        chatCapable: true,
        entryImport: "../agent.ts",
        description:
          "drive the compiled gateway's runOneTurn dispatcher per sample (runOneTurn in ../agent.ts) under an isolated per-sample tenant, with the per-sample RunContext + history threaded through extraOptions",
      };
    case "onchain":
    case "onchain-game":
      return {
        target,
        kind: "chain-trigger",
        chatCapable: false,
        description:
          "eval the onchain daemon's agent through the single-turn loop with its real tools (no live broadcast); the chain trigger daemon / simulated chain adapter is not driven in this slice",
      };
    case "batch":
      return {
        target,
        kind: "batch-item",
        chatCapable: false,
        description:
          "run one sample per queue item through the single-turn loop with the worker's real tools; the queue consumer framing is not driven in this slice",
      };
    default:
      return {
        target,
        kind: "single-turn-chat-loop",
        chatCapable: false,
        description:
          "single-turn agent loop over the shape's agent with its real wired tools (the eval-runner default invoker) — the shape's own runtime seam minus its stdin/driver framing",
      };
  }
}

/** Where the eval bridge bundle is written, relative to the primary out-dir. */
export const EVAL_BRIDGE_SUBDIR = "eval";

/**
 * Render the one-line summary the CLI prints after emitting an eval bridge, so
 * the author knows which invoker drives the shape (and whether sample history
 * is accepted).
 */
export function describeBridge(projected: ProjectedEvalIr, strategy: InvokerStrategy): string {
  // History is rejected only where there is nowhere to put it: an entry-driven
  // runtime that consumes a single trigger input. An entry-LESS bridge runs
  // the eval-runner's default single-turn chat loop, which seeds history
  // natively (B14) even though the shape itself is not a conversation.
  const history = strategy.chatCapable
    ? "seeded"
    : strategy.entryImport !== undefined
      ? "rejected (single-trigger runtime)"
      : "seeded by the default single-turn invoker";
  return (
    `eval bridge for target: ${strategy.target} → dataset ${projected.dataset.name}@${projected.dataset.version}` +
    `#${projected.dataset.split}, graders [${projected.graders.map((g) => g.name).join(", ")}]; ` +
    `invoker: ${strategy.kind} (${strategy.description}); ` +
    `history samples: ${history}`
  );
}
