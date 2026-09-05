import { describe, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import { type RuleSet, emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { createStore } from "@crewhaus/state-store";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  type ParentRunHandle,
  type RuntimeBridge,
  type SubAgentDefinition,
  createIsolatedContext,
  projectParentHandle,
  subAgentDefinitionFromIr,
  subAgentProfileAllowlist,
} from "./index.js";

function newTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-context-isolation-"));
}

async function makeParent(rootDir: string): Promise<{
  parent: ParentRunHandle;
  parentLog: EventLog;
  cleanup: () => void;
}> {
  const ac = new AbortController();
  const runContext = createRunContext({ abortSignal: ac.signal });
  const eventLog = await openEventLog(runContext.sessionId, { rootDir });
  const rules: RuleSet = { ...emptyRuleSet };
  const parent: ParentRunHandle = {
    runContext,
    eventLog,
    permissionMode: "default",
    permissionRules: rules,
    tools: [] as ReadonlyArray<RegisteredTool>,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 1024,
    sessionRootDir: rootDir,
  };
  return {
    parent,
    parentLog: eventLog,
    cleanup: () => ac.abort(),
  };
}

describe("createIsolatedContext", () => {
  test("mints a fresh runId and sessionId distinct from parent", async () => {
    const root = newTempRoot();
    try {
      const { parent } = await makeParent(root);
      const child = await createIsolatedContext(parent, {
        name: "test-child",
        instructions: "child instructions",
        tools: [],
      });
      expect(child.runContext.runId).not.toBe(parent.runContext.runId);
      expect(child.runContext.sessionId).not.toBe(parent.runContext.sessionId);
      expect(child.sessionId).toBe(child.runContext.sessionId);
      expect(child.sessionId).toMatch(/^sess_[0-9a-f]{16}$/);
      expect(child.toolResultDir).toBe(`.crewhaus/tool-results/${child.runContext.runId}`);
      // v0.3.0 §7.1 / Track 10 — the child's identity is stamped at mint
      // time so child-attributed writes (plan_update, wiki_write, audit
      // entries) record which sub-agent acted.
      expect(child.runContext.agentIdentity).toEqual({ subAgentId: "test-child" });
      expect(parent.runContext.agentIdentity).toBeUndefined();
      await child.close();
      await parent.eventLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("aborting the parent cascades to the child's abortTree", async () => {
    const root = newTempRoot();
    try {
      const ac = new AbortController();
      const runContext = createRunContext({ abortSignal: ac.signal });
      const eventLog = await openEventLog(runContext.sessionId, { rootDir: root });
      const parent: ParentRunHandle = {
        runContext,
        eventLog,
        permissionMode: "default",
        permissionRules: { ...emptyRuleSet },
        tools: [],
        model: "test-model",
        maxTokens: 1024,
        sessionRootDir: root,
      };
      const child = await createIsolatedContext(parent, {
        name: "abort-child",
        instructions: "irrelevant",
        tools: [],
      });
      expect(child.abortTree.signal.aborted).toBe(false);
      ac.abort(new Error("parent shutdown"));
      // Allow the listener microtask to run.
      await Promise.resolve();
      expect(child.abortTree.signal.aborted).toBe(true);
      await child.close();
      await eventLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("aborting the child does NOT abort the parent", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);
      const child = await createIsolatedContext(parent, {
        name: "rev-abort",
        instructions: "irrelevant",
        tools: [],
      });
      child.abortTree.abort(new Error("child cancelled"));
      await Promise.resolve();
      expect(child.abortTree.signal.aborted).toBe(true);
      expect(parent.runContext.abortSignal.aborted).toBe(false);
      await child.close();
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("child state-store is independent from any parent state", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);
      const childA = await createIsolatedContext(parent, {
        name: "isolation-a",
        instructions: "x",
        tools: [],
      });
      const childB = await createIsolatedContext(parent, {
        name: "isolation-b",
        instructions: "x",
        tools: [],
      });
      childA.state.set({ a: 1 });
      childB.state.set({ b: 2 });
      expect(childA.state.get()).toEqual({ a: 1 });
      expect(childB.state.get()).toEqual({ b: 2 });
      // No cross-talk.
      expect(childB.state.get()["a"]).toBeUndefined();
      expect(childA.state.get()["b"]).toBeUndefined();
      await childA.close();
      await childB.close();
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("child's event log writes to a different file than the parent's", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);
      const child = await createIsolatedContext(parent, {
        name: "logs",
        instructions: "x",
        tools: [],
      });

      await child.eventLog.append({
        kind: "user_message",
        payload: { content: "child says hi" },
      });
      await parent.eventLog.append({
        kind: "user_message",
        payload: { content: "parent says hi" },
      });

      // Each log only contains its own message.
      const childEvents: unknown[] = [];
      for await (const ev of child.eventLog.read()) childEvents.push(ev);
      const parentEvents: unknown[] = [];
      for await (const ev of parent.eventLog.read()) parentEvents.push(ev);

      expect(childEvents).toHaveLength(1);
      expect(parentEvents).toHaveLength(1);
      expect(JSON.stringify(childEvents[0])).toContain("child says hi");
      expect(JSON.stringify(parentEvents[0])).toContain("parent says hi");

      await child.close();
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed openEventLog does not leak an abort listener on the parent signal", async () => {
    const root = newTempRoot();
    try {
      const ac = new AbortController();
      const runContext = createRunContext({ abortSignal: ac.signal });
      // Point sessionRootDir at a path *under* a regular file so the
      // openEventLog mkdirSync throws ENOTDIR — exercising the error path
      // without any network/clock dependence.
      const filePath = join(root, "not-a-dir");
      writeFileSync(filePath, "x");
      const badRoot = join(filePath, "nested");
      const parent: ParentRunHandle = {
        runContext,
        // A stub log so we never reach a real openEventLog for the parent.
        eventLog: {
          append: async () => {},
          read: () => (async function* () {})(),
          close: async () => {},
        } as EventLog,
        permissionMode: "default",
        permissionRules: { ...emptyRuleSet },
        tools: [],
        model: "test-model",
        maxTokens: 1024,
        sessionRootDir: badRoot,
      };

      const before = getEventListeners(ac.signal, "abort").length;
      await expect(
        createIsolatedContext(parent, {
          name: "leaky",
          instructions: "x",
          tools: [],
        }),
      ).rejects.toThrow();
      // The abortTree created before openEventLog must have been torn down,
      // dropping its listener back off the parent signal.
      const after = getEventListeners(ac.signal, "abort").length;
      expect(after).toBe(before);

      // And the parent itself is untouched — child teardown never cascades up.
      expect(ac.signal.aborted).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("child inherits parent.sessionRootDir when opts.sessionRootDir is omitted", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);
      const child = await createIsolatedContext(parent, {
        name: "inherit-root",
        instructions: "x",
        tools: [],
      });
      // Append an event so the child's file actually materializes.
      await child.eventLog.append({
        kind: "user_message",
        payload: { content: "ping" },
      });
      // Confirm path resolution by re-opening the same id with the same root.
      const reopened = await openEventLog(child.sessionId, { rootDir: root });
      const events: unknown[] = [];
      for await (const ev of reopened.read()) events.push(ev);
      expect(events).toHaveLength(1);
      await reopened.close();
      await child.close();
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 PR 11 — the ONE bridge → handle projection, the profile allowlist and
// the IR → runtime definition mapping (plan §7.7, §10.2).
// ---------------------------------------------------------------------------

describe("projectParentHandle (0.6.0 §10.2)", () => {
  test("copies every ParentRunHandle field — routing included — and none of the tool-only bridge fields", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);
      const routing = {
        served: {
          model: "claude-haiku-4-5",
          wireModelId: "claude-haiku-4-5",
          profile: "fast",
          armId: "fast",
          fromPool: true,
        },
        budgetUsdMicros: 500_000,
      } as const;
      const approvals = {
        store: { persist: async () => {}, get: async () => null, resolve: async () => null },
      };
      const bridge: RuntimeBridge = {
        ...parent,
        routing,
        memory: { autoRecall: true },
        skills: [],
        failureTaxonomy: [],
        continuity: { loadPlan: async () => null },
        askMode: "pause",
        approvals: approvals as unknown as NonNullable<ParentRunHandle["approvals"]>,
        hooks: [],
        subAgents: new Map(),
        spawnSubAgent: async () => {
          throw new Error("unused");
        },
        runState: createStore({}),
      };
      const handle = projectParentHandle(bridge);
      expect(handle.routing).toBe(routing);
      expect(handle.model).toBe(parent.model);
      expect(handle.maxTokens).toBe(parent.maxTokens);
      expect(handle.memory).toBe(bridge.memory);
      expect(handle.skills).toBe(bridge.skills);
      expect(handle.failureTaxonomy).toBe(bridge.failureTaxonomy);
      expect(handle.continuity).toBe(bridge.continuity);
      expect(handle.askMode).toBe("pause");
      expect(handle.approvals).toBe(bridge.approvals);
      expect(handle.sessionRootDir).toBe(root);
      for (const toolOnly of ["hooks", "subAgents", "spawnSubAgent", "crewMailbox", "runState"]) {
        expect(toolOnly in handle).toBe(false);
      }
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a minimal bridge projects the minimal handle: optional fields are ABSENT, not undefined (the hand copy's key set)", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);
      const handle = projectParentHandle({ ...parent, hooks: [] });
      expect(Object.keys(handle).sort()).toEqual(
        [
          "eventLog",
          "maxTokens",
          "model",
          "permissionMode",
          "permissionRules",
          "runContext",
          "sessionRootDir",
          "tools",
        ].sort(),
      );
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("subAgentProfileAllowlist (0.6.0 §7.7 / §10.1)", () => {
  const base: SubAgentDefinition = { name: "h", description: "d", instructions: "i" };
  test("an allowlist yields exactly its profile names", () => {
    expect(
      subAgentProfileAllowlist(
        {
          ...base,
          model: "m",
          allowedProfiles: [
            { profile: "fast", model: "a" },
            { profile: "strong", model: "b" },
          ],
        },
        "parent",
      ),
    ).toEqual(["fast", "strong"]);
  });
  test("without one, the child's own identity: its profile name and model string", () => {
    expect(subAgentProfileAllowlist({ ...base, model: "m", modelProfile: "fast" }, "p")).toEqual([
      "fast",
      "m",
    ]);
    expect(subAgentProfileAllowlist({ ...base, model: "m" }, "p")).toEqual(["m"]);
  });
  test("with no model of its own, only the parent's model (what the child runs on)", () => {
    expect(subAgentProfileAllowlist(base, "parent-model")).toEqual(["parent-model"]);
  });
});

describe("subAgentDefinitionFromIr (0.6.0 §7.7)", () => {
  test("maps today's seven fields exactly as the interpreter did and copies every 0.6.0 key only when present", () => {
    const legacy = subAgentDefinitionFromIr({
      name: "s",
      description: "d",
      instructions: "i",
      tools: ["read"],
      permissions: "scoped",
      inheritBypass: false,
    });
    expect(legacy).toEqual({
      name: "s",
      description: "d",
      instructions: "i",
      tools: ["read"],
      permissions: "scoped",
      inherit_bypass: false,
    });
    const pool = { candidates: [{ model: "a", tags: ["cheap"] }], policy: "static" as const };
    const full = subAgentDefinitionFromIr({
      name: "s",
      description: "d",
      instructions: "i",
      tools: [],
      model: "m",
      permissions: { allow: ["Read"], deny: [] },
      inheritBypass: true,
      modelProfile: "fast",
      thinking: { effort: "low" },
      maxTokens: 10,
      temperature: 0.1,
      modelFallbacks: ["f"],
      circuitBreaker: { failureThreshold: 2 },
      modelTiers: { fast: "a", default: "b" },
      modelPool: pool,
      budgetShare: 0.5,
      inheritRouting: true,
      allowedProfiles: [{ profile: "fast", model: "a" }],
      federation: { url: "https://peer.example" },
    });
    expect(full).toEqual({
      name: "s",
      description: "d",
      instructions: "i",
      tools: [],
      model: "m",
      permissions: { allow: ["Read"], deny: [] },
      inherit_bypass: true,
      modelProfile: "fast",
      thinking: { effort: "low" },
      maxTokens: 10,
      temperature: 0.1,
      modelFallbacks: ["f"],
      circuitBreaker: { failureThreshold: 2 },
      modelTiers: { fast: "a", default: "b" },
      modelPool: pool,
      budgetShare: 0.5,
      inheritRouting: true,
      allowedProfiles: [{ profile: "fast", model: "a" }],
    });
    expect(full.modelPool).toBe(pool);
  });
});
