# hello-channel — channel-bot vertical slice (Section 12)

The smallest possible end-to-end demonstration of the `target: channel`
shape: a 20-line spec → a compiled long-running daemon that listens for
inbound Slack webhooks, resumes per-thread sessions, runs one model turn
per inbound message, and replies in-thread.

## Run it

From the repo root:

```bash
bun install
bun run compile:hello-channel                       # writes dist/{daemon,gateway,session-router,agent}.ts

# Real Slack workspace mode — set both creds in .env first.
SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... \
  ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun run run:hello-channel

# The daemon listens on PORT (default 3000). Point your Slack app's
# Event Subscription Request URL at https://<public-host>/slack/events
# (use ngrok or similar for local dev).
```

For an offline smoke test (no real Slack workspace required, but uses
the live Anthropic API):

```bash
bun run smoke:section-12
```

## What this slice exercises

Catalog modules touched (per `docs/MODULE-CATALOG.md`):
- F1 `spec-schema`, `spec-parser`, `spec-validator`, `ir-model` (channel target + IrSecretRef)
- F2 `compiler-core`, **`target-channel-bot`** (multi-file codegen — first target with >1 emitted file), `codegen-templates`
- R1 `runtime-orchestrator` — `runChatLoop({ singleTurn: true, resume })` (lifted from REPL-only in Section 12)
- R4 `tool-fs` (`Read`), `tool-bash` (`Bash`, ask-gated), **`tool-message-channel`** (`SendMessage`, opt-in)
- R7 `session-store`, `event-log` — per-thread session resumption keyed on `sha256(slack:<workspace>:<channel>:<thread_ts>)`
- R8 `permission-engine` — Read auto-allowed, Bash ask-gated, SendMessage fail-closed
- R9 `hooks-engine` — channel-bot daemons load `.crewhaus/settings.json` hooks (e.g. for approval flows)
- **R13** `channel-adapter-base`, **`channel-slack`** — HMAC verify, `event_callback` parse, `chat.postMessage` reply

## Routing

The example uses `sessionKey: thread` — every Slack thread gets its own
persistent session under `.crewhaus/sessions/`. Replying in the same
thread continues the same agent conversation; starting a new thread or
mention in the channel root creates a fresh session.

Other strategies (`user`, `channel`) are valid but pool more conversations
into one session — useful for global memory but lose thread isolation.
