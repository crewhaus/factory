import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrGraphEdgeWhen,
  type IrGraphNode,
  type IrGraphV0,
  renderBundleReadme,
} from "@crewhaus/ir";

/**
 * Emit a single-file `agent.ts` bundle that builds the graph via
 * `@crewhaus/graph-engine` and runs it against `process.stdin`.
 *
 * Each LLM-backed node calls `runChatLoop({ singleTurn: true, ... })`
 * with the node's instructions and a synthetic user message carrying
 * the JSON-stringified upstream state. The node's reply text is added
 * to the state under a key matching the node name (e.g. `state.plan`,
 * `state.execute`, `state.summarise`). Nodes that declare `tools` get
 * them resolved through the built-in tool map (G07 — the same
 * resolveTools/BUILTIN_TOOL_MAP approach as target-crew's roles) and
 * passed straight into the node's runChatLoop call.
 *
 * Loop contract 0.4 (Batch A):
 *   - `edges[].when` lowers onto graph-engine `EdgeCondition` lambdas
 *     reading the shared state (`equals` / `exists` forms);
 *   - `parallel` groups lower onto `addParallel` calls (the engine's G69
 *     collision check guards the default merge at runtime);
 *   - node-level `thinking`/`maxTokens` plus the graph-level `budget`,
 *     `limits` (flat runChatLoop knobs) and `hooks` thread into every
 *     node's runChatLoop call, mirroring target-managed's field renderers.
 *
 * Loop contract 0.4 (Batch B, G02) — `kind: "judge"` nodes are emitted as
 * JUDGE GATES over their upstream node's output, expressed entirely
 * through the engine's existing edge/checkpoint machinery:
 *
 *   - The judge node's body scores the gated upstream output(s) present in
 *     the shared state (in [0,1], via `@crewhaus/eval-judge`'s forced-tool
 *     scorer on the judge node's resolved `model`), publishes a
 *     `judge_verdict` trace event on `ctx.runContext.eventBus`, and
 *     records `state["<judge>"] = "pass" | "fail"` plus a structured
 *     `state["<judge>_judge"] = { verdict, score, rationale, retries }`
 *     record (the hitl `_decision`-suffix convention) — so author-declared
 *     `when: {key: <judge>, equals: pass}` predicates work too.
 *   - The judge's declared outgoing edges are PASS-GATED (condition
 *     `state["<judge>"] === "pass"`, AND-composed with any author `when`)
 *     for `halt`/`retry_previous`, matching the loop projection's
 *     conditional "pass" edge; `continue` leaves them as declared.
 *   - `on_fail: retry_previous` synthesizes a conditional BACK-EDGE from
 *     the judge to its single gated upstream node (`=== "fail"`); the
 *     retry counter lives in the checkpointed state, the gated node reads
 *     the failing judge's rationale out of the state as an instructions
 *     nudge, and exhausted retries throw the classified failure inside
 *     the body (so an edge-visible "fail" always means retries remain).
 *     A retry_previous judge therefore requires exactly ONE non-judge
 *     upstream (transitively through other judges) — enforced at emit
 *     time. `halt` throws immediately; both publish `run_failed` first
 *     (the engine's G69 convention) and the existing catch wrapper exits
 *     with the report's code.
 *
 * v0 honesty note: judge model calls ride outside the graph-level
 * `budget`/`limits` runChatLoop knobs (eval-judge drives the provider
 * adapter directly).
 *
 * HITL: nodes whose IR carries `hitlPrompt` await `ctx.requestApproval`
 * BEFORE the LLM turn — the gate is a pre-condition, matching
 * graph-engine's pause/resume contract (the pause checkpoints the PRE-node
 * state and `resume()` replays the paused node from the top). So a pause
 * has spent nothing, the `hitl_pause` event carries the state the approver
 * is deciding on, and the resumed turn is the node's first, not its
 * second. A rejecting decision (see HITL_HELPER) cancels the turn.
 * The graph-engine's pause/resume flow handles the checkpoint
 * persistence; the bundle emits CLI argument parsing for
 *
 *   bun agent.ts --resume <graphRunId> <decision>
 *   bun agent.ts --branch-from <graphRunId> <checkpointId>
 *
 * so operators can drive time-travel / resume from the shell without
 * any additional tooling.
 *
 * Layer F2. Pairs with `target-cli` (mirrors the codegen contract) and
 * `graph-engine` (R11 — runtime).
 */
/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — `emitGraph` options.
 * `evalEntry: true` (set only by `crewhaus compile --with-eval-harness`)
 * additionally emits an exported `runForEval(input, opts)` entry that drives
 * the compiled graph to `run_done` from the given input on the caller's
 * RunContext (node traces + judge verdicts land on the caller's bus; a HITL
 * pause fails loudly — approvals cannot resolve headless), returning the
 * final state JSON — and guards the CLI main with `import.meta.main` so the
 * eval bundle can import the compiled runtime without running it. Absent
 * (every existing caller), the emission is byte-identical to before.
 */
export type EmitGraphOptions = EmitReadmeOptions & { readonly evalEntry?: boolean };

export function emitGraph(ir: IrGraphV0, opts: EmitGraphOptions = {}): Bundle {
  const files = [
    {
      path: "agent.ts",
      content: renderAgent(ir, opts.evalEntry === true),
    },
  ];
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * G07 — built-in tool name → package + export, ported from target-crew's
 * map (which itself mirrors target-channel-bot's minus the channel-only
 * `sendMessage`): graph nodes, like crew roles, pass resolved tool values
 * straight into their own runChatLoop call rather than registering them on
 * `defaultCatalog`. `initSymbol` names the package's config-registration
 * export, called once before the graph is built when the node's
 * `toolConfigs` carries a value for the tool.
 */
type BuiltinToolEntry = {
  readonly package: string;
  readonly export: string;
  readonly initSymbol?: string;
};

const BUILTIN_TOOL_MAP: Record<string, BuiltinToolEntry> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite" },
  webFetch: {
    package: "@crewhaus/tool-web",
    export: "webFetch",
    initSymbol: "registerWebFetchConfig",
  },
  webSearch: { package: "@crewhaus/tool-web", export: "webSearch" },
  readImage: { package: "@crewhaus/tool-image", export: "readImage" },
  fetch: {
    package: "@crewhaus/tool-fetch",
    export: "fetch",
    initSymbol: "registerFetchConfig",
  },
  // §47 read-only EVM tools (slice 0).
  evmCall: { package: "@crewhaus/tool-evm", export: "evmCall" },
  evmGetLogs: { package: "@crewhaus/tool-evm", export: "evmGetLogs" },
  evmGetTransaction: { package: "@crewhaus/tool-evm", export: "evmGetTransaction" },
  evmGetTransactionReceipt: {
    package: "@crewhaus/tool-evm",
    export: "evmGetTransactionReceipt",
  },
  evmGetBalance: { package: "@crewhaus/tool-evm", export: "evmGetBalance" },
  evmBlockNumber: { package: "@crewhaus/tool-evm", export: "evmBlockNumber" },
  // §47 destructive EVM tools (slice 1) — gated by permission-engine
  // (destructive: true) and wallet-engine (two-gate model).
  evmSendTransaction: { package: "@crewhaus/tool-evm-tx", export: "evmSendTransaction" },
  evmSimulate: { package: "@crewhaus/tool-evm-tx", export: "evmSimulate" },
  // Pillar 2 — AST-aware code intelligence (recipe 54).
  codegraphSearch: { package: "@crewhaus/tool-codegraph", export: "codegraphSearch" },
  codegraphCallers: { package: "@crewhaus/tool-codegraph", export: "codegraphCallers" },
  codegraphCallees: { package: "@crewhaus/tool-codegraph", export: "codegraphCallees" },
  codegraphImpact: { package: "@crewhaus/tool-codegraph", export: "codegraphImpact" },
};

/**
 * G07 — resolve every node's `tools` across the whole graph into ONE
 * grouped import block + init list (agent.ts is a single file, unlike
 * crew's per-role files) plus a per-node `[a, b]` array literal for the
 * node's runChatLoop `tools` field. Shared `initSymbol`s are emitted once
 * (first configured node wins — target-cli's shared-symbol rule).
 */
function resolveTools(ir: IrGraphV0): {
  imports: string[];
  inits: string[];
  /** node name → rendered `[read, grep]` literal; absent when the node declares no tools. */
  toolsArrayByNode: Map<string, string>;
} {
  const byPackage = new Map<string, Set<string>>();
  const inits: string[] = [];
  const initEmitted = new Set<string>();
  const toolsArrayByNode = new Map<string, string>();
  for (const node of ir.nodes) {
    if (node.tools.length === 0) continue;
    const registrations: string[] = [];
    for (const name of node.tools) {
      const entry = BUILTIN_TOOL_MAP[name];
      if (!entry) {
        const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
        throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
      }
      const set = byPackage.get(entry.package) ?? new Set<string>();
      set.add(entry.export);
      byPackage.set(entry.package, set);
      if (entry.initSymbol !== undefined) {
        const cfg = node.toolConfigs[name];
        if (cfg !== undefined) {
          set.add(entry.initSymbol);
          if (!initEmitted.has(entry.initSymbol)) {
            inits.push(`${entry.initSymbol}(${JSON.stringify(cfg)});`);
            initEmitted.add(entry.initSymbol);
          }
        }
      }
      registrations.push(entry.export);
    }
    toolsArrayByNode.set(node.name, `[${registrations.join(", ")}]`);
  }
  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const symbols = [...(byPackage.get(pkg) ?? new Set<string>())].sort();
    imports.push(`import { ${symbols.join(", ")} } from "${pkg}";`);
  }
  return { imports, inits, toolsArrayByNode };
}

/**
 * Loop contract 0.4 (Batch B, G02) — is this node a judge gate? The IR
 * contract sets `judge` iff `kind === "judge"`; both are checked so a
 * malformed direct-IR node falls through to the regular renderer instead
 * of emitting a half-gate (mirror: target-workflow's isJudgeStep).
 */
function isJudgeNode(node: IrGraphNode): boolean {
  return node.kind === "judge" && node.judge !== undefined;
}

/**
 * Loop contract 0.4 (Batch F, temporal contract / G61) — the set of nodes
 * that lie on ANY cycle, over the declared edges PLUS the synthesized
 * judge-retry back-edges (judge → its gated node). A cyclic node re-executes
 * by design — a judge-retry refinement loop or an author `when` loop — so it
 * must NOT be wrapped in durable idempotency (which would dedup the second
 * visit against the first and silently break the loop). Only acyclic nodes,
 * which run at most once per run, are safe to wrap: their attempt index is
 * always 0, so a crash-replay dedups while normal execution is untouched.
 */
function nodesOnCycle(ir: IrGraphV0): ReadonlySet<string> {
  const adj = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = adj.get(from) ?? [];
    list.push(to);
    adj.set(from, list);
  };
  for (const e of ir.edges) link(e.from, e.to);
  for (const j of ir.nodes) {
    if (isJudgeNode(j) && j.judge?.onFail === "retry_previous") {
      const target = gatedUpstreams(ir, j.name)[0];
      if (target !== undefined) link(j.name, target);
    }
  }
  const onCycle = new Set<string>();
  for (const node of ir.nodes) {
    const start = node.name;
    const seen = new Set<string>();
    const stack = [...(adj.get(start) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === start) {
        onCycle.add(start);
        break;
      }
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of adj.get(cur) ?? []) stack.push(next);
    }
  }
  return onCycle;
}

/**
 * Loop contract 0.4 (Batch B, G02) — the non-judge upstream node names a
 * judge gates: walk the declared edges backwards from the judge,
 * COLLECTING non-judge ancestors and RECURSING through judge ancestors
 * (judges pass no output of their own — a judge chained behind another
 * judge still gates the original producing node). Deduped, edge
 * declaration order, cycle-safe.
 */
function gatedUpstreams(ir: IrGraphV0, judgeName: string): string[] {
  const byName = new Map(ir.nodes.map((n) => [n.name, n]));
  const out: string[] = [];
  const seen = new Set<string>([judgeName]);
  const queue: string[] = [judgeName];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const e of ir.edges) {
      if (e.to !== cur || seen.has(e.from)) continue;
      seen.add(e.from);
      const from = byName.get(e.from);
      if (from === undefined) continue; // unknown-node edges throw in validateGraph
      if (isJudgeNode(from)) queue.push(e.from);
      else out.push(e.from);
    }
  }
  return out;
}

function validateGraph(ir: IrGraphV0): void {
  const names = new Set(ir.nodes.map((n) => n.name));
  if (!names.has(ir.entry)) {
    throw new TargetEmitError(
      `entry node "${ir.entry}" is not declared in nodes (${[...names].join(", ")})`,
    );
  }
  for (const e of ir.edges) {
    if (!names.has(e.from)) {
      throw new TargetEmitError(`edge references unknown node "${e.from}" (from)`);
    }
    if (!names.has(e.to)) {
      throw new TargetEmitError(`edge references unknown node "${e.to}" (to)`);
    }
    // Loop contract 0.4 (Batch A) — `when.key` reads a node's recorded
    // output from the shared state, so it must name a declared node.
    // parseSpec + the ir-passes wellformedness check already enforce this;
    // re-checked here for direct emitGraph callers.
    if (e.when !== undefined && !names.has(e.when.key)) {
      throw new TargetEmitError(
        `edge ${e.from} -> ${e.to} when.key references unknown node "${e.when.key}"`,
      );
    }
  }
  for (const group of ir.parallel ?? []) {
    if (group.length < 2) {
      throw new TargetEmitError(
        `parallel group [${group.join(", ")}] needs at least 2 nodes (addParallel rejects smaller groups)`,
      );
    }
    for (const member of group) {
      if (!names.has(member)) {
        throw new TargetEmitError(`parallel group references unknown node "${member}"`);
      }
    }
  }
  // Loop contract 0.4 (Batch B, G02) — judge gate wellformedness. parseSpec
  // already rejects a judge entry; the upstream checks are emit-level
  // because they depend on the gate semantics this emitter implements.
  for (const node of ir.nodes) {
    if (!isJudgeNode(node)) continue;
    if (node.name === ir.entry) {
      throw new TargetEmitError(
        `entry node "${node.name}" cannot be a judge — nothing upstream to gate`,
      );
    }
    const upstreams = gatedUpstreams(ir, node.name);
    if (upstreams.length === 0) {
      throw new TargetEmitError(
        `judge node "${node.name}" has no non-judge upstream node to gate — add an edge from a producing node into it`,
      );
    }
    if (node.judge?.onFail === "retry_previous" && upstreams.length !== 1) {
      throw new TargetEmitError(
        `judge node "${node.name}" uses on_fail: retry_previous but gates ${upstreams.length} upstream nodes (${upstreams.join(", ")}) — the retry target must be unambiguous; keep a single upstream or use on_fail: halt/continue`,
      );
    }
  }
}

/**
 * Loop contract 0.4 (Batch A) — lower a declarative `edges[].when` block
 * onto a graph-engine `EdgeCondition` lambda over the shared state, exactly
 * as the IR docblock specifies:
 *
 *   equals → `(state) => state[key] === <literal>`
 *   exists → `(state) => state[key] !== undefined`
 *
 * `key` names an upstream node whose reply the generated node body recorded
 * under `state["<node>"]`; it threads through escapeJsonString (it is a
 * user-controlled spec value landing in generated source). `equals`
 * literals are JSON-encoded — string, number and boolean all serialize to
 * valid JS literals (`equals: false` is legal and distinct from `exists`).
 */
function renderWhenExpr(when: IrGraphEdgeWhen): string {
  const keyJs = escapeJsonString(when.key);
  if (when.equals !== undefined) {
    return `(__state as Record<string, unknown>)[${keyJs}] === ${JSON.stringify(when.equals)}`;
  }
  if (when.exists === true) {
    return `(__state as Record<string, unknown>)[${keyJs}] !== undefined`;
  }
  // Unreachable through parseSpec (its superRefine demands exactly one
  // form) — guard for direct-IR builders handing in an empty block.
  throw new TargetEmitError(
    `edge when on key "${when.key}" must carry exactly one of equals/exists`,
  );
}

function renderEdgeCondition(when: IrGraphEdgeWhen): string {
  return `(__state) => ${renderWhenExpr(when)}`;
}

/**
 * Loop contract 0.4 (Batch B, G02) — the `state["<judge>"] === "pass"`
 * test gating a judge's declared outgoing edges (halt / retry_previous
 * modes — the projection's conditional "pass" edge). AND-composed with
 * the author's `when` when both are present.
 */
function renderJudgePassCondition(judgeName: string, when: IrGraphEdgeWhen | undefined): string {
  const passExpr = `(__state as Record<string, unknown>)[${escapeJsonString(judgeName)}] === "pass"`;
  return when === undefined
    ? `(__state) => ${passExpr}`
    : `(__state) => ${passExpr} && ${renderWhenExpr(when)}`;
}

/**
 * The `hitl:` decision vocabulary that CANCELS a gated node's turn, compared
 * trimmed + lower-cased. Any other decision — including free text — approves;
 * the raw string is recorded at `state["<node>_decision"]` either way, so
 * every downstream node reads it as part of the upstream state. (`when:`
 * edges cannot name that key yet — `when.key` must name a declared node —
 * but a rejection IS routable as `when: { key: <node>, exists: true }`,
 * since a cancelled node records no output.)
 *
 * Unknown text approves rather than rejects: an operator's note ("approve,
 * but keep it short") must reach the state instead of silently skipping the
 * node's work. The single source of truth for {@link isHitlRejection} and
 * for the `__hitlRejected` helper emitted into the bundle.
 */
export const HITL_REJECTION_DECISIONS: readonly string[] = [
  "no",
  "n",
  "reject",
  "rejected",
  "deny",
  "denied",
  "decline",
  "declined",
  "abort",
  "cancel",
  "cancelled",
  "canceled",
  "stop",
  "veto",
];

/** Does `decision` cancel a gated node's turn? Mirrors the emitted helper. */
export function isHitlRejection(decision: string): boolean {
  return HITL_REJECTION_DECISIONS.includes(decision.trim().toLowerCase());
}

/**
 * Module-scope HITL machinery, emitted once when the graph carries a node
 * with `hitl:` (so gate-free bundles stay byte-identical).
 *
 * The gate is a PRE-condition: the emitted node body awaits
 * `ctx.requestApproval` BEFORE its model turn, which is the ordering
 * graph-engine's pause/resume contract requires — the pause checkpoint
 * holds the PRE-node state and `resume()` replays the paused node from the
 * top. Asking after the turn (the pre-0.4.x emission) discarded the reply
 * the approver never saw and re-ran — and re-paid for — the same model call
 * on resume.
 *
 * `__hitlRejected` gives the freeform `--resume <run> <decision>` string its
 * one piece of semantics — see {@link HITL_REJECTION_DECISIONS}.
 */
const HITL_HELPER = `
/**
 * Decisions that CANCEL a \`hitl:\` node's turn (compared trimmed +
 * lower-cased). Any other decision — including free text — approves. The
 * raw string is always recorded at \`state["<node>_decision"]\`; a CANCELLED
 * node records nothing else, so \`when: { key: "<node>", exists: true }\`
 * routes the run differently on a rejection.
 */
const __HITL_REJECTIONS: ReadonlySet<string> = new Set(${JSON.stringify(HITL_REJECTION_DECISIONS)});
function __hitlRejected(decision: string): boolean {
  return __HITL_REJECTIONS.has(decision.trim().toLowerCase());
}
`;

/**
 * Loop contract 0.4 (Batch B, G02) — module-scope judge machinery, emitted
 * once when the graph carries judge nodes: the `__judgeGate` scorer
 * (eval-judge's forced-tool `judge()` over a synthesized single-criterion
 * rubric with generic 1–5 anchors, mapped to [0,1] via `(n − 1) / 4` — the
 * createJudgeGrader convention) and, when a gate can throw, the classified
 * exit code with the literal 35 fallback (the next slot in the 3x
 * own-ceiling band after crewhaus_budget 33 / timeout 34) so bundles
 * emitted before @crewhaus/errors ships `EXIT_CODES.evaluation` still exit
 * classified. Mirror: target-workflow emits the same helper.
 */
const JUDGE_GATE_HELPER = `
/**
 * Loop contract 0.4 (G02) — score \`output\` in [0,1] against free-text
 * judge criteria: eval-judge's forced-tool scorer over a single-criterion
 * rubric (generic 1–5 anchors), mapped down via (n - 1) / 4. The judge
 * model resolves through the model-router, so any provider can judge; its
 * calls publish on the run bus with role "judge", so any cost-tracker on that
 * bus prices them and the verdict carries the judge's wire model + priced
 * spend for the judge_verdict event. The graph shape has no run-spanning
 * budget meter yet (each node's runChatLoop meter is torn down before a judge
 * node runs), so budget.usd does not count a gate's spend here — the 0.6.0
 * plan scopes the shared meter to the workflow target; mirroring it is
 * follow-up work.
 */
async function __judgeGate(opts: {
  criteria: string;
  model: string;
  gatedTask: string;
  output: string;
  bus: TraceEventBus;
}): Promise<{ score: number; rationale: string; judgeModel: string; costUsdMicros?: number }> {
  const result = await judge({
    rubric: {
      criteria: [
        {
          name: "criteria",
          description: opts.criteria,
          anchors: {
            "1": "clearly fails the criteria",
            "2": "mostly fails the criteria",
            "3": "partially meets the criteria",
            "4": "mostly meets the criteria",
            "5": "fully meets the criteria",
          },
        },
      ],
      passing_score: 3,
    },
    sample: { id: "judge-gate", input: opts.gatedTask },
    agentOutput: opts.output,
    model: opts.model,
    // Judge spend rides the run bus (role "judge") so a tracker on that bus
    // prices it; see the helper docblock for what the graph cap does not
    // yet count.
    bus: opts.bus,
  });
  return {
    score: (result.score - 1) / 4,
    rationale: result.rationale,
    judgeModel: result.usage.model,
    ...(result.usage.costUsdMicros !== undefined ? { costUsdMicros: result.usage.costUsdMicros } : {}),
  };
}
`;

/**
 * G02 — companion const to {@link JUDGE_GATE_HELPER}, emitted only when a
 * gate can THROW (`on_fail: halt` / exhausted `retry_previous`) so
 * continue-only bundles carry no dead throw machinery.
 */
const EVAL_EXIT_CONST = `
// Classified exit for a failed judge gate (falls back to 35 until
// @crewhaus/errors ships EXIT_CODES.evaluation).
const __EVAL_EXIT: number = (EXIT_CODES as Record<string, number>)["evaluation"] ?? 35;
`;

/**
 * Render a single node's body. The body calls runChatLoop singleTurn
 * with the node's instructions and the upstream state serialised as a
 * user message. Returns the assistant reply text under
 * `state["<nodeName>"]`. When `hitlPrompt` is set, the node calls
 * `ctx.requestApproval` BEFORE the LLM turn (see {@link HITL_HELPER}) so
 * the engine pauses with nothing spent and nothing to discard.
 *
 * Loop contract 0.4 (Batch B, G02) — when this node is the retry target
 * of one or more `retry_previous` judges (`nudgeJudges`), the body reads
 * each currently-failing judge's rationale out of the state and appends
 * it to the instructions as a nudge, so a retried run self-corrects
 * against the gate's feedback.
 */
/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field.
 * The taxonomy is graph-level, so every node's runChatLoop call gets the
 * same classes (mirror: target-cli + target-channel-bot render the same
 * field). Empty when the spec omits the block.
 */
function renderFailureTaxonomyField(ir: IrGraphV0): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n        failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Loop contract 0.4 (Batch A) — render one node's loop knobs (`maxTokens`,
 * `thinking`) as runChatLoop fields, indented for the generated node body.
 * Node-LEVEL config (spec `nodes.<n>.max_tokens` / `nodes.<n>.thinking`),
 * unlike the graph-level fields below — two nodes can think on different
 * budgets. Empty when the node declares neither so existing bundles stay
 * byte-identical. `thinking` is the IrThinking union verbatim
 * ({ budgetTokens } → `ProviderRequest.thinking`; { effort } →
 * `ProviderRequest.reasoningEffort` via the adapter's
 * EFFORT_THINKING_BUDGET_TOKENS table). Mirror: target-managed's
 * renderAgentLoopFields (agent-block scope there, node scope here).
 */
function renderNodeLoopFields(node: IrGraphNode): string {
  const pieces: string[] = [];
  if (node.maxTokens !== undefined) {
    pieces.push(`\n        maxTokens: ${node.maxTokens},`);
  }
  if (node.thinking !== undefined) {
    pieces.push(`\n        thinking: ${JSON.stringify(node.thinking)},`);
  }
  return pieces.join("");
}

/**
 * Item 27 (Batch A extends it to this shape) — render the `budget`
 * runChatLoop field, indented for the generated node body. Graph-level:
 * every node's call carries the same cap (same scope as failureTaxonomy).
 * Empty when the spec omits it. Mirror: target-cli + target-channel-bot +
 * target-managed render the same field.
 */
function renderBudgetField(ir: IrGraphV0): string {
  if (ir.budget === undefined) return "";
  return `\n        budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Loop contract 0.4 (Batch A) — render the top-level `limits:` ceilings as
 * FLAT runChatLoop fields (matching runtime-core's existing flat
 * `maxToolIterations`/`maxConcurrentTools`/`contextLimit` options),
 * indented for the generated node body. Each knob is emitted only when the
 * spec declared it — the runtime owns per-knob defaults, so an absent knob
 * must stay absent rather than pin today's default into the bundle.
 * `limits.crew` never appears on this shape (spec rejects it outside crew).
 * Mirror: target-cli + target-channel-bot + target-managed render the same
 * fields — keep the four in sync.
 */
function renderLimitsFields(ir: IrGraphV0): string {
  const limits = ir.limits;
  if (limits === undefined) return "";
  const pieces: string[] = [];
  if (limits.maxToolIterations !== undefined) {
    pieces.push(`\n        maxToolIterations: ${limits.maxToolIterations},`);
  }
  if (limits.maxConcurrentTools !== undefined) {
    pieces.push(`\n        maxConcurrentTools: ${limits.maxConcurrentTools},`);
  }
  if (limits.contextLimit !== undefined) {
    pieces.push(`\n        contextLimit: ${limits.contextLimit},`);
  }
  if (limits.deadlineMs !== undefined) {
    pieces.push(`\n        deadlineMs: ${limits.deadlineMs},`);
  }
  if (limits.turnTimeoutMs !== undefined) {
    pieces.push(`\n        turnTimeoutMs: ${limits.turnTimeoutMs},`);
  }
  if (limits.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n        modelCallTimeoutMs: ${limits.modelCallTimeoutMs},`);
  }
  if (limits.loopDetection !== undefined) {
    pieces.push(`\n        loopDetection: ${JSON.stringify(limits.loopDetection)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the spec-declared `hooks:` entries
 * as the `hooks` runChatLoop field, indented for the generated node body.
 * IrHook is shape-identical to hooks-engine's HookDef, so the JSON literal
 * is a valid `HookDef[]` in the generated bundle (declaration order
 * preserved — hook firing order is semantics). The graph shape discovers
 * no settings.json hooks (unlike cli), so the spec list is the whole
 * array. Empty/absent → no field. Mirror: target-managed's renderHooksField.
 */
function renderHooksField(ir: IrGraphV0): string {
  if (ir.hooks === undefined || ir.hooks.length === 0) return "";
  return `\n        hooks: ${JSON.stringify(ir.hooks)},`;
}

/**
 * Render the spec's `permissions:` block as the `permissionMode` /
 * `permissionRules` runChatLoop fields, indented for the generated node body.
 * Graph-level, like the taxonomy: every node's turn is gated by the same
 * policy. Until now the graph target rendered NEITHER, so a spec's whole
 * `permissions:` block was silently discarded and every node ran on the
 * runtime's defaults — a `deny` rule the author wrote was simply not there.
 * The rule literals carry `source: "yaml"` and sit above `BUILTIN_DEFAULT_RULES`
 * in the precedence layers exactly as the sibling emitters render them
 * (target-workflow / target-batch-worker — keep the three in sync). Empty when
 * the spec declares neither half, so bundles without a block stay
 * byte-identical.
 */
function renderPermissionsFields(ir: IrGraphV0): string {
  const { mode, rules } = ir.permissions;
  if (mode === undefined && rules.length === 0) return "";
  const lines: string[] = [];
  if (mode !== undefined) {
    lines.push(`        permissionMode: ${escapeJsonString(mode)},`);
  }
  if (rules.length > 0) {
    const ruleLits = rules
      .map(
        (r) =>
          `            { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
      )
      .join("\n");
    lines.push(
      [
        "        permissionRules: {",
        "          flag: [],",
        "          settings: [],",
        "          yaml: [",
        ruleLits,
        "          ],",
        "          hooks: [],",
        "          builtin: BUILTIN_DEFAULT_RULES,",
        "        },",
      ].join("\n"),
    );
  }
  return `\n${lines.join("\n")}`;
}

/**
 * Loop contract 0.4 (Batch C, G11) — the `askMode` + `approvals` fields.
 * Unlike the CLI's approvalRunOptions, a bundle parses no `--ask-mode`, so the
 * spec value is FIXED here at emit time. runtime-core parks a headless `ask`
 * only when BOTH halves are present (`approvals !== undefined && askMode ===
 * "pause"`), so emitting one without the other leaves ask_mode inert.
 *
 * UNCONDITIONAL, and deliberately NOT folded into renderPermissionsFields:
 * that renderer early-returns on a spec with no `permissions:` block, which is
 * exactly the case where parking matters most — with no block every unmatched
 * tool resolves to `ask`. The store is built under `"deny"` too, where it never
 * parks: it costs nothing (no I/O until something is persisted) and keeps
 * runtime-core's diagnostic honest, since that branches on `approvals ===
 * undefined` and would otherwise blame absent plumbing for a deliberate
 * operator choice.
 */
function renderApprovalFields(ir: IrGraphV0, indent: string): string {
  return (
    `\n${indent}askMode: ${escapeJsonString(ir.permissions.askMode ?? "pause")},` +
    `\n${indent}approvals: { store: __approvals, surface: "graph-node" },`
  );
}

function renderNodeBody(
  node: IrGraphNode,
  graphLevelFields: string,
  toolsArrayLiteral: string | undefined,
  nudgeJudges: readonly string[] = [],
  evalEntry = false,
): string {
  const instructionsJs = escapeJsonString(node.instructions);
  const modelJs = escapeJsonString(node.model);
  const nameJs = escapeJsonString(node.name);
  // G07 — the node's resolved built-in tools, passed straight into the
  // node's own runChatLoop call (crew's RoleDefinition posture, not
  // target-cli's shared defaultCatalog — two nodes can hold different
  // tool sets).
  const toolsField =
    toolsArrayLiteral !== undefined ? `\n        tools: ${toolsArrayLiteral},` : "";
  // HITL is a PRE-condition (see HITL_HELPER): the gate runs before the
  // model turn, so a pause spends nothing, the engine's pre-node pause
  // checkpoint is exactly the state the approver saw on `hitl_pause`, and
  // the replay on resume is this node's FIRST turn rather than its second.
  // A rejecting decision cancels the turn outright — the node records only
  // its `_decision` and the declared edges route from there.
  const hitlPreBlock =
    node.hitlPrompt !== undefined
      ? `
      const __decision = await ctx.requestApproval(${escapeJsonString(node.hitlPrompt)});
      if (__hitlRejected(__decision)) {
        const __rejected: Record<string, unknown> = { ...(prev as Record<string, unknown>) };
        __rejected[${nameJs} + "_decision"] = __decision;
        return __rejected;
      }`
      : "";
  const hitlRecordBlock =
    node.hitlPrompt !== undefined ? `\n      __next[${nameJs} + "_decision"] = __decision;` : "";
  // G02 — judge-retry nudge: read every currently-failing gating judge's
  // rationale out of the state and append it to the instructions.
  const nudgeBlock =
    nudgeJudges.length > 0
      ? `
      // G02 — a retry_previous judge sent the run back here when its state
      // record reads "fail"; its rationale rides in as a nudge.
      const __judgeState = prev as Record<string, unknown>;
      const __nudges: string[] = [];
      for (const __j of [${nudgeJudges.map((n) => escapeJsonString(n)).join(", ")}]) {
        if (__judgeState[__j] !== "fail") continue;
        const __rec = __judgeState[__j + "_judge"] as { rationale?: string } | undefined;
        if (typeof __rec?.rationale === "string" && __rec.rationale.length > 0) {
          __nudges.push('[judge feedback — the previous attempt failed the "' + __j + '" gate]:\\n' + __rec.rationale);
        }
      }
      const __nudge = __nudges.length === 0 ? "" : "\\n\\n" + __nudges.join("\\n\\n");`
      : "";
  const instructionsExpr = nudgeJudges.length > 0 ? `${instructionsJs} + __nudge` : instructionsJs;
  // Cluster S — the eval-entry variant reads THIS invocation's eval seams off
  // the per-run lookup keyed by the RunContext the caller passed (never a
  // module-scope mutable, which two concurrent samples would clobber):
  // `sessionRootDir` re-roots the node's session log into the runner's
  // per-sample artifact dir, `_adapter` is the scripted-provider test seam.
  // Empty otherwise, keeping plain bundles byte-identical.
  const evalSeamBlock = evalEntry
    ? "\n      const __evalSeam = __evalSeams.get(ctx.runContext);"
    : "";
  const evalAdapterLine = evalEntry
    ? "\n        ...(__evalSeam?.sessionRootDir !== undefined ? { sessionRootDir: __evalSeam.sessionRootDir } : {})," +
      "\n        ...(__evalSeam?._adapter !== undefined ? { _adapter: __evalSeam._adapter } : {}),"
    : "";
  return `
    async (ctx, prev) => {${evalSeamBlock}${hitlPreBlock}${nudgeBlock}
      const __seed = [
        { role: "user", content: \`Upstream state:\\n\\\`\\\`\\\`json\\n\${JSON.stringify(prev, null, 2)}\\n\\\`\\\`\\\`\` },
      ];
      const __reply = await runChatLoop({
        model: ${modelJs},
        instructions: ${instructionsExpr},
        sessionName: ${escapeJsonString(node.name)} + "-" + ctx.graphRunId,
        sessionTarget: "graph-node",
        seedMessages: __seed,
        singleTurn: true,${renderNodeLoopFields(node)}${toolsField}${graphLevelFields}
        runContext: ctx.runContext,${evalAdapterLine}
      });
      const __next = { ...prev, [${nameJs}]: __reply };${hitlRecordBlock}
      return __next;
    }`;
}

/**
 * Loop contract 0.4 (Batch B, G02) — render a judge node's body. The gate
 * scores the gated upstream output(s) recorded in the shared state (one
 * upstream: its output verbatim; several, e.g. behind a parallel barrier:
 * a `## <node>`-labelled concatenation — halt/continue only, since
 * retry_previous demands a single target), publishes ONE `judge_verdict`
 * trace event per scoring pass on `ctx.runContext.eventBus`, prints a
 * `[judge <name>]` stderr line (the bundle's `[graph]` diagnostic
 * stream), then applies the resolved `onFail`:
 *
 *   - `retry_previous`: record `"fail"` + retries+1 so the synthesized
 *     back-edge re-runs the gated node (nudged with the rationale);
 *     retries exhausted with the gate still failing publishes
 *     `run_failed` and throws the classified RunFailedError (fail-closed
 *     — an edge-visible "fail" always has retries remaining).
 *   - `halt`: publish `run_failed` + throw immediately.
 *   - `continue`: record the verdict and proceed (edges stay as
 *     declared).
 *
 * Every emit-time string that reaches executable code threads through
 * escapeJsonString — node names and criteria are user-controlled.
 */
function renderJudgeNodeBody(node: IrGraphNode, ir: IrGraphV0): string {
  const gate = node.judge;
  if (gate === undefined) {
    throw new TargetEmitError(
      `judge node "${node.name}" carries no judge config — kind: "judge" requires a judge block`,
    );
  }
  const nameJs = escapeJsonString(node.name);
  const upstreams = gatedUpstreams(ir, node.name);
  const byName = new Map(ir.nodes.map((n) => [n.name, n]));
  const taskEntries = upstreams
    .map((u) => `${escapeJsonString(u)}: ${escapeJsonString(byName.get(u)?.instructions ?? "")}`)
    .join(", ");
  const noOutputError = escapeJsonString(
    `judge node "${node.name}" found no upstream output to gate (expected output from: ${upstreams.join(", ")})`,
  );
  const verdictLine = `      process.stderr.write(${escapeJsonString(`[judge ${node.name}] `)} + "verdict=" + (__pass ? "pass" : "fail") + " score=" + __result.score.toFixed(2) + ${escapeJsonString(` threshold=${gate.threshold}\n`)});`;
  const throwBlock = (title: string, detailOpen: string, i: string): string =>
    [
      `${i}const __report = {`,
      `${i}  class: "evaluation" as const,`,
      `${i}  title: ${escapeJsonString(title)},`,
      `${i}  detail: ${escapeJsonString(detailOpen)} + __result.score.toFixed(2) + ${escapeJsonString(` < threshold ${gate.threshold} (gating: ${upstreams.join(", ")})`)} + (__result.rationale.length > 0 ? " — " + __result.rationale : ""),`,
      `${i}  remediation: ${escapeJsonString(`raise the gated node's quality (instructions/model), lower the judge threshold, or set on_fail: continue`)},`,
      `${i}  exitCode: __EVAL_EXIT,`,
      `${i}};`,
      `${i}__bus.publish({ ...__bus.envelope(), kind: "run_failed", class: __report.class, message: __report.title + ": " + __report.detail, remediation: __report.remediation, exitCode: __report.exitCode });`,
      `${i}throw new RunFailedError(__report);`,
    ].join("\n");
  const scoringPass = `      const __state = prev as Record<string, unknown>;
      // Gated upstream task(s) — emit-time constants keyed by node name.
      const __tasks: Record<string, string> = { ${taskEntries} };
      const __present = Object.keys(__tasks).filter((n) => typeof __state[n] === "string");
      if (__present.length === 0) {
        throw new Error(${noOutputError});
      }
      const __first = __present[0] as string;
      const __output = __present.length === 1 ? String(__state[__first]) : __present.map((n) => "## " + n + "\\n" + String(__state[n])).join("\\n\\n");
      const __task = __present.length === 1 ? (__tasks[__first] ?? "") : __present.map((n) => "## " + n + "\\n" + (__tasks[n] ?? "")).join("\\n\\n");
      const __result = await __judgeGate({
        criteria: ${escapeJsonString(gate.criteria)},
        model: ${escapeJsonString(node.model)},
        gatedTask: __task,
        output: __output,
        bus: ctx.runContext.eventBus,
      });
      const __pass = __result.score >= ${gate.threshold};
      const __bus = ctx.runContext.eventBus;
      __bus.publish({
        ...__bus.envelope(),
        kind: "judge_verdict",
        stepOrNode: ${nameJs},
        verdict: __pass ? "pass" : "fail",
        score: __result.score,
        ...(__result.rationale.length > 0 ? { rationale: __result.rationale } : {}),
        judgeModel: __result.judgeModel,
        ...(__result.costUsdMicros !== undefined ? { costUsdMicros: __result.costUsdMicros } : {}),
      });
${verdictLine}`;
  const recordReturn = (retriesExpr: string): string =>
    [
      "      return {",
      "        ...prev,",
      `        [${nameJs}]: __pass ? "pass" : "fail",`,
      `        [${nameJs} + "_judge"]: { verdict: __pass ? "pass" : "fail", score: __result.score, rationale: __result.rationale, retries: ${retriesExpr} },`,
      "      };",
    ].join("\n");

  if (gate.onFail === "retry_previous") {
    const retryTarget = upstreams[0] as string; // validateGraph pinned length === 1
    return `
    async (ctx, prev) => {
${scoringPass}
      const __rec = __state[${nameJs} + "_judge"] as { retries?: number } | undefined;
      const __retries = typeof __rec?.retries === "number" ? __rec.retries : 0;
      if (!__pass && __retries >= ${gate.maxRetries}) {
${throwBlock("judge gate failed after retries", `judge node "${node.name}" still scored `, "        ")}
      }
      if (!__pass) {
        process.stderr.write(${escapeJsonString(`[judge ${node.name}] retry `)} + (__retries + 1) + ${escapeJsonString(`/${gate.maxRetries} of node "${retryTarget}"\n`)});
      }
${recordReturn("__pass ? __retries : __retries + 1")}
    }`;
  }
  if (gate.onFail === "halt") {
    return `
    async (ctx, prev) => {
${scoringPass}
      if (!__pass) {
${throwBlock("judge gate failed", `judge node "${node.name}" scored `, "        ")}
      }
${recordReturn("0")}
    }`;
  }
  // on_fail: continue — record the verdict (event + line + state) and proceed.
  return `
    async (ctx, prev) => {
${scoringPass}
      if (!__pass) {
        process.stderr.write(${escapeJsonString(`[judge ${node.name}] on_fail=continue — proceeding with the flagged output\n`)});
      }
${recordReturn("0")}
    }`;
}

function renderAgent(ir: IrGraphV0, evalEntry = false): string {
  validateGraph(ir);

  // Graph-LEVEL runChatLoop fields, identical in every node's call (the
  // taxonomy precedent): failure taxonomy, spend cap, hard ceilings, hooks,
  // permission policy, and the G11 ask disposition + approval store.
  const graphLevelFields = `${renderFailureTaxonomyField(ir)}${renderBudgetField(ir)}${renderLimitsFields(ir)}${renderHooksField(ir)}${renderPermissionsFields(ir)}${renderApprovalFields(ir, "        ")}`;
  // G07 — per-node tools: one grouped import/init block for the file,
  // one array literal per declaring node.
  const tools = resolveTools(ir);
  const toolImportBlock = tools.imports.length > 0 ? `${tools.imports.join("\n")}\n` : "";
  const toolInitBlock = tools.inits.length > 0 ? `\n${tools.inits.join("\n")}\n` : "";

  // G02 — judge gates: which nodes are judges, which can throw (halt /
  // exhausted retry_previous — gates the classified-throw machinery), and
  // which nodes are retry targets (their bodies read the failing judge's
  // rationale as a nudge; a node can be gated by several judges).
  const judgeNodes = ir.nodes.filter(isJudgeNode);
  const hasJudges = judgeNodes.length > 0;
  const hasThrowingJudges = judgeNodes.some((n) => n.judge?.onFail !== "continue");
  const passGatedJudges = new Set(
    judgeNodes.filter((n) => n.judge?.onFail !== "continue").map((n) => n.name),
  );
  const nudgeJudgesByNode = new Map<string, string[]>();
  for (const j of judgeNodes) {
    if (j.judge?.onFail !== "retry_previous") continue;
    const target = gatedUpstreams(ir, j.name)[0] as string; // validateGraph pinned length === 1
    const list = nudgeJudgesByNode.get(target) ?? [];
    list.push(j.name);
    nudgeJudgesByNode.set(target, list);
  }

  // G61 — durable exactly-once wrapping applies only to acyclic,
  // work-performing nodes (judges are pure scoring; cyclic nodes re-run by
  // design). `anyDurable` gates the store + helper + imports so graphs with
  // nothing to wrap emit no idempotency plumbing.
  const cyclicNodes = nodesOnCycle(ir);
  const isDurable = (n: IrGraphNode): boolean => !isJudgeNode(n) && !cyclicNodes.has(n.name);
  const anyDurable = ir.nodes.some(isDurable);

  const nodeRegistrations = ir.nodes
    .map((n) => {
      const body = isJudgeNode(n)
        ? renderJudgeNodeBody(n, ir)
        : renderNodeBody(
            n,
            graphLevelFields,
            tools.toolsArrayByNode.get(n.name),
            nudgeJudgesByNode.get(n.name) ?? [],
            evalEntry,
          );
      const nameJs = escapeJsonString(n.name);
      return isDurable(n)
        ? `  .addNode(${nameJs}, __durableNode(${nameJs}, ${body.trim()}))`
        : `  .addNode(${nameJs}, ${body.trim()})`;
    })
    .join("\n");

  // Loop contract 0.4 (Batch A) — `when` blocks become EdgeCondition
  // lambdas (declaration order is semantics: the engine takes the first
  // matching edge, so no reordering). G02 — edges LEAVING a halt /
  // retry_previous judge are pass-gated (`state["<judge>"] === "pass"`,
  // AND-composed with any author `when`).
  const edgeRegistrations = ir.edges
    .map((e) => {
      const conditionArg = passGatedJudges.has(e.from)
        ? `, ${renderJudgePassCondition(e.from, e.when)}`
        : e.when !== undefined
          ? `, ${renderEdgeCondition(e.when)}`
          : "";
      return `  .addEdge(${escapeJsonString(e.from)}, ${escapeJsonString(e.to)}${conditionArg})`;
    })
    .join("\n");

  // G02 — synthesized retry back-edges, appended AFTER the declared edges:
  // a "fail" record loops the run back to the gated node (retries always
  // remain when an edge sees "fail" — exhaustion throws inside the judge
  // body). Declaration order keeps author edges first, but the conditions
  // are disjoint ("pass" vs "fail") so no declared edge can shadow these.
  const retryBackEdges = judgeNodes
    .filter((n) => n.judge?.onFail === "retry_previous")
    .map((n) => {
      const target = gatedUpstreams(ir, n.name)[0] as string;
      return `  // G02 — judge "${n.name}" retry back-edge (rationale rides the state as a nudge)
  .addEdge(${escapeJsonString(n.name)}, ${escapeJsonString(target)}, (__state) => (__state as Record<string, unknown>)[${escapeJsonString(n.name)}] === "fail")`;
    })
    .join("\n");
  const retryBackEdgeBlock = retryBackEdges.length > 0 ? `\n${retryBackEdges}` : "";

  // Loop contract 0.4 (Batch A) — parallel barrier groups, in declaration
  // order (group order and member order are execution semantics). No
  // reducer arg: this batch carries no spec key for reducers, so the
  // engine's G69 key-collision check guards the default merge.
  const parallelRegistrations = (ir.parallel ?? [])
    .map((group) => `  .addParallel([${group.map((n) => escapeJsonString(n)).join(", ")}])`)
    .join("\n");
  const parallelBlock = parallelRegistrations.length > 0 ? `\n${parallelRegistrations}` : "";

  const entryRegistration = `  .setEntry(${escapeJsonString(ir.entry)})`;

  // G02 — judge machinery, emitted only when a judge node is present so
  // judge-free bundles stay byte-identical: the errors import grows the
  // classified-throw members, eval-judge supplies the scorer, and the
  // module-scope helper block lands before the graph construction.
  const errorsImport = hasThrowingJudges
    ? `import { EXIT_CODES, RunFailedError, formatRunFailure, toFailureReport } from "@crewhaus/errors";`
    : `import { formatRunFailure, toFailureReport } from "@crewhaus/errors";`;
  const judgeImport = hasJudges
    ? `\nimport { judge } from "@crewhaus/eval-judge";\nimport type { TraceEventBus } from "@crewhaus/trace-event-bus";`
    : "";
  const judgeHelperBlock = hasJudges
    ? `${JUDGE_GATE_HELPER}${hasThrowingJudges ? EVAL_EXIT_CONST : ""}`
    : "";

  // The rule literals name BUILTIN_DEFAULT_RULES as their bottom precedence
  // layer, so the import rides only when the spec declared rules (mirror:
  // target-batch-worker).
  const permImport =
    ir.permissions.rules.length > 0
      ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
      : "";

  // HITL machinery, emitted only when a node declares `hitl:` so gate-free
  // bundles stay byte-identical (the judge-helper precedent).
  const hasHitl = ir.nodes.some((n) => n.hitlPrompt !== undefined);
  const hitlHelperBlock = hasHitl ? HITL_HELPER : "";

  // G61 — durable exactly-once wrapping. Emitted only when at least one node
  // is wrappable, so graphs with nothing to wrap stay free of the plumbing.
  const graphEngineImport = anyDurable
    ? `import { createGraph, type NodeFn } from "@crewhaus/graph-engine";`
    : `import { createGraph } from "@crewhaus/graph-engine";`;
  const durableImport = anyDurable
    ? `\nimport { createIdempotencyStore, withIdempotency } from "@crewhaus/durable-execution";`
    : "";
  const durableHelperBlock = anyDurable
    ? `
// Loop contract 0.4 (Batch F, temporal contract / G61) — durable exactly-once
// node execution. Each acyclic node runs through withIdempotency keyed
// (graphRunId, node, attempt=0); on a crash-restart re-executing the SAME run
// the completed attempt's cached result is returned instead of re-running the
// node's side effects. The default store is in-memory (transparent within one
// process); set CREWHAUS_IDEMPOTENCY_STORE=file:<dir> so records survive the
// restart and the guarantee crosses the crash. Cyclic nodes (judge-retry or
// author \`when\` loops) are NOT wrapped — they re-execute by design.
const __idempotencyStore = createIdempotencyStore(${escapeJsonString(ir.name)});
function __durableNode(name: string, fn: NodeFn<unknown>): NodeFn<unknown> {
  return (ctx, prev) =>
    withIdempotency<unknown>(async (_g, _n, __prev) => fn(ctx, __prev), {
      store: __idempotencyStore,
    })(ctx.graphRunId, name, prev);
}
`
    : "";

  // Cluster S (D36/NEW-shape-1) — the eval-entry variant: an exported
  // runForEval that drives the SAME compiled __graph to run_done on the
  // caller's RunContext, plus the PER-INVOCATION eval seams the node bodies
  // read (keyed by RunContext), plus the import.meta.main guard so importing
  // the bundle never runs the CLI. Empty/plain when off (byte-identical).
  const evalEntryBlock = evalEntry
    ? `
/**
 * Eval bridge (cluster S, D36/NEW-shape-1) — drive the compiled graph to
 * completion once: \`input\` becomes the graph's entry state (exactly what
 * main() reads from stdin) and the returned string is the run_done state
 * JSON — what a deployed run prints. Runs on the caller's RunContext when
 * supplied, so node traces + judge verdicts land on the caller's bus. A
 * HITL pause throws: approvals cannot resolve inside a headless eval sample.
 *
 * The seams every node body reads — \`sessionRootDir\` (re-roots each node's
 * session log into the runner's per-sample artifact dir, so the sample's
 * transcript.jsonl is populated instead of piling up in the process cwd) and
 * \`_adapter\` (the scripted-provider test path) — hang off THIS invocation's
 * RunContext rather than a module-scope mutable, so two concurrent samples
 * (the bundle's default concurrency is 2) each see their own.
 */
const __evalSeams = new WeakMap<
  NonNullable<NonNullable<Parameters<typeof __graph.run>[1]>["runContext"]>,
  { sessionRootDir?: string; _adapter?: Parameters<typeof runChatLoop>[0]["_adapter"] }
>();
export async function runForEval(
  __evalInput: string,
  __evalOpts: {
    runContext?: NonNullable<Parameters<typeof __graph.run>[1]>["runContext"];
    sessionRootDir?: string;
    _adapter?: Parameters<typeof runChatLoop>[0]["_adapter"];
  } = {},
): Promise<string> {
  const __evalRunContext = __evalOpts.runContext ?? __runContext;
  __evalSeams.set(__evalRunContext, {
    ...(__evalOpts.sessionRootDir !== undefined ? { sessionRootDir: __evalOpts.sessionRootDir } : {}),
    ...(__evalOpts._adapter !== undefined ? { _adapter: __evalOpts._adapter } : {}),
  });
  const stream = __graph.run({ input: __evalInput }, { runContext: __evalRunContext });
  let __finalState: unknown;
  let __paused: { nodeName: string; prompt: string } | undefined;
  for await (const ev of stream) {
    process.stderr.write(\`[graph] \${JSON.stringify(ev)}\\n\`);
    if (ev.kind === "hitl_pause") {
      __paused = { nodeName: ev.nodeName, prompt: ev.prompt };
    }
    if (ev.kind === "run_done") {
      __finalState = ev.state;
    }
  }
  if (__paused !== undefined) {
    throw new Error(\`graph paused for HITL approval at node "\${__paused.nodeName}" ("\${__paused.prompt}") — HITL gates cannot resolve inside a headless eval sample; remove hitl: from the node or eval a non-gated path\`);
  }
  if (__finalState === undefined) {
    throw new Error("graph run ended without a run_done event — nothing to grade");
  }
  return JSON.stringify(__finalState, null, 2);
}
`
    : "";
  const plainInvocation = `try {
  await main();
} catch (__err) {
  // v0.3.0 Goal 6 — render the ONE structured failure report (a classified
  // RunFailedError — e.g. the engine's G69 parallel-merge collision —
  // carries its own report; anything else synthesizes the generic one) and
  // exit with its coded status instead of an unhandled Bun stack.
  const __report = toFailureReport(__err);
  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[graph]" })}\\n\`);
  process.exit(__report.exitCode);
}`;
  const invocationBlock = evalEntry
    ? `if (import.meta.main) {
${plainInvocation
  .split("\n")
  .map((l) => (l.length > 0 ? `  ${l}` : l))
  .join("\n")}
}`
    : plainInvocation;

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: graph, ir version: ${ir.version})
${errorsImport}${judgeImport}
import { runChatLoop } from "@crewhaus/runtime-core";
import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";
import { createCheckpointStore } from "@crewhaus/checkpoint-store";
${graphEngineImport}
import { createRunContext } from "@crewhaus/run-context";${durableImport}
${permImport}${toolImportBlock}${toolInitBlock}${hitlHelperBlock}${judgeHelperBlock}${durableHelperBlock}
// G11 — a compiled bundle is NON-INTERACTIVE: a node whose tool call lands on
// \`ask\` has nobody to prompt, so without this it collapsed to a deny. Rooted
// where the run's session files land, so parks live beside them (and inside a
// tenant's rebased root when one is active). No I/O until a park.
const __approvalRoot = resolveSessionRootDir(undefined);
const __approvals = createPendingApprovalStore(
  __approvalRoot !== undefined ? { rootDir: __approvalRoot } : {},
);
const __store = createCheckpointStore();
const __runContext = createRunContext();
const __graph = createGraph({ checkpointStore: __store })
  .setInputAdapter((input) => ({ input }))
${nodeRegistrations}
${edgeRegistrations}${retryBackEdgeBlock}${parallelBlock}
${entryRegistration}
  .compile();

async function readStdinToEnd(): Promise<string> {
  // No piped input — don't block waiting on an interactive TTY.
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function parseArgs(argv: ReadonlyArray<string>): {
  mode: "fresh" | "resume" | "branch";
  graphRunId?: string;
  checkpointId?: string;
  decision?: string;
} {
  const args = argv.slice(2);
  const idxResume = args.indexOf("--resume");
  if (idxResume >= 0) {
    const id = args[idxResume + 1];
    const decision = args[idxResume + 2] ?? "approve";
    if (id === undefined) throw new Error("--resume requires <graphRunId> <decision>");
    return { mode: "resume", graphRunId: id, decision };
  }
  const idxBranch = args.indexOf("--branch-from");
  if (idxBranch >= 0) {
    const grun = args[idxBranch + 1];
    const ckpt = args[idxBranch + 2];
    if (grun === undefined || ckpt === undefined) {
      throw new Error("--branch-from requires <graphRunId> <checkpointId>");
    }
    return { mode: "branch", graphRunId: grun, checkpointId: ckpt };
  }
  return { mode: "fresh" };
}

type __Paused = {
  checkpointId: string;
  nodeName: string;
  prompt: string;
  /** The state the paused node is about to run on — what is being approved. */
  state: unknown;
};

/**
 * Report a HITL pause. The gate is a PRE-condition: nothing of the paused
 * node has run, so the state printed here is the upstream output the
 * decision is actually about — printing it is the difference between an
 * approver reading the work and rubber-stamping a prompt.
 */
function __writePause(paused: __Paused, graphRunId: string): void {
  process.stdout.write(\`paused at \${paused.nodeName}: "\${paused.prompt}" — checkpoint=\${paused.checkpointId} run=\${graphRunId}\\n\`);
  process.stdout.write(\`state under review (\${paused.nodeName} has NOT run yet):\\n\${JSON.stringify(paused.state, null, 2)}\\n\`);
  process.stdout.write(\`to resume: bun \${process.argv[1]} --resume \${graphRunId} <decision>\\n\`);
  process.stdout.write(\`  <decision> is recorded at state["\${paused.nodeName}_decision"]; "reject"/"no"/"deny"/"cancel"/"abort" skips \${paused.nodeName}'s turn, anything else approves it.\\n\`);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);

  if (cli.mode === "branch" && cli.graphRunId !== undefined && cli.checkpointId !== undefined) {
    const { newGraphRunId, head } = await __store.branch(cli.graphRunId, cli.checkpointId);
    process.stdout.write(\`branched: newRun=\${newGraphRunId} head=\${head.id} from=\${cli.graphRunId}/\${cli.checkpointId}\\n\`);
    // After branching, replay from the head's nodeName.
    const stream = __graph.run(head.state as { input?: string } | unknown, {
      graphRunId: newGraphRunId,
      runContext: __runContext,
      resumeFrom: { checkpointId: head.id, nextNode: head.nodeName },
    });
    let pausedAt: __Paused | undefined;
    for await (const ev of stream) {
      process.stderr.write(\`[graph] \${JSON.stringify(ev)}\\n\`);
      if (ev.kind === "hitl_pause") {
        pausedAt = { checkpointId: ev.checkpointId, nodeName: ev.nodeName, prompt: ev.prompt, state: ev.state };
      }
      if (ev.kind === "run_done") {
        process.stdout.write(JSON.stringify(ev.state, null, 2) + "\\n");
      }
    }
    if (pausedAt !== undefined) {
      __writePause(pausedAt, newGraphRunId);
    }
    return;
  }

  if (cli.mode === "resume" && cli.graphRunId !== undefined) {
    const meta = await __store.meta(cli.graphRunId);
    const head = meta?.head;
    if (head === undefined) {
      throw new Error(\`no head checkpoint for run \${cli.graphRunId}\`);
    }
    const stream = __graph.resume(cli.graphRunId, head, cli.decision ?? "approve", {
      runContext: __runContext,
    });
    for await (const ev of stream) {
      process.stderr.write(\`[graph] \${JSON.stringify(ev)}\\n\`);
      if (ev.kind === "run_done") {
        process.stdout.write(JSON.stringify(ev.state, null, 2) + "\\n");
      }
    }
    return;
  }

  // fresh run
  const stdin = await readStdinToEnd();
  const stream = __graph.run({ input: stdin }, { runContext: __runContext });
  let pausedAt: __Paused | undefined;
  let lastGraphRunId: string | undefined;
  for await (const ev of stream) {
    process.stderr.write(\`[graph] \${JSON.stringify(ev)}\\n\`);
    if (ev.kind === "node_start" || ev.kind === "node_end" || ev.kind === "checkpoint" || ev.kind === "hitl_pause" || ev.kind === "run_done") {
      lastGraphRunId = ev.graphRunId;
    }
    if (ev.kind === "hitl_pause") {
      pausedAt = { checkpointId: ev.checkpointId, nodeName: ev.nodeName, prompt: ev.prompt, state: ev.state };
    }
    if (ev.kind === "run_done") {
      process.stdout.write(JSON.stringify(ev.state, null, 2) + "\\n");
    }
  }
  if (pausedAt !== undefined) {
    __writePause(pausedAt, lastGraphRunId ?? "?");
  }
}
${evalEntryBlock}
${invocationBlock}
`;
}
