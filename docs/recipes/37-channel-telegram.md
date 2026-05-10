# Recipe 37 — Channel: Telegram

> **Status:** stub.

## What you'll learn

The Telegram-specific bits of the channel target: webhook secret-token
auth (Telegram doesn't sign the body), private vs group vs supergroup
session keying, and how to handle the four message kinds Telegram
delivers (text, edited, callback queries, group topics).

## Prerequisites

- [Recipe 03 — Slack Bot](03-slack-bot.md) for the channel-target mental model.
- A Telegram bot from @BotFather + a public HTTPS endpoint.

## Roadmap

1. Setting up the bot: BotFather → token → `setWebhook` with `secret_token=...`.
2. The verification model: `X-Telegram-Bot-Api-Secret-Token` compared timing-safely. Telegram does NOT sign the body — the secret token is the only authentication.
3. The `parseInbound` payload taxonomy: `message`, `edited_message`, `callback_query` (button presses), supergroup with `message_thread_id`.
4. Group/supergroup session keying — `<chatId>:<topicId>` when topics are enabled.
5. `sendReply` POSTs `sendMessage`; `setTyping` POSTs `sendChatAction`.
6. The IR slot: `IrChannels` extended with optional `telegram` block; spec/IR/compiler all grew the second-channel variant.
7. Idempotency: duplicate webhook delivery deduped via `update_id`.
8. Worked examples: a /summarize reply bot, a callback-query button menu bot.

## Run it now

```bash
bun run compile:hello-channel-telegram
bun run smoke:section-33-telegram
```

## Pointers to existing material

- **Example:** [`examples/hello-channel-telegram/crewhaus.yaml`](../../examples/hello-channel-telegram/crewhaus.yaml).
- **Module:** [`packages/channel-adapter-telegram`](../../packages/channel-adapter-telegram).
- **Catalog:** §33.

## Where to go next

- Same shape, different channels: [Recipe 38 — Discord](38-channel-discord.md), [Recipe 39 — WhatsApp](39-channel-whatsapp.md), [Recipe 40 — iMessage](40-channel-imessage.md).
