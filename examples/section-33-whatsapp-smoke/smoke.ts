#!/usr/bin/env bun
/**
 * Section 33 WhatsApp Business adapter smoke.
 *
 * Probes:
 *   A) compile examples/hello-channel-whatsapp → bundle declares
 *      WhatsApp adapter wiring + secret env-name check
 *   B) parseInbound round-trips fixture text + interactive payloads
 *   C) X-Hub-Signature-256 verify accepts/rejects per signed body
 *   D) sendReply emits documented argv (POST /v22.0/<phoneId>/messages)
 *   E) idempotency: same messages[].id parsed twice yields same key
 *      (gateway dedups across Meta's aggressive redelivery)
 *   F) live Cloud API gated on WHATSAPP_ACCESS_TOKEN +
 *      WHATSAPP_PHONE_NUMBER_ID + CREWHAUS_WHATSAPP_LIVE_TO
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type InboundEvent,
  createWhatsAppAdapter,
  signWhatsAppBody,
  verifyWhatsAppSignature,
} from "@crewhaus/channel-adapter-whatsapp";
import { compile } from "@crewhaus/compiler";

const log = (s: string) => process.stdout.write(`[section-33-whatsapp] ${s}\n`);
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
  "channel-adapter-whatsapp",
  "src",
  "fixtures",
);
const fixture = (n: string) => readFileSync(join(FIXTURE_DIR, `${n}.json`), "utf8");

const APP_SECRET = "smoke-app-secret";
const signedHeaders = (body: string) => {
  const sig = signWhatsAppBody({ body, appSecret: APP_SECRET });
  const h = new Headers();
  h.set("X-Hub-Signature-256", sig);
  return h;
};

// ── Probe A: compile ────────────────────────────────────────────────────────
log("probe A: compile examples/hello-channel-whatsapp");
const specPath = join(import.meta.dir, "..", "hello-channel-whatsapp", "crewhaus.yaml");
const yaml = readFileSync(specPath, "utf8");
const bundle = compile(yaml);
const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
check("daemon.ts exists", daemon.length > 0);
check("daemon imports createWhatsAppAdapter", daemon.includes("createWhatsAppAdapter"));
check(
  'daemon registers under "whatsapp"',
  daemon.includes('registerChannelAdapter("whatsapp", whatsappAdapter)'),
);
check(
  "daemon env list includes WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN + WHATSAPP_APP_SECRET",
  daemon.includes("WHATSAPP_PHONE_NUMBER_ID") &&
    daemon.includes("WHATSAPP_ACCESS_TOKEN") &&
    daemon.includes("WHATSAPP_APP_SECRET"),
);

// ── Probe B+C: parseInbound + verify ───────────────────────────────────────
log("probe B+C: parseInbound + signature verify");
const adapter = createWhatsAppAdapter(
  { phoneNumberId: "999000999000", accessToken: "EAAxxx", appSecret: APP_SECRET },
  { apiBaseUrl: "https://test.graph.local" },
);
for (const f of ["text_message", "button_reply", "list_reply", "image_with_caption"]) {
  const body = fixture(f);
  const headers = signedHeaders(body);
  check(`verify ${f} → true`, verifyWhatsAppSignature({ headers, body, appSecret: APP_SECRET }));
  const r = adapter.parseInbound({ headers, body });
  check(`parseInbound ${f} → event`, r.kind === "event");
}
for (const f of [
  "image_no_caption",
  "audio_message",
  "status_only",
  "sticker",
  "wrong_object",
  "missing_metadata",
]) {
  const body = fixture(f);
  const r = adapter.parseInbound({ headers: signedHeaders(body), body });
  check(`parseInbound ${f} → skip`, r.kind === "skip");
}
{
  const body = fixture("text_message");
  const headers = signedHeaders(body);
  check(
    "tampered body fails verify",
    !verifyWhatsAppSignature({ headers, body: `${body}--tampered`, appSecret: APP_SECRET }),
  );
  check(
    "wrong appSecret fails verify",
    !verifyWhatsAppSignature({ headers, body, appSecret: "wrong-secret" }),
  );
}

// ── Probe D: sendReply argv ────────────────────────────────────────────────
log("probe D: sendReply argv");
{
  const calls: Array<{ url: string; body: unknown }> = [];
  const f = (async (input: string | Request | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ messaging_product: "whatsapp" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const a = createWhatsAppAdapter(
    { phoneNumberId: "999000999000", accessToken: "EAAxxx", appSecret: APP_SECRET },
    { apiBaseUrl: "https://test.graph.local", fetch: f },
  );
  const event: InboundEvent = {
    idempotencyKey: "wamid.x",
    workspaceId: "999000999000",
    channelId: "15554443333",
    userId: "15554443333",
    ts: "1700000000",
    text: "hi",
    subtype: "message",
  };
  await a.sendReply({ event, text: "thanks!" });
  check(
    "sendReply hits /v22.0/<phoneId>/messages",
    (calls[0]?.url ?? "").endsWith("/v22.0/999000999000/messages"),
  );
  const body = calls[0]?.body as {
    to: string;
    type: string;
    text: { body: string };
    messaging_product: string;
  };
  check("sendReply body has to=<userId>", body?.to === "15554443333");
  check("sendReply body has type=text", body?.type === "text");
  check("sendReply body has text.body", body?.text?.body === "thanks!");
  check("sendReply body has messaging_product=whatsapp", body?.messaging_product === "whatsapp");
}

// ── Probe E: idempotency ──────────────────────────────────────────────────
log("probe E: idempotency");
{
  const body = fixture("text_message");
  const r1 = adapter.parseInbound({ headers: signedHeaders(body), body });
  const r2 = adapter.parseInbound({ headers: signedHeaders(body), body });
  if (r1.kind === "event" && r2.kind === "event") {
    check(
      "same payload → same idempotencyKey",
      r1.event.idempotencyKey === r2.event.idempotencyKey,
    );
  } else {
    check("idempotency check parsed both as events", false);
  }
}

// ── Probe F: live Cloud API (gated) ───────────────────────────────────────
const liveToken = process.env["WHATSAPP_ACCESS_TOKEN"];
const livePhoneId = process.env["WHATSAPP_PHONE_NUMBER_ID"];
const liveTo = process.env["CREWHAUS_WHATSAPP_LIVE_TO"];
if (liveToken && livePhoneId && liveTo) {
  log("probe F: live POST to WhatsApp Cloud API");
  try {
    const a = createWhatsAppAdapter(
      { phoneNumberId: livePhoneId, accessToken: liveToken, appSecret: "ignored" },
      {},
    );
    await a.sendReply({
      event: {
        idempotencyKey: `smoke-${Date.now()}`,
        workspaceId: livePhoneId,
        channelId: liveTo,
        userId: liveTo,
        ts: String(Date.now()),
        text: "",
        subtype: "message",
      },
      text: "section-33 whatsapp smoke ping",
    });
    check("live messages POST OK", true);
  } catch (err) {
    check("live messages POST OK", false, (err as Error).message);
  }
} else {
  log(
    "probe F: skipped (WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID + CREWHAUS_WHATSAPP_LIVE_TO not set)",
  );
}

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");
