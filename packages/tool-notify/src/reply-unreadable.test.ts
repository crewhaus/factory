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
  chatPost,
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
