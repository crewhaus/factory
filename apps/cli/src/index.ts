#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { SpecParseError, compile, lower } from "@crewhaus/compiler";
import {
  ArgParseError,
  type ParseArgsSchema,
  type ParsedArgs,
  parseArgs,
} from "@crewhaus/infra-utils";
import { createLogger } from "@crewhaus/logging";
import {
  BUILTIN_DEFAULT_RULES,
  PermissionConfigError,
  type PermissionMode,
  type RuleSet,
  parsePermissionsConfig,
  tagRules,
} from "@crewhaus/permission-engine";
import { resolveAuth, runChatLoop } from "@crewhaus/runtime-core";
import { parseSpec } from "@crewhaus/spec";
import type { RegisteredTool } from "@crewhaus/tool-catalog";

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
    { name: "help", short: "h" },
  ],
};

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
  const [fs, bash, todo] = await Promise.all([
    import("@crewhaus/tool-fs"),
    import("@crewhaus/tool-bash"),
    import("@crewhaus/tool-todo"),
  ]);
  return {
    read: fs.read,
    write: fs.write,
    edit: fs.edit,
    glob: fs.glob,
    grep: fs.grep,
    bash: bash.bash,
    todoWrite: todo.todoWrite,
  };
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
    const root = (raw as { permissions?: unknown }).permissions ?? raw;
    try {
      const parsed = parsePermissionsConfig(root, "settings");
      settings = tagRules(parsed.rules, "settings");
    } catch (err) {
      if (err instanceof PermissionConfigError) die(err.message);
      throw err;
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
      "usage: crewhaus run <spec.yaml> [--model <model>] [--permission-mode <default|plan|auto|bypass>]\n",
    );
    return;
  }
  const specPath = args.positional[0];
  if (typeof specPath !== "string") die("missing <spec.yaml>");

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

  await runChatLoop({
    model,
    instructions: ir.agent.instructions,
    tools,
    permissionMode,
    permissionRules,
  });
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
