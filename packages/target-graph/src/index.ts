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
 * HITL: nodes whose IR carries `hitlPrompt` await `ctx.requestApproval`
 * after the LLM turn. The graph-engine's pause/resume flow handles the
 * checkpoint persistence; the bundle emits CLI argument parsing for
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
export function emitGraph(ir: IrGraphV0, opts: EmitReadmeOptions = {}): Bundle {
  const files = [
    {
      path: "agent.ts",
      content: renderAgent(ir),
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
function renderEdgeCondition(when: IrGraphEdgeWhen): string {
  const keyJs = escapeJsonString(when.key);
  if (when.equals !== undefined) {
    return `(__state) => (__state as Record<string, unknown>)[${keyJs}] === ${JSON.stringify(when.equals)}`;
  }
  if (when.exists === true) {
    return `(__state) => (__state as Record<string, unknown>)[${keyJs}] !== undefined`;
  }
  // Unreachable through parseSpec (its superRefine demands exactly one
  // form) — guard for direct-IR builders handing in an empty block.
  throw new TargetEmitError(
    `edge when on key "${when.key}" must carry exactly one of equals/exists`,
  );
}

/**
 * Render a single node's body. The body calls runChatLoop singleTurn
 * with the node's instructions and the upstream state serialised as a
 * user message. Returns the assistant reply text under
 * `state["<nodeName>"]`. When `hitlPrompt` is set, the node calls
 * `ctx.requestApproval` after the LLM turn so the engine can pause.
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

function renderNodeBody(
  node: IrGraphNode,
  graphLevelFields: string,
  toolsArrayLiteral: string | undefined,
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
  const hitlBlock =
    node.hitlPrompt !== undefined
      ? `
      const __decision = await ctx.requestApproval(${escapeJsonString(node.hitlPrompt)});
      __next[${nameJs} + "_decision"] = __decision;`
      : "";
  return `
    async (ctx, prev) => {
      const __seed = [
        { role: "user", content: \`Upstream state:\\n\\\`\\\`\\\`json\\n\${JSON.stringify(prev, null, 2)}\\n\\\`\\\`\\\`\` },
      ];
      const __reply = await runChatLoop({
        model: ${modelJs},
        instructions: ${instructionsJs},
        sessionName: ${escapeJsonString(node.name)} + "-" + ctx.graphRunId,
        sessionTarget: "graph-node",
        seedMessages: __seed,
        singleTurn: true,${renderNodeLoopFields(node)}${toolsField}${graphLevelFields}
        runContext: ctx.runContext,
      });
      const __next = { ...prev, [${nameJs}]: __reply };${hitlBlock}
      return __next;
    }`;
}

function renderAgent(ir: IrGraphV0): string {
  validateGraph(ir);

  // Graph-LEVEL runChatLoop fields, identical in every node's call (the
  // taxonomy precedent): failure taxonomy, spend cap, hard ceilings, hooks.
  const graphLevelFields = `${renderFailureTaxonomyField(ir)}${renderBudgetField(ir)}${renderLimitsFields(ir)}${renderHooksField(ir)}`;
  // G07 — per-node tools: one grouped import/init block for the file,
  // one array literal per declaring node.
  const tools = resolveTools(ir);
  const toolImportBlock = tools.imports.length > 0 ? `${tools.imports.join("\n")}\n` : "";
  const toolInitBlock = tools.inits.length > 0 ? `\n${tools.inits.join("\n")}\n` : "";
  const nodeRegistrations = ir.nodes
    .map(
      (n) =>
        `  .addNode(${escapeJsonString(n.name)}, ${renderNodeBody(
          n,
          graphLevelFields,
          tools.toolsArrayByNode.get(n.name),
        ).trim()})`,
    )
    .join("\n");

  // Loop contract 0.4 (Batch A) — `when` blocks become EdgeCondition
  // lambdas (declaration order is semantics: the engine takes the first
  // matching edge, so no reordering).
  const edgeRegistrations = ir.edges
    .map((e) => {
      const conditionArg = e.when !== undefined ? `, ${renderEdgeCondition(e.when)}` : "";
      return `  .addEdge(${escapeJsonString(e.from)}, ${escapeJsonString(e.to)}${conditionArg})`;
    })
    .join("\n");

  // Loop contract 0.4 (Batch A) — parallel barrier groups, in declaration
  // order (group order and member order are execution semantics). No
  // reducer arg: this batch carries no spec key for reducers, so the
  // engine's G69 key-collision check guards the default merge.
  const parallelRegistrations = (ir.parallel ?? [])
    .map((group) => `  .addParallel([${group.map((n) => escapeJsonString(n)).join(", ")}])`)
    .join("\n");
  const parallelBlock = parallelRegistrations.length > 0 ? `\n${parallelRegistrations}` : "";

  const entryRegistration = `  .setEntry(${escapeJsonString(ir.entry)})`;

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: graph, ir version: ${ir.version})
import { formatRunFailure, toFailureReport } from "@crewhaus/errors";
import { runChatLoop } from "@crewhaus/runtime-core";
import { createCheckpointStore } from "@crewhaus/checkpoint-store";
import { createGraph } from "@crewhaus/graph-engine";
import { createRunContext } from "@crewhaus/run-context";
${toolImportBlock}${toolInitBlock}
const __store = createCheckpointStore();
const __runContext = createRunContext();
const __graph = createGraph({ checkpointStore: __store })
  .setInputAdapter((input) => ({ input }))
${nodeRegistrations}
${edgeRegistrations}${parallelBlock}
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
    let pausedAt: { checkpointId: string; nodeName: string; prompt: string } | undefined;
    for await (const ev of stream) {
      process.stderr.write(\`[graph] \${JSON.stringify(ev)}\\n\`);
      if (ev.kind === "hitl_pause") {
        pausedAt = { checkpointId: ev.checkpointId, nodeName: ev.nodeName, prompt: ev.prompt };
      }
      if (ev.kind === "run_done") {
        process.stdout.write(JSON.stringify(ev.state, null, 2) + "\\n");
      }
    }
    if (pausedAt !== undefined) {
      process.stdout.write(\`paused at \${pausedAt.nodeName}: "\${pausedAt.prompt}" — checkpoint=\${pausedAt.checkpointId}\\n\`);
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
  let pausedAt: { checkpointId: string; nodeName: string; prompt: string } | undefined;
  let lastGraphRunId: string | undefined;
  for await (const ev of stream) {
    process.stderr.write(\`[graph] \${JSON.stringify(ev)}\\n\`);
    if (ev.kind === "node_start" || ev.kind === "node_end" || ev.kind === "checkpoint" || ev.kind === "hitl_pause" || ev.kind === "run_done") {
      lastGraphRunId = ev.graphRunId;
    }
    if (ev.kind === "hitl_pause") {
      pausedAt = { checkpointId: ev.checkpointId, nodeName: ev.nodeName, prompt: ev.prompt };
    }
    if (ev.kind === "run_done") {
      process.stdout.write(JSON.stringify(ev.state, null, 2) + "\\n");
    }
  }
  if (pausedAt !== undefined) {
    process.stdout.write(\`paused at \${pausedAt.nodeName}: "\${pausedAt.prompt}" — checkpoint=\${pausedAt.checkpointId} run=\${lastGraphRunId ?? "?"}\\n\`);
    process.stdout.write(\`to resume: bun \${process.argv[1]} --resume \${lastGraphRunId ?? "?"} <decision>\\n\`);
  }
}

try {
  await main();
} catch (__err) {
  // v0.3.0 Goal 6 — render the ONE structured failure report (a classified
  // RunFailedError — e.g. the engine's G69 parallel-merge collision —
  // carries its own report; anything else synthesizes the generic one) and
  // exit with its coded status instead of an unhandled Bun stack.
  const __report = toFailureReport(__err);
  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[graph]" })}\\n\`);
  process.exit(__report.exitCode);
}
`;
}
