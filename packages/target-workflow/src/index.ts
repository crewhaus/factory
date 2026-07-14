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

function renderStep(
  step: IrWorkflowStep,
  idx: number,
  total: number,
  permFields: string,
  failureTaxonomyField: string,
): string {
  const isFirst = idx === 0;
  const stepNum = idx + 1;
  const toolsField = renderStepToolsField(step.tools);

  // Anthropic rejects empty user content with a 400, so fall back to a
  // non-empty placeholder when stdin is empty (autonomous-style agent —
  // the step's instructions ARE the prompt).
  const userContent = isFirst
    ? 'stdinInput || "begin"'
    : "`## Output of previous step:\\n${priorOutput}\\n\\n## Your task:\\n(continue based on the previous step's output)`";

  const stdinReadLine = isFirst ? "  const stdinInput = await readStdinToEnd();\n" : "";

  return `
  // ── Step ${stepNum}/${total}: ${step.name} ──
${stdinReadLine}  process.stdout.write("\\n[step ${stepNum}/${total}: ${step.name}]\\n");
  priorOutput = await runChatLoop({
    model: ${escapeJsonString(step.model)},
    instructions: ${escapeJsonString(step.instructions)},
    singleTurn: true,
    seedMessages: [{ role: "user", content: ${userContent} }],${toolsField}${permFields}${failureTaxonomyField}
    hooks: __hooks,
    skills: __skills,
    slashCommands: __slashCommands,
  });
`;
}

/**
 * Build the per-step `tools:` field. Section 11 weaves the discovered
 * Skill tool in alongside any spec-declared built-ins.
 */
function renderStepToolsField(tools: readonly string[]): string {
  const exports = tools
    .map((t) => BUILTIN_TOOL_MAP[t]?.export)
    .filter((e): e is string => typeof e === "string");
  if (exports.length === 0) {
    return "\n    tools: __skillTool ? [__skillTool] : [],";
  }
  return `\n    tools: __skillTool ? [${exports.join(", ")}, __skillTool] : [${exports.join(", ")}],`;
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

function renderAgent(ir: IrWorkflowV0): string {
  const importLines = resolveAllTools(ir.steps);
  const importBlock = importLines.length > 0 ? `${importLines.join("\n")}\n` : "";
  const hasRules = ir.permissions.rules.length > 0;
  const permImport = hasRules
    ? `import { BUILTIN_DEFAULT_RULES } from "@crewhaus/permission-engine";\n`
    : "";
  const permFields = renderPermissionsFields(ir);
  const failureTaxonomyField = renderFailureTaxonomyField(ir);
  const stepBodies = ir.steps
    .map((s, i) => renderStep(s, i, ir.steps.length, permFields, failureTaxonomyField))
    .join("");
  // Section 9: workflow target ignores mcp_servers in v0. Surface it as a
  // generated comment so users notice rather than wondering why their MCP
  // tools never showed up.
  const mcpWarning =
    Object.keys(ir.mcp_servers).length > 0
      ? "// note: mcp_servers configured but target-workflow does not yet wire them up — they are ignored\n"
      : "";
  // v0.3.0 — continuity is spec-carried on this shape but not emit-wired in
  // 0.3.0 (only the five agent-loop shapes are). Surface it, 0.2.3-style.
  const continuityWarning =
    ir.continuity !== undefined
      ? "// note: continuity configured but ignored on workflow in 0.3.0\n"
      : "";

  // Section 11 — share hooks/skills/slash-commands across all steps. The
  // discovery happens once at the top of `main` and each step's
  // runChatLoop call reuses the same arrays/maps. Skill tool is appended
  // to a step's local tool list when skills are present.
  const extensionImports = `import { loadHooks } from "@crewhaus/hooks-engine";
import { discoverSkills, createSkillTool } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
`;

  return `#!/usr/bin/env bun
// Generated by crewhaus. DO NOT EDIT.
// Source spec: ${escapeJsonString(ir.name)} (target: workflow, ir version: ${ir.version}, ${ir.steps.length} step(s))
${mcpWarning}${continuityWarning}import { runChatLoop } from "@crewhaus/runtime-core";
${permImport}${extensionImports}${importBlock}
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
  let priorOutput = "";
  const __cwd = process.cwd();
  const [__hooks, __skills, __slashCommands] = await Promise.all([
    loadHooks({ cwd: __cwd }),
    discoverSkills({ cwd: __cwd }),
    loadCommands({ cwd: __cwd }),
  ]);
  const __skillTool = __skills.length > 0 ? createSkillTool(__skills) : null;
  void __skillTool;
${stepBodies}}

await main();
`;
}
