#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import { SpecParseError, compile, lower } from "@crewhaus/compiler";
import { loadHooks } from "@crewhaus/hooks-engine";
import {
  ArgParseError,
  type ParseArgsSchema,
  type ParsedArgs,
  parseArgs,
} from "@crewhaus/infra-utils";
import { createLogger } from "@crewhaus/logging";
import { McpHost } from "@crewhaus/mcp-host";
import {
  BUILTIN_DEFAULT_RULES,
  PermissionConfigError,
  type PermissionMode,
  type RuleSet,
  parsePermissionsConfig,
  tagRules,
} from "@crewhaus/permission-engine";
import { resolveAuth, runChatLoop } from "@crewhaus/runtime-core";
import { createSkillTool, discoverSkills } from "@crewhaus/skills-registry";
import { loadCommands } from "@crewhaus/slash-commands";
import { parseSpec } from "@crewhaus/spec";
import { spawnSubAgent } from "@crewhaus/sub-agent-spawner";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { registerMcpServer } from "@crewhaus/tool-mcp";
import { createTaskTool } from "@crewhaus/tool-task";

/**
 * crewhaus — slice-scope CLI.
 * Subcommands:
 *   compile <spec.yaml> -o <out-dir>     parse → IR → emit bundle to disk
 *   run <spec.yaml> [--model <model>]    compile in-memory and execute the agent
 *   init [name]                          scaffold a new crewhaus.yaml
 *   doctor                               check environment health
 *
 * Future (per catalog F4 spec-cli): deploy, eval, watch.
 *
 * User-facing messages (status, errors) go directly to stdout/stderr for clean
 * UX. The logger is for diagnostic events visible only when CREWHAUS_LOG_LEVEL
 * is set to debug (or CREWHAUS_LOG=json for machine-readable traces).
 */

const logger = createLogger({ bindings: { app: "crewhaus" } });

const COMPILE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const RUN_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "model", takesValue: true },
    { name: "permission-mode", takesValue: true },
    { name: "resume", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;

const VALID_PERMISSION_MODES = ["default", "plan", "auto", "bypass"] as const;
type CliPermissionMode = (typeof VALID_PERMISSION_MODES)[number];

function isValidPermissionMode(s: string): s is CliPermissionMode {
  return (VALID_PERMISSION_MODES as readonly string[]).includes(s);
}

const INIT_SCHEMA: ParseArgsSchema = {
  flags: [{ name: "help", short: "h" }],
};

const DOCTOR_SCHEMA: ParseArgsSchema = {
  flags: [{ name: "help", short: "h" }],
};

function usage(): never {
  process.stderr.write(
    [
      "usage: crewhaus <subcommand> [args]",
      "",
      "subcommands:",
      "  compile <spec.yaml> -o <out-dir>     compile a spec to a runnable bundle",
      "  run <spec.yaml> [--model <model>]    compile in-memory and execute the agent",
      "                  [--resume <id>]      resume a prior session (event-log replay)",
      "  init [name]                          scaffold a new crewhaus.yaml",
      "  doctor                               check environment health",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function die(message: string): never {
  process.stderr.write(`crewhaus: ${message}\n`);
  process.exit(1);
}

function parseFor(rest: ReadonlyArray<string>, schema: ParseArgsSchema): ParsedArgs {
  try {
    return parseArgs(rest, schema);
  } catch (err) {
    if (err instanceof ArgParseError) die(err.message);
    throw err;
  }
}

function runCompile(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write("usage: crewhaus compile <spec.yaml> -o <out-dir>\n");
    return;
  }
  const specPath = args.positional[0];
  const outDir = args.flags["out"];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  if (typeof outDir !== "string") die("missing -o <out-dir>");

  const absSpec = resolve(specPath);
  const absOut = resolve(outDir);
  logger.debug("compile.start", { spec: absSpec, out: absOut });

  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }

  let bundle: ReturnType<typeof compile>;
  try {
    bundle = compile(yamlText);
  } catch (err) {
    if (err instanceof SpecParseError) {
      die(err.message);
    }
    throw err;
  }

  mkdirSync(absOut, { recursive: true });
  for (const file of bundle.files) {
    const fullPath = join(absOut, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
    process.stdout.write(`wrote ${fullPath}\n`);
  }
  process.stdout.write(`compiled bundle (${bundle.files.length} file(s)) → ${absOut}\n`);
  logger.debug("compile.success", { files: bundle.files.length, out: absOut });
}

function runInit(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write("usage: crewhaus init [name]\n");
    return;
  }
  const nameArg = args.positional[0];
  const targetDir = typeof nameArg === "string" ? resolve(nameArg) : process.cwd();
  const specName = typeof nameArg === "string" ? nameArg : basename(targetDir);
  const targetFile = join(targetDir, "crewhaus.yaml");

  if (existsSync(targetFile)) {
    die(`${targetFile} already exists — refusing to overwrite`);
  }

  mkdirSync(targetDir, { recursive: true });
  const yamlText = `name: ${specName}
target: cli
agent:
  model: claude-opus-4-7
  instructions: |
    You are a helpful assistant. Replace these instructions with your
    agent's actual behavior, persona, and constraints.
`;
  writeFileSync(targetFile, yamlText);
  process.stdout.write(`wrote ${targetFile}\n`);
  process.stdout.write(`next: bun crewhaus run ${targetFile}\n`);
  logger.debug("init.success", { target: targetFile });
}

/**
 * Built-in tool name → RegisteredTool, populated lazily so that subcommands
 * which don't need tools (init, doctor) don't pay the import cost. Mirror of
 * `BUILTIN_TOOL_MAP` in packages/target-cli/src/index.ts — keep them in sync.
 */
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

/**
 * Section 14 — apply per-tool config from the IR's `toolConfigs` map by
 * calling each tool's registration function. Mirror of the codegen-emitted
 * init calls in target-cli/target-channel-bot. Keep in sync.
 */
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

/**
 * Build the layered permission rule set from the IR (yaml source) and an
 * optional `.crewhaus/settings.json` (settings source). The flag and hooks
 * sources are placeholders for future sections (no rules yet, just modes).
 *
 * All non-flag config goes through `parsePermissionsConfig` which rejects
 * `mode: bypass` (defense in depth on top of the spec parser's check).
 */
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
      die(`failed to parse ${settingsPath}: ${(err as Error).message}`);
    }
    // Section 11 introduced top-level keys (`hooks`) into settings.json.
    // Only parse the `permissions` sub-object — never the bare root —
    // so hooks/skills/slash-command keys don't trip the strict permission
    // validator. If the file has no `permissions` block, treat as empty.
    const root = (raw as { permissions?: unknown }).permissions;
    if (root !== undefined) {
      try {
        const parsed = parsePermissionsConfig(root, "settings");
        settings = tagRules(parsed.rules, "settings");
      } catch (err) {
        if (err instanceof PermissionConfigError) die(err.message);
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

async function runRun(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus run <spec.yaml> [--model <model>] [--permission-mode <default|plan|auto|bypass>] [--resume <sessionId>]\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");

  const resumeFlag = args.flags["resume"];
  let resumeId: string | undefined;
  if (typeof resumeFlag === "string") {
    if (!SESSION_ID_REGEX.test(resumeFlag)) {
      die(`invalid --resume sessionId "${resumeFlag}" — expected sess_<16 hex>`);
    }
    resumeId = resumeFlag;
  }

  const absSpec = resolve(specPath);
  logger.debug("run.start", { spec: absSpec });

  let yamlText: string;
  try {
    yamlText = readFileSync(absSpec, "utf-8");
  } catch (err) {
    die(`could not read ${absSpec}: ${(err as Error).message}`);
  }

  let ir: ReturnType<typeof lower>;
  try {
    ir = lower(parseSpec(yamlText));
  } catch (err) {
    if (err instanceof SpecParseError) die(err.message);
    throw err;
  }

  if (ir.target !== "cli") {
    die(
      `crewhaus run only supports target: cli (got "${ir.target}"). For workflow specs, compile and execute the bundle directly: bun apps/cli/src/index.ts compile <spec> -o <out> && bun <out>/agent.ts`,
    );
  }

  let tools: RegisteredTool[] = [];
  if (ir.tools.length > 0) {
    // Section 14 — apply per-tool config (e.g. registerFetchConfig) before
    // loading the tools so first-call execution sees the registered config.
    await applyToolConfigs(ir.tools, ir.toolConfigs);
    const toolMap = await loadToolMap();
    tools = ir.tools.map((name) => {
      const tool = toolMap[name];
      if (!tool) {
        const known = Object.keys(toolMap).sort().join(", ");
        die(`unknown tool "${name}" — known tools: ${known}`);
      }
      return tool;
    });
  }

  // Section 9 — connect to declared MCP servers and register their remote
  // tools alongside the built-ins. Mirror of the codegen path in
  // @crewhaus/target-cli (renderMcpServers); keep them in sync.
  let mcpHost: McpHost | undefined;
  if (Object.keys(ir.mcp_servers).length > 0) {
    const host = new McpHost({ logger });
    mcpHost = host;
    for (const [name, cfg] of Object.entries(ir.mcp_servers)) {
      host.addServer(name, cfg);
    }
    const tempCatalog = new ToolCatalog();
    for (const t of tools) tempCatalog.register(t);
    await Promise.all(
      Object.keys(ir.mcp_servers).map((name) =>
        registerMcpServer(host, name, tempCatalog, {
          onRegister: ({ fullName }) => process.stdout.write(`[mcp] registered ${fullName}\n`),
        }),
      ),
    );
    tools = tempCatalog.list().slice();
  }

  const modelOverride = args.flags["model"];
  const model = typeof modelOverride === "string" ? modelOverride : ir.agent.model;

  // Permission mode resolution: CLI flag > spec > "default".
  // bypass is reachable only via the flag (the spec parser has already
  // rejected `mode: bypass`).
  const flagMode = args.flags["permission-mode"];
  let permissionMode: PermissionMode;
  if (typeof flagMode === "string") {
    if (!isValidPermissionMode(flagMode)) {
      die(
        `invalid --permission-mode "${flagMode}" — allowed: ${VALID_PERMISSION_MODES.join(", ")}`,
      );
    }
    permissionMode = flagMode;
  } else if (ir.permissions.mode !== undefined) {
    permissionMode = ir.permissions.mode;
  } else {
    permissionMode = "default";
  }

  const permissionRules = buildRuleSet(ir.permissions.rules, process.cwd());

  // Section 11 — discover hooks, skills, and slash commands from the user's
  // workspace. Hooks come from `~/.crewhaus/settings.json` + `<cwd>/.crewhaus/settings.json`;
  // skills from `~/.crewhaus/skills/*/SKILL.md` + project-equivalent; slash
  // commands from `<cwd>/.crewhaus/commands/*.md`. When skills are present,
  // a synthetic `Skill(name)` tool is appended to the tool list so the
  // model can lazily fetch each skill's body.
  const cwd = process.cwd();
  const [hooks, skills, slashCommands] = await Promise.all([
    loadHooks({ cwd }),
    discoverSkills({ cwd }),
    loadCommands({ cwd }),
  ]);
  if (skills.length > 0) {
    tools.push(createSkillTool(skills));
    process.stdout.write(
      `[skills] ${skills.length} available: ${skills.map((s) => s.name).join(", ")}\n`,
    );
  }
  if (hooks.length > 0) process.stdout.write(`[hooks] ${hooks.length} loaded\n`);
  if (slashCommands.size > 0) {
    process.stdout.write(
      `[slash] ${slashCommands.size} commands: ${[...slashCommands.keys()].join(", ")}\n`,
    );
  }

  // Section 13 — when the IR carries inline sub-agent definitions, build the
  // registry, register the Task tool, and inject `spawnSubAgent` so the
  // runtime can populate the bridge for framework-aware tools.
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
    process.stdout.write(
      `[sub-agents] ${subAgents.size} available: ${[...subAgents.keys()].join(", ")}\n`,
    );
  }

  try {
    await runChatLoop({
      model,
      instructions: ir.agent.instructions,
      tools,
      permissionMode,
      permissionRules,
      sessionName: ir.name,
      sessionTarget: ir.target,
      hooks,
      skills,
      slashCommands,
      ...(subAgents !== undefined ? { subAgents, spawnSubAgent } : {}),
      ...(resumeId !== undefined ? { resume: { sessionId: resumeId } } : {}),
    });
  } finally {
    if (mcpHost) await mcpHost.disconnectAll();
  }
}

type DoctorCheck = { label: string; pass: boolean; reason?: string };

function checkBunVersion(version: string): { pass: boolean; reason?: string } {
  const parts = version.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return { pass: false, reason: `unparseable version "${version}"` };
  }
  const ok = major > 1 || (major === 1 && minor >= 2);
  return ok ? { pass: true } : { pass: false, reason: `bun ${version} is below minimum 1.2.0` };
}

function runDoctor(args: ParsedArgs): void {
  if (args.flags["help"]) {
    process.stdout.write("usage: crewhaus doctor\n");
    return;
  }

  const checks: DoctorCheck[] = [];

  const auth = resolveAuth(process.env);
  checks.push({
    label: "Anthropic credentials",
    pass: auth.mode !== "none",
    reason:
      auth.mode === "none"
        ? "set ANTHROPIC_AUTH_TOKEN (Claude subscription) or ANTHROPIC_API_KEY"
        : undefined,
  });

  const bunCheck = checkBunVersion(Bun.version);
  checks.push({
    label: `Bun runtime (${Bun.version})`,
    pass: bunCheck.pass,
    reason: bunCheck.reason,
  });

  const specPath = join(process.cwd(), "crewhaus.yaml");
  checks.push({
    label: "crewhaus.yaml in cwd",
    pass: existsSync(specPath),
    reason: existsSync(specPath) ? undefined : `not found at ${specPath} — run \`crewhaus init\``,
  });

  for (const c of checks) {
    if (c.pass) {
      process.stdout.write(`✓ ${c.label}\n`);
    } else {
      process.stdout.write(`✗ ${c.label}: ${c.reason ?? "failed"}\n`);
    }
  }

  const allPass = checks.every((c) => c.pass);
  process.stdout.write(allPass ? "\nall checks passed.\n" : "\nsome checks failed.\n");
  process.exit(allPass ? 0 : 1);
}

const argv = process.argv.slice(2);
const subcommand = argv[0] ?? "";
const rest = argv.slice(1);

switch (subcommand) {
  case "compile":
    runCompile(parseFor(rest, COMPILE_SCHEMA));
    break;
  case "init":
    runInit(parseFor(rest, INIT_SCHEMA));
    break;
  case "run":
    await runRun(parseFor(rest, RUN_SCHEMA));
    break;
  case "doctor":
    runDoctor(parseFor(rest, DOCTOR_SCHEMA));
    break;
  case "":
  case "-h":
  case "--help":
    usage();
    break;
  default:
    die(`unknown subcommand: ${subcommand}`);
}
