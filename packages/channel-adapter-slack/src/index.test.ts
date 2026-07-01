import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSlackAdapter, signSlackBody, verifySlackSignature } from "./index";

// `tsc -b` also compiles this file into `dist/`; resolve fixtures from the
// source tree so both the src and dist test copies find them.
const FIXTURES = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "fixtures");
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
    // Flip the final hex digit so the tamper is ALWAYS a real one-character
    // change. (The old `slice(0, -2) + "00"` was a no-op ~1/256 of the time —
    // whenever the timestamp-derived HMAC already ended in "00" — which made
    // this test flaky.)
    const real = headers.get("x-slack-signature") ?? "v0=0";
    headers.set("x-slack-signature", real.slice(0, -1) + (real.endsWith("0") ? "1" : "0"));
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

  function reactionBody(reaction: string, evType = "reaction_added"): string {
    return JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "Ev_react_1",
      event: {
        type: evType,
        user: "U07USER01",
        reaction,
        item: { type: "message", channel: "C0CHAN01", ts: "1700000000.000200" },
      },
    });
  }

  test("parses a 👍 reaction_added into a thumbs-up reaction", () => {
    const out = adapter().parseInbound({ headers: new Headers(), body: reactionBody("+1") });
    expect(out.kind).toBe("reaction");
    if (out.kind !== "reaction") return;
    expect(out.reaction.vote).toBe("up");
    expect(out.reaction.channelId).toBe("C0CHAN01");
    expect(out.reaction.messageTs).toBe("1700000000.000200");
    expect(out.reaction.userId).toBe("U07USER01");
    expect(out.reaction.idempotencyKey).toBe("Ev_react_1");
  });

  test("maps thumbsup/-1/thumbsdown names to up/down", () => {
    expect(
      adapter().parseInbound({ headers: new Headers(), body: reactionBody("thumbsup") }),
    ).toMatchObject({ reaction: { vote: "up" } });
    expect(
      adapter().parseInbound({ headers: new Headers(), body: reactionBody("-1") }),
    ).toMatchObject({ reaction: { vote: "down" } });
    expect(
      adapter().parseInbound({ headers: new Headers(), body: reactionBody("thumbsdown") }),
    ).toMatchObject({ reaction: { vote: "down" } });
  });

  test("maps skin-tone-modified thumbs (Slack sends +1::skin-tone-N)", () => {
    expect(
      adapter().parseInbound({ headers: new Headers(), body: reactionBody("+1::skin-tone-4") }),
    ).toMatchObject({ reaction: { vote: "up" } });
    expect(
      adapter().parseInbound({
        headers: new Headers(),
        body: reactionBody("thumbsdown::skin-tone-2"),
      }),
    ).toMatchObject({ reaction: { vote: "down" } });
  });

  test("skips a non-vote emoji (incl. the bot's own status reactions)", () => {
    for (const e of ["eyes", "white_check_mark", "warning", "tada"]) {
      expect(adapter().parseInbound({ headers: new Headers(), body: reactionBody(e) }).kind).toBe(
        "skip",
      );
    }
  });

  test("skips reaction_removed (append-only log can't retract)", () => {
    const out = adapter().parseInbound({
      headers: new Headers(),
      body: reactionBody("+1", "reaction_removed"),
    });
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

describe("react (Phase 3 §3.2)", () => {
  const sampleEvent = {
    idempotencyKey: "E1",
    workspaceId: "T1",
    channelId: "C1",
    userId: "U1",
    ts: "1234.5678",
    text: "hello",
    subtype: "message" as const,
  };

  test("posts to reactions.add with channel + timestamp + emoji name", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = createSlackAdapter(
      { botToken: "xoxb-test", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    expect(adapter.react).toBeDefined();
    await adapter.react?.({ event: sampleEvent, emoji: "eyes" });
    expect(capturedUrl).toBe("https://slack.com/api/reactions.add");
    const body = JSON.parse(capturedBody) as { channel: string; timestamp: string; name: string };
    expect(body.channel).toBe("C1");
    expect(body.timestamp).toBe("1234.5678");
    expect(body.name).toBe("eyes");
  });

  test("strips leading/trailing colons from emoji name", async () => {
    let capturedBody = "";
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await adapter.react?.({ event: sampleEvent, emoji: ":white_check_mark:" });
    const body = JSON.parse(capturedBody) as { name: string };
    expect(body.name).toBe("white_check_mark");
  });

  test("treats already_reacted as benign no-op", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: "already_reacted" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(adapter.react?.({ event: sampleEvent, emoji: "eyes" })).resolves.toBeUndefined();
  });

  test("throws on non-already_reacted error", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(adapter.react?.({ event: sampleEvent, emoji: "eyes" })).rejects.toThrow(
      /invalid_auth/,
    );
  });

  test("does not parse a non-JSON reactions.add body (skips content-type guard)", async () => {
    // No content-type header => the `ct.includes("application/json")` branch is
    // false and the body is never read; an ok:false JSON payload would
    // otherwise throw, so reaching `resolves` proves the branch was skipped.
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(adapter.react?.({ event: sampleEvent, emoji: "eyes" })).resolves.toBeUndefined();
  });

  test("throws on a non-OK reactions.add HTTP status", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("nope", { status: 500, statusText: "Internal Server Error" });
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(adapter.react?.({ event: sampleEvent, emoji: "eyes" })).rejects.toThrow(
      /reactions\.add failed: 500/,
    );
  });
});

describe("createSlackAdapter — verify (adapter method wiring)", () => {
  test("delegates to verifySlackSignature and accepts a fresh request", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, SECRET);
    const adapter = createSlackAdapter({ botToken: "xoxb", signingSecret: SECRET });
    expect(adapter.verify({ headers, body })).toBe(true);
  });

  test("rejects a request signed with the wrong secret", () => {
    const body = APP_MENTION;
    const headers = signedHeaders(body, "some-other-secret");
    const adapter = createSlackAdapter({ botToken: "xoxb", signingSecret: SECRET });
    expect(adapter.verify({ headers, body })).toBe(false);
  });

  test("forwards an injected `now` so tolerance is deterministic", () => {
    const body = APP_MENTION;
    const fixedTs = 1700000000;
    const headers = signedHeaders(body, SECRET, fixedTs);
    // `now` far outside the ±5 min window => stale => false, proving the
    // `opts.now !== undefined` branch threads the clock through to verify.
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { now: () => fixedTs * 1000 + 60 * 60_000 },
    );
    expect(adapter.verify({ headers, body })).toBe(false);
  });
});

describe("security regressions (T8 — hardening)", () => {
  // parseInt is lenient and stops at the first non-digit, so a header like
  // "1700000000junk" parses to a fresh-looking 1700000000 for the replay-window
  // check. This must NOT be a bypass: the *raw* header string is bound into the
  // HMAC base (`v0:${timestamp}:${body}`), so a signature minted for the clean
  // timestamp cannot validate against the tampered one — and vice-versa.
  test("a parseInt-lenient timestamp header cannot be swapped past the HMAC", () => {
    const body = APP_MENTION;
    const ts = 1700000000;
    const sig = signSlackBody({ body, timestamp: ts, signingSecret: SECRET });

    const headers = new Headers();
    // Attacker keeps the timestamp inside the replay window numerically but
    // appends garbage, hoping parseInt-leniency lets it slide.
    headers.set("x-slack-request-timestamp", `${ts}junk`);
    headers.set("x-slack-signature", sig);

    const within = () => ts * 1000 + 1000; // numerically fresh
    expect(verifySlackSignature({ headers, body, signingSecret: SECRET }, { now: within })).toBe(
      false,
    );
  });

  // The signing secret is the only thing protecting the webhook; confirm that
  // forging a signature without it is impossible even with a known-good base.
  test("a signature computed under a different secret never validates", () => {
    const body = MESSAGE;
    const ts = 1700000001;
    const headers = new Headers();
    headers.set("x-slack-request-timestamp", String(ts));
    headers.set(
      "x-slack-signature",
      signSlackBody({ body, timestamp: ts, signingSecret: "attacker-secret" }),
    );
    expect(
      verifySlackSignature({ headers, body, signingSecret: SECRET }, { now: () => ts * 1000 }),
    ).toBe(false);
  });

  // parseInbound walks attacker-controlled JSON. A payload carrying a
  // "__proto__" key (or polluted nested object) must not mutate Object.prototype
  // nor leak through as a usable event.
  test("parseInbound does not pollute Object.prototype from a hostile payload", () => {
    const adapter = createSlackAdapter({ botToken: "xoxb", signingSecret: SECRET });
    const hostile =
      '{"type":"event_callback","__proto__":{"polluted":true},"event":{"type":"message","__proto__":{"polluted":true}}}';
    const out = adapter.parseInbound({ headers: new Headers(), body: hostile });
    // Missing required ids => skip, and crucially no prototype mutation.
    expect(out.kind).toBe("skip");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // A non-string text field must coerce to "" rather than leaking a non-string
  // (or object) into the normalised event the gateway trusts.
  test("parseInbound coerces a non-string text to empty string", () => {
    const adapter = createSlackAdapter({ botToken: "xoxb", signingSecret: SECRET });
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: {
        type: "message",
        channel: "C1",
        user: "U1",
        ts: "1.0",
        text: { nested: "object" },
      },
    });
    const out = adapter.parseInbound({ headers: new Headers(), body });
    expect(out.kind).toBe("event");
    if (out.kind !== "event") return;
    expect(out.event.text).toBe("");
  });
});

describe("createSlackAdapter — parseInbound selfBotId branches", () => {
  function bodyWithBot(botId: string) {
    return JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: "E1",
      event: {
        type: "message",
        bot_id: botId,
        text: "hi",
        channel: "C1",
        user: "U1",
        ts: "1.0",
      },
    });
  }

  test("skips a message authored by our own bot (bot_id === selfBotId)", () => {
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { selfBotId: "B_SELF" },
    );
    const out = adapter.parseInbound({ headers: new Headers(), body: bodyWithBot("B_SELF") });
    expect(out.kind).toBe("skip");
  });

  test("lets another bot's message through when selfBotId is set", () => {
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { selfBotId: "B_SELF" },
    );
    const out = adapter.parseInbound({ headers: new Headers(), body: bodyWithBot("B_OTHER") });
    expect(out.kind).toBe("event");
    if (out.kind !== "event") return;
    expect(out.event.workspaceId).toBe("T1");
    expect(out.event.userId).toBe("U1");
  });
});

describe("createSlackAdapter — sendReply edge cases", () => {
  const sampleEvent = {
    idempotencyKey: "E",
    workspaceId: "T",
    channelId: "C",
    userId: "U",
    ts: "1.0",
    text: "x",
    subtype: "message" as const,
  };

  test("throws on a non-OK HTTP status from chat.postMessage", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response("boom", { status: 502, statusText: "Bad Gateway" });
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(adapter.sendReply({ event: sampleEvent, text: "x" })).rejects.toThrow(
      /chat\.postMessage failed: 502 Bad Gateway/,
    );
  });

  test("does not parse a non-JSON chat.postMessage body (skips content-type guard)", async () => {
    // ok:false in the body would throw if parsed; no content-type header means
    // the guard is skipped, so a resolved promise proves the branch was not taken.
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 });
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(adapter.sendReply({ event: sampleEvent, text: "x" })).resolves.toBeUndefined();
  });

  test("accepts a JSON ok:true response without throwing", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(adapter.sendReply({ event: sampleEvent, text: "x" })).resolves.toBeUndefined();
  });
});

describe("createSlackAdapter — setTyping is a no-op", () => {
  test("resolves to undefined without performing any I/O", async () => {
    let called = false;
    const fakeFetch: typeof fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createSlackAdapter(
      { botToken: "xoxb", signingSecret: SECRET },
      { fetch: fakeFetch },
    );
    await expect(
      adapter.setTyping({
        event: {
          idempotencyKey: "E",
          workspaceId: "T",
          channelId: "C",
          userId: "U",
          ts: "1.0",
          text: "x",
          subtype: "message",
        },
      }),
    ).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});

describe("createSlackAdapter — apiBaseUrl resolution", () => {
  test("falls back to SLACK_API_BASE_URL env when no opt is given", async () => {
    const prev = process.env["SLACK_API_BASE_URL"];
    process.env["SLACK_API_BASE_URL"] = "https://env.slack.test/api";
    try {
      let capturedUrl = "";
      const fakeFetch: typeof fetch = async (url) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
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
          ts: "1.0",
          text: "x",
          subtype: "message",
        },
        text: "out",
      });
      expect(capturedUrl).toBe("https://env.slack.test/api/chat.postMessage");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "SLACK_API_BASE_URL");
      else process.env["SLACK_API_BASE_URL"] = prev;
    }
  });

  test("an explicit apiBaseUrl opt takes precedence over the env var", async () => {
    const prev = process.env["SLACK_API_BASE_URL"];
    process.env["SLACK_API_BASE_URL"] = "https://env.slack.test/api";
    try {
      let capturedUrl = "";
      const fakeFetch: typeof fetch = async (url) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      const adapter = createSlackAdapter(
        { botToken: "xoxb", signingSecret: SECRET },
        { apiBaseUrl: "https://opt.slack.test/api", fetch: fakeFetch },
      );
      await adapter.sendReply({
        event: {
          idempotencyKey: "E",
          workspaceId: "T",
          channelId: "C",
          userId: "U",
          ts: "1.0",
          text: "x",
          subtype: "message",
        },
        text: "out",
      });
      expect(capturedUrl).toBe("https://opt.slack.test/api/chat.postMessage");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "SLACK_API_BASE_URL");
      else process.env["SLACK_API_BASE_URL"] = prev;
    }
  });
});
