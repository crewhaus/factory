# Recipe 39 — Channel: WhatsApp

> **Status:** stub.

## What you'll learn

The WhatsApp-specific bits of the channel target: HMAC-SHA256
verification per Meta's `X-Hub-Signature-256` spec, the message type
taxonomy (text, interactive button/list, image with caption), per-user
session keying via `wa_id`, and dedup against Meta's aggressive retry
storm.

## Prerequisites

- [Recipe 03 — Slack Bot](03-slack-bot.md) for the channel-target mental model.
- A Meta Business account, a WhatsApp Business Cloud API number, and the app secret.

## Roadmap

1. Setting up the integration: Meta Business → WhatsApp Business → phone number id + app secret + Bearer token.
2. Verification: HMAC-SHA256 of the raw body using the app secret, compared timing-safely to `sha256=<hex>` in `X-Hub-Signature-256`.
3. Message types:
   - `text` — body verbatim.
   - `interactive` — `button_reply` / `list_reply` rendered as `[button:<id>]` / `[list:<id>]`.
   - `image` with caption — rendered as `[image] <caption>`.
   - Skipped: image-without-caption, audio, sticker, status-only, wrong-object payloads.
4. Per-user session keying via `wa_id` (the contact's WhatsApp ID).
5. `sendReply` POSTs `/v22.0/{phoneNumberId}/messages` with the `text` payload.
6. `setTyping` is a no-op — WhatsApp Business has no public typing API.
7. Idempotency: dedup by `messages[].id` (Meta retries aggressively).
8. Operational: webhook subscription setup, 24-hour customer service window.

## Run it now

```bash
bun run compile:hello-channel-whatsapp
bun run smoke:section-33-whatsapp
```

## Pointers to existing material

- **Example:** [`examples/hello-channel-whatsapp/crewhaus.yaml`](../../examples/hello-channel-whatsapp/crewhaus.yaml).
- **Module:** [`packages/channel-adapter-whatsapp`](../../packages/channel-adapter-whatsapp).
- **Catalog:** §33.

## Where to go next

- Same shape, different channels: [Recipe 37 — Telegram](37-channel-telegram.md), [Recipe 38 — Discord](38-channel-discord.md), [Recipe 40 — iMessage](40-channel-imessage.md).
