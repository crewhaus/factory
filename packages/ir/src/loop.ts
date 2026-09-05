/**
 * Loop contract 0.4 (Batch B, G42) — `projectLoop(ir)`: project a lowered
 * {@link IrNode} into its canonical AGENT-LOOP phase graph.
 *
 * The {@link LoopProjection} shape below is the WIRE CONTRACT shared with
 * the studio's client-side projection (`studio-pwa/src/lib/loop-model.ts`):
 * plain JSON-serializable data — no functions, no classes — rendered by the
 * /builder page verbatim. The compiler-worker's `POST /loop` endpoint
 * returns exactly this object for `projectLoop(lower(parseSpec(yaml)))`.
 *
 * Two projection kinds:
 *   - `"ring"`   — single-agent shapes (cli / channel / managed): the
 *     seven-component loop as ring segments (perceive / reason / act /
 *     evaluate / update) plus the Stop and Safety boundary panels.
 *   - `"canvas"` — step/node/role shapes (workflow / graph / crew /
 *     pipeline / research / batch): steps/nodes/roles as canvas nodes,
 *     edges/handoffs as arrows, HITL and judge gates surfaced, each node
 *     carrying its own mini seven-segment summary.
 *
 * The remaining shapes (voice / browser / eval / onchain / onchain-game)
 * fall back to the generic ring with an honest warning — "say so rather
 * than shrink".
 *
 * MAPPING SOURCE OF TRUTH: the IR's RESOLVED fields, not the raw spec.
 * This differs from the studio's spec-object projection in two deliberate
 * ways:
 *   - default-on config that the runtime WILL wire lights its segment
 *     (e.g. cli continuity is default-on in 0.3+, so `update` is active
 *     unless the spec opted out) — the projection reports what the loop
 *     actually does;
 *   - per-step/node models are resolved at lower time, so node minis always
 *     show the resolved model (the spec-side "inherits the spec-level
 *     model" state is not reconstructible from IR).
 * Stop stays defaults-honest: with neither `budget` nor `limits` in the IR
 * the segment is inactive and {@link NO_BUDGET_WARNING} is emitted.
 *
 * `keys` entries remain SPEC-dotted paths (`"agent.model_pool"`,
 * `"channels.slack"`, `"tools[webFetch]"`) so the operator can jump from a
 * segment to the YAML that (would) configure it.
 *
 * Pure functions of the IR — no I/O, no imports beyond the IR types.
 */
import type {
  IrBudget,
  IrChannelV0,
  IrCompaction,
  IrContinuity,
  IrEvaluation,
  IrHook,
  IrJudge,
  IrLearning,
  IrLimits,
  IrManagedV0,
  IrMcpServers,
  IrMemory,
  IrModelPool,
  IrModelTiers,
  IrNode,
  IrPermissions,
  IrSecurity,
  IrSubAgentDefinition,
  IrThinking,
  IrV0,
} from "./index";

// --- projection wire shape ---------------------------------------------------

/** The seven loop components, in canonical render order. */
export type LoopSegmentId =
  | "perceive"
  | "reason"
  | "act"
  | "evaluate"
  | "update"
  | "stop"
  | "safety";

/** Canonical segment order — every ring and every node mini uses exactly this. */
export const SEGMENT_ORDER: readonly LoopSegmentId[] = [
  "perceive",
  "reason",
  "act",
  "evaluate",
  "update",
  "stop",
  "safety",
];

/**
 * One loop component. `active` iff the RESOLVED IR configures it; `keys`
 * are the dotted spec paths that lit it (e.g. "agent.model_pool",
 * "tools[webFetch]", "channels.slack"); `summary` is a one-line,
 * operator-facing description of what is (or isn't) configured.
 */
export type LoopSegment = {
  readonly id: LoopSegmentId;
  readonly active: boolean;
  readonly keys: readonly string[];
  readonly summary: string;
};

/** The single-agent loop ring: always all seven segments, in SEGMENT_ORDER. */
export type LoopRing = {
  readonly segments: readonly LoopSegment[];
};

/**
 * What a canvas node represents on its shape. EXACTLY the studio's
 * `LoopNodeKind` union (studio-pwa `src/lib/loop-model.ts`) — the studio
 * renderer is the wire consumer, so factory must not emit kinds outside it.
 * Research branches and the batch queue render as `"node"`, mirroring the
 * studio's own client-side projection of those shapes.
 */
export type LoopNodeKind = "step" | "node" | "role" | "doc";

/**
 * One canvas node (a workflow step, graph node, crew role, research branch,
 * batch queue, or a doc/report artifact). `hitl` marks a human-approval
 * badge; `mini` is the node's own seven-segment summary.
 */
export type LoopNode = {
  readonly id: string;
  readonly label: string;
  readonly kind: LoopNodeKind;
  readonly hitl?: boolean;
  readonly mini: readonly LoopSegment[];
};

/** One canvas arrow. `conditional` marks a guarded edge (a graph `when`, a
 *  judge gate's pass/retry, a routing rule). */
export type LoopEdge = {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly conditional?: boolean;
};

export type LoopCanvas = {
  readonly nodes: readonly LoopNode[];
  readonly edges: readonly LoopEdge[];
};

/**
 * The full projection. Exactly one of `ring` / `canvas` is set, matching
 * `kind`. `target` is the IR's target. `warnings` carry defaults-only
 * boundaries (see {@link NO_BUDGET_WARNING}), family hints for fallback
 * targets, and structural notes (crew routing, dangling graph edges,
 * parallel barrier groups).
 */
export type LoopProjection = {
  readonly kind: "ring" | "canvas";
  readonly target: string;
  readonly ring?: LoopRing;
  readonly canvas?: LoopCanvas;
  readonly warnings: readonly string[];
};

// --- target families -----------------------------------------------------------

/** Single-agent shapes rendered as the seven-component ring. */
export const RING_TARGETS: readonly string[] = ["cli", "channel", "managed"];

/** Step/node/role shapes rendered as a node canvas. */
export const CANVAS_TARGETS: readonly string[] = [
  "workflow",
  "graph",
  "crew",
  "pipeline",
  "research",
  "batch",
];

/**
 * The exact defaults-only Stop warning (guardrails-first affordance): with
 * neither `budget:` nor `limits:` the loop's only boundary is the runtime's
 * hardcoded tool-iteration cap. Shared verbatim with the studio.
 */
export const NO_BUDGET_WARNING = "no budget: — stops only at the 500-iteration default";

/**
 * Tool names that count as PERCEPTION (bringing outside state into the
 * loop) rather than plain action. Everything in `tools` still counts toward
 * the Act segment; matching names ALSO light Perceive.
 */
export const PERCEIVE_TOOL_RE = /(browse|fetch|web|search|crawl|navigate|retrieve)/i;

// --- tiny formatting helpers ----------------------------------------------------

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** "3 tools (read, write, bash)" — list up to `max` names, then "+n more". */
function countList(n: number, noun: string, names: readonly string[], max = 6): string {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  const list =
    shown.length > 0 ? ` (${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""})` : "";
  return `${n} ${noun}${n === 1 ? "" : "s"}${list}`;
}

function segment(
  id: LoopSegmentId,
  keys: readonly string[],
  activeSummary: string,
  inactiveSummary: string,
): LoopSegment {
  const active = keys.length > 0;
  return { id, active, keys, summary: active ? activeSummary : inactiveSummary };
}

/** IR limits fields, rendered back as the spec's snake_case key names. */
const LIMITS_SPEC_KEYS: ReadonlyArray<readonly [keyof IrLimits, string]> = [
  ["maxToolIterations", "max_tool_iterations"],
  ["maxConcurrentTools", "max_concurrent_tools"],
  ["contextLimit", "context_limit"],
  ["deadlineMs", "deadline_ms"],
  ["turnTimeoutMs", "turn_timeout_ms"],
  ["modelCallTimeoutMs", "model_call_timeout_ms"],
  ["loopDetection", "loop_detection"],
  ["crew", "crew"],
];

function limitsSpecKeyNames(limits: IrLimits): string[] {
  return LIMITS_SPEC_KEYS.filter(([irKey]) => limits[irKey] !== undefined).map(
    ([, specKey]) => specKey,
  );
}

function describeEvaluation(e: IrEvaluation): string {
  const threshold = e.threshold !== undefined ? `, threshold ${e.threshold}` : "";
  const retries = e.maxRetries > 1 ? `, ≤ ${e.maxRetries} retries` : "";
  return `in-loop evaluation (${e.grader.type}${threshold}, on fail: ${e.onFail}${retries})`;
}

function describeJudge(j: IrJudge): string {
  return `judge gate (threshold ${j.threshold}, on fail: ${j.onFail})`;
}

function describeModelPool(pool: IrModelPool): string {
  return `adaptive model pool (${pool.candidates.length} candidates, policy: ${pool.policy})`;
}

// --- the seven ring segments -------------------------------------------------------

/**
 * The normalized single-agent view a ring is built from. Each ring/fallback
 * shape maps its own IR fields into this bag; absent fields simply leave
 * their segment inactive.
 */
type RingView = {
  readonly model: string;
  /** Spec path of the tools list ("tools" | "agent.tools"); undefined when
   *  the shape carries no tool catalog (managed). */
  readonly toolsKey?: "tools" | "agent.tools";
  readonly tools?: readonly string[];
  readonly mcpServers?: IrMcpServers;
  readonly subAgents?: readonly IrSubAgentDefinition[];
  /** Configured channel names, in declaration order (channel shape). */
  readonly channels?: readonly string[];
  readonly heartbeat?: boolean;
  readonly thinking?: IrThinking;
  readonly modelTiers?: IrModelTiers;
  readonly modelPool?: IrModelPool;
  readonly evaluation?: IrEvaluation;
  readonly learning?: IrLearning;
  readonly security?: IrSecurity;
  readonly memory?: IrMemory;
  readonly continuity?: IrContinuity;
  /** Whether this shape defaults continuity ON (so an absent `continuity`
   *  is an explicit opt-out, not merely unconfigured). */
  readonly continuityDefaultOn?: boolean;
  readonly thredz?: boolean;
  readonly compaction?: IrCompaction;
  readonly budget?: IrBudget;
  readonly limits?: IrLimits;
  readonly permissions?: IrPermissions;
  readonly hooks?: readonly IrHook[];
  readonly transactionPolicy?: boolean;
};

function ringSegmentsFromView(view: RingView): LoopSegment[] {
  const tools = view.tools ?? [];
  const toolsKey = view.toolsKey ?? "tools";

  // perceive ← browse/fetch/web tools + channel ingress (+ heartbeat timer).
  const perceiveTools = tools.filter((n) => PERCEIVE_TOOL_RE.test(n));
  const perceiveKeys: string[] = perceiveTools.map((n) => `${toolsKey}[${n}]`);
  const perceiveParts: string[] = [];
  if (perceiveTools.length > 0) perceiveParts.push(`web tools: ${perceiveTools.join(", ")}`);
  if (view.channels !== undefined && view.channels.length > 0) {
    perceiveKeys.push(...view.channels.map((c) => `channels.${c}`));
    perceiveParts.push(`channel ingress: ${view.channels.join(", ")}`);
  }
  if (view.heartbeat === true) {
    perceiveKeys.push("heartbeat");
    perceiveParts.push("heartbeat timer");
  }
  const perceive = segment(
    "perceive",
    perceiveKeys,
    perceiveParts.join(" · "),
    "input arrives only from the incoming message — no browse/fetch/web tools or channel ingress",
  );

  // reason ← agent.thinking / agent.model_tiers / agent.model_pool.
  const reasonKeys: string[] = [];
  const reasonParts: string[] = [];
  if (view.thinking !== undefined) {
    reasonKeys.push("agent.thinking");
    reasonParts.push("extended thinking");
  }
  if (view.modelTiers !== undefined) {
    reasonKeys.push("agent.model_tiers");
    reasonParts.push("two-tier turn routing");
  }
  if (view.modelPool !== undefined) {
    reasonKeys.push("agent.model_pool");
    reasonParts.push(describeModelPool(view.modelPool));
  }
  const reason = segment(
    "reason",
    reasonKeys,
    `${reasonParts.join(" · ")} on ${view.model}`,
    `single fixed model (${view.model}) — no thinking, tiers, or pool`,
  );

  // act ← tools / mcp_servers / sub_agents.
  const actKeys: string[] = [];
  const actParts: string[] = [];
  if (tools.length > 0) {
    actKeys.push(toolsKey);
    actParts.push(countList(tools.length, "tool", tools));
  }
  const mcpNames = view.mcpServers !== undefined ? Object.keys(view.mcpServers) : [];
  if (mcpNames.length > 0) {
    actKeys.push("mcp_servers");
    actParts.push(countList(mcpNames.length, "MCP server", mcpNames));
  }
  if (view.subAgents !== undefined && view.subAgents.length > 0) {
    actKeys.push("agent.sub_agents");
    actParts.push(
      countList(
        view.subAgents.length,
        "sub-agent",
        view.subAgents.map((s) => s.name),
      ),
    );
  }
  const act = segment(
    "act",
    actKeys,
    actParts.join(" · "),
    "no tools, MCP servers, or sub-agents — replies in text only",
  );

  // evaluate ← evaluation / learning.exam / security.justification.
  const evalKeys: string[] = [];
  const evalParts: string[] = [];
  if (view.evaluation !== undefined) {
    evalKeys.push("evaluation");
    evalParts.push(describeEvaluation(view.evaluation));
  }
  if (view.learning?.exam !== undefined) {
    evalKeys.push("learning.exam");
    evalParts.push(`competency exam (${view.learning.exam.dataset})`);
  }
  if (view.security?.justification !== undefined) {
    evalKeys.push("security.justification");
    evalParts.push(`justification intent gate (judge: ${view.security.justification.judge})`);
  }
  const evaluate = segment(
    "evaluate",
    evalKeys,
    evalParts.join(" · "),
    "no in-loop evaluation — output is never checked before it ships",
  );

  // update ← memory / continuity / thredz / compaction.
  const updKeys: string[] = [];
  const updParts: string[] = [];
  if (view.memory !== undefined) {
    updKeys.push("memory");
    const quals: string[] = [];
    if (view.memory.backend !== undefined) quals.push(`${view.memory.backend} backend`);
    if (view.memory.wiki !== undefined) quals.push("wiki");
    if (view.memory.dream !== undefined) quals.push("dream");
    updParts.push(`memory${quals.length > 0 ? ` (${quals.join(", ")})` : ""}`);
  }
  if (view.continuity !== undefined) {
    updKeys.push("continuity");
    updParts.push(`continuity (proof: ${view.continuity.proof})`);
  }
  if (view.thredz === true) {
    updKeys.push("thredz");
    updParts.push("thredz wiki");
  }
  if (view.compaction !== undefined && Object.keys(view.compaction).length > 0) {
    updKeys.push("compaction");
    updParts.push(`compaction${view.compaction.curate === true ? " (curated)" : ""}`);
  }
  const update = segment(
    "update",
    updKeys,
    updParts.join(" · "),
    view.continuityDefaultOn === true && view.continuity === undefined
      ? "continuity explicitly disabled — nothing durable persists between sessions"
      : "no memory/continuity/thredz configured — facts are not persisted between sessions",
  );

  // stop ← budget / limits (hardcoded runtime defaults when absent).
  const stopKeys: string[] = [];
  const stopParts: string[] = [];
  if (view.budget !== undefined) {
    stopKeys.push("budget");
    const usd = view.budget.usdMicros / 1_000_000;
    const onExceed =
      view.budget.onExceed.kind === "degrade"
        ? `on exceed: degrade → ${view.budget.onExceed.model}`
        : "on exceed: stop";
    // 0.6.0 — `scope` is only carried when declared, so the rendered summary
    // is byte-identical for every pre-0.6.0 IR.
    const scope = view.budget.scope !== undefined ? `; scope: ${view.budget.scope}` : "";
    stopParts.push(`budget $${usd} (${onExceed}${scope})`);
  }
  if (view.limits !== undefined) {
    stopKeys.push("limits");
    const names = limitsSpecKeyNames(view.limits);
    stopParts.push(`limits${names.length > 0 ? ` (${names.join(", ")})` : ""}`);
  }
  const stop = segment(
    "stop",
    stopKeys,
    stopParts.join(" · "),
    "defaults only — stops at the 500-iteration cap",
  );

  // safety ← permissions / security / hooks / transaction_policy.
  const safeKeys: string[] = [];
  const safeParts: string[] = [];
  const perms = view.permissions;
  if (perms !== undefined && (perms.mode !== undefined || perms.rules.length > 0)) {
    safeKeys.push("permissions");
    const quals = [
      perms.mode !== undefined ? `mode: ${perms.mode}` : "",
      perms.rules.length > 0
        ? `${perms.rules.length} rule${perms.rules.length === 1 ? "" : "s"}`
        : "",
    ]
      .filter((q) => q.length > 0)
      .join(", ");
    safeParts.push(`permissions${quals ? ` (${quals})` : ""}`);
  }
  if (view.security !== undefined) {
    safeKeys.push("security");
    const egress = view.security.egressMatcher;
    safeParts.push(`security fabric${egress !== undefined ? ` (egress: ${egress})` : ""}`);
  }
  if (view.hooks !== undefined && view.hooks.length > 0) {
    safeKeys.push("hooks");
    safeParts.push("hooks");
  }
  if (view.transactionPolicy === true) {
    safeKeys.push("transaction_policy");
    safeParts.push("transaction policy");
  }
  const safety = segment(
    "safety",
    safeKeys,
    safeParts.join(" · "),
    "no permissions, security, or transaction policy — runtime defaults only",
  );

  return [perceive, reason, act, evaluate, update, stop, safety];
}

// --- node mini segments ---------------------------------------------------------

/** The normalized per-node view a canvas node's mini is built from. */
type MiniView = {
  readonly model?: string;
  readonly thinking?: IrThinking;
  readonly modelPool?: IrModelPool;
  readonly tools?: readonly string[];
  readonly subAgents?: readonly IrSubAgentDefinition[];
  readonly judge?: IrJudge;
  readonly hitlPrompt?: string;
};

function miniSegments(view: MiniView): LoopSegment[] {
  const tools = view.tools ?? [];

  const perceiveTools = tools.filter((n) => PERCEIVE_TOOL_RE.test(n));
  const perceive = segment(
    "perceive",
    perceiveTools.map((n) => `tools[${n}]`),
    `web tools: ${perceiveTools.join(", ")}`,
    "sees only upstream state and its instructions",
  );

  const reasonKeys: string[] = [];
  const reasonParts: string[] = [];
  if (view.model !== undefined) {
    reasonKeys.push("model");
    reasonParts.push(`model: ${view.model}`);
  }
  if (view.thinking !== undefined) {
    reasonKeys.push("thinking");
    reasonParts.push("extended thinking");
  }
  if (view.modelPool !== undefined) {
    reasonKeys.push("model_pool");
    reasonParts.push(describeModelPool(view.modelPool));
  }
  const reason = segment(
    "reason",
    reasonKeys,
    reasonParts.join(" · "),
    "inherits the spec-level model",
  );

  const actKeys: string[] = [];
  const actParts: string[] = [];
  if (tools.length > 0) {
    actKeys.push("tools");
    actParts.push(countList(tools.length, "tool", tools));
  }
  if (view.subAgents !== undefined && view.subAgents.length > 0) {
    actKeys.push("sub_agents");
    actParts.push(
      countList(
        view.subAgents.length,
        "sub-agent",
        view.subAgents.map((s) => s.name),
      ),
    );
  }
  const act = segment("act", actKeys, actParts.join(" · "), "no tools — replies in text only");

  const evaluate = segment(
    "evaluate",
    view.judge !== undefined ? ["judge"] : [],
    view.judge !== undefined ? describeJudge(view.judge) : "",
    "no in-loop evaluation",
  );

  // IR carries no node-level memory or budget/limits — those are spec-level.
  const update = segment("update", [], "", "no node-level memory — shares the spec's stores");
  const stop = segment("stop", [], "", "bounded by the surrounding orchestration");

  const safety = segment(
    "safety",
    view.hitlPrompt !== undefined ? ["hitl"] : [],
    `human approval gate${view.hitlPrompt !== undefined ? `: "${truncate(view.hitlPrompt, 60)}"` : ""}`,
    "no approval gate on this node",
  );

  return [perceive, reason, act, evaluate, update, stop, safety];
}

/** The all-inactive mini used by artifact nodes (docs, queues, reports). */
function emptyMini(): LoopSegment[] {
  return miniSegments({});
}

// --- canvas builders ---------------------------------------------------------------

/** Allocate a unique node id, suffixing duplicates ("draft", "draft-2", …). */
function claimId(used: Set<string>, wanted: string): string {
  let id = wanted;
  let n = 2;
  while (used.has(id)) {
    id = `${wanted}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function workflowCanvas(
  ir: Extract<IrNode, { target: "workflow" }>,
  warnings: string[],
): LoopCanvas {
  if (ir.steps.length === 0) warnings.push("workflow has no steps — nothing to run");
  const used = new Set<string>();
  const nodes: LoopNode[] = ir.steps.map((step, i) => ({
    id: claimId(used, step.name),
    label: `${i + 1}. ${step.name}`,
    kind: "step" as const,
    mini: miniSegments(
      step.kind === "judge"
        ? { model: step.model, ...(step.judge !== undefined ? { judge: step.judge } : {}) }
        : {
            model: step.model,
            ...(step.thinking !== undefined ? { thinking: step.thinking } : {}),
            // Item 9 (G37) — per-step model pool surfaces in the reason segment.
            ...(step.modelPool !== undefined ? { modelPool: step.modelPool } : {}),
            tools: step.tools,
          },
    ),
  }));
  const edges: LoopEdge[] = [];
  for (let i = 0; i < ir.steps.length; i += 1) {
    const step = ir.steps[i];
    const node = nodes[i];
    const next = nodes[i + 1];
    if (step === undefined || node === undefined) continue;
    if (next !== undefined) {
      // The edge LEAVING a judge step only fires when the gate passes
      // (except on_fail: continue, where output flows regardless).
      if (step.kind === "judge" && step.judge !== undefined && step.judge.onFail !== "continue") {
        edges.push({ from: node.id, to: next.id, label: "pass", conditional: true });
      } else {
        edges.push({ from: node.id, to: next.id });
      }
    }
    const prev = nodes[i - 1];
    if (
      step.kind === "judge" &&
      step.judge !== undefined &&
      step.judge.onFail === "retry_previous" &&
      prev !== undefined
    ) {
      edges.push({
        from: node.id,
        to: prev.id,
        label: `retry ≤ ${step.judge.maxRetries}`,
        conditional: true,
      });
    }
  }
  return { nodes, edges };
}

function graphCanvas(ir: Extract<IrNode, { target: "graph" }>, warnings: string[]): LoopCanvas {
  const ids = ir.nodes.map((n) => n.name);
  if (ids.length === 0) warnings.push("graph has no nodes — nothing to run");
  if (ids.length > 0 && !ids.includes(ir.entry)) {
    warnings.push(`entry "${ir.entry}" is not a declared node`);
  }
  const nodes: LoopNode[] = ir.nodes.map((node) => ({
    id: node.name,
    label: node.name === ir.entry ? `${node.name} (entry)` : node.name,
    kind: "node" as const,
    ...(node.hitlPrompt !== undefined ? { hitl: true } : {}),
    mini: miniSegments(
      node.kind === "judge"
        ? { model: node.model, ...(node.judge !== undefined ? { judge: node.judge } : {}) }
        : {
            model: node.model,
            ...(node.thinking !== undefined ? { thinking: node.thinking } : {}),
            tools: node.tools,
            ...(node.hitlPrompt !== undefined ? { hitlPrompt: node.hitlPrompt } : {}),
          },
    ),
  }));
  const known = new Set(ids);
  const edges: LoopEdge[] = [];
  for (const edge of ir.edges) {
    for (const end of [edge.from, edge.to]) {
      if (!known.has(end)) {
        warnings.push(`edge ${edge.from} → ${edge.to} references unknown node "${end}"`);
      }
    }
    const when = edge.when;
    const label =
      when === undefined
        ? undefined
        : when.exists === true
          ? `${when.key} exists`
          : `${when.key} == ${String(when.equals)}`;
    edges.push({
      from: edge.from,
      to: edge.to,
      ...(label !== undefined ? { label, conditional: true } : {}),
    });
  }
  // Parallel barrier groups have no per-edge representation in the declared
  // edge list; surface them as structural notes so the canvas stays honest.
  if (ir.parallel !== undefined) {
    for (const group of ir.parallel) {
      warnings.push(`parallel group: ${group.join(", ")} run concurrently (barrier)`);
    }
  }
  return { nodes, edges };
}

function crewCanvas(ir: Extract<IrNode, { target: "crew" }>, warnings: string[]): LoopCanvas {
  if (ir.roles.length === 0) warnings.push("crew has no roles — nothing to run");
  const nodes: LoopNode[] = ir.roles.map((role) => ({
    id: role.name,
    label: role.name === ir.entry ? `${role.name} (entry)` : role.name,
    kind: "role" as const,
    mini: miniSegments({
      model: role.model,
      ...(role.thinking !== undefined ? { thinking: role.thinking } : {}),
      // Item 9 (G37) — per-role model pool surfaces in the reason segment.
      ...(role.modelPool !== undefined ? { modelPool: role.modelPool } : {}),
      tools: role.tools,
      subAgents: role.subAgents,
    }),
  }));
  const edges: LoopEdge[] = [];
  if (ir.routing === undefined) {
    warnings.push(`no routing: — the entry role ("${ir.entry}") handles every message`);
  } else if (ir.routing.kind === "llm") {
    warnings.push("routing.kind: llm — an LLM router picks the next role at runtime");
    for (const role of ir.roles) {
      if (role.name !== ir.entry) {
        edges.push({ from: ir.entry, to: role.name, label: "llm router", conditional: true });
      }
    }
  } else if (ir.routing.match !== undefined) {
    for (const [from, rules] of Object.entries(ir.routing.match)) {
      for (const rule of rules) {
        edges.push({
          from,
          to: rule.to,
          label: `contains "${truncate(rule.contains, 24)}"`,
          conditional: true,
        });
      }
    }
  }
  return { nodes, edges };
}

function pipelineCanvas(
  ir: Extract<IrNode, { target: "pipeline" }>,
  warnings: string[],
): LoopCanvas {
  const used = new Set<string>();
  if (ir.indexing.documents.length === 0) {
    warnings.push("pipeline declares no indexing.documents — nothing to index");
  }
  const nodes: LoopNode[] = [];
  const edges: LoopEdge[] = [];
  for (const doc of ir.indexing.documents) {
    const id = claimId(used, `doc:${doc.id}`);
    nodes.push({ id, label: doc.id, kind: "doc", mini: emptyMini() });
    edges.push({ from: id, to: "index" });
  }
  nodes.push({
    id: claimId(used, "index"),
    label: `index (${ir.indexing.chunkStrategy})`,
    kind: "node",
    mini: emptyMini(),
  });
  nodes.push({
    id: claimId(used, "agent"),
    label: "chat agent",
    kind: "node",
    mini: miniSegments({
      model: ir.agent.model,
      ...(ir.agent.modelPool !== undefined ? { modelPool: ir.agent.modelPool } : {}),
    }),
  });
  edges.push({
    from: "index",
    to: "agent",
    label: `retrieve (k=${ir.retrieve.defaultK}, ${ir.retrieve.vectorBackend})`,
  });
  return { nodes, edges };
}

function researchCanvas(ir: Extract<IrNode, { target: "research" }>): LoopCanvas {
  const agentMini = (): LoopSegment[] =>
    miniSegments({
      model: ir.agent.model,
      ...(ir.agent.modelPool !== undefined ? { modelPool: ir.agent.modelPool } : {}),
      tools: ir.tools,
    });
  const nodes: LoopNode[] = [
    { id: "goal", label: `goal: ${truncate(ir.goal, 40)}`, kind: "node", mini: agentMini() },
  ];
  const edges: LoopEdge[] = [];
  for (let i = 1; i <= ir.branchingFactor; i += 1) {
    nodes.push({ id: `branch-${i}`, label: `branch ${i}`, kind: "node", mini: agentMini() });
    edges.push({ from: "goal", to: `branch-${i}` });
    edges.push({ from: `branch-${i}`, to: "report" });
  }
  nodes.push({ id: "report", label: "report", kind: "doc", mini: emptyMini() });
  return { nodes, edges };
}

function batchCanvas(ir: Extract<IrNode, { target: "batch" }>): LoopCanvas {
  const nodes: LoopNode[] = [
    { id: "queue", label: `queue (${ir.queue.adapter})`, kind: "node", mini: emptyMini() },
    {
      id: "agent",
      label: `worker × ${ir.concurrency}`,
      kind: "node",
      mini: miniSegments({
        model: ir.agent.model,
        ...(ir.agent.modelPool !== undefined ? { modelPool: ir.agent.modelPool } : {}),
        tools: ir.tools,
      }),
    },
  ];
  const edges: LoopEdge[] = [
    { from: "queue", to: "agent", label: "jobs" },
    { from: "agent", to: "queue", label: `retries (≤ ${ir.queue.maxRetries})`, conditional: true },
  ];
  return { nodes, edges };
}

// --- per-shape ring views ---------------------------------------------------------

function cliRingView(ir: IrV0): RingView {
  return {
    model: ir.agent.model,
    toolsKey: "tools",
    tools: ir.tools,
    mcpServers: ir.mcp_servers,
    subAgents: ir.subAgents,
    ...(ir.agent.thinking !== undefined ? { thinking: ir.agent.thinking } : {}),
    ...(ir.agent.modelTiers !== undefined ? { modelTiers: ir.agent.modelTiers } : {}),
    ...(ir.agent.modelPool !== undefined ? { modelPool: ir.agent.modelPool } : {}),
    ...(ir.evaluation !== undefined ? { evaluation: ir.evaluation } : {}),
    ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
    ...(ir.security !== undefined ? { security: ir.security } : {}),
    ...(ir.memory !== undefined ? { memory: ir.memory } : {}),
    ...(ir.continuity !== undefined ? { continuity: ir.continuity } : {}),
    continuityDefaultOn: true,
    thredz: ir.thredz !== undefined,
    compaction: ir.compaction,
    ...(ir.budget !== undefined ? { budget: ir.budget } : {}),
    ...(ir.limits !== undefined ? { limits: ir.limits } : {}),
    permissions: ir.permissions,
    ...(ir.hooks !== undefined ? { hooks: ir.hooks } : {}),
    transactionPolicy: ir.transactionPolicy !== undefined,
  };
}

function channelRingView(ir: IrChannelV0): RingView {
  const channelNames = Object.keys(ir.channels).filter(
    (name) => (ir.channels as Record<string, unknown>)[name] !== undefined,
  );
  return {
    model: ir.agent.model,
    toolsKey: "agent.tools",
    tools: ir.tools,
    mcpServers: ir.mcp_servers,
    subAgents: ir.subAgents,
    channels: channelNames,
    heartbeat: ir.heartbeat !== undefined,
    ...(ir.agent.thinking !== undefined ? { thinking: ir.agent.thinking } : {}),
    ...(ir.agent.modelTiers !== undefined ? { modelTiers: ir.agent.modelTiers } : {}),
    ...(ir.agent.modelPool !== undefined ? { modelPool: ir.agent.modelPool } : {}),
    ...(ir.evaluation !== undefined ? { evaluation: ir.evaluation } : {}),
    ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
    ...(ir.memory !== undefined ? { memory: ir.memory } : {}),
    ...(ir.continuity !== undefined ? { continuity: ir.continuity } : {}),
    continuityDefaultOn: true,
    thredz: ir.thredz !== undefined,
    compaction: ir.compaction,
    ...(ir.budget !== undefined ? { budget: ir.budget } : {}),
    ...(ir.limits !== undefined ? { limits: ir.limits } : {}),
    permissions: ir.permissions,
    ...(ir.hooks !== undefined ? { hooks: ir.hooks } : {}),
    transactionPolicy: ir.transactionPolicy !== undefined,
  };
}

function managedRingView(ir: IrManagedV0): RingView {
  return {
    model: ir.agent.model,
    ...(ir.agent.thinking !== undefined ? { thinking: ir.agent.thinking } : {}),
    ...(ir.agent.modelTiers !== undefined ? { modelTiers: ir.agent.modelTiers } : {}),
    ...(ir.agent.modelPool !== undefined ? { modelPool: ir.agent.modelPool } : {}),
    ...(ir.evaluation !== undefined ? { evaluation: ir.evaluation } : {}),
    ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
    ...(ir.memory !== undefined ? { memory: ir.memory } : {}),
    ...(ir.continuity !== undefined ? { continuity: ir.continuity } : {}),
    continuityDefaultOn: true,
    thredz: ir.thredz !== undefined,
    compaction: ir.compaction,
    ...(ir.budget !== undefined ? { budget: ir.budget } : {}),
    ...(ir.limits !== undefined ? { limits: ir.limits } : {}),
    permissions: ir.permissions,
    ...(ir.hooks !== undefined ? { hooks: ir.hooks } : {}),
  };
}

/** Generic fallback view for the shapes without a dedicated projection. */
function fallbackRingView(ir: IrNode): RingView {
  const bag = ir as Partial<{
    agent: { model: string; tools?: readonly string[] };
    tools: readonly string[];
    mcp_servers: IrMcpServers;
    compaction: IrCompaction;
    permissions: IrPermissions;
    continuity: IrContinuity;
    budget: IrBudget;
    limits: IrLimits;
    hooks: readonly IrHook[];
    transactionPolicy: unknown;
  }>;
  const topTools = bag.tools ?? [];
  const agentTools = bag.agent?.tools ?? [];
  const useAgentTools = topTools.length === 0 && agentTools.length > 0;
  return {
    model: bag.agent?.model ?? "",
    toolsKey: useAgentTools ? "agent.tools" : "tools",
    tools: useAgentTools ? agentTools : topTools,
    ...(bag.mcp_servers !== undefined ? { mcpServers: bag.mcp_servers } : {}),
    ...(bag.compaction !== undefined ? { compaction: bag.compaction } : {}),
    ...(bag.permissions !== undefined ? { permissions: bag.permissions } : {}),
    ...(bag.continuity !== undefined ? { continuity: bag.continuity } : {}),
    ...(bag.budget !== undefined ? { budget: bag.budget } : {}),
    ...(bag.limits !== undefined ? { limits: bag.limits } : {}),
    ...(bag.hooks !== undefined ? { hooks: bag.hooks } : {}),
    transactionPolicy: bag.transactionPolicy !== undefined,
  };
}

// --- projectLoop -------------------------------------------------------------------

function ringProjection(target: string, view: RingView, warnings: string[]): LoopProjection {
  const segments = ringSegmentsFromView(view);
  // Guardrails-first: the defaults-only Stop warning applies to the true
  // ring families (their loop really does run to the iteration cap).
  // Fallback targets have their own boundaries (call length, page budget,
  // dataset size), so the 500-iteration claim would be dishonest there.
  if (RING_TARGETS.includes(target)) {
    const stop = segments.find((s) => s.id === "stop");
    if (stop !== undefined && !stop.active) warnings.push(NO_BUDGET_WARNING);
  }
  return { kind: "ring", target, ring: { segments }, warnings };
}

/**
 * Project a lowered IR into its canonical loop view. Total over the IrNode
 * union and never throws: every variant maps to a ring or canvas, and the
 * shapes without a dedicated projection fall back to the generic ring with
 * an honest warning.
 */
export function projectLoop(ir: IrNode): LoopProjection {
  switch (ir.target) {
    case "cli":
      return ringProjection("cli", cliRingView(ir), []);
    case "channel":
      return ringProjection("channel", channelRingView(ir), []);
    case "managed":
      return ringProjection("managed", managedRingView(ir), []);
    case "workflow": {
      const warnings: string[] = [];
      const canvas = workflowCanvas(ir, warnings);
      return { kind: "canvas", target: "workflow", canvas, warnings };
    }
    case "graph": {
      const warnings: string[] = [];
      const canvas = graphCanvas(ir, warnings);
      return { kind: "canvas", target: "graph", canvas, warnings };
    }
    case "crew": {
      const warnings: string[] = [];
      const canvas = crewCanvas(ir, warnings);
      return { kind: "canvas", target: "crew", canvas, warnings };
    }
    case "pipeline": {
      const warnings: string[] = [];
      const canvas = pipelineCanvas(ir, warnings);
      return { kind: "canvas", target: "pipeline", canvas, warnings };
    }
    case "research":
      return { kind: "canvas", target: "research", canvas: researchCanvas(ir), warnings: [] };
    case "batch":
      return { kind: "canvas", target: "batch", canvas: batchCanvas(ir), warnings: [] };
    case "voice":
    case "browser":
    case "eval":
    case "onchain":
    case "onchain-game":
      return ringProjection(ir.target, fallbackRingView(ir), [
        `target "${ir.target}" has no dedicated loop projection yet — showing the generic single-agent ring`,
      ]);
  }
}
