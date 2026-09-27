/**
 * An id is substituted into a path as an id, never as a path (C120,
 * flag-truth-3#2, security-5#1).
 *
 * `encodeURIComponent` leaves `.` and `..` as they are, and the URL parser
 * then resolves them, so in 0.7.0:
 *
 * - ChatDelete on discord with messageId `..` sent
 *   `DELETE /api/v10/channels/<id>/` — the delete-channel route — and
 *   reported `deleted: true`; ChatUpdate `..` modified the channel.
 * - DeliveryCheck, which is readOnly and runs unasked in plan and auto
 *   mode, read `/sms/` (other recipients' messages) for `.` and the API
 *   root for `..`, with the operator's provider credential, and returned
 *   the raw body. Its own guard said it existed to stop exactly this.
 *
 * Each site now refuses a dot-only value with a message saying why, and the
 * chat tools and DeliveryCheck also check the URL the parser produced: the
 * path requested must be the path built, with the value written in.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  __setPrivateHostsAllowedForTest,
  _resetNotifyConfig,
  chatDelete,
  chatPost,
  chatReact,
  chatUpdate,
  deliveryCheck,
  registerNotifyConfig,
} from "./index";
import { isDotSegment, substituteIntoUrl } from "./net";

const TOKEN_VAR = "CREWHAUS_TEST_DOT_SEGMENT_TOKEN";
const CHANNEL = "1100000000000000001";

let requests: Array<{ method: string; pathname: string }> = [];
let http: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      await req.arrayBuffer();
      requests.push({ method: req.method, pathname: new URL(req.url).pathname });
      return new Response(JSON.stringify({ id: "1", status: "delivered" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  origin = `http://127.0.0.1:${http.port}`;
});

afterAll(() => {
  http.stop(true);
});

beforeEach(() => {
  requests = [];
  process.env[TOKEN_VAR] = "discord-bot-token-value";
  __setPrivateHostsAllowedForTest(true);
  registerNotifyConfig({
    allowed_origins: [origin],
    allowed_secret_envs: [TOKEN_VAR],
    providers: {
      gateway: {
        endpoint: `${origin}/sms`,
        statusEndpoint: `${origin}/sms/{id}`,
        statusPath: "status",
      },
      plivoStyle: {
        endpoint: `${origin}/sms`,
        statusEndpoint: `${origin}/Message/{id}/`,
        statusPath: "status",
      },
      suffixed: {
        endpoint: `${origin}/sms`,
        statusEndpoint: `${origin}/sms/{id}/status`,
        statusPath: "status",
      },
      queried: {
        endpoint: `${origin}/sms`,
        statusEndpoint: `${origin}/status?id={id}`,
        statusPath: "status",
      },
    },
  });
});

afterEach(() => {
  delete process.env[TOKEN_VAR];
  __setPrivateHostsAllowedForTest(false);
  _resetNotifyConfig();
});

const discord = (extra: Record<string, unknown>) => ({
  platform: "discord",
  apiBaseUrl: `${origin}/api/v10`,
  tokenEnv: TOKEN_VAR,
  channel: CHANNEL,
  ...extra,
});

describe("the discord chat tools refuse a dot segment for an id (C120)", () => {
  for (const id of [".", ".."]) {
    test(`messageId "${id}": ChatDelete, ChatUpdate and ChatReact send nothing and say why`, async () => {
      const deleted = String(await chatDelete.execute(discord({ messageId: id }), {} as never));
      const updated = String(
        await chatUpdate.execute(discord({ messageId: id, text: "x" }), {} as never),
      );
      const reacted = String(
        await chatReact.execute(discord({ messageId: id, emoji: "x" }), {} as never),
      );
      expect(deleted).not.toContain('"deleted":true');
      expect(updated).not.toContain('"updated":true');
      expect(reacted).not.toContain('"reacted":true');
      for (const out of [deleted, updated, reacted]) {
        expect(out).toContain(`messageId "${id}" is a relative path segment`);
      }
      expect(requests).toEqual([]);
    });
  }

  test('a channel of ".." cannot post to, and an emoji of ".." cannot react at, another endpoint', async () => {
    const posted = String(
      await chatPost.execute(discord({ channel: "..", text: "x" }), {} as never),
    );
    const reacted = String(
      await chatReact.execute(discord({ messageId: "999", emoji: ".." }), {} as never),
    );
    expect(posted).not.toContain('"sent":true');
    expect(posted).toContain('channel ".." is a relative path segment');
    expect(reacted).not.toContain('"reacted":true');
    expect(reacted).toContain('emoji ".." is a relative path segment');
    expect(requests).toEqual([]);
  });

  test("an ordinary id still reaches the message it names", async () => {
    const out = JSON.parse(
      String(await chatDelete.execute(discord({ messageId: "999" }), {} as never)),
    );
    expect(out.deleted).toBe(true);
    expect(requests).toEqual([
      { method: "DELETE", pathname: `/api/v10/channels/${CHANNEL}/messages/999` },
    ]);
  });
});

describe("DeliveryCheck substitutes an id, not a path (C120)", () => {
  for (const provider of ["gateway", "plivoStyle", "suffixed"]) {
    for (const id of [".", ".."]) {
      test(`${provider}: messageId "${id}" is refused before anything is read`, async () => {
        const out = String(await deliveryCheck.execute({ provider, messageId: id }, {} as never));
        expect(out).not.toContain('"body"');
        expect(out).toContain(`messageId "${id}" is a relative path segment`);
        expect(requests).toEqual([]);
      });
    }
  }

  test("a dot inside an id is part of the id", async () => {
    for (const id of ["SM.123", "a..b"]) {
      const out = JSON.parse(
        String(await deliveryCheck.execute({ provider: "gateway", messageId: id }, {} as never)),
      );
      expect(out.deliveryStatus).toBe("delivered");
    }
    expect(requests.map((r) => r.pathname)).toEqual(["/sms/SM.123", "/sms/a..b"]);
  });

  test("an id in the query string cannot reach the path at all", async () => {
    const out = JSON.parse(
      String(await deliveryCheck.execute({ provider: "queried", messageId: "m1" }, {} as never)),
    );
    expect(out.deliveryStatus).toBe("delivered");
    expect(requests).toEqual([{ method: "GET", pathname: "/status" }]);
  });
});

describe("the helpers the sites share (C120)", () => {
  test("isDotSegment is true only for a value made of dots", () => {
    const hits = [".", "..", "...", "a.b", "..a", "a..", "", "%2e%2e"].filter(isDotSegment);
    expect(hits).toEqual([".", "..", "..."]);
  });

  test("substituteIntoUrl refuses a value the parser would turn into a different path", () => {
    const template = "https://api.example.test/v1/messages/{id}/status";
    const ok = substituteIntoUrl(template, "{id}", "a/b?c#d");
    expect(ok.ok && ok.url.pathname).toBe("/v1/messages/a%2Fb%3Fc%23d/status");
    // Without isDotSegment in front, the literal-path check still holds.
    expect(substituteIntoUrl(template, "{id}", "..")).toEqual({ ok: false, why: "reshaped" });
    expect(substituteIntoUrl(template, "{id}", ".")).toEqual({ ok: false, why: "reshaped" });
    expect(substituteIntoUrl("not a url {id}", "{id}", "x")).toEqual({ ok: false, why: "invalid" });
  });
});
