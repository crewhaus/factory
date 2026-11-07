import { afterEach, describe, expect, test } from "bun:test";
import { type FakeModel, type FakeModelOptions, fakeModel, promptDigest } from "./model";
import { MASKED } from "./record";

const fakes: FakeModel[] = [];
afterEach(async () => {
  while (fakes.length > 0) await (fakes.pop() as FakeModel).stop();
});

function start(opts: FakeModelOptions = {}): FakeModel {
  const fake = fakeModel(opts);
  fakes.push(fake);
  return fake;
}

// Built from parts, and only ever sent to the fake.
const API_KEY = ["sk", "ant", "fake", "0".repeat(12)].join("-");

function post(fake: FakeModel, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${fake.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, ...headers },
    body: JSON.stringify(body),
  });
}

const prompt = (text: string) => ({
  model: "claude-fake",
  max_tokens: 64,
  messages: [{ role: "user", content: text }],
});

/** The `type` of every event in an SSE body, and its parsed data. */
function events(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  return text
    .split("\n\n")
    .filter((frame) => frame !== "")
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      const data = JSON.parse((dataLine ?? "").slice("data: ".length)) as Record<string, unknown>;
      const type = (eventLine ?? "").slice("event: ".length);
      expect(data["type"]).toBe(type);
      return { type, data };
    });
}

describe("promptDigest", () => {
  test("is stable across key order and ignores everything but system and messages", () => {
    const a = promptDigest({ system: "s", messages: [{ role: "user", content: "hi" }] });
    const b = promptDigest({ messages: [{ content: "hi", role: "user" }], system: "s" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const withExtra = { system: "s", messages: [{ role: "user", content: "hi" }], max_tokens: 9 };
    expect(promptDigest(withExtra)).toBe(a);
  });

  test("changes with the prompt", () => {
    const a = promptDigest({ messages: [{ role: "user", content: "one" }] });
    const b = promptDigest({ messages: [{ role: "user", content: "two" }] });
    const c = promptDigest({ system: "x", messages: [{ role: "user", content: "one" }] });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("replies", () => {
  test("an unscripted prompt with no default is refused, and the refusal names its digest", async () => {
    const fake = start();
    const body = prompt("nobody wrote a reply to this");
    const res = await post(fake, body);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(parsed.type).toBe("error");
    expect(parsed.error.type).toBe("invalid_request_error");
    expect(parsed.error.message).toContain(promptDigest(body));
  });

  test("a scripted prompt gets its reply, and another prompt does not", async () => {
    const fake = start();
    const body = prompt("scripted");
    fake.script(promptDigest(body), "the scripted reply");
    const res = await post(fake, body);
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as Record<string, unknown>;
    expect(parsed["type"]).toBe("message");
    expect(parsed["role"]).toBe("assistant");
    expect(parsed["model"]).toBe("claude-fake");
    expect(parsed["stop_reason"]).toBe("end_turn");
    expect(parsed["content"]).toEqual([{ type: "text", text: "the scripted reply" }]);
    expect((await post(fake, prompt("not scripted"))).status).toBe(400);
  });

  test("the default answers what no script does, and a script still wins", async () => {
    const fake = start({ defaultReply: "by default" });
    const body = prompt("scripted");
    fake.script(promptDigest(body), "scripted");
    const scripted = (await (await post(fake, body)).json()) as { content: unknown };
    expect(scripted.content).toEqual([{ type: "text", text: "scripted" }]);
    const other = (await (await post(fake, prompt("other"))).json()) as { content: unknown };
    expect(other.content).toEqual([{ type: "text", text: "by default" }]);
  });

  test("a tool_use block comes back with an id and the tool_use stop reason", async () => {
    const fake = start({
      defaultReply: { content: [{ type: "tool_use", name: "Read", input: { path: "a" } }] },
    });
    const parsed = (await (await post(fake, prompt("x"))).json()) as {
      stop_reason: string;
      content: Array<{ type: string; id: string; name: string; input: unknown }>;
    };
    expect(parsed.stop_reason).toBe("tool_use");
    expect(parsed.content[0]?.name).toBe("Read");
    expect(parsed.content[0]?.input).toEqual({ path: "a" });
    expect(parsed.content[0]?.id).toMatch(/^toolu_/);
  });
});

describe("streaming", () => {
  test("the full event sequence, generated from text and tool_use blocks", async () => {
    const fake = start({
      defaultReply: {
        content: [
          { type: "text", text: "hello there" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } },
        ],
      },
    });
    const res = await post(fake, { ...prompt("x"), stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const list = events(await res.text());
    expect(list.map((e) => e.type)).toEqual([
      "message_start",
      "ping",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const deltas = list
      .filter((e) => e.type === "content_block_delta")
      .map((e) => e.data["delta"] as { text?: string; partial_json?: string });
    expect(`${deltas[0]?.text}${deltas[1]?.text}`).toBe("hello there");
    expect(JSON.parse(`${deltas[2]?.partial_json}${deltas[3]?.partial_json}`)).toEqual({
      path: "a",
    });
    const final = list.find((e) => e.type === "message_delta")?.data["delta"] as {
      stop_reason: string;
    };
    expect(final.stop_reason).toBe("tool_use");
  });
});

describe("faults", () => {
  test.each([
    [401, "authentication_error"],
    [429, "rate_limit_error"],
    [529, "overloaded_error"],
  ] as const)("%d answers in the API's error shape, %s", async (status, type) => {
    const fake = start({ defaultReply: "ok", faults: [{ status, times: 1 }] });
    const res = await post(fake, prompt("x"));
    expect(res.status).toBe(status);
    const parsed = (await res.json()) as { type: string; error: { type: string } };
    expect(parsed.type).toBe("error");
    expect(parsed.error.type).toBe(type);
  });

  test("a fault's times is honoured, and the next request succeeds", async () => {
    const fake = start({
      defaultReply: "ok",
      faults: [{ status: 429, times: 2, retryAfter: 7 }],
    });
    const first = await post(fake, prompt("x"));
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("7");
    expect((await post(fake, prompt("x"))).status).toBe(429);
    expect((await post(fake, prompt("x"))).status).toBe(200);
    expect(fake.count()).toBe(3);
  });

  test("a request with no credential is a 401", async () => {
    const fake = start({ defaultReply: "ok" });
    const res = await fetch(`${fake.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(prompt("x")),
    });
    expect(res.status).toBe(401);
  });
});

describe("models and prices", () => {
  test("an id outside a supplied table is a 404 not_found_error, an id inside is served", async () => {
    const fake = start({
      defaultReply: "ok",
      models: { "claude-fake": { inputPerMTok: 3, outputPerMTok: 15 }, "claude-free": "unpriced" },
    });
    expect((await post(fake, prompt("x"))).status).toBe(200);
    const res = await post(fake, { ...prompt("x"), model: "claude-missing" });
    expect(res.status).toBe(404);
    const parsed = (await res.json()) as { error: { type: string } };
    expect(parsed.error.type).toBe("not_found_error");
  });

  test("prices are for assertions and never go on the wire", async () => {
    const models = { "claude-fake": { inputPerMTok: 123.5, outputPerMTok: 456.5 } };
    const fake = start({ defaultReply: "ok", models });
    expect(fake.prices).toEqual(models);
    const wire = await (await post(fake, prompt("x"))).text();
    expect(wire).not.toContain("123.5");
    expect(wire).not.toContain("inputPerMTok");
  });

  test("with no table, any id is served", async () => {
    const fake = start({ defaultReply: "ok" });
    expect((await post(fake, { ...prompt("x"), model: "anything" })).status).toBe(200);
    expect(fake.prices).toEqual({});
  });
});

describe("recording", () => {
  test("counts every request and masks credentials out of what it keeps", async () => {
    const fake = start({ defaultReply: "ok" });
    const planted = ["pass", "word", "value"].join("-");
    await post(
      fake,
      { ...prompt("x"), metadata: { api_key: planted, password: planted } },
      {
        authorization: `Bearer ${API_KEY}`,
      },
    );
    expect(fake.count()).toBe(1);
    const [request] = fake.requests();
    expect(request?.path).toBe("/v1/messages");
    expect(request?.headers["authorization"]).toBeUndefined();
    expect(request?.headers["x-api-key"]).toBeUndefined();
    const recorded = JSON.stringify(request);
    expect(recorded).not.toContain(API_KEY);
    expect(recorded).not.toContain(planted);
    const body = request?.body as { metadata: Record<string, unknown>; max_tokens: number };
    expect(body.metadata["api_key"]).toBe(MASKED);
    expect(body.metadata["password"]).toBe(MASKED);
    // A count whose name happens to contain "token" is still a count.
    expect(body.max_tokens).toBe(64);
  });
});
