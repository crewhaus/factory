# Recipe 03 — Slack Bot

> **Status:** stub.

## What you'll learn

Stand up a long-running daemon that receives Slack `app_mention` and
`message` events, threads sessions per Slack thread, and replies via
the streaming chat loop. Same recipe pattern works for Telegram,
Discord, WhatsApp, and iMessage — see the channel-specific recipes
linked at the bottom.

## Prerequisites

- A Slack workspace where you can create an app.
- A public HTTPS endpoint (use ngrok / cloudflared in dev).
- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md).

## Roadmap

1. Creating a Slack app: Bot Token + Signing Secret + Event Subscriptions URL.
2. The `target: channel` spec shape — `channels.slack.botToken` / `signingSecret` as `$VAR_NAME` references.
3. `routing.sessionKey: thread` vs `user` vs `channel` — what the deterministic session id buys you.
4. The generated bundle: `daemon.ts`, `gateway.ts`, `session-router.ts`, `agent.ts`. Read each.
5. HMAC-SHA256 signature verification, ±5 min timestamp tolerance, replay defense.
6. Idempotency via Slack `event_id` — duplicate webhook deliveries collapse.
7. The `SendMessage` tool (opt-in) for proactive posts initiated by the model.
8. Local development with ngrok; production behind a reverse proxy.
9. Permission rules for tools the model can use to ground replies (`Read`, `Bash`).

## Run it now

```bash
# Smoke test (no real Slack workspace required — synthetic webhooks):
bun run smoke:section-12

# Live (set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in .env first):
bun run compile:hello-channel
bun run run:hello-channel
```

## Pointers to existing material

- **Example:** [`examples/hello-channel/crewhaus.yaml`](../../examples/hello-channel/crewhaus.yaml).
- **Codegen:** [`packages/target-channel-bot`](../../packages/target-channel-bot) — multi-file emitter.
- **Adapter:** [`packages/channel-adapter-slack`](../../packages/channel-adapter-slack).
- **Catalog:** §12 (channel target + Slack), §33 (Telegram/Discord/WhatsApp/iMessage).

## Where to go next

- Same shape, different channel: [Recipe 37 — Telegram](37-channel-telegram.md), [Recipe 38 — Discord](38-channel-discord.md), [Recipe 39 — WhatsApp](39-channel-whatsapp.md), [Recipe 40 — iMessage](40-channel-imessage.md).
- For multiple specialist agents collaborating on a request → [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md).
- For production deployment of the daemon → [Recipe 24 — Docker and Helm](24-docker-and-helm.md).
