/**
 * The tools driven the way the runtime drives them: registered in a catalog
 * and dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before `execute` ever
 * runs.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately. The server
 * is a real one on 127.0.0.1, as in `index.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import {
  NOTIFY_TOOLS,
  __setPrivateHostsAllowedForTest,
  _resetIdempotencyLedger,
  _resetNotifyConfig,
  _setDnsTxtResolver,
  registerNotifyConfig,
} from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let server: ReturnType<typeof Bun.serve>;
let origin = "";
let tmp: string;

const WEBHOOK_VAR = "CREWHAUS_INT_WEBHOOK";

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-notify-int-"));
  process.chdir(tmp);
  server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ ok: true, ts: "1.1", id: "m1", status: "sent" }), {
        headers: { "content-type": "application/json" },
      }),
  });
  origin = `http://127.0.0.1:${server.port}`;
  process.env[WEBHOOK_VAR] = `${origin}/services/T/B/x`;
  registerNotifyConfig({
    allowed_origins: [origin],
    allowed_recipients: ["*@example.com"],
    allowed_smtp_hosts: ["127.0.0.1"],
    allowed_sender_domains: ["example.com"],
    providers: {
      gateway: {
        endpoint: `${origin}/sms`,
        fields: { to: "To", body: "Body", title: "Title" },
        idPath: "id",
        statusPath: "status",
        statusEndpoint: `${origin}/sms/{id}`,
      },
    },
  });
  __setPrivateHostsAllowedForTest(true);
  // DNS is recorded here too: dispatching every tool through the executor
  // must not make one of them ask a real resolver.
  _setDnsTxtResolver((name) =>
    name === "example.com"
      ? Promise.resolve([["v=spf1 -all"]])
      : Promise.reject(new Error(`no DNS fixture recorded for "${name}"`)),
  );
  catalog = new ToolCatalog();
  for (const tool of NOTIFY_TOOLS) catalog.register(tool);
});

afterEach(() => {
  process.chdir(originalCwd);
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
  _resetNotifyConfig();
  _resetIdempotencyLedger();
  _setDnsTxtResolver(undefined);
  __setPrivateHostsAllowedForTest(false);
  delete process.env[WEBHOOK_VAR];
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(NOTIFY_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of NOTIFY_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });

  test("registering the same tool twice is refused, which is what makes names unique", () => {
    expect(() => catalog.register(NOTIFY_TOOLS[0] as RegisteredTool)).toThrow();
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("ChatPost"),
      { platform: "slack", webhookUrlEnv: WEBHOOK_VAR, text: "hello" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"sent":true');
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("ChatPost"),
      { platform: "slack", text: 42 },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ChatPost");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(
      lookup("SmsSend"),
      { provider: "gateway" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
  });

  test("an unknown platform is rejected by the enum, not by the tool", async () => {
    const result = await executeTool(
      lookup("ChatPost"),
      { platform: "irc", webhookUrlEnv: WEBHOOK_VAR, text: "x" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("NotifyDigest"),
      { events: [{ key: "a" }] },
      { toolUseId: "t5", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("NotifyDigest"),
      { events: [{ key: "a" }] },
      { toolUseId: "t6", allowedPatterns: ["NotifyDigest"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("a per-call tool_config replaces the boot allow-list for that call only", async () => {
    const denied = await executeTool(
      lookup("ChatPost"),
      { platform: "slack", webhookUrlEnv: WEBHOOK_VAR, text: "x" },
      { toolUseId: "t7", toolConfig: { allowed_origins: ["https://elsewhere.test"] } },
    );
    expect(denied.content).toContain("not in allowed_origins");
    const allowed = await executeTool(
      lookup("ChatPost"),
      { platform: "slack", webhookUrlEnv: WEBHOOK_VAR, text: "x" },
      { toolUseId: "t8" },
    );
    expect(allowed.content).toContain('"sent":true');
  });

  test("the runtime's own cancellation aborts a send in flight", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeTool(
      lookup("ChatPost"),
      { platform: "slack", webhookUrlEnv: WEBHOOK_VAR, text: "x" },
      { toolUseId: "t9", signal: controller.signal },
    );
    expect(result.content).toContain("nothing was sent");
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const api = { apiBaseUrl: `${origin}/api`, tokenEnv: WEBHOOK_VAR, channel: "C1" };
    const mail = {
      from: { address: "ci@example.com" },
      to: [{ address: "ops@example.com" }],
      subject: "s",
      text: "t",
      date: "2026-09-17T09:30:00Z",
    };
    const calls: Record<string, unknown> = {
      ChatPost: { platform: "slack", webhookUrlEnv: WEBHOOK_VAR, text: "x" },
      ChatUpdate: { platform: "slack", ...api, messageId: "1.1", text: "x" },
      ChatDelete: { platform: "slack", ...api, messageId: "1.1" },
      ChatReact: { platform: "slack", ...api, messageId: "1.1", emoji: "eyes" },
      DeliverabilityCheck: { domain: "example.com" },
      DeliveryCheck: { provider: "gateway", messageId: "m1" },
      EmailCompose: mail,
      // No SMTP server here: the point is that it returns a string rather
      // than throwing when the connection cannot be made.
      EmailSend: { ...mail, host: "127.0.0.1", port: 1, timeoutMs: 500, requireTls: false },
      EmailSendPreflight: mail,
      MessageTemplate: { templates: { t: "{{a}}" }, name: "t", data: { a: 1 }, platform: "slack" },
      NotifyDigest: { events: [{ key: "a" }] },
      PushNotify: { provider: "gateway", to: "d", body: "b" },
      QuietHours: {
        schedule: { timezone: "UTC", quietWindows: [{ start: "22:00", end: "07:00" }] },
        now: "2026-09-17T09:30:00Z",
      },
      RateLimitGate: { key: "k", now: "2026-09-17T09:30:00Z", windowMs: 1000 },
      SmsSend: { provider: "gateway", to: "+1", body: "b" },
      WebhookPost: { url: `${origin}/hook`, payload: { a: 1 } },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(NOTIFY_TOOLS.map((t) => t.name).sort());
    for (const tool of NOTIFY_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
      expect({ name: tool.name, type: typeof result.content }).toEqual({
        name: tool.name,
        type: "string",
      });
    }
  });

  test("results are deterministic — the same pure call twice gives the same bytes", async () => {
    const args = {
      schedule: { timezone: "Europe/Berlin", quietWindows: [{ start: "22:00", end: "07:00" }] },
      now: "2026-01-15T00:00:00Z",
    };
    const a = await executeTool(lookup("QuietHours"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("QuietHours"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });

  test("a refusal comes back as a readable result, not as a thrown exception", async () => {
    _resetNotifyConfig();
    const result = await executeTool(
      lookup("ChatPost"),
      { platform: "slack", webhookUrlEnv: WEBHOOK_VAR, text: "x" },
      { toolUseId: "r1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("empty allow-list = deny all");
  });
});

// Regression — a RELATIVE symlink target must be resolved against the
// directory that actually CONTAINS the link, not against the link's lexical
// parent. The two only ever differ when that parent is itself reached
// through a symlink, and it takes the `readlink` hop to make the difference
// reachable: the leaf then sits in the RESOLVED part of the path, so
// measuring it from the wrong directory names a location the caller's path
// does not lead to.
//
// The wrong base cannot produce a path OUTSIDE the root — it strips the
// outward hop, so what it names is always in-root and always passes
// containment. That is what makes it worth a test rather than a shrug: the
// failure is silent. `EmailCompose` would have attached a different file
// than the one the caller's path leads to, and a legitimate in-workspace
// relative dangling link would be judged by the same broken arithmetic.
describe("integration: tool-notify relative dangling-link base", () => {
  test("an outward directory link holding a relative dangling link is refused", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "tool-notify-outside-"));
    try {
      mkdirSync(path.join(outside, "realdir"));
      // `pdir` leaves the workspace, so `l` really lives in <outside>/realdir
      // and "../escape.bin" truly names <outside>/escape.bin. Read from the
      // LEXICAL parent <tmp>/pdir the same target reads as <tmp>/escape.bin —
      // an in-root path, and one that exists, so the broken arithmetic does
      // not merely mis-measure: it finds a real file to attach.
      symlinkSync(path.join(outside, "realdir"), path.join(tmp, "pdir"));
      symlinkSync("../escape.bin", path.join(outside, "realdir", "l"));
      const decoy = "IN-ROOT-DECOY-NOT-THE-ATTACHMENT";
      writeFileSync(path.join(tmp, "escape.bin"), decoy);

      const result = await executeTool(
        lookup("EmailCompose"),
        {
          from: { address: "ci@example.com" },
          to: [{ address: "ops@example.com" }],
          subject: "s",
          text: "t",
          date: "2026-09-17T09:30:00Z",
          // A plain workspace-relative path: no `..`, not absolute, so the
          // lexical pre-check waves it through and the refusal below can
          // only have come from the symlink walk.
          attachments: [{ path: "pdir/l" }],
        },
        { toolUseId: "relbase" },
      );

      // This package hands refusals back as text rather than throwing.
      expect(result.isError).toBe(false);
      expect(String(result.content)).toMatch(/escapes the workspace root/);
      // And it is refused rather than quietly redirected: the in-root file
      // the lexical reading names was never opened.
      expect(String(result.content)).not.toContain(Buffer.from(decoy).toString("base64"));
      // The tool only ever reads, so this cannot fail here — it is the same
      // assertion the tool-fs copy of this test makes, kept so the whole
      // sweep reads alike and so a future writing tool inherits the check.
      expect(existsSync(path.join(outside, "escape.bin"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
