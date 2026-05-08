import { describe, expect, test } from "bun:test";
import type { CrewMailbox } from "@crewhaus/agent-context-isolation";
import { isValidSpanId, isValidTraceId, parseTraceparent } from "@crewhaus/trace-event-bus";
import { type A2AEnvelope, buildEnvelope, createSendMessageA2ATool } from "./index.js";

function makeMailbox(
  roles: string[],
  onSend?: (to: string, payload: string) => string,
): CrewMailbox {
  return {
    knownRoles: roles,
    currentRole: () => roles[0] ?? "",
    currentTraceparent: () => "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    requestHandoff: () => {
      throw new Error("not used in this test");
    },
    sendA2A: async (to, payload) => (onSend ? onSend(to, payload) : `<<reply from ${to}>>`),
  };
}

describe("createSendMessageA2ATool", () => {
  test("delivers payload to peer and returns peer's reply verbatim", async () => {
    let capturedTarget: string | undefined;
    let capturedPayload: string | undefined;
    const mailbox = makeMailbox(["critic", "researcher"], (to, payload) => {
      capturedTarget = to;
      capturedPayload = payload;
      return "the answer is 42";
    });
    const tool = createSendMessageA2ATool({ from: "critic", targets: ["critic", "researcher"] });

    const result = await tool.execute(
      { target: "researcher", payload: "what is the answer?", kind: "question" },
      { bridge: { crewMailbox: mailbox } as never },
    );

    expect(capturedTarget).toBe("researcher");
    expect(capturedPayload).toBe("what is the answer?");
    expect(result).toBe("the answer is 42");
  });

  test("refuses self-message", async () => {
    const mailbox = makeMailbox(["solo"]);
    const tool = createSendMessageA2ATool({ from: "solo", targets: ["solo"] });

    const result = await tool.execute(
      { target: "solo", payload: "hi me" },
      { bridge: { crewMailbox: mailbox } as never },
    );

    expect(result).toContain("cannot send a message to yourself");
  });

  test("refuses unknown peer with helpful list", async () => {
    const mailbox = makeMailbox(["a", "b"]);
    const tool = createSendMessageA2ATool({ from: "a", targets: ["a", "b"] });

    const result = await tool.execute(
      { target: "c", payload: "hi" },
      { bridge: { crewMailbox: mailbox } as never },
    );

    expect(result).toContain('unknown peer "c"');
    expect(result).toContain("a");
    expect(result).toContain("b");
  });

  test("returns clean error when no bridge / no mailbox is present", async () => {
    const tool = createSendMessageA2ATool({ from: "x", targets: ["x", "y"] });

    const r1 = await tool.execute({ target: "y", payload: "hi" }, {});
    expect(r1).toContain("crew mailbox is not available");

    const r2 = await tool.execute({ target: "y", payload: "hi" }, { bridge: {} as never });
    expect(r2).toContain("crew mailbox is not available");
  });

  test("flag profile: read-only, not destructive, classifier enabled", () => {
    const tool = createSendMessageA2ATool({ from: "a", targets: ["a", "b"] });
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBe(false);
    // Default true — peer text could carry attacker-supplied content.
    expect(tool.classifyOutput).toBe(true);
  });
});

describe("buildEnvelope", () => {
  test("packs all wire fields with default kind=question", () => {
    const env: A2AEnvelope = buildEnvelope({
      from: "critic",
      to: "researcher",
      payload: "where did the data come from?",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });

    expect(env.from).toBe("critic");
    expect(env.to).toBe("researcher");
    expect(env.kind).toBe("question");
    expect(env.payload).toBe("where did the data come from?");
    expect(env.traceparent).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  });

  test("traceparent parses to a valid W3C trace context (T9 envelope invariant)", () => {
    const env = buildEnvelope({
      from: "a",
      to: "b",
      payload: "hi",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    const parsed = parseTraceparent(env.traceparent);
    expect(parsed).not.toBeNull();
    expect(parsed && isValidTraceId(parsed.traceId)).toBe(true);
    expect(parsed && isValidSpanId(parsed.parentSpanId)).toBe(true);
  });
});
