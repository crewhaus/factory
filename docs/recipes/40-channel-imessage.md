---
test:
  spec: examples/hello-channel-imessage/crewhaus.yaml
  bun_scripts:
    - compile:hello-channel-imessage
    - smoke:section-33-imessage
---

# Recipe 40 — Channel: iMessage

The iMessage-specific bits of the channel target: macOS-host-bound
ingest by polling `~/Library/Messages/chat.db`, outbound via
osascript driving Messages.app, hard-gated on a kill-switch env var,
and shell-injection-safe handle validation. There is **no public
Apple Business API** for general agent integrations — this adapter
is the host-bound workaround.

For the channel-target mental model, read [Recipe 03 — Slack Bot](03-slack-bot.md)
first. This recipe covers only the iMessage-specific deltas.

## Prerequisites

- A **Mac** running macOS with iMessage logged in.
- **Full Disk Access** granted to the controlling process so it can
  read `~/Library/Messages/chat.db`.
- (Optional) A `bun:sqlite` chat.db fixture for testing without a
  real Mac.

## Why host-bound

Apple offers no public Business API for iMessage. The options are:

1. **Apple Business Messages.** Available only to approved businesses
   (banks, airlines, etc.), via a separate platform. Not viable for
   general agent integrations.
2. **Reverse-engineering APNS push tokens.** Fragile, against Apple's
   ToS, breaks with every macOS update.
3. **Host-bound polling.** Read `chat.db` directly; send via
   AppleScript. The only approach that is viable AND legal AND
   stable.

This adapter takes option 3.

## The kill switch

The adapter **refuses to do anything** unless both conditions hold:

```bash
CREWHAUS_IMESSAGE_HOST_ENABLED=1
```

AND `process.platform === "darwin"`.

So:

- Running the spec on Linux: fails at startup with a clear error.
- Running on macOS without the env var: fails with "iMessage host
  not enabled — set CREWHAUS_IMESSAGE_HOST_ENABLED=1 to opt in."
- Running on macOS with the env var: proceeds.

This is **defense in depth** — it forces operators to deliberately
opt into the host-controlling behavior. A CI smoke that accidentally
ran the adapter wouldn't drive the developer's iMessage; a multi-
tenant SaaS image deployed to Linux would never even try.

## The spec

[`examples/hello-channel-imessage/crewhaus.yaml`](../../examples/hello-channel-imessage/crewhaus.yaml):

```yaml
name: hello-channel-imessage
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a personal iMessage assistant running on the user's Mac.
    Reply concisely (1-2 sentences). You may use the Read filesystem
    tool to ground answers in repo state.
  tools:
    - read
channels:
  imessage: {}
routing:
  sessionKey: user
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
```

The `imessage:` block is **empty** — no secrets, no tokens. The
auth model is "the host process speaks for the human who owns the
Mac." No credentials change that.

For non-default file paths (rare):

```yaml
channels:
  imessage:
    chatDbPath: ~/Library/Messages/chat.db        # the default
    cursorPath: .crewhaus/imessage-cursor.json    # the default
```

## Inbound — polling chat.db

`chat.db` is a SQLite database iMessage uses for message history.
The adapter polls it once per second:

```sql
SELECT m.ROWID, h.id, m.text, m.is_from_me
FROM message m
JOIN handle h ON m.handle_id = h.ROWID
WHERE m.ROWID > <cursor>
  AND m.is_from_me = 0
ORDER BY m.ROWID ASC
```

`cursor` is the highest `ROWID` seen so far, persisted in
`.crewhaus/imessage-cursor.json` (mode `0o600`). On daemon restart,
polling resumes from `cursor` — no replays of old messages, no
missed messages between restarts.

Polling frequency: 1 Hz. Tunable via `CREWHAUS_IMESSAGE_POLL_MS=500`
for half-second polling, but most workloads don't need faster than
1 second.

## Outbound — driving Messages.app

The adapter sends replies via `osascript`:

```applescript
tell application "Messages"
  set targetService to first service whose service type = iMessage
  set targetBuddy to participant "<handle>" of targetService
  send "<text>" to targetBuddy
end tell
```

Both the handle and the text are AppleScript-escaped to prevent
injection (single-quote → `\"&quot;\"`, double-quote → `\\\"`, etc.).
The escaper is in [`packages/channel-adapter-imessage/src`](../../packages/channel-adapter-imessage).

## Handle validation

Handles look like emails or phone numbers:

- `alice@example.com`
- `+15551234567`
- `tel:+15551234567`

The adapter validates with strict regexes before any `osascript` call:

| Pattern               | Matches                                  |
| --------------------- | ---------------------------------------- |
| email                 | `^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$` |
| `+phone`              | `^\+[1-9]\d{6,14}$`                       |
| `tel:` prefix         | `^tel:\+[1-9]\d{6,14}$`                   |

Anything else fails validation and the send is refused. So a
shell-injection attempt like `alice@example.com'; tell application
"Terminal"...` is rejected at the boundary before reaching osascript.

## What's missing

| Surface          | Why no-op                                                            |
| ---------------- | -------------------------------------------------------------------- |
| `verify`         | Poll-driven, no webhook. No signature to verify.                      |
| `parseInbound`   | The SQL query is the parse step. `parseInbound` is a thin wrapper.   |
| `setTyping`      | iMessage has no public typing API for non-Apple-Business apps.        |
| Read receipts    | Skipped intentionally — sending read receipts requires UI interaction. |

## Per-user session keying

`routing.sessionKey: user`. Each handle becomes its own session:

```
sess_<sha256("imessage:" + handle)[:16]>
```

So a conversation with `+15551234567` is one session; conversation
with `alice@example.com` is another. Same handle reaches the same
session across daemon restarts.

## Operating considerations

- **Don't run as a server.** This is a personal-machine adapter, not
  a multi-tenant service. One human, one Mac, one daemon.
- **Don't run in untrusted contexts.** A compromised daemon controls
  the user's iMessage account. Sandbox isolation doesn't help here —
  the AppleScript runs in the user's session.
- **Full Disk Access.** The first poll attempt fails with EACCES if
  the process doesn't have FDA. Grant via System Preferences →
  Privacy & Security → Full Disk Access.
- **Lock screen.** When the Mac is locked, AppleScript send calls
  may queue or fail depending on the macOS version. Watch the
  `imessage_send_failed` audit events.
- **Auto-update brittleness.** macOS minor updates can change the
  chat.db schema. The adapter pins the query against schema fields
  that have been stable since macOS 10.12; major macOS upgrades
  warrant a re-test.

## Worked example: personal assistant

```yaml
# Channel spec fragment — MCP tool names land as calendar__list_events,
# reminders__add, gmail__list_unread, accessible to the agent:
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are my personal assistant running on my Mac. Tasks I may
    ask:
    - "what's on my calendar today" → call calendar__list_events.
    - "remind me to X at Y" → call reminders__add.
    - "summarize my unread email" → call gmail__list_unread + summarize.
    Reply concisely (1-2 sentences max).
mcp_servers:
  calendar:
    transport: stdio
    command: mcp-calendar
  reminders:
    transport: stdio
    command: mcp-reminders
  gmail:
    transport: stdio
    command: mcp-gmail
channels:
  imessage: {}
routing:
  sessionKey: user
```

Text the bot from your iPhone → it reads your chat.db on your Mac →
processes the request → replies in the same iMessage thread. Useful
for "ask my computer something while I'm away from it."

## Smoke

```bash
bun run smoke:section-33-imessage
```

Validates without a real Mac:

1. The kill-switch refuses on Linux even with the env var set.
2. The kill-switch refuses on macOS without the env var.
3. With both gates passing, polling reads a `bun:sqlite` chat.db
   fixture correctly.
4. Cursor persistence works across simulated restarts.
5. Handle validation rejects shell-injection attempts.
6. AppleScript escaping is correct.

The smoke uses an in-memory SQLite fixture, so it runs in CI
without iMessage installed.

## Things that look like iMessage support but aren't

| Symptom                                                          | Better tool                                       |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| Want **business-grade** iMessage (CRM-style).                     | Apple Business Messages (separate Apple platform). |
| Want **SMS** (not iMessage).                                      | Twilio + a Twilio channel adapter (DIY).            |
| Want **cross-platform**.                                          | WhatsApp, Telegram, Discord; they're cross-platform. |
| Want it without a Mac.                                            | Not possible. iMessage requires Apple infrastructure. |

## What to read next

- **Same shape, different channels.** [Recipe 37 — Telegram](37-channel-telegram.md),
  [Recipe 38 — Discord](38-channel-discord.md),
  [Recipe 39 — WhatsApp](39-channel-whatsapp.md).
- **Channel-target mental model.** [Recipe 03 — Slack Bot](03-slack-bot.md).

## Pointers to source

- **Example:** [`examples/hello-channel-imessage/crewhaus.yaml`](../../examples/hello-channel-imessage/crewhaus.yaml).
- **Adapter:** [`packages/channel-adapter-imessage`](../../packages/channel-adapter-imessage).
- **Spec schema (imessage block):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts).
- **Module catalog reference:** §33 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
