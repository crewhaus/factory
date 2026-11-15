import { describe, expect, test } from "bun:test";
import type { CanonicalMessage, ProviderAdapter, StreamEvent } from "@crewhaus/adapter-anthropic";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import { runWorkerLoop } from "./loop";
import type { WorkerPermissions } from "./permissions";
import type { WorkerPlatform } from "./platform";
import type { WorkerTraceEvent } from "./trace";

function platform(): WorkerPlatform {
  return {
    now: () => 1000,
    randomId: () => "id",
    fetch: (async () => {
      throw new Error("no network in this test");
    }) as unknown as typeof fetch,
  };
}

/** Replays one scripted stream per model call and keeps every request's messages. */
function scripted(turns: StreamEvent[][]): {
  adapter: ProviderAdapter;
  requests: string[];
} {
  const requests: string[] = [];
  const adapter: ProviderAdapter = {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: false,
    },
    estimateTokens: (msgs) => msgs.length * 10,
    async *stream(req) {
      requests.push(JSON.stringify(req.messages));
      for (const ev of turns[requests.length - 1] ?? textTurn("(exhausted)")) yield ev;
    },
  };
  return { adapter, requests };
}

function textTurn(text: string): StreamEvent[] {
  return [
    { kind: "message_start", usage: { input: 10, output: 0 } },
    { kind: "content_block_start", index: 0, block: { type: "text", text: "" } },
    { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { kind: "content_block_stop", index: 0 },
    { kind: "message_delta", stopReason: "end_turn", usage: { input: 0, output: 5 } },
    { kind: "message_stop" },
  ];
}

/** One assistant message carrying a tool_use block per entry. */
function toolTurn(...calls: Array<{ id: string; name: string; input: unknown }>): StreamEvent[] {
  return [
    { kind: "message_start", usage: { input: 10, output: 0 } },
    ...calls.flatMap((c, index): StreamEvent[] => [
      {
        kind: "content_block_start",
        index,
        block: { type: "tool_use", id: c.id, name: c.name, input: {} },
      },
      {
        kind: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) },
      },
      { kind: "content_block_stop", index },
    ]),
    { kind: "message_delta", stopReason: "tool_use", usage: { input: 0, output: 3 } },
    { kind: "message_stop" },
  ];
}

/** A url tool that counts its executions. */
function countingTool(name: string, readOnly = true): { tool: RegisteredTool; runs: () => number } {
  let runs = 0;
  return {
    tool: {
      name,
      description: `${name} tool`,
      inputSchema: z.object({ url: z.string() }),
      execute: async () => {
        runs += 1;
        return "page body";
      },
      concurrencySafe: false,
      readOnly,
      destructive: false,
      requiresSandbox: false,
      classifyOutput: false,
      scope: "external",
      requireJustification: false,
      operativeArgs: [{ field: "url", kind: "url" }],
    },
    runs: () => runs,
  };
}

const seed: readonly CanonicalMessage[] = [{ role: "user", content: "hi" }];

async function run(
  tool: RegisteredTool,
  permissions: WorkerPermissions | undefined,
  input: unknown = { url: "https://a.example/x" },
) {
  const { adapter, requests } = scripted([
    toolTurn({ id: "tu_1", name: tool.name, input }),
    textTurn("done"),
  ]);
  const events: WorkerTraceEvent[] = [];
  const result = await runWorkerLoop({
    platform: platform(),
    model: "claude-sonnet-4-5",
    instructions: "use tools",
    messages: seed,
    tools: [tool],
    adapter,
    ...(permissions !== undefined ? { permissions } : {}),
    emitTrace: (e) => events.push(e),
  });
  const toolResult = (
    result.messages[2]?.content as Array<Record<string, unknown>> | undefined
  )?.[0];
  return {
    result,
    events,
    requests,
    toolResult,
    decisions: events.filter((e) => e.kind === "permission_decision"),
    toolEnd: events.find((e) => e.kind === "tool_call_end") as
      | { isError: boolean; toolName: string }
      | undefined,
  };
}

describe("runWorkerLoop — permission decisions before every tool call", () => {
  test("a call no alwaysAllow rule covers is never executed, and its result says why", async () => {
    const probe = countingTool("WebFetch");
    const r = await run(probe.tool, { rules: [] });
    expect(probe.runs()).toBe(0);
    expect(r.toolResult).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
      is_error: true,
    });
    expect(String(r.toolResult?.["content"])).toBe(
      "tool denied: `WebFetch` needs approval, and this worker has nobody to give it. A tool runs on a worker only when an alwaysAllow rule covers the call: add { type: alwaysAllow, pattern: WebFetch } to permissions.rules",
    );
    expect(r.decisions).toEqual([
      {
        kind: "permission_decision",
        toolName: "WebFetch",
        decision: "ask",
        mode: "default",
        reason:
          "`WebFetch` needs approval, and this worker has nobody to give it. A tool runs on a worker only when an alwaysAllow rule covers the call: add { type: alwaysAllow, pattern: WebFetch } to permissions.rules",
        askOutcome: "denied",
      },
    ]);
    expect(r.toolEnd).toMatchObject({ toolName: "WebFetch", isError: true });
    // The run goes on: the model sees the refusal and answers.
    expect(r.result.stopReason).toBe("done");
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1]).toContain("needs approval");
  });

  test("a deny is refused with the deny's reason, and no askOutcome", async () => {
    const probe = countingTool("WebFetch");
    const r = await run(probe.tool, {
      rules: [
        { type: "alwaysAllow", pattern: "WebFetch" },
        { type: "alwaysDeny", pattern: "WebFetch" },
      ],
    });
    expect(probe.runs()).toBe(0);
    expect(r.decisions).toEqual([
      {
        kind: "permission_decision",
        toolName: "WebFetch",
        decision: "deny",
        mode: "default",
        reason: "an alwaysDeny rule in this worker's permissions denies `WebFetch`",
      },
    ]);
    expect(String(r.toolResult?.["content"])).toBe(
      "tool denied: an alwaysDeny rule in this worker's permissions denies `WebFetch`",
    );
  });

  test("plan mode is the mode a decision reports, and refuses a tool that is not read-only", async () => {
    const probe = countingTool("Fetch", false);
    const r = await run(probe.tool, {
      mode: "plan",
      rules: [{ type: "alwaysAllow", pattern: "Fetch" }],
    });
    expect(probe.runs()).toBe(0);
    expect(r.decisions).toEqual([
      {
        kind: "permission_decision",
        toolName: "Fetch",
        decision: "deny",
        mode: "plan",
        reason: "plan mode runs only read-only tools, and `Fetch` is not read-only",
      },
    ]);
  });

  test("an allowed call executes once and gets an allow frame", async () => {
    const probe = countingTool("WebFetch");
    const r = await run(probe.tool, {
      mode: "auto",
      rules: [{ type: "alwaysAllow", pattern: "WebFetch" }],
    });
    expect(probe.runs()).toBe(1);
    expect(r.decisions).toEqual([
      { kind: "permission_decision", toolName: "WebFetch", decision: "allow", mode: "default" },
    ]);
    expect(r.toolResult).toMatchObject({ is_error: false, content: "page body" });
    expect(r.toolEnd).toMatchObject({ isError: false });
  });

  test("an argument-scoped allow runs its URL and refuses another", async () => {
    const rules: WorkerPermissions = {
      rules: [{ type: "alwaysAllow", pattern: "WebFetch(https://a.example/**)" }],
    };
    const inScope = countingTool("WebFetch");
    expect(
      (await run(inScope.tool, rules, { url: "https://a.example/docs" })).toolResult,
    ).toMatchObject({
      is_error: false,
    });
    expect(inScope.runs()).toBe(1);
    const outOfScope = countingTool("WebFetch");
    const r = await run(outOfScope.tool, rules, { url: "https://b.example/docs" });
    expect(outOfScope.runs()).toBe(0);
    expect(r.decisions.map((d) => (d as { decision: string }).decision)).toEqual(["ask"]);
  });

  test("an input the tool's schema refuses gets the schema's message and no decision", async () => {
    const probe = countingTool("WebFetch");
    const r = await run(
      probe.tool,
      { rules: [{ type: "alwaysAllow", pattern: "*" }] },
      { url: 42 },
    );
    expect(probe.runs()).toBe(0);
    expect(r.decisions).toEqual([]);
    expect(r.toolResult).toMatchObject({ is_error: true });
    expect(String(r.toolResult?.["content"])).not.toContain("tool denied");
    expect(r.toolEnd).toMatchObject({ isError: true });
  });

  test("without permissions every advertised tool runs, and no decision is traced", async () => {
    const probe = countingTool("WebFetch");
    const r = await run(probe.tool, undefined);
    expect(probe.runs()).toBe(1);
    expect(r.decisions).toEqual([]);
    expect(r.toolResult).toMatchObject({ is_error: false });
  });

  test("tool calls run one at a time: two in one message never overlap, and both run", async () => {
    for (const permissions of [
      undefined,
      { rules: [{ type: "alwaysAllow" as const, pattern: "*" }] },
    ]) {
      let inFlight = 0;
      let highest = 0;
      const ran: string[] = [];
      const slow: RegisteredTool = {
        ...countingTool("Slow").tool,
        execute: async (input) => {
          inFlight += 1;
          highest = Math.max(highest, inFlight);
          // A deferred the event loop settles later: a second call started
          // in parallel would be in flight while this one waits.
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          ran.push((input as { url: string }).url);
          inFlight -= 1;
          return "ok";
        },
      };
      const { adapter } = scripted([
        toolTurn(
          { id: "tu_1", name: "Slow", input: { url: "https://a.example/1" } },
          { id: "tu_2", name: "Slow", input: { url: "https://a.example/2" } },
        ),
        textTurn("done"),
      ]);
      const result = await runWorkerLoop({
        platform: platform(),
        model: "claude-sonnet-4-5",
        instructions: "use tools",
        messages: seed,
        tools: [slow],
        adapter,
        ...(permissions !== undefined ? { permissions } : {}),
      });
      expect(result.stopReason).toBe("done");
      expect(ran).toEqual(["https://a.example/1", "https://a.example/2"]);
      expect(highest).toBe(1);
    }
  });
});
