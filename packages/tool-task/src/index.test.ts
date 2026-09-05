import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ParentRunHandle,
  RuntimeBridge,
  SpawnSubAgentFn,
  SpawnSubAgentOptions,
  SubAgentDefinition,
  SubAgentResult,
} from "@crewhaus/agent-context-isolation";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import { emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  BUILTIN_GENERAL_PURPOSE,
  createTaskTool,
  parseSubAgentFile,
  resolveSubAgentDefinition,
} from "./index.js";

function newTempDir(): string {
  return mkdtempSync(join(tmpdir(), "tool-task-"));
}

function makeReadTool(): RegisteredTool {
  return buildTool({
    name: "Read",
    description: "read",
    inputSchema: z.object({}),
    execute: async () => "ok",
    readOnly: true,
    concurrencySafe: true,
  });
}

function makeBashTool(): RegisteredTool {
  return buildTool({
    name: "Bash",
    description: "shell",
    inputSchema: z.object({}),
    execute: async () => "ok",
    destructive: true,
  });
}

async function makeBridge(
  rootDir: string,
  spawn: SpawnSubAgentFn,
  parentTools: ReadonlyArray<RegisteredTool>,
): Promise<{ bridge: RuntimeBridge; close: () => Promise<void> }> {
  const ac = new AbortController();
  const runContext = createRunContext({ abortSignal: ac.signal });
  const eventLog: EventLog = await openEventLog(runContext.sessionId, { rootDir });
  const parent: ParentRunHandle = {
    runContext,
    eventLog,
    permissionMode: "default",
    permissionRules: { ...emptyRuleSet },
    tools: parentTools,
    model: "test-model",
    maxTokens: 1024,
    sessionRootDir: rootDir,
  };
  const bridge: RuntimeBridge = {
    ...parent,
    hooks: [],
    spawnSubAgent: spawn,
  };
  return {
    bridge,
    close: async () => {
      await eventLog.close();
    },
  };
}

describe("parseSubAgentFile", () => {
  test("extracts frontmatter and body", () => {
    const content = `---
name: code-reviewer
description: reviews code thoroughly
tools:
  - Read
  - Grep
---
You are a code reviewer.`;
    const def = parseSubAgentFile(content);
    expect(def.name).toBe("code-reviewer");
    expect(def.description).toBe("reviews code thoroughly");
    expect(def.tools).toEqual(["Read", "Grep"]);
    expect(def.instructions).toBe("You are a code reviewer.");
  });

  test("rejects missing frontmatter", () => {
    expect(() => parseSubAgentFile("just body, no fm")).toThrow(/frontmatter delimiter/);
  });

  test("rejects unterminated frontmatter", () => {
    expect(() => parseSubAgentFile("---\nname: x\ndescription: y")).toThrow(/never terminated/);
  });

  test("rejects empty body", () => {
    expect(() =>
      parseSubAgentFile(`---
name: x
description: y
---
`),
    ).toThrow(/empty body/);
  });

  test("falls back to file name when name is omitted from frontmatter", () => {
    // The schema requires name explicitly so this raises a validation error;
    // confirm the error path is hit cleanly.
    expect(() =>
      parseSubAgentFile(
        `---
description: missing name
---
body`,
        "fallback",
      ),
    ).toThrow(/name/);
  });
});

describe("resolveSubAgentDefinition", () => {
  test("inline map wins over disk + builtin", () => {
    const inline: SubAgentDefinition = {
      name: "summarizer",
      description: "inline def",
      instructions: "summarize.",
      tools: [],
    };
    const out = resolveSubAgentDefinition("summarizer", {
      subAgents: new Map([["summarizer", inline]]),
    });
    expect(out).toBe(inline);
  });

  test("falls back to disk when not in inline map", () => {
    const dir = newTempDir();
    try {
      writeFileSync(
        join(dir, "ondisk.md"),
        `---
name: ondisk
description: from disk
---
disk instructions`,
      );
      const out = resolveSubAgentDefinition("ondisk", { subAgentDir: dir });
      expect(out.name).toBe("ondisk");
      expect(out.instructions).toBe("disk instructions");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to general-purpose for that exact name", () => {
    const out = resolveSubAgentDefinition("general-purpose", {});
    expect(out).toBe(BUILTIN_GENERAL_PURPOSE);
  });

  test("undefined subagent_type → general-purpose", () => {
    const out = resolveSubAgentDefinition(undefined, {});
    expect(out.name).toBe("general-purpose");
  });

  test("unknown name with no inline + no disk + not general-purpose → throws", () => {
    expect(() =>
      resolveSubAgentDefinition("nonexistent", { subAgentDir: "/tmp/does-not-exist-xyz" }),
    ).toThrow(/unknown subagent_type/);
  });

  // SECURITY: subagent_type is model-filled and becomes `join(dir, name+".md")`,
  // so an unsanitized `..`/separator escapes the sub-agent dir and loads an
  // arbitrary host .md as a sub-agent definition. Must be rejected.
  test.each([
    "../../../../etc/passwd",
    "../sibling",
    "foo/bar",
    "foo\\bar",
    "..",
    ".",
    "a/../../b",
  ])("rejects path-traversal subagent_type %p", (evil) => {
    expect(() =>
      resolveSubAgentDefinition(evil, { subAgentDir: "/tmp/does-not-exist-xyz" }),
    ).toThrow(/invalid subagent_type/);
  });

  test("path-traversal is rejected even when an inline map is present (disk path is the sink)", () => {
    expect(() =>
      resolveSubAgentDefinition("../../tmp/evil", {
        subAgents: new Map(),
        subAgentDir: "/tmp/does-not-exist-xyz",
      }),
    ).toThrow(/invalid subagent_type/);
  });

  test("ordinary names with dots that are not traversal still resolve via disk", () => {
    const dir = newTempDir();
    try {
      writeFileSync(
        join(dir, "my.agent.md"),
        "---\nname: my.agent\ndescription: d\n---\ndo the thing\n",
      );
      const out = resolveSubAgentDefinition("my.agent", { subAgentDir: dir });
      expect(out.name).toBe("my.agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createTaskTool — execute round-trip", () => {
  test("calls bridge.spawnSubAgent with resolved def + filtered tools, returns finalMessage", async () => {
    const root = newTempDir();
    try {
      const calls: SpawnSubAgentOptions[] = [];
      const spawn: SpawnSubAgentFn = mock(async (_parent, opts) => {
        calls.push(opts);
        return {
          finalMessage: `child saw: ${opts.prompt}`,
          transcript: [],
          toolCalls: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        } satisfies SubAgentResult;
      });
      const parentTools = [makeReadTool(), makeBashTool()];
      const { bridge, close } = await makeBridge(root, spawn, parentTools);

      const inline: SubAgentDefinition = {
        name: "code-reviewer",
        description: "scoped reviewer",
        instructions: "review",
        tools: ["Read"],
        permissions: "scoped",
      };
      const tool = createTaskTool({ subAgents: new Map([["code-reviewer", inline]]) });

      const result = await tool.execute(
        { description: "review", prompt: "look at this", subagent_type: "code-reviewer" },
        { bridge },
      );

      expect(result).toBe("child saw: look at this");
      expect(calls).toHaveLength(1);
      const called = calls[0];
      expect(called?.def).toBe(inline);
      expect(called?.permissionMode).toBe("default");
      // Bash filtered out, only Read survives.
      expect(called?.childTools.map((t) => t.name)).toEqual(["Read"]);
      await close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns clean error when bridge is missing", async () => {
    const tool = createTaskTool({});
    const result = await tool.execute({ description: "x", prompt: "y" }, { signal: undefined });
    expect(result).toContain("[Task error]");
    expect(result).toContain("runtime bridge");
  });

  test("returns error result on unknown subagent_type", async () => {
    const root = newTempDir();
    try {
      const spawn: SpawnSubAgentFn = mock(async () => {
        throw new Error("should not be called");
      });
      const { bridge, close } = await makeBridge(root, spawn, []);
      const tool = createTaskTool({ subAgentDir: "/tmp/nope-xyz-doesntexist" });
      const result = await tool.execute(
        { description: "x", prompt: "y", subagent_type: "ghost" },
        { bridge },
      );
      expect(result).toContain("[Task error]");
      expect(result).toContain("ghost");
      await close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("filesystem fallback resolves a sub-agent definition from .crewhaus/sub-agents", async () => {
    const root = newTempDir();
    const subAgentDir = join(root, "subs");
    mkdirSync(subAgentDir, { recursive: true });
    writeFileSync(
      join(subAgentDir, "fooagent.md"),
      `---
name: fooagent
description: hello
tools:
  - Read
permissions: scoped
---
Be brief.`,
    );
    try {
      let captured: SubAgentDefinition | undefined;
      const spawn: SpawnSubAgentFn = mock(async (_p, opts) => {
        captured = opts.def;
        return {
          finalMessage: "ok",
          transcript: [],
          toolCalls: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      });
      const { bridge, close } = await makeBridge(root, spawn, [makeReadTool()]);
      const tool = createTaskTool({ subAgentDir });
      const result = await tool.execute(
        { description: "x", prompt: "y", subagent_type: "fooagent" },
        { bridge },
      );
      expect(result).toBe("ok");
      expect(captured?.name).toBe("fooagent");
      expect(captured?.instructions).toBe("Be brief.");
      expect(captured?.tools).toEqual(["Read"]);
      await close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("def.tools=[] yields empty child catalog (full permission isolation)", async () => {
    const root = newTempDir();
    try {
      let captured: ReadonlyArray<RegisteredTool> | undefined;
      const spawn: SpawnSubAgentFn = mock(async (_p, opts) => {
        captured = opts.childTools;
        return {
          finalMessage: "denied",
          transcript: [],
          toolCalls: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        };
      });
      const parentTools = [makeReadTool(), makeBashTool()];
      const { bridge, close } = await makeBridge(root, spawn, parentTools);
      const inline: SubAgentDefinition = {
        name: "no-tools",
        description: "no tools",
        instructions: "x",
        tools: [],
        permissions: "scoped",
      };
      const tool = createTaskTool({ subAgents: new Map([["no-tools", inline]]) });
      await tool.execute({ description: "x", prompt: "y", subagent_type: "no-tools" }, { bridge });
      expect(captured).toEqual([]);
      await close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("metadata: concurrencySafe=true, readOnly=false, destructive=false", () => {
    const tool = createTaskTool();
    expect(tool.name).toBe("Task");
    expect(tool.concurrencySafe).toBe(true);
    expect(tool.readOnly).toBe(false);
    expect(tool.destructive).toBe(false);
  });
});

describe("createTaskTool — concurrencyClassifier (per-call parallel eligibility)", () => {
  const read = makeReadTool();
  const bash = makeBashTool();

  function classify(
    tool: RegisteredTool,
    input: unknown,
    catalog: ReadonlyArray<RegisteredTool>,
  ): boolean {
    const fn = tool.concurrencyClassifier;
    expect(fn).toBeDefined();
    if (fn === undefined) throw new Error("Task tool should ship a concurrencyClassifier");
    return fn(input, catalog);
  }

  const def = (name: string, extra: Partial<SubAgentDefinition> = {}): SubAgentDefinition => ({
    name,
    description: "d",
    instructions: "i",
    ...extra,
  });
  const dispatch = (subagent_type: string): unknown => ({
    description: "x",
    prompt: "y",
    subagent_type,
  });

  test("a read-only sub-agent (tools: [Read]) is parallel-safe", () => {
    const tool = createTaskTool({
      subAgents: new Map([["explorer", def("explorer", { tools: ["Read"] })]]),
    });
    expect(classify(tool, dispatch("explorer"), [read, bash])).toBe(true);
  });

  test("a sub-agent that can Bash is NOT parallel-safe", () => {
    const tool = createTaskTool({
      subAgents: new Map([["runner", def("runner", { tools: ["Read", "Bash"] })]]),
    });
    expect(classify(tool, dispatch("runner"), [read, bash])).toBe(false);
  });

  test("an inherit-the-whole-catalog child is NOT parallel-safe (catalog has Bash)", () => {
    const tool = createTaskTool({
      subAgents: new Map([["inheritor", def("inheritor", { permissions: "inherit" })]]),
    });
    expect(classify(tool, dispatch("inheritor"), [read, bash])).toBe(false);
  });

  test("a child that can spawn Task is NOT parallel-safe (Task is readOnly:false)", () => {
    const tool = createTaskTool({
      subAgents: new Map([["nested", def("nested", { tools: ["Read", "Task"] })]]),
    });
    // Include the Task tool itself in the catalog so buildChildCatalog resolves it.
    expect(classify(tool, dispatch("nested"), [read, tool])).toBe(false);
  });

  test("a child with an empty tool set is NOT parallel-safe", () => {
    const tool = createTaskTool({ subAgents: new Map([["empty", def("empty", { tools: [] })]]) });
    expect(classify(tool, dispatch("empty"), [read, bash])).toBe(false);
  });

  test("fail-closed: unknown subagent_type routes serial", () => {
    const tool = createTaskTool({ subAgentDir: "/tmp/nope-xyz-doesntexist" });
    expect(classify(tool, dispatch("ghost"), [read])).toBe(false);
  });

  test("fail-closed: malformed input (missing prompt) routes serial", () => {
    const tool = createTaskTool({
      subAgents: new Map([["explorer", def("explorer", { tools: ["Read"] })]]),
    });
    expect(classify(tool, { description: "x", subagent_type: "explorer" }, [read])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 PR 11 — the `profile` argument (allowlist-validated), the shared
// handle projection, and the frontmatter mirror (plan §7.7, §10.1, §10.2).
// ---------------------------------------------------------------------------

describe("createTaskTool — profile allowlist (0.6.0 §7.7 / §10.1)", () => {
  const spawnRecording = (calls: SpawnSubAgentOptions[], parents: ParentRunHandle[]) =>
    mock(async (parent: ParentRunHandle, opts: SpawnSubAgentOptions) => {
      calls.push(opts);
      parents.push(parent);
      return {
        finalMessage: "ok",
        transcript: [],
        toolCalls: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      } satisfies SubAgentResult;
    }) as SpawnSubAgentFn;

  const PROFILED: SubAgentDefinition = {
    name: "helper",
    description: "h",
    instructions: "i",
    tools: [],
    model: "claude-sonnet-4-6",
    allowedProfiles: [
      { profile: "fast", model: "claude-haiku-4-5" },
      { profile: "strong", model: "claude-opus-4-8" },
    ],
  };

  test("Task({profile: 'not-allowed'}) REJECTS (is_error through tool-executor) before spawning, naming the allowlist", async () => {
    const root = newTempDir();
    try {
      const calls: SpawnSubAgentOptions[] = [];
      const { bridge, close } = await makeBridge(root, spawnRecording(calls, []), []);
      const tool = createTaskTool({ subAgents: new Map([["helper", PROFILED]]) });
      await expect(
        tool.execute(
          { description: "d", prompt: "p", subagent_type: "helper", profile: "not-allowed" },
          { bridge },
        ),
      ).rejects.toThrow(
        /profile "not-allowed" is not allowed for sub-agent "helper" — allowed: fast, strong/,
      );
      expect(calls).toHaveLength(0);
      await close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an allowed profile is threaded to the spawner verbatim", async () => {
    const root = newTempDir();
    try {
      const calls: SpawnSubAgentOptions[] = [];
      const { bridge, close } = await makeBridge(root, spawnRecording(calls, []), []);
      const tool = createTaskTool({ subAgents: new Map([["helper", PROFILED]]) });
      await tool.execute(
        { description: "d", prompt: "p", subagent_type: "helper", profile: "strong" },
        { bridge },
      );
      expect(calls[0]?.profile).toBe("strong");
      // No profile → nothing threaded (the spawner's default plan).
      await tool.execute({ description: "d", prompt: "p", subagent_type: "helper" }, { bridge });
      expect("profile" in (calls[1] ?? {})).toBe(false);
      await close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without an allowlist the argument may only restate the child's own model (else the parent's)", async () => {
    const root = newTempDir();
    try {
      const calls: SpawnSubAgentOptions[] = [];
      const { bridge, close } = await makeBridge(root, spawnRecording(calls, []), []);
      const own: SubAgentDefinition = {
        ...PROFILED,
        model: "claude-sonnet-4-6",
        allowedProfiles: undefined,
      };
      const tool = createTaskTool({
        subAgents: new Map([
          ["helper", own],
          ["bare", { ...own, model: undefined, name: "bare" }],
        ]),
      });
      await tool.execute(
        { description: "d", prompt: "p", subagent_type: "helper", profile: "claude-sonnet-4-6" },
        { bridge },
      );
      expect(calls).toHaveLength(1);
      await expect(
        tool.execute(
          { description: "d", prompt: "p", subagent_type: "helper", profile: "claude-haiku-4-5" },
          { bridge },
        ),
      ).rejects.toThrow(/allowed: claude-sonnet-4-6/);
      // A model-less child runs on the parent's model — the one restatable name.
      await tool.execute(
        { description: "d", prompt: "p", subagent_type: "bare", profile: "test-model" },
        { bridge },
      );
      expect(calls).toHaveLength(2);
      await close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the description advertises `profile` only when some definition declares an allowlist", () => {
    const plain = createTaskTool({
      subAgents: new Map([["helper", { ...PROFILED, allowedProfiles: undefined }]]),
    });
    expect(plain.description).not.toContain("profile");
    const profiled = createTaskTool({ subAgents: new Map([["helper", PROFILED]]) });
    expect(profiled.description).toContain("Pass `profile`");
    expect(profiled.description).toContain("helper: fast/strong");
    // The input schema always carries it (a rejected value is the guard).
    expect(taskInputHasProfile(profiled)).toBe(true);
  });

  test("the spawner receives the ONE shared projection: the bridge's routing rides along, tool-only fields do not", async () => {
    const root = newTempDir();
    try {
      const parents: ParentRunHandle[] = [];
      const { bridge, close } = await makeBridge(root, spawnRecording([], parents), []);
      const routing = {
        served: { model: "m", wireModelId: "m", armId: "m", fromPool: false },
        budgetUsdMicros: 10,
      } as const;
      const routed: RuntimeBridge = { ...bridge, routing, askMode: "pause" };
      const tool = createTaskTool({ subAgents: new Map([["helper", PROFILED]]) });
      await tool.execute(
        { description: "d", prompt: "p", subagent_type: "helper" },
        { bridge: routed },
      );
      const parent = parents[0];
      if (parent === undefined) throw new Error("unreachable");
      expect(parent.routing).toBe(routing);
      expect(parent.askMode).toBe("pause");
      expect(parent.model).toBe("test-model");
      expect("spawnSubAgent" in parent).toBe(false);
      expect("hooks" in parent).toBe(false);
      await close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** True when the tool's model-facing input schema (zod) declares `profile`. */
function taskInputHasProfile(tool: RegisteredTool): boolean {
  const shape = (tool.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape !== undefined && "profile" in shape;
}

describe("parseSubAgentFile — the 0.6.0 routing keys (frontmatter mirror)", () => {
  test("routing quartet, params, budget_share, inherit_routing and resolved allowed_profiles map onto the runtime definition", () => {
    const def = parseSubAgentFile(`---
name: router
description: routes itself
model: claude-sonnet-4-6
thinking: { effort: low }
max_tokens: 2048
model_fallbacks: [claude-haiku-4-5]
circuit_breaker: { failureThreshold: 2 }
model_pool:
  candidates:
    - { model: claude-haiku-4-5, tags: [cheap], tools: [] }
    - { model: claude-opus-4-8, tags: [strong] }
  policy: heuristic
budget_share: 0.25
inherit_routing: true
allowed_profiles:
  - { profile: fast, model: claude-haiku-4-5, temperature: 0.2 }
  - { profile: strong, model: claude-opus-4-8, thinking: { budget_tokens: 4096 }, max_tokens: 8192 }
---
Route wisely.`);
    expect(def.thinking).toEqual({ effort: "low" });
    expect(def.maxTokens).toBe(2048);
    expect(def.modelFallbacks).toEqual(["claude-haiku-4-5"]);
    expect(def.circuitBreaker).toEqual({ failureThreshold: 2 });
    expect(def.modelPool?.policy).toBe("heuristic");
    expect(def.modelPool?.candidates[0]).toEqual({
      model: "claude-haiku-4-5",
      tags: ["cheap"],
      tools: [],
    });
    expect(def.budgetShare).toBe(0.25);
    expect(def.inheritRouting).toBe(true);
    expect(def.allowedProfiles).toEqual([
      { profile: "fast", model: "claude-haiku-4-5", temperature: 0.2 },
      {
        profile: "strong",
        model: "claude-opus-4-8",
        thinking: { budgetTokens: 4096 },
        maxTokens: 8192,
      },
    ]);
    // A file declaring none of them yields none of them (no undefined keys).
    const legacy = parseSubAgentFile("---\nname: a\ndescription: b\n---\nbody");
    expect(Object.keys(legacy).sort()).toEqual(["description", "instructions", "name"]);
    // `overlay` mirrors the IR's raw default-profile prefix: carried, not folded
    // into the body — the spawner picks it or a pinned option's per call.
    const overlaid = parseSubAgentFile(
      "---\nname: a\ndescription: b\noverlay: You are the fast lane.\n---\nbody",
    );
    expect(overlaid.overlay).toBe("You are the fast lane.");
    expect(overlaid.instructions).toBe("body");
  });

  test("malformed routing keys are rejected with the offending path", () => {
    expect(() =>
      parseSubAgentFile("---\nname: a\ndescription: b\nbudget_share: 2\n---\nbody"),
    ).toThrow(/budget_share/);
    expect(() =>
      parseSubAgentFile("---\nname: a\ndescription: b\nthinking: { effort: extreme }\n---\nbody"),
    ).toThrow(/thinking/);
    expect(() =>
      parseSubAgentFile(
        "---\nname: a\ndescription: b\nallowed_profiles: [{ profile: fast }]\n---\nbody",
      ),
    ).toThrow(/allowed_profiles/);
  });
});
