# Recipe 40 — Channel: iMessage

> **Status:** stub.

## What you'll learn

The iMessage-specific bits of the channel target: macOS-host-bound
ingest by polling `~/Library/Messages/chat.db`, outbound via osascript
driving Messages.app, hard-gated on a kill-switch env var, and
shell-injection-safe handle validation. There is no public Apple
Business API for general agent integrations — this adapter is the
host-bound workaround.

## Prerequisites

- A Mac (or a `bun:sqlite` chat.db fixture if you're testing without one).
- Full Disk Access granted to the controlling process so it can read `~/Library/Messages/chat.db`.

## Roadmap

1. Why host-bound: Apple offers no public iMessage Business API. This adapter takes the only viable approach for general agent integrations.
2. Hard kill-switch: `CREWHAUS_IMESSAGE_HOST_ENABLED=1` AND `process.platform === "darwin"` are both required; without them the adapter refuses to do anything.
3. Inbound: polls `chat.db` for messages with `ROWID > cursor`. Cursor persists at `.crewhaus/imessage-cursor.json` (mode 0o600) so daemon restarts resume from where they left off.
4. Outbound: drives Messages.app via `osascript`. Both the handle and the message body are AppleScript-escaped.
5. Handle validation: email-shaped / `+phone` / `tel:` regex. Shell-injection attempts are rejected at the boundary.
6. `parseInbound` and `verify` are no-ops (poll-driven, not webhook-driven).
7. `setTyping` is a no-op.
8. The IR slot is optional fields only — no required secrets — because the auth model is host-process identity.
9. Operational: never run this in untrusted contexts. The host process speaks for the human who owns the Mac.

## Run it now

```bash
bun run compile:hello-channel-imessage
# Smoke uses a bun:sqlite chat.db fixture so it works without a real Mac:
bun run smoke:section-33-imessage
```

## Pointers to existing material

- **Example:** [`examples/hello-channel-imessage/crewhaus.yaml`](../../examples/hello-channel-imessage/crewhaus.yaml).
- **Module:** [`packages/channel-adapter-imessage`](../../packages/channel-adapter-imessage).
- **Catalog:** §33.

## Where to go next

- Same shape, different channels: [Recipe 37 — Telegram](37-channel-telegram.md), [Recipe 38 — Discord](38-channel-discord.md), [Recipe 39 — WhatsApp](39-channel-whatsapp.md).
