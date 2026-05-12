---
test:
  spec: examples/hello-channel-telegram/crewhaus.yaml
  bun_scripts:
    - compile:hello-channel-telegram
    - smoke:section-33-telegram
---

# Recipe 37 — Channel: Telegram

The Telegram-specific bits of the channel target: webhook secret-token
authentication (Telegram doesn't sign the body), private vs group vs
supergroup session keying, and how to handle the four message kinds
Telegram delivers (text, edited, callback queries, supergroup topics).

For the channel-target mental model — `Bun.serve` + adapter dispatch +
session keying + per-message `runChatLoop` — read [Recipe 03 — Slack Bot](03-slack-bot.md)
first. This recipe covers only what's different on Telegram.

## Prerequisites

- [Recipe 03 — Slack Bot](03-slack-bot.md) for the channel mental model.
- A Telegram bot from [@BotFather](https://t.me/BotFather) +
  a public HTTPS endpoint (ngrok, cloudflared, etc.).

## Step 1 — Create the bot

1. Open Telegram, chat with `@BotFather`.
2. `/newbot` → pick a name and `@your_bot_username`.
3. BotFather replies with a bot token: `123456:AAH...`.
4. Generate a random secret token: `openssl rand -hex 32`.

Save both into `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:AAH...
TELEGRAM_SECRET_TOKEN=<your hex>
```

## Step 2 — The spec

The bundled example
[`examples/hello-channel-telegram/crewhaus.yaml`](../../examples/hello-channel-telegram/crewhaus.yaml):

```yaml
name: hello-channel-telegram
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a Telegram bot. When mentioned in a chat or DM'd, reply
    concisely (1-2 sentences). You may use the Read filesystem tool to
    ground answers in repo state.
  tools:
    - read
channels:
  telegram:
    botToken: $TELEGRAM_BOT_TOKEN
    secretToken: $TELEGRAM_SECRET_TOKEN
routing:
  sessionKey: thread
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
```

Two fields specific to Telegram:

- **`botToken: $TELEGRAM_BOT_TOKEN`** — used to call `sendMessage`,
  `sendChatAction`, etc.
- **`secretToken: $TELEGRAM_SECRET_TOKEN`** — passed to Telegram via
  `setWebhook` and echoed back in `X-Telegram-Bot-Api-Secret-Token`.

## Step 3 — Authentication

Telegram does **not sign request bodies** (unlike Slack's HMAC). The
only authentication is the secret token in a header:

```http
POST /telegram/events HTTP/1.1
Host: bot.example.com
Content-Type: application/json
X-Telegram-Bot-Api-Secret-Token: <your hex>

{ "update_id": 123, "message": { ... } }
```

The runtime compares `X-Telegram-Bot-Api-Secret-Token` to the spec's
`secretToken` using `crypto.timingSafeEqual` to avoid timing attacks.

**Security implications:**

1. Anyone who learns the secret token can submit valid-looking
   webhooks. Treat the secret like any other API key.
2. There's no body signing — a network attacker who can MITM the
   plaintext webhook can substitute payloads. Use HTTPS-only.
3. Rotation: change the spec, redeploy, then call `setWebhook` again
   with the new secret. There's no graceful overlap.

## Step 4 — Compile and register the webhook

```bash
bun run compile:hello-channel-telegram
bun examples/hello-channel-telegram/dist/daemon.ts
```

Point ngrok at the daemon's port:

```bash
ngrok http 3000
```

Then tell Telegram about it:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<your-tunnel>/telegram/events" \
  -d "secret_token=$TELEGRAM_SECRET_TOKEN" \
  -d "allowed_updates=[\"message\", \"edited_message\", \"callback_query\"]"
```

The `allowed_updates` filter is per-bot. Limit to what you actually
handle — otherwise Telegram sends every `channel_post`, `my_chat_member`,
etc., wasting webhook capacity.

## Inbound message kinds

`parseInbound` handles four payload shapes:

| Kind                | Trigger                                            | Routing context                           |
| ------------------- | -------------------------------------------------- | ----------------------------------------- |
| `message`           | New text message in a chat.                         | `chat.id`, optional `message_thread_id`.  |
| `edited_message`    | User edited a prior message.                        | Same as `message`.                         |
| `callback_query`    | User pressed an inline-keyboard button.             | `chat.id` + `data` (the button's payload). |
| Supergroup w/ topic | Message inside a supergroup forum topic.            | `chat.id` + `message_thread_id`.           |

For `edited_message`, the runtime treats the edit as a **new turn**
— the session resumes from the prior assistant message, then the
user's edited message becomes the next user input. So edits aren't
ignored.

For `callback_query`, the inline button's `data` field is the user
message. The bot can reply via `sendMessage` and also call
`answerCallbackQuery` to dismiss the loading spinner Telegram shows
on the button.

## Session keying

`routing.sessionKey: thread` is the default. Concretely:

| Chat type         | Session key derived from                                   |
| ----------------- | ---------------------------------------------------------- |
| Private (1-on-1)   | `chatId` (= userId).                                       |
| Group              | `chatId`.                                                  |
| Supergroup, no topic | `chatId`.                                                |
| Supergroup w/ topic | `chatId:messageThreadId` — one session per topic.          |

So a supergroup with three topics keeps three separate conversations.
That's usually what you want — each topic has its own context.

Alternatives:

- `routing.sessionKey: user` — `fromId`. One session per user,
  shared across chats. Useful for "personal assistant" bots.
- `routing.sessionKey: channel` — `chatId` only. One session per chat,
  ignoring topics. Rarely useful for supergroups.

## Idempotency

Telegram retries delivery if the webhook doesn't respond `200 OK`
within ~10 seconds. The runtime dedups by `update_id`:

```typescript
gateway.dedupKey = update.update_id;
```

A retry of the same `update_id` is a no-op (logs and returns `200`).
First time through, the daemon processes normally.

The dedup cache size is 10,000 entries (LRU). That's enough for
~24h of traffic at 0.1 updates/s — well above what Telegram delivers
in practice.

## Sending replies

`channel-adapter-telegram.sendReply({ event, text })`:

```http
POST https://api.telegram.org/bot<TOKEN>/sendMessage HTTP/1.1
Content-Type: application/json

{
  "chat_id": <chatId>,
  "message_thread_id": <topicId or omitted>,
  "text": "Your reply.",
  "reply_to_message_id": <inbound message id or omitted>,
  "parse_mode": "MarkdownV2"
}
```

Markdown V2 is the default — it lets the agent use **bold**, *italic*,
inline `code`, [links](https://example.com), etc. Telegram's V2
escaping is strict; the adapter handles escaping internally.

For typing indicators ("the bot is typing..."), call `sendChatAction`:

```typescript
await adapter.setTyping({ chatId, typing: true });
// the model thinks...
await adapter.sendReply({ event, text: "..." });
```

The typing indicator auto-expires after 5 seconds, so for long model
calls you'd send `setTyping` periodically (every 4 seconds).

## Worked examples

### `/summarize` reply bot

```yaml
agent:
  instructions: |
    You're a Telegram bot. When the user types /summarize <URL>, fetch
    the URL and reply with a 3-sentence summary. Otherwise, refuse and
    explain you only handle /summarize.
  tools:
    - webFetch
```

### Button menu bot

```yaml
agent:
  instructions: |
    On the first message, reply with an inline keyboard:
      [✅ Yes]  [❌ No]
    On a callback_query whose data is "Yes" or "No", reply with the
    corresponding choice acknowledgment.
  tools:
    - sendInlineKeyboard
```

`sendInlineKeyboard` is a Telegram-adapter-specific tool that wraps
the `reply_markup` field on `sendMessage`.

## IR slot

The compiler grew an `IrChannels` slot when Telegram was added.
Today `IrChannels` covers all five adapters as a discriminated union;
new channel adapters extend it. See [packages/ir](../../packages/ir)
for the type.

## Smoke

```bash
bun run smoke:section-33-telegram
```

Validates:

1. `setWebhook`-style synthetic payload signed with the test secret.
2. `parseInbound` correctly extracts chat/user/message fields.
3. `sendReply` POSTs to the right URL.
4. Idempotent retry of the same `update_id`.

The smoke doesn't talk to real Telegram; it uses a scripted adapter
to validate the wiring.

## What to read next

- **Same shape, different channel.** [Recipe 38 — Discord](38-channel-discord.md),
  [Recipe 39 — WhatsApp](39-channel-whatsapp.md),
  [Recipe 40 — iMessage](40-channel-imessage.md).
- **The channel-target mental model.** [Recipe 03 — Slack Bot](03-slack-bot.md).
- **Inbound message classification.** [Recipe 41 — Security Fabric](41-security-fabric.md)
  — channel text is classified before reaching the model.

## Pointers to source

- **Example:** [`examples/hello-channel-telegram/crewhaus.yaml`](../../examples/hello-channel-telegram/crewhaus.yaml).
- **Adapter:** [`packages/channel-adapter-telegram`](../../packages/channel-adapter-telegram).
- **Spec schema (telegram block):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts).
- **Module catalog reference:** §33 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
