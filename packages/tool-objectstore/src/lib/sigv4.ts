/**
 * AWS Signature Version 4, as arithmetic.
 *
 * Nothing in this file reaches a network, opens a socket or keeps state. It
 * takes a request description and a secret, and returns bytes. The secret is
 * used to derive the signing key and is referenced nowhere else — not in the
 * result, not in an error message, not in a log line — because a signing
 * routine that puts its key into a thrown error has published it to every
 * transcript that ever catches one.
 *
 * The chain, per AWS's "Signing AWS API requests":
 *
 *   1. canonical request  — method, URI, query, headers, signed-header list,
 *                           payload hash, joined by newlines
 *   2. string to sign     — algorithm, timestamp, credential scope, and the
 *                           SHA-256 of (1)
 *   3. signing key        — HMAC-SHA256 chained through date, region, service
 *                           and the literal `aws4_request`
 *   4. signature          — HMAC-SHA256 of (2) under (3), lowercase hex
 *
 * Step 3 is why a leaked signature is not a leaked credential: it is scoped to
 * one day, one region and one service, and it cannot be run backwards.
 */
import { createHash, createHmac } from "node:crypto";
import { type QueryParam, canonicalQuery } from "./encode";

export const ALGORITHM = "AWS4-HMAC-SHA256";

/**
 * The payload hash a presigned URL carries. The body does not exist yet when
 * the URL is minted — that is the entire point of presigning — so S3 accepts
 * this sentinel in place of a digest. Writing the SHA-256 of the empty string
 * here instead would sign "this PUT has no body", and every real upload would
 * then 403.
 */
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** A header as it will be signed: `[name, value]`, name in any case. */
export type Header = readonly [string, string];

/** Lowercase-hex SHA-256 of a string, the form every step of SigV4 wants. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Derive the signing key: HMAC down the scope, starting from `AWS4` + secret.
 *
 * `dateStamp` is `YYYYMMDD` in UTC, and it must be the same day as the
 * timestamp in the string to sign. A key derived from yesterday's date with
 * today's timestamp verifies against nothing, and the error says only
 * `SignatureDoesNotMatch`.
 */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** `20130524T000000Z` and `20130524` for an instant, always UTC. */
export function amzTimestamps(epochMs: number): { amzDate: string; dateStamp: string } {
  if (!Number.isFinite(epochMs)) throw new Error("the signing instant is not a finite number");
  // toISOString throws RangeError outside ±8.64e15; let it, rather than
  // emitting "InvalidDate" into a signature.
  const iso = new Date(epochMs).toISOString();
  // Sub-second precision is dropped rather than rounded: X-Amz-Date has
  // second resolution, and rounding up could place the timestamp in the
  // future for a store that enforces clock skew strictly.
  const amzDate = `${iso.slice(0, 19).replace(/[-:]/g, "")}Z`;
  if (!/^\d{8}T\d{6}Z$/.test(amzDate)) {
    // The finite check above is not enough, and the RangeError above does not
    // cover this. `toISOString` only throws outside ±8.64e15; for the years
    // in between that do not fit four digits it switches to the EXPANDED
    // form, `+010000-01-01T00:00:00.000Z`. Slicing that yields an X-Amz-Date
    // of `+0100000101T0000Z` and a credential scope of `+0100000/...` — a URL
    // that is well-formed, correctly signed over nonsense, and refused by
    // every store on earth with the reason nowhere in sight. Refuse the
    // instant instead of signing it.
    throw new Error(
      `the signing instant (${iso}) is outside the years 0000-9999 that X-Amz-Date can express`,
    );
  }
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** `20130524/us-east-1/s3/aws4_request` — the credential scope. */
export function credentialScope(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/aws4_request`;
}

/**
 * Canonicalize one header value: trim the ends, collapse internal runs of
 * whitespace to a single space.
 *
 * The server applies this same reduction to what it receives, so a value with
 * doubled spaces still verifies — the collapse is not a divergence. The
 * divergence to fear is a DIFFERENT value: an HTTP client that appends
 * `; charset=utf-8` to a bare `text/plain` changes the signed bytes, and no
 * canonicalization saves it. That is why the caller is handed back the exact
 * value that was signed.
 *
 * Known limit, stated rather than hidden: the spec exempts whitespace inside
 * a quoted string from the collapse. This does not implement that exemption,
 * so a value like `attachment; filename="a  b"` would be canonicalized by
 * this code and (arguably) not by the server. Such values are refused
 * upstream in `headers.ts` rather than signed on a guess.
 */
export function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/[ \t]+/g, " ");
}

/**
 * The `SignedHeaders` value: lowercase names, sorted, semicolon-joined.
 *
 * It appears twice in a presigned URL — inside the canonical request and as
 * the `X-Amz-SignedHeaders` query parameter — and the two must agree, so both
 * come from here rather than from two list comprehensions that drift.
 */
export function signedHeaderList(headers: ReadonlyArray<Header>): string {
  return headers
    .map(([name]) => name.toLowerCase())
    .sort()
    .join(";");
}

export type CanonicalRequest = {
  /** The canonical request text, newline-joined, exactly as it is hashed. */
  text: string;
  /** `content-type;host;x-amz-meta-owner` — semicolon-joined, sorted. */
  signedHeaders: string;
};

/**
 * Assemble the canonical request.
 *
 * `canonicalUri` arrives already percent-encoded (see `encode.ts`): this
 * function must not encode it again, because whether the path is encoded once
 * or twice is a per-service fact the caller owns and S3's answer is "once".
 */
export function canonicalRequest(input: {
  method: string;
  canonicalUri: string;
  query: ReadonlyArray<QueryParam>;
  headers: ReadonlyArray<Header>;
  payloadHash: string;
}): CanonicalRequest {
  const lowered = input.headers.map(
    ([name, value]) => [name.toLowerCase(), canonicalHeaderValue(value)] as const,
  );
  lowered.sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1));
  const canonicalHeaders = lowered.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = lowered.map(([name]) => name).join(";");
  const text = [
    input.method,
    input.canonicalUri,
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  return { text, signedHeaders };
}

/** The string to sign: algorithm, timestamp, scope, hash of the canonical request. */
export function stringToSign(input: {
  amzDate: string;
  scope: string;
  canonicalRequest: string;
}): string {
  return [ALGORITHM, input.amzDate, input.scope, sha256Hex(input.canonicalRequest)].join("\n");
}

/** The signature itself: lowercase hex, 64 characters. */
export function sign(input: {
  secretAccessKey: string;
  dateStamp: string;
  region: string;
  service: string;
  stringToSign: string;
}): string {
  const key = signingKey(input.secretAccessKey, input.dateStamp, input.region, input.service);
  return hmac(key, input.stringToSign).toString("hex");
}

export type PresignInput = {
  method: "GET" | "PUT";
  /** `https://bucket.s3.amazonaws.com` — scheme and authority, no path. */
  origin: string;
  /** The exact Host header value, port included only when non-default. */
  host: string;
  /** Already percent-encoded, always starting with `/`. */
  canonicalUri: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  epochMs: number;
  expiresInSeconds: number;
  /** Extra query parameters to sign, un-encoded. */
  query?: ReadonlyArray<QueryParam>;
  /** Headers to sign beyond `host`, un-canonicalized. */
  headers?: ReadonlyArray<Header>;
};

export type PresignResult = {
  url: string;
  amzDate: string;
  /** Sorted, semicolon-joined — what the eventual request must send. */
  signedHeaders: string;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
};

/**
 * Mint a presigned URL: query-string authentication, SigV4.
 *
 * Two facts about query-string auth that the header-based form does not share,
 * and that are easy to get wrong by analogy:
 *
 *   - the session token travels as `X-Amz-Security-Token` in the QUERY and is
 *     signed there, not as a header;
 *   - `X-Amz-Signature` itself is the one parameter excluded from the
 *     canonical query string, because it does not exist yet when the canonical
 *     request is built. It is appended to the URL afterwards.
 */
export function presign(input: PresignInput): PresignResult {
  const { amzDate, dateStamp } = amzTimestamps(input.epochMs);
  const scope = credentialScope(dateStamp, input.region, input.service);
  const headers: Header[] = [["host", input.host], ...(input.headers ?? [])];

  const signed = signedHeaderList(headers);

  const query: QueryParam[] = [
    ...(input.query ?? []),
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", signed],
  ];
  if (input.sessionToken !== undefined) {
    query.push(["X-Amz-Security-Token", input.sessionToken]);
  }

  const creq = canonicalRequest({
    method: input.method,
    canonicalUri: input.canonicalUri,
    query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const toSign = stringToSign({ amzDate, scope, canonicalRequest: creq.text });
  const signature = sign({
    secretAccessKey: input.secretAccessKey,
    dateStamp,
    region: input.region,
    service: input.service,
    stringToSign: toSign,
  });

  // The URL carries the canonical (sorted, encoded) query so that two calls
  // with the same inputs produce byte-identical URLs. The server re-sorts
  // anyway; determinism is for the caller, who diffs these.
  const url = `${input.origin}${input.canonicalUri}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
  return {
    url,
    amzDate,
    signedHeaders: creq.signedHeaders,
    canonicalRequest: creq.text,
    stringToSign: toSign,
    signature,
  };
}
