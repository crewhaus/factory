# @crewhaus/tool-objectstore

A door key for one object, instead of the keys to the building.

| Tool | Answers |
|---|---|
| `ObjectPresign` | what URL lets someone download or upload this one object, for this long |

`ObjectPresign` mints a time-limited SigV4 URL for an S3-compatible store —
AWS S3, Cloudflare R2, MinIO, anything that verifies SigV4. Whoever holds the
URL can do one thing to one object until it expires. They get no credential,
and the bytes never pass through the harness.

## It computes; it does not connect

The whole package is HMAC-SHA256 from `node:crypto` over strings. No SDK, no
socket, no file read, no state between calls except an injectable clock. It
works offline, and the same inputs always produce the same URL.

That claim is not left to the reader. The test suite greps this package's own
source for `node:http`, `node:net`, `node:fs`, a `fetch` call and the rest, so
an edit that adds one fails a test rather than a review.

It holds no credential either. The access key and secret arrive as arguments
from whatever the caller uses for secrets, the secret is consumed by the
signing-key derivation, and it appears in no result, no error and no stack
trace — asserted on both the success and the failure path. The access key ID
*is* in the URL: SigV4 puts it in `X-Amz-Credential` by construction, which is
how the store knows which key to check against. That one is public by design.

## Three things that fail hours later

Every trap in this package has the same shape: the URL comes back looking
perfect and the failure arrives later, from somewhere else, as a 403 that
explains nothing.

### 1. `encodeURIComponent` is the wrong encoder

SigV4 percent-encodes everything outside `A-Z a-z 0-9 - _ . ~`.
`encodeURIComponent` leaves five of those alone:

| Key contains | `encodeURIComponent` | SigV4 |
|---|---|---|
| `!` `'` `(` `)` `*` | unchanged | `%21` `%27` `%28` `%29` `%2A` |
| a space | `%20` | `%20` |
| `+` | `%2B` | `%2B` |
| `é` | `%C3%A9` | `%C3%A9` |

So `q&a (2026)/notes!.txt` signs one way and is requested another. The encoder
here is hand-written for that reason, and it is tested against keys with
spaces, pluses, the five stragglers, three-byte characters and a surrogate
pair.

Two more rules live in the same place. The object key is encoded **once** and
its `/` separators are left alone (every non-S3 AWS service double-encodes its
canonical URI — the option exists, it is just not what S3 wants). And the
query string is encoded and **then** sorted, in that order: encoding moves
characters around the ASCII table, so `a-b` and `a?b` come out in the opposite
order from the one a sort-then-encode would produce.

### 2. A pinned `content-type` is a promise the caller has to keep

Passing `contentType` to a PUT puts `content-type` into `SignedHeaders`. The
eventual upload must send that header with that exact value; an HTTP client
that appends `; charset=utf-8` is sending different signed bytes, and the
store answers 403 without mentioning headers.

So the result carries the exact headers alongside the URL, plus a sentence
saying to send them verbatim, plus a `curl` line that already does:

```json
{
  "url": "https://…?X-Amz-SignedHeaders=content-type%3Bhost&X-Amz-Signature=…",
  "headers": { "content-type": "application/pdf" },
  "sendHeadersVerbatim": "send every header above exactly as written — …",
  "signedHeaders": ["content-type", "host"]
}
```

`x-amz-meta-*` works the same way, so `metadata` comes back in `headers` too.
A GET is the opposite case: `responseContentType` and
`responseContentDisposition` are signed into the **query**, so they are
already in the URL and the caller sends them by doing nothing. Mixing the two
— a `contentType` on a GET — is refused with the alternative named, rather
than dropped or signed on a guess.

### 3. The addressing style is an argument, never an inference

Virtual-hosted style puts the bucket in the hostname; path style puts it in
the path. They change *both* the Host header and the canonical URI, so a
wrong guess is not a typo the server can correct — it is a different request.

| `addressingStyle` | Host | Path |
|---|---|---|
| `virtual-hosted` | `docs.s3.us-east-1.amazonaws.com` | `/report.pdf` |
| `path` | `s3.us-east-1.amazonaws.com` | `/docs/report.pdf` |

AWS S3 and most R2 setups are virtual-hosted; MinIO and some R2 and gateway
configurations are path-style, and the endpoint URL looks identical either
way. There is no default.

## What it refuses, and why

Each of these would otherwise mint a URL that cannot work, for a reason the
store's answer will not name:

| Refused | Because |
|---|---|
| a key with a `.` or `..` segment | clients resolve it before sending, so the path signed is not the path that arrives |
| a key with `//` or a leading `/` | URL normalization collapses it on the way out |
| a key over 1024 **bytes** | S3's limit counts bytes, so a non-ASCII key reaches it sooner than it looks |
| a control character in a key or header | a bare CR splits the request in a careless client |
| `http://` to anything but loopback | the URL *is* the credential for that object; http puts it and the object on the wire in clear. Loopback means the parsed address — `localhost`, `*.localhost`, `[::1]`, or an IPv4 literal in `127.0.0.0/8`. A hostname that merely *starts* with `127.` is a domain somebody else registers |
| an endpoint with a path, query or credentials | a prefix would be signed twice or not at all |
| virtual-hosted style against an IP endpoint | an address cannot carry a bucket as a subdomain (this is the local-MinIO mistake) |
| an endpoint that already names the bucket | it would be signed twice |
| a bucket that cannot be a DNS label, virtual-hosted | the request would not reach the store; path style takes it, with a warning |
| a bucket that is not a usable path segment, path-style | `.` would sign `/./key`, the same dot segment a key is refused for |
| a signing instant outside the years 0000–9999 | `X-Amz-Date` has four digits for the year; `toISOString` switches to `+010000-…` rather than throwing, and the slice of that is a signature over nonsense |
| a region like `US-East-1` | the credential scope is matched literally |
| a secret with leading or trailing whitespace | a newline picked up while reading or pasting, which signs cleanly and verifies nowhere |
| `expiresInSeconds` over 7 days | SigV4 query authentication stops there; clamping silently would be a lie |
| a `content-type` with doubled or edge whitespace | SigV4 signs the collapsed form, so the value handed back would not be the value signed |

Warnings, rather than refusals, cover the cases that work but should be seen:
a dotted bucket in virtual-hosted style (the wildcard certificate covers one
label), temporary credentials (the URL also dies with the session token), and
an expiry long enough that the URL is effectively a copy of the object.

## Vectors, not vibes

The signing tests are pinned to AWS's own published values and are written as
literals, so a change to the encoder or the canonicalization moves a byte and
the test says so:

- the signing-key derivation example (`iam` / `us-east-1` / `20120215`);
- `aws-sig-v4-test-suite` `get-vanilla` and `get-header-value-trim`, canonical
  request, string-to-sign and signature;
- the documented presigned GET Object example for `examplebucket/test.txt`,
  reproduced end to end through the tool.

Vectors only cover the requests somebody published. So the integration suite
adds a verifier — the store's half of the exchange, built from the finished
URL string and nothing the tool returned alongside it — and runs ten awkward
keys through mint-then-verify, plus the cases that must *fail*: a tampered
path, the wrong secret, a GET URL replayed as a PUT, a pinned header dropped
or "improved", and a query parameter appended after signing. Every refusal
asserts *which* reason it got, so a verifier that fell over somewhere else
cannot pass for a signature that was correctly rejected.

The verifier writes out RFC 3986 percent-encoding a second time, from the
rule, rather than importing this package's encoder — and each minted path is
compared against that independent encoding of the key. Taking `canonicalUri`
off the minted URL instead, as an earlier version did, makes the verifier
agree with the tool by construction: with the encoder broken to
`encodeURIComponent`'s unreserved set, all ten keys still verified, including
the two carrying `!` `'` `(` `)` `*`.

## Using it

```jsonc
{
  "operation": "put",
  "endpoint": "https://s3.us-east-1.amazonaws.com",
  "addressingStyle": "virtual-hosted",
  "region": "us-east-1",
  "bucket": "acme-invoices",
  "key": "2026/q1/invoice 0041.pdf",
  "contentType": "application/pdf",
  "metadata": { "run-id": "r-4412" },
  "expiresInSeconds": 900,
  "accessKeyId": "…",
  "secretAccessKey": "…"
}
```

`signedAt` pins the signing instant, so a URL can be reproduced exactly when
somebody asks why theirs stopped working. `includeCanonical` returns the
canonical request and string-to-sign, which is what you diff against the
`CanonicalRequest` S3 echoes back in a 403 body.

## For the next AWS-signing tool

`lib/sigv4.ts` and `lib/encode.ts` are the general primitive, not an S3
detail: `encodeRfc3986`, `encodePath` (with the double-encoding option the
other services need), `canonicalQuery`, `signingKey`, `canonicalRequest`,
`stringToSign` and `sign` are all exported. Anything in this monorepo that
needs to sign an AWS request should import them rather than write a second
copy — there is no second copy today, and the golden vectors are what keeps
the first one honest.
