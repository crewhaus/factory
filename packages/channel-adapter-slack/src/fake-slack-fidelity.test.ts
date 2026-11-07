/**
 * `fakeSlack` against the real adapter: its signatures must pass `verify`, and
 * the adapter's real calls must land in its sink. The fake signs with its own
 * HMAC rather than this package's, so the two have to agree on the wire.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type FakeSlack, type FakeSlackOptions, fakeSlack } from "service-fakes";
import { SlackAdapterError, createSlackAdapter } from "./index.js";
import { verifySlackSignature } from "./verify.js";

const running: FakeSlack[] = [];
const receivers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(async () => {
  while (running.length > 0) await (running.pop() as FakeSlack).stop();
  while (receivers.length > 0) await receivers.pop()?.stop(true);
});

function start(opts: FakeSlackOptions = {}): FakeSlack {
  const fake = fakeSlack(opts);
  running.push(fake);
  return fake;
}

// Built from parts, and only ever sent to the loopback fake.
const BOT_TOKEN = ["xox", "b", "fidelity"].join("-");

function adapterFor(fake: FakeSlack) {
  return createSlackAdapter(
    { botToken: BOT_TOKEN, signingSecret: fake.signingSecret },
    { apiBaseUrl: fake.apiBaseUrl },
  );
}

const EVENT = {
  idempotencyKey: "Ev1",
  workspaceId: "T1",
  channelId: "C1",
  userId: "U1",
  ts: "1700000000.000100",
  text: "hello",
  subtype: "message" as const,
};

const BODY = JSON.stringify({ type: "event_callback", event_id: "Ev1" });

describe("verify", () => {
  test("a signed request passes", () => {
    const fake = start();
    expect(adapterFor(fake).verify(fake.signedRequest(BODY))).toBe(true);
  });

  test("a body tampered by one byte fails", () => {
    const fake = start();
    const signed = fake.signedRequest(BODY);
    expect(adapterFor(fake).verify({ ...signed, body: `${BODY.slice(0, -1)}!` })).toBe(false);
  });

  test("a stale timestamp fails, on the adapter's own window", () => {
    const fake = start();
    const stale = Math.floor(Date.now() / 1000) - 6 * 60;
    expect(adapterFor(fake).verify(fake.signedRequest(BODY, { ts: stale }))).toBe(false);
  });

  test("a clock injected into the check moves the window", () => {
    const fake = start();
    const ts = 1_700_000_000;
    const signed = fake.signedRequest(BODY, { ts });
    const args = { ...signed, signingSecret: fake.signingSecret };
    expect(verifySlackSignature(args, { now: () => ts * 1000 + 1000 })).toBe(true);
    expect(verifySlackSignature(args, { now: () => ts * 1000 + 10 * 60 * 1000 })).toBe(false);
  });

  test("another secret fails", () => {
    const fake = start();
    const other = createSlackAdapter({ botToken: BOT_TOKEN, signingSecret: "another-secret" });
    expect(other.verify(fake.signedRequest(BODY))).toBe(false);
  });
});

describe("deliveries a real receiver accepts", () => {
  test("an event passes verify and parses, and a replay repeats its idempotency key", async () => {
    const fake = start();
    const adapter = adapterFor(fake);
    const keys: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      development: false,
      fetch: async (req) => {
        const raw = { headers: req.headers, body: await req.text() };
        if (!adapter.verify(raw)) return new Response("bad signature", { status: 401 });
        const parsed = adapter.parseInbound(raw);
        if (parsed.kind === "event") keys.push(parsed.event.idempotencyKey);
        return new Response("ok");
      },
    });
    receivers.push(server);
    const results = await fake.deliverEvent(
      `http://127.0.0.1:${server.port}/slack/events`,
      {
        type: "app_mention",
        channel: "C1",
        user: "U1",
        ts: "1700000000.000100",
        text: "hello",
      },
      { eventId: "Ev9", replay: true },
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(keys).toEqual(["Ev9", "Ev9"]);
  });
});

describe("the adapter's real calls land in the sink", () => {
  test("chat.postMessage", async () => {
    const fake = start();
    await adapterFor(fake).sendReply({ event: EVENT, text: "the reply" });
    const [call] = fake.calls("chat.postMessage");
    expect(call?.body).toMatchObject({ channel: "C1", text: "the reply" });
    expect(call?.headers["authorization"]).toBeUndefined();
    expect(JSON.stringify(fake.calls())).not.toContain(BOT_TOKEN);
  });

  test("reactions.add", async () => {
    const fake = start();
    const adapter = adapterFor(fake);
    await adapter.react?.({ event: EVENT, emoji: ":eyes:" });
    expect(fake.calls("reactions.add")[0]?.body).toMatchObject({ channel: "C1", name: "eyes" });
  });

  test("chat.update, from an approval ack with no response URL", async () => {
    const fake = start();
    const adapter = adapterFor(fake);
    await adapter.ackApproval?.({
      interaction: {
        kind: "approval_action",
        decision: "grant",
        approvalId: "appr_1",
        userId: "U1",
        channelId: "C1",
        messageTs: "1700000000.000100",
      } as Parameters<NonNullable<typeof adapter.ackApproval>>[0]["interaction"],
      decision: "grant",
      by: "U1",
    });
    expect(fake.calls("chat.update")[0]?.body).toMatchObject({
      channel: "C1",
      ts: "1700000000.000100",
    });
  });

  test("a missing_scope reply reaches the adapter's error path", async () => {
    const fake = start({
      scopes: { granted: [], required: { "chat.postMessage": ["chat:write"] } },
    });
    const failed = adapterFor(fake).sendReply({ event: EVENT, text: "the reply" });
    await expect(failed).rejects.toThrow(SlackAdapterError);
    await expect(failed).rejects.toThrow("missing_scope");
  });
});
