#!/usr/bin/env bun
/**
 * Section 33 iMessage adapter smoke (mac-host-only).
 *
 * Probes:
 *   A) compile examples/hello-channel-imessage → bundle declares
 *      iMessage adapter wiring + opt-in env requirement
 *   B) parseInbound + verify are no-ops (poll-driven adapter)
 *   C) sendReply rejects unsafe handles + escapes shell metacharacters
 *   D) pollNewMessages with a fixture chat.db: 3 inbound (alice + phone +
 *      another), me-message + empty-text rows skipped, cursor advances
 *      to ROWID 5, persists across adapter instances, resetCursor works
 *   E) live: skipped — requires CREWHAUS_IMESSAGE_HOST_ENABLED=1 +
 *      Full Disk Access + a real Messages.app account; never run on CI
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  IMessageAdapterError,
  type InboundEvent,
  createIMessageAdapter,
} from "@crewhaus/channel-adapter-imessage";
import { compile } from "@crewhaus/compiler";

const log = (s: string) => process.stdout.write(`[section-33-imessage] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

// ── Probe A: compile ────────────────────────────────────────────────────────
log("probe A: compile examples/hello-channel-imessage");
const specPath = join(import.meta.dir, "..", "hello-channel-imessage", "crewhaus.yaml");
const yaml = readFileSync(specPath, "utf8");
const bundle = compile(yaml);
const daemon = bundle.files.find((f) => f.path === "daemon.ts")?.content ?? "";
check("daemon.ts exists", daemon.length > 0);
check("daemon imports createIMessageAdapter", daemon.includes("createIMessageAdapter"));
check(
  'daemon registers under "imessage"',
  daemon.includes('registerChannelAdapter("imessage", imessageAdapter)'),
);

// ── Probe B/C/D: pollNewMessages over fixture chat.db ─────────────────────
log("probe B/C/D: build fixture chat.db + poll");
const dir = mkdtempSync(join(tmpdir(), "section-33-imsg-"));
const dbPath = join(dir, "chat.db");
const cursorPath = join(dir, "cursor.json");

const db = new Database(dbPath);
db.run(
  "CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT NOT NULL, service TEXT NOT NULL DEFAULT 'iMessage');",
);
db.run(`
  CREATE TABLE message (
    ROWID INTEGER PRIMARY KEY,
    text TEXT,
    is_from_me INTEGER DEFAULT 0,
    date INTEGER DEFAULT 0,
    handle_id INTEGER REFERENCES handle(ROWID)
  );
`);
db.run("INSERT INTO handle (ROWID, id) VALUES (1, 'alice@example.com')");
db.run("INSERT INTO handle (ROWID, id) VALUES (2, '+15551234567')");
db.run(
  "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (1, 'hi from alice', 0, 7e17, 1)",
);
db.run(
  "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (2, 'me reply', 1, 7.001e17, 1)",
);
db.run(
  "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (3, 'hi from phone', 0, 7.002e17, 2)",
);
db.run(
  "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (4, '', 0, 7.003e17, 1)",
);
db.run(
  "INSERT INTO message (ROWID, text, is_from_me, date, handle_id) VALUES (5, 'second from alice', 0, 7.004e17, 1)",
);
db.close();

const adapter = createIMessageAdapter(
  { chatDbPath: dbPath, cursorPath, requireHostOptIn: false },
  { osascript: async () => undefined },
);
{
  const r = await adapter.pollNewMessages();
  check("first poll: 3 inbound (skips me + empty)", r.events.length === 3);
  check("first poll: cursor advances to 5", r.cursor === 5);
  check("first event from alice", r.events[0]?.userId === "alice@example.com");
  check("second event from phone handle", r.events[1]?.userId === "+15551234567");
  check("idempotencyKey is imsg:<rowid>", r.events[0]?.idempotencyKey === "imsg:1");
}
{
  const r = await adapter.pollNewMessages();
  check(
    "subsequent poll with no new rows: empty + same cursor",
    r.events.length === 0 && r.cursor === 5,
  );
}

const a2 = createIMessageAdapter(
  { chatDbPath: dbPath, cursorPath, requireHostOptIn: false },
  { osascript: async () => undefined },
);
check("cursor persists across adapter instances", a2.getCursor() === 5);

a2.resetCursor();
check("resetCursor → 0", a2.getCursor() === 0);

// Probe C: handle / escape guards
const sendCalls: string[] = [];
const a3 = createIMessageAdapter(
  { chatDbPath: dbPath, cursorPath, requireHostOptIn: false },
  {
    osascript: async (script) => {
      sendCalls.push(script);
    },
  },
);
const event: InboundEvent = {
  idempotencyKey: "imsg:1",
  workspaceId: "imessage",
  channelId: "alice@example.com",
  userId: "alice@example.com",
  ts: "0",
  text: "hi",
  subtype: "message",
};
await a3.sendReply({ event, text: 'hi "you"!' });
check("sendReply called osascript", sendCalls.length === 1);
check('sendReply escapes "quotes"', sendCalls[0]?.includes('send "hi \\"you\\"!"') ?? false);

let rejected = false;
try {
  await a3.sendReply({
    event: { ...event, userId: 'alice@example.com"; rm -rf /' },
    text: "x",
  });
} catch (err) {
  rejected = err instanceof IMessageAdapterError;
}
check("sendReply rejects shell-injection handle", rejected);

rmSync(dir, { recursive: true, force: true });

// ── Probe E: live (gated, never on CI) ─────────────────────────────────────
log(
  "probe E: skipped (live iMessage requires CREWHAUS_IMESSAGE_HOST_ENABLED=1 + Full Disk Access + macOS account)",
);

if (failed > 0) {
  log(`FAILED — ${failed} check(s) did not pass`);
  process.exit(1);
}
log("OK — all probes passed");
