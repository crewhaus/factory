import { afterEach, describe, expect, test } from "bun:test";
import {
  type ChannelAdapter,
  type InboundEvent,
  createSlackAdapter,
} from "@crewhaus/channel-adapter-slack";
import {
  BUILTIN_DEFAULT_RULES,
  type RuleSet,
  emptyRuleSet,
  evaluate,
} from "@crewhaus/permission-engine";
import { executeTool } from "@crewhaus/tool-executor";
import { _resetChannelAdapters, registerChannelAdapter, sendMessage } from "./index";

afterEach(() => {
  _resetChannelAdapters();
});

function dummyAdapter(): {
  adapter: ChannelAdapter;
  captured: Array<{ event: InboundEvent; text: string }>;
} {
  const captured: Array<{ event: InboundEvent; text: string }> = [];
  const adapter: ChannelAdapter = {
    id: "slack",
    verify: () => true,
    parseInbound: () => ({ kind: "skip" }),
    sendReply: async (a) => {
      captured.push(a);
    },
    setTyping: async () => undefined,
  };
  return { adapter, captured };
}

describe("sendMessage tool — shape (T1)", () => {
  test("declares destructive: true so default mode evaluates fail-closed", () => {
    expect(sendMessage.name).toBe("SendMessage");
    expect(sendMessage.destructive).toBe(true);
    expect(sendMessage.readOnly).toBe(false);
  });
});

describe("sendMessage permission gating (T8 — security)", () => {
  test("evaluates to ASK in default mode without an explicit allow rule", () => {
    const decision = evaluate(
      {
        toolName: "SendMessage",
        input: { channel: "slack:T:C", text: "x" },
        readOnly: false,
        destructive: true,
      },
      "default",
      { ...emptyRuleSet, builtin: BUILTIN_DEFAULT_RULES },
    );
    // ASK with no askApproval prompter => the runtime treats it as deny.
    // The point is: it does NOT auto-allow. (alwaysAllow Read is in builtins
    // but never matches SendMessage.)
    expect(decision).toBe("ask");
  });

  test("evaluates to ASK in auto mode (destructive default)", () => {
    const decision = evaluate(
      { toolName: "SendMessage", input: {}, readOnly: false, destructive: true },
      "auto",
      { ...emptyRuleSet, builtin: BUILTIN_DEFAULT_RULES },
    );
    expect(decision).toBe("ask");
  });

  test("plan mode denies SendMessage outright (not readOnly)", () => {
    const decision = evaluate(
      { toolName: "SendMessage", input: {}, readOnly: false, destructive: true },
      "plan",
      { ...emptyRuleSet, builtin: BUILTIN_DEFAULT_RULES },
    );
    expect(decision).toBe("deny");
  });

  test("explicit alwaysAllow rule unlocks SendMessage", () => {
    const rules: RuleSet = {
      ...emptyRuleSet,
      yaml: [{ type: "alwaysAllow", pattern: "SendMessage", source: "yaml" }],
      builtin: BUILTIN_DEFAULT_RULES,
    };
    const decision = evaluate(
      { toolName: "SendMessage", input: {}, readOnly: false, destructive: true },
      "default",
      rules,
    );
    expect(decision).toBe("allow");
  });

  test("alwaysDeny rule wins over alwaysAllow due to source priority", () => {
    const rules: RuleSet = {
      ...emptyRuleSet,
      flag: [{ type: "alwaysDeny", pattern: "SendMessage", source: "flag" }],
      yaml: [{ type: "alwaysAllow", pattern: "SendMessage", source: "yaml" }],
    };
    const decision = evaluate(
      { toolName: "SendMessage", input: {}, readOnly: false, destructive: true },
      "default",
      rules,
    );
    expect(decision).toBe("deny");
  });
});

describe("sendMessage execution", () => {
  test("dispatches to the registered adapter and returns success", async () => {
    const { adapter, captured } = dummyAdapter();
    registerChannelAdapter("slack", adapter);
    const result = await executeTool(
      sendMessage,
      { channel: "slack:T9:C7:1700000000.000", text: "hi from tool" },
      { toolUseId: "u1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("sent to slack:T9:C7:1700000000.000");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.event.workspaceId).toBe("T9");
    expect(captured[0]?.event.channelId).toBe("C7");
    expect(captured[0]?.event.threadTs).toBe("1700000000.000");
    expect(captured[0]?.text).toBe("hi from tool");
  });

  test("returns isError when no adapter is registered", async () => {
    const result = await executeTool(
      sendMessage,
      { channel: "slack:T:C:1.0", text: "x" },
      { toolUseId: "u2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no adapter registered/);
  });

  test("returns isError on a malformed routing key", async () => {
    const result = await executeTool(
      sendMessage,
      { channel: "slack-only", text: "x" },
      { toolUseId: "u3" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid channel/);
  });

  test("integrates with createSlackAdapter for end-to-end dispatch", async () => {
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({
        url: typeof input === "string" ? input : input.toString(),
        body: typeof init?.body === "string" ? init.body : "",
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: "s" },
      { apiBaseUrl: "https://slack.test/api", fetch: fakeFetch },
    );
    registerChannelAdapter("slack", adapter);
    const result = await executeTool(
      sendMessage,
      { channel: "slack:T:C:1.0", text: "ok" },
      { toolUseId: "u4" },
    );
    expect(result.isError).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://slack.test/api/chat.postMessage");
  });
});
