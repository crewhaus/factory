/**
 * `fakeModel` against the real client: if the fake drifts from what the SDK and
 * this adapter accept, every journey built on it is testing something no real
 * service does. So the fake is driven here through the real code path, not by
 * hand-written requests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { AdapterError } from "@crewhaus/errors";
import { type FakeModel, type FakeModelOptions, fakeModel } from "service-fakes";
import { createAnthropicAdapter } from "./adapter.js";
import { createAnthropicClient } from "./client.js";
import type { ProviderRequest, StreamEvent } from "./types.js";

// Built from parts, and only ever sent to the loopback fake.
const TOKEN = ["sk", "ant", "fidelity", "0".repeat(12)].join("-");
const MODEL = "claude-fidelity";

const running: FakeModel[] = [];
afterEach(async () => {
  while (running.length > 0) await (running.pop() as FakeModel).stop();
});

function start(opts: FakeModelOptions): FakeModel {
  const fake = fakeModel(opts);
  running.push(fake);
  return fake;
}

function clientFor(fake: FakeModel): Anthropic {
  return createAnthropicClient({ mode: "api-key", token: TOKEN }, { ANTHROPIC_BASE_URL: fake.url })
    .client;
}

const MIXED_REPLY = {
  content: [
    { type: "text" as const, text: "looking that up" },
    { type: "tool_use" as const, id: "toolu_1", name: "Read", input: { path: "a.txt", lines: 3 } },
  ],
};

const PARAMS = {
  model: MODEL,
  max_tokens: 64,
  messages: [{ role: "user" as const, content: "hello" }],
};

const REQUEST: ProviderRequest = {
  model: MODEL,
  maxTokens: 64,
  system: [{ type: "text", text: "be brief" }],
  messages: [{ role: "user", content: "hello" }],
};

describe("the SDK reads the fake's replies", () => {
  test("a plain reply parses with text and a tool_use block", async () => {
    const fake = start({ defaultReply: MIXED_REPLY });
    const message = await clientFor(fake).messages.create(PARAMS);
    expect(message.role).toBe("assistant");
    expect(message.model).toBe(MODEL);
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      { type: "text", text: "looking that up" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt", lines: 3 } },
    ] as unknown as typeof message.content);
    expect(message.usage.input_tokens).toBeGreaterThan(0);
  });

  test("an SSE stream parses into the same message through the SDK's accumulator", async () => {
    const fake = start({ defaultReply: MIXED_REPLY });
    const message = await clientFor(fake).messages.stream(PARAMS).finalMessage();
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      { type: "text", text: "looking that up" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt", lines: 3 } },
    ] as unknown as typeof message.content);
  });
});

describe("the adapter reads the fake's stream", () => {
  test("through its own env seam, the same text and tool call", async () => {
    const fake = start({ defaultReply: MIXED_REPLY });
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: TOKEN,
      ANTHROPIC_BASE_URL: fake.url,
    });
    const events: StreamEvent[] = [];
    for await (const event of adapter.stream(REQUEST)) events.push(event);
    expect(fake.count()).toBe(1);
    const wire = JSON.stringify(events);
    expect(wire).toContain("looking");
    expect(wire).toContain("toolu_1");
    expect(wire).toContain("input_json_delta");
    expect(events.length).toBeGreaterThan(5);
  });

  test("a fault reaches it as the adapter's own error, carrying the status", async () => {
    const fake = start({ defaultReply: "ok", faults: [{ status: 401, times: 1 }] });
    const adapter = createAnthropicAdapter({
      ANTHROPIC_API_KEY: TOKEN,
      ANTHROPIC_BASE_URL: fake.url,
    });
    let caught: unknown;
    try {
      for await (const _event of adapter.stream(REQUEST)) {
        // the first event never arrives
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AdapterError);
    expect((caught as { status?: number }).status).toBe(401);
  });
});

describe("the fake's faults arrive as the SDK's status errors", () => {
  test.each([
    [401, Anthropic.AuthenticationError, "authentication_error"],
    [429, Anthropic.RateLimitError, "rate_limit_error"],
    [529, Anthropic.InternalServerError, "overloaded_error"],
  ] as const)("%d", async (status, errorClass, type) => {
    const fake = start({ defaultReply: "ok", faults: [{ status, times: 1, retryAfter: 1 }] });
    // The SDK's default retries would spend a `times: 1` fault and then succeed.
    const failed = clientFor(fake)
      .messages.create(PARAMS, { maxRetries: 0 })
      .catch((err: unknown) => err);
    const err = await failed;
    expect(err).toBeInstanceOf(errorClass);
    const apiError = err as InstanceType<typeof Anthropic.APIError>;
    expect(apiError.status).toBe(status);
    expect((apiError.error as { error: { type: string } }).error.type).toBe(type);
    // It was spent, so the next request is served.
    await expect(clientFor(fake).messages.create(PARAMS, { maxRetries: 0 })).resolves.toBeDefined();
  });

  test("an unscripted prompt surfaces as a BadRequestError naming nothing but the digest", async () => {
    const fake = start({});
    const err = await clientFor(fake)
      .messages.create(PARAMS, { maxRetries: 0 })
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(Anthropic.BadRequestError);
    expect(String((err as Error).message)).toMatch(/[0-9a-f]{64}/);
  });
});

describe("what the fake keeps", () => {
  test("the client's auth header never appears in requests()", async () => {
    const fake = start({ defaultReply: "ok" });
    await clientFor(fake).messages.create(PARAMS);
    const [request] = fake.requests();
    expect(request?.path).toBe("/v1/messages");
    expect(request?.headers["x-api-key"]).toBeUndefined();
    expect(request?.headers["authorization"]).toBeUndefined();
    expect(JSON.stringify(fake.requests())).not.toContain(TOKEN);
    expect((request?.body as { model: string }).model).toBe(MODEL);
  });
});
