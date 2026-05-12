---
test:
  spec: examples/hello-channel-whatsapp/crewhaus.yaml
  bun_scripts:
    - compile:hello-channel-whatsapp
    - smoke:section-33-whatsapp
---

# Recipe 39 — Channel: WhatsApp

The WhatsApp-specific bits of the channel target: HMAC-SHA256
verification per Meta's `X-Hub-Signature-256` spec, the message-type
taxonomy (text, interactive button/list, image with caption), per-user
session keying via `wa_id`, and dedup against Meta's aggressive retry
storm.

For the channel-target mental model, read [Recipe 03 — Slack Bot](03-slack-bot.md)
first. This recipe covers only what's different for WhatsApp.

## Prerequisites

- [Recipe 03 — Slack Bot](03-slack-bot.md) for the channel mental model.
- A Meta Business account.
- A **WhatsApp Business Cloud API** phone number provisioned.
- The application's **app secret**.
- A long-lived **Bearer token** with `whatsapp_business_messaging`
  scope.

## Step 1 — Set up the integration

In Meta Business → WhatsApp Business → API setup:

1. Note the **Phone Number ID** (numeric, displayed on the API setup page).
2. Note the **App Secret** (App Settings → Basic → App Secret).
3. Generate a **Permanent Access Token** for the system user. Save
   as `$WHATSAPP_ACCESS_TOKEN`.

```bash
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_APP_SECRET=...
```

## Step 2 — The spec

[`examples/hello-channel-whatsapp/crewhaus.yaml`](../../examples/hello-channel-whatsapp/crewhaus.yaml):

```yaml
name: hello-channel-whatsapp
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a WhatsApp Business bot. When a customer messages, reply
    concisely (1-3 sentences). You may use the Read filesystem tool
    to ground answers in repo state.
  tools:
    - read
channels:
  whatsapp:
    phoneNumberId: $WHATSAPP_PHONE_NUMBER_ID
    accessToken: $WHATSAPP_ACCESS_TOKEN
    appSecret: $WHATSAPP_APP_SECRET
routing:
  sessionKey: user
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
```

Three fields, all required:

| Field            | Used for                                                   |
| ---------------- | ---------------------------------------------------------- |
| `phoneNumberId`  | Building send-message URLs.                                  |
| `accessToken`    | Bearer auth on outbound API calls.                          |
| `appSecret`      | HMAC verification of inbound webhooks.                       |

## Step 3 — Verification

Meta signs every webhook body with HMAC-SHA256, using the **app secret**:

```http
POST /whatsapp/events HTTP/1.1
X-Hub-Signature-256: sha256=<hex>
Content-Type: application/json

{ "object": "whatsapp_business_account", "entry": [...] }
```

The runtime:

1. Reads the raw body bytes (not parsed JSON — Meta signs the
   pre-parsed bytes).
2. Computes `HMAC-SHA256(body, appSecret)` and compares hex strings
   timing-safely.
3. Rejects with 401 on mismatch.

The signature is over **the raw body**, including all whitespace
and JSON formatting. Any middleware that re-serializes the body
breaks verification — read the body as a stream, hash, then parse.

## Step 4 — Compile and subscribe

```bash
bun run compile:hello-channel-whatsapp
bun examples/hello-channel-whatsapp/dist/daemon.ts
```

Tunnel to a public URL:

```bash
ngrok http 3000
```

In Meta Business → Webhook configuration → enter
`https://<your-tunnel>/whatsapp/events` and the verify token (Meta
sends a one-time GET to confirm). Subscribe to the `messages` field.

## Inbound message types

The `parseInbound` handler covers:

| Type            | Rendered as user message               | Notes                                          |
| --------------- | -------------------------------------- | ---------------------------------------------- |
| `text`          | `<body>` verbatim                       | Most common.                                   |
| `interactive` → `button_reply` | `[button:<id>] <title>`        | User pressed an inline button.                  |
| `interactive` → `list_reply`   | `[list:<id>] <title>`           | User chose a list option.                       |
| `image` w/ caption | `[image] <caption>`                  | The image bytes are not fetched.               |
| `image` w/o caption | (skipped)                            | Nothing to reply to.                            |
| `audio` / `sticker` / `video` | (skipped)                          | No transcription / OCR built in today.          |
| `status` events  | (skipped)                              | Delivery / read receipts. Logged only.         |

Skipped messages are logged but don't trigger `runChatLoop`. If you
want to handle them, customize the adapter.

## Per-user session keying

`routing.sessionKey: user`. Concretely: each contact's `wa_id` (their
WhatsApp number) becomes the session id:

```
sess_<sha256("wa:" + wa_id)[:16]>
```

So a customer messaging the business has one persistent conversation
across days/weeks. The bot picks up where it left off automatically.

`sessionKey: channel` is rarely useful for WhatsApp — there's no
"channel" concept distinct from the user.

## Sending replies

```http
POST https://graph.facebook.com/v22.0/<phoneNumberId>/messages
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<wa_id>",
  "type": "text",
  "text": { "body": "Your reply." }
}
```

The adapter wraps this. For interactive replies (buttons, lists),
use the matching payload type — the adapter exposes
`sendInteractive({...})` for richer messages.

## Typing indicator

WhatsApp Business has **no public typing API**. The bundled
`setTyping` is a no-op. For long model calls, send a short
acknowledgment message ("One moment...") and then the real reply.

## Idempotency

Meta retries webhooks aggressively — multiple deliveries per message
are common, especially if the daemon takes longer than ~3 seconds
to respond.

The adapter dedupes by `messages[].id`:

```typescript
gateway.dedupKey = update.entry[0].changes[0].value.messages[0].id;
```

Each message has a globally-unique `wamid.XXX` id. The dedup cache
is 10,000 entries — adequate for ~24h at typical volumes.

## The 24-hour customer service window

WhatsApp imposes a **24-hour rule**:

- Within 24 hours of a customer's last message, you can reply freely.
- Past 24 hours, you can only send **template messages** (pre-approved
  by Meta).

For bots, this is rarely a constraint — bot replies are immediate.
But for **proactive sends** (a scheduled summary at end-of-day),
you need an approved template:

```typescript
await sendTemplate({
  to: "<wa_id>",
  template: { name: "daily_summary", language: { code: "en_US" } }
});
```

The template approval process takes 1-3 days. Set this up well
before launch.

## Operational considerations

- **Phone number cost.** A WhatsApp Business phone number costs
  ~$0.005-$0.06 per session, depending on country. Free for the
  bot itself; you pay per delivery.
- **Verification status.** New numbers are "green-tier" (default
  rate limits). Sustained healthy traffic earns "blue-tier" with
  higher quotas.
- **Quality rating.** Meta tracks how often users block your number.
  Excessive blocks drop your quality rating; persistently low quality
  loses the number entirely. The bot's defaults (concise replies,
  don't message proactively without template) keep quality high.

## Worked example: customer support triage

```yaml
agent:
  instructions: |
    You're a customer support triage bot. When a customer messages:
    1. Read their message.
    2. Categorize: ORDER, BILLING, TECHNICAL, OTHER.
    3. If ORDER: ask for their order number.
    4. If BILLING: hand off to a human via the SendMessage tool to
       channel "billing-team".
    5. If TECHNICAL: try to answer if it's in our FAQ; otherwise
       say "Let me get a human" and escalate.
    6. If OTHER: politely ask for more detail.
    Always be brief — max 2-3 sentences per reply.
```

This pattern works well in WhatsApp because of the per-user session
keying — the bot remembers what the customer said earlier in the
day without you managing state explicitly.

## Smoke

```bash
bun run smoke:section-33-whatsapp
```

Validates:

1. HMAC verification (positive + negative).
2. Text / interactive / image-with-caption parsing.
3. Skipped types don't trigger `runChatLoop`.
4. Dedup by `messages[].id`.

## What to read next

- **Same shape, different channels.** [Recipe 37 — Telegram](37-channel-telegram.md),
  [Recipe 38 — Discord](38-channel-discord.md),
  [Recipe 40 — iMessage](40-channel-imessage.md).
- **Channel-target mental model.** [Recipe 03 — Slack Bot](03-slack-bot.md).

## Pointers to source

- **Example:** [`examples/hello-channel-whatsapp/crewhaus.yaml`](../../examples/hello-channel-whatsapp/crewhaus.yaml).
- **Adapter:** [`packages/channel-adapter-whatsapp`](../../packages/channel-adapter-whatsapp).
- **Spec schema (whatsapp block):** [`packages/spec/src/index.ts`](../../packages/spec/src/index.ts).
- **Module catalog reference:** §33 in [MODULE-CATALOG.md](../MODULE-CATALOG.md).
