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

  test("rejects when UTF-16 length matches but UTF-8 byte length differs", () => {
    // "é" is one UTF-16 code unit but two UTF-8 bytes; "e" is one unit / one
    // byte. They pass the `.length` check yet must be rejected by the
    // byte-length guard before timingSafeEqual (which throws on size mismatch).
    const h = new Headers({ "X-Telegram-Bot-Api-Secret-Token": "é" });
    expect(verifyTelegramSecret({ headers: h, secretToken: "e" })).toBe(false);
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

  test("non-numeric update_id → skip", () => {
    const a = adapter();
    const body = JSON.stringify({ update_id: "not-a-number", message: {} });
    expect(a.parseInbound(withHeaders(SECRET, body)).kind).toBe("skip");
  });

  test("JSON array body (object, not null, but not an Update) → skip", () => {
    const a = adapter();
    // Arrays are typeof "object" and non-null; they lack a numeric update_id.
    expect(a.parseInbound(withHeaders(SECRET, "[1,2,3]")).kind).toBe("skip");
  });

  test("message with chat but no `from` (userId undefined) → skip", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200001,
      message: { message_id: 5, chat: { id: 9, type: "private" }, text: "hi" },
    });
    expect(a.parseInbound(withHeaders(SECRET, body)).kind).toBe("skip");
  });

  test("message text prefers `text` over `caption`", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200002,
      message: {
        message_id: 6,
        from: { id: 1 },
        chat: { id: 9, type: "private" },
        text: "the-text",
        caption: "the-caption",
      },
    });
    const r = a.parseInbound(withHeaders(SECRET, body)) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("the-text");
  });

  test("bot_command entity → subtype app_mention", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200003,
      message: {
        message_id: 7,
        from: { id: 1 },
        chat: { id: 9, type: "private" },
        text: "/start",
        entities: [{ type: "bot_command", offset: 0, length: 6 }],
      },
    });
    const r = a.parseInbound(withHeaders(SECRET, body)) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.subtype).toBe("app_mention");
  });

  test("entity with unrelated type (e.g. `url`) → subtype message", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200004,
      message: {
        message_id: 8,
        from: { id: 1 },
        chat: { id: 9, type: "private" },
        text: "see https://example.com",
        entities: [{ type: "url", offset: 4, length: 19 }],
      },
    });
    const r = a.parseInbound(withHeaders(SECRET, body)) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.subtype).toBe("message");
  });

  test("bot message is NOT skipped when no selfBotId is configured", () => {
    // selfBotId-less adapter must let bot-authored messages through (the
    // `opts.selfBotId !== undefined` short-circuit guards this branch).
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local" },
    );
    const body = JSON.stringify({
      update_id: 200005,
      message: {
        message_id: 9,
        from: { id: 9999, is_bot: true, username: "crewhaus_bot" },
        chat: { id: 9, type: "private" },
        text: "I am the bot",
      },
    });
    const r = a.parseInbound(withHeaders(SECRET, body)) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.userId).toBe("9999");
  });

  test("non-self bot message is NOT skipped even with selfBotId set", () => {
    // selfBotId is set, message is from a bot, but a *different* bot id →
    // exercises the `String(from.id) === selfBotId` false branch.
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200006,
      message: {
        message_id: 10,
        from: { id: 8888, is_bot: true, username: "other_bot" },
        chat: { id: 9, type: "private" },
        text: "different bot",
      },
    });
    const r = a.parseInbound(withHeaders(SECRET, body)) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.userId).toBe("8888");
  });

  test("edited_message with neither text nor caption → skip", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200007,
      edited_message: { message_id: 11, from: { id: 1 }, chat: { id: 9, type: "private" } },
    });
    expect(a.parseInbound(withHeaders(SECRET, body)).kind).toBe("skip");
  });

  test("edited_message in a topic → channelId chatId:topicId, threadTs set", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200008,
      edited_message: {
        message_id: 12,
        from: { id: 1 },
        chat: { id: -100123, type: "supergroup" },
        message_thread_id: 21,
        text: "edited in topic",
      },
    });
    const r = a.parseInbound(withHeaders(SECRET, body)) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.channelId).toBe("-100123:21");
    expect(r.event.threadTs).toBe("21");
  });

  test("callback_query without `message` → skip", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200009,
      callback_query: { id: "cq", from: { id: 7 }, data: "go" },
    });
    expect(a.parseInbound(withHeaders(SECRET, body)).kind).toBe("skip");
  });

  test("callback_query without `from` (userId undefined) → skip", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200010,
      callback_query: {
        id: "cq",
        data: "go",
        message: { message_id: 3, chat: { id: 9, type: "private" } },
      },
    });
    expect(a.parseInbound(withHeaders(SECRET, body)).kind).toBe("skip");
  });

  test("callback_query whose message lacks `chat` → skip", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200011,
      callback_query: { id: "cq", from: { id: 7 }, data: "go", message: { message_id: 3 } },
    });
    expect(a.parseInbound(withHeaders(SECRET, body)).kind).toBe("skip");
  });

  test("callback_query without `data` → text defaults to empty string", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200012,
      callback_query: {
        id: "cq",
        from: { id: 7 },
        message: { message_id: 3, chat: { id: 9, type: "private" } },
      },
    });
    const r = a.parseInbound(withHeaders(SECRET, body)) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.text).toBe("");
  });

  test("callback_query in a topic → channelId chatId:topicId, threadTs set", () => {
    const a = adapter();
    const body = JSON.stringify({
      update_id: 200013,
      callback_query: {
        id: "cq",
        from: { id: 7 },
        data: "approve",
        message: {
          message_id: 3,
          chat: { id: -100123, type: "supergroup" },
          message_thread_id: 42,
        },
      },
    });
    const r = a.parseInbound(withHeaders(SECRET, body)) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.channelId).toBe("-100123:42");
    expect(r.event.threadTs).toBe("42");
    expect(r.event.text).toBe("approve");
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

  test("sendReply tolerates a 2xx response without a JSON content-type", async () => {
    // res.ok is true but content-type is not application/json, so the
    // ok:false body inspection is skipped and no error is thrown.
    const f = (async () =>
      new Response("OK", { status: 200, statusText: "OK" })) as unknown as typeof fetch;
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await expect(a.sendReply({ event, text: "x" })).resolves.toBeUndefined();
  });

  test("sendReply accepts a 2xx JSON response with ok:true", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await expect(a.sendReply({ event, text: "x" })).resolves.toBeUndefined();
  });

  test("setTyping forwards message_thread_id when threadTs is set", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await a.setTyping({ event: { ...event, threadTs: "17", channelId: "4242:17" } });
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.message_thread_id).toBe(17);
  });

  test("setTyping rejects malformed workspaceId", async () => {
    const a = adapter();
    await expect(a.setTyping({ event: { ...event, workspaceId: "not-a-number" } })).rejects.toThrow(
      /invalid workspaceId/,
    );
  });

  test("setTyping ignores a non-200 response (best-effort)", async () => {
    // setTyping never checks res.ok; a 500 must NOT reject.
    let called = false;
    const f = (async () => {
      called = true;
      return new Response("nope", { status: 500, statusText: "Server Error" });
    }) as unknown as typeof fetch;
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await expect(a.setTyping({ event })).resolves.toBeUndefined();
    expect(called).toBe(true);
  });
});

describe("react (Phase 3 §3.2)", () => {
  function captureFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (input: string | Request | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true, result: true }), {
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

  test("posts setMessageReaction with chat_id, message_id, and a mapped allowed emoji", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    expect(a.react).toBeDefined();
    await a.react?.({ event, emoji: "eyes" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`https://test.telegram.local/bot${BOT_TOKEN}/setMessageReaction`);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.chat_id).toBe(4242);
    expect(body.message_id).toBe(7);
    expect(body.reaction).toEqual([{ type: "emoji", emoji: "👀" }]);
  });

  test("maps white_check_mark/warning to Telegram-allowed emoji", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await a.react?.({ event, emoji: "white_check_mark" });
    await a.react?.({ event, emoji: "warning" });
    expect(JSON.parse(String(calls[0]?.init.body)).reaction[0].emoji).toBe("👍");
    expect(JSON.parse(String(calls[1]?.init.body)).reaction[0].emoji).toBe("😱");
  });

  test("rejects when chat/message id is not numeric", async () => {
    const { fetch: f } = captureFetch();
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await expect(a.react?.({ event: { ...event, ts: "nope" }, emoji: "eyes" })).rejects.toThrow(
      TelegramAdapterError,
    );
  });

  test("throws on Telegram-side ok:false (router swallows it)", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ ok: false, description: "REACTION_INVALID" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const a = createTelegramAdapter(
      { botToken: BOT_TOKEN, secretToken: SECRET },
      { apiBaseUrl: "https://test.telegram.local", fetch: f },
    );
    await expect(a.react?.({ event, emoji: "eyes" })).rejects.toThrow(/REACTION_INVALID/);
  });
});

describe("apiBaseUrl resolution", () => {
  const event: InboundEvent = {
    idempotencyKey: "1",
    workspaceId: "4242",
    channelId: "4242",
    userId: "4242",
    ts: "7",
    text: "hi",
    subtype: "message",
  };

  function captureUrlFetch() {
    const calls: string[] = [];
    const f = (async (input: string | Request | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { calls, fetch: f };
  }

  test("falls back to TELEGRAM_API_BASE_URL env var when no apiBaseUrl option", async () => {
    const prev = process.env["TELEGRAM_API_BASE_URL"];
    process.env["TELEGRAM_API_BASE_URL"] = "https://env.telegram.local";
    try {
      const { calls, fetch: f } = captureUrlFetch();
      const a = createTelegramAdapter({ botToken: BOT_TOKEN, secretToken: SECRET }, { fetch: f });
      await a.sendReply({ event, text: "x" });
      expect(calls[0]).toBe(`https://env.telegram.local/bot${BOT_TOKEN}/sendMessage`);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "TELEGRAM_API_BASE_URL");
      else process.env["TELEGRAM_API_BASE_URL"] = prev;
    }
  });

  test("falls back to the public Telegram API host when nothing is configured", async () => {
    const prev = process.env["TELEGRAM_API_BASE_URL"];
    Reflect.deleteProperty(process.env, "TELEGRAM_API_BASE_URL");
    try {
      const { calls, fetch: f } = captureUrlFetch();
      const a = createTelegramAdapter({ botToken: BOT_TOKEN, secretToken: SECRET }, { fetch: f });
      await a.sendReply({ event, text: "x" });
      expect(calls[0]).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    } finally {
      if (prev !== undefined) process.env["TELEGRAM_API_BASE_URL"] = prev;
    }
  });
});
