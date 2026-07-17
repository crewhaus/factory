import { CrewhausError } from "@crewhaus/errors";
import { escapeJsonString } from "@crewhaus/infra-utils";
import {
  type Bundle,
  type EmitReadmeOptions,
  type IrWorkflowStep,
  type IrWorkflowV0,
  renderBundleReadme,
} from "@crewhaus/ir";

/**
 * Emit a self-contained workflow agent bundle. The generated agent.ts
 * runs each step sequentially via runChatLoop in single-turn mode. Step
 * 1 reads its initial user message from process.stdin (read to EOF);
 * steps 2+ have no user input — they receive a synthetic user message
 * containing the prior step's terminal assistant text.
 *
 * Loop contract 0.4 (Batch A): the spec's `limits` ceilings thread into
 * every step's call — `deadline_ms` bounds the WHOLE run (the runner
 * stamps the deadline once, guards between steps, and arms each step's
 * runtime deadline timer with the remaining budget) while
 * `turn_timeout_ms` bounds one step. Each step carries its own
 * `max_tokens`/`thinking` tuning, `budget` and the spec-declared `hooks`
 * ride along, and `mcp_servers` are wired for real (G05): one shared
 * McpHost boots before the steps and its tools flow to every step that
 * declares tools.
 *
 * Future expansion: parallel/conditional steps, fan-out, retry/branch
 * logic — this v0 emits strictly sequential execution.
 */
export function emitWorkflow(ir: IrWorkflowV0, opts: EmitReadmeOptions = {}): Bundle {
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
 * Built-in tool name → package + export. Mirrors the same map in
 * @crewhaus/target-cli; intentionally duplicated for this PR. Follow-up
 * will extract a shared @crewhaus/tool-resolver package.
 */
const BUILTIN_TOOL_MAP: Record<string, { package: string; export: string }> = {
  read: { package: "@crewhaus/tool-fs", export: "read" },
  write: { package: "@crewhaus/tool-fs", export: "write" },
  edit: { package: "@crewhaus/tool-fs", export: "edit" },
  glob: { package: "@crewhaus/tool-fs", export: "glob" },
  grep: { package: "@crewhaus/tool-fs", export: "grep" },
  bash: { package: "@crewhaus/tool-bash", export: "bash" },
  todoWrite: { package: "@crewhaus/tool-todo", export: "todoWrite" },
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
};

/**
 * Compute the union of every tool referenced across all steps and resolve
 * to grouped imports (sorted, one per package). Throws TargetEmitError if
 * any step references an unknown tool name.
 */
function resolveAllTools(steps: readonly IrWorkflowStep[]): string[] {
  const seen = new Set<string>();
  for (const step of steps) {
    for (const t of step.tools) seen.add(t);
  }
  if (seen.size === 0) return [];

  const byPackage = new Map<string, string[]>();
  for (const name of seen) {
    const entry = BUILTIN_TOOL_MAP[name];
    if (!entry) {
      const known = Object.keys(BUILTIN_TOOL_MAP).sort().join(", ");
      throw new TargetEmitError(`unknown tool "${name}" — known tools: ${known}`);
    }
    const list = byPackage.get(entry.package) ?? [];
    list.push(entry.export);
    byPackage.set(entry.package, list);
  }

  const imports: string[] = [];
  for (const pkg of [...byPackage.keys()].sort()) {
    const exports = (byPackage.get(pkg) ?? []).slice().sort();
    imports.push(`import { ${exports.join(", ")} } from "${pkg}";`);
  }
  return imports;
}

/**
 * Fields shared verbatim by every step's runChatLoop call, precomputed
 * once in renderAgent. `hooksExpr` is `__allHooks` when the spec declares
 * `hooks:` (concat with the discovered settings.json hooks), else the
 * pre-existing `__hooks`. `deadlineMs` renders the per-step whole-run
 * deadline guard; `mcpWired` spreads `__mcpTools` into tool-declaring
 * steps (G05).
 */
type StepShared = {
  readonly permFields: string;
  readonly failureTaxonomyField: string;
  readonly limitsFields: string;
  readonly budgetField: string;
  readonly hooksExpr: string;
  readonly deadlineMs: number | undefined;
  readonly mcpWired: boolean;
};

function renderStep(step: IrWorkflowStep, idx: number, total: number, shared: StepShared): string {
  const isFirst = idx === 0;
  const stepNum = idx + 1;
  const toolsField = renderStepToolsField(step.tools, shared.mcpWired);
  const stepTuningFields = renderStepTuningFields(step);
  const deadlineGuard = renderDeadlineGuard(shared.deadlineMs, stepNum, total, step.name);

  // Anthropic rejects empty user content with a 400, so fall back to a
  // non-empty placeholder when stdin is empty (autonomous-style agent —
  // the step's instructions ARE the prompt).
  const userContent = isFirst
    ? 'stdinInput || "begin"'
    : "`## Output of previous step:\\n${priorOutput}\\n\\n## Your task:\\n(continue based on the previous step's output)`";

  const stdinReadLine = isFirst ? "  const stdinInput = await readStdinToEnd();\n" : "";

  return `
  // ── Step ${stepNum}/${total}: ${step.name} ──
${deadlineGuard}${stdinReadLine}  process.stdout.write("\\n[step ${stepNum}/${total}: ${step.name}]\\n");
  priorOutput = await runChatLoop({
    model: ${escapeJsonString(step.model)},
    instructions: ${escapeJsonString(step.instructions)},
    singleTurn: true,
    seedMessages: [{ role: "user", content: ${userContent} }],${toolsField}${stepTuningFields}${shared.limitsFields}${shared.budgetField}${shared.permFields}${shared.failureTaxonomyField}
    hooks: ${shared.hooksExpr},
    skills: __skills,
    slashCommands: __slashCommands,
  });
`;
}

/**
 * Build the per-step `tools:` field. Section 11 weaves the discovered
 * Skill tool in alongside any spec-declared built-ins; G05 additionally
 * spreads the wire-once MCP tools (`__mcpTools`) into steps that declare
 * tools. Steps WITHOUT tools stay tool-free — they receive neither the
 * built-ins nor the MCP tools (only the Section 11 skill weave).
 */
function renderStepToolsField(tools: readonly string[], mcpWired: boolean): string {
  const exports = tools
    .map((t) => BUILTIN_TOOL_MAP[t]?.export)
    .filter((e): e is string => typeof e === "string");
  if (exports.length === 0) {
    return "\n    tools: __skillTool ? [__skillTool] : [],";
  }
  const base = mcpWired ? `${exports.join(", ")}, ...__mcpTools` : exports.join(", ");
  return `\n    tools: __skillTool ? [${base}, __skillTool] : [${base}],`;
}

/**
 * Loop contract 0.4 (Batch A) — per-step model-call tuning: `maxTokens`
 * (spec `steps[].max_tokens`) and the extended-thinking selector (spec
 * `steps[].thinking`; the spec's superRefine guarantees exactly one of
 * `{ budgetTokens }` / `{ effort }`). `JSON.stringify` is safe here:
 * numbers plus a closed `low|medium|high` literal union, no free-form
 * user strings. Empty when the step declares neither, keeping
 * pre-existing bundles byte-identical.
 */
function renderStepTuningFields(step: IrWorkflowStep): string {
  const pieces: string[] = [];
  if (step.maxTokens !== undefined) {
    pieces.push(`\n    maxTokens: ${step.maxTokens},`);
  }
  if (step.thinking !== undefined) {
    pieces.push(`\n    thinking: ${JSON.stringify(step.thinking)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — render the spec-declared `limits` ceilings
 * shared by EVERY step's runChatLoop call. `deadline_ms` bounds the WHOLE
 * workflow run, so it is never passed verbatim (each call would get the
 * full ceiling — N steps would multiply the budget): the runner stamps
 * `__deadlineAt` once at boot and each step's call arms runtime-core's
 * run-deadline timer with the REMAINING budget
 * (`Math.max(1, __deadlineAt - Date.now())`), so the workflow ceiling
 * binds MID-step too — in singleTurn mode the turn is the run, so a fire
 * is the runtime's classified timeout failure. The already-elapsed
 * boundary is handled cleanly BEFORE the call by {@link
 * renderDeadlineGuard} (the `Math.max(1, …)` floor exists so a razor-edge
 * remainder of `<= 0` still arms the timer instead of disarming it).
 * `turn_timeout_ms` passes verbatim — it bounds one step (each step is
 * exactly one singleTurn call). `limits.crew` never appears on this shape
 * (the spec rejects it outside crew). All values are spec-validated
 * numbers / a closed literal union, so `JSON.stringify` is safe. Empty
 * when the spec omits `limits`, keeping pre-existing bundles
 * byte-identical.
 */
function renderLimitsFields(ir: IrWorkflowV0): string {
  const l = ir.limits;
  if (l === undefined) return "";
  const pieces: string[] = [];
  if (l.maxToolIterations !== undefined) {
    pieces.push(`\n    maxToolIterations: ${l.maxToolIterations},`);
  }
  if (l.maxConcurrentTools !== undefined) {
    pieces.push(`\n    maxConcurrentTools: ${l.maxConcurrentTools},`);
  }
  if (l.contextLimit !== undefined) {
    pieces.push(`\n    contextLimit: ${l.contextLimit},`);
  }
  if (l.deadlineMs !== undefined) {
    pieces.push("\n    deadlineMs: Math.max(1, __deadlineAt - Date.now()),");
  }
  if (l.turnTimeoutMs !== undefined) {
    pieces.push(`\n    turnTimeoutMs: ${l.turnTimeoutMs},`);
  }
  if (l.modelCallTimeoutMs !== undefined) {
    pieces.push(`\n    modelCallTimeoutMs: ${l.modelCallTimeoutMs},`);
  }
  if (l.loopDetection !== undefined) {
    pieces.push(`\n    loopDetection: ${JSON.stringify(l.loopDetection)},`);
  }
  return pieces.join("");
}

/**
 * Loop contract 0.4 (Batch A) — `limits.deadline_ms` bounds the WHOLE
 * workflow run (wall clock), not any single step. The generated runner
 * stamps `__deadlineAt` once at the top of main() and guards every step:
 * once the deadline has passed, the run stops with a `[limits]` notice and
 * a non-zero exit code BEFORE opening the next step's turn (mid-step
 * enforcement is the runtime's job — each call arms the run-deadline
 * timer with the remaining budget, see {@link renderLimitsFields}). The
 * guard uses `process.exitCode` + `return` (never `process.exit`) so the
 * MCP `finally` teardown still runs.
 */
function renderDeadlineGuard(
  deadlineMs: number | undefined,
  stepNum: number,
  total: number,
  stepName: string,
): string {
  if (deadlineMs === undefined) return "";
  const notice = `\n[limits] workflow deadline exceeded (deadline_ms = ${deadlineMs}) — stopping before step ${stepNum}/${total}: ${stepName}\n`;
  return [
    "  if (Date.now() >= __deadlineAt) {",
    `    process.stderr.write(${escapeJsonString(notice)});`,
    "    process.exitCode = 1;",
    "    return;",
    "  }",
    "",
  ].join("\n");
}

/**
 * Section 55 / item 23 — render the `failureTaxonomy` runChatLoop field.
 * The taxonomy is spec-level, so every step's runChatLoop call gets the
 * same classes (mirror: target-cli + target-channel-bot render the same
 * field). Empty when the spec omits the block.
 */
function renderFailureTaxonomyField(ir: IrWorkflowV0): string {
  const taxonomy = ir.failureTaxonomy;
  if (taxonomy === undefined || taxonomy.length === 0) return "";
  return `\n    failureTaxonomy: ${JSON.stringify(taxonomy)},`;
}

/**
 * Item 27 (Batch A extends the block to this shape) — render the `budget`
 * runChatLoop field, threaded into EVERY step's call. Each step runs its
 * own loop with its own cost meter, so in v0 the cap bounds each step
 * independently (a run-spanning meter needs a runtime-core seam that does
 * not exist yet). `JSON.stringify` safely quotes the degrade `model`
 * string. Empty when the spec omits it. Mirror: target-cli +
 * target-channel-bot + target-managed render the same field.
 */
function renderBudgetField(ir: IrWorkflowV0): string {
  if (ir.budget === undefined) return "";
  return `\n    budget: ${JSON.stringify(ir.budget)},`;
}

/**
 * Loop contract 0.4 (Batch A) — spec-declared lifecycle hooks. The IR
 * entries are already HookDef-shaped (hooks-engine's type, camelCase
 * `timeoutMs`), so the bundle declares them as one typed const and layers
 * them BELOW the discovered settings.json hooks: spec entries first, then
 * loadHooks()' user → project entries — aggregateDecisions' later-wins
 * mutate merge keeps the settings layers authoritative, mirroring the
 * permission RuleSet's settings-over-yaml precedence (same ordering as
 * target-cli and the `crewhaus run` interpreter). All hooks still RUN
 * (any deny wins regardless of layer). `JSON.stringify` is safe —
 * `event` is a closed enum and matcher/command land inside JSON-quoted
 * literals. Empty when the spec omits `hooks`.
 */
function renderSpecHooksBoot(ir: IrWorkflowV0): string {
  const specHooks = ir.hooks ?? [];
  if (specHooks.length === 0) return "";
  return [
    "",
    "  // Loop contract 0.4 — spec-declared hooks layer BELOW the discovered",
    "  // settings.json layers (spec first; user → project later-wins).",
    `  const __specHooks: ReadonlyArray<HookDef> = ${JSON.stringify(specHooks)};`,
    "  const __allHooks = [...__specHooks, ...__hooks];",
  ].join("\n");
}

/**
 * G05 — wire-once MCP host for the workflow bundle, following
 * eval-runner's wire-once `McpHost` + `registerMcpServer` pattern: the
 * generated main() boots ONE McpHost, registers every server's tools into
 * ONE private `ToolCatalog` (`__mcpCatalog`), and each step that declares
 * tools spreads the resulting `__mcpTools` into its runChatLoop call.
 * Steps without tools stay tool-free. Teardown is a `finally` around the
 * step sequence so stdio servers are disconnected on success, failure, or
 * a deadline stop.
 *
 * 0.3.0 — env/header values are `IrSecretRef` objects; the UNRESOLVED
 * config is embedded verbatim (no secret value ever lands in the artifact)
 * and `resolveMcpServerConfig` materialises it from the running process's
 * environment at boot, failing fast with the variable's name when a
 * referenced env var is unset (mirror: target-cli renders the same call).
 *
 * When servers are declared but NO step declares tools there is nothing to
 * expose them to, so the bundle skips the boot entirely and surfaces a
 * generated note instead (0.2.3 convention: users notice rather than
 * wondering why their MCP tools never showed up).
 */
function renderMcpServers(ir: IrWorkflowV0): {
  imports: string[];
  bootBlock: string;
  note: string;
  wired: boolean;
} {
  const entries = Object.entries(ir.mcp_servers);
  if (entries.length === 0) {
    return { imports: [], bootBlock: "", note: "", wired: false };
  }
  const anyStepHasTools = ir.steps.some((s) => s.tools.length > 0);
  if (!anyStepHasTools) {
    return {
      imports: [],
      bootBlock: "",
      note: "// note: mcp_servers configured but no step declares tools — servers are not booted (declare tools on a step to expose MCP tools to it)\n",
      wired: false,
    };
  }
  const imports = [
    `import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";`,
    `import { ToolCatalog } from "@crewhaus/tool-catalog";`,
    `import { registerMcpServer } from "@crewhaus/tool-mcp";`,
  ];
  const addLines = entries
    .map(
      ([name, cfg]) =>
        `  __mcpHost.addServer(${escapeJsonString(name)}, resolveMcpServerConfig(${JSON.stringify(cfg)}, { name: ${escapeJsonString(name)} }));`,
    )
    .join("\n");
  const registerLines = entries
    .map(
      ([name]) =>
        `    registerMcpServer(__mcpHost, ${escapeJsonString(name)}, __mcpCatalog, { onRegister: ({ fullName }) => process.stdout.write(\`[mcp] registered \${fullName}\\n\`) }),`,
    )
    .join("\n");
  const bootBlock = [
    "",
    "  // G05 — wire-once MCP host shared across steps (eval-runner pattern):",
    "  // servers boot once, their tools land in one catalog, and steps that",
    "  // declare tools receive them alongside their built-ins.",
    "  const __mcpHost = new McpHost();",
    addLines,
    "  const __mcpCatalog = new ToolCatalog();",
    "  await Promise.all([",
    registerLines,
    "  ]);",
    "  const __mcpTools = __mcpCatalog.list();",
  ].join("\n");
  return { imports, bootBlock, note: "", wired: true };
}

function renderPermissionsFields(ir: IrWorkflowV0): string {
  const { mode, rules } = ir.permissions;
  if (mode === undefined && rules.length === 0) return "";
  const lines: string[] = [];
  if (mode !== undefined) {
    lines.push(`    permissionMode: ${escapeJsonString(mode)},`);
  }
  if (rules.length > 0) {
    const ruleLits = rules
      .map(
        (r) =>
          `        { type: ${escapeJsonString(r.type)}, pattern: ${escapeJsonString(r.pattern)}, source: "yaml" },`,
      )
      .join("\n");
    lines.push(
      [
        "    permissionRules: {",
        "      flag: [],",
        "      settings: [],",
        "      yaml: [",
        ruleLits,
        "      ],",
        "      hooks: [],",
        "      builtin: BUILTIN_DEFAULT_RULES,",
        "    },",
      ].join("\n"),
    );
  }
  return `\n${lines.join("\n")}`;
}

/** Indent every non-empty line by one extra level (the MCP try wrapper). */
function indentStepBodies(stepBodies: string): string {
  return stepBodies
    .split("\n")
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join("\n");
}

function renderAgent(ir: IrWorkflowV0): string {
  const importLines = resolveAllTools(ir.steps);
  const importBlock = importLines.length > 0 ? `${importLines.join("\n")}\n` : "";
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permFields = renderPermissionsFields(ir);
  const failureTaxonomyField = renderFailureTaxonomyField(ir);
  const limitsFields = renderLimitsFields(ir);
  const budgetField = renderBudgetField(ir);
  // G05 — mcp_servers are WIRED now (wire-once host + per-step tool spread);
  // the pre-0.4 ignored-note remains only for the declared-but-unconsumable
  // corner (no step declares tools).
  const mcp = renderMcpServers(ir);
  const specHooksBoot = renderSpecHooksBoot(ir);
  const hasSpecHooks = specHooksBoot !== "";
  const deadlineMs = ir.limits?.deadlineMs;
  const shared: StepShared = {
    permFields,
    failureTaxonomyField,
    limitsFields,
    budgetField,
    hooksExpr: hasSpecHooks ? "__allHooks" : "__hooks",
    deadlineMs,
    mcpWired: mcp.wired,
  };
  const stepBodies = ir.steps.map((s, i) => renderStep(s, i, ir.steps.length, shared)).join("");
  // v0.3.0 — continuity is spec-carried on this shape but not emit-wired in
  // 0.3.0 (only the five agent-loop shapes are). Surface it, 0.2.3-style.
  const continuityWarning =
    ir.continuity !== undefined
      ? "// note: continuity configured but ignored on workflow in 0.3.0\n"
      : "";

  // Section 11 — share hooks/skills/slash-commands across all steps. The
  // discovery happens once at the top of `main` and each step's
  // runChatLoop call reuses the same arrays/maps. Skill tool is appended
  // to a step's local tool list when skills are present. Loop contract 0.4
  // additionally imports hooks-engine's HookDef type when the spec
  // declares its own hooks (the typed `__specHooks` const).
  const extensionImports = `import { ${hasSpecHooks ? "type HookDef, " : ""}loadHooks } from "@crewhaus/hooks-engine";
import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
`;
  const mcpImportBlock = mcp.imports.length > 0 ? `${mcp.imports.join("\n")}\n` : "";

  // limits.deadline_ms — stamped at the very TOP of main(), before the
  // extension discovery and the MCP boot, so the ceiling covers the whole
  // run (boot time included); every step body opens with the guard (see
  // renderDeadlineGuard).
  const deadlineBoot =
    deadlineMs !== undefined
      ? [
          "",
          "  // limits.deadline_ms — wall-clock ceiling for the WHOLE workflow run",
          "  // (boot included), guarded before every step (turn_timeout_ms bounds",
          "  // one step's turn from inside runChatLoop).",
          `  const __deadlineAt = Date.now() + ${deadlineMs};`,
        ].join("\n")
      : "";

  // G05 — with MCP wired, the step sequence runs inside try/finally so the
  // stdio servers disconnect on success, failure, or a deadline stop.
  const stepsSection = mcp.wired
    ? `  try {${indentStepBodies(stepBodies)}  } finally {
    await __mcpHost.disconnectAll();
  }
`
    : stepBodies;

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: workflow, ir version: ${ir.version}, ${ir.steps.length} step(s))
${mcp.note}${continuityWarning}import { runChatLoop } from "@crewhaus/runtime-core";
${permImport}${extensionImports}${importBlock}${mcpImportBlock}
async function readStdinToEnd(): Promise<string> {
  // No piped input — don't block waiting on an interactive TTY.
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

async function main(): Promise<void> {
  let priorOutput = "";${deadlineBoot}
  const __cwd = process.cwd();
  const [__hooks, __skills, __slashCommands] = await Promise.all([
    loadHooks({ cwd: __cwd }),
    discoverSkills({ cwd: __cwd }),
    loadCommands({ cwd: __cwd }),
  ]);
  const __skillTool = __skills.length > 0 ? createSkillTool(__skills) : null;
  void __skillTool;${specHooksBoot}${mcp.bootBlock}
${stepsSection}}

await main();
`;
}
