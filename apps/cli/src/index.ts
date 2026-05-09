#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import { SpecParseError, compile, lower } from "@crewhaus/compiler";
import { loadDataset } from "@crewhaus/eval-dataset";
import { parseGradersConfig } from "@crewhaus/eval-grader";
import { diffReports, loadRun, renderReport } from "@crewhaus/eval-report";
import { runEval as runEvalLib } from "@crewhaus/eval-runner";
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

const EVAL_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "dataset", takesValue: true },
    { name: "graders", takesValue: true },
    { name: "judge-model", takesValue: true },
    { name: "concurrency", takesValue: true },
    { name: "seed", takesValue: true },
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const EVAL_REPORT_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "out", short: "o", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const COST_SUMMARY_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "session", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "format", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const SECRETS_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "backend", takesValue: true },
    { name: "root-dir", takesValue: true },
    { name: "value", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const SPEC_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const DEPLOY_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "tenant", takesValue: true },
    { name: "actor", takesValue: true },
    { name: "help", short: "h" },
  ],
};

const MIGRATE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "root-dir", takesValue: true },
    { name: "from", takesValue: true },
    { name: "to", takesValue: true },
    { name: "dry-run" },
    { name: "help", short: "h" },
  ],
};

const BUILD_IMAGE_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "tag", takesValue: true },
    { name: "platform", takesValue: true },
    { name: "push" },
    { name: "help", short: "h" },
  ],
};

const CLOUD_SCHEMA: ParseArgsSchema = {
  flags: [
    { name: "provider", takesValue: true },
    { name: "region", takesValue: true },
    { name: "tier", takesValue: true },
    { name: "image-tag", takesValue: true },
    { name: "working-dir", takesValue: true },
    { name: "help", short: "h" },
  ],
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
      "  eval <spec.yaml> --dataset <data>    run the agent against a dataset and grade",
      "       --graders <graders.yaml>       (deterministic graders + LLM-as-judge)",
      "       [--judge-model <model>] [--concurrency N] [--seed N] -o <out-dir>",
      "  eval-report diff <prev> <new>        compare two eval runs and emit a diff report",
      "       [-o <out-dir>]",
      "  init [name]                          scaffold a new crewhaus.yaml",
      "  doctor                               check environment health",
      "  cost-summary --session <id>          summarize cost_accrual events for a session",
      "  secrets doctor                       list known secrets via the configured backend",
      "  secrets rotate <name> [--value V]    rotate a named secret (file or vault backend)",
      "  spec put|list|get|pin|alias ...      versioned spec storage (Section 28 spec-registry)",
      "  deploy promote|rollback ...          re-pin a spec for an environment (Section 28)",
      "  migrate-all --from N --to N          batch-migrate every spec in the registry",
      "  build-image <target> --tag <tag>     build the docker image for a target shape (Section 32)",
      "       [--platform <p>] [--push]",
      "  cloud deploy --provider <p>          deploy a managed CrewHaus cluster (Section 32)",
      "       --region <r> [--tier <t>] [--image-tag <tag>]",
      "  cloud teardown --provider <p>        tear down a managed cluster",
      "       --region <r>",
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

async function runEvalSubcommand(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus eval <spec.yaml> --dataset <data> --graders <graders.yaml> " +
        "[--judge-model <model>] [--concurrency N] [--seed N] -o <out-dir>\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");
  const datasetPath = args.flags["dataset"];
  const gradersPath = args.flags["graders"];
  const outDirArg = args.flags["out"];
  if (typeof datasetPath !== "string") die("missing --dataset <data>");
  if (typeof gradersPath !== "string") die("missing --graders <graders.yaml>");
  if (typeof outDirArg !== "string") die("missing -o <out-dir>");

  const concurrencyFlag = args.flags["concurrency"];
  const seedFlag = args.flags["seed"];
  const judgeModelFlag = args.flags["judge-model"];
  const concurrency =
    typeof concurrencyFlag === "string" ? Number.parseInt(concurrencyFlag, 10) : undefined;
  const seed = typeof seedFlag === "string" ? Number.parseInt(seedFlag, 10) : undefined;
  if (concurrency !== undefined && (Number.isNaN(concurrency) || concurrency < 1)) {
    die(`invalid --concurrency "${concurrencyFlag}" — must be positive integer`);
  }
  if (seed !== undefined && Number.isNaN(seed)) {
    die(`invalid --seed "${seedFlag}" — must be integer`);
  }

  const absSpec = resolve(specPath);
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
    die(`crewhaus eval only supports target: cli (got "${ir.target}")`);
  }

  let gradersYaml: string;
  try {
    gradersYaml = readFileSync(resolve(gradersPath), "utf-8");
  } catch (err) {
    die(`could not read ${gradersPath}: ${(err as Error).message}`);
  }
  const { compiled } = parseGradersConfig(gradersYaml);
  const dataset = await loadDataset(resolve(datasetPath));

  const absOut = resolve(outDirArg);
  process.stdout.write(`[eval] running ${dataset.name}: ${compiled.length} graders → ${absOut}\n`);

  const summary = await runEvalLib({
    ir,
    dataset,
    compiledGraders: compiled,
    opts: {
      outDir: absOut,
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(seed !== undefined ? { seed } : {}),
      ...(typeof judgeModelFlag === "string" ? { judgeModel: judgeModelFlag } : {}),
    },
  });

  // Render report
  const loaded = await loadRun(absOut);
  const rendered = renderReport(loaded);
  writeFileSync(join(absOut, "index.html"), rendered.html);

  process.stdout.write(
    `[eval] runId=${summary.runId} pass_rate=${(summary.aggregates.passRate * 100).toFixed(1)}% ` +
      `mean_score=${summary.aggregates.meanScore.toFixed(3)} ` +
      `errors=${summary.aggregates.errorCount} ` +
      `tokens=${summary.aggregates.totalTokens.input}/${summary.aggregates.totalTokens.output}\n`,
  );
  process.stdout.write(`[eval] report: ${join(absOut, "index.html")}\n`);
}

async function runEvalReport(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write("usage: crewhaus eval-report diff <prev> <new> [-o <out-dir>]\n");
    return;
  }
  const action = args.positional[0];
  if (action !== "diff") die(`eval-report: unknown action "${action ?? ""}" — supported: diff`);

  const prev = args.positional[1];
  const next = args.positional[2];
  if (typeof prev !== "string" || typeof next !== "string") {
    die("eval-report diff: missing <prev> <new>");
  }

  const outArg = args.flags["out"];
  const prevLoaded = await loadRun(prev);
  const nextLoaded = await loadRun(next);
  const result = diffReports(prevLoaded, nextLoaded);

  if (typeof outArg === "string") {
    const absOut = resolve(outArg);
    mkdirSync(absOut, { recursive: true });
    writeFileSync(join(absOut, "index.html"), result.html);
    writeFileSync(join(absOut, "diff.json"), result.json);
    process.stdout.write(`[eval-report] diff: ${join(absOut, "index.html")}\n`);
  } else {
    process.stdout.write(result.html);
  }
  process.stdout.write(
    `[eval-report] regressions=${result.diff.regressions.length} ` +
      `recoveries=${result.diff.recoveries.length} ` +
      `score_shifts=${result.diff.scoreShifts.length} ` +
      `unchanged=${result.diff.unchanged}\n`,
  );
}

/**
 * Section 27 — `crewhaus cost-summary [--session <id>] [--tenant <id>]
 * [--format json|text]`. Reads `cost_accrual` events out of an `event-log`
 * (or aggregates the per-day audit-log records) and prints a USD summary.
 *
 * v0 ships with the per-session readout — pass `--session <id>` to read
 * the JSONL transcript at `.crewhaus/sessions/<id>.jsonl` and aggregate
 * the cost_accrual events embedded in there. Tenant aggregation lands in
 * §31's studio-server cost dashboard.
 */
async function runCostSummary(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write("usage: crewhaus cost-summary --session <id> [--format json|text]\n");
    return;
  }
  const session = args.flags["session"];
  const format = args.flags["format"] ?? "text";
  if (typeof session !== "string") die("missing --session <id>");

  const sessionFile = join(process.cwd(), ".crewhaus", "sessions", `${session}.jsonl`);
  if (!existsSync(sessionFile)) {
    die(`session log not found at ${sessionFile}`);
  }
  const lines = readFileSync(sessionFile, "utf-8")
    .split("\n")
    .filter((l) => l !== "");
  let totalMicros = 0;
  const byProvider: Record<string, number> = {};
  let count = 0;
  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "kind" in parsed &&
      (parsed as { kind?: string }).kind === "cost_accrual"
    ) {
      const e = parsed as unknown as {
        provider: string;
        costUsdMicros: number;
      };
      totalMicros += e.costUsdMicros;
      byProvider[e.provider] = (byProvider[e.provider] ?? 0) + e.costUsdMicros;
      count++;
    }
  }
  const totalDollars = totalMicros / 1_000_000;
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({ session, count, totalUsdMicros: totalMicros, byProvider })}\n`,
    );
  } else {
    process.stdout.write(`session: ${session}\n`);
    process.stdout.write(`accrual events: ${count}\n`);
    process.stdout.write(`total: $${totalDollars.toFixed(4)}\n`);
    for (const [p, m] of Object.entries(byProvider)) {
      process.stdout.write(`  ${p}: $${(m / 1_000_000).toFixed(4)}\n`);
    }
  }
}

/**
 * Section 27 — `crewhaus secrets <action> <name> [opts]`. Two actions:
 *   doctor                 list configured secrets and report missing
 *   rotate <name>          rotate the named secret (file or vault backends)
 */
async function runSecrets(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus secrets doctor [--backend env-var|file|vault] [--root-dir <dir>]\n" +
        "  crewhaus secrets rotate <name> [--value <new-value>] [--backend ...]\n",
    );
    return;
  }
  const backendIdFlag = args.flags["backend"];
  const backendId = typeof backendIdFlag === "string" ? backendIdFlag : "env-var";
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "secrets");
  const { createSecrets, createEnvVarBackend, createFileBackend } = await import(
    "@crewhaus/secrets-manager"
  );
  const backend = backendId === "file" ? createFileBackend({ rootDir }) : createEnvVarBackend();
  const secrets = createSecrets({ backend });

  if (action === "doctor") {
    const known = (await backend.list?.()) ?? [];
    process.stdout.write(`backend: ${backend.id}\n`);
    process.stdout.write(`known: ${known.length} secret(s)\n`);
    for (const n of known) process.stdout.write(`  - ${n}\n`);
    return;
  }

  if (action === "rotate") {
    const name = args.positional[0];
    if (typeof name !== "string") die("missing <name>");
    const value = args.flags["value"];
    const newValue = await secrets.rotate(name, {
      ...(typeof value === "string" ? { newValue: value } : {}),
    });
    process.stdout.write(`rotated ${name} (${newValue.length} chars) via ${backend.id} backend\n`);
    return;
  }

  die(`unknown secrets action "${action}" (expected: doctor | rotate)`);
}

/**
 * Section 28 — `crewhaus spec <action> ...` subcommands wrap the
 * spec-registry. Actions: put / get / list / pin / alias.
 */
async function runSpec(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus spec put <name> <version> <spec.yaml> [--root-dir <dir>]\n" +
        "  crewhaus spec list <name>                                   list versions\n" +
        "  crewhaus spec get <name> <version>                          print yaml\n" +
        "  crewhaus spec pin <name> <env> <version> [--tenant <id>]   pin env → version\n" +
        "  crewhaus spec alias <name> <env> [--tenant <id>]            resolve env → version\n",
    );
    return;
  }
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "specs");
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  const reg = createFileBackedRegistry({ rootDir });
  const tenantFlag = args.flags["tenant"];
  const tenantId = typeof tenantFlag === "string" ? tenantFlag : undefined;

  if (action === "put") {
    const name = args.positional[0];
    const version = args.positional[1];
    const filePath = args.positional[2];
    if (typeof name !== "string") die("missing <name>");
    if (typeof version !== "string") die("missing <version>");
    if (typeof filePath !== "string") die("missing <spec.yaml>");
    const yaml = readFileSync(resolve(filePath), "utf-8");
    await reg.put(name, version, yaml);
    process.stdout.write(`stored ${name}@${version} (${yaml.length} bytes)\n`);
    return;
  }
  if (action === "list") {
    const name = args.positional[0];
    if (typeof name !== "string") die("missing <name>");
    const versions = await reg.list(name);
    for (const v of versions) process.stdout.write(`${v}\n`);
    return;
  }
  if (action === "get") {
    const name = args.positional[0];
    const version = args.positional[1];
    if (typeof name !== "string") die("missing <name>");
    if (typeof version !== "string") die("missing <version>");
    process.stdout.write(await reg.get(name, version));
    return;
  }
  if (action === "pin") {
    const name = args.positional[0];
    const env = args.positional[1];
    const version = args.positional[2];
    if (typeof name !== "string") die("missing <name>");
    if (typeof env !== "string") die("missing <env>");
    if (typeof version !== "string") die("missing <version>");
    if (tenantId !== undefined) {
      await reg.pinForTenant(tenantId, name, env, version);
      process.stdout.write(`pinned tenant=${tenantId} ${name} ${env} → ${version}\n`);
    } else {
      await reg.pin(name, env, version);
      process.stdout.write(`pinned ${name} ${env} → ${version}\n`);
    }
    return;
  }
  if (action === "alias") {
    const name = args.positional[0];
    const env = args.positional[1];
    if (typeof name !== "string") die("missing <name>");
    if (typeof env !== "string") die("missing <env>");
    const v =
      tenantId !== undefined
        ? await reg.aliasForTenant(tenantId, name, env)
        : await reg.aliasFor(name, env);
    if (!v) die(`no pin for ${name} ${env}`);
    process.stdout.write(`${v}\n`);
    return;
  }
  die(`unknown spec action "${action}" (expected: put | list | get | pin | alias)`);
}

/**
 * Section 28 — `crewhaus deploy <action> ...` subcommands wrap the
 * deployment-controller. Actions: promote / rollback.
 */
async function runDeploy(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage:\n" +
        "  crewhaus deploy promote <name> <fromEnv> <toEnv>  copy env pin\n" +
        "  crewhaus deploy rollback <name> <env> <version>   re-pin env to version\n",
    );
    return;
  }
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "specs");
  const auditDir = join(process.cwd(), ".crewhaus", "audit");
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  const { openAuditLog } = await import("@crewhaus/audit-log");
  const { createDeploymentController } = await import("@crewhaus/deployment-controller");
  const reg = createFileBackedRegistry({ rootDir });
  const audit = await openAuditLog({ rootDir: auditDir });
  const tenantFlag = args.flags["tenant"];
  const actorFlag = args.flags["actor"];
  const tenantId = typeof tenantFlag === "string" ? tenantFlag : undefined;
  const actor = typeof actorFlag === "string" ? actorFlag : undefined;
  const ctrl = createDeploymentController({
    registry: reg,
    auditLog: audit,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(actor !== undefined ? { actor } : {}),
  });

  if (action === "promote") {
    const name = args.positional[0];
    const fromEnv = args.positional[1];
    const toEnv = args.positional[2];
    if (typeof name !== "string") die("missing <name>");
    if (typeof fromEnv !== "string") die("missing <fromEnv>");
    if (typeof toEnv !== "string") die("missing <toEnv>");
    const rec = await ctrl.promote(name, fromEnv, toEnv);
    process.stdout.write(
      `promoted ${name} ${fromEnv} → ${toEnv} (now pinned to ${rec.toVersion})\n`,
    );
    return;
  }
  if (action === "rollback") {
    const name = args.positional[0];
    const env = args.positional[1];
    const version = args.positional[2];
    if (typeof name !== "string") die("missing <name>");
    if (typeof env !== "string") die("missing <env>");
    if (typeof version !== "string") die("missing <version>");
    const rec = await ctrl.rollback(name, env, version);
    process.stdout.write(
      `rolled back ${name} ${env} → ${version} (was ${rec.fromVersion ?? "unset"})\n`,
    );
    return;
  }
  die(`unknown deploy action "${action}" (expected: promote | rollback)`);
}

/**
 * Section 28 — `crewhaus migrate-all --from <ver> --to <ver> [--dry-run]`.
 * Walks every spec in the registry and applies the migration chain.
 */
async function runMigrateAll(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      "usage: crewhaus migrate-all --from <ver> --to <ver> [--dry-run] [--root-dir <dir>]\n",
    );
    return;
  }
  const fromFlag = args.flags["from"];
  const toFlag = args.flags["to"];
  if (typeof fromFlag !== "string") die("missing --from <ver>");
  if (typeof toFlag !== "string") die("missing --to <ver>");
  const fromVersion = Number.parseInt(fromFlag, 10);
  const toVersion = Number.parseInt(toFlag, 10);
  if (Number.isNaN(fromVersion) || Number.isNaN(toVersion)) {
    die("--from / --to must be integers");
  }
  const rootDirFlag = args.flags["root-dir"];
  const rootDir =
    typeof rootDirFlag === "string" ? rootDirFlag : join(process.cwd(), ".crewhaus", "specs");
  const dryRun = args.flags["dry-run"] === true;
  const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
  const { createDefaultEngine } = await import("@crewhaus/migration-engine");
  const { migrateAll } = await import("@crewhaus/migration-runner");
  const result = await migrateAll({
    registry: createFileBackedRegistry({ rootDir }),
    engine: createDefaultEngine(),
    fromVersion,
    toVersion,
    dryRun,
  });
  for (const item of result.plan) {
    const arrow = item.newVersion ? ` → ${item.newVersion}` : "";
    const err = item.error ? `   ERROR: ${item.error}` : "";
    process.stdout.write(
      `${item.action.padEnd(15)} ${item.name}@${item.latestVersion}${arrow}${err}\n`,
    );
  }
  const dryNote = dryRun ? " (dry-run)" : "";
  process.stdout.write(
    `[migrate-all] migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed}${dryNote}\n`,
  );
  if (result.failed > 0) process.exit(1);
}

/**
 * Section 32 — `crewhaus build-image <target> --tag <tag> [--platform <p>] [--push]`.
 * Wraps `docker buildx build` for the per-target Dockerfiles in
 * @crewhaus/docker-images.
 */
async function runBuildImage(rest: ReadonlyArray<string>): Promise<void> {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined) continue;
    if (a === "--help" || a === "-h") {
      process.stdout.write(
        "usage: crewhaus build-image <target> --tag <tag> [--platform <p>] [--push]\n",
      );
      return;
    }
    if (a === "--push") {
      flags.set("push", true);
      continue;
    }
    if (a === "--tag" || a === "--platform") {
      const v = rest[i + 1];
      if (typeof v !== "string") die(`${a} requires a value`);
      flags.set(a.slice(2), v);
      i++;
      continue;
    }
    positional.push(a);
  }
  const target = positional[0];
  if (typeof target !== "string") die("missing <target> (one of cli, workflow, channel, ...)");
  const tag = flags.get("tag");
  if (typeof tag !== "string") die("missing --tag <tag>");
  const platform = flags.get("platform");
  const push = flags.get("push") === true;

  const { buildImage, isTargetShape } = await import("@crewhaus/docker-images");
  if (!isTargetShape(target)) {
    die(`unknown target shape: ${target}`);
  }
  try {
    const result = await buildImage({
      target,
      tag,
      platform: typeof platform === "string" ? platform : undefined,
      push,
    });
    process.stdout.write(`built crewhaus/${result.target}:${result.tag}\n`);
  } catch (err) {
    die(`build-image: ${(err as Error).message}`);
  }
}

/**
 * Section 32 — `crewhaus cloud deploy|teardown --provider <p> --region <r>`.
 * Composite recipe: terraform-up + helm-chart + kustomize overlay.
 */
async function runCloud(args: ParsedArgs, action: string): Promise<void> {
  if (args.flags["help"]) {
    process.stdout.write(
      `usage: crewhaus cloud ${action} --provider <aws|gcp|azure|aws-localstack> --region <r> [--tier <dev|default|production>] [--image-tag <tag>]\n`,
    );
    return;
  }
  const provider = args.flags["provider"];
  const region = args.flags["region"];
  if (typeof provider !== "string") die("missing --provider");
  if (typeof region !== "string") die("missing --region");
  const tierFlag = args.flags["tier"];
  const imageTagFlag = args.flags["image-tag"];
  const workingDirFlag = args.flags["working-dir"];

  const cloudMod = await import("@crewhaus/crewhaus-cloud");
  if (!cloudMod.isCloudProvider(provider)) {
    die(`unknown provider: ${provider} (allowed: ${cloudMod.listProviders().join(", ")})`);
  }
  const config = {
    ...cloudMod.defaultCloudConfig(provider, region),
    ...(typeof tierFlag === "string" ? { tier: tierFlag as "dev" | "default" | "production" } : {}),
    ...(typeof imageTagFlag === "string" ? { imageTag: imageTagFlag } : {}),
  };

  if (action === "deploy") {
    const result = await cloudMod.deployCloud({
      config,
      workingDir: typeof workingDirFlag === "string" ? workingDirFlag : undefined,
    });
    process.stdout.write(`${cloudMod.summariseDeploy(result)}\n`);
    return;
  }
  if (action === "teardown") {
    await cloudMod.teardownCloud({
      config,
      workingDir: typeof workingDirFlag === "string" ? workingDirFlag : undefined,
    });
    process.stdout.write(`teardown complete for ${config.clusterName}\n`);
    return;
  }
  die(`unknown cloud action "${action}" (expected: deploy | teardown)`);
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
  case "eval":
    await runEvalSubcommand(parseFor(rest, EVAL_SCHEMA));
    break;
  case "eval-report":
    await runEvalReport(parseFor(rest, EVAL_REPORT_SCHEMA));
    break;
  case "doctor":
    runDoctor(parseFor(rest, DOCTOR_SCHEMA));
    break;
  case "cost-summary":
    await runCostSummary(parseFor(rest, COST_SUMMARY_SCHEMA));
    break;
  case "secrets": {
    const action = rest[0] ?? "";
    if (action !== "doctor" && action !== "rotate") {
      die(`secrets action must be "doctor" or "rotate" (got "${action}")`);
    }
    await runSecrets(parseFor(rest.slice(1), SECRETS_SCHEMA), action);
    break;
  }
  case "spec": {
    const action = rest[0] ?? "";
    if (!["put", "list", "get", "pin", "alias"].includes(action)) {
      die(`spec action must be one of: put, list, get, pin, alias (got "${action}")`);
    }
    await runSpec(parseFor(rest.slice(1), SPEC_SCHEMA), action);
    break;
  }
  case "deploy": {
    const action = rest[0] ?? "";
    if (action !== "promote" && action !== "rollback") {
      die(`deploy action must be "promote" or "rollback" (got "${action}")`);
    }
    await runDeploy(parseFor(rest.slice(1), DEPLOY_SCHEMA), action);
    break;
  }
  case "migrate-all":
    await runMigrateAll(parseFor(rest, MIGRATE_SCHEMA));
    break;
  case "build-image":
    await runBuildImage(rest);
    break;
  case "cloud": {
    const action = rest[0] ?? "";
    if (action !== "deploy" && action !== "teardown") {
      die(`cloud action must be "deploy" or "teardown" (got "${action}")`);
    }
    await runCloud(parseFor(rest.slice(1), CLOUD_SCHEMA), action);
    break;
  }
  case "":
  case "-h":
  case "--help":
    usage();
    break;
  default:
    die(`unknown subcommand: ${subcommand}`);
}
