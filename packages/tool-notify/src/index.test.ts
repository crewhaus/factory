/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Nothing here is mocked at the transport: the HTTP tools are driven against
 * a real `Bun.serve` and the SMTP tool against a real listener on
 * 127.0.0.1, because a mocked `fetch` proves nothing about whether a
 * deadline fires, a redirect is refused, or an SMTP handshake reaches TLS
 * before the password does. Attachments come from a `mkdtempSync` directory
 * that is removed afterwards, and nothing is ever written into the repo.
 *
 * The refusals are tested as carefully as the successes: an origin outside
 * the allow-list, a recipient outside it, a path escaping the workspace, a
 * server that will not offer STARTTLS, and a deadline that fires.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  NOTIFY_TOOLS,
  __setPrivateHostsAllowedForTest,
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  chatDelete,
  chatPost,
  chatReact,
  chatUpdate,
  deliveryCheck,
  emailCompose,
  emailSend,
  messageTemplate,
  notifyDigest,
  pushNotify,
  quietHours,
  rateLimitGate,
  registerNotifyConfig,
  smsSend,
  webhookPost,
} from "./index";

// ---------------------------------------------------------------------------
// a fake SMTP server, spoken to over a real socket
// ---------------------------------------------------------------------------

type SmtpLog = {
  /** Every command line the server received, with AUTH payloads intact. */
  readonly commands: string[];
  /** The DATA payload of the message that was delivered. */
  messages: string[];
};

type SmtpServerOptions = {
  readonly offerStartTls?: boolean;
  readonly rejectRecipients?: readonly string[];
  readonly greetingDelayMs?: number;
  readonly maxSize?: number;
};

function startSmtpServer(
  options: SmtpServerOptions = {},
): Promise<{ server: Server; port: number; log: SmtpLog }> {
  const log: SmtpLog = { commands: [], messages: [] };
  const server = createServer((socket) => {
    let buffer = "";
    let inData = false;
    let body = "";
    const say = (text: string): void => {
      socket.write(text);
    };
    const greet = (): void => say("220 test.invalid ESMTP ready\r\n");
    if (options.greetingDelayMs !== undefined) setTimeout(greet, options.greetingDelayMs);
    else greet();

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\r\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            log.messages.push(body);
            body = "";
            say("250 2.0.0 Ok: queued as TESTQUEUE1\r\n");
          } else {
            body += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
          }
          continue;
        }

        log.commands.push(line);
        const verb = line.split(" ")[0]?.toUpperCase() ?? "";
        if (verb === "EHLO") {
          const lines = [
            "250-test.invalid",
            `250-SIZE ${options.maxSize ?? 10_485_760}`,
            ...(options.offerStartTls === true ? ["250-STARTTLS"] : []),
            "250-AUTH PLAIN LOGIN",
            "250 HELP",
          ];
          say(`${lines.join("\r\n")}\r\n`);
        } else if (verb === "AUTH") {
          if (line.toUpperCase().startsWith("AUTH LOGIN")) say("334 VXNlcm5hbWU6\r\n");
          else say("235 2.7.0 Authentication successful\r\n");
        } else if (verb === "MAIL") {
          say("250 2.1.0 Ok\r\n");
        } else if (verb === "RCPT") {
          const address = line.slice(line.indexOf("<") + 1, line.lastIndexOf(">"));
          if ((options.rejectRecipients ?? []).includes(address)) {
            say("550 5.1.1 No such user\r\n");
          } else {
            say("250 2.1.5 Ok\r\n");
          }
        } else if (verb === "DATA") {
          inData = true;
          say("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") {
          say("221 2.0.0 Bye\r\n");
          socket.end();
        } else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // A bare base64 line is an AUTH LOGIN continuation.
          say(
            line.length > 12 ? "235 2.7.0 Authentication successful\r\n" : "334 UGFzc3dvcmQ6\r\n",
          );
        } else {
          say("502 5.5.2 Command not implemented\r\n");
        }
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port, log });
    });
  });
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

type HttpLog = Array<{
  method: string;
  pathname: string;
  headers: Record<string, string>;
  body: string;
}>;

const originalCwd = process.cwd();
let tmp: string;
let http: ReturnType<typeof Bun.serve>;
let origin = "";
let requests: HttpLog;
let failuresLeft = 0;

const WEBHOOK_VAR = "CREWHAUS_TEST_SLACK_WEBHOOK";
const TOKEN_VAR = "CREWHAUS_TEST_BOT_TOKEN";
const SECRET_VAR = "CREWHAUS_TEST_SIGNING_SECRET";
const SMTP_USER_VAR = "CREWHAUS_TEST_SMTP_USER";
const SMTP_PASS_VAR = "CREWHAUS_TEST_SMTP_PASS";
const PROVIDER_VAR = "CREWHAUS_TEST_PROVIDER_TOKEN";

/** Parse a tool result that should be JSON; returns the raw string otherwise. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed shape directly.
async function run(tool: (typeof NOTIFY_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-notify-"));
  process.chdir(tmp);
  requests = [];
  failuresLeft = 0;

  http = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = await req.text();
      const headers: Record<string, string> = {};
      for (const [key, value] of req.headers.entries()) headers[key.toLowerCase()] = value;
      requests.push({ method: req.method, pathname: url.pathname, headers, body });

      if (url.pathname === "/slow") {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return new Response("late");
      }
      if (url.pathname === "/flaky") {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return new Response("upstream is unwell", { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/badrequest") {
        return new Response("payload rejected", { status: 400 });
      }
      if (url.pathname === "/hop") {
        return new Response(null, {
          status: 302,
          headers: { location: url.searchParams.get("to") ?? "/" },
        });
      }
      if (url.pathname === "/moved") {
        return new Response(null, { status: 302, headers: { location: `${origin}/hook` } });
      }
      if (url.pathname === "/api/chat.postMessage" || url.pathname === "/api/chat.update") {
        return new Response(JSON.stringify({ ok: true, ts: "1758100000.000100", channel: "C1" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/api/chat.delete" || url.pathname === "/api/reactions.add") {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/api/refuses")) {
        return new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/sms") {
        return new Response(JSON.stringify({ sid: "SM123", status: "queued" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.startsWith("/sms/")) {
        return new Response(JSON.stringify({ sid: "SM123", status: "delivered" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, id: "msg_1" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  origin = `http://127.0.0.1:${http.port}`;

  process.env[WEBHOOK_VAR] = `${origin}/services/T000/B000/xoxbSecretWebhookPath`;
  process.env[TOKEN_VAR] = "xoxb-test-token-value-1234";
  process.env[SECRET_VAR] = "whsec-test-signing-secret";
  process.env[SMTP_USER_VAR] = "mailer@example.com";
  process.env[SMTP_PASS_VAR] = "sup3rs3cretmailpassword";
  process.env[PROVIDER_VAR] = "provider-token-abcdef";

  registerNotifyConfig({
    allowed_origins: [origin],
    allowed_recipients: ["ops@example.com", "*@team.test"],
    allowed_smtp_hosts: ["127.0.0.1"],
    providers: {
      gateway: {
        endpoint: `${origin}/sms`,
        auth: { type: "bearer", envVar: PROVIDER_VAR },
        fields: { to: "To", body: "Body", from: "From", title: "Title", data: "Data" },
        staticFields: { AccountSid: "AC-test" },
        idPath: "sid",
        statusPath: "status",
        statusEndpoint: `${origin}/sms/{id}`,
        idempotencyHeader: "I-Key",
      },
      formGateway: {
        endpoint: `${origin}/sms`,
        encoding: "form",
        fields: { to: "To", body: "Body" },
      },
      noStatus: { endpoint: `${origin}/sms`, fields: { to: "To", body: "Body" } },
    },
  });
  __setPrivateHostsAllowedForTest(true);
});

afterEach(() => {
  process.chdir(originalCwd);
  http.stop(true);
  rmSync(tmp, { recursive: true, force: true });
  _resetNotifyConfig();
  _resetIdempotencyLedger();
  __setPrivateHostsAllowedForTest(false);
  for (const name of [
    WEBHOOK_VAR,
    TOKEN_VAR,
    SECRET_VAR,
    SMTP_USER_VAR,
    SMTP_PASS_VAR,
    PROVIDER_VAR,
  ]) {
    delete process.env[name];
  }
});

// ---------------------------------------------------------------------------
// package-wide contract
// ---------------------------------------------------------------------------

const SENDING_TOOLS = new Set([
  "ChatPost",
  "ChatUpdate",
  "ChatDelete",
  "ChatReact",
  "EmailSend",
  "WebhookPost",
  "SmsSend",
  "PushNotify",
]);
const PURE_TOOLS = new Set([
  "EmailCompose",
  "MessageTemplate",
  "NotifyDigest",
  "QuietHours",
  "RateLimitGate",
]);

describe("package-wide contract", () => {
  test("NOTIFY_TOOLS holds every tool, and is frozen", () => {
    expect(NOTIFY_TOOLS.length).toBe(14);
    expect(Object.isFrozen(NOTIFY_TOOLS)).toBe(true);
  });

  test("names are unique and PascalCase", () => {
    const names = NOTIFY_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("no tool reuses SendMessage, which belongs to tool-message-channel", () => {
    expect(NOTIFY_TOOLS.some((t) => t.name === "SendMessage")).toBe(false);
  });

  test("every description says what the tool is for", () => {
    for (const tool of NOTIFY_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(120);
      expect(tool.description).toContain("Use ");
    }
  });

  test("EVERY sending tool is destructive and requires a justification", () => {
    for (const tool of NOTIFY_TOOLS) {
      if (!SENDING_TOOLS.has(tool.name)) continue;
      expect({
        name: tool.name,
        destructive: tool.destructive,
        justified: tool.requireJustification,
        scope: tool.scope,
        io: tool.ioCapability,
      }).toEqual({
        name: tool.name,
        destructive: true,
        justified: true,
        scope: "external",
        io: "network",
      });
    }
  });

  test("DeliveryCheck is the one outbound tool that only reads", () => {
    expect({
      readOnly: deliveryCheck.readOnly,
      destructive: deliveryCheck.destructive,
      scope: deliveryCheck.scope,
      io: deliveryCheck.ioCapability,
    }).toEqual({ readOnly: true, destructive: false, scope: "external", io: "network" });
  });

  test("the pure tools are read-only, internal and declare no io capability", () => {
    for (const tool of NOTIFY_TOOLS) {
      if (!PURE_TOOLS.has(tool.name)) continue;
      expect({
        name: tool.name,
        readOnly: tool.readOnly,
        destructive: tool.destructive,
        scope: tool.scope,
        io: tool.ioCapability,
        safe: tool.concurrencySafe,
      }).toEqual({
        name: tool.name,
        readOnly: true,
        destructive: false,
        scope: "internal",
        io: undefined,
        safe: true,
      });
    }
  });

  test("every tool accounted for: each is either a send, a pure tool, or DeliveryCheck", () => {
    for (const tool of NOTIFY_TOOLS) {
      expect({
        name: tool.name,
        known:
          SENDING_TOOLS.has(tool.name) ||
          PURE_TOOLS.has(tool.name) ||
          tool.name === "DeliveryCheck",
      }).toEqual({ name: tool.name, known: true });
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const tool of NOTIFY_TOOLS) {
      expect({ name: tool.name, ok: tool.inputSchema.safeParse(42).success }).toEqual({
        name: tool.name,
        ok: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// ChatPost
// ---------------------------------------------------------------------------

describe("ChatPost", () => {
  test("posts to a Slack incoming webhook whose URL came from the environment", async () => {
    const result = await run(chatPost, {
      platform: "slack",
      webhookUrlEnv: WEBHOOK_VAR,
      text: "nightly run finished",
    });
    expect(result.sent).toBe(true);
    expect(result.mode).toBe("webhook");
    const sent = requests[0];
    expect(sent?.pathname).toBe("/services/T000/B000/xoxbSecretWebhookPath");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({
      text: "nightly run finished",
      link_names: false,
    });
  });

  test("blocks render into the message body", async () => {
    await run(chatPost, {
      platform: "slack",
      webhookUrlEnv: WEBHOOK_VAR,
      blocks: [
        { kind: "heading", text: "Deploy" },
        { kind: "fields", fields: [{ name: "env", value: "prod" }] },
      ],
    });
    expect(JSON.parse(requests[0]?.body ?? "{}").text).toBe("*Deploy*\n\n*env:* prod");
  });

  test("INJECTION: a channel-wide mention in the text arrives as inert characters", async () => {
    await run(chatPost, {
      platform: "slack",
      webhookUrlEnv: WEBHOOK_VAR,
      text: "<!channel> everything is fine",
    });
    const body = JSON.parse(requests[0]?.body ?? "{}");
    expect(body.text).toBe("&lt;!channel&gt; everything is fine");
    expect(body.text.includes("<!channel>")).toBe(false);
  });

  test("Discord is told to parse no mentions, so @everyone in a value pages nobody", async () => {
    process.env[WEBHOOK_VAR] = `${origin}/api/webhooks/1/2`;
    await run(chatPost, { platform: "discord", webhookUrlEnv: WEBHOOK_VAR, text: "@everyone" });
    expect(JSON.parse(requests[0]?.body ?? "{}").allowed_mentions).toEqual({ parse: [] });
  });

  test("API mode carries a bot token and returns the posted message id", async () => {
    const result = await run(chatPost, {
      platform: "slack",
      apiBaseUrl: `${origin}/api`,
      tokenEnv: TOKEN_VAR,
      channel: "C1",
      text: "hello",
    });
    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("1758100000.000100");
    expect(requests[0]?.headers["authorization"]).toBe("Bearer xoxb-test-token-value-1234");
  });

  test("Slack answering 200 with ok:false is a failure, not a send", async () => {
    const result = await run(chatPost, {
      platform: "slack",
      apiBaseUrl: `${origin}/api`,
      tokenEnv: TOKEN_VAR,
      channel: "C1",
      text: "hi",
    });
    expect(result.sent).toBe(true);
    const refused = await chatPost.execute({
      platform: "slack",
      apiBaseUrl: `${origin}/api/refuses`,
      tokenEnv: TOKEN_VAR,
      channel: "C1",
      text: "hi",
    });
    expect(String(refused)).toContain("channel_not_found");
    expect(String(refused)).toContain("nothing was sent");
  });

  test("REFUSAL: an origin outside the allow-list is not reached", async () => {
    process.env[WEBHOOK_VAR] = "https://hooks.elsewhere.test/services/x";
    const result = await chatPost.execute({
      platform: "slack",
      webhookUrlEnv: WEBHOOK_VAR,
      text: "hi",
    });
    expect(String(result)).toContain("not in allowed_origins");
    expect(requests.length).toBe(0);
  });

  test("REFUSAL: an empty allow-list denies everything", async () => {
    _resetNotifyConfig();
    const result = await chatPost.execute({
      platform: "slack",
      webhookUrlEnv: WEBHOOK_VAR,
      text: "hi",
    });
    expect(String(result)).toContain("empty allow-list = deny all");
    expect(requests.length).toBe(0);
  });

  test("REFUSAL: an unset environment variable names itself but leaks nothing", async () => {
    const result = String(
      await chatPost.execute({ platform: "slack", webhookUrlEnv: "NOT_SET_ANYWHERE", text: "x" }),
    );
    expect(result).toContain("NOT_SET_ANYWHERE");
    expect(result).toContain("unset or empty");
  });

  test("REFUSAL: a pasted secret in place of a variable name is not echoed back", async () => {
    const result = String(
      await chatPost.execute({
        platform: "slack",
        webhookUrlEnv: "xoxb-1234-actual-secret",
        text: "x",
      }),
    );
    expect(result).not.toContain("xoxb-1234-actual-secret");
    expect(result).toContain("NAME of an environment variable");
  });

  test("REFUSAL: a webhook path never appears in a failure message", async () => {
    process.env[WEBHOOK_VAR] = "not-a-url-at-all";
    const result = String(
      await chatPost.execute({ platform: "slack", webhookUrlEnv: WEBHOOK_VAR, text: "x" }),
    );
    expect(result).not.toContain("not-a-url-at-all");
  });

  test("REFUSAL: both credential styles at once is a mistake, not a preference", async () => {
    const result = String(
      await chatPost.execute({
        platform: "slack",
        webhookUrlEnv: WEBHOOK_VAR,
        apiBaseUrl: `${origin}/api`,
        tokenEnv: TOKEN_VAR,
        text: "x",
      }),
    );
    expect(result).toContain("not both");
  });

  test("REFUSAL: a send never follows a redirect", async () => {
    process.env[WEBHOOK_VAR] = `${origin}/moved`;
    const result = String(
      await chatPost.execute({ platform: "slack", webhookUrlEnv: WEBHOOK_VAR, text: "x" }),
    );
    expect(result).toContain("redirect");
    expect(requests.map((r) => r.pathname)).toEqual(["/moved"]);
  });

  test("REFUSAL: an empty message is refused before anything is sent", async () => {
    const result = String(
      await chatPost.execute({ platform: "slack", webhookUrlEnv: WEBHOOK_VAR, blocks: [] }),
    );
    expect(result).toContain("the message is empty");
    expect(requests.length).toBe(0);
  });

  test("a deadline fires rather than hanging", async () => {
    process.env[WEBHOOK_VAR] = `${origin}/slow`;
    const started = Date.now();
    const result = String(
      await chatPost.execute({
        platform: "slack",
        webhookUrlEnv: WEBHOOK_VAR,
        text: "x",
        timeoutMs: 150,
      }),
    );
    expect(result).toContain("deadline");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("an idempotency key makes a retry return the first result without posting again", async () => {
    const first = await run(chatPost, {
      platform: "slack",
      webhookUrlEnv: WEBHOOK_VAR,
      text: "once",
      idempotencyKey: "nightly-2026-09-17",
    });
    const second = await run(chatPost, {
      platform: "slack",
      webhookUrlEnv: WEBHOOK_VAR,
      text: "once",
      idempotencyKey: "nightly-2026-09-17",
    });
    expect(first).toEqual(second);
    expect(requests.length).toBe(1);
    expect(requests[0]?.headers["idempotency-key"]).toBe("nightly-2026-09-17");
  });

  test("a thread id on a platform without threads is reported, not silently dropped", async () => {
    const result = await run(chatPost, {
      platform: "teams",
      webhookUrlEnv: WEBHOOK_VAR,
      text: "x",
      threadId: "123",
    });
    expect(result.warnings).toContain("teams has no threads; threadId was ignored");
    expect(JSON.parse(requests[0]?.body ?? "{}")["@type"]).toBe("MessageCard");
  });
});

// ---------------------------------------------------------------------------
// ChatUpdate / ChatDelete / ChatReact
// ---------------------------------------------------------------------------

describe("ChatUpdate, ChatDelete and ChatReact", () => {
  const api = () => ({ apiBaseUrl: `${origin}/api`, tokenEnv: TOKEN_VAR, channel: "C1" });

  test("an edit reaches chat.update with the message id", async () => {
    const result = await run(chatUpdate, {
      platform: "slack",
      ...api(),
      messageId: "1758100000.000100",
      text: "done",
    });
    expect(result.updated).toBe(true);
    expect(requests[0]?.pathname).toBe("/api/chat.update");
    expect(JSON.parse(requests[0]?.body ?? "{}").ts).toBe("1758100000.000100");
  });

  test("a delete reaches chat.delete", async () => {
    const result = await run(chatDelete, {
      platform: "slack",
      ...api(),
      messageId: "1758100000.000100",
    });
    expect(result.deleted).toBe(true);
    expect(requests[0]?.pathname).toBe("/api/chat.delete");
  });

  test("a reaction strips the colons Slack does not want", async () => {
    const result = await run(chatReact, {
      platform: "slack",
      ...api(),
      messageId: "1758100000.000100",
      emoji: ":white_check_mark:",
    });
    expect(result.reacted).toBe(true);
    expect(JSON.parse(requests[0]?.body ?? "{}").name).toBe("white_check_mark");
  });

  test("Discord addresses a message by path rather than by body", async () => {
    await run(chatUpdate, {
      platform: "discord",
      apiBaseUrl: `${origin}/api`,
      tokenEnv: TOKEN_VAR,
      channel: "555",
      messageId: "999",
      text: "edited",
    });
    expect(requests[0]?.method).toBe("PATCH");
    expect(requests[0]?.pathname).toBe("/api/channels/555/messages/999");
  });

  test("REFUSAL: Teams cannot be edited, and says so instead of reposting", async () => {
    const result = String(
      await chatUpdate.execute({
        platform: "teams",
        apiBaseUrl: `${origin}/api`,
        tokenEnv: TOKEN_VAR,
        messageId: "1",
        text: "x",
      }),
    );
    expect(result).toContain("does not let a posted message be edited");
    expect(requests.length).toBe(0);
  });

  test("REFUSAL: an incoming webhook cannot edit, which is a credential problem not a retry", async () => {
    const result = String(
      await chatUpdate.execute({
        platform: "slack",
        webhookUrlEnv: WEBHOOK_VAR,
        messageId: "1",
        text: "x",
      }),
    );
    expect(result).toContain("apiBaseUrl and tokenEnv");
    expect(requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EmailCompose
// ---------------------------------------------------------------------------

describe("EmailCompose", () => {
  const base = {
    from: { address: "ci@example.com", name: "CI" },
    to: [{ address: "ops@example.com" }],
    subject: "Nightly",
    text: "green\n",
    date: "2026-09-17T09:30:00Z",
  };

  test("returns a complete message and never touches the network", async () => {
    const result = await run(emailCompose, base);
    expect(result.message).toContain("Subject: Nightly\r\n");
    expect(result.envelopeTo).toEqual(["ops@example.com"]);
    expect(requests.length).toBe(0);
  });

  test("composing the same message twice gives byte-identical output", async () => {
    const a = await run(emailCompose, base);
    const b = await run(emailCompose, base);
    expect(a.message).toBe(b.message);
    expect(a.messageId).toBe(b.messageId);
  });

  test("an attachment is read from the workspace and base64-encoded", async () => {
    writeFileSync(path.join(tmp, "report.txt"), "the report");
    const result = await run(emailCompose, {
      ...base,
      attachments: [{ path: "report.txt", contentType: "text/plain" }],
    });
    expect(result.message).toContain("multipart/mixed");
    expect(result.message).toContain(Buffer.from("the report").toString("base64"));
    expect(result.message).toContain('filename="report.txt"');
  });

  test("REFUSAL: a path escaping the workspace is refused before any read", async () => {
    const result = String(
      await emailCompose.execute({
        ...base,
        attachments: [{ path: "../../../etc/passwd" }],
      }),
    );
    expect(result).toContain("escapes the workspace root");
  });

  test("REFUSAL: an absolute path outside the workspace is refused", async () => {
    const result = String(
      await emailCompose.execute({ ...base, attachments: [{ path: "/etc/hosts" }] }),
    );
    expect(result).toContain("escapes the workspace root");
  });

  test("REFUSAL: a date that is not an instant is refused rather than guessed", async () => {
    const result = String(await emailCompose.execute({ ...base, date: "next tuesday" }));
    expect(result).toContain("not an instant");
  });

  test("attachments are capped by what they ENCODE to, before either is read", async () => {
    // Two files under the 10 MB per-attachment cap whose raw total is under
    // the 25 MB message cap, but whose base64 is not: counting raw bytes
    // would have let a ~26 MB string be assembled and only then refused.
    writeFileSync(path.join(tmp, "a.bin"), Buffer.alloc(10 * 1024 * 1024 - 1024, 7));
    writeFileSync(path.join(tmp, "b.bin"), Buffer.alloc(10 * 1024 * 1024 - 1024, 9));
    const result = String(
      await emailCompose.execute({
        ...base,
        attachments: [{ path: "a.bin" }, { path: "b.bin" }],
      }),
    );
    expect(result).toContain("encode to more than");
    expect(result).not.toContain("messageId");
  });

  test("a symlink pointing out of the workspace does not smuggle a file in", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "crewhaus-outside-"));
    try {
      writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
      Bun.spawnSync(["ln", "-s", path.join(outside, "secret.txt"), path.join(tmp, "link.txt")]);
      const result = String(
        await emailCompose.execute({ ...base, attachments: [{ path: "link.txt" }] }),
      );
      expect(result).toContain("escapes the workspace root");
      expect(result).not.toContain("TOP SECRET");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// EmailSend
// ---------------------------------------------------------------------------

describe("EmailSend", () => {
  const base = {
    from: { address: "ci@example.com", name: "CI" },
    to: [{ address: "ops@example.com" }],
    subject: "Nightly",
    text: "green\n",
    date: "2026-09-17T09:30:00Z",
    host: "127.0.0.1",
    requireTls: false,
  };

  test("delivers a message over a real SMTP conversation", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      const result = await run(emailSend, { ...base, port });
      expect(result.sent).toBe(true);
      expect(result.accepted).toEqual(["ops@example.com"]);
      expect(result.queued).toContain("TESTQUEUE1");
      expect(result.secured).toBe(false);
      expect(log.commands[0]).toContain("EHLO");
      expect(log.commands).toContain("MAIL FROM:<ci@example.com>");
      expect(log.commands).toContain("RCPT TO:<ops@example.com>");
      expect(log.messages[0]).toContain("Subject: Nightly");
      expect(log.messages[0]).toContain("green");
    } finally {
      server.close();
    }
  });

  test("authenticates with AUTH PLAIN and never returns the password", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      const raw = await emailSend.execute({
        ...base,
        port,
        usernameEnv: SMTP_USER_VAR,
        passwordEnv: SMTP_PASS_VAR,
      });
      const text = String(raw);
      expect(JSON.parse(text).authenticated).toBe(true);
      // The server really did receive the credential...
      expect(log.commands.some((c) => c.startsWith("AUTH PLAIN "))).toBe(true);
      // ...and the tool result does not contain it in any form.
      expect(text).not.toContain("sup3rs3cretmailpassword");
      expect(text).not.toContain(
        Buffer.from(" mailer@example.com sup3rs3cretmailpassword").toString("base64"),
      );
    } finally {
      server.close();
    }
  });

  test("a refused recipient is named, and the transcript comes back", async () => {
    const { server, port } = await startSmtpServer({ rejectRecipients: ["ops@example.com"] });
    try {
      const result = String(await emailSend.execute({ ...base, port }));
      expect(result).toContain("every recipient was refused");
      expect(result).toContain("ops@example.com");
      expect(result).toContain("550");
    } finally {
      server.close();
    }
  });

  test("some accepted and some refused reports both", async () => {
    const { server, port } = await startSmtpServer({ rejectRecipients: ["gone@team.test"] });
    try {
      const result = await run(emailSend, {
        ...base,
        port,
        to: [{ address: "ops@example.com" }, { address: "gone@team.test" }],
      });
      expect(result.sent).toBe(true);
      expect(result.accepted).toEqual(["ops@example.com"]);
      expect(result.rejected[0].address).toBe("gone@team.test");
    } finally {
      server.close();
    }
  });

  test("REFUSAL: TLS is required by default, and the session ends before anything is sent", async () => {
    const { server, port, log } = await startSmtpServer({ offerStartTls: false });
    try {
      const result = String(
        await emailSend.execute({
          ...base,
          port,
          requireTls: undefined,
          usernameEnv: SMTP_USER_VAR,
          passwordEnv: SMTP_PASS_VAR,
        }),
      );
      expect(result).toContain("did not offer STARTTLS");
      // Nothing after EHLO: no AUTH, no MAIL FROM, no body.
      expect(log.commands).toEqual(["EHLO crewhaus.invalid"]);
      expect(log.messages.length).toBe(0);
    } finally {
      server.close();
    }
  });

  test("REFUSAL: a recipient outside the allow-list stops the send before a socket opens", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      const result = String(
        await emailSend.execute({ ...base, port, to: [{ address: "stranger@elsewhere.test" }] }),
      );
      expect(result).toContain("not in allowed_recipients");
      expect(log.commands.length).toBe(0);
    } finally {
      server.close();
    }
  });

  test("REFUSAL: a BCC recipient is allow-listed too — blind is not exempt", async () => {
    const { server, port } = await startSmtpServer();
    try {
      const result = String(
        await emailSend.execute({ ...base, port, bcc: [{ address: "stranger@elsewhere.test" }] }),
      );
      expect(result).toContain("not in allowed_recipients");
    } finally {
      server.close();
    }
  });

  test("a BCC recipient reaches RCPT TO but never a header", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      await run(emailSend, { ...base, port, bcc: [{ address: "audit@team.test" }] });
      expect(log.commands).toContain("RCPT TO:<audit@team.test>");
      expect(log.messages[0]?.toLowerCase()).not.toContain("bcc:");
      expect(log.messages[0]).not.toContain("audit@team.test");
    } finally {
      server.close();
    }
  });

  test("REFUSAL: an SMTP host no operator named is refused", async () => {
    const { server, port } = await startSmtpServer();
    try {
      const result = String(
        await emailSend.execute({ ...base, host: "smtp.elsewhere.test", port }),
      );
      expect(result).toContain("not in allowed_smtp_hosts");
    } finally {
      server.close();
    }
  });

  test("a deadline fires when the server never greets", async () => {
    const { server, port } = await startSmtpServer({ greetingDelayMs: 5000 });
    try {
      const started = Date.now();
      const result = String(await emailSend.execute({ ...base, port, timeoutMs: 200 }));
      expect(result).toContain("deadline");
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      server.close();
    }
  });

  test("a message larger than the server's advertised SIZE is refused before the body is uploaded", async () => {
    const { server, port, log } = await startSmtpServer({ maxSize: 500 });
    try {
      const result = String(await emailSend.execute({ ...base, port, text: "x".repeat(5000) }));
      expect(result).toContain("accepts at most 500");
      expect(log.messages.length).toBe(0);
    } finally {
      server.close();
    }
  });

  test("an idempotency key stops a retry from sending a second copy", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      const args = { ...base, port, idempotencyKey: "nightly-mail" };
      const first = await run(emailSend, args);
      const second = await run(emailSend, args);
      expect(first).toEqual(second);
      expect(log.messages.length).toBe(1);
    } finally {
      server.close();
    }
  });

  test("INJECTION: an EHLO name carrying CRLF cannot smuggle a second command", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      const result = String(
        await emailSend.execute({
          ...base,
          port,
          ehloName: "crewhaus.invalid\r\nRCPT TO:<stranger@evil.test>",
        }),
      );
      expect(result).toContain("EHLO name");
      // SMTP is a line protocol: a CRLF in an argument is a second command,
      // and one that adds a recipient the allow-list never saw. Nothing at
      // all may reach the socket.
      expect(log.commands).toEqual([]);
      expect(log.messages.length).toBe(0);
    } finally {
      server.close();
    }
  });

  test("the AUTH PLAIN blob is the RFC 4616 message: NUL authcid NUL passwd", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      await run(emailSend, {
        ...base,
        port,
        usernameEnv: SMTP_USER_VAR,
        passwordEnv: SMTP_PASS_VAR,
      });
      const line = log.commands.find((c) => c.startsWith("AUTH PLAIN ")) as string;
      expect(line).toBeDefined();
      // Decoded here rather than compared against what the client built, so a
      // wrong separator (a space is the classic one) fails this test instead
      // of travelling through it.
      const decoded = Buffer.from(line.slice("AUTH PLAIN ".length), "base64").toString("utf8");
      const fields = decoded.split("\u0000");
      expect(fields.length).toBe(3);
      expect(fields[0]).toBe("");
      expect(fields[1]).toBe(process.env[SMTP_USER_VAR]);
      expect(fields[2]).toBe(process.env[SMTP_PASS_VAR]);
    } finally {
      server.close();
    }
  });

  test('a body line of "." reaches the server whole, and the message is not truncated', async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      await run(emailSend, { ...base, port, text: "before\n.\nafter\n" });
      const delivered = log.messages[0] as string;
      // The dot line survives DATA — either quoted-printable encoded it or
      // dot-stuffing doubled it — and everything after it arrived, which is
      // what a truncated message would have lost.
      expect(delivered).toContain("after");
      expect(delivered.split("\r\n").some((l) => l === ".")).toBe(false);
    } finally {
      server.close();
    }
  });

  test("INJECTION: an In-Reply-To carrying CRLF is refused before a socket opens", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      const result = String(
        await emailSend.execute({
          ...base,
          port,
          inReplyTo: "<real@example.com>\r\nBcc: attacker@evil.test",
        }),
      );
      expect(result).toContain("inReplyTo");
      expect(log.commands).toEqual([]);
    } finally {
      server.close();
    }
  });

  test("INJECTION: a subject with CRLF cannot add an envelope recipient", async () => {
    const { server, port, log } = await startSmtpServer();
    try {
      await run(emailSend, {
        ...base,
        port,
        subject: "hi\r\nBcc: attacker@evil.test",
      });
      expect(log.commands.filter((c) => c.startsWith("RCPT TO:"))).toEqual([
        "RCPT TO:<ops@example.com>",
      ]);
      expect(log.messages[0]?.toLowerCase()).not.toContain("bcc: attacker");
    } finally {
      server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// WebhookPost
// ---------------------------------------------------------------------------

describe("WebhookPost", () => {
  test("posts a JSON payload and reports the status", async () => {
    const result = await run(webhookPost, {
      url: `${origin}/hook`,
      payload: { event: "deploy", ok: true },
    });
    expect(result.sent).toBe(true);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ event: "deploy", ok: true });
  });

  test("signs the exact bytes it transmits, in the body scheme", async () => {
    const { createHmac } = await import("node:crypto");
    await run(webhookPost, {
      url: `${origin}/hook`,
      payload: { a: 1 },
      signing: { secretEnv: SECRET_VAR, scheme: "body", header: "X-Hub-Signature-256" },
    });
    const sent = requests[0];
    const expected = createHmac("sha256", "whsec-test-signing-secret")
      .update(sent?.body ?? "", "utf8")
      .digest("hex");
    expect(sent?.headers["x-hub-signature-256"]).toBe(`sha256=${expected}`);
  });

  test("the timestamped scheme signs <seconds>.<body>", async () => {
    const { createHmac } = await import("node:crypto");
    await run(webhookPost, {
      url: `${origin}/hook`,
      payload: { a: 1 },
      signing: { secretEnv: SECRET_VAR, scheme: "timestamped", timestampSeconds: 1758100000 },
    });
    const sent = requests[0];
    const expected = createHmac("sha256", "whsec-test-signing-secret")
      .update(`1758100000.${sent?.body}`, "utf8")
      .digest("hex");
    expect(sent?.headers["x-signature"]).toBe(`t=1758100000,v1=${expected}`);
  });

  test("REFUSAL: the timestamped scheme will not read the clock for you", async () => {
    const result = String(
      await webhookPost.execute({
        url: `${origin}/hook`,
        payload: {},
        signing: { secretEnv: SECRET_VAR, scheme: "timestamped" },
      }),
    );
    expect(result).toContain("timestampSeconds");
    expect(requests.length).toBe(0);
  });

  test("retries a 5xx on the declared backoff and succeeds", async () => {
    failuresLeft = 2;
    const result = await run(webhookPost, {
      url: `${origin}/flaky`,
      payload: { a: 1 },
      retries: 3,
      backoffMs: 5,
    });
    expect(result.sent).toBe(true);
    expect(result.attempts).toBe(3);
    expect(requests.length).toBe(3);
  });

  test("a 4xx is not retried, because a bad request does not get better", async () => {
    const result = String(
      await webhookPost.execute({
        url: `${origin}/badrequest`,
        payload: { a: 1 },
        retries: 3,
        backoffMs: 1,
      }),
    );
    expect(result).toContain("not a retryable status");
    expect(result).toContain("payload rejected");
    expect(requests.length).toBe(1);
  });

  test("exhausting the retries reports every attempt rather than just the last", async () => {
    failuresLeft = 99;
    const result = String(
      await webhookPost.execute({
        url: `${origin}/flaky`,
        payload: { a: 1 },
        retries: 2,
        backoffMs: 5,
      }),
    );
    expect(result).toContain("all 3 attempt(s) failed");
    expect(result).toContain('"status":503');
  });

  test("a backoff that would outlast the deadline stops instead of sleeping past it", async () => {
    failuresLeft = 99;
    const result = String(
      await webhookPost.execute({
        url: `${origin}/flaky`,
        payload: { a: 1 },
        retries: 5,
        backoffMs: 10_000,
        timeoutMs: 2000,
      }),
    );
    expect(result).toContain("would outlast the deadline");
  });

  test("REFUSAL: an inline Authorization header is refused in favour of the auth profile", async () => {
    const result = String(
      await webhookPost.execute({
        url: `${origin}/hook`,
        payload: {},
        headers: { Authorization: "Bearer hunter2" },
      }),
    );
    expect(result).toContain("cannot be set inline");
    expect(result).not.toContain("hunter2");
    expect(requests.length).toBe(0);
  });

  test("an auth profile's secret is attached to the request and redacted from the result", async () => {
    const result = String(
      await webhookPost.execute({
        url: `${origin}/hook`,
        payload: {},
        auth: { type: "header", headerName: "X-Api-Key", envVar: SECRET_VAR },
      }),
    );
    expect(requests[0]?.headers["x-api-key"]).toBe("whsec-test-signing-secret");
    expect(result).not.toContain("whsec-test-signing-secret");
  });

  test("REFUSAL: exactly one of url and urlEnv", async () => {
    expect(String(await webhookPost.execute({ payload: {} }))).toContain("exactly one");
    expect(
      String(await webhookPost.execute({ payload: {}, url: `${origin}/a`, urlEnv: WEBHOOK_VAR })),
    ).toContain("exactly one");
  });

  test("REFUSAL: a webhook URL whose path IS the credential may not be passed inline", async () => {
    for (const path of [
      "/services/T01ABCDEF/B02ABCDEF/xAbCdEfGhIjKlMnOpQrStUv",
      "/api/webhooks/123456789012345678/xAbCdEfGhIjKlMnOpQrStUv",
    ]) {
      const result = String(
        await webhookPost.execute({ url: `${origin}${path}`, payload: { a: 1 } }),
      );
      expect(result).toContain("urlEnv");
      // Neither sent, nor echoed: the path is the secret.
      expect(requests.length).toBe(0);
      expect(result).not.toContain("xAbCdEfGhIjKlMnOpQrStUv");
    }
  });

  test("a string payload is transmitted verbatim, so a pre-signed body survives", async () => {
    await run(webhookPost, { url: `${origin}/hook`, payload: '{"a":  1}' });
    expect(requests[0]?.body).toBe('{"a":  1}');
  });
});

// ---------------------------------------------------------------------------
// SmsSend, PushNotify, DeliveryCheck
// ---------------------------------------------------------------------------

describe("provider-shaped tools", () => {
  test("SmsSend maps canonical fields onto the provider's own names", async () => {
    const result = await run(smsSend, {
      provider: "gateway",
      to: "+15550100",
      body: "disk full",
      from: "+15550199",
    });
    expect(result.sent).toBe(true);
    expect(result.messageId).toBe("SM123");
    expect(result.deliveryStatus).toBe("queued");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      AccountSid: "AC-test",
      Body: "disk full",
      From: "+15550199",
      To: "+15550100",
    });
    expect(requests[0]?.headers["authorization"]).toBe("Bearer provider-token-abcdef");
  });

  test("a provider with no mapping for a field simply never receives it", async () => {
    await run(smsSend, { provider: "formGateway", to: "+1", body: "x", from: "+2" });
    expect(requests[0]?.body).toBe("Body=x&To=%2B1");
    expect(requests[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  test("PushNotify speaks the same provider shape", async () => {
    const result = await run(pushNotify, {
      provider: "gateway",
      to: "device-token",
      title: "Deploy",
      body: "finished",
      data: { runId: "42" },
    });
    expect(result.sent).toBe(true);
    expect(JSON.parse(requests[0]?.body ?? "{}").Data).toBe('{"runId":"42"}');
  });

  test("REFUSAL: an unconfigured provider is named, with what is configured", async () => {
    const result = String(await smsSend.execute({ provider: "nope", to: "+1", body: "x" }));
    expect(result).toContain('no provider "nope"');
    expect(result).toContain("formGateway, gateway, noStatus");
    expect(requests.length).toBe(0);
  });

  test("REFUSAL: with no providers configured at all, the message says so", async () => {
    _resetNotifyConfig();
    const result = String(await smsSend.execute({ provider: "gateway", to: "+1", body: "x" }));
    expect(result).toContain("providers is empty");
  });

  test("an idempotency key reaches the provider's own header", async () => {
    await run(smsSend, { provider: "gateway", to: "+1", body: "x", idempotencyKey: "alert-7" });
    expect(requests[0]?.headers["i-key"]).toBe("alert-7");
  });

  test("DeliveryCheck reads the provider's status endpoint", async () => {
    const result = await run(deliveryCheck, { provider: "gateway", messageId: "SM123" });
    expect(result.deliveryStatus).toBe("delivered");
    expect(requests[0]?.pathname).toBe("/sms/SM123");
    expect(requests[0]?.method).toBe("GET");
  });

  test("REFUSAL: a provider with no status endpoint is reported, not guessed at", async () => {
    const result = String(await deliveryCheck.execute({ provider: "noStatus", messageId: "X" }));
    expect(result).toContain("no statusEndpoint configured");
    expect(requests.length).toBe(0);
  });

  test("REFUSAL: DeliveryCheck re-runs the allow-list on the hop it is redirected to", async () => {
    // DeliveryCheck is the one call here that follows a redirect at all. The
    // first hop is allow-listed; the second is where the far end gets to
    // choose, which is exactly why the gate runs again.
    const result = String(
      await deliveryCheck.execute(
        { provider: "redirector", messageId: "m1" },
        {
          toolConfig: {
            allowed_origins: [origin],
            providers: {
              redirector: {
                endpoint: `${origin}/sms`,
                statusEndpoint: `${origin}/hop?to=https%3A%2F%2Felsewhere.invalid%2Fstatus&id={id}`,
              },
            },
          },
        },
      ),
    );
    expect(result).toContain("not in allowed_origins");
    // The first hop really happened — the refusal is the SECOND one.
    expect(requests.map((r) => r.pathname)).toContain("/hop");
  });

  test("a cross-origin redirect drops the credential before the next hop opens", async () => {
    let sawAuthorization: string | null = "not called";
    const second = Bun.serve({
      port: 0,
      fetch: (req) => {
        sawAuthorization = req.headers.get("authorization");
        return new Response(JSON.stringify({ status: "delivered" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const secondOrigin = `http://127.0.0.1:${second.port}`;
    try {
      const raw = String(
        await deliveryCheck.execute(
          { provider: "redirector", messageId: "m1" },
          {
            toolConfig: {
              allowed_origins: [origin, secondOrigin],
              providers: {
                redirector: {
                  endpoint: `${origin}/sms`,
                  auth: { type: "bearer", envVar: PROVIDER_VAR },
                  statusPath: "status",
                  statusEndpoint: `${origin}/hop?to=${encodeURIComponent(`${secondOrigin}/status`)}&id={id}`,
                },
              },
            },
          },
        ),
      );
      const result = JSON.parse(raw);
      // The token was minted for the origin we asked, not for wherever that
      // origin points us next.
      expect(sawAuthorization).toBe(null);
      expect(result.credentialsDroppedAtRedirect).toBe(true);
      expect(result.deliveryStatus).toBe("delivered");
      expect(raw).not.toContain("provider-token-abcdef");
    } finally {
      second.stop(true);
    }
  });

  test("REFUSAL: a message id that could rewrite the URL is refused", async () => {
    const result = String(
      await deliveryCheck.execute({ provider: "gateway", messageId: "../../admin" }),
    );
    expect(result).toContain("plain identifier");
    expect(requests.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the pure tools
// ---------------------------------------------------------------------------

describe("NotifyDigest, QuietHours, RateLimitGate and MessageTemplate", () => {
  test("NotifyDigest folds forty events into one line", async () => {
    const events = Array.from({ length: 40 }, (_, i) => ({
      key: i < 38 ? "conn-refused" : "timeout",
      summary: i < 38 ? "connection refused" : "timed out",
    }));
    const result = await run(notifyDigest, { events, title: "Overnight" });
    expect(result.total).toBe(40);
    expect(result.distinct).toBe(2);
    expect(result.text).toContain("38× connection refused");
  });

  test("NotifyDigest can emit blocks that ChatPost takes directly", async () => {
    const digest = await run(notifyDigest, {
      events: [{ key: "a", summary: "alpha" }],
      format: "blocks",
      title: "T",
    });
    const posted = await run(chatPost, {
      platform: "slack",
      webhookUrlEnv: WEBHOOK_VAR,
      blocks: digest.blocks,
    });
    expect(posted.sent).toBe(true);
    expect(JSON.parse(requests[0]?.body ?? "{}").text).toContain("*T*");
  });

  test("QuietHours holds an overnight alert and says when it may go", async () => {
    const result = await run(quietHours, {
      schedule: { timezone: "Europe/Berlin", quietWindows: [{ start: "22:00", end: "07:00" }] },
      now: "2026-01-15T00:00:00Z",
    });
    expect(result.allowed).toBe(false);
    expect(result.nextAllowed).toBe("2026-01-15T06:00:00.000Z");
  });

  test("QuietHours refuses a now it cannot read rather than falling back to the clock", async () => {
    const result = String(
      await quietHours.execute({
        schedule: { timezone: "UTC", quietWindows: [{ start: "22:00", end: "07:00" }] },
        now: "tonight",
      }),
    );
    expect(result).toContain("not an instant");
  });

  test("RateLimitGate answers from the state it is handed, and hands the next one back", async () => {
    const first = await run(rateLimitGate, {
      key: "disk-full",
      now: "2026-09-17T09:00:00Z",
      windowMs: 3_600_000,
    });
    expect(first.allowed).toBe(true);
    const second = await run(rateLimitGate, {
      key: "disk-full",
      now: "2026-09-17T09:10:00Z",
      windowMs: 3_600_000,
      state: first.nextState,
    });
    expect(second.allowed).toBe(false);
    expect(second.retryAt).toBe("2026-09-17T10:00:00.000Z");
  });

  test("MessageTemplate renders a named template and escapes every value", async () => {
    const result = await run(messageTemplate, {
      templates: { deploy: "*{{service}}* → {{env}}" },
      name: "deploy",
      data: { service: "<!channel>", env: "prod" },
      platform: "slack",
    });
    expect(result.text).toBe("*&lt;!channel&gt;* → prod");
  });

  test("MessageTemplate names the templates it does have when asked for one it does not", async () => {
    const result = String(
      await messageTemplate.execute({
        templates: { a: "x", b: "y" },
        name: "c",
        data: {},
        platform: "slack",
      }),
    );
    expect(result).toContain('no template named "c"');
    expect(result).toContain("a, b");
  });

  test("MessageTemplate refuses a missing value rather than rendering a hole", async () => {
    const result = String(
      await messageTemplate.execute({
        templates: { t: "{{a}} {{b}}" },
        name: "t",
        data: { a: 1 },
        platform: "slack",
      }),
    );
    expect(result).toContain("{{b}}");
    expect(result).toContain("does not supply");
  });

  test("the pure tools are deterministic — the same call twice gives the same bytes", async () => {
    const args = {
      schedule: { timezone: "UTC", quietWindows: [{ start: "22:00", end: "07:00" }] },
      now: "2026-01-15T23:30:00Z",
    };
    expect(await quietHours.execute(args)).toBe(await quietHours.execute(args));
  });
});
