/**
 * Catalog F2 `target-crew` — Section 22.
 *
 * Codegen for the CRW target shape. Mirrors the multi-file pattern from
 * `target-channel-bot`:
 *   - `daemon.ts`     — entrypoint that loads hooks/skills/commands,
 *                       constructs the runnable crew, and serves stdin or
 *                       a webhook.
 *   - `orchestrator.ts` — wires the `Crew` builder to the spec roles +
 *                         entry + routing.
 *   - `agent_<role>.ts` — per-role config wrapper exporting a
 *                         `RoleDefinition` instance for the orchestrator
 *                         to register.
 *
 * The emitted daemon reads input from stdin (one prompt per line) and
 * pipes events to stdout as JSON-per-line so the smoke harness (and any
 * future shell pipeline consumer) can parse them deterministically.
 */
import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrCrewRole,
  type IrCrewV0,
  type IrSubAgentDefinition,
  renderBundleReadme,
} from "@crewhaus/ir";
import { memoryFragmentFromIr } from "@crewhaus/memory-service";

export class TargetEmitError extends CrewhausError {
  override readonly name = "TargetEmitError";
  constructor(message: string, cause?: unknown) {
    super("compiler", message, cause);
  }
}

/**
 * Built-in tool name → package + export. Mirrors target-channel-bot's
 * map but excluded `sendMessage` (the channel-bot variant) since CRW
 * roles use `a2a-protocol`'s `SendMessage` automatically wired by the
 * orchestrator.
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

export function emitCrew(ir: IrCrewV0, opts: EmitReadmeOptions = {}): Bundle {
  if (ir.roles.length === 0) {
    throw new TargetEmitError("crew target requires at least one role");
  }
  const entryRole = ir.roles.find((r) => r.name === ir.entry);
  if (entryRole === undefined) {
    throw new TargetEmitError(
      `crew entry "${ir.entry}" does not match any defined role (got: ${ir.roles
        .map((r) => r.name)
        .join(", ")})`,
    );
  }

  const files = [
    { path: "orchestrator.ts", content: renderOrchestrator(ir, entryRole) },
    { path: "daemon.ts", content: renderDaemon(ir) },
  ];
  for (const role of ir.roles) {
    files.push({ path: `agent_${safeFileName(role.name)}.ts`, content: renderRoleAgent(ir, role) });
  }
  // Item 42 — generated bundle README; default ON (`crewhaus compile
  // --no-readme` opts out).
  if (opts.readme !== false) {
    files.push({ path: "README.md", content: renderBundleReadme(ir) });
  }
  return { files };
}

function safeFileName(role: string): string {
  // Conservative: keep alnum + underscore so generated paths are clean.
  return role.replace(/[^a-zA-Z0-9_]/g, "_");
}

function resolveTools(
  toolNames: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): {
  imports: string[];
  inits: string[];
  registrations: string[];
} {
  if (toolNames.length === 0) return { imports: [], inits: [], registrations: [] };
  const byPackage = new Map<string, Set<string>>();
  const registrations: string[] = [];
  const inits: string[] = [];
  for (const name of toolNames) {
    const entry = BUILTIN_TOOL_MAP[name];
    if (!entry) {
      const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
      throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
    }
    const set = byPackage.get(entry.package) ?? new Set<string>();
    set.add(entry.export);
    byPackage.set(entry.package, set);
    if (entry.initSymbol !== undefined) {
      const cfg = toolConfigs[name];
      if (cfg !== undefined) {
        set.add(entry.initSymbol);
        inits.push(`${entry.initSymbol}(${JSON.stringify(cfg)});`);
      }
    }
    registrations.push(entry.export);
  }
  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const symbols = [...(byPackage.get(pkg) ?? new Set<string>())].sort();
    imports.push(`import { ${symbols.join(", ")} } from "${pkg}";`);
  }
  return { imports, inits, registrations };
}

function renderPermissionsField(ir: IrCrewV0): string {
  const { mode, rules } = ir.permissions;
  if (mode === undefined && rules.length === 0) return "";
  const lines: string[] = [];
  if (mode !== undefined) {
    lines.push(`  permissionMode: ${escapeJsonString(mode)},`);
  }
  if (rules.length > 0) {
    const ruleLits = rules
      .map(
        (r) =>
          `      { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
      )
      .join("\n");
    lines.push(
      [
        "  permissionRules: {",
        "    flag: [],",
        "    settings: [],",
        "    yaml: [",
        ruleLits,
        "    ],",
        "    hooks: [],",
        "    builtin: BUILTIN_DEFAULT_RULES,",
        "  },",
      ].join("\n"),
    );
  }
  return `\n${lines.join("\n")}`;
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` crew RunOptions field.
 * The orchestrator threads it into every role's runChatLoop (same crew-wide
 * scope as permissionMode/permissionRules). Empty when the spec omits the
 * block (mirror: target-cli + target-channel-bot render the same field).
 */
function renderFailureTaxonomyField(ir: IrCrewV0): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n  failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Loop contract 0.4 (Batch A) — the crew-only orchestration ceilings
 * (`limits.crew`) map onto crew-orchestrator's EXISTING RunOptions caps:
 * `max_activations` → `maxActivations`, `refusal_depth` → `refusalDepth`,
 * `max_a2a_depth` → `maxA2ADepth`. Each cap is emitted only when the spec
 * declared it — the orchestrator owns the defaults (16 / 2 / 3) — so
 * existing bundles stay byte-identical.
 */
function renderCrewCapsFields(ir: IrCrewV0): string {
  const crew = ir.limits?.crew;
  if (crew === undefined) return "";
  const pieces: string[] = [];
  if (crew.maxActivations !== undefined) {
    pieces.push(`\n    maxActivations: ${crew.maxActivations},`);
  }
  if (crew.refusalDepth !== undefined) {
    pieces.push(`\n    refusalDepth: ${crew.refusalDepth},`);
  }
  if (crew.maxA2aDepth !== undefined) {
    pieces.push(`\n    maxA2ADepth: ${crew.maxA2aDepth},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — the per-turn loop ceilings (top-level
 * `limits:` minus the crew-only block above) ride `RunOptions.limits`; the
 * orchestrator forwards them to EVERY role's runChatLoop — primary
 * activations and inline A2A peer turns alike (`composeLoopTuning`). Only
 * declared knobs are present — the runtime owns every default. Mirror:
 * target-cli + target-channel-bot + target-managed render the same knobs
 * (as direct runChatLoop fields — crew is the one shape that routes them
 * through an orchestrator).
 */
function renderLoopLimitsField(ir: IrCrewV0): string {
  const limits = ir.limits;
  if (limits === undefined) return "";
  const loop = {
    ...(limits.maxToolIterations !== undefined
      ? { maxToolIterations: limits.maxToolIterations }
      : {}),
    ...(limits.maxConcurrentTools !== undefined
      ? { maxConcurrentTools: limits.maxConcurrentTools }
      : {}),
    ...(limits.contextLimit !== undefined ? { contextLimit: limits.contextLimit } : {}),
    ...(limits.deadlineMs !== undefined ? { deadlineMs: limits.deadlineMs } : {}),
    ...(limits.turnTimeoutMs !== undefined ? { turnTimeoutMs: limits.turnTimeoutMs } : {}),
    ...(limits.modelCallTimeoutMs !== undefined
      ? { modelCallTimeoutMs: limits.modelCallTimeoutMs }
      : {}),
    ...(limits.loopDetection !== undefined ? { loopDetection: limits.loopDetection } : {}),
  };
  if (Object.keys(loop).length === 0) return "";
  return `\n    limits: ${JSON.stringify(loop)},`;
}

/** Item 27 (Batch A extends it to crew) — run-level spend cap + degradation
 *  ladder. The orchestrator forwards it to every role's runChatLoop, so the
 *  always-on cost meter accrues the WHOLE crew run against one cap. Mirror:
 *  target-cli + target-channel-bot render the same field. */
function renderBudgetField(ir: IrCrewV0): string {
  if (ir.budget === undefined) return "";
  return `\n    budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks (`hooks:`).
 * IrHook is HookDef-shaped by contract (the spec ↔ hooks-engine cross-check
 * test pins the event list), so codegen embeds the array as a literal on
 * `RunOptions.hooks` and the orchestrator forwards it to every role's
 * runChatLoop. The crew daemon discovers no settings.json hooks (unlike
 * cli), so the spec list is the whole array; declaration order is preserved
 * (hooks run in registration order). Absent/empty leaves bundles
 * byte-identical.
 */
function renderHooksField(ir: IrCrewV0): string {
  if (ir.hooks === undefined || ir.hooks.length === 0) return "";
  return `\n    hooks: ${JSON.stringify(ir.hooks)},`;
}

/**
 * Loop contract 0.4 (Batch A, G05) — spec-declared MCP servers, wired ONCE
 * at daemon boot (the wire-once pattern: one shared McpHost, one
 * registration pass) into a dedicated catalog whose tools every role
 * receives through the orchestrator's crew-wide `extraTools`. The
 * UNRESOLVED IrSecretRef-valued config is embedded and resolved at boot
 * (mirror of target-cli + target-channel-bot's renderMcpServers; keep in
 * sync). One deliberate divergence: `onRegister` logs to STDERR — the crew
 * daemon's stdout is the JSON-per-line event stream and must stay
 * machine-parseable.
 */
function renderMcpServers(ir: IrCrewV0): {
  imports: string[];
  bootBlock: string;
  hasAny: boolean;
} {
  const entries = Object.entries(ir.mcp_servers);
  if (entries.length === 0) {
    return { imports: [], bootBlock: "", hasAny: false };
  }
  const imports = [
    `import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";`,
    `import { registerMcpServer } from "@crewhaus/tool-mcp";`,
  ];
  const addLines = entries
    .map(
      ([name, cfg]) =>
        `  mcpHost.addServer(${escapeJsonString(name)}, resolveMcpServerConfig(${JSON.stringify(cfg)}, { name: ${escapeJsonString(name)} }));`,
    )
    .join("\n");
  const registerLines = entries
    .map(
      ([name]) =>
        `    registerMcpServer(mcpHost, ${escapeJsonString(name)}, __mcpCatalog, { onRegister: ({ fullName }) => process.stderr.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  const bootBlock = `
  // Loop contract 0.4 (Batch A, G05) — MCP servers, wired ONCE: every
  // role's turns see the remote tools through the orchestrator's crew-wide
  // extraTools; the daemon disconnects the shared host on shutdown.
  const mcpHost = new McpHost();
${addLines}
  const __mcpCatalog = new ToolCatalog();
  await Promise.all([
${registerLines}
  ]);
  const __mcpTools = __mcpCatalog.list();`;
  return { imports, bootBlock, hasAny: true };
}

// ---------------------------------------------------------------------------
// File: agent_<role>.ts — exports the role's RoleDefinition.
// ---------------------------------------------------------------------------

/** Render one IrSubAgentDefinition as a TS object literal — mirrors
 *  target-cli + target-channel-bot; keep the three in sync. */
function renderSubAgentDef(d: IrSubAgentDefinition): string {
  const lines: string[] = [];
  lines.push(`name: ${escapeJsonString(d.name)}`);
  lines.push(`description: ${escapeJsonString(d.description)}`);
  lines.push(`instructions: ${escapeJsonString(d.instructions)}`);
  lines.push(`tools: ${JSON.stringify(d.tools)}`);
  if (d.model !== undefined) lines.push(`model: ${escapeJsonString(d.model)}`);
  if (typeof d.permissions === "string") {
    lines.push(`permissions: ${escapeJsonString(d.permissions)}`);
  } else {
    lines.push(
      `permissions: { allow: ${JSON.stringify(d.permissions.allow)}, deny: ${JSON.stringify(d.permissions.deny)} }`,
    );
  }
  lines.push(`inherit_bypass: ${d.inheritBypass}`);
  return `{ ${lines.join(", ")} }`;
}

/**
 * Loop contract 0.4 (Batch A) — render the per-role tuning fields onto the
 * RoleDefinition literal, camelCase-mirroring the IR 1:1: `max_tokens` →
 * `maxTokens` (model max OUTPUT tokens per activation) and `thinking` →
 * `thinking` (extended-thinking selector; exactly one of `{ budgetTokens }`
 * / `{ effort }` by spec construction — the orchestrator forwards it to the
 * role's runChatLoop turns). Each field is emitted only when the spec
 * declared it — the runtime owns every default — so existing bundles stay
 * byte-identical. Mirror: target-cli + target-channel-bot render the same
 * knobs on their agent blocks.
 */
function renderRoleTuningFields(role: IrCrewRole): string {
  const pieces: string[] = [];
  if (role.maxTokens !== undefined) {
    pieces.push(`\n    maxTokens: ${role.maxTokens},`);
  }
  if (role.thinking !== undefined) {
    pieces.push(`\n    thinking: ${JSON.stringify(role.thinking)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch G, item 9 / G37) — render the per-role model-
 * routing fields onto the role's `RoleDefinition` literal. The pooled
 * pattern is adopted verbatim from the cli agent block
 * (`@crewhaus/target-cli`'s `renderModelFailoverFields`), so a PolicyRouter
 * decision per role shares the same `@crewhaus/routing-store` scoreboard the
 * cli/pipeline shapes use — runtime-core owns the router; the orchestrator
 * forwards the RoleDefinition's config into this role's `runChatLoop` turns
 * (primary activations AND inline A2A peer turns) exactly as it already
 * forwards `maxTokens`/`thinking`. The four fields are mutually exclusive in
 * the spec (`model_pool` ⊥ `model_tiers` ⊥ `model_fallbacks`, with
 * `circuit_breaker` riding `model_fallbacks`), so at most one clause fires
 * per role. Model strings pass through `escapeJsonString` (user-controlled
 * spec values in generated source); the breaker/tiers/pool blocks are
 * validated numbers/strings/closed-literal unions safe to `JSON.stringify`.
 * Empty when the role declares none, keeping pre-existing bundles
 * byte-identical. Mirror: target-cli + target-channel-bot + target-managed
 * render the same fields on their agent blocks — keep the four in sync.
 */
function renderRoleModelFailoverFields(role: IrCrewRole): string {
  const pieces: string[] = [];
  const fallbacks = role.modelFallbacks;
  if (fallbacks !== undefined && fallbacks.length > 0) {
    pieces.push(`\n    modelFallbacks: [${fallbacks.map((m) => escapeJsonString(m)).join(", ")}],`);
  }
  if (role.circuitBreaker !== undefined) {
    pieces.push(`\n    circuitBreaker: ${JSON.stringify(role.circuitBreaker)},`);
  }
  if (role.modelTiers !== undefined) {
    pieces.push(`\n    modelTiers: ${JSON.stringify(role.modelTiers)},`);
  }
  if (role.modelPool !== undefined) {
    pieces.push(`\n    modelPool: ${JSON.stringify(role.modelPool)},`);
  }
  return pieces.join("");
}

function renderRoleAgent(ir: IrCrewV0, role: IrCrewRole): string {
  const { imports, inits, registrations } = resolveTools(role.tools, role.toolConfigs);
  const hasSubAgents = role.subAgents.length > 0;
  // Section 13 (Batch A, G34) — the role's inline sub-agent definitions:
  // rendered as a Map for the Task tool (createTaskTool resolves
  // subagent_type against it) AND threaded onto the RoleDefinition so the
  // orchestrator forwards them to this role's runChatLoop bridge alongside
  // the daemon-injected spawnSubAgent.
  const subAgentImports = hasSubAgents
    ? [
        `import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";`,
        `import { createTaskTool } from "@crewhaus/tool-task";`,
      ]
    : [];
  const importBlock =
    imports.length > 0 || subAgentImports.length > 0
      ? `${[...subAgentImports, ...imports].join("\n")}\n`
      : "";
  const initLines = inits.length > 0 ? `${inits.join("\n")}\n` : "";
  const subAgentEntries = role.subAgents
    .map((d) => `  [${escapeJsonString(d.name)}, ${renderSubAgentDef(d)}],`)
    .join("\n");
  const subAgentBlock = hasSubAgents
    ? `const __subAgents: ReadonlyMap<string, SubAgentDefinition> = new Map<string, SubAgentDefinition>([
${subAgentEntries}
]);
`
    : "";
  const toolRegistrations = hasSubAgents
    ? [...registrations, "createTaskTool({ subAgents: __subAgents })"]
    : registrations;
  const toolsArrayLiteral =
    toolRegistrations.length > 0 ? `[${toolRegistrations.join(", ")}]` : "[]";
  const subAgentsField = hasSubAgents ? "\n    subAgents: __subAgents," : "";
  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, role: ${escapeJsonString(role.name)})
${importBlock}import type { RoleDefinition } from "@crewhaus/crew-orchestrator";

${initLines}${subAgentBlock}
export const role: { name: string; def: RoleDefinition } = {
  name: ${escapeJsonString(role.name)},
  def: {
    model: ${escapeJsonString(role.model)},
    instructions: ${escapeJsonString(role.instructions)},${renderRoleTuningFields(role)}${renderRoleModelFailoverFields(role)}
    tools: ${toolsArrayLiteral},${subAgentsField}
  },
};
`;
}

// ---------------------------------------------------------------------------
// File: orchestrator.ts — composes Crew() from roles + entry + routing.
// ---------------------------------------------------------------------------

/** Emit-time cap on the roster excerpt of each role's instructions inside
 *  the llm-router classify prompt — the classify turn must stay small. */
const LLM_ROUTER_DESCRIPTION_MAX_CHARS = 240;

/** Runtime cap (rendered into the bundle) on the finishing role's output
 *  fed to the classify turn. The TAIL is kept: routing signals ("DONE",
 *  "needs review", verdicts) conventionally close an output. */
const LLM_ROUTER_INPUT_MAX_CHARS = 2000;

function llmRouterDescription(instructions: string): string {
  return instructions.length > LLM_ROUTER_DESCRIPTION_MAX_CHARS
    ? `${instructions.slice(0, LLM_ROUTER_DESCRIPTION_MAX_CHARS)}…`
    : instructions;
}

/**
 * Loop contract 0.4 (Batch A, G08) — `routing.kind: "llm"`: render a
 * model-backed router into the generated orchestrator. One small
 * `runChatLoop` classify turn runs after every role_end: it sees the role
 * roster (names + emit-time-truncated instruction excerpts) plus the tail
 * of the finishing role's output and must answer with EXACTLY one role
 * name or DONE — the exact-token output contract is what keeps the
 * decision stable at any sampling temperature. DONE (or re-picking the
 * finishing role) terminates the crew; an unparseable reply falls back to
 * the entry role. The turn runs on the entry role's model in its own
 * session (`<name> (llm-router)`) so the crew transcript stays clean, and
 * it rides the run's session root + `_adapter` test seam via the
 * orchestrator's RouterArgs passthroughs.
 */
function renderLlmRouter(
  ir: IrCrewV0,
  entryRole: IrCrewRole,
): { prelude: string; routerBlock: string } {
  const rosterEntries = ir.roles
    .map(
      (r) =>
        `  { name: ${escapeJsonString(r.name)}, description: ${escapeJsonString(
          llmRouterDescription(r.instructions),
        )} },`,
    )
    .join("\n");
  const classifierInstructions =
    "You are the routing classifier for a multi-role agent crew. After a role finishes its turn you decide who acts next. Respond with EXACTLY one word: the name of the next role, or DONE when the crew's work is complete. No punctuation, no explanation — the exact-match contract keeps routing deterministic at any sampling temperature.";
  const prelude = `
// Loop contract 0.4 (Batch A, G08) — routing.kind "llm": the roster the
// classify turn picks from (name + an instructions excerpt truncated at
// compile time to keep the classify prompt small).
const __roleRoster: ReadonlyArray<{ name: string; description: string }> = [
${rosterEntries}
];
const __roleNames: ReadonlyArray<string> = __roleRoster.map((r) => r.name);

/**
 * Parse the classifier's reply into the next role. Priority ladder: exact
 * role-name match (quotes/punctuation stripped) → that role; exact DONE →
 * the finishing role (re-picking it terminates the crew); exactly one
 * roster name mentioned → that role; DONE mentioned → the finishing role;
 * anything else is unparseable and falls back to the entry role.
 */
function __pickNextRole(reply: string, lastRole: string): string {
  const text = reply.trim().toLowerCase();
  const exact = text.replace(/^["'\`\\s]+|["'\`.!\\s]+$/g, "");
  for (const name of __roleNames) {
    if (name.toLowerCase() === exact) return name;
  }
  if (exact === "done") return lastRole;
  const mentioned = __roleNames.filter((name) => text.includes(name.toLowerCase()));
  const only = mentioned[0];
  if (mentioned.length === 1 && only !== undefined) return only;
  if (/\\bdone\\b/.test(text)) return lastRole;
  return ${escapeJsonString(ir.entry)};
}
`;
  const routerBlock = `
  // Loop contract 0.4 (Batch A, G08) — model-backed routing: one small
  // classify turn per role_end picks the next role (see __pickNextRole for
  // the parse ladder). Temperature-stable by construction: exact-token
  // output contract + tail-anchored output excerpt.
  builder.setRouting(async ({ input, lastRole, sessionRootDir, _adapter }) => {
    if (lastRole === undefined) return ${escapeJsonString(ir.entry)};
    const roster = __roleRoster.map((r) => \`- \${r.name}: \${r.description}\`).join("\\n");
    const excerpt =
      input.length > ${LLM_ROUTER_INPUT_MAX_CHARS}
        ? \`…\${input.slice(-${LLM_ROUTER_INPUT_MAX_CHARS})}\`
        : input;
    const reply = await runChatLoop({
      model: ${escapeJsonString(entryRole.model)},
      instructions: ${escapeJsonString(classifierInstructions)},
      sessionName: ${escapeJsonString(`${ir.name} (llm-router)`)},
      sessionTarget: "crew",
      ...(sessionRootDir !== undefined ? { sessionRootDir } : {}),
      singleTurn: true,
      installSigintHandler: false,
      maxTokens: 128,
      seedMessages: [
        {
          role: "user",
          content: \`Roles:\\n\${roster}\\n\\nRole that just finished: \${lastRole}\\n\\nIts output:\\n\${excerpt}\\n\\nWhich role acts next? Answer with exactly one of: \${__roleNames.join(", ")}, or DONE.\`,
        },
      ],
      ...(_adapter !== undefined ? { _adapter } : {}),
    });
    return __pickNextRole(reply, lastRole);
  });`;
  return { prelude, routerBlock };
}

function renderOrchestrator(ir: IrCrewV0, entryRole: IrCrewRole): string {
  const roleImports = ir.roles
    .map((r) => `import { role as ${roleVar(r.name)} } from "./agent_${safeFileName(r.name)}.js";`)
    .join("\n");
  const adds = ir.roles
    .map((r) => `    .addRole(${roleVar(r.name)}.name, ${roleVar(r.name)}.def)`)
    .join("\n");

  let prelude = "";
  let routerBlock = "";
  let runtimeImport = "";
  if (ir.routing && ir.routing.kind === "match" && ir.routing.match !== undefined) {
    const tableLit = JSON.stringify(ir.routing.match, null, 2)
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n");
    routerBlock = `
  const __routingTable: Record<string, ReadonlyArray<{ contains: string; to: string }>> =
${tableLit};
  builder.setRouting(({ input, lastRole }) => {
    if (lastRole === undefined) return ${escapeJsonString(ir.entry)};
    const rules = __routingTable[lastRole] ?? [];
    for (const r of rules) {
      if (input.includes(r.contains)) return r.to;
    }
    return lastRole;
  });`;
  } else if (ir.routing && ir.routing.kind === "llm") {
    const llm = renderLlmRouter(ir, entryRole);
    prelude = llm.prelude;
    routerBlock = llm.routerBlock;
    runtimeImport = `import { runChatLoop } from "@crewhaus/runtime-core";\n`;
  }

  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, file: orchestrator.ts)
import { Crew, type RunnableCrew } from "@crewhaus/crew-orchestrator";
${runtimeImport}${roleImports}
${prelude}
export function buildCrew(): RunnableCrew {
  const builder = Crew()
    .setName(${escapeJsonString(ir.name)})
${adds}
    .setEntry(${escapeJsonString(ir.entry)});${routerBlock}
  return builder.compile();
}
`;
}

function roleVar(name: string): string {
  return `__role_${safeFileName(name)}`;
}

// ---------------------------------------------------------------------------
// File: daemon.ts — entrypoint. Reads stdin, drives the crew, prints events.
// ---------------------------------------------------------------------------

/**
 * v0.3.0 PR 11 — the crew shape's memory-fabric wiring state. `wired` when
 * the IR carries an enabled `memory` block and/or a `continuity` block
 * (DEFAULT-ON in 0.3.0 — only `continuity: false` removes it). Scope is
 * `spec`, shared by every role: the plan store IS the coordination surface
 * (§2.7); the tools/seams thread crew-wide through the orchestrator's
 * `extraTools`/`memory`/`continuity`/`skills` RunOptions.
 */
function memoryFabric(ir: IrCrewV0): { wired: boolean; fragmentJson: string } {
  const memoryOn = ir.memory !== undefined && ir.memory.enabled !== false;
  const continuityOn = ir.continuity !== undefined;
  const wired = memoryOn || continuityOn;
  const fragmentJson = wired
    ? JSON.stringify(
        memoryFragmentFromIr({
          name: ir.name,
          ...(memoryOn ? { memory: ir.memory } : {}),
          ...(continuityOn ? { continuity: ir.continuity } : {}),
          // v0.3.0 Goal 2 (PR 17) — learning rides the fragment: wireMemory
          // renders the learning-loop skill + gates in /study /reflect.
          ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
        }),
      )
    : "";
  return { wired, fragmentJson };
}

function renderDaemon(ir: IrCrewV0): string {
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permField = renderPermissionsField(ir);
  const taxonomyField = renderFailureTaxonomyField(ir);
  // Loop contract 0.4 (Batch A) — the new crew.run knobs.
  const crewCapsFields = renderCrewCapsFields(ir);
  const loopLimitsField = renderLoopLimitsField(ir);
  const budgetField = renderBudgetField(ir);
  const hooksField = renderHooksField(ir);
  const fabric = memoryFabric(ir);
  const mcp = renderMcpServers(ir);
  // Section 13 (Batch A, G34) — when any role declares sub-agents, inject
  // the spawner once at the run level; the orchestrator stamps it (plus the
  // per-role subAgents map) onto each role's runChatLoop bridge.
  const anySubAgents = ir.roles.some((r) => r.subAgents.length > 0);
  const spawnImport = anySubAgents
    ? `import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";\n`
    : "";
  const spawnField = anySubAgents ? "\n    spawnSubAgent," : "";
  // One tool-catalog import line serves both consumers: the MCP wire-once
  // catalog (value) and the memory fabric's collector typing (type).
  const toolCatalogImport =
    mcp.hasAny && fabric.wired
      ? `import { ToolCatalog, type RegisteredTool } from "@crewhaus/tool-catalog";\n`
      : mcp.hasAny
        ? `import { ToolCatalog } from "@crewhaus/tool-catalog";\n`
        : fabric.wired
          ? `import type { RegisteredTool } from "@crewhaus/tool-catalog";\n`
          : "";
  const mcpImport = mcp.hasAny ? `${mcp.imports.join("\n")}\n` : "";
  const memImport = fabric.wired
    ? `import { wireMemory } from "@crewhaus/memory-service";
import { createSkillTool } from "@crewhaus/skills-registry";
`
    : "";
  const memBoot = fabric.wired
    ? `
  // v0.3.0 — the memory fabric, wired ONCE through the stable composition-
  // root call (design §1 principle 1): roles share the spec-scoped stores;
  // the orchestrator threads the tools + seams into every role's turn.
  const __memTools: RegisteredTool[] = [];
  const __memWired = await wireMemory(${fabric.fragmentJson}, {
    catalog: { register: (t: RegisteredTool) => { __memTools.push(t); } },
    cwd: process.cwd(),
  });
  const __skills = __memWired.options.skills ?? [];
  if (__skills.length > 0) __memTools.push(createSkillTool(__skills));`
    : "";
  // Crew-wide extra tools: user-declared MCP tools first (explicit choices
  // win), then the memory fabric's.
  const extraToolsField =
    mcp.hasAny && fabric.wired
      ? "\n    extraTools: [...__mcpTools, ...__memTools],"
      : mcp.hasAny
        ? "\n    extraTools: __mcpTools,"
        : fabric.wired
          ? "\n    extraTools: __memTools,"
          : "";
  const memOptsFields = fabric.wired
    ? `
    ...(__memWired.options.memory !== undefined ? { memory: __memWired.options.memory } : {}),
    ...(__memWired.options.continuity !== undefined ? { continuity: __memWired.options.continuity } : {}),
    ...(__skills.length > 0 ? { skills: __skills } : {}),`
    : "";
  const mcpShutdownOk = mcp.hasAny ? "\n  await mcpHost.disconnectAll();" : "";
  const mcpShutdownErr = mcp.hasAny ? "\n    await mcpHost.disconnectAll().catch(() => {});" : "";
  // v0.3.0 Goal 3 — thredz is spec-carried on this shape but not emit-wired
  // in this release (the one-knob backend flip ships on cli). Surface it,
  // 0.2.3-style, so nobody wonders why their wiki stayed local.
  const thredzWarning =
    ir.thredz !== undefined
      ? "// note: thredz configured but ignored on crew in 0.3.0 — the Thredz backend flip is wired on the cli shape (design §4)\n"
      : "";
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, file: daemon.ts)
${thredzWarning}import { formatRunFailure, toFailureReport } from "@crewhaus/errors";
${permImport}${memImport}${mcpImport}${spawnImport}${toolCatalogImport}import { buildCrew } from "./orchestrator.js";

async function main(): Promise<void> {
  const crew = buildCrew();
  const input = await readAllStdin();
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    process.stderr.write("[crew] no input on stdin\\n");
    process.exit(2);
  }${mcp.bootBlock}${memBoot}
  const opts: Parameters<typeof crew.run>[1] = {${permField}${taxonomyField}${crewCapsFields}${loopLimitsField}${budgetField}${hooksField}${spawnField}${extraToolsField}${memOptsFields}
  };
  let lastFinalOutput = "";
  try {
    for await (const ev of crew.run(trimmed, opts)) {
      process.stdout.write(\`\${JSON.stringify(ev)}\\n\`);
      if (ev.kind === "crew_done") lastFinalOutput = ev.finalOutput;
    }
  } catch (err) {
    // v0.3.0 Goal 6 — render the one structured failure report (classified
    // for a RunFailedError, generic otherwise) and exit with its coded
    // status instead of the bare "[crew] error:" line + exit 1.
    const __report = toFailureReport(err);
    process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[crew]" })}\\n\`);${mcpShutdownErr}
    process.exit(__report.exitCode);
  }${mcpShutdownOk}
  if (lastFinalOutput.length > 0) {
    const PREVIEW_LIMIT = 200;
    const preview =
      lastFinalOutput.length > PREVIEW_LIMIT
        ? \`\${lastFinalOutput.slice(0, PREVIEW_LIMIT)}… [preview truncated; full output (\${lastFinalOutput.length} chars) is on stdout in the crew_done event]\`
        : lastFinalOutput;
    process.stderr.write(\`[crew] final: \${preview}\\n\`);
  }
}

async function readAllStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

main().catch((err) => {
  // v0.3.0 Goal 6 — no unhandled Bun stack: same report, coded exit.
  const __report = toFailureReport(err);
  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[crew]" })}\\n\`);
  process.exit(__report.exitCode);
});
`;
}
