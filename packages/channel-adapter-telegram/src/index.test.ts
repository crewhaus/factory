import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ChannelAdapter,
  type InboundEvent,
  type ParsedInbound,
  type RawRequest,
  TelegramAdapterError,
  createTelegramAdapter,
  verifyTelegramSecret,
} from "./index";

// `tsc -b` also compiles this file into `dist/`; resolve fixtures from the
// source tree so both the src and dist test copies find them.
const FIXTURES_DIR = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8");

const SECRET = "tg-secret-shhh";
const BOT_TOKEN = "1234:test-token";
const ADAPTER_OPTS = (extras: Record<string, unknown> = {}) => ({
  apiBaseUrl: "https://test.telegram.local",
  fetch: extras["fetch"] as typeof fetch | undefined,
  selfBotId: "9999",
});

function withHeaders(token: string | undefined, body: string): RawRequest {
  const h = new Headers();
  if (token !== undefined) h.set("X-Telegram-Bot-Api-Secret-Token", token);
  return { headers: h, body };
}

function adapter(extra: Record<string, unknown> = {}): ChannelAdapter {
  return createTelegramAdapter({ botToken: BOT_TOKEN, secretToken: SECRET }, ADAPTER_OPTS(extra));
}

describe("verifyTelegramSecret (T8)", () => {
  test("matches a valid secret token", () => {
    const h = new Headers({ "X-Telegram-Bot-Api-Secret-Token": SECRET });
    expect(verifyTelegramSecret({ headers: h, secretToken: SECRET })).toBe(true);
  });

  test("rejects a tampered secret", () => {
    const h = new Headers({ "X-Telegram-Bot-Api-Secret-Token": `${SECRET}-tampered` });
    expect(verifyTelegramSecret({ headers: h, secretToken: SECRET })).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(verifyTelegramSecret({ headers: new Headers(), secretToken: SECRET })).toBe(false);
  });

  test("constant-time guard rejects different lengths", () => {
    const h = new Headers({ "X-Telegram-Bot-Api-Secret-Token": "x" });
    expect(verifyTelegramSecret({ headers: h, secretToken: SECRET })).toBe(false);
  });

  test("rejects empty supplied token", () => {
    const h = new Headers({ "X-Telegram-Bot-Api-Secret-Token": "" });
    expect(verifyTelegramSecret({ headers: h, secretToken: SECRET })).toBe(false);
  });
});

describe("createTelegramAdapter.verify()", () => {
  test("forwards header to verifyTelegramSecret", () => {
    const a = adapter();
    expect(a.verify(withHeaders(SECRET, "{}"))).toBe(true);
    expect(a.verify(withHeaders("wrong-secret-here", "{}"))).toBe(false);
    expect(a.verify(withHeaders(undefined, "{}"))).toBe(false);
  });
});

describe("parseInbound — fixtures (T2)", () => {
  test("private_message → event with workspaceId=chat.id, channelId=chat.id", () => {
    const a = adapter();
    const result = a.parseInbound(withHeaders(SECRET, fixture("private_message"))) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(result.kind).toBe("event");
    expect(result.event.workspaceId).toBe("4242");
    expect(result.event.channelId).toBe("4242");
    expect(result.event.userId).toBe("4242");
    expect(result.event.text).toBe("hello bot");
    expect(result.event.idempotencyKey).toBe("100001");
    expect(result.event.subtype).toBe("message");
    expect(result.event.threadTs).toBeUndefined();
  });

  test("group_message → event with workspaceId = supergroup chat.id", () => {
    const a = adapter();
    const r = a.parseInbound(withHeaders(SECRET, fixture("group_message"))) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.workspaceId).toBe("-100123");
    expect(r.event.channelId).toBe("-100123");
    expect(r.event.threadTs).toBeUndefined();
  });

  test("group_topic_message → channelId = chatId:topicId, threadTs set", () => {
    const a = adapter();
    const r = a.parseInbound(withHeaders(SECRET, fixture("group_topic_message"))) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.channelId).toBe("-100123:17");
    expect(r.event.threadTs).toBe("17");
  });

  test("edited_message produces a normal event (gateway dedups via update_id)", () => {
    const a = adapter();
    const r = a.parseInbound(withHeaders(SECRET, fixture("edited_message"))) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.idempotencyKey).toBe("100004");
    expect(r.event.text).toBe("hello bot (edited)");
  });

  test("callback_query → event whose text is the callback `data`", () => {
    const a = adapter();
    const r = a.parseInbound(withHeaders(SECRET, fixture("callback_query"))) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.text).toBe("approve:123");
    expect(r.event.idempotencyKey).toBe("100005");
  });

  test("bot_mention with mention entity → subtype app_mention", () => {
    const a = adapter();
    const r = a.parseInbound(withHeaders(SECRET, fixture("bot_mention"))) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.subtype).toBe("app_mention");
  });

  test("sticker_only (no text/caption) → skip", () => {
    const a = adapter();
    expect(a.parseInbound(withHeaders(SECRET, fixture("sticker_only"))).kind).toBe("skip");
  });

  test("photo_with_caption → event with caption as text", () => {
    const a = adapter();
    const r = a.parseInbound(withHeaders(SECRET, fixture("photo_with_caption"))) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("look at this graph");
  });

  test("bot_self matching selfBotId → skip", () => {
    const a = adapter();
    expect(a.parseInbound(withHeaders(SECRET, fixture("bot_self"))).kind).toBe("skip");
  });

  test("missing_chat → skip", () => {
    const a = adapter();
    expect(a.parseInbound(withHeaders(SECRET, fixture("missing_chat"))).kind).toBe("skip");
  });

  test("non_message_update (poll) → skip", () => {
    const a = adapter();
    expect(a.parseInbound(withHeaders(SECRET, fixture("non_message_update"))).kind).toBe("skip");
  });

  test("malformed JSON body → skip", () => {
    const a = adapter();
    expect(a.parseInbound(withHeaders(SECRET, "{not-json")).kind).toBe("skip");
  });

  test("empty body → skip", () => {
    const a = adapter();
    expect(a.parseInbound(withHeaders(SECRET, "null")).kind).toBe("skip");
  });
});

describe("sendReply / setTyping (T3)", () => {
  function captureFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (input: string | Request | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, fetch: f };
  }

  const event: InboundEvent = {
    idempotencyKey: "100001",
    workspaceId: "4242",
    channelId: "4242",
    userId: "4242",
    ts: "7",
    text: "hello",
    subtype: "message",
  };

  test("sendReply POSTs sendMessage with correct chat_id + text", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await a.sendReply({ event, text: "hi back" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`https://test.telegram.local/bot${BOT_TOKEN}/sendMessage`);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.chat_id).toBe(4242);
    expect(body.text).toBe("hi back");
    expect(body.message_thread_id).toBeUndefined();
  });

  test("sendReply forwards message_thread_id when threadTs set", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await a.sendReply({
      event: { ...event, threadTs: "17", channelId: "4242:17" },
      text: "topic reply",
    });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.message_thread_id).toBe(17);
  });

  test("sendReply throws on HTTP error", async () => {
    const f = (async () =>
      new Response("boom", { status: 502, statusText: "Bad Gateway" })) as unknown as typeof fetch;
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await expect(a.sendReply({ event, text: "x" })).rejects.toThrow(TelegramAdapterError);
  });

  test("sendReply throws on Telegram-side ok:false", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await expect(a.sendReply({ event, text: "x" })).rejects.toThrow(/chat not found/);
  });

  test("sendReply rejects malformed workspaceId", async () => {
    const a = adapter();
    await expect(
      a.sendReply({ event: { ...event, workspaceId: "not-a-number" }, text: "x" }),
    ).rejects.toThrow(/invalid workspaceId/);
  });

  test("setTyping POSTs sendChatAction with action=typing", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await a.setTyping({ event });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`https://test.telegram.local/bot${BOT_TOKEN}/sendChatAction`);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.chat_id).toBe(4242);
    expect(body.action).toBe("typing");
  });
});
