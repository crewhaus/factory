import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * Build the agent stack ONCE per eval run, then share across samples.
 *
 * This factors the runRun logic from apps/cli/src/index.ts so the CLI's
 * `crewhaus run` and the eval runner's `crewhaus eval` use the same
 * tool/hook/skill/MCP/sub-agent wiring. Single source of truth for the
 * "what is the full agent stack from an IR" question.
 *
 * The MCP host (if any) is shared across all eval samples — re-spinning
 * stdio MCP servers per sample for 200 samples would burn ~30s in process
 * startup and exceed the T7 SLO. The trade-off is documented: eval-runner
 * assumes the agent's MCP usage is read-mostly. An `isolateMcpPerSample`
 * escape hatch is reserved for a future where this matters.
 */
import {
  type SubAgentDefinition,
  subAgentDefinitionFromIr,
} from "@crewhaus/agent-context-isolation";
import { type HookDef, loadHooks } from "@crewhaus/hooks-engine";
import type { IrV0 } from "@crewhaus/ir";
import { createLogger } from "@crewhaus/logging";
import { McpHost, resolveMcpServerConfig } from "@crewhaus/mcp-host";
import {
  BUILTIN_DEFAULT_RULES,
  PermissionConfigError,
  type RuleSet,
  parsePermissionsConfig,
  tagRules,
} from "@crewhaus/permission-engine";
import { sandboxAvailableFromEnv } from "@crewhaus/sandbox";
import { type SkillRef, createSkillTool, discoverSkills } from "@crewhaus/skills-registry";
import { type SlashCommand, loadCommands } from "@crewhaus/slash-commands";
import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import {
  BUILTIN_TOOLS,
  BuiltinToolError,
  type ToolPackageImporter,
  checkBuiltinTool,
  registerToolConfigs,
} from "@crewhaus/tool-categories";
import { registerMcpServer, registerOptionalMcpServer } from "@crewhaus/tool-mcp";
import { createTaskTool } from "@crewhaus/tool-task";
import { RunnerError } from "./errors";

type SpawnSubAgentFn = typeof spawnSubAgent;

export type SharedAgentDeps = {
  readonly tools: ReadonlyArray<RegisteredTool>;
  /**
   * Some wired tool runs model-written code, and the environment's sandbox
   * backend (CREWHAUS_SANDBOX, the grammar the cli bundle uses) is not
   * `noop`. Absent when no such tool is wired.
   */
  readonly sandboxAvailable?: boolean;
  readonly hooks: ReadonlyArray<HookDef>;
  readonly skills: ReadonlyArray<SkillRef>;
  readonly slashCommands: ReadonlyMap<string, SlashCommand>;
  readonly subAgents?: ReadonlyMap<string, SubAgentDefinition>;
  readonly spawnSubAgent?: SpawnSubAgentFn;
  readonly permissionRules: RuleSet;
  readonly mcpHost?: McpHost;
  readonly model: string;
  readonly instructions: string;
  readonly sessionName: string;
  readonly sessionTarget: string;
};

const logger = createLogger({ bindings: { module: "eval-runner.wire" } });

export type WireRunOnceOptions = {
  readonly cwd?: string;
  /**
   * How to import a tool package. The default is a plain `import(pkg)`,
   * which works wherever the packages resolve from this module (an installed
   * bundle, whose manifest pins them). The CLI passes its literal loader
   * table, because a single-binary build only embeds literal specifiers; an
   * eval bundle passes the modules it imported statically.
   */
  readonly importToolPackage?: ToolPackageImporter;
};

const defaultImportToolPackage: ToolPackageImporter = (pkg) => import(pkg);

/**
 * The spec's `tools:` → RegisteredTools, through the one builtin table
 * (`@crewhaus/tool-categories`) every emitter and `crewhaus run` read — so
 * `crewhaus eval` and `crewhaus optimize` wire exactly the tools the compiled
 * bundle registers, the 0.7.0 builtins included. `tool_config` is applied
 * through the same hook first. A name the shape cannot run is a RunnerError
 * with the compiler's own message.
 */
async function wireBuiltinTools(
  ir: IrV0,
  importPackage: ToolPackageImporter,
): Promise<{ tools: RegisteredTool[]; sandbox: boolean }> {
  if (ir.tools.length === 0) return { tools: [], sandbox: false };
  const problems: string[] = [];
  for (const key of ir.tools) {
    const verdict = checkBuiltinTool(key, "eval");
    if (verdict.kind === "unknown" || verdict.kind === "refused") {
      problems.push(`tools: ${verdict.message}`);
    }
  }
  if (problems.length > 0) throw new RunnerError(problems.join("\n"));
  const modules = new Map<string, Readonly<Record<string, unknown>>>();
  const load = async (pkg: string): Promise<Readonly<Record<string, unknown>>> => {
    const cached = modules.get(pkg);
    if (cached !== undefined) return cached;
    let mod: Readonly<Record<string, unknown>>;
    try {
      mod = await importPackage(pkg);
    } catch (err) {
      throw new RunnerError(
        `could not load ${pkg}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    modules.set(pkg, mod);
    return mod;
  };
  try {
    // The same registrations a compiled bundle makes: tool_config blocks with
    // their `$VAR` values read from this process, and the chain blocks.
    await registerToolConfigs([{ tools: ir.tools, toolConfigs: ir.toolConfigs }], load, {
      env: process.env,
      chains: ir,
    });
  } catch (err) {
    if (err instanceof BuiltinToolError) throw new RunnerError(err.message, err);
    throw err;
  }
  let sandbox = false;
  const tools: RegisteredTool[] = [];
  for (const key of ir.tools) {
    const entry = BUILTIN_TOOLS[key];
    if (entry === undefined) continue; // unreachable: checked above
    const tool = (await load(entry.package))[entry.export] as RegisteredTool | undefined;
    if (tool === undefined || typeof tool.name !== "string") {
      throw new RunnerError(
        `${entry.package} does not export the tool "${entry.export}" that the builtin table names for "${key}"`,
      );
    }
    if (entry.sandbox === true) sandbox = true;
    tools.push(tool);
  }
  return { tools, sandbox };
}

export async function wireRunOnce(
  ir: IrV0,
  opts: WireRunOnceOptions = {},
): Promise<SharedAgentDeps> {
  const cwd = opts.cwd ?? process.cwd();

  // Tools.
  const builtin = await wireBuiltinTools(ir, opts.importToolPackage ?? defaultImportToolPackage);
  let tools: RegisteredTool[] = builtin.tools;

  // MCP servers (shared across samples).
  let mcpHost: McpHost | undefined;
  if (Object.keys(ir.mcp_servers).length > 0) {
    const host = new McpHost({ logger });
    mcpHost = host;
    // 0.3.0 — env/header values are IrSecretRef; resolve from the eval
    // process's environment (fail-fast, names the variable).
    for (const [name, cfg] of Object.entries(ir.mcp_servers)) {
      // #406 — an optional peer's config resolution + addServer happen inside
      // registerOptionalMcpServer's never-throw boundary below, so an unset
      // env var on one degrades instead of failing the whole eval run.
      if (cfg.required === false) continue;
      host.addServer(name, resolveMcpServerConfig(cfg, { name }));
    }
    const tempCatalog = new ToolCatalog();
    for (const t of tools) tempCatalog.register(t);
    await Promise.all(
      Object.entries(ir.mcp_servers)
        .filter(([, cfg]) => cfg.required !== false)
        .map(([name]) => registerMcpServer(host, name, tempCatalog)),
    );
    // #406 — optional peers degrade instead of failing the run. Wire-once
    // freezes this tool list for every sample, so degrade-only (retry: false).
    for (const [name, cfg] of Object.entries(ir.mcp_servers)) {
      if (cfg.required !== false) continue;
      const { required: _requiredFlag, ...wireCfg } = cfg as typeof cfg & { required?: false };
      await registerOptionalMcpServer(host, name, tempCatalog, {
        retry: false,
        config: () => resolveMcpServerConfig(wireCfg, { name }),
        log: (line) => process.stdout.write(line),
      }).firstAttempt;
    }
    tools = tempCatalog.list().slice();
  }

  // Permission rules.
  const permissionRules = buildRuleSet(ir.permissions.rules, cwd);

  // Hooks / skills / slash-commands.
  const [hooks, skills, slashCommands] = await Promise.all([
    loadHooks({ cwd }),
    discoverSkills({ cwd }),
    loadCommands({ cwd }),
  ]);
  if (skills.length > 0) tools.push(createSkillTool(skills));

  // Sub-agents.
  let subAgents: ReadonlyMap<string, SubAgentDefinition> | undefined;
  if (ir.subAgents.length > 0) {
    // 0.6.0 §7.7 — the ONE IR → runtime mapping (shared with both `crewhaus
    // run` loop sites), so `crewhaus eval` measures the same child routing,
    // params, budget share and profile allowlist the shipped agent runs with.
    subAgents = new Map(ir.subAgents.map((d) => [d.name, subAgentDefinitionFromIr(d)]));
    tools.push(createTaskTool({ subAgents }));
  }

  return {
    tools,
    hooks,
    skills,
    slashCommands,
    permissionRules,
    model: ir.agent.model,
    instructions: ir.agent.instructions,
    sessionName: ir.name,
    sessionTarget: ir.target,
    ...(builtin.sandbox ? { sandboxAvailable: sandboxAvailableFromEnv(process.env) } : {}),
    ...(subAgents !== undefined ? { subAgents, spawnSubAgent } : {}),
    ...(mcpHost !== undefined ? { mcpHost } : {}),
  };
}

function buildRuleSet(
  yamlRules: ReadonlyArray<{ type: "alwaysAllow" | "alwaysDeny" | "alwaysAsk"; pattern: string }>,
  cwd: string,
): RuleSet {
  let settings: RuleSet["settings"] = [];
  const settingsPath = join(cwd, ".crewhaus", "settings.json");
  if (existsSync(settingsPath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    } catch (err) {
      throw new RunnerError(`failed to parse ${settingsPath}: ${(err as Error).message}`, err);
    }
    const root = (raw as { permissions?: unknown }).permissions;
    if (root !== undefined) {
      try {
        const parsed = parsePermissionsConfig(root, "settings");
        settings = tagRules(parsed.rules, "settings");
      } catch (err) {
        if (err instanceof PermissionConfigError) throw new RunnerError(err.message, err);
        throw err;
      }
    }
  }
  return {
    flag: [],
    settings,
    yaml: tagRules(yamlRules, "yaml"),
    hooks: [],
    builtin: BUILTIN_DEFAULT_RULES,
  };
}
