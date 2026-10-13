/**
 * A delivered message whose reply cannot be read is not reported as unsent
 * (net review of 0.7.1).
 *
 * 0.7.1's first cut made the reply reader throw on a reply it would not
 * decode, AFTER the request had been delivered. The sending tools caught
 * that and answered "nothing was sent", without writing the idempotency
 * ledger, so a retry with the same key delivered the message a second time.
 * A corrupt compressed reply went further and hung the call past its
 * deadline. Now the send reports what it knows: the message was delivered
 * (or, for Slack, whose verdict lives in the reply, that its fate is
 * unknown), and a retry under the same key replays that answer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  __setPrivateHostsAllowedForTest,
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  chatDelete,
  chatPost,
  chatReact,
  chatUpdate,
  registerNotifyConfig,
  webhookPost,
} from "./index";

const TOKEN_VAR = "CREWHAUS_TEST_REPLY_UNREADABLE_TOKEN";

/** A gzip reply with its middle bytes flipped: the decoder fails partway through. */
const corrupt = (() => {
  const gz = Uint8Array.from(gzipSync(JSON.stringify({ ok: true, filler: "x ".repeat(20_000) })));
  const mid = Math.floor(gz.length / 2);
  for (let i = mid; i < mid + 8; i++) gz[i] = (gz[i] as number) ^ 0xff;
  return gz;
})();

let server: ReturnType<typeof Bun.serve>;
let origin = "";
let posts: string[] = [];

beforeAll(() => {
  process.env[TOKEN_VAR] = ["xoxb", "-reply-unreadable-test-token"].join("");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      posts.push(path);
      await req.arrayBuffer();
      if (path.startsWith("/refuses/")) {
        // Slack's Web API refusing on a 200, with a reply longer than 256 bytes.
        return Response.json({
          ok: false,
          error: "invalid_blocks",
          errors: ["invalid additional property: x".repeat(20)],
          response_metadata: { messages: ["[ERROR] invalid block".repeat(10)] },
        });
      }
      if (path.startsWith("/plain/")) return new Response("ok");
      if (path.startsWith("/corrupt")) {
        return new Response(corrupt, {
          headers: { "content-encoding": "gzip", "content-type": "application/json" },
        });
      }
      // A stack of codings this reader will not decode: accepted, unreadable.
      return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
        headers: { "content-encoding": "gzip, br", "content-type": "application/json" },
      });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  Reflect.deleteProperty(process.env, TOKEN_VAR);
});

beforeEach(() => {
  posts = [];
  __setPrivateHostsAllowedForTest(true);
  _resetIdempotencyLedger();
  registerNotifyConfig({ allowed_origins: [origin], allowed_secret_envs: [TOKEN_VAR] });
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _resetNotifyConfig();
  _resetIdempotencyLedger();
});

describe("a delivered message whose reply cannot be read", () => {
  test("net-review#critical: a corrupt compressed reply ends the call at once, as sent", async () => {
    // The deadline is long on purpose: before the fix this call never
    // returned, and a deadline answer here would mean the read hung.
    const out = String(
      await webhookPost.execute({
        url: `${origin}/corrupt/hook`,
        payload: { e: 1 },
        timeoutMs: 10_000,
      }),
    );
    expect(JSON.parse(out)).toMatchObject({
      sent: true,
      status: 200,
      replyUnreadable:
        "the endpoint's reply is labelled as compressed but could not be decoded, so it was not read",
    });
    expect(posts).toEqual(["/corrupt/hook"]);
  }, 30_000);

  test("net-review: WebhookPost says sent, and a retry with the same key sends nothing more", async () => {
    const call = { url: `${origin}/hook`, payload: { e: 1 }, idempotencyKey: "deploy-42" };
    const first = String(await webhookPost.execute(call));
    const second = String(await webhookPost.execute(call));
    expect(first).not.toContain("nothing was sent");
    expect(JSON.parse(first)).toMatchObject({ sent: true, status: 200 });
    expect(JSON.parse(first).replyUnreadable).toContain("stack of content-encodings");
    expect(second).toBe(first);
    expect(posts).toEqual(["/hook"]);
  });

  test("net-review: Slack, whose verdict is in the reply, is reported as unknown, never as unsent", async () => {
    const call = {
      platform: "slack" as const,
      apiBaseUrl: `${origin}/api`,
      tokenEnv: TOKEN_VAR,
      channel: "C1",
      text: "hello",
      idempotencyKey: "standup-1",
    };
    const first = String(await chatPost.execute(call));
    const second = String(await chatPost.execute(call));
    expect(first).not.toContain("nothing was sent");
    const parsed = JSON.parse(first) as { sent: unknown; status: number; reason: string };
    expect(parsed).toMatchObject({ sent: null, status: 200 });
    expect(parsed.reason).toContain("could not be read");
    expect(second).toBe(first);
    expect(posts).toEqual(["/api/chat.postMessage"]);
  });
});

describe("Slack's verdict in a reply longer than maxBytes (net attacker review)", () => {
  const api = (base: string) => ({
    platform: "slack" as const,
    apiBaseUrl: `${origin}${base}`,
    tokenEnv: TOKEN_VAR,
    channel: "C1",
  });

  test("the same refusal is 'not sent' when it fits, and unknown, not sent: true, when it is cut", async () => {
    const whole = String(await chatPost.execute({ ...api("/refuses"), text: "hello" }));
    expect(whole).toBe(
      "nothing was sent: Slack accepted the request and refused the message: invalid_blocks",
    );
    const call = { ...api("/refuses"), text: "hello", maxBytes: 256, idempotencyKey: "cut-1" };
    const cut = String(await chatPost.execute(call));
    const parsed = JSON.parse(cut) as { sent: unknown; status: number; reason: string };
    expect(parsed).toMatchObject({ sent: null, status: 200 });
    expect(parsed.reason).toContain("longer than maxBytes");
    // Recorded, like any delivered request: a retry under the key sends nothing.
    expect(String(await chatPost.execute(call))).toBe(cut);
    expect(posts).toEqual(["/refuses/chat.postMessage", "/refuses/chat.postMessage"]);
  });

  test("an API reply that is not a JSON object is unknown too; an incoming webhook's plain ok is sent", async () => {
    const plainApi = JSON.parse(String(await chatPost.execute({ ...api("/plain"), text: "hi" })));
    expect(plainApi).toMatchObject({ sent: null, status: 200 });
    expect(plainApi.reason).toContain("not the JSON object");
    process.env["CREWHAUS_TEST_REPLY_UNREADABLE_HOOK"] = `${origin}/plain/hook`;
    try {
      const hook = String(
        await chatPost.execute(
          { platform: "slack", webhookUrlEnv: "CREWHAUS_TEST_REPLY_UNREADABLE_HOOK", text: "hi" },
          {
            toolConfig: {
              allowed_origins: [origin],
              allowed_secret_envs: [TOKEN_VAR, "CREWHAUS_TEST_REPLY_UNREADABLE_HOOK"],
            },
          } as never,
        ),
      );
      expect(JSON.parse(hook)).toMatchObject({ sent: true, mode: "webhook", status: 200 });
    } finally {
      Reflect.deleteProperty(process.env, "CREWHAUS_TEST_REPLY_UNREADABLE_HOOK");
    }
  });

  test("ChatUpdate, ChatDelete and ChatReact answer null for a cut verdict", async () => {
    const target = { ...api("/refuses"), messageId: "1.2", maxBytes: 256 };
    const outs = [
      JSON.parse(String(await chatUpdate.execute({ ...target, text: "edited" }))),
      JSON.parse(String(await chatDelete.execute(target))),
      JSON.parse(String(await chatReact.execute({ ...target, emoji: "tada" }))),
    ];
    expect(outs.map((o) => [o.updated, o.deleted, o.reacted, o.status])).toEqual([
      [null, undefined, undefined, 200],
      [undefined, null, undefined, 200],
      [undefined, undefined, null, 200],
    ]);
    for (const o of outs) expect(o.reason).toContain("longer than maxBytes");
  });
});
