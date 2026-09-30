/**
 * A cut through a credential the endpoint echoed leaves none of it (net
 * attacker review; tool-http's C050 fix, carried over).
 *
 * The redactor replaces whole spellings of a secret. A byte cap (maxBytes,
 * which the model chooses) or the 500-character excerpt an error quotes can
 * cut an echoed `Authorization` header, leaving every character of the
 * credential but the last, which no whole spelling matches. In a JSON result
 * the cut is not at the end of the text the redactor sees, so its backstop
 * for a cut edge does not fire either. Each cut is now trimmed where it is
 * made: the text that comes back ends exactly where the credential began.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  __setPrivateHostsAllowedForTest,
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  chatPost,
  deliveryCheck,
  registerNotifyConfig,
  smsSend,
  webhookPost,
} from "./index";
import { applyAuth, redactorFor } from "./net";

const LISTED = "CREWHAUS_TEST_ECHO_CUT_TOKEN";
const PROVIDER = "CREWHAUS_TEST_ECHO_CUT_PROVIDER";
const TOKEN = "hook_9f3aa1c2d4e5f60718293a4b5c6d7e8f0a1b";
const PROVIDER_TOKEN = "prov_tok_9f3aa1c2d4e5f60718293a4b5c6d7e8f";

/** How many filler characters the next reply puts before the echoed header. */
let pad = 0;
let hits = 0;
let server: ReturnType<typeof Bun.serve>;
let origin = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      hits++;
      await req.text();
      const path = new URL(req.url).pathname;
      // An endpoint that repeats the request's Authorization header, padded
      // so the cut lands where the test wants it, with plenty after it.
      const body = `${"p".repeat(pad)}${req.headers.get("authorization")}${" ".repeat(700)}`;
      return new Response(body, { status: path.includes("fail") ? 400 : 200 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  hits = 0;
  __setPrivateHostsAllowedForTest(true);
  process.env[LISTED] = TOKEN;
  process.env[PROVIDER] = PROVIDER_TOKEN;
  registerNotifyConfig({
    allowed_origins: [origin],
    allowed_secret_envs: [LISTED],
    allowed_sms_recipients: ["+1555*"],
    providers: {
      gw: {
        endpoint: `${origin}/sms-fail`,
        statusEndpoint: `${origin}/status/{id}`,
        auth: { type: "bearer", envVar: PROVIDER },
        fields: { to: "To", body: "Body" },
      },
    },
  });
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _resetNotifyConfig();
  _resetIdempotencyLedger();
  delete process.env[LISTED];
  delete process.env[PROVIDER];
});

async function call(tool: RegisteredTool, input: unknown): Promise<string> {
  return String(await tool.execute(input, undefined as never));
}

/** Characters of the credential the cut keeps: one, a few, most, all but one. */
const KEEP = [1, 5, 12, TOKEN.length - 1];
const MAX_BYTES = 256;
const EXCERPT = 500;
const BEARER = "Bearer ";

describe("a byte cap through an echoed credential", () => {
  test("WebhookPost's response ends where the credential began", async () => {
    let checked = 0;
    for (const keep of KEEP) {
      pad = MAX_BYTES - BEARER.length - keep;
      const out = await call(webhookPost, {
        url: `${origin}/hook`,
        payload: { n: keep },
        auth: { type: "bearer", envVar: LISTED },
        maxBytes: MAX_BYTES,
      });
      const parsed = JSON.parse(out) as { sent: boolean; response: string };
      expect({ keep, sent: parsed.sent, response: parsed.response }).toEqual({
        keep,
        sent: true,
        response: `${"p".repeat(pad)}${BEARER}`,
      });
      checked++;
    }
    expect(checked).toBe(KEEP.length);
    expect(hits).toBe(KEEP.length);
  });

  test("the read-only DeliveryCheck's body ends where the credential began", async () => {
    let checked = 0;
    for (const keep of KEEP) {
      pad = MAX_BYTES - BEARER.length - keep;
      const out = await call(deliveryCheck, {
        provider: "gw",
        messageId: `m${keep}`,
        maxBytes: MAX_BYTES,
      });
      const parsed = JSON.parse(out) as { body: string; truncated?: boolean };
      expect({ keep, body: parsed.body, truncated: parsed.truncated }).toEqual({
        keep,
        body: `${"p".repeat(pad)}${BEARER}`,
        truncated: true,
      });
      if (keep >= 6) expect(out).not.toContain(PROVIDER_TOKEN.slice(0, keep));
      checked++;
    }
    expect(checked).toBe(KEEP.length);
  });
});

describe("the excerpt an error quotes, through an echoed credential", () => {
  const cases: Array<[string, RegisteredTool, () => Record<string, unknown>]> = [
    [
      "WebhookPost, a status that is not retried",
      webhookPost,
      () => ({ url: `${origin}/hook-fail`, payload: {}, auth: { type: "bearer", envVar: LISTED } }),
    ],
    [
      "ChatPost in API mode",
      chatPost,
      () => ({
        platform: "slack",
        apiBaseUrl: `${origin}/api-fail`,
        tokenEnv: LISTED,
        channel: "C1",
        text: "hello",
      }),
    ],
    [
      "SmsSend through a provider",
      smsSend,
      () => ({ provider: "gw", to: "+15550001111", body: "hello" }),
    ],
  ];

  for (const [name, tool, input] of cases) {
    test(`${name}: nothing was sent, and the excerpt ends where the credential began`, async () => {
      let checked = 0;
      for (const keep of KEEP) {
        pad = EXCERPT - BEARER.length - keep;
        const out = await call(tool, input());
        expect({ keep, starts: out.startsWith("nothing was sent:") }).toEqual({
          keep,
          starts: true,
        });
        expect({ keep, tail: out.slice(-20) }).toEqual({
          keep,
          tail: `${"p".repeat(20 - BEARER.length)}${BEARER}`,
        });
        checked++;
      }
      expect(checked).toBe(KEEP.length);
      expect(hits).toBe(KEEP.length);
    });
  }
});

describe("what the redactor leaves alone (net regression review)", () => {
  const PASSWORD = "Xk9-quartz-lantern-77";

  test("a Basic profile's username is the account's name, not a secret", () => {
    const headers: Record<string, string> = {};
    const applied = applyAuth(
      headers,
      { type: "basic", envVar: "PW", username: "deploybot" },
      ["PW"],
      { PW: PASSWORD },
    );
    if (!applied.ok) throw new Error(applied.message);
    const redact = redactorFor(applied.secrets);
    expect(redact("assignee deploybot")).toBe("assignee deploybot");
    expect(redact("https://x.example/users/deploybot")).toBe("https://x.example/users/deploybot");
    expect(redact(`echo ${headers["Authorization"]}`)).toBe("echo Basic <redacted>");
    expect(redact(`echo deploybot:${PASSWORD.slice(0, 8)}`)).toBe("echo <redacted>");
  });

  test("an SMTP username is replaced whole, as 0.7.0 did, and never cut-matched", () => {
    const redact = redactorFor([PASSWORD], ["ops-mailer@example.com"]);
    expect(redact("from ops-mailer@example.com.")).toBe("from <redacted>.");
    expect(redact("from ops-mailer@exam")).toBe("from ops-mailer@exam");
    expect(redact(`auth ${PASSWORD.slice(0, 8)}`)).toBe("auth <redacted>");
  });
});
