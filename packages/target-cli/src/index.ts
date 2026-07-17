import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrSubAgentDefinition,
  type IrV0,
  renderBundleReadme,
} from "@crewhaus/ir";
import { memoryFragmentFromIr } from "@crewhaus/memory-service";

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
 * 0.3.0 — env/header values are `IrSecretRef` objects; the UNRESOLVED
 * config is embedded verbatim (so no secret value ever lands in the
 * artifact) and `resolveMcpServerConfig` materialises it from the running
 * process's environment at boot, failing fast with the variable's name
 * when a referenced env var is unset.
 *
 * Empty `mcp_servers` returns empty strings so spec files without MCP get
 * no MCP plumbing at all — no imports, no boot block, and no `finally`
 * cleanup on the runChatLoop wrapper (regression guard for the hello-cli
 * example; since 0.3.0 Goal 6 every bundle carries the terminal-failure
 * `catch`, but only MCP adds the `finally`).
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
  // v0.3.0 Goal 3 (design §4.3) — the `thredz` server (synthesized, or the
  // user's own vendored entry) boots through `connectThredz`: its wiki+goals
  // tools land on the catalog under their BARE names (one vocabulary across
  // backends) and a boot failure DEGRADES (`__thredz` = null → wireMemory
  // falls back to local files with a warning) instead of failing the run.
  const thredzOn = ir.thredz !== undefined;
  const imports = [
    `import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";`,
    ...(thredzOn ? [`import { connectThredz } from "@crewhaus/memory-service";`] : []),
    ...(entries.some(([name]) => !(thredzOn && name === "thredz"))
      ? [`import { registerMcpServer } from "@crewhaus/tool-mcp";`]
      : []),
  ];
  const addLines = entries
    .map(([name, cfg]) => {
      const add = `mcpHost.addServer(${escapeJsonString(name)}, resolveMcpServerConfig(${JSON.stringify(cfg)}, { name: ${escapeJsonString(name)} }));`;
      // §4.4 — a missing THREDZ_API_KEY is a CONFIG failure: render the one
      // structured report and exit with the config code (21) instead of an
      // unhandled ConfigError stack (this add runs before the runChatLoop
      // try/catch wrapper).
      if (thredzOn && name === "thredz") {
        return `try {\n  ${add}\n} catch (__err) {\n  const __report = toFailureReport(__err);\n  process.stderr.write(\`\${formatRunFailure(__report, { prefix: "crewhaus:" })}\\n\`);\n  process.exit(__report.exitCode);\n}`;
      }
      return add;
    })
    .join("\n");
  const namespacedEntries = entries.filter(([name]) => !(thredzOn && name === "thredz"));
  const registerLines = namespacedEntries
    .map(
      ([name]) =>
        `  registerMcpServer(mcpHost, ${escapeJsonString(name)}, defaultCatalog, { onRegister: ({ fullName }) => process.stdout.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  const thredzBoot = thredzOn
    ? `const __thredz = await connectThredz(mcpHost, defaultCatalog, { log: (line) => process.stdout.write(line)${
        ir.thredz?.agentName !== undefined
          ? `, agentName: ${escapeJsonString(ir.thredz.agentName)}`
          : ""
      } });`
    : undefined;
  const bootBlock = [
    "const mcpHost = new McpHost();",
    addLines,
    ...(thredzBoot !== undefined ? [thredzBoot] : []),
    ...(namespacedEntries.length > 0 ? ["await Promise.all([", registerLines, "]);"] : []),
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

/**
 * Loop contract 0.4 (Batch B, G02) — render the in-loop `evaluation:` wiring.
 * The bundle constructs the evaluate fn from the RESOLVED IR grader and
 * threads it — together with the resolved gate knobs — into runChatLoop's
 * `evaluation` option; the runtime scores each completed assistant turn,
 * compares against `threshold`, applies `onFail` (retry ≤ `maxRetries` with
 * the rationale appended as a system nudge / halt as a classified
 * `evaluation` failure / note as an `eval_graded` trace event only) and
 * emits one `eval_graded` event per grading pass.
 *
 *   - `llm_judge` rides `@crewhaus/eval-judge`'s `judge()` (the offline
 *     eval-judge scoring path: single-criterion rubric from `criteria`,
 *     1–5 score mapped to [0,1] via (n-1)/4, prompt-injection-hardened
 *     sentinels). The judge model resolves through the SAME model-router
 *     adapter wiring the bundle's primary model uses (env credentials,
 *     any provider), so judge spend is metered exactly like every other
 *     model call; the model defaults to the shape's primary model when the
 *     spec omitted `grader.model` (`cheapest` already resolved at lower
 *     time). `threshold` was resolved at lower time (default 0.7) — the
 *     `?? 0.7` is a defensive floor for hand-built IR.
 *   - `contains` / `regex` are emitted as pure fns (score 1 on pass, 0 on
 *     fail; no model spend, no import). The regex was validated compilable
 *     at parse time; `lastIndex` is reset per call so a global/sticky flag
 *     can never flip-flop verdicts across turns.
 *
 * The emitted literal is annotated `RunEvaluation` (runtime-core's seam
 * type), so a compiled bundle typechecks against the exact runtime
 * contract: `graderType`/`threshold` are stamped verbatim onto every
 * `eval_graded` event (deterministic graders carry the documented
 * threshold 1 — score is 0|1 and `score >= threshold` is the pass rule).
 * Empty pieces when the spec omits the block, keeping pre-existing bundles
 * byte-identical. Mirror: target-channel-bot + target-managed render the
 * same wiring — keep the three in sync.
 */
function renderEvaluation(ir: IrV0): { imports: string[]; bootBlock: string; field: string } {
  const ev = ir.evaluation;
  if (ev === undefined) return { imports: [], bootBlock: "", field: "" };
  const field = "\n  evaluation: __evaluation,";
  const typeImport = `import type { RunEvaluation } from "@crewhaus/runtime-core";`;
  const onFail = escapeJsonString(ev.onFail);
  if (ev.grader.type === "llm_judge") {
    const criteria = escapeJsonString(ev.grader.criteria);
    const model = escapeJsonString(ev.grader.model ?? ir.agent.model);
    const bootBlock = `const __evaluation: RunEvaluation = {
  graderType: "llm_judge",
  threshold: ${ev.threshold ?? 0.7},
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) => {
    const __verdict = await judge({
      rubric: {
        criteria: [
          {
            name: "criteria",
            description: ${criteria},
            anchors: {
              "1": "fails the criteria entirely",
              "2": "mostly fails the criteria",
              "3": "partially meets the criteria",
              "4": "meets the criteria with minor gaps",
              "5": "fully meets the criteria",
            },
          },
        ],
        passing_score: 3,
      },
      sample: { id: "in-loop-evaluation", input: "" },
      agentOutput: finalText,
      model: ${model},
    });
    return { score: (__verdict.score - 1) / 4, rationale: __verdict.rationale };
  },
};`;
    return {
      imports: [typeImport, `import { judge } from "@crewhaus/eval-judge";`],
      bootBlock,
      field,
    };
  }
  const value = ev.grader.value;
  const valueLit = escapeJsonString(value);
  if (ev.grader.type === "contains") {
    const bootBlock = `const __evaluation: RunEvaluation = {
  graderType: "contains",
  threshold: 1,
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) =>
    finalText.includes(${valueLit})
      ? { score: 1, rationale: ${escapeJsonString(`output contains "${value}"`)} }
      : { score: 0, rationale: ${escapeJsonString(`output missing "${value}"`)} },
};`;
    return { imports: [typeImport], bootBlock, field };
  }
  const bootBlock = `const __evalRegex = new RegExp(${valueLit});
const __evaluation: RunEvaluation = {
  graderType: "regex",
  threshold: 1,
  onFail: ${onFail},
  maxRetries: ${ev.maxRetries},
  evaluate: async ({ finalText }) => {
    __evalRegex.lastIndex = 0;
    return __evalRegex.test(finalText)
      ? { score: 1, rationale: ${escapeJsonString(`output matches /${value}/`)} }
      : { score: 0, rationale: ${escapeJsonString(`output does not match /${value}/`)} };
  },
};`;
  return { imports: [typeImport], bootBlock, field };
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
  // Loop contract 0.4 (Batch B, G02) — in-loop output evaluation. Empty
  // pieces when the spec omits the block.
  const evaluation = renderEvaluation(ir);
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

  // v0.3.0 Goal 1 — when the IR carries continuity (DEFAULT-ON unless the
  // spec opted out with `continuity: false`) or learning (PR 17 — its
  // rendered learning-loop skill and /study /reflect /exam commands come
  // from the same root), the composition root owns the skill/command
  // surface: `wireMemory` merges the builtin skills and slash commands at
  // lowest precedence with the user's `~/.crewhaus` + project `.crewhaus`
  // entries, and the bundle registers the Skill tool from THAT list — the
  // bundle's own discovery would strand the builtin skills (advertised in
  // the prompt with no tool able to load them).
  const continuityOn = ir.continuity !== undefined || ir.learning !== undefined;

  // Section 11 — extension surface. The generated bundle discovers hooks /
  // skills / slash commands at runtime from the user's `.crewhaus/`
  // workspace, mirroring `apps/cli`'s `runRun` behaviour. Always emitted
  // so a compiled bundle has parity with the interpreter path. With
  // continuity on, skills + commands come from `wireMemory` (below) instead.
  const extensionImport = continuityOn
    ? [
        `import { loadHooks } from "@crewhaus/hooks-engine";`,
        `import { createSkillTool } from "@crewhaus/skills-registry";`,
      ].join("\n")
    : [
        `import { loadHooks } from "@crewhaus/hooks-engine";`,
        `import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";`,
        `import { loadCommands } from "@crewhaus/slash-commands";`,
      ].join("\n");
  const extensionBoot = continuityOn
    ? `const __cwd = process.cwd();
const __hooks = await loadHooks({ cwd: __cwd });`
    : `const __cwd = process.cwd();
const [__hooks, __skills, __slashCommands] = await Promise.all([
  loadHooks({ cwd: __cwd }),
  discoverSkills({ cwd: __cwd }),
  loadCommands({ cwd: __cwd }),
]);
if (__skills.length > 0) defaultCatalog.register(createSkillTool(__skills));`;

  // Feature #53 / v0.3.0 Goal 1 — first-class `memory:` + `continuity:`
  // blocks, wired through the ONE stable composition-root call. Mirrors
  // apps/cli's runRunCli.
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
  // Loop contract 0.4 (Batch A) — extended-thinking selector. The IR carries
  // exactly one form ({budgetTokens} XOR {effort}); both are numbers/closed
  // literal unions, so JSON.stringify is safe. Runtime-core threads it to the
  // provider request (`thinking` verbatim, `effort` via the adapter preset
  // table `EFFORT_THINKING_BUDGET_TOKENS`). Empty when unset.
  const thinkingField =
    ir.agent.thinking !== undefined ? `\n  thinking: ${JSON.stringify(ir.agent.thinking)},` : "";
  // Loop contract 0.4 (Batch A) — stream partial output tokens (cli-only spec
  // key). Carried verbatim only when declared, so unset specs keep their
  // pinned bundle bytes and the runtime default (false) stays authoritative.
  const streamingField =
    ir.agent.streaming !== undefined ? `\n  streaming: ${ir.agent.streaming},` : "";
  // Loop contract 0.4 (Batch A) — per-tool rate limits (keys are tool names
  // or "*"). Keys are user-controlled spec strings landing in a plain object
  // literal, so JSON.stringify's quoting is the escaping (same posture as
  // toolConfigs inits). Empty when unset.
  const rateLimitsField =
    ir.agent.rateLimits !== undefined && Object.keys(ir.agent.rateLimits).length > 0
      ? `\n  rateLimits: ${JSON.stringify(ir.agent.rateLimits)},`
      : "";
  // Thread `compaction.model` so the compiled bundle's auto-compaction
  // summarizes on the spec's chosen model. The compiler already resolved the
  // `cheapest` sentinel to a concrete id, so this is a raw model string
  // (escaped like `model:`). Empty when the spec omits it, keeping existing
  // bundles byte-identical.
  const compactionModelField =
    ir.compaction.model !== undefined
      ? `\n  compactionModel: ${escapeJsonString(ir.compaction.model)},`
      : "";
  // Loop contract 0.4 (Batch A) — compaction tuning knobs, mapped onto the
  // runtime's existing options (`compactionThreshold` + the snip window).
  // Numbers only; each key absent when the spec omits it so the runtime's
  // own defaults (0.85 / 4 / 20) stay authoritative and pre-existing bundles
  // stay byte-identical.
  const compactionTuningFields = renderCompactionTuningFields(ir);
  // Loop contract 0.4 (Batch A) — hard runtime ceilings from the `limits:`
  // block. Empty when the spec omits it.
  const limitsFields = renderLimitsFields(ir);
  // Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks, layered
  // BELOW the settings.json layers. Empty pieces when the spec has none.
  const specHooks = renderSpecHooks(ir);
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
  sessionTarget: "cli",${maxTokensField}${thinkingField}${streamingField}${rateLimitsField}${compactionModelField}${compactionTuningFields}${limitsFields}${failoverFields}${failureTaxonomyField}${budgetField}${evaluation.field}${sloField}${toolsField}${permField}${sandboxField}
  hooks: ${specHooks.hooksExpr},
  skills: __skills,
  slashCommands: __slashCommands,${subAgents.subAgentsField}${subAgents.spawnField}${egress.field}${memory.field}
});`;
  // v0.3.0 Goal 6 — the exact "agent exited" fix. The top-level
  // `await runChatLoop(...)` used to be bare, so a terminal failure
  // surfaced as an unhandled Bun stack on stderr + exit 1. Every emitted
  // bundle now catches, renders the ONE structured report every other
  // surface prints (a RunFailedError carries its classified report;
  // anything else synthesizes the generic one), and exits with the
  // report's coded status so fleet / the UI host can dispatch on it.
  const catchBlock = `} catch (__err) {
  const __report = toFailureReport(__err);
  process.stderr.write(\`\${formatRunFailure(__report)}\\n\`);
  process.exit(__report.exitCode);
}`;
  const finallyBlock = mcp.hasAny
    ? ` finally {
  ${mcp.cleanupBlock}
}`
    : "";
  const wrapped = `try {
  ${runChatLoopCall.split("\n").join("\n  ")}
${catchBlock}${finallyBlock}`;

  const subAgentImportBlock =
    subAgents.imports.length > 0 ? `${subAgents.imports.join("\n")}\n` : "";
  const egressImportBlock = egress.imports.length > 0 ? `${egress.imports.join("\n")}\n` : "";
  const evaluationImportBlock =
    evaluation.imports.length > 0 ? `${evaluation.imports.join("\n")}\n` : "";
  const evaluationBoot = evaluation.bootBlock ? `${evaluation.bootBlock}\n\n` : "";
  const memoryImportBlock = memory.imports.length > 0 ? `${memory.imports.join("\n")}\n` : "";
  const memoryBoot = memory.bootBlock ? `${memory.bootBlock}\n\n` : "";

  // v0.3.0 Goal 3 — with thredz on, the MCP host boots FIRST so wireMemory
  // receives the live connection (`__thredz`) the backend flip needs; every
  // other bundle keeps the pinned memory-before-mcp order byte-identically.
  const bootBlocks =
    ir.thredz !== undefined ? `${mcpBoot}${memoryBoot}` : `${memoryBoot}${mcpBoot}`;

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: cli, ir version: ${ir.version})
import { formatRunFailure, toFailureReport } from "@crewhaus/errors";
import { runChatLoop } from "@crewhaus/runtime-core";
${permImport}${importBlock}${catalogImport}${mcpImportBlock}${subAgentImportBlock}${egressImportBlock}${evaluationImportBlock}${memoryImportBlock}${extensionImport}
${registerBlock}
${extensionBoot}${specHooks.bootBlock}

${bannerBoot}${subAgentsBoot}${egressBoot}${evaluationBoot}${bootBlocks}${wrapped}
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
    readonly modelPool?: unknown;
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
  // Adaptive model routing — the N-candidate pool. Same JSON.stringify safety
  // as modelTiers (a plain object literal of validated strings/numbers).
  if (ir.agent.modelPool !== undefined) {
    pieces.push(`\n  modelPool: ${JSON.stringify(ir.agent.modelPool)},`);
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
 * Loop contract 0.4 (Batch A) — render the `limits:` ceilings into
 * runChatLoop options, 1:1 onto the runtime knobs of the same names:
 * `maxToolIterations` / `maxConcurrentTools` / `contextLimit` (pre-existing)
 * and `deadlineMs` / `turnTimeoutMs` / `modelCallTimeoutMs` / `loopDetection`
 * (the 0.4 enforcement timers + detection tuning/escalation ladder).
 * Every value is a spec-validated positive int or a closed literal union
 * (`loopDetection.escalation`), so `JSON.stringify` needs no escaping.
 * Empty when the spec omits the block, keeping pre-existing bundles
 * byte-identical. `limits.crew` never appears on IrV0 (crew-shape only).
 * Mirror: the `crewhaus run` interpreter threads the same fields via
 * apps/cli's loop-contract helper — keep the two in sync.
 */
function renderLimitsFields(ir: IrV0): string {
  const limits = ir.limits;
  if (limits === undefined) return "";
  const pieces: string[] = [];
  if (limits.maxToolIterations !== undefined) {
    pieces.push(`\n  maxToolIterations: ${limits.maxToolIterations},`);
  }
  if (limits.maxConcurrentTools !== undefined) {
    pieces.push(`\n  maxConcurrentTools: ${limits.maxConcurrentTools},`);
  }
  if (limits.contextLimit !== undefined) {
    pieces.push(`\n  contextLimit: ${limits.contextLimit},`);
  }
  if (limits.deadlineMs !== undefined) {
    pieces.push(`\n  deadlineMs: ${limits.deadlineMs},`);
  }
  if (limits.turnTimeoutMs !== undefined) {
    pieces.push(`\n  turnTimeoutMs: ${limits.turnTimeoutMs},`);
  }
  if (limits.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n  modelCallTimeoutMs: ${limits.modelCallTimeoutMs},`);
  }
  if (limits.loopDetection !== undefined) {
    pieces.push(`\n  loopDetection: ${JSON.stringify(limits.loopDetection)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the compaction tuning knobs onto the
 * runtime's EXISTING options: `compaction.threshold` → `compactionThreshold`,
 * `compaction.snip_keep_head`/`snip_keep_tail` → `snipKeepHead`/`snipKeepTail`.
 * Numbers only. Each key is emitted only when the spec declared it so the
 * runtime defaults (0.85 / 4 / 20) stay authoritative and pre-existing
 * bundles stay byte-identical.
 */
function renderCompactionTuningFields(ir: IrV0): string {
  const pieces: string[] = [];
  if (ir.compaction.threshold !== undefined) {
    pieces.push(`\n  compactionThreshold: ${ir.compaction.threshold},`);
  }
  if (ir.compaction.snipKeepHead !== undefined) {
    pieces.push(`\n  snipKeepHead: ${ir.compaction.snipKeepHead},`);
  }
  if (ir.compaction.snipKeepTail !== undefined) {
    pieces.push(`\n  snipKeepTail: ${ir.compaction.snipKeepTail},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the spec-declared `hooks:` array and
 * the runChatLoop `hooks:` expression. Spec hooks are LAYERED BELOW the
 * settings.json layers: the generated bundle concatenates
 * `[...__specHooks, ...__hooks]` (spec first, then loadHooks()' user →
 * project entries), mirroring the permission RuleSet's settings-over-yaml
 * precedence — hooks-engine's `aggregateDecisions` shallow-merges `mutate`
 * later-wins, so a settings.json hook overrides a spec hook's mutate keys,
 * and result ordering keeps the more-local layers last. All hooks still RUN
 * (any deny wins regardless of layer).
 *
 * IrHook is field-compatible with hooks-engine's `HookDef` (camelCase
 * `timeoutMs`), and `event` values are the closed HookEvent union, so the
 * JSON literal + `as const` type-checks against `runChatLoop({ hooks })`.
 * `matcher`/`command` are user-controlled spec strings — JSON.stringify's
 * quoting is the escaping (same posture as toolConfigs inits). Returns the
 * plain `__hooks` expression and no boot line when the spec declares none,
 * keeping pre-existing bundles byte-identical.
 */
function renderSpecHooks(ir: IrV0): { bootBlock: string; hooksExpr: string } {
  if (ir.hooks === undefined || ir.hooks.length === 0) {
    return { bootBlock: "", hooksExpr: "__hooks" };
  }
  return {
    bootBlock: `\nconst __specHooks = ${JSON.stringify(ir.hooks)} as const;`,
    hooksExpr: "[...__specHooks, ...__hooks]",
  };
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
 * Feature #53 / v0.3.0 PR 10+11 — render the memory-fabric wiring. When the
 * IR carries a `memory` block (and did not disable it) and/or a `continuity`
 * block (DEFAULT-ON in 0.3.0), emit ONE stable composition-root call
 * (design §1 principle 1): the fragment — serialized via
 * `memoryFragmentFromIr` — goes to `@crewhaus/memory-service`'s `wireMemory`,
 * which constructs the stores, registers the tools, and returns the
 * runChatLoop seams; the bundle spreads `__memWired.options` into the call.
 * Every future memory feature lands in the service, not in codegen.
 *
 * Two emission shapes, byte-diff-pinned:
 *   - memory only (a `continuity: false` spec) — EXACTLY the PR 10 bytes, so
 *     the opt-out restores prior bundles verbatim (the release's compat
 *     contract, design §12).
 *   - continuity on — the call moves onto `__cwd`, and the bundle takes its
 *     skills + slash commands from `wireMemory` (builtin `continuity` skill
 *     and commands merged at lowest precedence) before registering the
 *     Skill tool.
 * Empty when the IR carries neither block, keeping opted-out bundles
 * byte-identical (test-pinned).
 */
function renderMemory(ir: IrV0): { imports: string[]; bootBlock: string; field: string } {
  const mem = ir.memory;
  const memoryOn = mem !== undefined && mem.enabled !== false;
  const continuityOn = ir.continuity !== undefined;
  const thredzOn = ir.thredz !== undefined;
  if (!memoryOn && !continuityOn && !thredzOn) {
    return { imports: [], bootBlock: "", field: "" };
  }
  // v0.3.0 PR 14 (§6.3) — boot-time dream catch-up, cli shape: when the
  // schedule is overdue, the DETERMINISTIC phase runs (sub-second, zero
  // spend) and the bundle prints the note pointing at `crewhaus dream` for
  // the full consolidation. Only emitted when the spec configured
  // memory.dream, so dream-less bundles keep their pinned bytes.
  const dreamOn = memoryOn && mem?.dream !== undefined;
  // v0.3.0 Goal 2 (§3.3, PR 17) — the first-class exam: with `learning.exam`
  // configured, the bundle constructs the programmatic exam runner
  // (eval-runner's `createExamRunner`) and hands it to wireMemory, which
  // registers the `run_exam` tool + gates in `/exam`. No Bash shell-out —
  // the compiled bundle sits its exam in-process, same as the interpreter.
  const learningOn = ir.learning !== undefined;
  const examOn = learningOn && ir.learning?.exam !== undefined;
  // Loop contract 0.4 (Batch A) — top-level fact-store embedder (spec
  // `memory.embedder`). The bundle constructs it and hands it to wireMemory
  // as `deps.embedder`, which memory-service's `resolveEmbedder` prefers
  // over the fragment's `wiki.embedder` — exactly the documented runtime
  // fallback order (`embedder` → `wiki.embedder`), with zero fragment-shape
  // change. The import is skipped when the FR-006 semantic egress matcher
  // already imported `createEmbedder` (renderEgressMatcher emits the same
  // binding, and its import block precedes this one in the bundle).
  const memEmbedder = memoryOn ? mem?.embedder : undefined;
  const embedderDep =
    memEmbedder !== undefined
      ? `, embedder: createEmbedder({ model: ${escapeJsonString(memEmbedder)} })`
      : "";
  const imports = [
    ...(memEmbedder !== undefined && ir.security?.egressMatcher !== "semantic"
      ? [`import { createEmbedder } from "@crewhaus/embedder";`]
      : []),
    `import { wireMemory${dreamOn ? ", runDreamBootCatchUp" : ""} } from "@crewhaus/memory-service";`,
    ...(examOn ? [`import { createExamRunner } from "@crewhaus/eval-runner";`] : []),
  ];
  const fragment = JSON.stringify(
    memoryFragmentFromIr({
      name: ir.name,
      ...(memoryOn ? { memory: ir.memory } : {}),
      ...(continuityOn ? { continuity: ir.continuity } : {}),
      ...(thredzOn ? { thredz: ir.thredz } : {}),
      ...(learningOn ? { learning: ir.learning } : {}),
    }),
  );
  // v0.3.0 Goal 3 — hand wireMemory the live thredz connection from the MCP
  // boot block (which runs first when thredz is on); null means boot failed
  // and wireMemory degrades to local files with a warning (§4.4).
  const thredzDep = thredzOn ? ", thredz: __thredz" : "";
  // The exam runner reuses the bundle's own identity (model + instructions —
  // the examinee is THIS harness) and the same fragment/thredz wiring the
  // memory fabric boots with. The instructions literal appears once more in
  // the runChatLoop call below; duplicating the string keeps the no-learning
  // emission byte-identical (a shared const would reshape every bundle).
  const examDep = (cwdExpr: string): string =>
    examOn
      ? `, examRunner: createExamRunner({ specName: ${escapeJsonString(ir.name)}, model: ${escapeJsonString(ir.agent.model)}, instructions: ${escapeJsonString(ir.agent.instructions)}, fragment: ${fragment}, cwd: ${cwdExpr}${thredzOn ? ", thredz: __thredz" : ""} })`
      : "";
  const dreamBoot = (cwdExpr: string): string =>
    dreamOn
      ? `\nconst __dreamNote = await runDreamBootCatchUp(${fragment}, { cwd: ${cwdExpr} });
if (__dreamNote !== null) process.stdout.write(\`\${__dreamNote}\\n\`);`
      : "";
  if (!continuityOn && !learningOn) {
    // PR 10-pinned bytes: the `continuity: false` opt-out path.
    const bootBlock = `const __memWired = await wireMemory(${fragment}, { catalog: defaultCatalog, cwd: process.cwd()${embedderDep}${thredzDep}${examDep("process.cwd()")} });${dreamBoot("process.cwd()")}`;
    const field = "\n  ...__memWired.options,";
    return { imports, bootBlock, field };
  }
  const bootBlock = `const __memWired = await wireMemory(${fragment}, { catalog: defaultCatalog, cwd: __cwd${embedderDep}${thredzDep}${examDep("__cwd")} });
const __skills = __memWired.options.skills ?? [];
const __slashCommands = __memWired.options.slashCommands ?? new Map();
if (__skills.length > 0) defaultCatalog.register(createSkillTool(__skills));${dreamBoot("__cwd")}`;
  const field = "\n  ...__memWired.options,";
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
