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

// The static fixtures carry a fixed (old) messages[].timestamp; pin the
// replay-window clock near it so the signature tests exercise auth, not age.
const FIXTURE_TS = 1700000123;
const FIXTURE_NOW = () => FIXTURE_TS * 1000;

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
      now: FIXTURE_NOW,
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    },
  );
}

describe("verifyWhatsAppSignature (T8)", () => {
  test("matches a valid signature", () => {
    const body = fixture("text_message");
    const r = verifyWhatsAppSignature(
      {
        headers: signedHeaders(body),
        body,
        appSecret: APP_SECRET,
      },
      { now: FIXTURE_NOW },
    );
    expect(r).toBe(true);
  });

  // SECURITY: WhatsApp signs only the body (no signed timestamp), so a captured
  // signed POST verified forever. Bound it with messages[].timestamp.
  test("rejects a stale captured message under the real clock (replay window)", () => {
    const body = fixture("text_message"); // fixture ts is years old vs Date.now()
    expect(
      verifyWhatsAppSignature({ headers: signedHeaders(body), body, appSecret: APP_SECRET }),
    ).toBe(false);
  });

  test("rejects a message whose timestamp is in the future beyond tolerance", () => {
    const body = fixture("text_message");
    expect(
      verifyWhatsAppSignature(
        { headers: signedHeaders(body), body, appSecret: APP_SECRET },
        { now: () => (FIXTURE_TS - 3600) * 1000 },
      ),
    ).toBe(false);
  });

  test("accepts a status-only webhook with no message timestamp (no freshness gate)", () => {
    const body = fixture("status_only");
    expect(
      verifyWhatsAppSignature({ headers: signedHeaders(body), body, appSecret: APP_SECRET }),
    ).toBe(true);
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

  test("react POSTs a type:reaction message targeting the inbound message id", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = adapter({ fetch: f });
    expect(a.react).toBeDefined();
    await a.react?.({ event, emoji: "white_check_mark" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe(`https://test.graph.local/v22.0/${PHONE_NUMBER_ID}/messages`);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.type).toBe("reaction");
    expect(body.to).toBe("15554443333");
    expect(body.reaction).toEqual({ message_id: "wamid.xx", emoji: "✅" });
    const auth = (calls[0]?.init.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  test("react throws on a Meta-side error envelope (router swallows it)", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ error: { message: "message not found" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const a = adapter({ fetch: f });
    await expect(a.react?.({ event, emoji: "eyes" })).rejects.toThrow(/message not found/);
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

  test("preserves the cause chain via toJSON()", () => {
    const root = new Error("socket hang up");
    const e = new WhatsAppAdapterError("send failed", root);
    expect(e.cause).toBe(root);
    expect(e.toJSON()).toEqual({
      name: "WhatsAppAdapterError",
      code: "channel",
      message: "send failed",
      cause: { name: "Error", message: "socket hang up" },
    });
  });
});

describe("signWhatsAppBody (T8)", () => {
  test('produces a "sha256=<64-hex>" header that verify accepts', () => {
    const body = fixture("text_message");
    const sig = signWhatsAppBody({ body, appSecret: APP_SECRET });
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    const h = new Headers({ "X-Hub-Signature-256": sig });
    expect(
      verifyWhatsAppSignature({ headers: h, body, appSecret: APP_SECRET }, { now: FIXTURE_NOW }),
    ).toBe(true);
  });

  test("is deterministic for a given (body, secret)", () => {
    const a = signWhatsAppBody({ body: "{}", appSecret: APP_SECRET });
    const b = signWhatsAppBody({ body: "{}", appSecret: APP_SECRET });
    expect(a).toBe(b);
  });

  test("differs when the secret differs", () => {
    const a = signWhatsAppBody({ body: "{}", appSecret: APP_SECRET });
    const b = signWhatsAppBody({ body: "{}", appSecret: "other-secret" });
    expect(a).not.toBe(b);
  });
});

describe("parseInbound — branch coverage (T2)", () => {
  // Build a well-formed text payload and let callers perturb a single field.
  function payloadWith(msg: Record<string, unknown>, value: Record<string, unknown> = {}): string {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "100100100100",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: PHONE_NUMBER_ID },
                messages: [{ id: "wamid.gen-1", from: "15554443333", ...msg }],
                ...value,
              },
            },
          ],
        },
      ],
    });
  }

  test("non-object JSON (e.g. a bare number) → skip", () => {
    const a = adapter();
    expect(a.parseInbound({ headers: new Headers(), body: "42" }).kind).toBe("skip");
  });

  test("JSON null literal → skip", () => {
    const a = adapter();
    expect(a.parseInbound({ headers: new Headers(), body: "null" }).kind).toBe("skip");
  });

  test("change.field other than 'messages' → skip", () => {
    const a = adapter();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "message_template_status_update", value: {} }] }],
    });
    expect(a.parseInbound({ headers: new Headers(), body }).kind).toBe("skip");
  });

  test("messages field present but value missing → skip", () => {
    const a = adapter();
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages" }] }],
    });
    expect(a.parseInbound({ headers: new Headers(), body }).kind).toBe("skip");
  });

  test("message missing id (non-string) → skip", () => {
    const a = adapter();
    const body = payloadWith({ id: undefined, type: "text", text: { body: "hi" } });
    expect(a.parseInbound({ headers: new Headers(), body }).kind).toBe("skip");
  });

  test("message missing from (non-string) → skip", () => {
    const a = adapter();
    const body = payloadWith({ from: undefined, type: "text", text: { body: "hi" } });
    expect(a.parseInbound({ headers: new Headers(), body }).kind).toBe("skip");
  });

  test("metadata present but phone_number_id empty → skip", () => {
    const a = adapter();
    const body = payloadWith(
      { type: "text", text: { body: "hi" } },
      { metadata: { display_phone_number: "15551112222" } },
    );
    expect(a.parseInbound({ headers: new Headers(), body }).kind).toBe("skip");
  });

  test("text message with empty body → event with text ''", () => {
    const a = adapter();
    const body = payloadWith({ type: "text", text: { body: "" } });
    const r = a.parseInbound({ headers: new Headers(), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.text).toBe("");
  });

  test("text message with no text field → event with text ''", () => {
    const a = adapter();
    const body = payloadWith({ type: "text" });
    const r = a.parseInbound({ headers: new Headers(), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("");
  });

  test("missing timestamp → event ts defaults to ''", () => {
    const a = adapter();
    const body = payloadWith({ type: "text", text: { body: "hi" } });
    const r = a.parseInbound({ headers: new Headers(), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.ts).toBe("");
  });

  test("button_reply with missing id → text '[button:]'", () => {
    const a = adapter();
    const body = payloadWith({ type: "interactive", interactive: { type: "button_reply" } });
    const r = a.parseInbound({ headers: new Headers(), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("[button:]");
  });

  test("list_reply with missing id → text '[list:]'", () => {
    const a = adapter();
    const body = payloadWith({ type: "interactive", interactive: { type: "list_reply" } });
    const r = a.parseInbound({ headers: new Headers(), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("[list:]");
  });

  test("interactive with unknown sub-type → skip", () => {
    const a = adapter();
    const body = payloadWith({ type: "interactive", interactive: { type: "flow_reply" } });
    expect(a.parseInbound({ headers: new Headers(), body }).kind).toBe("skip");
  });

  test("interactive with no interactive object → skip", () => {
    const a = adapter();
    const body = payloadWith({ type: "interactive" });
    expect(a.parseInbound({ headers: new Headers(), body }).kind).toBe("skip");
  });

  test("video type (unsupported) → skip via default branch", () => {
    const a = adapter();
    const body = payloadWith({ type: "video" });
    expect(a.parseInbound({ headers: new Headers(), body }).kind).toBe("skip");
  });

  test("ignores prototype-polluting keys in the payload", () => {
    const a = adapter();
    const body = `{"object":"whatsapp_business_account","__proto__":{"polluted":true},"entry":[{"changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"${PHONE_NUMBER_ID}"},"messages":[{"id":"wamid.p","from":"15554443333","type":"text","text":{"body":"hi"}}]}}]}]}`;
    const r = a.parseInbound({ headers: new Headers(), body });
    expect(r.kind).toBe("event");
    // No global prototype mutation occurred.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("createWhatsAppAdapter — config / options", () => {
  const event: InboundEvent = {
    idempotencyKey: "wamid.xx",
    workspaceId: PHONE_NUMBER_ID,
    channelId: "15554443333",
    userId: "15554443333",
    ts: "1700000123",
    text: "hello",
    subtype: "message",
  };

  test("id is 'whatsapp'", () => {
    expect(adapter().id).toBe("whatsapp");
  });

  test("defaults to graph.facebook.com / v22.0 when no base url given", async () => {
    const calls: string[] = [];
    const f = (async (input: string | Request | URL) => {
      calls.push(String(input));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    // No apiBaseUrl override and no env var → default host.
    const prev = process.env["WHATSAPP_API_BASE_URL"];
    Reflect.deleteProperty(process.env, "WHATSAPP_API_BASE_URL");
    try {
      const a = createWhatsAppAdapter(
        { phoneNumberId: PHONE_NUMBER_ID, accessToken: ACCESS_TOKEN, appSecret: APP_SECRET },
        { fetch: f },
      );
      await a.sendReply({ event, text: "x" });
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "WHATSAPP_API_BASE_URL");
      else process.env["WHATSAPP_API_BASE_URL"] = prev;
    }
    expect(calls[0]).toBe(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`);
  });

  test("honours WHATSAPP_API_BASE_URL env override", async () => {
    const calls: string[] = [];
    const f = (async (input: string | Request | URL) => {
      calls.push(String(input));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const prev = process.env["WHATSAPP_API_BASE_URL"];
    process.env["WHATSAPP_API_BASE_URL"] = "https://env.graph.local";
    try {
      const a = createWhatsAppAdapter(
        { phoneNumberId: PHONE_NUMBER_ID, accessToken: ACCESS_TOKEN, appSecret: APP_SECRET },
        { fetch: f },
      );
      await a.sendReply({ event, text: "x" });
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "WHATSAPP_API_BASE_URL");
      else process.env["WHATSAPP_API_BASE_URL"] = prev;
    }
    expect(calls[0]).toBe(`https://env.graph.local/v22.0/${PHONE_NUMBER_ID}/messages`);
  });

  test("honours apiVersion option", async () => {
    const calls: string[] = [];
    const f = (async (input: string | Request | URL) => {
      calls.push(String(input));
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const a = createWhatsAppAdapter(
      { phoneNumberId: PHONE_NUMBER_ID, accessToken: ACCESS_TOKEN, appSecret: APP_SECRET },
      { apiBaseUrl: "https://test.graph.local", apiVersion: "v21.0", fetch: f },
    );
    await a.sendReply({ event, text: "x" });
    expect(calls[0]).toBe(`https://test.graph.local/v21.0/${PHONE_NUMBER_ID}/messages`);
  });
});

describe("sendReply — response handling (T3)", () => {
  const event: InboundEvent = {
    idempotencyKey: "wamid.xx",
    workspaceId: PHONE_NUMBER_ID,
    channelId: "15554443333",
    userId: "15554443333",
    ts: "1700000123",
    text: "hello",
    subtype: "message",
  };

  test("resolves on a 200 with non-JSON content-type (body not parsed)", async () => {
    const f = (async () =>
      new Response("OK", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof fetch;
    const a = adapter({ fetch: f });
    await expect(a.sendReply({ event, text: "x" })).resolves.toBeUndefined();
  });

  test("resolves on a 200 with no content-type header", async () => {
    const f = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const a = adapter({ fetch: f });
    await expect(a.sendReply({ event, text: "x" })).resolves.toBeUndefined();
  });

  test("resolves on a 200 JSON success envelope without an error field", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const a = adapter({ fetch: f });
    await expect(a.sendReply({ event, text: "x" })).resolves.toBeUndefined();
  });

  test("error envelope with no message falls back to 'unknown'", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ error: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const a = adapter({ fetch: f });
    await expect(a.sendReply({ event, text: "x" })).rejects.toThrow(/messages POST error: unknown/);
  });
});
