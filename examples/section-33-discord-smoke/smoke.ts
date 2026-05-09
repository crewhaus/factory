#!/usr/bin/env bun
/**
 * Section 33 Discord adapter smoke.
 *
 * Probes:
 *   A) compile examples/hello-channel-discord → bundle declares Discord
 *      adapter wiring + secret env-name check
 *   B) parseInbound round-trips fixture interactions (slash command,
 *      button, modal) and rejects unknown types
 *   C) Ed25519 verify matches/rejects per signed payload
 *   D) sendReply emits documented argv (POST /channels/<id>/messages)
 *   E) PING → challenge with PONG body (Discord URL-verification)
 *   F) live Discord API gated on DISCORD_BOT_TOKEN +
 *      CREWHAUS_DISCORD_LIVE_CHANNEL_ID
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type InboundEvent,
  createDiscordAdapter,
  generateEd25519Keypair,
  signDiscordBody,
  verifyDiscordSignature,
} from "@crewhaus/channel-adapter-discord";
import { compile } from "@crewhaus/compiler";

const log = (s: string) => process.stdout.write(`[section-33-discord] ${s}\n`);
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
  "channel-adapter-discord",
  "src",
  "fixtures",
);
const fixture = (n: string) => readFileSync(join(FIXTURE_DIR, `${n}.json`), "utf8");

const { publicKeyHex, privateKeyPem } = generateEd25519Keypair();

const signedHeaders = (body: string, ts = "1700000000") => {
  const sig = signDiscordBody({ body, timestamp: ts, privateKeyPem });
  const h = new Headers();
  h.set("X-Signature-Ed25519", sig);
  h.set("X-Signature-Timestamp", ts);
  return h;
};

// ── Probe A: compile ────────────────────────────────────────────────────────
log("probe A: compile examples/hello-channel-discord");
const specPath = join(import.meta.dir, "..", "hello-channel-discord", "crewhaus.yaml");
const yaml = readFileSync(specPath, "utf8");
const bundle = compile(yaml);
const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
check("daemon.ts exists", daemon.length > 0);
check("daemon imports createDiscordAdapter", daemon.includes("createDiscordAdapter"));
check(
  'daemon registers under "discord"',
  daemon.includes('registerChannelAdapter("discord", discordAdapter)'),
);
check(
  "daemon env list includes DISCORD_APPLICATION_ID + DISCORD_BOT_TOKEN + DISCORD_PUBLIC_KEY",
  daemon.includes("DISCORD_APPLICATION_ID") &&
    daemon.includes("DISCORD_BOT_TOKEN") &&
    daemon.includes("DISCORD_PUBLIC_KEY"),
);

// ── Probe B/C/E: parseInbound + verify ─────────────────────────────────────
log("probe B/C/E: parseInbound + Ed25519 verify");
const adapter = createDiscordAdapter(
  { applicationId: "200000000000000001", botToken: "Bot.token", publicKeyHex },
  { apiBaseUrl: "https://test.discord.local" },
);
for (const f of [
  "slash_command_basic",
  "slash_command_with_options",
  "slash_command_thread",
  "slash_command_dm",
  "component_button",
  "modal_submit",
]) {
  const body = fixture(f);
  const headers = signedHeaders(body);
  check(`verify ${f} → true`, verifyDiscordSignature({ headers, body, publicKeyHex }));
  const r = adapter.parseInbound({ headers, body });
  check(`parseInbound ${f} → event`, r.kind === "event");
}
{
  const body = fixture("ping");
  const r = adapter.parseInbound({ headers: signedHeaders(body), body });
  check("ping → challenge", r.kind === "challenge");
  if (r.kind === "challenge") {
    check("challenge body is PONG type:1", JSON.parse(r.challenge).type === 1);
  }
}
{
  const body = fixture("unknown_type");
  const r = adapter.parseInbound({ headers: signedHeaders(body), body });
  check("unknown_type → skip", r.kind === "skip");
}
{
  const body = fixture("slash_command_basic");
  const headers = signedHeaders(body);
  // tampered body: signature was over the original body, so the tampered
  // verify must reject.
  check(
    "tampered body fails verify",
    !verifyDiscordSignature({ headers, body: `${body}--tampered`, publicKeyHex }),
  );
  const otherKey = generateEd25519Keypair().publicKeyHex;
  check(
    "wrong public key fails verify",
    !verifyDiscordSignature({ headers, body, publicKeyHex: otherKey }),
  );
}

// ── Probe D: sendReply argv ────────────────────────────────────────────────
log("probe D: sendReply argv");
{
  const calls: Array<{ url: string; body: unknown }> = [];
  const f = (async (input: string | Request | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response("", { status: 204 });
  }) as unknown as typeof fetch;
  const a = createDiscordAdapter(
    { applicationId: "200000000000000001", botToken: "Bot.token", publicKeyHex },
    { apiBaseUrl: "https://test.discord.local", fetch: f },
  );
  const event: InboundEvent = {
    idempotencyKey: "100",
    workspaceId: "400",
    channelId: "300",
    userId: "500",
    ts: "100",
    text: "/ping",
    subtype: "message",
  };
  await a.sendReply({ event, text: "pong" });
  check(
    "sendReply hits /channels/300/messages",
    (calls[0]?.url ?? "").endsWith("/channels/300/messages"),
  );
  check(
    'sendReply body has content="pong"',
    (calls[0]?.body as { content: string })?.content === "pong",
  );
}

// ── Probe F: live Discord (gated) ─────────────────────────────────────────
const liveBot = process.env["DISCORD_BOT_TOKEN"];
const liveChannel = process.env["CREWHAUS_DISCORD_LIVE_CHANNEL_ID"];
const liveAppId = process.env["DISCORD_APPLICATION_ID"] ?? "live";
if (liveBot && liveChannel) {
  log("probe F: live POST to Discord");
  try {
    const a = createDiscordAdapter(
      { applicationId: liveAppId, botToken: liveBot, publicKeyHex: "ignored" },
      {},
    );
    await a.sendReply({
      event: {
        idempotencyKey: `smoke-${Date.now()}`,
        workspaceId: "live",
        channelId: liveChannel,
        userId: "0",
        ts: String(Date.now()),
        text: "",
        subtype: "message",
      },
      text: "section-33 discord smoke ping",
    });
    check("live channels/<id>/messages POST OK", true);
  } catch (err) {
    check("live channels/<id>/messages POST OK", false, (err as Error).message);
  }
} else {
  log("probe F: skipped (DISCORD_BOT_TOKEN + CREWHAUS_DISCORD_LIVE_CHANNEL_ID not set)");
}

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");
