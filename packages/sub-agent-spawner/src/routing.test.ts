/**
 * 0.6.0 PR 11 — sub-agent routing end to end (plan §7.7, §4.4, §10.2):
 *
 *   - `resolveChildLoopPlan`: declared / inherited / pinned, the `budget_share`
 *     sub-cap, the fail-closed profile re-check;
 *   - a child with `inheritRouting: true` runs on the parent's SERVED arm and
 *     one without runs on the declared primary (`req.model` on the child's
 *     adapter is the proof);
 *   - a Task-pinned `profile` runs the child on that option's model + params
 *     with its overlay folded in, and its `model_pool` does not route the call;
 *   - `sub_agent_start` / `sub_agent_end` carry `model` / `profile`;
 *   - the child's PRICED spend lands on the PARENT bus as ONE
 *     `cost_accrual{role: "subagent", summary: true}` inside the bracket;
 *   - through a real parent `runChatLoop` + Task, that roll-up is what trips
 *     the PARENT's `budget` (the meter counts a child's spend for the first
 *     time), and a `budgetShare` sub-cap stops the CHILD with a non-fatal
 *     classified `crewhaus_budget` failure.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderAdapter, ProviderRequest } from "@crewhaus/adapter-anthropic";
import type {
  ParentRunHandle,
  SpawnSubAgentOptions,
  SubAgentDefinition,
} from "@crewhaus/agent-context-isolation";
import { isRunFailedError } from "@crewhaus/errors";
import { type EventLog, openEventLog } from "@crewhaus/event-log";
import { emptyRuleSet } from "@crewhaus/permission-engine";
import { createRunContext } from "@crewhaus/run-context";
import { runChatLoop } from "@crewhaus/runtime-core";
import { buildTool } from "@crewhaus/tool-builder";
import { createTaskTool } from "@crewhaus/tool-task";
import type {
  CostAccrualEvent,
  SubAgentEndEvent,
  SubAgentStartEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { resolveChildLoopPlan, spawnSubAgent } from "./index.js";

const PRIMARY = "claude-sonnet-4-6";
const FAST = "claude-haiku-4-5";
const STRONG = "claude-opus-4-8";

function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "sub-agent-routing-"));
  return dir;
}

async function makeParent(
  rootDir: string,
  routing?: ParentRunHandle["routing"],
): Promise<{ parent: ParentRunHandle; parentLog: EventLog; events: TraceEvent[] }> {
  const runContext = createRunContext({ abortSignal: new AbortController().signal });
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const eventLog = await openEventLog(runContext.sessionId, { rootDir });
  const parent: ParentRunHandle = {
    runContext,
    eventLog,
    permissionMode: "bypass",
    permissionRules: { ...emptyRuleSet },
    tools: [],
    model: PRIMARY,
    maxTokens: 1024,
    sessionRootDir: rootDir,
    ...(routing !== undefined ? { routing } : {}),
  };
  return { parent, parentLog: eventLog, events };
}

type Step = { readonly tool: string; readonly input?: unknown } | { readonly text: string };

/** Scripted adapter: plays one step per call, reports fixed usage, records every request. */
function scripted(
  steps: ReadonlyArray<Step>,
  usage: { input: number; output: number } = { input: 0, output: 0 },
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  return {
    requests,
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream(req) {
      requests.push(req);
      const step = steps[Math.min(call, steps.length - 1)] ?? { text: "done" };
      call++;
      return (async function* () {
        yield { kind: "message_start", usage: { input: usage.input, output: 0 } } as const;
        if ("tool" in step) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: `tu_${call}`, name: step.tool, input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input ?? {}) },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "tool_use",
            usage: { input: 0, output: usage.output },
          } as const;
        } else {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: step.text },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 0, output: usage.output },
          } as const;
        }
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

const echoTool = buildTool({
  name: "echo",
  description: "echo",
  inputSchema: z.object({ msg: z.string().optional() }),
  execute: async () => "echoed",
  readOnly: true,
  concurrencySafe: true,
});

const HELPER: SubAgentDefinition = {
  name: "helper",
  description: "helps",
  instructions: "help",
  tools: [],
};

const SERVED_FAST = {
  served: { model: FAST, wireModelId: FAST, profile: "fast", armId: "fast", fromPool: true },
} as const;

async function spawn(
  parent: ParentRunHandle,
  def: SubAgentDefinition,
  client: ProviderAdapter,
  extra: Partial<SpawnSubAgentOptions> = {},
) {
  return spawnSubAgent(parent, {
    def,
    prompt: "go",
    permissionMode: "bypass",
    permissionRules: { ...emptyRuleSet },
    childTools: [],
    _client: client,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// resolveChildLoopPlan — the pure resolution
// ---------------------------------------------------------------------------

describe("resolveChildLoopPlan (§7.7)", () => {
  const parent = {
    model: PRIMARY,
    maxTokens: 1024,
    routing: { ...SERVED_FAST, budgetUsdMicros: 1_000_000 },
  } as unknown as ParentRunHandle;

  test("declared: the child's own model, params and routing quartet; the parent's router is never inherited", () => {
    const def: SubAgentDefinition = {
      ...HELPER,
      model: STRONG,
      modelProfile: "strong",
      thinking: { effort: "low" },
      maxTokens: 512,
      modelPool: { candidates: [{ model: FAST, tags: ["cheap"] }], policy: "static" },
    };
    const plan = resolveChildLoopPlan(parent, def, undefined);
    expect(plan.source).toBe("declared");
    expect(plan.model).toBe(STRONG);
    expect(plan.profile).toBe("strong");
    expect(plan.maxTokens).toBe(512);
    expect(plan.loopOptions.thinking).toEqual({ effort: "low" });
    expect(plan.loopOptions.modelPool).toBe(def.modelPool);
    expect(plan.loopOptions.budget).toBeUndefined();
  });

  test("declared without a model falls back to the parent's DECLARED primary, not its served arm", () => {
    const plan = resolveChildLoopPlan(parent, HELPER, undefined);
    expect(plan.source).toBe("declared");
    expect(plan.model).toBe(PRIMARY);
    expect(plan.profile).toBeUndefined();
    expect(plan.maxTokens).toBe(1024);
  });

  test("inherited: inheritRouting: true runs on the served arm (its profile stamped); the child keeps its own params", () => {
    const def: SubAgentDefinition = {
      ...HELPER,
      model: STRONG,
      inheritRouting: true,
      temperature: 0.3,
    };
    const plan = resolveChildLoopPlan(parent, def, undefined);
    expect(plan.source).toBe("inherited");
    expect(plan.model).toBe(FAST);
    expect(plan.profile).toBe("fast");
    expect(plan.loopOptions.temperature).toBe(0.3);
  });

  test("inherited falls back to the declared plan when the bridge projected no served arm (a pre-0.6.0 handle)", () => {
    const bare = { model: PRIMARY, maxTokens: 1024 } as unknown as ParentRunHandle;
    const plan = resolveChildLoopPlan(bare, { ...HELPER, inheritRouting: true }, undefined);
    expect(plan.source).toBe("declared");
    expect(plan.model).toBe(PRIMARY);
  });

  test("pinned: an allowed profile runs single-model on the option (params, overlay, chain); the child's pool does not route it", () => {
    const def: SubAgentDefinition = {
      ...HELPER,
      model: PRIMARY,
      modelPool: { candidates: [{ model: FAST, tags: ["cheap"] }], policy: "static" },
      allowedProfiles: [
        {
          profile: "strong",
          model: STRONG,
          thinking: { budgetTokens: 4096 },
          maxTokens: 2048,
          overlay: "Think hard.",
          modelFallbacks: [PRIMARY],
        },
        { profile: "fast", model: FAST, temperature: 0.2 },
      ],
    };
    const plan = resolveChildLoopPlan(parent, def, "strong");
    expect(plan.source).toBe("pinned");
    expect(plan.model).toBe(STRONG);
    expect(plan.profile).toBe("strong");
    expect(plan.maxTokens).toBe(2048);
    expect(plan.instructions).toBe("Think hard.\n\nhelp");
    expect(plan.loopOptions).toEqual({
      thinking: { budgetTokens: 4096 },
      modelFallbacks: [PRIMARY],
      budget: undefined,
    } as never);
    expect(plan.loopOptions.modelPool).toBeUndefined();
    expect(plan.loopOptions.modelTiers).toBeUndefined();
  });

  test("a profile that restates the child's own identity is accepted and yields the default plan", () => {
    const def: SubAgentDefinition = { ...HELPER, model: STRONG, modelProfile: "strong" };
    expect(resolveChildLoopPlan(parent, def, "strong").source).toBe("declared");
    expect(resolveChildLoopPlan(parent, def, STRONG).source).toBe("declared");
    // …and with no model at all, the parent's model is the one restatable name.
    expect(resolveChildLoopPlan(parent, HELPER, PRIMARY).source).toBe("declared");
  });

  test("a profile outside the allowlist fails closed — nothing outside the spec is ever named", () => {
    const def: SubAgentDefinition = {
      ...HELPER,
      allowedProfiles: [{ profile: "fast", model: FAST }],
    };
    expect(() => resolveChildLoopPlan(parent, def, "not-allowed")).toThrow(
      /profile "not-allowed" is not allowed — allowed: fast/,
    );
    // Without an allowlist the served arm's profile is NOT a valid name either:
    // the argument may restate the child's own identity only.
    expect(() => resolveChildLoopPlan(parent, HELPER, "fast")).toThrow(/not allowed/);
    // The child's own model string outranks nothing: an unrelated model is refused.
    expect(() => resolveChildLoopPlan(parent, { ...HELPER, model: STRONG }, FAST)).toThrow(
      /allowed: claude-opus-4-8/,
    );
  });

  test("budgetShare: a sub-cap under the parent's run cap, `stop` on breach; inert without a parent cap", () => {
    const def: SubAgentDefinition = { ...HELPER, budgetShare: 0.25 };
    const plan = resolveChildLoopPlan(parent, def, undefined);
    expect(plan.loopOptions.budget).toEqual({ usdMicros: 250_000, onExceed: { kind: "stop" } });
    // The pinned path carries the same sub-cap.
    const pinned = resolveChildLoopPlan(
      parent,
      { ...def, allowedProfiles: [{ profile: "fast", model: FAST }] },
      "fast",
    );
    expect(pinned.loopOptions.budget).toEqual({ usdMicros: 250_000, onExceed: { kind: "stop" } });
    // No parent budget → nothing to take a share of.
    const uncapped = { ...parent, routing: SERVED_FAST } as unknown as ParentRunHandle;
    expect(resolveChildLoopPlan(uncapped, def, undefined).loopOptions.budget).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// spawnSubAgent — the model the child ACTUALLY requests, and the events
// ---------------------------------------------------------------------------

describe("spawnSubAgent — inherit_routing and the served arm (§4.4 / §7.7)", () => {
  test("inheritRouting: true → the child requests the parent's SERVED arm; sub_agent_start/end carry model + profile", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog, events } = await makeParent(root, SERVED_FAST);
      const client = scripted([{ text: "done" }]);
      const result = await spawn(parent, { ...HELPER, inheritRouting: true }, client);
      expect(result.finalMessage).toBe("done");
      expect(client.requests[0]?.model).toBe(FAST);
      const start = events.find((e): e is SubAgentStartEvent => e.kind === "sub_agent_start");
      const end = events.find((e): e is SubAgentEndEvent => e.kind === "sub_agent_end");
      expect(start?.model).toBe(FAST);
      expect(start?.profile).toBe("fast");
      expect(end?.model).toBe(FAST);
      expect(end?.profile).toBe("fast");
      // The durable bracket on the parent's log carries the same attribution.
      const reread = await openEventLog(parent.runContext.sessionId, { rootDir: root });
      const payloads: Array<Record<string, unknown>> = [];
      for await (const ev of reread.read()) {
        if (ev.kind === "sub_agent_start" || ev.kind === "sub_agent_end") {
          payloads.push(ev.payload as Record<string, unknown>);
        }
      }
      await reread.close();
      expect(payloads).toHaveLength(2);
      for (const p of payloads) {
        expect(p["model"]).toBe(FAST);
        expect(p["profile"]).toBe("fast");
      }
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without inheritRouting the child requests the DECLARED primary even while a pool candidate served the parent", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog, events } = await makeParent(root, SERVED_FAST);
      const client = scripted([{ text: "done" }]);
      await spawn(parent, HELPER, client);
      expect(client.requests[0]?.model).toBe(PRIMARY);
      const start = events.find((e): e is SubAgentStartEvent => e.kind === "sub_agent_start");
      expect(start?.model).toBe(PRIMARY);
      expect(start?.profile).toBeUndefined();
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pinned profile runs the child on that option's model and params, overlay first in the system prompt", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog, events } = await makeParent(root, SERVED_FAST);
      const client = scripted([{ text: "done" }]);
      const def: SubAgentDefinition = {
        ...HELPER,
        model: PRIMARY,
        allowedProfiles: [
          {
            profile: "strong",
            model: STRONG,
            maxTokens: 777,
            thinking: { budgetTokens: 2048 },
            overlay: "You are the strong lane.",
          },
        ],
      };
      await spawn(parent, def, client, { profile: "strong" });
      const req = client.requests[0];
      expect(req?.model).toBe(STRONG);
      // The loop's effective max_tokens = the option's maxTokens + its thinking
      // budget (a thinking request must leave room for the visible answer).
      expect(req?.maxTokens).toBe(777 + 2048);
      expect(req?.thinking).toMatchObject({ budgetTokens: 2048 });
      expect(req?.system[0]?.text.startsWith("You are the strong lane.\n\nhelp")).toBe(true);
      const start = events.find((e): e is SubAgentStartEvent => e.kind === "sub_agent_start");
      expect(start?.model).toBe(STRONG);
      expect(start?.profile).toBe("strong");
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a disallowed profile is refused BEFORE anything is spawned: no bracket, no child log, no model call", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog, events } = await makeParent(root);
      const client = scripted([{ text: "never" }]);
      await expect(spawn(parent, HELPER, client, { profile: "not-allowed" })).rejects.toThrow(
        /not allowed/,
      );
      expect(client.requests).toHaveLength(0);
      expect(events.some((e) => e.kind === "sub_agent_start")).toBe(false);
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the child's own params and thinking reach its request; a child's temperature/thinking never come from the parent", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog } = await makeParent(root);
      const client = scripted([{ text: "done" }]);
      await spawn(parent, { ...HELPER, maxTokens: 333, temperature: 0.7 }, client);
      expect(client.requests[0]?.maxTokens).toBe(333);
      expect(client.requests[0]?.temperature).toBe(0.7);
      const plain = scripted([{ text: "done" }]);
      await spawn(parent, HELPER, plain);
      expect(plain.requests[0]?.maxTokens).toBe(1024);
      expect(plain.requests[0]?.temperature).toBeUndefined();
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// the child's spend on the parent bus
// ---------------------------------------------------------------------------

describe("spawnSubAgent — child spend re-published on the parent bus (§7.6 / §10.2)", () => {
  test("ONE cost_accrual{role: subagent, summary: true} lands inside the bracket, priced and token-summed over the child's calls", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog, events } = await makeParent(root);
      // Two child calls (a tool_use, then text) at 10_000 in / 1_000 out each.
      const client = scripted([{ tool: "echo", input: { msg: "hi" } }, { text: "done" }], {
        input: 10_000,
        output: 1_000,
      });
      const result = await spawn(parent, { ...HELPER, model: FAST }, client, {
        childTools: [echoTool],
      });
      expect(result.usage).toEqual({ input_tokens: 20_000, output_tokens: 2_000 });
      const accruals = events.filter((e): e is CostAccrualEvent => e.kind === "cost_accrual");
      expect(accruals).toHaveLength(1);
      const accrual = accruals[0];
      if (accrual === undefined) throw new Error("unreachable");
      expect(accrual.role).toBe("subagent");
      expect(accrual.summary).toBe(true);
      expect(accrual.provider).toBe("anthropic");
      expect(accrual.modelId).toBe(FAST);
      expect(accrual.inputTokens).toBe(20_000);
      expect(accrual.outputTokens).toBe(2_000);
      expect(accrual.costUsdMicros).toBeGreaterThan(0);
      expect(accrual.unpriced).toBeUndefined();
      // Published on the PARENT's run, between the bracket events, sharing the
      // bracket's span so OTel nests it under the sub-agent span.
      expect(accrual.runId).toBe(parent.runContext.runId);
      const kinds = events
        .filter((e) => ["sub_agent_start", "cost_accrual", "sub_agent_end"].includes(e.kind))
        .map((e) => e.kind);
      expect(kinds).toEqual(["sub_agent_start", "cost_accrual", "sub_agent_end"]);
      const start = events.find((e): e is SubAgentStartEvent => e.kind === "sub_agent_start");
      expect(accrual.spanId).toBe(start?.spanId);
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a child that made no model call publishes no roll-up; an unpriced model publishes a $0 roll-up flagged unpriced", async () => {
    const root = newTempRoot();
    try {
      const { parent, parentLog, events } = await makeParent(root);
      const client = scripted([{ text: "done" }], { input: 500, output: 50 });
      await spawn(parent, { ...HELPER, model: "totally-unknown-model" }, client);
      const accruals = events.filter((e): e is CostAccrualEvent => e.kind === "cost_accrual");
      expect(accruals).toHaveLength(1);
      expect(accruals[0]?.costUsdMicros).toBe(0);
      expect(accruals[0]?.unpriced).toBe(true);
      expect(accruals[0]?.inputTokens).toBe(500);
      await parentLog.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// end to end — a PARENT runChatLoop drives the REAL Task tool
// ---------------------------------------------------------------------------

describe("end to end — Task profile, parent budget and budget_share (§7.7 / §7.12)", () => {
  const HELPER_PROFILED: SubAgentDefinition = {
    ...HELPER,
    model: PRIMARY,
    allowedProfiles: [{ profile: "fast", model: FAST }],
  };

  const runParent = async (
    root: string,
    def: SubAgentDefinition,
    taskInput: Record<string, unknown>,
    childClient: ProviderAdapter,
    extra: Record<string, unknown> = {},
  ): Promise<{
    text: string;
    events: TraceEvent[];
    parent: ProviderAdapter & { requests: ProviderRequest[] };
  }> => {
    const subAgents = new Map([[def.name, def]]);
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => events.push(e));
    const parent = scripted([
      {
        tool: "Task",
        input: { description: "d", prompt: "p", subagent_type: def.name, ...taskInput },
      },
      { text: "parent done" },
    ]);
    const text = await runChatLoop({
      model: PRIMARY,
      instructions: "delegate",
      _adapter: parent,
      runContext,
      sessionRootDir: root,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [createTaskTool({ subAgents })],
      permissionMode: "bypass",
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
      subAgents,
      spawnSubAgent: (p, opts: SpawnSubAgentOptions) =>
        spawnSubAgent(p, { ...opts, _client: childClient }),
      ...extra,
    });
    return { text, events, parent };
  };

  const toolResultText = (req: ProviderRequest | undefined): { text: string; isError: boolean } => {
    const last = req?.messages[req.messages.length - 1];
    if (last === undefined || typeof last.content === "string") return { text: "", isError: false };
    const block = (last.content as Anthropic.ContentBlockParam[]).find(
      (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result",
    );
    const text =
      typeof block?.content === "string"
        ? block.content
        : ((block?.content ?? []) as Anthropic.ContentBlockParam[])
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");
    return { text, isError: block?.is_error === true };
  };

  test("Task({profile: 'not-allowed'}) returns is_error naming the allowlist; nothing was spawned", async () => {
    const root = newTempRoot();
    try {
      const child = scripted([{ text: "never" }]);
      const { text, events, parent } = await runParent(
        root,
        HELPER_PROFILED,
        { profile: "not-allowed" },
        child,
      );
      expect(text).toBe("parent done");
      const result = toolResultText(parent.requests[1]);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('profile "not-allowed" is not allowed');
      expect(result.text).toContain("allowed: fast");
      expect(child.requests).toHaveLength(0);
      expect(events.some((e) => e.kind === "sub_agent_start")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Task({profile: 'fast'}) runs the child on the fast profile and records it on sub_agent_start", async () => {
    const root = newTempRoot();
    try {
      const child = scripted([{ text: "child done" }]);
      const { events, parent } = await runParent(root, HELPER_PROFILED, { profile: "fast" }, child);
      expect(toolResultText(parent.requests[1])).toEqual({ text: "child done", isError: false });
      expect(child.requests[0]?.model).toBe(FAST);
      const start = events.find((e): e is SubAgentStartEvent => e.kind === "sub_agent_start");
      expect(start?.model).toBe(FAST);
      expect(start?.profile).toBe("fast");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the bridge projects the parent's served arm: a child with inheritRouting runs on it through the real Task tool", async () => {
    const root = newTempRoot();
    try {
      // No pool on the parent: the served arm IS the primary — the projection
      // exists (fromPool: false) and the child lands on `PRIMARY` either way.
      // The pooled case (served arm ≠ primary) is pinned in runtime-core's
      // plan-table tests, which own the pool boot seams.
      const child = scripted([{ text: "child done" }]);
      const { events } = await runParent(root, { ...HELPER, inheritRouting: true }, {}, child);
      expect(child.requests[0]?.model).toBe(PRIMARY);
      const start = events.find((e): e is SubAgentStartEvent => e.kind === "sub_agent_start");
      expect(start?.model).toBe(PRIMARY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the child's re-published spend trips the PARENT's budget: the parent's own calls are free, the child's are not", async () => {
    const root = newTempRoot();
    try {
      // Cap: $0.001. The child bills 100k input tokens on haiku (~$0.10) and
      // the parent's scripted adapter reports zero usage — so ONLY the
      // re-published child roll-up can put the meter over the cap, and the
      // parent's second model call (after the Task result) is the one gated.
      const child = scripted([{ text: "child done" }], { input: 100_000, output: 1_000 });
      let thrown: unknown;
      try {
        await runParent(root, { ...HELPER, model: FAST }, {}, child, {
          budget: { usdMicros: 1_000, onExceed: { kind: "stop" } },
        });
      } catch (err) {
        thrown = err;
      }
      expect(isRunFailedError(thrown)).toBe(true);
      if (!isRunFailedError(thrown)) throw new Error("unreachable");
      expect(thrown.report.class).toBe("crewhaus_budget");
      // The child itself completed (its one call happened).
      expect(child.requests).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without the child's spend the same parent under the same cap runs to completion (control)", async () => {
    const root = newTempRoot();
    try {
      const child = scripted([{ text: "child done" }]);
      const { text } = await runParent(root, { ...HELPER, model: FAST }, {}, child, {
        budget: { usdMicros: 1_000, onExceed: { kind: "stop" } },
      });
      expect(text).toBe("parent done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("budgetShare: the CHILD is stopped at its sub-cap with a non-fatal classified failure; the parent continues", async () => {
    const root = newTempRoot();
    try {
      // Parent cap $10 → child cap $0.50 (share 0.05). The child's FIRST call
      // bills 1M input tokens on haiku (~$1), so its second call (after the
      // tool result) is gated inside the CHILD loop: a `crewhaus_budget` child
      // failure — not billing/auth, so it surfaces as an is_error tool result
      // and the parent (whose $10 cap the ~$1 roll-up does not reach) carries
      // on to its own next turn.
      const child = scripted([{ tool: "echo", input: {} }, { text: "never reached" }], {
        input: 1_000_000,
        output: 100,
      });
      const def: SubAgentDefinition = {
        ...HELPER,
        model: FAST,
        tools: ["echo"],
        budgetShare: 0.05,
      };
      const { text, events, parent } = await runParent(root, def, {}, child, {
        tools: [echoTool, createTaskTool({ subAgents: new Map([[def.name, def]]) })],
        budget: { usdMicros: 10_000_000, onExceed: { kind: "stop" } },
      });
      expect(text).toBe("parent done");
      const result = toolResultText(parent.requests[1]);
      expect(result.isError).toBe(true);
      expect(result.text).toContain('"failureClass":"crewhaus_budget"');
      const end = events.find((e): e is SubAgentEndEvent => e.kind === "sub_agent_end");
      expect(end?.isError).toBe(true);
      expect(end?.failureClass).toBe("crewhaus_budget");
      expect(child.requests).toHaveLength(1);
      // The parent's meter still saw the child's ~$1 through the roll-up.
      const rollup = events.find(
        (e): e is CostAccrualEvent => e.kind === "cost_accrual" && e.role === "subagent",
      );
      expect(rollup?.summary).toBe(true);
      expect(rollup?.costUsdMicros ?? 0).toBeGreaterThan(500_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
