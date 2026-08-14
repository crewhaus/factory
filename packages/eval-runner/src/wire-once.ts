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
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
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
import { type SkillRef, createSkillTool, discoverSkills } from "@crewhaus/skills-registry";
import { type SlashCommand, loadCommands } from "@crewhaus/slash-commands";
import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { registerMcpServer, registerOptionalMcpServer } from "@crewhaus/tool-mcp";
import { createTaskTool } from "@crewhaus/tool-task";
import { RunnerError } from "./errors";

type SpawnSubAgentFn = typeof spawnSubAgent;

export type SharedAgentDeps = {
  readonly tools: ReadonlyArray<RegisteredTool>;
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

export async function wireRunOnce(ir: IrV0, opts: { cwd?: string } = {}): Promise<SharedAgentDeps> {
  const cwd = opts.cwd ?? process.cwd();

  // Tools.
  let tools: RegisteredTool[] = [];
  if (ir.tools.length > 0) {
    await applyToolConfigs(ir.tools, ir.toolConfigs);
    const toolMap = await loadToolMap();
    tools = ir.tools.map((name) => {
      const tool = toolMap[name];
      if (!tool) {
        const known = Object.keys(toolMap).sort().join(", ");
        throw new RunnerError(`unknown tool "${name}" — known tools: ${known}`);
      }
      return tool;
    });
  }

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
    subAgents = new Map(
      ir.subAgents.map((d) => [
        d.name,
        {
          name: d.name,
          description: d.description,
          instructions: d.instructions,
          tools: d.tools,
          ...(d.model !== undefined ? { model: d.model } : {}),
          permissions: d.permissions,
          inherit_bypass: d.inheritBypass,
        } satisfies SubAgentDefinition,
      ]),
    );
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
    ...(subAgents !== undefined ? { subAgents, spawnSubAgent } : {}),
    ...(mcpHost !== undefined ? { mcpHost } : {}),
  };
}

async function loadToolMap(): Promise<Record<string, RegisteredTool>> {
  const [fs, bash, todo, web, image, fetchPkg] = await Promise.all([
    import("@crewhaus/tool-fs"),
    import("@crewhaus/tool-bash"),
    import("@crewhaus/tool-todo"),
    import("@crewhaus/tool-web"),
    import("@crewhaus/tool-image"),
    import("@crewhaus/tool-fetch"),
  ]);
  return {
    read: fs.read,
    write: fs.write,
    edit: fs.edit,
    glob: fs.glob,
    grep: fs.grep,
    bash: bash.bash,
    todoWrite: todo.todoWrite,
    webFetch: web.webFetch,
    webSearch: web.webSearch,
    readImage: image.readImage,
    fetch: fetchPkg.fetch,
  };
}

async function applyToolConfigs(
  toolNames: readonly string[],
  toolConfigs: Readonly<Record<string, unknown>>,
): Promise<void> {
  const used = new Set(toolNames);
  if (used.has("fetch") && toolConfigs["fetch"] !== undefined) {
    const { registerFetchConfig } = await import("@crewhaus/tool-fetch");
    registerFetchConfig(toolConfigs["fetch"] as Parameters<typeof registerFetchConfig>[0]);
  }
  if (used.has("webFetch") && toolConfigs["webFetch"] !== undefined) {
    const { registerWebFetchConfig } = await import("@crewhaus/tool-web");
    registerWebFetchConfig(toolConfigs["webFetch"] as Parameters<typeof registerWebFetchConfig>[0]);
  }
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
