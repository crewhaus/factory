#!/usr/bin/env bun
/**
 * Section 33 Telegram adapter smoke.
 *
 * Probes:
 *   A) compile examples/hello-channel-telegram → bundle declares Telegram
 *      adapter wiring + secret env-name check
 *   B) parseInbound round-trips each fixture inbound payload
 *   C) verify() rejects tampered/missing secret tokens
 *   D) sendReply emits documented argv (POST sendMessage with chat_id +
 *      text + optional message_thread_id)
 *   E) idempotency cursor — same update_id parsed twice yields same
 *      idempotencyKey (gateway dedups on this)
 *
 * Live Telegram Bot API probe is gated on TELEGRAM_BOT_TOKEN +
 * CREWHAUS_TELEGRAM_LIVE_CHAT_ID env vars and is otherwise skipped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type InboundEvent,
  type RawRequest,
  createTelegramAdapter,
  verifyTelegramSecret,
} from "@crewhaus/channel-adapter-telegram";
import { compile } from "@crewhaus/compiler";

const log = (s: string) => process.stdout.write(`[section-33-telegram] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const FIXTURE_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "channel-adapter-telegram",
  "src",
  "fixtures",
);
const fixture = (n: string) => readFileSync(join(FIXTURE_DIR, `${n}.json`), "utf8");

// ── Probe A: compile produces a daemon wired to telegram adapter ────────────
log("probe A: compile examples/hello-channel-telegram");
const specPath = join(import.meta.dir, "..", "hello-channel-telegram", "crewhaus.yaml");
const yaml = readFileSync(specPath, "utf8");
const bundle = compile(yaml);
const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
check("daemon.ts exists", daemon.length > 0);
check("daemon imports createTelegramAdapter", daemon.includes("createTelegramAdapter"));
check(
  'daemon registers under "telegram"',
  daemon.includes('registerChannelAdapter("telegram", telegramAdapter)'),
);
check(
  'daemon adapter map contains ["telegram", telegramAdapter]',
  daemon.includes('["telegram", telegramAdapter]'),
);
check(
  "daemon env list includes both TELEGRAM_* vars",
  daemon.includes("TELEGRAM_BOT_TOKEN") && daemon.includes("TELEGRAM_SECRET_TOKEN"),
);

// ── Probe B: parseInbound round-trips each fixture ──────────────────────────
log("probe B: parseInbound fixtures");
const adapter = createTelegramAdapter(
  { botToken: "test:token", secretToken: "smoke-secret" },
  { apiBaseUrl: "https://test.telegram.local" },
);
const baseHeaders = (token = "smoke-secret"): Headers => {
  const h = new Headers();
  h.set("X-Telegram-Bot-Api-Secret-Token", token);
  return h;
};
const req = (body: string): RawRequest => ({ headers: baseHeaders(), body });

for (const f of [
  "private_message",
  "group_message",
  "group_topic_message",
  "edited_message",
  "callback_query",
  "bot_mention",
  "photo_with_caption",
]) {
  const r = adapter.parseInbound(req(fixture(f)));
  check(`parseInbound ${f} → event`, r.kind === "event");
}
for (const f of ["sticker_only", "missing_chat", "non_message_update"]) {
  const r = adapter.parseInbound(req(fixture(f)));
  check(`parseInbound ${f} → skip`, r.kind === "skip");
}

// ── Probe C: verify rejects tampered/missing secret ─────────────────────────
log("probe C: secret_token verification");
check(
  "matches valid",
  verifyTelegramSecret({ headers: baseHeaders("smoke-secret"), secretToken: "smoke-secret" }),
);
check(
  "rejects tampered",
  !verifyTelegramSecret({ headers: baseHeaders("wrong-secret-1234"), secretToken: "smoke-secret" }),
);
check(
  "rejects missing",
  !verifyTelegramSecret({ headers: new Headers(), secretToken: "smoke-secret" }),
);

// ── Probe D: sendReply emits documented argv ────────────────────────────────
log("probe D: sendReply argv");
{
  const calls: Array<{ url: string; body: unknown }> = [];
  const fakeFetch = (async (input: string | Request | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const a = createTelegramAdapter(
    { botToken: "test:token", secretToken: "smoke-secret" },
    { apiBaseUrl: "https://test.telegram.local", fetch: fakeFetch },
  );
  const event: InboundEvent = {
    idempotencyKey: "100001",
    workspaceId: "4242",
    channelId: "4242",
    userId: "4242",
    ts: "7",
    text: "hello",
    subtype: "message",
  };
  await a.sendReply({ event, text: "hi back" });
  check("sendReply called fetch once", calls.length === 1);
  check("sendReply hits sendMessage", calls[0]?.url?.endsWith("/sendMessage") ?? false);
  check(
    "sendReply body has chat_id and text",
    (calls[0]?.body as { chat_id: number; text: string })?.chat_id === 4242 &&
      (calls[0]?.body as { chat_id: number; text: string })?.text === "hi back",
  );
}

// ── Probe E: idempotency on update_id ───────────────────────────────────────
log("probe E: idempotency");
{
  const a = createTelegramAdapter(
    { botToken: "test:token", secretToken: "smoke-secret" },
    { apiBaseUrl: "https://test.telegram.local" },
  );
  const r1 = a.parseInbound(req(fixture("private_message")));
  const r2 = a.parseInbound(req(fixture("private_message")));
  if (r1.kind === "event" && r2.kind === "event") {
    check("same update → same idempotencyKey", r1.event.idempotencyKey === r2.event.idempotencyKey);
  } else {
    check("idempotency check parsed both as events", false);
  }
}

// ── Probe F: live Bot API (gated) ───────────────────────────────────────────
const liveToken = process.env["TELEGRAM_BOT_TOKEN"];
const liveChatId = process.env["CREWHAUS_TELEGRAM_LIVE_CHAT_ID"];
if (liveToken && liveChatId) {
  log("probe F: live sendMessage to Telegram");
  try {
    const a = createTelegramAdapter({ botToken: liveToken, secretToken: "ignored-for-send" }, {});
    await a.sendReply({
      event: {
        idempotencyKey: `smoke-${Date.now()}`,
        workspaceId: liveChatId,
        channelId: liveChatId,
        userId: "0",
        ts: String(Date.now()),
        text: "",
        subtype: "message",
      },
      text: "section-33 smoke ping",
    });
    check("live sendMessage round-trip OK", true);
  } catch (err) {
    check("live sendMessage round-trip OK", false, (err as Error).message);
  }
} else {
  log("probe F: skipped (TELEGRAM_BOT_TOKEN + CREWHAUS_TELEGRAM_LIVE_CHAT_ID not set)");
}

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");
