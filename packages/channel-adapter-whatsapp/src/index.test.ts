import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ChannelAdapter,
  type InboundEvent,
  type ParsedInbound,
  type RawRequest,
  WhatsAppAdapterError,
  createWhatsAppAdapter,
  signWhatsAppBody,
  verifyWhatsAppSignature,
} from "./index";

// `tsc -b` also compiles this file into `dist/`; resolve fixtures from the
// source tree so both the src and dist test copies find them.
const FIXTURES_DIR = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8");

const APP_SECRET = "wa-app-secret";
const PHONE_NUMBER_ID = "999000999000";
const ACCESS_TOKEN = "EAAxxxxxxxxx";

function signedHeaders(body: string): Headers {
  const sig = signWhatsAppBody({ body, appSecret: APP_SECRET });
  const h = new Headers();
  h.set("X-Hub-Signature-256", sig);
  return h;
}

function adapter(overrides: { fetch?: typeof fetch } = {}): ChannelAdapter {
  return createWhatsAppAdapter(
    { phoneNumberId: PHONE_NUMBER_ID, accessToken: ACCESS_TOKEN, appSecret: APP_SECRET },
    {
      apiBaseUrl: "https://test.graph.local",
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    },
  );
}

describe("verifyWhatsAppSignature (T8)", () => {
  test("matches a valid signature", () => {
    const body = fixture("text_message");
    const r = verifyWhatsAppSignature({
      headers: signedHeaders(body),
      body,
      appSecret: APP_SECRET,
    });
    expect(r).toBe(true);
  });

  test("rejects tampered body", () => {
    const body = fixture("text_message");
    const headers = signedHeaders(body);
    expect(
      verifyWhatsAppSignature({ headers, body: `${body}--tampered`, appSecret: APP_SECRET }),
    ).toBe(false);
  });

  test("rejects wrong secret", () => {
    const body = fixture("text_message");
    expect(
      verifyWhatsAppSignature({
        headers: signedHeaders(body),
        body,
        appSecret: "wrong-secret",
      }),
    ).toBe(false);
  });

  test("rejects missing X-Hub-Signature-256", () => {
    expect(
      verifyWhatsAppSignature({ headers: new Headers(), body: "{}", appSecret: APP_SECRET }),
    ).toBe(false);
  });

  test("rejects malformed signature header (missing sha256= prefix)", () => {
    const headers = new Headers({ "X-Hub-Signature-256": "deadbeef" });
    expect(verifyWhatsAppSignature({ headers, body: "{}", appSecret: APP_SECRET })).toBe(false);
  });

  test("rejects malformed signature hex (wrong length)", () => {
    const headers = new Headers({ "X-Hub-Signature-256": "sha256=deadbeef" });
    expect(verifyWhatsAppSignature({ headers, body: "{}", appSecret: APP_SECRET })).toBe(false);
  });
});

describe("parseInbound — fixtures (T2)", () => {
  test("text_message → event with body verbatim", () => {
    const a = adapter();
    const body = fixture("text_message");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.text).toBe("hello bot");
    expect(r.event.userId).toBe("15554443333");
    expect(r.event.channelId).toBe("15554443333");
    expect(r.event.workspaceId).toBe(PHONE_NUMBER_ID);
    expect(r.event.idempotencyKey).toBe("wamid.HBgNMTU1NTQ0NDMzMzMVAgASGBYzRUI");
  });

  test("button_reply → text [button:<id>]", () => {
    const a = adapter();
    const body = fixture("button_reply");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("[button:approve-doc-7]");
  });

  test("list_reply → text [list:<id>]", () => {
    const a = adapter();
    const body = fixture("list_reply");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("[list:tier-pro]");
  });

  test('image_with_caption → text "[image] <caption>"', () => {
    const a = adapter();
    const body = fixture("image_with_caption");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("[image] look at this graph");
  });

  test("image_no_caption → skip (no actionable text)", () => {
    const a = adapter();
    const body = fixture("image_no_caption");
    expect(a.parseInbound({ headers: signedHeaders(body), body }).kind).toBe("skip");
  });

  test("audio → skip", () => {
    const a = adapter();
    const body = fixture("audio_message");
    expect(a.parseInbound({ headers: signedHeaders(body), body }).kind).toBe("skip");
  });

  test("status_only (delivery receipt) → skip", () => {
    const a = adapter();
    const body = fixture("status_only");
    expect(a.parseInbound({ headers: signedHeaders(body), body }).kind).toBe("skip");
  });

  test("sticker → skip", () => {
    const a = adapter();
    const body = fixture("sticker");
    expect(a.parseInbound({ headers: signedHeaders(body), body }).kind).toBe("skip");
  });

  test("wrong_object (Facebook page) → skip", () => {
    const a = adapter();
    const body = fixture("wrong_object");
    expect(a.parseInbound({ headers: signedHeaders(body), body }).kind).toBe("skip");
  });

  test("missing_metadata → skip", () => {
    const a = adapter();
    const body = fixture("missing_metadata");
    expect(a.parseInbound({ headers: signedHeaders(body), body }).kind).toBe("skip");
  });

  test("malformed JSON → skip", () => {
    const a = adapter();
    expect(a.parseInbound({ headers: new Headers(), body: "{not json" }).kind).toBe("skip");
  });

  test("idempotencyKey == messages[].id (gateway dedups across redelivery)", () => {
    const a = adapter();
    const body = fixture("text_message");
    const r1 = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    const r2 = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r1.event.idempotencyKey).toBe(r2.event.idempotencyKey);
  });
});

describe("sendReply / setTyping (T3)", () => {
  function captureFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (input: string | Request | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(
        JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.xx" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as unknown as typeof fetch;
    return { calls, fetch: f };
  }

  const event: InboundEvent = {
    idempotencyKey: "wamid.xx",
    workspaceId: PHONE_NUMBER_ID,
    channelId: "15554443333",
    userId: "15554443333",
    ts: "1700000123",
    text: "hello",
    subtype: "message",
  };

  test("sendReply POSTs /v22.0/<phoneId>/messages with text body", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = adapter({ fetch: f });
    await a.sendReply({ event, text: "hi back" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`https://test.graph.local/v22.0/${PHONE_NUMBER_ID}/messages`);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.to).toBe("15554443333");
    expect(body.type).toBe("text");
    expect(body.text.body).toBe("hi back");
    const auth = (calls[0]?.init.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  test("sendReply throws on HTTP error", async () => {
    const f = (async () =>
      new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
      })) as unknown as typeof fetch;
    const a = adapter({ fetch: f });
    await expect(a.sendReply({ event, text: "x" })).rejects.toThrow(WhatsAppAdapterError);
  });

  test("sendReply throws on Meta-side error envelope", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ error: { message: "Invalid phone number" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const a = adapter({ fetch: f });
    await expect(a.sendReply({ event, text: "x" })).rejects.toThrow(/Invalid phone number/);
  });

  test("setTyping is a no-op (no public API) — returns without error", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = adapter({ fetch: f });
    await a.setTyping({ event });
    expect(calls.length).toBe(0);
  });
});

describe("createWhatsAppAdapter.verify()", () => {
  test("forwards to verifyWhatsAppSignature", () => {
    const a = adapter();
    const body = fixture("text_message");
    expect(a.verify({ headers: signedHeaders(body), body })).toBe(true);
    expect(a.verify({ headers: new Headers(), body })).toBe(false);
  });
});

describe("WhatsAppAdapterError", () => {
  test('is a CrewhausError with code "channel"', () => {
    const e = new WhatsAppAdapterError("test");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("channel");
    expect(e.name).toBe("WhatsAppAdapterError");
  });
});
