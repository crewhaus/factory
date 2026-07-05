import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrSubAgentDefinition,
  type IrV0,
  renderBundleReadme,
} from "@crewhaus/ir";

/**
 * Emit a self-contained CLI agent bundle for a CLI-target IR.
 * Slice scope: a single agent.ts that imports @crewhaus/runtime-core and
 * runs a streaming chat loop with the configured model and instructions.
 *
 * Tool support (Section 2): when ir.tools is non-empty, the emitted agent
 * imports each tool from its built-in package, registers them on the default
 * catalog, and threads catalog.list() into runChatLoop. Unknown tool names
 * fail at compile time via TargetEmitError.
 *
 * Future expansion (per catalog F2 target-cli-bundle): hooks, MCP config,
 * settings.json, multi-file output, bundling for distribution.
 */
export function emitCli(ir: IrV0, opts: EmitReadmeOptions = {}): Bundle {
  const files = [
    {
      path: "agent.ts",
      content: renderAgent(ir),
    },
  ];
  // Item 42 — generated bundle README (name/target/model, tool table, MCP
  // servers, required env vars, launch snippet). Default ON; `crewhaus
  // compile --no-readme` threads `readme: false` through here.
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
 * Built-in tool name → package + export. Section 2 seeds this with every
 * Section-3 tool so the convention is documented; the actual packages ship
 * incrementally (currently none — generated agents that reference these
 * names will fail at install time until Section 3 lands).
 *
 * Mirror: `loadToolMap()` in apps/cli/src/index.ts maps the same names to
 * RegisteredTool instances for `crewhaus run`. Keep both maps in sync.
 */
/**
 * Section 14 — `initSymbol` is the name of an exported function in the
 * tool's package that takes a config blob and registers it for the tool
 * to read at execute time (e.g. `registerFetchConfig({ allowed_origins })`).
 * Codegen emits the call before `defaultCatalog.register(...)` when the
 * IR's `toolConfigs` map has a value for the tool.
 */
type BuiltinToolEntry = {
  readonly package: string;
  readonly export: string;
  readonly initSymbol?: string;
};

export const BUILTIN_TOOL_MAP: Record<string, BuiltinToolEntry> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  // Background-shell companions to `bash` (Claude-Code-style long-running
  // tasks): poll a detached command's output / stop it. Opt-in like any tool.
  bashOutput: { package: "@crewhaus/tool-bash", export: "bashOutput" },
  killShell: { package: "@crewhaus/tool-bash", export: "killShell" },
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
  python: {
    package: "@crewhaus/tool-code-execution",
    export: "python",
    initSymbol: "registerCodeExecutionConfig",
  },
  javascript: {
    package: "@crewhaus/tool-code-execution",
    export: "javascript",
    initSymbol: "registerCodeExecutionConfig",
  },
  shell: {
    package: "@crewhaus/tool-code-execution",
    export: "shell",
    initSymbol: "registerCodeExecutionConfig",
  },
  // M4.1 — image generation (DALL-E / Replicate / mock for offline).
  imageGenerate: {
    package: "@crewhaus/tool-image-generation",
    export: "imageGenerate",
    initSymbol: "registerImageGenerationConfig",
  },
  // M4.3 — document ingest (txt/md/csv/json out of the box; PDF/docx
  // via operator-registered parsers).
  ingestDocument: {
    package: "@crewhaus/tool-document-ingest",
    export: "ingestDocument",
  },
  // Pillar 2 — AST-aware code intelligence (recipe 54).
  codegraphSearch: { package: "@crewhaus/tool-codegraph", export: "codegraphSearch" },
  codegraphCallers: { package: "@crewhaus/tool-codegraph", export: "codegraphCallers" },
  codegraphCallees: { package: "@crewhaus/tool-codegraph", export: "codegraphCallees" },
  codegraphImpact: { package: "@crewhaus/tool-codegraph", export: "codegraphImpact" },
};

function resolveTools(
  toolNames: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): {
  imports: string[];
  inits: string[];
  registrations: string[];
} {
  if (toolNames.length === 0) return { imports: [], inits: [], registrations: [] };

  // Group exports + inits by package for one grouped import per package.
  const byPackage = new Map<string, Set<string>>();
  const registrations: string[] = [];
  const inits: string[] = [];
  // Section 18 — when several tools share an `initSymbol` (e.g.
  // python/javascript/shell all calling `registerCodeExecutionConfig`),
  // emit the init exactly once. We honor a `tool_config.codeExecution`
  // (or the first per-tool config we encounter) for the shared symbol.
  const initEmitted = new Set<string>();
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
      const cfg =
        toolConfigs[name] ?? toolConfigs["codeExecution"] ?? toolConfigs["code_execution"];
      if (cfg !== undefined && !initEmitted.has(entry.initSymbol)) {
        set.add(entry.initSymbol);
        inits.push(`${entry.initSymbol}(${JSON.stringify(cfg)});`);
        initEmitted.add(entry.initSymbol);
      } else if (cfg !== undefined) {
        // ensure the symbol is imported even when init was emitted earlier
        set.add(entry.initSymbol);
      }
    }
    registrations.push(`defaultCatalog.register(${entry.export});`);
  }

  const imports: string[] = [`import { defaultCatalog } from "@crewhaus/tool-catalog";`];
  for (const pkg of [...byPackage.keys()].sort()) {
    const symbols = [...(byPackage.get(pkg) ?? new Set<string>())].sort();
    imports.push(`import { ${symbols.join(", ")} } from "${pkg}";`);
  }
  return { imports, inits, registrations };
}

function renderPermissionsField(ir: IrV0): string {
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
 * Section 9 — emit `McpHost` boot block when the IR carries mcp_servers.
 * Returns three optional pieces: imports (added to the top of the file),
 * a boot block that constructs the host + registers each server (placed
 * before runChatLoop), and a cleanup statement (run inside a finally).
 *
 * Empty `mcp_servers` returns empty strings so spec files without MCP get
 * the original bare `await runChatLoop(...)` shape (regression guard for
 * the hello-cli example).
 */
function renderMcpServers(ir: IrV0): {
  imports: string[];
  bootBlock: string;
  cleanupBlock: string;
  hasAny: boolean;
} {
  const entries = Object.entries(ir.mcp_servers);
  if (entries.length === 0) {
    return { imports: [], bootBlock: "", cleanupBlock: "", hasAny: false };
  }
  const imports = [
    `import { McpHost } from "@crewhaus/mcp-host";`,
    `import { registerMcpServer } from "@crewhaus/tool-mcp";`,
  ];
  const addLines = entries
    .map(([name, cfg]) => `mcpHost.addServer(${escapeJsonString(name)}, ${JSON.stringify(cfg)});`)
    .join("\n");
  const registerLines = entries
    .map(
      ([name]) =>
        `  registerMcpServer(mcpHost, ${escapeJsonString(name)}, defaultCatalog, { onRegister: ({ fullName }) => process.stdout.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  const bootBlock = [
    "const mcpHost = new McpHost();",
    addLines,
    "await Promise.all([",
    registerLines,
    "]);",
  ].join("\n");
  return {
    imports,
    bootBlock,
    cleanupBlock: "await mcpHost.disconnectAll();",
    hasAny: true,
  };
}

/**
 * Section 13 — render the sub-agent registry literal + Task-tool registration.
 * Returns empty pieces when ir.subAgents is empty so non-sub-agent specs
 * preserve their pre-Section-13 emitted shape.
 */
function renderSubAgents(ir: IrV0): {
  imports: string[];
  registryBlock: string;
  registerBlock: string;
  spawnField: string;
  subAgentsField: string;
} {
  if (ir.subAgents.length === 0) {
    return {
      imports: [],
      registryBlock: "",
      registerBlock: "",
      spawnField: "",
      subAgentsField: "",
    };
  }
  const imports = [
    `import { createTaskTool } from "@crewhaus/tool-task";`,
    `import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";`,
    `import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";`,
  ];
  const entries = ir.subAgents
    .map((d) => `  [${escapeJsonString(d.name)}, ${renderSubAgentDef(d)}],`)
    .join("\n");
  const registryBlock = `const __subAgents: ReadonlyMap<string, SubAgentDefinition> = new Map<string, SubAgentDefinition>([\n${entries}\n]);`;
  const registerBlock = "defaultCatalog.register(createTaskTool({ subAgents: __subAgents }));";
  return {
    imports,
    registryBlock,
    registerBlock,
    spawnField: "\n  spawnSubAgent,",
    subAgentsField: "\n  subAgents: __subAgents,",
  };
}

/**
 * FR-006 (Pillar 3, sink-side) — emit the egress-matcher selection lowered
 * to `ir.security.egressMatcher` into the standalone bundle, so a compiled
 * cli artifact honours `security.egressMatcher: semantic` WITHOUT the
 * `crewhaus run` path. This mirrors `apps/cli`'s `resolveEgressMatcher` /
 * `createEgressMatcher`:
 *
 *   - `"substring"` (or absent) returns empty pieces — the bundle pulls in
 *     NO embedding dependency and runtime-core stays on the built-in
 *     `substringMatcher` default (the run path returns `undefined` here and
 *     omits `egressMatcher`; the emitted shape stays byte-identical to the
 *     pre-FR-006 bundle). The optional-dependency posture (acceptance #4) is
 *     preserved: the default artifact never imports the semantic package.
 *   - `"semantic"` emits the construction of a `SemanticEgressMatcher` with
 *     an injected `@crewhaus/embedder` `Embedder`, threaded into
 *     `runChatLoop({ egressMatcher })`. The embedder model is resolved at
 *     bundle runtime from `CREWHAUS_EGRESS_EMBEDDER` (the same env var the
 *     run path reads) falling back to the documented default — the standalone
 *     analogue of `--egress-embedder` > `CREWHAUS_EGRESS_EMBEDDER` > default.
 *
 * Only *how* lineage matches are detected changes; the IR-wired placement
 * (every external sink) and the per-origin/per-sink policy + the three audit
 * outcomes (`egress-passed | egress-warned | egress-blocked`) live in
 * `classifyEgress` and are matcher-independent.
 */
const DEFAULT_EGRESS_EMBEDDER_MODEL = "openai/text-embedding-3-small";

function renderEgressMatcher(ir: IrV0): {
  imports: string[];
  bootBlock: string;
  field: string;
} {
  if (ir.security?.egressMatcher !== "semantic") {
    return { imports: [], bootBlock: "", field: "" };
  }
  const imports = [
    `import { createEmbedder } from "@crewhaus/embedder";`,
    `import { createSemanticEgressMatcher } from "@crewhaus/egress-matcher-semantic";`,
  ];
  // Resolve the embedder model at bundle runtime, mirroring the run path's
  // `CREWHAUS_EGRESS_EMBEDDER` env > DEFAULT_EGRESS_EMBEDDER_MODEL precedence.
  // The `--egress-embedder` flag has no standalone-bundle analogue; the env
  // var is the deployment knob for a compiled artifact.
  const bootBlock = [
    "const __egressEmbedder = createEmbedder({",
    `  model: process.env.CREWHAUS_EGRESS_EMBEDDER ?? ${escapeJsonString(DEFAULT_EGRESS_EMBEDDER_MODEL)},`,
    "});",
    "const __egressMatcher = createSemanticEgressMatcher({ embedder: __egressEmbedder });",
  ].join("\n");
  return { imports, bootBlock, field: "\n  egressMatcher: __egressMatcher," };
}

/** Render one IrSubAgentDefinition as a TypeScript object literal. */
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

function renderAgent(ir: IrV0): string {
  const { imports: builtinImports, inits, registrations } = resolveTools(ir.tools, ir.toolConfigs);
  const mcp = renderMcpServers(ir);
  const subAgents = renderSubAgents(ir);
  // FR-006 — Pillar 3 sink-side egress matcher. Empty pieces for the
  // substring default (the bundle stays free of any embedding dependency);
  // for "semantic" it constructs `@crewhaus/egress-matcher-semantic` with an
  // injected embedder, mirroring the `crewhaus run` path.
  const egress = renderEgressMatcher(ir);
  // The catalog import is needed when either built-in tools OR MCP servers
  // are in play. resolveTools() already prepends it for the built-in case;
  // we add it explicitly when MCP is the only consumer.
  // Section 11 also adds skill-tool registration to the catalog at boot,
  // so the catalog import is needed unconditionally now.
  const needsCatalogImport = ir.tools.length === 0 && (mcp.hasAny || true);
  const catalogImport = needsCatalogImport
    ? `import { defaultCatalog } from "@crewhaus/tool-catalog";\n`
    : "";
  const importBlock = builtinImports.length > 0 ? `${builtinImports.join("\n")}\n` : "";
  const mcpImportBlock = mcp.imports.length > 0 ? `${mcp.imports.join("\n")}\n` : "";
  // Section 14 — emit per-tool init calls (e.g. registerFetchConfig) before
  // the catalog registration so tools see their config on first use.
  const initBlock = inits.length > 0 ? `${inits.join("\n")}\n` : "";
  const registerBlock =
    registrations.length > 0 ? `\n${initBlock}${registrations.join("\n")}\n` : "";
  // tools: defaultCatalog.list() always — Section 11 may register a Skill
  // tool at boot when skills are discovered, so we always advertise.
  const toolsField = "\n  tools: defaultCatalog.list(),";

  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permField = renderPermissionsField(ir);

  // Section 11 — extension surface. The generated bundle discovers hooks /
  // skills / slash commands at runtime from the user's `.crewhaus/`
  // workspace, mirroring `apps/cli`'s `runRun` behaviour. Always emitted
  // so a compiled bundle has parity with the interpreter path.
  const extensionImport = [
    `import { loadHooks } from "@crewhaus/hooks-engine";`,
    `import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";`,
    `import { loadCommands } from "@crewhaus/slash-commands";`,
  ].join("\n");
  const extensionBoot = `const __cwd = process.cwd();
const [__hooks, __skills, __slashCommands] = await Promise.all([
  loadHooks({ cwd: __cwd }),
  discoverSkills({ cwd: __cwd }),
  loadCommands({ cwd: __cwd }),
]);
if (__skills.length > 0) defaultCatalog.register(createSkillTool(__skills));`;

  // Feature #53 — first-class `memory:` block. Its presence wires Remember/
  // Recall into the catalog and — via the auto-* switches — the runtime's
  // auto-recall + auto-capture seams. Mirrors apps/cli's runRunCli.
  const memory = renderMemory(ir);

  const mcpBoot = mcp.hasAny ? `${mcp.bootBlock}\n\n` : "";
  const subAgentsBoot = subAgents.registryBlock
    ? `${subAgents.registryBlock}\n${subAgents.registerBlock}\n\n`
    : "";
  // FR-006 — construct the semantic matcher (when selected) before the
  // runChatLoop call so it can be threaded into the options. Empty for the
  // substring default.
  const egressBoot = egress.bootBlock ? `${egress.bootBlock}\n\n` : "";

  // Phase 3 §3.3 — CLI banner with optional tagline rotation. Emitted
  // ahead of runChatLoop so users see the brand on cold start. Suppressed
  // when the environment sets CREWHAUS_RESUMED=1. NOTE: nothing in the
  // toolchain sets that var — `crewhaus run --continue/--resume` drives the
  // interpreter path, not a compiled bundle, and never touches the env. It
  // is purely a hook for an external wrapper that re-invokes a compiled
  // bundle and wants to skip the re-banner on a resumed run.
  const bannerBoot = ir.cli?.banner
    ? `if (process.env.CREWHAUS_RESUMED !== "1") {
  const __taglines = ${JSON.stringify(ir.cli.banner.taglines)};
  const __tagline = ${
    ir.cli.banner.taglineMode === "random"
      ? "__taglines[Math.floor(Math.random() * __taglines.length)]"
      : "__taglines[0]"
  };
  process.stdout.write(\`\\n\\x1b[1m${escapeBannerName(ir.name)}\\x1b[0m — \${__tagline}\\n\\n\`);
}
`
    : "";
  // Section 18 — only flip `sandboxAvailable` on at runtime when the
  // operator has wired a real backend. Default (unset) treats docker as
  // available; `CREWHAUS_SANDBOX=noop` always denies the floor.
  const hasSandboxTools = ir.tools.some(
    (t) => t === "python" || t === "javascript" || t === "shell",
  );
  const sandboxField = hasSandboxTools
    ? '\n  sandboxAvailable: ((process.env.CREWHAUS_SANDBOX ?? "docker").toLowerCase() !== "noop"),'
    : "";
  const maxTokensField =
    ir.agent.maxTokens !== undefined ? `\n  maxTokens: ${ir.agent.maxTokens},` : "";
  // Thread `compaction.model` so the compiled bundle's auto-compaction
  // summarizes on the spec's chosen model. The compiler already resolved the
  // `cheapest` sentinel to a concrete id, so this is a raw model string
  // (escaped like `model:`). Empty when the spec omits it, keeping existing
  // bundles byte-identical.
  const compactionModelField =
    ir.compaction.model !== undefined
      ? `\n  compactionModel: ${escapeJsonString(ir.compaction.model)},`
      : "";
  // Item 22 — provider failover chain: thread `agent.model_fallbacks` +
  // `agent.circuit_breaker` into the runtime, which constructs the
  // breaker-driven meta-adapter (see @crewhaus/model-router). Emitted only
  // when the spec declared them so existing bundles stay byte-identical.
  const failoverFields = renderModelFailoverFields(ir);
  // Section 55 / item 23 — thread the spec's failure_taxonomy so recovery-
  // engine consults the named error classes (incl. the `switch-model`
  // verdict) before its built-in flow. Empty when the spec omits it.
  const failureTaxonomyField = renderFailureTaxonomyField(ir);
  // Item 27 — run-level spend cap + degradation ladder. Empty when the spec
  // omits `budget`, keeping pre-existing bundles byte-identical.
  const budgetField = renderBudgetField(ir);
  // Item 37 — observability.slo → sloTargets, so a compiled bundle's chat loop
  // attaches the SLO monitor (sensing + alert, gated by CREWHAUS_SLO). Empty
  // when the spec omits the block.
  const sloField = renderSloField(ir);
  const runChatLoopCall = `await runChatLoop({
  model: ${escapeJsonString(ir.agent.model)},
  instructions: ${escapeJsonString(ir.agent.instructions)},
  sessionName: ${escapeJsonString(ir.name)},
  sessionTarget: "cli",${maxTokensField}${compactionModelField}${failoverFields}${failureTaxonomyField}${budgetField}${sloField}${toolsField}${permField}${sandboxField}
  hooks: __hooks,
  skills: __skills,
  slashCommands: __slashCommands,${subAgents.subAgentsField}${subAgents.spawnField}${egress.field}${memory.field}
});`;
  const wrapped = mcp.hasAny
    ? `try {
  ${runChatLoopCall.split("\n").join("\n  ")}
} finally {
  ${mcp.cleanupBlock}
}`
    : runChatLoopCall;

  const subAgentImportBlock =
    subAgents.imports.length > 0 ? `${subAgents.imports.join("\n")}\n` : "";
  const egressImportBlock = egress.imports.length > 0 ? `${egress.imports.join("\n")}\n` : "";
  const memoryImportBlock = memory.imports.length > 0 ? `${memory.imports.join("\n")}\n` : "";
  const memoryBoot = memory.bootBlock ? `${memory.bootBlock}\n\n` : "";

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: cli, ir version: ${ir.version})
import { runChatLoop } from "@crewhaus/runtime-core";
${permImport}${importBlock}${catalogImport}${mcpImportBlock}${subAgentImportBlock}${egressImportBlock}${memoryImportBlock}${extensionImport}
${registerBlock}
${extensionBoot}

${bannerBoot}${subAgentsBoot}${egressBoot}${memoryBoot}${mcpBoot}${wrapped}
`;
}

/**
 * Item 22 — render the failover-chain runChatLoop fields from the IR agent
 * block. Model strings pass through `escapeJsonString` (they are
 * user-controlled spec values landing in generated source); the breaker
 * tuning is a numbers-only object safe to JSON.stringify. Returns "" when
 * the spec declared neither field, keeping pre-existing bundles
 * byte-identical. Mirror: target-channel-bot + target-managed render the
 * same fields — keep the three in sync.
 */
function renderModelFailoverFields(ir: {
  readonly agent: {
    readonly modelFallbacks?: readonly string[];
    readonly circuitBreaker?: {
      readonly failureThreshold?: number;
      readonly windowMs?: number;
      readonly cooldownMs?: number;
    };
    readonly modelTiers?: {
      readonly fast: string;
      readonly default: string;
      readonly routing?: Record<string, number | boolean>;
    };
  };
}): string {
  const pieces: string[] = [];
  const fallbacks = ir.agent.modelFallbacks;
  if (fallbacks !== undefined && fallbacks.length > 0) {
    pieces.push(`\n  modelFallbacks: [${fallbacks.map((m) => escapeJsonString(m)).join(", ")}],`);
  }
  if (ir.agent.circuitBreaker !== undefined) {
    pieces.push(`\n  circuitBreaker: ${JSON.stringify(ir.agent.circuitBreaker)},`);
  }
  // Item 26 — two-tier router. JSON.stringify safely quotes the fast/default
  // model strings + numeric routing knobs (a plain object literal, no template
  // escaping needed). Absent when unset, keeping bundles byte-identical.
  if (ir.agent.modelTiers !== undefined) {
    pieces.push(`\n  modelTiers: ${JSON.stringify(ir.agent.modelTiers)},`);
  }
  return pieces.join("");
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field.
 * The IR entries are `{ class, pattern, recovery, hint? }`; `JSON.stringify`
 * produces safe double-quoted JS string literals for the user-controlled
 * class/pattern/hint text (no backtick/template-literal escaping needed —
 * the field lands in a plain object literal, not a template). Empty when
 * the spec omits the block, keeping pre-existing bundles byte-identical.
 * Mirror: target-channel-bot + target-managed render the same field.
 */
function renderFailureTaxonomyField(ir: IrV0): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n  failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Item 27 — render the `budget` runChatLoop field. The IR carries a
 * numbers-and-literals object (`usdMicros` + `onExceed`); `JSON.stringify`
 * safely quotes the degrade `model` string. Empty when the spec omits it.
 * Mirror: target-channel-bot + target-managed render the same field.
 */
function renderBudgetField(ir: IrV0): string {
  if (ir.budget === undefined) return "";
  return `\n  budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Ops item 37 — render the `sloTargets` runChatLoop field from
 * `observability.slo`. The IR carries a numbers + literal-union object (no
 * user-controlled strings — mitigation is a closed `alert|pause-intake|rollback`
 * union), so `JSON.stringify` is safe. Emitting this makes a compiled CLI bundle
 * attach the SLO monitor (gated at runtime by CREWHAUS_SLO) so SENSING + the
 * `alert` rung are portable — parity with the interpreter's runRunCli. Empty
 * when the spec omits the block, keeping pre-existing bundles byte-identical.
 * NOTE: the destructive mitigation rungs (pause-intake / rollback) need an
 * injected registry-backed sink, which a standalone CLI bundle has no way to
 * build, so a compiled bundle degrades to alert-only; production pause/rollback
 * mitigation runs in the CLI `run`/managed (registry-backed) context.
 */
function renderSloField(ir: IrV0): string {
  const slo = ir.observability?.slo;
  if (slo === undefined) return "";
  return `\n  sloTargets: ${JSON.stringify(slo)},`;
}

/**
 * Feature #53 — render the `memory:` block wiring. When the spec declared a
 * `memory` block (and did not disable it), emit: the memory-store/tool imports,
 * a boot block that constructs the store, registers Remember/Recall, and — via
 * the auto-* switches — the auto-recall (system-prompt injection) + auto-capture
 * (durable-fact summary at teardown) seams, plus the `memory:` runChatLoop
 * field. Empty when the spec omits `memory` so pre-existing bundles are
 * byte-identical. Mirrors apps/cli's runRunCli.
 */
function renderMemory(ir: IrV0): { imports: string[]; bootBlock: string; field: string } {
  const mem = ir.memory;
  if (mem === undefined || mem.enabled === false) {
    return { imports: [], bootBlock: "", field: "" };
  }
  const imports = [
    `import { createMemoryStore, deriveMemoryDecision, summarizeDurableFacts, captureFacts, turnsFromEvents } from "@crewhaus/memory-store";`,
    `import { createMemoryTools } from "@crewhaus/tool-memory";`,
    `import { readFileSync as __memReadFileSync } from "node:fs";`,
    `import { join as __memJoin } from "node:path";`,
  ];
  const specName = escapeJsonString(ir.name);
  const autoRecall = mem.autoRecall === true;
  const autoCapture = mem.autoCapture === true;
  const config = JSON.stringify({
    ...(mem.enabled !== undefined ? { enabled: mem.enabled } : {}),
    ...(mem.autoCapture !== undefined ? { autoCapture: mem.autoCapture } : {}),
    ...(mem.autoCaptureThreshold !== undefined
      ? { autoCaptureThreshold: mem.autoCaptureThreshold }
      : {}),
    ...(mem.autoRecall !== undefined ? { autoRecall: mem.autoRecall } : {}),
    ...(mem.recallK !== undefined ? { recallK: mem.recallK } : {}),
  });
  const recallSeam = autoRecall
    ? `
    autoRecall: true,
    recallK: __memDecision.recallK,
    recall: async (query, k) => (await __memStore.recall(query, k)).map((r) => r.entry.text),`
    : "";
  const captureSeam = autoCapture
    ? `
    autoCapture: true,
    onCapture: async (completedTurns, sessionId) => {
      if (!deriveMemoryDecision(__memConfig, completedTurns).capture) return;
      const __memFile = __memJoin(process.cwd(), ".crewhaus", "sessions", sessionId + ".jsonl");
      let __memEvents = [];
      try {
        __memEvents = __memReadFileSync(__memFile, "utf-8")
          .split("\\n")
          .filter((l) => l.trim() !== "")
          .map((l) => { try { return JSON.parse(l); } catch { return undefined; } })
          .filter((e) => e !== undefined);
      } catch {}
      const __memFacts = summarizeDurableFacts(turnsFromEvents(__memEvents));
      await captureFacts(__memStore, __memFacts, ["auto-capture", sessionId]);
    },`
    : "";
  const bootBlock = `const __memConfig = ${config};
const __memStore = createMemoryStore({ specName: ${specName} });
const __memBundle = createMemoryTools({ specName: ${specName}, store: __memStore });
defaultCatalog.register(__memBundle.remember);
defaultCatalog.register(__memBundle.recall);
const __memDecision = deriveMemoryDecision(__memConfig, Number.MAX_SAFE_INTEGER);`;
  const field = `\n  memory: {${recallSeam}${captureSeam}\n  },`;
  return { imports, bootBlock, field };
}

/**
 * Escape a string for safe embedding inside a backtick template literal
 * in the generated bundle. Banner names come from spec.name (user-
 * controlled but already validated to be a non-empty string) — we still
 * sanitize to be defensive about backticks and template-literal
 * interpolation tokens.
 */
function escapeBannerName(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
