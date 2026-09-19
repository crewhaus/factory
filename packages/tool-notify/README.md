# @crewhaus/tool-notify

Messaging and notification tools: post to a chat platform, send email over
SMTP, deliver a signed webhook, reach a phone — and, first, decide whether to
send anything at all.

`@crewhaus/tool-message-channel`'s `SendMessage` replies on the harness's own
bound channel: the room it was spoken to in. That is the right primitive for a
conversation, and it is not the one a scheduled job needs when the thing it has
to say belongs in `#ops`, or in an email to the person who owns the broken
service. These tools address a destination an **operator** allow-listed, which
is a different and more dangerous act.

```yaml
tools:
  - all-notify          # every tool below
  - -SmsSend            # ...except this one
```

| Tool | What it does |
|---|---|
| `ChatPost` | Post to Slack, Discord, Teams or a generic webhook, with optional blocks and a thread id |
| `ChatUpdate` | Edit a message already posted, by its id |
| `ChatDelete` | Remove a message already posted |
| `ChatReact` | Add an emoji reaction |
| `EmailSend` | Send over SMTP: EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA |
| `EmailCompose` | Build the RFC 5322 bytes without sending them |
| `EmailSendPreflight` | Check a message the way `EmailSend` would build it, and send nothing |
| `DeliverabilityCheck` | Read a sending domain's SPF, DMARC and named DKIM selectors out of public DNS |
| `WebhookPost` | POST JSON to an allow-listed URL, optionally HMAC-signed, retrying 5xx |
| `SmsSend` | SMS through a REST gateway the operator described |
| `PushNotify` | Push notification through a REST provider the operator described |
| `DeliveryCheck` | Ask a provider what became of a message it accepted |
| `NotifyDigest` | Fold many events into one message |
| `QuietHours` | May this go out now, and if not, when? |
| `RateLimitGate` | Has this key already been notified inside the window? |
| `MessageTemplate` | Render a named template with per-platform escaping |

## Start with the three that stop you sending

The tools worth reaching for first are the ones that send nothing.

`NotifyDigest` is the reason a watcher does not page a channel forty times
about the same broken host. `QuietHours` is the reason an overnight alert waits
until 09:00 when it will read identically. `RateLimitGate` is the reason a loop
does not re-report the same thing on every iteration. All three are pure, take
`now` as an argument, and compose:

```
NotifyDigest → QuietHours → RateLimitGate → MessageTemplate → ChatPost
```

## Safety flags

Every tool that sends is `destructive: true` **and**
`requireJustification: true`. Putting text in front of a person is a side
effect that deleting the message does not undo, because it has already been
read — that is precisely what the intent gate is for, and nothing here opts
out of it. `DeliveryCheck` and `DeliverabilityCheck` are the outbound tools that only
read, so they are `readOnly` and carry no justification. The six pure tools
are `readOnly`, `scope: "internal"`, declare no io capability, and are
concurrency-safe. `src/index.test.ts` asserts all of this per tool, so a
future addition that forgets cannot land quietly.

The two `…Check` names sit uncomfortably close, so: `DeliveryCheck` asks a
PROVIDER what became of one message it accepted. `DeliverabilityCheck` asks
public DNS what a DOMAIN publishes about itself, and knows nothing about any
particular message.

## The outbound posture

`src/net.ts` carries `@crewhaus/tool-http`'s gate over whole rather than
re-deriving it — a second outbound surface with a weaker gate is the same hole
twice. In summary:

- **Empty allow-list denies everything.** Separately for origins, for SMTP
  hosts, and for email recipients. There is no "allow all" value.
- **SSRF refusal is numeric, not textual.** Loopback, link-local (including
  the cloud metadata address), RFC1918, CGNAT, multicast and mDNS are refused
  as an IP literal in any of its encodings — octal, hex, integer, every IPv6
  spelling — and as the DNS-resolved address. An IPv6-shaped string the parser
  cannot classify is refused, never waved through.
- **The vetted IP is pinned** for the connection, so a rebinding resolver
  cannot swap in a private address between the check and the socket. The SMTP
  client pins the same way, and still presents and verifies the hostname.
- **A send never follows a redirect.** Replaying a body at a new origin, or
  downgrading to a GET that delivers nothing, are both worse than stopping.
  Only `DeliveryCheck` follows, re-running the whole gate on every hop.
- **Everything is deadline-bounded and byte-capped,** with the cap bounding
  what is ever held in memory rather than applied after buffering.

## Credentials

No tool accepts a secret. Every credential is the **NAME** of an environment
variable, read at call time:

```yaml
tool_config:
  notify:
    allowed_origins: ["https://hooks.slack.com", "https://slack.com"]
    allowed_recipients: ["ops@example.com", "*@team.example.com"]
    allowed_smtp_hosts: ["smtp.example.com"]
    allowed_sender_domains: ["example.com"]
```

```jsonc
{ "platform": "slack", "webhookUrlEnv": "SLACK_OPS_WEBHOOK", "text": "…" }
```

A Slack incoming-webhook URL (`/services/T…/B…/…`) and a Discord one
(`/api/webhooks/<id>/<token>`) carry their whole authority in the **path**, so
the URL is itself a credential: it is named rather than passed, and no error
message ever prints a webhook path. `WebhookPost` refuses one handed to `url`
inline — where it would be recorded verbatim — and points at `urlEnv`. A value that arrives where a variable name
was expected and looks like a secret is refused **without being echoed back**,
because a tool result is a transcript, a trace and usually an eval report. Every
result — success or failure — passes through a redactor built from the resolved
secret, in its literal, URL-encoded and base64 forms.

## Injection is the thing this package is most careful about

A notification is almost always assembled from data the harness did not write:
a branch name, an error string, a customer's subject line.

- **Chat.** Every value is escaped for its platform before it is sent, so
  `<!channel>`, `@everyone` or a stray code fence can change what a message
  *says* and never what it *does*. Discord is additionally sent
  `allowed_mentions: { parse: [] }`, which is the only reliable way to stop a
  mention in a body from paging a server. A link block whose URL is not
  http(s) is dropped and reported, never rendered.
- **Templates.** `MessageTemplate` escapes the **values** and leaves the
  **template** alone: the operator owns the structure, the run supplies the
  content, and there is no path by which content becomes structure. A missing
  key is an error rather than an empty string, because a notification reading
  `deploy of  failed at ` still gets acted on.
- **Email.** Any header value that is not plain printable ASCII becomes an RFC
  2047 encoded word — which turns a CR or LF into `=0D`/`=0A` inside the word
  — and an address containing either is refused outright. A subject cannot add
  a `Bcc:`. The values that are emitted verbatim and so cannot be encoded — a
  message id in `In-Reply-To` or `References`, an attachment's `Content-ID` —
  are checked against their grammar instead, and the finished header block is
  re-checked for a line break that is not a fold. Blind recipients reach the
  envelope and never a header.
- **SMTP.** SMTP is a line protocol, so a CR or LF inside any command argument
  is not a malformed command but a second one. The EHLO name and the envelope
  addresses are checked before the socket opens, which is what stops a
  smuggled `RCPT TO:` from reaching a recipient the allow-list never saw.

## Email, specifically

`EmailCompose` builds the message; `EmailSend` sends it. Splitting them means
the assembly is testable without a mail server and the bytes can be handed to
another transport.

The composer does RFC 2047 encoded words, header folding that never breaks an
encoded word or an address in half, quoted-printable bodies with correct
trailing-whitespace and soft-break handling, base64 attachments, and
`multipart/alternative` inside `multipart/mixed`. MIME boundaries are derived
from a hash of the message's own content rather than from a random number, so
composing the same message twice gives byte-identical output.

The SMTP client is written out over `node:net` / `node:tls`. **STARTTLS is
required by default**: a server that does not offer it ends the session before
the credential, the envelope or the body is sent. The transcript records
`AUTH PLAIN <redacted>` and the base64 blob is never kept. Attachment size is
checked from the file's own metadata *before* it is read — and counted as the
base64 it will become, not as the bytes on disk — so an oversized attachment
never reaches memory.

## Before the send

`EmailSendPreflight` takes the same arguments as `EmailSend` and runs the
same composer, and sends nothing. It exists because `EmailSend` answers one
refusal at a time, at the moment somebody has already decided to send, and
because some of what is wrong with a message is not a refusal at all: an
empty body composes perfectly and delivers nothing, a `{{placeholder}}` that
never got filled goes out as written, the same mailbox on To and Bcc is one
copy rather than two. The result is a row per check, and the verdict has
three values rather than two — a check that could not run comes back
`unknown`, and a message with an attachment nobody could read is
`incomplete`, which is neither ready nor blocked.

`DeliverabilityCheck` reads what a sending domain publishes: its SPF record,
its DMARC policy, and the DKIM key record at each selector the caller names.
It reports facts rather than a score, because the facts decide different
things — no DMARC record at all and a DMARC record with `p=none` score the
same and are not the same situation, and a lookup that failed is a third
answer again, reported as `unknown` with its reason. There is no way to
enumerate DKIM selectors, so it checks the ones you name and guesses none.

DNS is not an HTTP request and so does not pass through `allowed_origins`,
but the name queried is still chosen by the caller and still leaves the
machine. `allowed_sender_domains` is that surface's allow-list, fail-closed
like the others: empty denies everything. The `_dmarc.` and `._domainkey.`
names are derived from the canonicalised domain after it passes, so there is
no spelling that clears the gate and a different one that reaches the
resolver.

## What is deliberately not here

- **`SendMessage`.** That is `@crewhaus/tool-message-channel`'s, for the
  harness's own bound channel. This package does not duplicate it.
- **A mail queue, retries or bounce handling.** `EmailSend` sends once and
  reports what the server said. A refused recipient comes back named; deciding
  whether to try again is the caller's.
- **CRAM-MD5, XOAUTH2, DSN, pipelining, connection reuse.** PLAIN and LOGIN
  over TLS cover submission to every service that matters; the rest would be
  surface without users.
- **DKIM signature verification.** `DeliverabilityCheck` reads the KEY
  record a selector publishes — its type, its size, whether it has been
  revoked. It does not verify that a message's signature validates: that
  needs relaxed/simple canonicalisation, header selection and body hashing,
  which is `mailauth`'s job and a dependency this package does not take. A
  half-built verifier that can answer "pass" is a security control that
  controls nothing, so there is no partial one here.
- **Walking SPF includes.** `dnsTermsInThisRecord` counts the DNS-querying
  terms in the record it read, and says so. The RFC's limit of ten counts
  the whole evaluation, with its own sub-limits for `a` and `mx` and a
  separate void-lookup cap; a walker that got those wrong would report a
  confident total that is not the receiver's. It would also mean querying
  domains the caller never named.
- **Reading messages.** Nothing here receives; it only sends.
- **Vendor SDKs.** `SmsSend`, `PushNotify` and `DeliveryCheck` speak a provider
  shape the operator writes in `tool_config`. Changing gateway is a config
  diff, not a release.

## Known gaps

Stated rather than papered over:

- **A successful STARTTLS upgrade is not covered by a test.** The refusals
  are: a server offering no STARTTLS, a handshake that cannot complete, and an
  untrusted certificate all end the session with the password unsent and the
  message undelivered. But building a STARTTLS *server* needs an
  already-connected plaintext socket handed to a TLS server, and this
  runtime's `node:tls` shim does not support that — such a test would hang
  rather than assert. See `src/smtp.test.ts`.
- **Implicit TLS (port 465) is untested** for the same reason.
- **The idempotency ledger is per-process.** A retry after a restart will send
  again. The ledger is the second line of defence; the key is also passed to
  the provider, which is the first.
- **`ChatUpdate` does not return the previous text,** because the platform
  does not give it back.
- **`EmailSendPreflight` does not fold provider-specific aliases.** Two
  recipients count as duplicates on their exact spelling, case aside. Gmail
  treats `a.b@` and `ab@` as one mailbox and strips `+tags`; most providers
  do neither, so folding them here would report two separate people as one
  on every domain that keeps them apart. Which domains fold is configuration
  this package does not carry. Two spellings of one mailbox that differ only
  in case are reported as a **warning that they will each get their own
  `RCPT TO`** — `composeMessage` builds its envelope from the exact
  addresses, so that is what the send does, and the preflight reports the
  composer's count rather than its own comparison key's.
- **`DeliverabilityCheck` does not walk up to the organizational domain.**
  RFC 7489 6.6.3 has a receiver that finds no `_dmarc` record fall back to
  the organizational domain's, so a subdomain with nothing of its own can
  still be covered. Naming that domain needs the Public Suffix List —
  `example.co.uk` is an organizational domain and `mail.example.com` is not,
  and nothing in the name says which — which is a dependency this package
  does not take. So a domain with more than two labels and no record of its
  own gets a note saying which lookup was not made, and the answer stops at
  the name that was asked.

## Layout

`src/lib/` holds the pure functions — escaping and block rendering, templates,
digests, quiet hours, rate limiting, MIME, the preflight rules and the SPF,
DMARC and DKIM record parsers — and is where the behaviour is tested. `src/net.ts` is the outbound gate, `src/paths.ts` the path gate,
`src/smtp.ts` the SMTP client, and `src/index.ts` wraps all of it as tools. A
bug in quoted-printable encoding reads better as a failing unit than as a
failing tool call.
