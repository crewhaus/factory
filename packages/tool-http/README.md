# @crewhaus/tool-http

HTTP and network work that should not cost a model turn.

`@crewhaus/tool-fetch` gives an agent one request. That is the right
primitive, and it is also why a seven-page API costs seven model turns, a
webhook signature costs a code-execution round trip, and "wait until the
deploy is healthy" becomes a sleep-and-hope loop. Each tool here collapses one
of those patterns into a single call with a stated bound.

```yaml
tools:
  - all-http          # every tool below
  - -downloadFile     # ...except this one

tool_config:
  http:
    allowed_origins:  # REQUIRED — an empty list denies everything
      - https://api.example.com
      - https://api.github.com
```

| Tool | What it does |
|---|---|
| `HttpRequest` | One request with method, headers, body, env-resolved auth, redirect policy, retry-on-status and a deadline |
| `HttpPaginate` | Walk a paginated API to the end, a page cap or a total-byte budget — Link header, cursor field or page number — and return the items |
| `GraphqlQuery` | POST a query with variables, returning `data` and `errors` separately |
| `HttpBatch` | Several independent requests with a concurrency cap and a deadline for the batch, results in request order |
| `DownloadFile` | Fetch to a contained path under a byte cap, with an optional sha256 verified before the file is kept |
| `HeadRequest` | Existence, size, content type and caching headers without the body |
| `HttpWaitFor` | Poll until a status or a JSON field predicate holds, within a required deadline |
| `UrlReachable` | A bounded connectivity probe: status and latency |
| `LinkCheck` | Check a list of URLs with a concurrency cap and a shared deadline |
| `SseRead` | Collect server-sent events until a count, a terminator event, or a required deadline |
| `WebhookSign` | HMAC signature header in the timestamped or plain-body scheme |
| `WebhookVerify` | Constant-time verification that rejects a stale timestamp as a replay |
| `DnsLookup` | A / AAAA / CNAME / MX / TXT / NS records for a name |
| `TlsInspect` | Certificate chain for a host and port — subject, issuer, validity, days remaining, SANs |
| `RobotsCheck` | Fetch and evaluate `robots.txt` for a user-agent and path |
| `SitemapParse` | A sitemap into structured entries, from text or an allow-listed URL |
| `FeedParse` | An RSS, RDF or Atom feed into a common entry shape |

## The gate

Every outbound byte leaves through `src/net.ts`, which carries
`@crewhaus/tool-fetch`'s posture over whole rather than re-deriving it. A
second HTTP surface with a weaker gate would be the same hole twice.

1. **Empty allow-list denies everything.** There is no "allow all" value.
2. Scheme must be `http` or `https`.
3. Origin must match an allow-list entry exactly after canonicalisation
   (lowercase host, default port elided).
4. **SSRF**: loopback, link-local (including the cloud metadata address),
   RFC1918, CGNAT, multicast, reserved and mDNS targets are refused *even when
   allow-listed* — as an IP literal in any encoding and as the DNS-resolved
   address. Addresses are classified numerically, never by string prefix, so
   every spelling of one address gets one answer: `0177.0.0.1`, `0x7f000001`
   and `2130706433` for IPv4; `::1`, `0:0:0:0:0:0:0:1` and `::0:1` for IPv6;
   and the ranges that CARRY an IPv4 address — `::ffff:a.b.c.d`, NAT64
   (`64:ff9b::a9fe:a9fe`) and 6to4 (`2002:a9fe:a9fe::`) — by the address they
   carry. An IPv6-shaped host this parser cannot expand is refused rather than
   assumed public.
5. The vetted IP is **pinned** for the connection, with the real hostname kept
   for `Host` and TLS SNI, so a rebinding resolver cannot swap in a private
   address between the check and the socket.
6. Redirects are followed by hand, capped, and re-checked against 3–5 at every
   hop. A 301/302/303 answer to a non-GET becomes a GET with the body dropped,
   so a request payload is never replayed at a hop nobody asked for.
7. `Authorization`, `Proxy-Authorization`, `Cookie` **and whatever header the
   call's `auth` profile set** are **dropped the moment a redirect leaves the
   origin they were minted for**, and the result reports `credentialsDropped`.
   A URL carrying `user:pass@` is refused outright — at the first hop and at
   every redirect — because userinfo is a credential that would otherwise ride
   in `finalUrl` and `redirects` straight into a transcript.
8. Every request has a deadline and every body a byte cap. The polling and
   streaming tools *require* the deadline rather than defaulting it,
   `HttpBatch` bounds the batch as well as each request, and `HttpPaginate`
   bounds the bytes across all pages as well as within one — a per-page cap is
   not a bound on a tool that holds every page's items at once.
9. `Cookie`, `Set-Cookie` and `Authorization` are stripped from response
   headers before anything reaches a model.

## Secrets

No tool accepts an inline credential. An `auth` profile names an environment
**variable**:

```json
{ "type": "bearer", "envVar": "GITHUB_TOKEN" }
```

and an inline `Authorization` or `Cookie` header is refused with a message
pointing at `auth`, as is a URL with `user:pass@` in it. A token a model can
put in a tool argument is a token in the transcript, the trace event and the
eval report.

Echoed request headers come back as `<redacted>` — including the one a
`{ "type": "header", "headerName": "X-Api-Key" }` profile set, which is just as
much a secret as an `Authorization` value and is guarded as one everywhere:
in the echo, and on a cross-origin redirect.

An error message names a URL by scheme, host, port and path only. The query
string is where a presigned link keeps its signature, and an error string is a
thing that ends up in a transcript.

## Determinism

Same inputs against the same world state, same bytes out: listings are sorted,
comparisons use code-unit order (never `localeCompare` without a locale),
nothing is random — the retry backoff has **no jitter** for exactly this
reason — and the wall clock appears only where the caller asked for timing:
`HttpRequest.elapsedMs`, `UrlReachable.latencyMs`, `HttpWaitFor.elapsedMs`,
and `TlsInspect`'s `daysRemaining`. Each of those is flagged in its own
description. `WebhookSign` refuses to default a timestamp to "now" so the same
call always produces the same signature.

Feed entries are the one listing that is *not* re-sorted: a feed's order is
the signal it carries, and document order is deterministic anyway.

## Layout

`src/lib/` holds the pure functions and is where their behaviour is tested
without a socket — XML, sitemaps, feeds, `Link` headers, SSE framing,
robots.txt matching, HMAC signatures, JSON path reading, backoff arithmetic
and certificate shaping. `src/net.ts` is the gate. `src/index.ts` wraps them
as tools. `src/paths.ts` is the workspace-containment check, copied from
`@crewhaus/tool-fsx`, that `DownloadFile` passes every caller-supplied path
through.

The tests use real servers: `Bun.serve({ port: 0 })` on 127.0.0.1, never a
public address, never a mocked `fetch`. A stubbed transport would prove
nothing about whether a redirect chain really drops a credential or whether a
byte cap really cancels a stream.

## Safety flags

| | Tools |
|---|---|
| `scope: "external"`, `ioCapability: "network"` | everything except `WebhookSign` and `WebhookVerify` |
| `destructive: true` | `HttpRequest`, `HttpBatch`, `GraphqlQuery` (any of them can mutate a remote resource), `DownloadFile` (writes a file) |
| `requireJustification: true` | `HttpRequest`, `HttpBatch`, `GraphqlQuery` — the three with a visible outward side effect |
| `readOnly: true` | the other thirteen |

`src/index.test.ts` asserts the whole table tool by tool and runs
`auditToolScopes` over the package, so a future tool that forgets an
annotation fails the suite rather than shipping.

## What is deliberately not here

- **A cookie jar.** Nothing persists between calls; a session cookie must be
  passed explicitly each time, through a `header`-type auth profile.
- **WebSockets.** `SseRead` covers one-way streaming; a bidirectional session
  does not fit a single bounded tool call.
- **Following a sitemap index.** `SitemapParse` reads one document; parse each
  child yourself so the page cap stays visible.
- **Crawling.** `RobotsCheck` tells you whether you may fetch a path and what
  `Crawl-delay` the site asked for; it does not pace anything for you, and
  `LinkCheck` does not discover links.
- **Date normalisation in feeds.** Dates come back exactly as the feed wrote
  them, RFC 822 or RFC 3339; guessing a timezone this parser cannot verify
  would be worse than handing the string to `@crewhaus/tool-datetime`.
- **Retries with jitter, or any unseeded randomness.** Stagger concurrent
  agents where the seed is visible.
