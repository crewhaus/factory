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
import {
  renderControlDrain,
  renderControlImports,
  renderControlPlaneBoot,
  renderControlStart,
} from "@crewhaus/gateway-protocol/control-codegen";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrCrewRole,
  type IrCrewV0,
  type IrMcpServerConfig,
  renderBundleReadme,
} from "@crewhaus/ir";
import { memoryFragmentFromIr } from "@crewhaus/memory-service";
import { renderModelWiringFields, renderSubAgentDef } from "@crewhaus/model-service";

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

/**
 * Evals Wave 4, cluster S (D36 + NEW-shape-1) — `emitCrew` options.
 * `evalEntry: true` (set only by `crewhaus compile --with-eval-harness`)
 * additionally emits an `eval-entry.ts` file exporting
 * `runForEval(input, opts)`: one crew run through the SAME compiled
 * orchestrator + role definitions, with the SAME run options the daemon
 * assembles (permissions/taxonomy/caps/limits/budget/hooks/MCP/memory),
 * minus the stdin/stdout framing — the `crew_done` finalOutput is returned
 * for grading. Purely ADDITIVE: the existing daemon/orchestrator/role files
 * stay byte-identical with or without the option.
 */
export type EmitCrewOptions = EmitReadmeOptions & { readonly evalEntry?: boolean };

export function emitCrew(ir: IrCrewV0, opts: EmitCrewOptions = {}): Bundle {
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
  if (opts.evalEntry === true) {
    files.push({ path: "eval-entry.ts", content: renderEvalEntry(ir) });
  }
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
 * Loop contract 0.4 (Batch C, G11) — the `askMode` + `approvals` crew
 * RunOptions fields (the orchestrator forwards both to every role turn,
 * primary activations and inline A2A peer turns alike). Unlike the CLI's
 * `approvalRunOptions`, a bundle parses no `--ask-mode`, so the spec value is
 * FIXED here at emit time.
 *
 * Deliberately NOT folded into {@link renderPermissionsField}: that renderer
 * early-returns "" when the spec declares neither a mode nor rules — which is
 * exactly the bundle where parking matters MOST, because with no block every
 * unmatched tool resolves to `ask`. So this one is unconditional, including
 * under `"deny"` where it never parks: runtime-core picks its denial wording
 * by testing `approvals === undefined`, so handing it the store lets it
 * honestly report `ask_mode: "deny"` instead of blaming absent plumbing.
 */
function renderApprovalFields(ir: IrCrewV0, indent: string): string {
  return (
    `\n${indent}askMode: ${escapeJsonString(ir.permissions.askMode ?? "pause")},` +
    `\n${indent}approvals: { store: __approvals, surface: "crew" },`
  );
}

/**
 * G11 — the park store the fields above reference, emitted unconditionally
 * into every file that assembles `crew.run` opts. Constructing it does no I/O;
 * the first write happens at a park.
 *
 * `rootArg` is what the file can offer `resolveSessionRootDir`: the daemon has
 * nothing (`undefined` → tenant root, else `CREWHAUS_SESSION_DIR`, else the
 * store's own default), while the eval bridge passes its caller's per-sample
 * directory so a parked sample's record — which embeds the raw tool input —
 * lands in that sample's artifacts instead of the operator's working tree.
 */
function renderApprovalStoreBoot(rootArg: string, indent = ""): string {
  return `
${indent}// G11 — a compiled bundle is NON-INTERACTIVE: a tool that lands on \`ask\`
${indent}// has nobody to prompt, so without this it collapsed to a deny. Rooted
${indent}// where the run's session files land, so parks live beside them (and
${indent}// inside a tenant's rebased root when one is active). No I/O until a park.
${indent}const __approvalRoot = resolveSessionRootDir(${rootArg});
${indent}const __approvals = createPendingApprovalStore(
${indent}  __approvalRoot !== undefined ? { rootDir: __approvalRoot } : {},
${indent});
`;
}

/** The store's imports. A SEPARATE line from any other runtime-core import
 *  the file may already carry — duplicate specifiers are already normal in
 *  emitted output, and one dedicated line keeps exact-import-line assertions
 *  (and diffs) stable. */
const APPROVAL_STORE_IMPORT = `import { createPendingApprovalStore, resolveSessionRootDir } from "@crewhaus/runtime-core";\n`;

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
/** The `mcp_servers` keys that carry a synthesized Thredz server for this
 *  crew: the crew-wide `"thredz"` plus one `"thredz-<slug>"` per role that
 *  owns its own key. They are spawned on the shared host but deliberately
 *  kept OUT of the namespaced `registerMcpServer` pass — their tools are
 *  registered as BARE names into per-role catalogs by `connectThredz`, which
 *  is what makes `wiki_write` mean "my wiki" to each role. Namespacing them
 *  too would double-register the whole vocabulary as `thredz__wiki_write`. */
function thredzServerNames(ir: IrCrewV0): ReadonlySet<string> {
  const names = new Set<string>();
  for (const role of ir.roles) if (role.thredzServer !== undefined) names.add(role.thredzServer);
  return names;
}

function renderMcpServers(ir: IrCrewV0): {
  imports: string[];
  bootBlock: string;
  hasAny: boolean;
} {
  const thredzNames = thredzServerNames(ir);
  const entries = Object.entries(ir.mcp_servers).filter(([name]) => !thredzNames.has(name));
  if (entries.length === 0) {
    return { imports: [], bootBlock: "", hasAny: false };
  }
  // #406 — servers the spec marked `required: false` degrade at boot instead
  // of exiting. The crew's tool list (`__mcpTools`) is frozen at wire-once
  // boot, so the optional path is degrade-only (`retry: false`): tools absent
  // until restart, no background banner mid-run.
  const requiredEntries = entries.filter(([, cfg]) => cfg.required !== false);
  const optionalEntries = entries.filter(([, cfg]) => cfg.required === false);
  const imports = [
    `import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";`,
    `import { ${[
      ...(requiredEntries.length > 0 ? ["registerMcpServer"] : []),
      ...(optionalEntries.length > 0 ? ["registerOptionalMcpServer"] : []),
    ].join(", ")} } from "@crewhaus/tool-mcp";`,
  ];
  // Optional entries are NOT added here: their config resolution + addServer
  // run inside registerOptionalMcpServer's never-throw boundary (an unset env
  // var on an optional peer must degrade, not kill the boot).
  const addLines = requiredEntries
    .map(
      ([name, cfg]) =>
        `  mcpHost.addServer(${escapeJsonString(name)}, resolveMcpServerConfig(${JSON.stringify(cfg)}, { name: ${escapeJsonString(name)} }));`,
    )
    .join("\n");
  const registerLines = requiredEntries
    .map(
      ([name]) =>
        `    registerMcpServer(mcpHost, ${escapeJsonString(name)}, __mcpCatalog, { onRegister: ({ fullName }) => process.stderr.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  const optionalLines = optionalEntries
    .map(([name, cfg]) => {
      // The wire config only — `required` is an EMIT-time decision (which
      // registration call), not something mcp-host's config knows.
      const { required: _requiredFlag, ...wireCfg } = cfg as IrMcpServerConfig & {
        required?: false;
      };
      return `\n  await registerOptionalMcpServer(mcpHost, ${escapeJsonString(name)}, __mcpCatalog, { retry: false, config: () => resolveMcpServerConfig(${JSON.stringify(wireCfg)}, { name: ${escapeJsonString(name)} }), log: (line) => process.stderr.write(line), onRegister: ({ fullName }) => process.stderr.write(\`[mcp] registered \${fullName}\\n\`) }).firstAttempt;`;
    })
    .join("");
  const registerBlock =
    requiredEntries.length > 0
      ? `
  await Promise.all([
${registerLines}
  ]);`
      : "";
  const bootBlock = `
  // Loop contract 0.4 (Batch A, G05) — MCP servers, wired ONCE: every
  // role's turns see the remote tools through the orchestrator's crew-wide
  // extraTools; the daemon disconnects the shared host on shutdown.
  const mcpHost = new McpHost();
${addLines}
  const __mcpCatalog = new ToolCatalog();${registerBlock}${optionalLines}
  const __mcpTools = __mcpCatalog.list();`;
  return { imports, bootBlock, hasAny: true };
}

// ---------------------------------------------------------------------------
// File: agent_<role>.ts — exports the role's RoleDefinition.
// ---------------------------------------------------------------------------

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
  // 0.6.0 §4.1 — role-level sampling temperature (a validated number); the
  // orchestrator forwards it to the role's turns like `thinking`.
  if (role.temperature !== undefined) {
    pieces.push(`\n    temperature: ${role.temperature},`);
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
  // Loop contract 0.4 (Batch G, item 9 / G37) + 0.6.0 PR 3 (design §7.7) —
  // the role's model-routing quartet (`modelFallbacks` / `circuitBreaker` /
  // `modelTiers` / `modelPool`) lands on the `RoleDefinition` literal, rendered
  // by `@crewhaus/model-service`'s `renderModelWiringFields` (the one renderer
  // every emitter shares). `RoleDefinition` types the four fields by indexing
  // runtime-core's `RunChatLoopOptions`, so the literal is checked against
  // what the loop accepts, and `composeLoopTuning` spreads them into every
  // activation of this role. The field NAMES are the contract with the
  // orchestrator — a rename on either side must move both.
  // 0.6.0 §4.2 / §7.7 (PR 7b): `modelPool` is the WIDENED `IrModelPool`,
  // carried whole — every per-candidate profile setting, the hybrid siblings
  // and a declared `scope` reach the literal verbatim; the orchestrator's
  // `RoleModelPool` accepts that shape (pinned in `@crewhaus/compiler`) and
  // stamps `scope` with the role name at runtime when the spec declared none.
  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, role: ${escapeJsonString(role.name)})
${importBlock}import type { RoleDefinition } from "@crewhaus/crew-orchestrator";

${initLines}${subAgentBlock}
export const role: { name: string; def: RoleDefinition } = {
  name: ${escapeJsonString(role.name)},
  def: {
    model: ${escapeJsonString(role.model)},
    instructions: ${escapeJsonString(role.instructions)},${renderRoleTuningFields(role)}${renderModelWiringFields(role, "    ")}
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
 * the entry role. The turn runs on `routing.model` — 0.6.0 §7.7, the
 * router's own slot (a `$profile` resolves at lower time, `IrCrewRouting.
 * model`) — or, when the spec names none, on the entry role's model, the
 * byte-identical pre-0.6.0 default. It runs in its own session
 * (`<name> (llm-router)`) so the crew transcript stays clean, and it rides
 * the run's session root + `_adapter` test seam via the orchestrator's
 * RouterArgs passthroughs.
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
      model: ${escapeJsonString(ir.routing?.model ?? entryRole.model)},
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
  // 0.5.0 — AMENDS the crew-wide scope stated above: when any role carries its
  // own Thredz config, the WIKI stops being crew-wide. Each role gets its own,
  // scoped to its own space, and the crew-wide fabric must not also register
  // the ten LOCAL wiki twins — a role's tool array would then carry both, and
  // duplicate names in the array advertised to the provider are a 400.
  // Facts, continuity, plan and skills stay crew-wide and local.
  const perRoleWiki = ir.roles.some((r) => r.thredz !== undefined);
  const crewMemory =
    memoryOn && perRoleWiki && ir.memory !== undefined
      ? (({ wiki: _perRole, ...rest }) => rest)(ir.memory)
      : ir.memory;
  const fragmentJson = wired
    ? JSON.stringify(
        memoryFragmentFromIr({
          name: ir.name,
          ...(memoryOn ? { memory: crewMemory } : {}),
          ...(continuityOn ? { continuity: ir.continuity } : {}),
          // v0.3.0 Goal 2 (PR 17) — learning rides the fragment: wireMemory
          // renders the learning-loop skill + gates in /study /reflect.
          ...(ir.learning !== undefined ? { learning: ir.learning } : {}),
        }),
      )
    : "";
  return { wired, fragmentJson };
}

/**
 * 0.5.0 — the per-role Thredz boot. One `addServer` + one `ToolCatalog` +
 * one `connectThredz` + one `wireWiki` per role that carries a config.
 *
 * The catalog is per role ON PURPOSE: `registerMcpToolAliases` throws on a
 * bare-name collision within the catalog it is handed, so two roles could not
 * both own `wiki_write` in one catalog. A catalog is a boot-time composition
 * device — one Map plus N registrations — and `runChatLoop` never sees one, so
 * this costs essentially nothing and lets every role keep the BARE vocabulary
 * that five prompt sites and four policy surfaces match verbatim.
 */
function renderRoleThredz(ir: IrCrewV0): {
  imports: string[];
  bootBlock: string;
  roleExtraToolsField: string;
  roleMemoryField: string;
  hasAny: boolean;
} {
  const roles = ir.roles.filter((r) => r.thredz !== undefined && r.thredzServer !== undefined);
  if (roles.length === 0) {
    return {
      imports: [],
      bootBlock: "",
      roleExtraToolsField: "",
      roleMemoryField: "",
      hasAny: false,
    };
  }
  // Distinct servers: roles sharing the crew default share one npx process.
  const servers = new Map<string, IrCrewRole>();
  for (const r of roles)
    if (!servers.has(r.thredzServer as string)) servers.set(r.thredzServer as string, r);

  const ident = (role: string) => role.replace(/[^A-Za-z0-9]/g, "_");
  const addLines = [...servers].map(
    ([name, r]) => `  try {
    mcpHost.addServer(${escapeJsonString(name)}, resolveMcpServerConfig(${JSON.stringify(
      synthesizedThredzServerFor(ir, name),
    )}, { name: ${escapeJsonString(name)} }));
  } catch (__err) {
    const __report = toFailureReport(__err);
    process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[crew]" })}\\n\`);
    process.exit(__report.exitCode);
  }`,
  );
  const connectLines = [...servers].map(([name, r]) => {
    const id = ident(name);
    const agent = r.thredz?.agentName;
    // Item 5 (G44) / #401 — per-role messaging opt-in. A crew role that owns
    // its own Thredz key is exactly the case A2A messaging exists for, and
    // the flag is per-role because the keys are.
    const messaging = r.thredz?.messaging === true;
    return `  const __thredzCat_${id} = new ToolCatalog();
  const __thredz_${id} = await connectThredz(mcpHost, __thredzCat_${id}, {
    serverName: ${escapeJsonString(name)},${
      agent !== undefined ? `\n    agentName: ${escapeJsonString(agent)},` : ""
    }${messaging ? "\n    messaging: true," : ""}
    log: (line) => process.stderr.write(line),
  });`;
  });
  // Per-role wiki seam. With a live connection wireWiki returns
  // { store: null, tools: [] } plus a client-bound recall; on the degrade it
  // returns the ten LOCAL tools — so exactly one of the two arrays is
  // non-empty per role, and both are safe to concatenate.
  const wikiLines = roles.map((r) => {
    const id = ident(r.name);
    const server = ident(r.thredzServer as string);
    return `  const __wiki_${id} = wireWiki(${JSON.stringify({
      specName: ir.name,
      ...(ir.memory !== undefined ? { memory: ir.memory } : {}),
      thredz: r.thredz,
    })}, { catalog: { register: () => {} }, cwd: process.cwd(), thredz: __thredz_${server} });`;
  });
  const recallK = ir.memory?.wiki?.recallK ?? 5;
  const roleExtraToolsField = `\n    roleExtraTools: {${roles
    .map(
      (r) =>
        `\n      ${escapeJsonString(r.name)}: [...__thredzCat_${ident(
          r.thredzServer as string,
        )}.list(), ...(__wiki_${ident(r.name)}?.tools ?? [])],`,
    )
    .join("")}\n    },`;
  const roleMemoryField = `\n    roleMemory: {${roles
    .map(
      (r) =>
        `\n      ${escapeJsonString(r.name)}: foldWikiRecall(__memWired?.options.memory, __wiki_${ident(
          r.name,
        )}, ${recallK}),`,
    )
    .join("")}\n    },`;
  // The Thredz servers ride the SHARED McpHost. When the crew declares no
  // user MCP servers, `renderMcpServers` emits nothing — so this block owns
  // the host declaration and its imports instead.
  const ownsHost = Object.keys(ir.mcp_servers).every((n) => servers.has(n));
  return {
    imports: [
      `import { connectThredz, wireWiki, foldWikiRecall } from "@crewhaus/memory-service";`,
      ...(ownsHost
        ? [`import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";`]
        : []),
    ],
    bootBlock: `
  // 0.5.0 — per-role Thredz. One key owns one private wiki space and
  // thredz-mcp reads one key per process, so per-role private memory is one
  // spawned server per role. Each role's vocabulary lands in its OWN catalog.${
    ownsHost ? "\n  const mcpHost = new McpHost();" : ""
  }
${addLines.join("\n")}
${connectLines.join("\n")}
${wikiLines.join("\n")}`,
    roleExtraToolsField,
    roleMemoryField,
    hasAny: true,
  };
}

/** The synthesized server config the compiler put in `ir.mcp_servers`. */
function synthesizedThredzServerFor(ir: IrCrewV0, name: string): unknown {
  const cfg = ir.mcp_servers[name];
  if (cfg === undefined) throw new Error(`crew emitter: no mcp_servers entry for ${name}`);
  return cfg;
}

function renderDaemon(ir: IrCrewV0): string {
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permField = renderPermissionsField(ir);
  const approvalFields = renderApprovalFields(ir, "    ");
  const taxonomyField = renderFailureTaxonomyField(ir);
  // Loop contract 0.4 (Batch A) — the new crew.run knobs.
  const crewCapsFields = renderCrewCapsFields(ir);
  const loopLimitsField = renderLoopLimitsField(ir);
  const budgetField = renderBudgetField(ir);
  const hooksField = renderHooksField(ir);
  const fabric = memoryFabric(ir);
  const mcp = renderMcpServers(ir);
  // 0.5.0 — per-role Thredz servers, catalogs and wiki seams.
  const roleThredz = renderRoleThredz(ir);
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
  const mcpImport = `${[...(mcp.hasAny ? mcp.imports : []), ...roleThredz.imports].join("\n")}${
    mcp.hasAny || roleThredz.hasAny ? "\n" : ""
  }`;
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
  // The host is shared by user MCP servers and the per-role Thredz servers —
  // disconnect it if EITHER put something on it, or N npx children outlive the
  // run.
  const hostLive = mcp.hasAny || roleThredz.hasAny;
  const mcpShutdownOk = hostLive ? "\n  await mcpHost.disconnectAll();" : "";
  const mcpShutdownErr = hostLive ? "\n    await mcpHost.disconnectAll().catch(() => {});" : "";
  // 0.5.0 — thredz is EMIT-WIRED on crew. A crew whose roles each carry their
  // own key gets one server, one space and one vocabulary per role; roles that
  // share the crew-wide block share one brain. Nothing is ignored any more.
  const thredzWarning = "";
  // crewhaus.control.v1, from the shared gateway-protocol renderers. The crew
  // daemon is a ONE-SHOT: it consumes stdin, runs the crew and exits, so it
  // arms no pokeable lane — `/control/v1/wake` answers 404 lane_not_armed.
  // What control.v1 gives an operator here is a uniform way to observe the run
  // (`/status`: turns + pid + startedAt) and to ask it to stop taking new work
  // and finish (`/drain`), on exactly the same surface the long-running shapes
  // serve.
  const controlPlaneBoot = renderControlPlaneBoot({
    name: ir.name,
    target: "crew",
    indent: "  ",
    auditLogExpr: "__controlAudit",
  });
  const controlDrain = renderControlDrain({
    indent: "  ",
    body: `process.stderr.write("[crew] draining — finishing the in-flight run\\n");
while (__crewRunning) await new Promise((__r) => setTimeout(__r, 100));`,
  });
  const controlStart = renderControlStart({ indent: "  " });
  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, file: daemon.ts)
${thredzWarning}import { openAuditLog } from "@crewhaus/audit-log";
import { formatRunFailure, toFailureReport } from "@crewhaus/errors";
${renderControlImports()}${APPROVAL_STORE_IMPORT}${permImport}${memImport}${mcpImport}${spawnImport}${toolCatalogImport}import { buildCrew } from "./orchestrator.js";
${renderApprovalStoreBoot("undefined")}
let __crewRunning = false;

async function main(): Promise<void> {
  // control.v1 — the harness-wide hash-chained audit log every control call
  // appends a \`gateway_request\` record to. CREWHAUS_SECURITY_AUDIT=0 opts out.
  const __controlAudit =
    process.env["CREWHAUS_SECURITY_AUDIT"] === "0"
      ? undefined
      : await openAuditLog({ rootDir: \`\${process.cwd()}/.crewhaus/audit\` });
${controlPlaneBoot}${controlDrain}${controlStart}  const crew = buildCrew();
  const input = await readAllStdin();
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    // Say what to do, not just what happened. A supervisor that spawned this
    // with no stdin used to read the bare exit 2 as a crash and restart it,
    // and the operator's only clue was this line in a log.
    process.stderr.write(
      "[crew] no input on stdin — a crew bundle reads its BRIEF there.\\n" +
        "[crew] run it with \`bun daemon.ts < brief.md\`, or under supervision with\\n" +
        "[crew] \`crewhaus daemon submit <harness-dir> --brief-file brief.md\`.\\n",
    );
    process.exit(2);
  }${mcp.bootBlock}${roleThredz.bootBlock}${memBoot}
  const opts: Parameters<typeof crew.run>[1] = {${permField}${approvalFields}${taxonomyField}${crewCapsFields}${loopLimitsField}${budgetField}${hooksField}${spawnField}${extraToolsField}${roleThredz.roleExtraToolsField}${roleThredz.roleMemoryField}${memOptsFields}
  };
  let lastFinalOutput = "";
  __crewRunning = true;
  try {
    for await (const ev of crew.run(trimmed, opts)) {
      process.stdout.write(\`\${JSON.stringify(ev)}\\n\`);
      if (ev.kind === "crew_done") {
        lastFinalOutput = ev.finalOutput;
        __control.counters.turns++;
      }
    }
  } catch (err) {
    // v0.3.0 Goal 6 — render the one structured failure report (classified
    // for a RunFailedError, generic otherwise) and exit with its coded
    // status instead of the bare "[crew] error:" line + exit 1.
    const __report = toFailureReport(err);
    process.stderr.write(\`\${formatRunFailure(__report, { prefix: "[crew]" })}\\n\`);${mcpShutdownErr}
    __crewRunning = false;
    process.exit(__report.exitCode);
  }${mcpShutdownOk}
  __crewRunning = false;
  await __control.stop();
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

// ---------------------------------------------------------------------------
// File (cluster S, D36/NEW-shape-1): eval-entry.ts — the eval bridge's
// runtime entry. Emitted ONLY under `emitCrew(ir, { evalEntry: true })`.
// ---------------------------------------------------------------------------

/**
 * Render `eval-entry.ts`: one crew run through the compiled orchestrator +
 * roles, assembled with the SAME renderers the daemon uses (so the two run-
 * option sets can never drift), minus the stdin/stdout framing. Each eval
 * sample is one crew run; the `crew_done` finalOutput is the graded output.
 * The runner's per-sample `sessionId`/`sessionRootDir` thread into the crew's
 * own session machinery so the crew transcript lands in the sample artifacts
 * (crew trace events stay on the orchestrator's internal bus in this slice —
 * `crew.run` mints its own RunContext).
 */
function renderEvalEntry(ir: IrCrewV0): string {
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permField = renderPermissionsField(ir);
  const approvalFields = renderApprovalFields(ir, "    ");
  const taxonomyField = renderFailureTaxonomyField(ir);
  const crewCapsFields = renderCrewCapsFields(ir);
  const loopLimitsField = renderLoopLimitsField(ir);
  const budgetField = renderBudgetField(ir);
  const hooksField = renderHooksField(ir);
  const fabric = memoryFabric(ir);
  const mcp = renderMcpServers(ir);
  const anySubAgents = ir.roles.some((r) => r.subAgents.length > 0);
  const spawnImport = anySubAgents
    ? `import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";\n`
    : "";
  const spawnField = anySubAgents ? "\n    spawnSubAgent," : "";
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
  //
  // Cluster S (D36/NEW-shape-1) — the fabric roots at the caller's per-sample
  // directory when one is supplied, so a bridged eval keeps the Pillar-2
  // isolation invariant: sample N's facts/plan/handoff never leak into sample
  // N+1, and nothing is written into the operator's working tree.
  const __memTools: RegisteredTool[] = [];
  const __memWired = await wireMemory(${fabric.fragmentJson}, {
    catalog: { register: (t: RegisteredTool) => { __memTools.push(t); } },
    cwd: __evalOpts.sessionRootDir ?? process.cwd(),
  });
  const __skills = __memWired.options.skills ?? [];
  if (__skills.length > 0) __memTools.push(createSkillTool(__skills));`
    : "";
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
  const runBlock = mcp.hasAny
    ? `  let __final = "";
  try {
    for await (const ev of crew.run(input, opts)) {
      if (ev.kind === "crew_done") __final = ev.finalOutput;
    }
  } finally {
    await mcpHost.disconnectAll().catch(() => {});
  }
  return __final;`
    : `  let __final = "";
  for await (const ev of crew.run(input, opts)) {
    if (ev.kind === "crew_done") __final = ev.finalOutput;
  }
  return __final;`;
  return `// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: crew, ir version: ${ir.version}, file: eval-entry.ts — the compile --with-eval-harness bridge entry)
${APPROVAL_STORE_IMPORT}${permImport}${memImport}${mcpImport}${spawnImport}${toolCatalogImport}import { buildCrew } from "./orchestrator.js";

type __CrewRunOpts = NonNullable<Parameters<ReturnType<typeof buildCrew>["run"]>[1]>;

/**
 * Eval bridge (cluster S, D36/NEW-shape-1) — run ONE crew turn through the
 * compiled orchestrator + role definitions with the SAME run options the
 * daemon assembles, minus the stdin/stdout framing. Each eval sample is one
 * crew run; the crew_done finalOutput is the graded output. \`sessionId\` /
 * \`sessionRootDir\` thread into the crew's own session machinery so the crew
 * transcript lands in the caller's per-sample directory; \`_adapter\` is the
 * scripted-provider test seam every role turn shares.
 */
export async function runForEval(
  input: string,
  __evalOpts: {
    sessionId?: string;
    sessionRootDir?: string;
    _adapter?: __CrewRunOpts["_adapter"];
  } = {},
): Promise<string> {
  const crew = buildCrew();${renderApprovalStoreBoot("__evalOpts.sessionRootDir", "  ")}${mcp.bootBlock}${memBoot}
  const opts: __CrewRunOpts = {${permField}${approvalFields}${taxonomyField}${crewCapsFields}${loopLimitsField}${budgetField}${hooksField}${spawnField}${extraToolsField}${memOptsFields}
    ...(__evalOpts.sessionId !== undefined ? { sessionId: __evalOpts.sessionId } : {}),
    ...(__evalOpts.sessionRootDir !== undefined ? { sessionRootDir: __evalOpts.sessionRootDir } : {}),
    ...(__evalOpts._adapter !== undefined ? { _adapter: __evalOpts._adapter } : {}),
  };
${runBlock}
}
`;
}
