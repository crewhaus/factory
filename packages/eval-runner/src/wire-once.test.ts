/**
 * Coverage for `wireRunOnce` and its helpers (`loadToolMap`,
 * `applyToolConfigs`, `buildRuleSet`) in `wire-once.ts`.
 *
 * `wireRunOnce` is the "build the agent stack once per eval run" factory. In
 * production it spins up real tools, an MCP host (which would launch stdio
 * servers), scans the cwd for hooks/skills/slash-commands, and reads
 * `.crewhaus/settings.json`. To keep these tests deterministic and free of
 * network / child-process / cwd-scanning I/O we stub every heavy `@crewhaus/*`
 * dependency with `mock.module`:
 *
 *   - the six tool packages loaded dynamically by `loadToolMap`
 *     (`tool-fs/bash/todo/web/image/fetch`) become trivial in-memory tools;
 *   - `registerFetchConfig` / `registerWebFetchConfig` become spies so the
 *     `applyToolConfigs` branch is observable without touching real config;
 *   - `McpHost` / `registerMcpServer` become fakes that record `addServer`
 *     calls and register a namespaced tool into the passed catalog — no stdio
 *     server is spawned;
 *   - `loadHooks` / `discoverSkills` / `loadCommands` return canned data
 *     instead of scanning the filesystem; `createSkillTool` / `createTaskTool`
 *     return trivial tools.
 *
 * `@crewhaus/permission-engine` is left REAL (it is pure) except for
 * `parsePermissionsConfig`, which a single test overrides — via a captured,
 * non-recursing snapshot — to throw a NON-`PermissionConfigError` so the
 * rethrow arm of `buildRuleSet` is exercised. `ToolCatalog` is also real
 * (pure, in-memory).
 *
 * `.crewhaus/settings.json` is read from a per-test temp dir (hermetic,
 * controlled fixture I/O), never the real project tree.
 *
 * Every `mock.module` override is reinstalled to the real module in
 * `afterAll`; `mock.module` is process-global, so this file is the canonical
 * place those overrides live and they must not leak.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HookDef } from "@crewhaus/hooks-engine";
import type { IrSubAgentDefinition, IrV0 } from "@crewhaus/ir";
import type { SkillRef } from "@crewhaus/skills-registry";
import type { SlashCommand } from "@crewhaus/slash-commands";

// ── Capture real modules up front (for restoration + non-recursing delegation).
const realPermissionEngine = await import("@crewhaus/permission-engine");
const realParsePermissionsConfig = realPermissionEngine.parsePermissionsConfig;
const realMcpHost = await import("@crewhaus/mcp-host");
const realToolMcp = await import("@crewhaus/tool-mcp");
const realHooks = await import("@crewhaus/hooks-engine");
const realSkills = await import("@crewhaus/skills-registry");
const realSlash = await import("@crewhaus/slash-commands");
const realTaskTool = await import("@crewhaus/tool-task");
const realSpawner = await import("@crewhaus/sub-agent-spawner");

// ── Recording channels the stubs write to so tests can assert behaviour.
const calls = {
  addServer: [] as Array<{ name: string }>,
  registerMcpServer: [] as string[],
  loadHooksCwd: [] as Array<string | undefined>,
  discoverSkillsCwd: [] as Array<string | undefined>,
  loadCommandsCwd: [] as Array<string | undefined>,
  registerFetchConfig: [] as unknown[],
  registerWebFetchConfig: [] as unknown[],
  createSkillTool: [] as unknown[],
  createTaskTool: [] as unknown[],
};
// Per-test knobs for what the cwd-scanning stubs return.
let hooksToReturn: unknown[] = [];
let skillsToReturn: unknown[] = [];
let commandsToReturn: Array<[string, unknown]> = [];
// "real" → delegate to the captured real parser; "throwGeneric" → throw a
// plain Error (NOT a PermissionConfigError) to hit the rethrow arm.
let parseMode: "real" | "throwGeneric" = "real";

/** Minimal structurally-complete RegisteredTool (only `.name` is read here). */
function fakeTool(name: string): never {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { parse: (x: unknown) => x } as never,
    execute: async () => ({ ok: true }) as never,
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
    scope: "internal",
    requireJustification: false,
  } as never;
}

// ── Tool packages loaded dynamically by `loadToolMap`.
mock.module("@crewhaus/tool-fs", () => ({
  read: fakeTool("read"),
  write: fakeTool("write"),
  edit: fakeTool("edit"),
  glob: fakeTool("glob"),
  grep: fakeTool("grep"),
}));
mock.module("@crewhaus/tool-bash", () => ({ bash: fakeTool("bash") }));
mock.module("@crewhaus/tool-todo", () => ({ todoWrite: fakeTool("todoWrite") }));
mock.module("@crewhaus/tool-web", () => ({
  webFetch: fakeTool("webFetch"),
  webSearch: fakeTool("webSearch"),
  registerWebFetchConfig: (cfg: unknown) => {
    calls.registerWebFetchConfig.push(cfg);
  },
}));
mock.module("@crewhaus/tool-image", () => ({ readImage: fakeTool("readImage") }));
mock.module("@crewhaus/tool-fetch", () => ({
  fetch: fakeTool("fetch"),
  registerFetchConfig: (cfg: unknown) => {
    calls.registerFetchConfig.push(cfg);
  },
}));

// ── MCP host + registration (no real stdio servers).
class FakeMcpHost {
  addServer(name: string, _cfg: unknown): void {
    calls.addServer.push({ name });
  }
}
mock.module("@crewhaus/mcp-host", () => ({ ...realMcpHost, McpHost: FakeMcpHost }));
mock.module("@crewhaus/tool-mcp", () => ({
  ...realToolMcp,
  registerMcpServer: async (
    _host: unknown,
    name: string,
    catalog: { register: (t: unknown) => void },
  ) => {
    calls.registerMcpServer.push(name);
    // Register a namespaced tool so `tempCatalog.list()` reflects MCP wiring.
    catalog.register(fakeTool(`mcp__${name}__do`));
  },
}));

// ── cwd-scanning loaders → canned data.
mock.module("@crewhaus/hooks-engine", () => ({
  ...realHooks,
  loadHooks: async (opts: { cwd?: string } = {}) => {
    calls.loadHooksCwd.push(opts.cwd);
    return hooksToReturn;
  },
}));
mock.module("@crewhaus/skills-registry", () => ({
  ...realSkills,
  discoverSkills: async (opts: { cwd?: string } = {}) => {
    calls.discoverSkillsCwd.push(opts.cwd);
    return skillsToReturn;
  },
  createSkillTool: (skills: unknown) => {
    calls.createSkillTool.push(skills);
    return fakeTool("skill");
  },
}));
mock.module("@crewhaus/slash-commands", () => ({
  ...realSlash,
  loadCommands: async (opts: { cwd?: string } = {}) => {
    calls.loadCommandsCwd.push(opts.cwd);
    return new Map(commandsToReturn);
  },
}));
mock.module("@crewhaus/tool-task", () => ({
  ...realTaskTool,
  createTaskTool: (arg: unknown) => {
    calls.createTaskTool.push(arg);
    return fakeTool("task");
  },
}));

// ── permission-engine: real, except a swappable parser (non-recursing snapshot).
mock.module("@crewhaus/permission-engine", () => ({
  ...realPermissionEngine,
  parsePermissionsConfig: (raw: unknown, source: "yaml" | "settings") => {
    if (parseMode === "throwGeneric") {
      throw new TypeError("not a PermissionConfigError");
    }
    return realParsePermissionsConfig(raw, source);
  },
}));

const { wireRunOnce } = await import("./wire-once");

// ── IR fixture builder ─────────────────────────────────────────────────────
function baseIr(overrides: Partial<IrV0> = {}): IrV0 {
  return {
    version: 0,
    name: "wire-test",
    target: "cli",
    agent: { model: "claude-opus-4-7", instructions: "be helpful" },
    tools: [],
    toolConfigs: {},
    mcp_servers: {},
    permissions: { rules: [] },
    subAgents: [],
    compaction: {},
    ...overrides,
  };
}

function subAgent(overrides: Partial<IrSubAgentDefinition> = {}): IrSubAgentDefinition {
  return {
    name: "helper",
    description: "a helper",
    instructions: "help",
    tools: ["read"],
    permissions: "inherit",
    inheritBypass: false,
    ...overrides,
  };
}

const TMP_ROOTS: string[] = [];
/**
 * Make a temp cwd. When `settings` is supplied it is written verbatim to
 * `.crewhaus/settings.json` (pass already-stringified JSON, or deliberately
 * malformed text, to drive the relevant `buildRuleSet` branch).
 */
function newCwd(settings?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-wire-"));
  TMP_ROOTS.push(dir);
  if (settings !== undefined) {
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(join(dir, ".crewhaus", "settings.json"), settings, "utf-8");
  }
  return dir;
}

beforeEach(() => {
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) {
    (calls[k] as unknown[]).length = 0;
  }
  hooksToReturn = [];
  skillsToReturn = [];
  commandsToReturn = [];
  parseMode = "real";
});
afterEach(() => {
  parseMode = "real";
});
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
  // Reinstall the real modules so no override leaks into sibling suites.
  mock.module("@crewhaus/permission-engine", () => realPermissionEngine);
  mock.module("@crewhaus/mcp-host", () => realMcpHost);
  mock.module("@crewhaus/tool-mcp", () => realToolMcp);
  mock.module("@crewhaus/hooks-engine", () => realHooks);
  mock.module("@crewhaus/skills-registry", () => realSkills);
  mock.module("@crewhaus/slash-commands", () => realSlash);
  mock.module("@crewhaus/tool-task", () => realTaskTool);
  mock.module("@crewhaus/sub-agent-spawner", () => realSpawner);
});

describe("wireRunOnce — tools", () => {
  test("resolves named tools from the tool map (cwd defaults to process.cwd)", async () => {
    const ir = baseIr({ tools: ["read", "bash", "grep"] });
    // No opts.cwd → exercises the `process.cwd()` default.
    const deps = await wireRunOnce(ir);
    expect(deps.tools.map((t) => t.name)).toEqual(["read", "bash", "grep"]);
    // Each cwd-scanning loader saw the default cwd (a string, not undefined).
    expect(typeof calls.loadHooksCwd[0]).toBe("string");
    expect(calls.discoverSkillsCwd[0]).toBe(calls.loadHooksCwd[0]);
    expect(deps.model).toBe("claude-opus-4-7");
    expect(deps.instructions).toBe("be helpful");
    expect(deps.sessionName).toBe("wire-test");
    expect(deps.sessionTarget).toBe("cli");
    // No MCP / sub-agents → those optional keys are absent.
    expect(deps.mcpHost).toBeUndefined();
    expect(deps.subAgents).toBeUndefined();
    expect(deps.spawnSubAgent).toBeUndefined();
  });

  test("throws RunnerError listing known tools for an unknown tool name", async () => {
    const ir = baseIr({ tools: ["read", "nope"] });
    await expect(wireRunOnce(ir, { cwd: newCwd() })).rejects.toThrow(
      /unknown tool "nope" — known tools: /,
    );
  });

  test("applies fetch + webFetch tool configs when present (registerXConfig)", async () => {
    const ir = baseIr({
      tools: ["fetch", "webFetch"],
      toolConfigs: { fetch: { allow: ["example.com"] }, webFetch: { timeoutMs: 10 } },
    });
    await wireRunOnce(ir, { cwd: newCwd() });
    expect(calls.registerFetchConfig).toEqual([{ allow: ["example.com"] }]);
    expect(calls.registerWebFetchConfig).toEqual([{ timeoutMs: 10 }]);
  });

  test("skips config registration when the tool is present but config absent", async () => {
    const ir = baseIr({ tools: ["fetch", "webFetch"], toolConfigs: {} });
    await wireRunOnce(ir, { cwd: newCwd() });
    expect(calls.registerFetchConfig).toEqual([]);
    expect(calls.registerWebFetchConfig).toEqual([]);
  });
});

describe("wireRunOnce — MCP servers", () => {
  test("builds a shared McpHost, adds each server, registers tools", async () => {
    const ir = baseIr({
      tools: ["read"],
      mcp_servers: {
        alpha: { transport: "stdio", command: "x", args: [] },
        beta: { transport: "sse", url: "https://example.com" },
      },
    });
    const deps = await wireRunOnce(ir, { cwd: newCwd() });
    expect(deps.mcpHost).toBeInstanceOf(FakeMcpHost);
    expect(calls.addServer.map((c) => c.name).sort()).toEqual(["alpha", "beta"]);
    expect(calls.registerMcpServer.sort()).toEqual(["alpha", "beta"]);
    // The pre-existing `read` tool plus the two namespaced MCP tools are present.
    const names = deps.tools.map((t) => t.name).sort();
    expect(names).toContain("read");
    expect(names).toContain("mcp__alpha__do");
    expect(names).toContain("mcp__beta__do");
  });
});

describe("wireRunOnce — hooks / skills / slash-commands", () => {
  test("threads loaded hooks/skills/commands and appends a skill tool", async () => {
    hooksToReturn = [{ event: "PreToolUse" }];
    skillsToReturn = [{ name: "skA" }];
    commandsToReturn = [["greet", { name: "greet" }]];
    const ir = baseIr({ tools: ["read"] });
    const deps = await wireRunOnce(ir, { cwd: newCwd() });
    expect(deps.hooks).toEqual(hooksToReturn as readonly HookDef[]);
    expect(deps.skills).toEqual(skillsToReturn as readonly SkillRef[]);
    expect(deps.slashCommands.get("greet")).toEqual({ name: "greet" } as unknown as SlashCommand);
    // skills.length > 0 → a skill tool was created and pushed.
    expect(calls.createSkillTool).toHaveLength(1);
    expect(deps.tools.some((t) => t.name === "skill")).toBe(true);
  });

  test("does not append a skill tool when no skills are discovered", async () => {
    skillsToReturn = [];
    const ir = baseIr({ tools: ["read"] });
    const deps = await wireRunOnce(ir, { cwd: newCwd() });
    expect(calls.createSkillTool).toHaveLength(0);
    expect(deps.tools.some((t) => t.name === "skill")).toBe(false);
  });
});

describe("wireRunOnce — sub-agents", () => {
  test("builds a sub-agent map, attaches spawnSubAgent, pushes a task tool", async () => {
    const ir = baseIr({
      tools: ["read"],
      subAgents: [
        // model present → the `...(model !== undefined)` spread branch.
        subAgent({ name: "withModel", model: "claude-haiku", inheritBypass: true }),
        // model absent → the spread is skipped.
        subAgent({ name: "noModel", permissions: { allow: ["read"], deny: [] } }),
      ],
    });
    const deps = await wireRunOnce(ir, { cwd: newCwd() });
    expect(deps.subAgents).toBeInstanceOf(Map);
    expect(deps.subAgents?.get("withModel")?.model).toBe("claude-haiku");
    expect(deps.subAgents?.get("withModel")?.inherit_bypass).toBe(true);
    // model omitted ⇒ key not present on the definition.
    expect("model" in (deps.subAgents?.get("noModel") ?? {})).toBe(false);
    expect(deps.subAgents?.get("noModel")?.permissions).toEqual({ allow: ["read"], deny: [] });
    expect(typeof deps.spawnSubAgent).toBe("function");
    expect(deps.spawnSubAgent).toBe(realSpawner.spawnSubAgent);
    expect(calls.createTaskTool).toHaveLength(1);
    expect(deps.tools.some((t) => t.name === "task")).toBe(true);
  });
});

describe("wireRunOnce — buildRuleSet (permission rules)", () => {
  test("no settings.json → settings rules empty, yaml + builtin populated", async () => {
    const ir = baseIr({
      tools: ["read"],
      permissions: { rules: [{ type: "alwaysAllow", pattern: "Bash(ls)" }] },
    });
    const deps = await wireRunOnce(ir, { cwd: newCwd() }); // tmp cwd, no settings file
    expect(deps.permissionRules.settings).toEqual([]);
    expect(deps.permissionRules.yaml).toEqual([
      { type: "alwaysAllow", pattern: "Bash(ls)", source: "yaml" },
    ]);
    expect(deps.permissionRules.flag).toEqual([]);
    expect(deps.permissionRules.hooks).toEqual([]);
    expect(deps.permissionRules.builtin).toBe(realPermissionEngine.BUILTIN_DEFAULT_RULES);
  });

  test("settings.json with a permissions block → parsed + tagged 'settings'", async () => {
    const settings = JSON.stringify({
      permissions: { rules: [{ type: "alwaysDeny", pattern: "Bash(rm -rf /)" }] },
    });
    const ir = baseIr({ tools: ["read"] });
    const deps = await wireRunOnce(ir, { cwd: newCwd(settings) });
    expect(deps.permissionRules.settings).toEqual([
      { type: "alwaysDeny", pattern: "Bash(rm -rf /)", source: "settings" },
    ]);
  });

  test("settings.json present but without a permissions key → root undefined branch", async () => {
    const settings = JSON.stringify({ somethingElse: true });
    const ir = baseIr({ tools: ["read"] });
    const deps = await wireRunOnce(ir, { cwd: newCwd(settings) });
    expect(deps.permissionRules.settings).toEqual([]);
  });

  test("malformed settings.json → RunnerError mentioning the path", async () => {
    const ir = baseIr({ tools: ["read"] });
    await expect(wireRunOnce(ir, { cwd: newCwd("{ not json") })).rejects.toThrow(
      /failed to parse .*settings\.json/,
    );
  });

  test("PermissionConfigError from a bad permissions block → wrapped RunnerError", async () => {
    // `mode: bypass` is rejected by parsePermissionsConfig with a
    // PermissionConfigError, which buildRuleSet rewraps as a RunnerError.
    const settings = JSON.stringify({ permissions: { mode: "bypass", rules: [] } });
    const ir = baseIr({ tools: ["read"] });
    await expect(wireRunOnce(ir, { cwd: newCwd(settings) })).rejects.toThrow(
      /eval-runner: .*bypass mode cannot be set/,
    );
  });

  test("a non-PermissionConfigError from the parser is rethrown verbatim", async () => {
    parseMode = "throwGeneric";
    const settings = JSON.stringify({ permissions: { rules: [] } });
    const ir = baseIr({ tools: ["read"] });
    // Not wrapped in RunnerError → the raw TypeError surfaces.
    await expect(wireRunOnce(ir, { cwd: newCwd(settings) })).rejects.toThrow(
      "not a PermissionConfigError",
    );
  });
});
