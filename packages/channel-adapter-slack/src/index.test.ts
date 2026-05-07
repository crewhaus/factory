import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSlackAdapter, signSlackBody, verifySlackSignature } from "./index";

const FIXTURES = join(import.meta.dir, "fixtures");
const APP_MENTION = readFileSync(join(FIXTURES, "app_mention.json"), "utf8");
const MESSAGE = readFileSync(join(FIXTURES, "message.json"), "utf8");
const BOT_MESSAGE = readFileSync(join(FIXTURES, "bot_message.json"), "utf8");
const URL_VERIFICATION = readFileSync(join(FIXTURES, "url_verification.json"), "utf8");

const SECRET = "test-secret-1234567890";

function signedHeaders(body: string, secret: string, ts: number = Math.floor(Date.now() / 1000)) {
  const headers = new Headers();
  headers.set("x-slack-request-timestamp", String(ts));
  headers.set("x-slack-signature", signSlackBody({ body, timestamp: ts, signingSecret: secret }));
  return headers;
}

describe("verifySlackSignature (T8 — security)", () => {
  test("accepts a freshly signed request", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, SECRET);
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(true);
  });

  test("rejects a request with a tampered body", () => {
    const headers = signedHeaders(APP_MENTION, SECRET);
    const tamperedBody = APP_MENTION.replace("what time is it?", "rm -rf");
    expect(verifySlackSignature({ headers, body: tamperedBody, signingSecret: SECRET })).toBe(
      false,
    );
  });

  test("rejects a request with a tampered signature", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, SECRET);
    headers.set(
      "x-slack-signature",
      `${headers.get("x-slack-signature")?.slice(0, -2) ?? "v0="}00`,
    );
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(false);
  });

  test("rejects a request signed with a different secret", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, "wrong-secret");
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(false);
  });

  test("rejects a request with an expired timestamp (replay attack)", () => {
    const body = APP_MENTION;
    const oldTs = Math.floor(Date.now() / 1000) - 10 * 60; // 10 minutes ago
    const headers = signedHeaders(body, SECRET, oldTs);
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(false);
  });

  test("rejects a request with a future timestamp", () => {
    const body = APP_MENTION;
    const futureTs = Math.floor(Date.now() / 1000) + 10 * 60;
    const headers = signedHeaders(body, SECRET, futureTs);
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(false);
  });

  test("rejects a request with missing timestamp header", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, SECRET);
    headers.delete("x-slack-request-timestamp");
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(false);
  });

  test("rejects a request with missing signature header", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, SECRET);
    headers.delete("x-slack-signature");
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(false);
  });

  test("rejects a request with a malformed (non-numeric) timestamp", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, SECRET);
    headers.set("x-slack-request-timestamp", "not-a-number");
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(false);
  });

  test("rejects a request whose signature has the wrong length (timing-safe equal guard)", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, SECRET);
    headers.set("x-slack-signature", "v0=short");
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET })).toBe(false);
  });

  test("honours an injected `now` for tolerance testing", () => {
    const body = APP_MENTION;
    const fixedTs = 1700000000;
    const headers = signedHeaders(body, SECRET, fixedTs);
    const stillFresh = verifySlackSignature(
      { headers, body, signingSecret: SECRET },
      { now: () => fixedTs * 1000 + 60_000 },
    );
    expect(stillFresh).toBe(true);
    const stale = verifySlackSignature(
      { headers, body, signingSecret: SECRET },
      { now: () => fixedTs * 1000 + 10 * 60_000 },
    );
    expect(stale).toBe(false);
  });
});

describe("createSlackAdapter — parseInbound (T2 — contract)", () => {
  function adapter() {
    return createSlackAdapter({ botToken: "xoxb-test", signingSecret: SECRET });
  }

  test("parses app_mention into a normalised InboundEvent", () => {
    const out = adapter().parseInbound({ headers: new Headers(), body: APP_MENTION });
    expect(out.kind).toBe("event");
    if (out.kind !== "event") return;
    expect(out.event.subtype).toBe("app_mention");
    expect(out.event.workspaceId).toBe("T12345WRK");
    expect(out.event.channelId).toBe("C0CHAN01");
    expect(out.event.userId).toBe("U07USER01");
    expect(out.event.text).toBe("<@U0BOT> what time is it?");
    expect(out.event.threadTs).toBe("1700000000.000100");
    expect(out.event.idempotencyKey).toBe("Ev0EVENTONE");
  });

  test("parses a top-level message event", () => {
    const out = adapter().parseInbound({ headers: new Headers(), body: MESSAGE });
    expect(out.kind).toBe("event");
    if (out.kind !== "event") return;
    expect(out.event.subtype).toBe("message");
    expect(out.event.threadTs).toBeUndefined();
    expect(out.event.text).toBe("ping");
  });

  test("skips bot self-mentions (subtype: bot_message)", () => {
    const out = adapter().parseInbound({ headers: new Headers(), body: BOT_MESSAGE });
    expect(out.kind).toBe("skip");
  });

  test("returns a challenge for url_verification", () => {
    const out = adapter().parseInbound({ headers: new Headers(), body: URL_VERIFICATION });
    expect(out.kind).toBe("challenge");
    if (out.kind !== "challenge") return;
    expect(out.challenge.length).toBeGreaterThan(0);
  });

  test("skips unparsable JSON", () => {
    const out = adapter().parseInbound({ headers: new Headers(), body: "not-json" });
    expect(out.kind).toBe("skip");
  });

  test("skips events outside the {app_mention, message} set", () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: { type: "channel_created", channel: "C1", user: "U1", ts: "1.0" },
    });
    const out = adapter().parseInbound({ headers: new Headers(), body });
    expect(out.kind).toBe("skip");
  });

  test("skips events with another bot's bot_id when selfBotId is unspecified", () => {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: {
        type: "message",
        bot_id: "B_OTHER",
        text: "hi",
        channel: "C1",
        user: "U1",
        ts: "1.0",
      },
    });
    const out = adapter().parseInbound({ headers: new Headers(), body });
    expect(out.kind).toBe("skip");
  });
});

describe("createSlackAdapter — sendReply", () => {
  test("POSTs chat.postMessage with channel/thread_ts/text", async () => {
    const captured: Array<{ url: string; body: string; auth: string }> = [];
    const fakeFetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      captured.push({
        url,
        body: typeof init?.body === "string" ? init.body : "",
        auth: (init?.headers as Record<string, string>)["Authorization"] ?? "",
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const adapter = createSlackAdapter(
      { botToken: "xoxb-rotated", signingSecret: SECRET },
      { apiBaseUrl: "https://slack.test/api", fetch: fakeFetch },
    );

    await adapter.sendReply({
      event: {
        idempotencyKey: "E1",
        workspaceId: "T1",
        channelId: "C1",
        userId: "U1",
        threadTs: "1.0",
        ts: "1.1",
        text: "hi",
        subtype: "app_mention",
      },
      text: "hello back",
    });

    expect(captured.length).toBe(1);
    expect(captured[0]?.url).toBe("https://slack.test/api/chat.postMessage");
    expect(captured[0]?.auth).toBe("Bearer xoxb-rotated");
    const body = JSON.parse(captured[0]?.body ?? "{}");
    expect(body.channel).toBe("C1");
    expect(body.thread_ts).toBe("1.0");
    expect(body.text).toBe("hello back");
  });

  test("falls back to event.ts when no threadTs is set", async () => {
    let captured: { thread_ts?: string } = {};
    const fakeFetch: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await adapter.sendReply({
      event: {
        idempotencyKey: "E",
        workspaceId: "T",
        channelId: "C",
        userId: "U",
        ts: "9.9",
        text: "x",
        subtype: "message",
      },
      text: "out",
    });
    expect(captured.thread_ts).toBe("9.9");
  });

  test("throws on Slack ok:false response", async () => {
    const fakeFetch: typeof fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(
      adapter.sendReply({
        event: {
          idempotencyKey: "E",
          workspaceId: "T",
          channelId: "C",
          userId: "U",
          ts: "1.0",
          text: "x",
          subtype: "message",
        },
        text: "x",
      }),
    ).rejects.toThrow(/channel_not_found/);
  });
});
