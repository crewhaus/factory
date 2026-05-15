import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type ChannelAdapter,
  DiscordAdapterError,
  type InboundEvent,
  type ParsedInbound,
  type RawRequest,
  createDiscordAdapter,
  generateEd25519Keypair,
  signDiscordBody,
  verifyDiscordSignature,
} from "./index";

// `tsc -b` also compiles this file into `dist/`; resolve fixtures from the
// source tree so both the src and dist test copies find them.
const FIXTURES_DIR = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES_DIR, `${name}.json`), "utf8");

let publicKeyHex: string;
let privateKeyPem: string;
let otherPublicKeyHex: string;

beforeAll(() => {
  const k = generateEd25519Keypair();
  publicKeyHex = k.publicKeyHex;
  privateKeyPem = k.privateKeyPem;
  otherPublicKeyHex = generateEd25519Keypair().publicKeyHex;
});

function signedHeaders(body: string, ts: string | number = "1700000000"): Headers {
  const sig = signDiscordBody({ body, timestamp: ts, privateKeyPem });
  const h = new Headers();
  h.set("X-Signature-Ed25519", sig);
  h.set("X-Signature-Timestamp", String(ts));
  return h;
}

function adapter(
  overrides: Partial<{ publicKeyHex: string; fetch: typeof fetch }> = {},
): ChannelAdapter {
  return createDiscordAdapter(
    {
      applicationId: "200000000000000001",
      botToken: "Bot.token",
      publicKeyHex: overrides.publicKeyHex ?? publicKeyHex,
    },
    {
      apiBaseUrl: "https://test.discord.local",
      ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    },
  );
}

describe("verifyDiscordSignature (T8)", () => {
  test("matches a valid signature", () => {
    const body = fixture("ping");
    const r = verifyDiscordSignature({
      headers: signedHeaders(body),
      body,
      publicKeyHex,
    });
    expect(r).toBe(true);
  });

  test("rejects a tampered body", () => {
    const body = fixture("ping");
    const headers = signedHeaders(body);
    expect(
      verifyDiscordSignature({
        headers,
        body: `${body}--tampered`,
        publicKeyHex,
      }),
    ).toBe(false);
  });

  test("rejects wrong public key", () => {
    const body = fixture("ping");
    expect(
      verifyDiscordSignature({
        headers: signedHeaders(body),
        body,
        publicKeyHex: otherPublicKeyHex,
      }),
    ).toBe(false);
  });

  test("rejects missing X-Signature-Ed25519 header", () => {
    const body = fixture("ping");
    const headers = signedHeaders(body);
    headers.delete("X-Signature-Ed25519");
    expect(verifyDiscordSignature({ headers, body, publicKeyHex })).toBe(false);
  });

  test("rejects missing X-Signature-Timestamp header", () => {
    const body = fixture("ping");
    const headers = signedHeaders(body);
    headers.delete("X-Signature-Timestamp");
    expect(verifyDiscordSignature({ headers, body, publicKeyHex })).toBe(false);
  });

  test("rejects malformed sig hex (wrong length)", () => {
    const body = fixture("ping");
    const headers = new Headers({
      "X-Signature-Ed25519": "deadbeef",
      "X-Signature-Timestamp": "1700000000",
    });
    expect(verifyDiscordSignature({ headers, body, publicKeyHex })).toBe(false);
  });

  test("rejects non-numeric timestamp", () => {
    const body = fixture("ping");
    const headers = signedHeaders(body, "abc");
    expect(verifyDiscordSignature({ headers, body, publicKeyHex })).toBe(false);
  });

  test("rejects malformed publicKeyHex", () => {
    const body = fixture("ping");
    expect(
      verifyDiscordSignature({
        headers: signedHeaders(body),
        body,
        publicKeyHex: "not-hex",
      }),
    ).toBe(false);
  });
});

describe("parseInbound — fixtures (T2)", () => {
  test("ping → challenge with PONG body", () => {
    const a = adapter();
    const body = fixture("ping");
    const r = a.parseInbound({ headers: signedHeaders(body), body });
    expect(r.kind).toBe("challenge");
    if (r.kind === "challenge") {
      expect(JSON.parse(r.challenge)).toEqual({ type: 1 });
    }
  });

  test("slash_command_basic → event with text /<name>", () => {
    const a = adapter();
    const body = fixture("slash_command_basic");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.kind).toBe("event");
    expect(r.event.text).toBe("/ping");
    expect(r.event.channelId).toBe("300000000000000001");
    expect(r.event.userId).toBe("500000000000000001");
    expect(r.event.workspaceId).toBe("400000000000000001");
    expect(r.event.threadTs).toBeUndefined();
  });

  test("slash_command_with_options → text encodes name=value pairs", () => {
    const a = adapter();
    const body = fixture("slash_command_with_options");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("/summarize url=https://example.com depth=3");
  });

  test("slash_command_thread → channelId is thread id, threadTs set", () => {
    const a = adapter();
    const body = fixture("slash_command_thread");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.channelId).toBe("300000000000000099");
    expect(r.event.threadTs).toBe("300000000000000099");
  });

  test('slash_command_dm → workspaceId is "dm", user.id used', () => {
    const a = adapter();
    const body = fixture("slash_command_dm");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.workspaceId).toBe("dm");
    expect(r.event.userId).toBe("500000000000000007");
  });

  test("component_button → text [component:<custom_id>]", () => {
    const a = adapter();
    const body = fixture("component_button");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("[component:approve:doc-123]");
  });

  test("modal_submit → text encodes form fields", () => {
    const a = adapter();
    const body = fixture("modal_submit");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.text).toBe("feedback-form: rating=5 comment=loved it");
  });

  test("unknown_type → skip", () => {
    const a = adapter();
    const body = fixture("unknown_type");
    const r = a.parseInbound({ headers: signedHeaders(body), body });
    expect(r.kind).toBe("skip");
  });

  test("missing_user → skip", () => {
    const a = adapter();
    const body = fixture("missing_user");
    const r = a.parseInbound({ headers: signedHeaders(body), body });
    expect(r.kind).toBe("skip");
  });

  test("malformed JSON → skip", () => {
    const a = adapter();
    const r = a.parseInbound({ headers: new Headers(), body: "not json{" });
    expect(r.kind).toBe("skip");
  });

  test("idempotencyKey == interaction id", () => {
    const a = adapter();
    const body = fixture("slash_command_basic");
    const r = a.parseInbound({ headers: signedHeaders(body), body }) as Extract<
      ParsedInbound,
      { kind: "event" }
    >;
    expect(r.event.idempotencyKey).toBe("100000000000000002");
  });
});

describe("sendReply / setTyping (T3)", () => {
  function captureFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (input: string | Request | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    return { calls, fetch: f };
  }

  const event: InboundEvent = {
    idempotencyKey: "100000000000000002",
    workspaceId: "400000000000000001",
    channelId: "300000000000000001",
    userId: "500000000000000001",
    ts: "100000000000000002",
    text: "/ping",
    subtype: "message",
  };

  test("sendReply POSTs /channels/{channelId}/messages with content", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = adapter({ fetch: f });
    await a.sendReply({ event, text: "pong" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://test.discord.local/channels/300000000000000001/messages");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.content).toBe("pong");
    const auth = (calls[0]?.init.headers as Record<string, string> | undefined)?.["Authorization"];
    expect(auth).toBe("Bot Bot.token");
  });

  test("sendReply throws DiscordAdapterError on HTTP error", async () => {
    const f = (async () =>
      new Response("server fail", {
        status: 500,
        statusText: "Internal",
      })) as unknown as typeof fetch;
    const a = adapter({ fetch: f });
    await expect(a.sendReply({ event, text: "x" })).rejects.toThrow(DiscordAdapterError);
  });

  test("setTyping POSTs /channels/{channelId}/typing", async () => {
    const { calls, fetch: f } = captureFetch();
    const a = adapter({ fetch: f });
    await a.setTyping({ event });
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://test.discord.local/channels/300000000000000001/typing");
  });
});

describe("createDiscordAdapter.verify()", () => {
  test("forwards to verifyDiscordSignature", () => {
    const a = adapter();
    const body = fixture("ping");
    expect(a.verify({ headers: signedHeaders(body), body })).toBe(true);
    expect(a.verify({ headers: new Headers(), body })).toBe(false);
  });
});
