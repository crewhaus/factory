import { describe, expect, test } from "bun:test";
import {
  EFFORT_THINKING_BUDGET_TOKENS,
  type ProviderRequest,
  type ReasoningEffort,
} from "@crewhaus/adapter-anthropic";
import { toOpenAIChatParams } from "./translate.js";

const baseReq: ProviderRequest = {
  model: "gpt-4o-mini",
  system: [{ type: "text", text: "you are helpful" }],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1024,
};

/** Recursively collect every key name appearing anywhere in a value. */
function allKeys(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) allKeys(item, into);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      into.add(key);
      allKeys(value, into);
    }
  }
  return into;
}

describe("toOpenAIChatParams", () => {
  test("non-reasoning models keep max_tokens (compat servers only understand it)", () => {
    for (const model of ["gpt-4o", "gpt-4o-mini", "llama3.1:8b", "deepseek-chat"]) {
      const params = toOpenAIChatParams({ ...baseReq, model });
      expect(params.max_tokens).toBe(1024);
      expect(params.max_completion_tokens).toBeUndefined();
    }
  });

  test("o-series models send max_completion_tokens instead of max_tokens", () => {
    for (const model of ["o1", "o3", "o4-mini"]) {
      const params = toOpenAIChatParams({ ...baseReq, model });
      expect(params.max_completion_tokens).toBe(1024);
      expect(params.max_tokens).toBeUndefined();
    }
  });

  test("gpt-5 family models send max_completion_tokens instead of max_tokens", () => {
    for (const model of ["gpt-5", "gpt-5-mini", "gpt-5.1"]) {
      const params = toOpenAIChatParams({ ...baseReq, model });
      expect(params.max_completion_tokens).toBe(1024);
      expect(params.max_tokens).toBeUndefined();
    }
  });

  test("collapses canonical system array into a leading system message", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(params.messages[0]).toEqual({ role: "system", content: "first\n\nsecond" });
  });

  test("strips empty system blocks", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      system: [
        { type: "text", text: "" },
        { type: "text", text: "real instruction" },
      ],
    });
    expect(params.messages[0]).toEqual({ role: "system", content: "real instruction" });
  });

  test("user message with text content passes through", () => {
    const params = toOpenAIChatParams(baseReq);
    expect(params.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("translates tools as function specs", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
      toolChoice: { type: "tool", name: "Read" },
    });
    // A plain object schema qualifies for Structured-Outputs strict mode:
    // `additionalProperties: false`, every property in `required`, and the
    // (originally optional) `path` made nullable so omission is expressible.
    expect(params.tools).toEqual([
      {
        type: "function",
        function: {
          name: "Read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: ["string", "null"] } },
            required: ["path"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    ]);
    expect(params.tool_choice).toEqual({ type: "function", function: { name: "Read" } });
  });

  test("toolChoice 'any' → 'required'", () => {
    const params = toOpenAIChatParams({ ...baseReq, toolChoice: { type: "any" } });
    expect(params.tool_choice).toBe("required");
  });

  test("a $ref-heavy but strict-expressible schema is upgraded to strict:true", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      tools: [
        {
          name: "connect",
          description: "open a connection",
          input_schema: {
            type: "object",
            properties: {
              target: { $ref: "#/$defs/Endpoint" },
              retries: { type: "integer" },
            },
            required: ["target"],
            $defs: {
              Endpoint: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"],
              },
            },
          },
        },
      ],
    });
    const fn = params.tools?.[0]?.function as {
      strict?: boolean;
      parameters?: Record<string, unknown>;
    };
    expect(fn.strict).toBe(true);
    const p = fn.parameters as Record<string, unknown>;
    expect(p["additionalProperties"]).toBe(false);
    // both properties required under strict; the optional one made nullable
    expect(new Set(p["required"] as string[])).toEqual(new Set(["target", "retries"]));
    const props = p["properties"] as Record<string, Record<string, unknown>>;
    expect(props["retries"]?.["type"]).toEqual(["integer", "null"]);
    // ref inlined + nested object also locked down
    const target = props["target"] as Record<string, unknown>;
    expect(target["additionalProperties"]).toBe(false);
    expect(allKeys(p).has("$ref")).toBe(false);
  });

  test("a schema outside the strict subset stays non-strict (no strict flag)", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      tools: [
        {
          name: "search",
          description: "search",
          input_schema: {
            type: "object",
            properties: { q: { type: "string", pattern: "^.+$" } },
            required: ["q"],
          },
        },
      ],
    });
    const fn = params.tools?.[0]?.function as { strict?: boolean; parameters?: unknown };
    expect(fn.strict).toBeUndefined();
    // Original schema rides through untouched (constraints preserved).
    expect(fn.parameters).toEqual({
      type: "object",
      properties: { q: { type: "string", pattern: "^.+$" } },
      required: ["q"],
    });
  });

  test("assistant tool_use block → tool_calls on the assistant message", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        { role: "user", content: "read it" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", id: "tu_1", name: "Read", input: { path: "/x" } },
          ],
        },
      ],
    });
    const assistant = params.messages[2] as { role: string; tool_calls?: unknown[] };
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: { name: "Read", arguments: JSON.stringify({ path: "/x" }) },
      },
    ]);
  });

  test("user tool_result block → separate tool message with tool_call_id", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file contents" }],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "file contents",
    });
  });

  test("dropping cache_control markers (auto-cached on OpenAI)", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      system: [{ type: "text", text: "long sys", cache_control: { type: "ephemeral" } }],
    });
    // No cache_control in the OpenAI request anywhere.
    expect(JSON.stringify(params)).not.toContain("cache_control");
  });

  test("empty system array → no leading system message", () => {
    const params = toOpenAIChatParams({ ...baseReq, system: [] });
    expect(params.messages[0]).toEqual({ role: "user", content: "hi" });
  });

  test("toolChoice 'auto' → 'auto'", () => {
    const params = toOpenAIChatParams({ ...baseReq, toolChoice: { type: "auto" } });
    expect(params.tool_choice).toBe("auto");
  });

  test("empty tools array is not forwarded", () => {
    const params = toOpenAIChatParams({ ...baseReq, tools: [] });
    expect(params.tools).toBeUndefined();
  });

  test("user image block (base64) → image_url data URI part", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look:" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            },
          ],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look:" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  test("user image block (url) → image_url with the raw url", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://img.example/p.png" } }],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://img.example/p.png" } }],
    });
  });

  test("text before a tool_result is flushed as a user message first (order preserved)", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "here is the result" },
            { type: "tool_result", tool_use_id: "tu_1", content: "OUTPUT" },
          ],
        },
      ],
    });
    // First the flushed user part, then the tool message.
    expect(params.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "here is the result" }],
    });
    expect(params.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "OUTPUT",
    });
  });

  test("text AFTER a tool_result is flushed as a trailing user message", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "OUTPUT" },
            { type: "text", text: "follow-up question" },
          ],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "OUTPUT",
    });
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "follow-up question" }],
    });
  });

  test("tool_result with array content: text joined on the tool message, image re-emitted as a follow-up user message", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [
                { type: "text", text: "line one" },
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "ZZ" },
                },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      ],
    });
    expect(params.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "line one\nline two",
    });
    // The image rides a follow-up user message, labelled with the tool
    // call id (OpenAI tool messages only accept strings).
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[Image output of tool call tu_1]" },
        { type: "image_url", image_url: { url: "data:image/png;base64,ZZ" } },
      ],
    });
    expect(params.messages).toHaveLength(3);
  });

  test("multiple image-bearing tool_results: tool messages stay contiguous, images follow in order", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_a",
              content: [
                { type: "text", text: "shot A" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
              ],
            },
            {
              type: "tool_result",
              tool_use_id: "tu_b",
              content: [
                { type: "image", source: { type: "url", url: "https://img.example/b.png" } },
              ],
            },
          ],
        },
      ],
    });
    // Tool responses remain adjacent (OpenAI requires them directly
    // after the assistant tool_calls message)…
    expect(params.messages[1]).toEqual({ role: "tool", tool_call_id: "tu_a", content: "shot A" });
    expect(params.messages[2]).toEqual({ role: "tool", tool_call_id: "tu_b", content: "" });
    // …then a single follow-up user message with both images in tool
    // result order, each labelled.
    expect(params.messages[3]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[Image output of tool call tu_a]" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
        { type: "text", text: "[Image output of tool call tu_b]" },
        { type: "image_url", image_url: { url: "https://img.example/b.png" } },
      ],
    });
    expect(params.messages).toHaveLength(4);
  });

  test("text after an image-bearing tool_result joins the image follow-up message in order", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: "QQ" } },
              ],
            },
            { type: "text", text: "what do you see?" },
          ],
        },
      ],
    });
    expect(params.messages[1]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "" });
    expect(params.messages[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "[Image output of tool call tu_1]" },
        { type: "image_url", image_url: { url: "data:image/png;base64,QQ" } },
        { type: "text", text: "what do you see?" },
      ],
    });
  });

  test("tool_result with undefined content → empty string", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1" }],
        },
      ],
    });
    expect(params.messages[1]).toEqual({ role: "tool", tool_call_id: "tu_1", content: "" });
  });

  test("assistant message with plain string content passes through", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello there" },
      ],
    });
    expect(params.messages[2]).toEqual({ role: "assistant", content: "hello there" });
  });

  test("assistant block message with only tool_use → content null + tool_calls", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_9", name: "Run", input: { x: 1 } }],
        },
      ],
    });
    const assistant = params.messages[2] as {
      role: string;
      content: string | null;
      tool_calls?: unknown[];
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toEqual([
      {
        id: "tu_9",
        type: "function",
        function: { name: "Run", arguments: JSON.stringify({ x: 1 }) },
      },
    ]);
  });

  test("assistant tool_use with undefined input → arguments '{}'", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_0", name: "Noop", input: undefined }],
        },
      ],
    });
    const assistant = params.messages[2] as { tool_calls?: { function: { arguments: string } }[] };
    expect(assistant.tool_calls?.[0]?.function.arguments).toBe("{}");
  });
});

describe("toOpenAIChatParams — reasoning effort", () => {
  test("reasoningEffort passes through verbatim on reasoning models", () => {
    for (const model of ["o1", "o3", "o4-mini", "gpt-5", "gpt-5-mini"]) {
      const params = toOpenAIChatParams({ ...baseReq, model, reasoningEffort: "high" });
      expect(params.reasoning_effort).toBe("high");
    }
  });

  test("reasoningEffort is silently ignored on non-reasoning models", () => {
    for (const model of ["gpt-4o", "gpt-4o-mini", "llama3.1:8b", "deepseek-chat"]) {
      const params = toOpenAIChatParams({ ...baseReq, model, reasoningEffort: "high" });
      expect(params.reasoning_effort).toBeUndefined();
    }
  });

  test("neither reasoningEffort nor thinking → no reasoning_effort, even on reasoning models", () => {
    const params = toOpenAIChatParams({ ...baseReq, model: "o3" });
    expect(params.reasoning_effort).toBeUndefined();
  });

  test("thinking.budgetTokens alone derives the exact preset buckets", () => {
    for (const [effort, budgetTokens] of Object.entries(EFFORT_THINKING_BUDGET_TOKENS)) {
      const params = toOpenAIChatParams({
        ...baseReq,
        model: "o3",
        thinking: { type: "enabled", budgetTokens },
      });
      expect(params.reasoning_effort).toBe(effort as ReasoningEffort);
    }
  });

  test("thinking.budgetTokens derives the NEAREST bucket for off-preset budgets", () => {
    const cases: ReadonlyArray<[number, ReasoningEffort]> = [
      [1024, "low"], // below the low preset
      [3000, "low"], // nearer 2048 than 8192
      [6000, "medium"], // nearer 8192 than 2048
      [20000, "high"], // nearer 24576 than 8192
      [100000, "high"], // above the high preset
    ];
    for (const [budgetTokens, expected] of cases) {
      const params = toOpenAIChatParams({
        ...baseReq,
        model: "o3",
        thinking: { type: "enabled", budgetTokens },
      });
      expect(params.reasoning_effort).toBe(expected);
    }
  });

  test("bucket ties resolve to the lower effort", () => {
    // 5120 is equidistant from low (2048) and medium (8192); 16384 from
    // medium (8192) and high (24576).
    const ties: ReadonlyArray<[number, ReasoningEffort]> = [
      [5120, "low"],
      [16384, "medium"],
    ];
    for (const [budgetTokens, expected] of ties) {
      const params = toOpenAIChatParams({
        ...baseReq,
        model: "o3",
        thinking: { type: "enabled", budgetTokens },
      });
      expect(params.reasoning_effort).toBe(expected);
    }
  });

  test("explicit reasoningEffort wins over thinking.budgetTokens (native effort control)", () => {
    // Inverted precedence vs the budget-token providers: OpenAI's native
    // knob IS the effort string, so the preset passes through and the
    // budget is not consulted.
    const params = toOpenAIChatParams({
      ...baseReq,
      model: "gpt-5",
      reasoningEffort: "low",
      thinking: { type: "enabled", budgetTokens: 24576 },
    });
    expect(params.reasoning_effort).toBe("low");
  });

  test("thinking-derived effort is also ignored on non-reasoning models", () => {
    const params = toOpenAIChatParams({
      ...baseReq,
      model: "gpt-4o",
      thinking: { type: "enabled", budgetTokens: 8192 },
    });
    expect(params.reasoning_effort).toBeUndefined();
  });
});
