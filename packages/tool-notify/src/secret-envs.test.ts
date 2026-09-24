/**
 * A tool call may only name a credential variable the operator listed
 * (C054, flag-truth-3#1).
 *
 * In 0.7.0 every credential variable name was tool input (WebhookPost
 * auth.envVar, signing.secretEnv and urlEnv; the chat tools' tokenEnv and
 * webhookUrlEnv; EmailSend's usernameEnv and passwordEnv), and any
 * correctly shaped process variable was read and sent: a model, or the text
 * steering it, could put ANTHROPIC_API_KEY in a header bound for an allowed
 * (possibly multi-tenant) origin, where the egress classifier sees only the
 * name. Now `tool_config.notify.allowed_secret_envs` lists them, and a
 * provider's own operator-written `auth.envVar` is read only for that
 * provider.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type Server, createServer } from "node:net";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import {
  __setPrivateHostsAllowedForTest,
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  chatDelete,
  chatPost,
  chatReact,
  chatUpdate,
  emailSend,
  registerNotifyConfig,
  smsSend,
  webhookPost,
} from "./index";
import { NotifyPermissionError, buildNotifyConfig } from "./net";

const LISTED = "CREWHAUS_TEST_NOTIFY_LISTED";
const OTHER = "CREWHAUS_TEST_NOTIFY_OTHER_SECRET";
const OTHER_URL = "CREWHAUS_TEST_NOTIFY_OTHER_URL";
const PROVIDER = "CREWHAUS_TEST_NOTIFY_PROVIDER_KEY";
const LISTED_VALUE = "listed-notify-secret-1234";
const OTHER_VALUE = "unlisted-notify-secret-5678";
const PROVIDER_VALUE = "provider-only-secret-9012";

type Hit = { path: string; authorization: string | null; anything: string | null };
let hits: Hit[] = [];
let http: ReturnType<typeof Bun.serve>;
let origin = "";
let smtp: Server;
let smtpPort = 0;
let smtpConnections = 0;

beforeAll(async () => {
  http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      hits.push({
        path: new URL(req.url).pathname,
        authorization: req.headers.get("authorization"),
        anything: req.headers.get("x-anything"),
      });
      await req.text();
      return new Response(
        JSON.stringify({ ok: true, ts: "1.1", sid: "SM1", echo: req.headers.get("x-anything") }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    },
  });
  origin = `http://127.0.0.1:${http.port}`;
  smtp = createServer((socket) => {
    smtpConnections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", () => resolve()));
  smtpPort = (smtp.address() as { port: number }).port;
});

afterAll(() => {
  http.stop(true);
  smtp.close();
});

beforeEach(() => {
  hits = [];
  smtpConnections = 0;
  __setPrivateHostsAllowedForTest(true);
  process.env[LISTED] = LISTED_VALUE;
  process.env[OTHER] = OTHER_VALUE;
  process.env[OTHER_URL] = `${origin}/hook`;
  process.env[PROVIDER] = PROVIDER_VALUE;
  registerNotifyConfig({
    allowed_origins: [origin],
    allowed_recipients: ["ops@example.com"],
    allowed_smtp_hosts: ["127.0.0.1"],
    allowed_secret_envs: [LISTED],
    providers: {
      gw: {
        endpoint: `${origin}/sms`,
        auth: { type: "bearer", envVar: PROVIDER },
        fields: { to: "To", body: "Body" },
        idPath: "sid",
      },
    },
  });
});

afterEach(() => {
  __setPrivateHostsAllowedForTest(false);
  _resetNotifyConfig();
  _resetIdempotencyLedger();
  for (const name of [LISTED, OTHER, OTHER_URL, PROVIDER]) delete process.env[name];
});

async function call(tool: RegisteredTool, input: unknown, ctx?: unknown): Promise<string> {
  return String(await tool.execute(input, ctx as never));
}

const chatApi = (tokenEnv: string) => ({
  platform: "slack",
  apiBaseUrl: `${origin}/api`,
  tokenEnv,
  channel: "C1",
});

const email = {
  from: { address: "ci@example.com" },
  to: [{ address: "ops@example.com" }],
  subject: "s",
  text: "t\n",
  date: "2026-09-17T09:30:00Z",
  host: "127.0.0.1",
  requireTls: false,
};

describe("every credential variable a call names must be listed", () => {
  test("each place a call names one refuses an unlisted variable before anything is sent", async () => {
    const attempts: Array<[string, RegisteredTool, Record<string, unknown>]> = [
      [
        "WebhookPost auth.envVar",
        webhookPost,
        {
          url: `${origin}/hook`,
          payload: { e: 1 },
          auth: { type: "header", headerName: "X-Anything", envVar: OTHER },
        },
      ],
      [
        "WebhookPost signing.secretEnv",
        webhookPost,
        { url: `${origin}/hook`, payload: { e: 1 }, signing: { scheme: "body", secretEnv: OTHER } },
      ],
      ["WebhookPost urlEnv", webhookPost, { urlEnv: OTHER_URL, payload: { e: 1 } }],
      ["ChatPost tokenEnv", chatPost, { ...chatApi(OTHER), text: "hi" }],
      [
        "ChatPost webhookUrlEnv",
        chatPost,
        { platform: "slack", webhookUrlEnv: OTHER_URL, text: "hi" },
      ],
      ["ChatUpdate tokenEnv", chatUpdate, { ...chatApi(OTHER), messageId: "1.1", text: "x" }],
      ["ChatDelete tokenEnv", chatDelete, { ...chatApi(OTHER), messageId: "1.1" }],
      ["ChatReact tokenEnv", chatReact, { ...chatApi(OTHER), messageId: "1.1", emoji: "eyes" }],
      [
        "EmailSend usernameEnv",
        emailSend,
        { ...email, port: smtpPort, usernameEnv: OTHER, passwordEnv: LISTED },
      ],
      [
        "EmailSend passwordEnv",
        emailSend,
        { ...email, port: smtpPort, usernameEnv: LISTED, passwordEnv: OTHER },
      ],
      // A provider's own variable is not a name a call may use elsewhere.
      [
        "WebhookPost auth.envVar naming a provider's variable",
        webhookPost,
        { url: `${origin}/hook`, payload: { e: 1 }, auth: { type: "bearer", envVar: PROVIDER } },
      ],
    ];
    for (const [where, tool, input] of attempts) {
      const out = await call(tool, input);
      expect({
        where,
        refused: out.startsWith("nothing was sent:") && out.includes("allowed_secret_envs"),
      }).toEqual({
        where,
        refused: true,
      });
      for (const value of [OTHER_VALUE, PROVIDER_VALUE, `${origin}/hook`])
        expect(out).not.toContain(value);
    }
    expect(attempts.length).toBe(11);
    expect(hits).toEqual([]);
    expect(smtpConnections).toBe(0);
  });

  test("a listed variable is sent where the call points, and scrubbed from the reply", async () => {
    const out = await call(webhookPost, {
      url: `${origin}/hook`,
      payload: { e: 1 },
      auth: { type: "header", headerName: "X-Anything", envVar: LISTED },
    });
    expect(hits).toEqual([{ path: "/hook", authorization: null, anything: LISTED_VALUE }]);
    expect(JSON.parse(out).sent).toBe(true);
    expect(out).not.toContain(LISTED_VALUE);
  });

  test("a provider's own variable works for that provider without being listed", async () => {
    const out = JSON.parse(await call(smsSend, { provider: "gw", to: "+15550001111", body: "x" }));
    expect(out.sent).toBe(true);
    expect(hits).toEqual([
      { path: "/sms", authorization: `Bearer ${PROVIDER_VALUE}`, anything: null },
    ]);
  });

  test("a per-call tool_config block uses its own list, not the boot one", async () => {
    const out = await call(
      webhookPost,
      { url: `${origin}/hook`, payload: { e: 1 }, auth: { type: "bearer", envVar: LISTED } },
      { toolConfig: { allowed_origins: [origin] } },
    );
    expect(out).toContain("allowed_secret_envs lists no variables");
    expect(hits).toEqual([]);
    const listed = await call(
      webhookPost,
      { url: `${origin}/hook`, payload: { e: 1 }, auth: { type: "bearer", envVar: OTHER } },
      { toolConfig: { allowed_origins: [origin], allowed_secret_envs: [OTHER] } },
    );
    expect(JSON.parse(listed).sent).toBe(true);
    expect(hits.map((h) => h.authorization)).toEqual([`Bearer ${OTHER_VALUE}`]);
  });
});

describe("allowed_secret_envs is checked when the harness starts", () => {
  test.each([[["has space"]], [["xoxb-1234-5678-abcdefghijklmnop"]], [[7]], ["SLACK_TOKEN"]])(
    "%p is refused, and the entry is not echoed",
    (entry) => {
      let message = "";
      try {
        buildNotifyConfig({ allowed_secret_envs: entry as never });
      } catch (err) {
        expect(err).toBeInstanceOf(NotifyPermissionError);
        message = (err as Error).message;
      }
      expect(message).toContain("tool_config.notify.allowed_secret_envs");
      for (const part of [entry].flat()) {
        if (typeof part === "string" && part !== "SLACK_TOKEN") expect(message).not.toContain(part);
      }
    },
  );

  test("both spellings are read, camelCase first", () => {
    expect(buildNotifyConfig({ allowedSecretEnvs: ["B", "A"] }).allowedSecretEnvs).toEqual([
      "A",
      "B",
    ]);
    expect(buildNotifyConfig({ allowed_secret_envs: ["C"] }).allowedSecretEnvs).toEqual(["C"]);
  });
});
