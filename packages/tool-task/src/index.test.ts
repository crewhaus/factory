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
