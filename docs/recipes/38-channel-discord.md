# Recipe 38 — Channel: Discord

> **Status:** stub.

## What you'll learn

The Discord-specific bits of the channel target: Ed25519 signature
verification of the `<timestamp><body>` payload, the four interaction
types Discord delivers (PING, slash command, component click, modal
submit), and thread-vs-channel session keying via `parent_id`.

## Prerequisites

- [Recipe 03 — Slack Bot](03-slack-bot.md) for the channel-target mental model.
- A Discord application (Developer Portal) with an interactions endpoint.

## Roadmap

1. Setting up the app: Developer Portal → application → public key (`publicKeyHex`).
2. Ed25519 verification: `crypto.verify` with no SDK dependency. `generateEd25519Keypair` + `signDiscordBody` exposed for test fixtures.
3. The four interaction types:
   - Type 1 — PING. Reply `{type: 1}` PONG body.
   - Type 2 — slash command. Rendered as `/<name> <opt1=val1> ...`.
   - Type 3 — component click. Rendered as `[component:<custom_id>]`.
   - Type 5 — modal submit. Rendered as `<custom_id>: <field>=<value> ...`.
4. Thread session keying: when `interaction.channel.parent_id` is set, the channel is a thread; populate `threadTs`.
5. `sendReply` POSTs `/channels/{channelId}/messages` (REST follow-up; works any time after the deferred response).
6. `setTyping` POSTs `/channels/{channelId}/typing`.
7. Side-by-side with Slack/Telegram: gateway dispatches by `/<adapter>/events` path prefix.
8. Worked examples: slash-command-to-agent bot, modal form for structured input.

## Run it now

```bash
bun run compile:hello-channel-discord
bun run smoke:section-33-discord
```

## Pointers to existing material

- **Example:** [`examples/hello-channel-discord/crewhaus.yaml`](../../examples/hello-channel-discord/crewhaus.yaml).
- **Module:** [`packages/channel-adapter-discord`](../../packages/channel-adapter-discord).
- **Catalog:** §33.

## Where to go next

- Same shape, different channels: [Recipe 37 — Telegram](37-channel-telegram.md), [Recipe 39 — WhatsApp](39-channel-whatsapp.md), [Recipe 40 — iMessage](40-channel-imessage.md).
