import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { MASKED } from "./record";
import { type FakeSlack, type FakeSlackOptions, fakeSlack } from "./slack";

const fakes: FakeSlack[] = [];
const receivers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  while (fakes.length > 0) await (fakes.pop() as FakeSlack).stop();
  while (receivers.length > 0) await receivers.pop()?.stop(true);
});

function start(opts: FakeSlackOptions = {}): FakeSlack {
  const fake = fakeSlack(opts);
  fakes.push(fake);
  return fake;
}

type Received = { headers: Headers; body: string };

function receiver(status = 200): { url: string; received: Received[] } {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    fetch: async (req) => {
      received.push({ headers: req.headers, body: await req.text() });
      return new Response("ok", { status });
    },
  });
  receivers.push(server);
  return { url: `http://127.0.0.1:${server.port}/slack`, received };
}

const post = (fake: FakeSlack, method: string, body: unknown, token = "not-a-real-one") =>
  fetch(`${fake.apiBaseUrl}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const recompute = (secret: string, ts: string, body: string): string =>
  `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;

describe("the Web API sink", () => {
  test.each([
    ["chat.postMessage", "ts"],
    ["chat.update", "ts"],
    ["chat.postEphemeral", "message_ts"],
    ["auth.test", "bot_id"],
  ])("%s answers ok with its field", async (method, field) => {
    const fake = start();
    const res = await post(fake, method, { channel: "C1", text: "hi" });
    expect(res.status).toBe(200);
    const parsed = (await res.json()) as Record<string, unknown>;
    expect(parsed["ok"]).toBe(true);
    expect(parsed[field]).toBeDefined();
    expect(fake.calls(method)).toHaveLength(1);
  });

  test("reactions.add answers ok and calls() keeps each method apart", async () => {
    const fake = start();
    const res = await post(fake, "reactions.add", { channel: "C1", name: "eyes" });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    await post(fake, "chat.postMessage", { channel: "C1", text: "hi" });
    expect(fake.calls("reactions.add")).toHaveLength(1);
    expect(fake.calls("chat.postMessage")).toHaveLength(1);
    expect(fake.calls()).toHaveLength(2);
    expect(fake.calls("reactions.add")[0]?.body).toEqual({ channel: "C1", name: "eyes" });
  });

  test("a method it does not serve says so", async () => {
    const fake = start();
    const parsed = (await (await post(fake, "files.upload", {})).json()) as Record<string, unknown>;
    expect(parsed).toEqual({ ok: false, error: "unknown_method" });
  });

  test("a form-encoded call is recorded by field", async () => {
    const fake = start();
    await fetch(`${fake.apiBaseUrl}/chat.postMessage`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channel: "C2", text: "form" }).toString(),
    });
    expect(fake.calls("chat.postMessage")[0]?.body).toEqual({ channel: "C2", text: "form" });
  });

  test("a recording holds no credential", async () => {
    const fake = start();
    const planted = ["not", "a", "real", "one"].join("-");
    await post(fake, "chat.postMessage", { channel: "C1", text: "hi", token: planted }, planted);
    const [call] = fake.calls("chat.postMessage");
    expect(JSON.stringify(call)).not.toContain(planted);
    expect((call?.body as { token: string }).token).toBe(MASKED);
    expect(call?.headers["authorization"]).toBeUndefined();
  });
});

describe("scopes", () => {
  const scopes = {
    granted: ["chat:write"],
    required: { "chat.postMessage": ["chat:write"], "reactions.add": ["reactions:write"] },
  };

  test("a method whose scope is missing gets missing_scope, naming it", async () => {
    const fake = start({ scopes });
    const parsed = (await (await post(fake, "reactions.add", {})).json()) as Record<
      string,
      unknown
    >;
    expect(parsed["ok"]).toBe(false);
    expect(parsed["error"]).toBe("missing_scope");
    expect(parsed["needed"]).toBe("reactions:write");
  });

  test("a method whose scope is granted is served", async () => {
    const fake = start({ scopes });
    const parsed = (await (await post(fake, "chat.postMessage", {})).json()) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });
});

describe("faults", () => {
  test("a 429 says ratelimited with Retry-After, for its method and its times", async () => {
    const fake = start({
      faults: [{ status: 429, times: 1, method: "chat.postMessage", retryAfter: 9 }],
    });
    expect((await post(fake, "auth.test", {})).status).toBe(200);
    const limited = await post(fake, "chat.postMessage", {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("9");
    expect(((await limited.json()) as { error: string }).error).toBe("ratelimited");
    expect((await post(fake, "chat.postMessage", {})).status).toBe(200);
  });
});

describe("signed deliveries", () => {
  test("signedRequest signs v0:<ts>:<body> with the secret, in seconds", () => {
    const fake = start();
    const signed = fake.signedRequest('{"a":1}', { ts: 1_700_000_000 });
    expect(signed.body).toBe('{"a":1}');
    expect(signed.headers.get("x-slack-request-timestamp")).toBe("1700000000");
    expect(signed.headers.get("x-slack-signature")).toBe(
      recompute(fake.signingSecret, "1700000000", '{"a":1}'),
    );
  });

  test("an event arrives signed, with its event_id", async () => {
    const fake = start();
    const { url, received } = receiver();
    const results = await fake.deliverEvent(
      url,
      { type: "app_mention", text: "hi" },
      { eventId: "Ev1" },
    );
    expect(results.map((r) => r.status)).toEqual([200]);
    expect(received).toHaveLength(1);
    const first = received[0] as Received;
    const parsed = JSON.parse(first.body) as Record<string, unknown>;
    expect(parsed["type"]).toBe("event_callback");
    expect(parsed["event_id"]).toBe("Ev1");
    expect(parsed["event"]).toEqual({ type: "app_mention", text: "hi" });
    const ts = first.headers.get("x-slack-request-timestamp") ?? "";
    expect(first.headers.get("x-slack-signature")).toBe(
      recompute(fake.signingSecret, ts, first.body),
    );
  });

  test("a replay repeats the same event_id, marked as a retry", async () => {
    const fake = start();
    const { url, received } = receiver();
    await fake.deliverEvent(url, { type: "message" }, { eventId: "Ev2", replay: true });
    expect(received).toHaveLength(2);
    expect(received[0]?.body).toBe(received[1]?.body as string);
    expect(received[0]?.headers.get("x-slack-retry-num")).toBeNull();
    expect(received[1]?.headers.get("x-slack-retry-num")).toBe("1");
  });

  test("an interaction is a form-encoded payload field, signed over the raw body", async () => {
    const fake = start();
    const { url, received } = receiver();
    await fake.deliverInteraction(url, { type: "block_actions", actions: [] });
    const first = received[0] as Received;
    expect(first.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    const payload = new URLSearchParams(first.body).get("payload") ?? "";
    expect(JSON.parse(payload)).toEqual({ type: "block_actions", actions: [] });
    const ts = first.headers.get("x-slack-request-timestamp") ?? "";
    expect(first.headers.get("x-slack-signature")).toBe(
      recompute(fake.signingSecret, ts, first.body),
    );
  });

  test("a slash command is form-encoded by field", async () => {
    const fake = start();
    const { url, received } = receiver();
    await fake.deliverCommand(url, { command: "/status", text: "all" });
    const fields = new URLSearchParams(received[0]?.body);
    expect(fields.get("command")).toBe("/status");
    expect(fields.get("text")).toBe("all");
  });

  test("a delivery refuses a receiver off this machine", async () => {
    const fake = start();
    await expect(fake.deliverEvent("https://example.invalid/x", {})).rejects.toThrow("loopback");
    await expect(fake.deliverInteraction("https://example.invalid/x", {})).rejects.toThrow(
      "loopback",
    );
    await expect(fake.deliverCommand("https://example.invalid/x", {})).rejects.toThrow("loopback");
  });
});
