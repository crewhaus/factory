/**
 * Where the object lives: endpoint, addressing style, bucket, key — resolved
 * into the two strings the signature is computed over, the Host header and
 * the canonical URI.
 *
 * The addressing style is an INPUT, never an inference. `https://minio.acme.io`
 * and `https://s3.us-east-1.amazonaws.com` look the same to a parser, and R2
 * answers to both styles depending on how the bucket was configured. Guessing
 * produces a signature that is internally consistent and unusable: the Host
 * header and the path both move together, so the wrong guess is not a typo
 * the server can correct, it is a different request entirely.
 *
 * Everything here throws `PresignError` on a fact that would produce a URL
 * that cannot work. A refusal now is worth an opaque 403 later, and it is the
 * only feedback available — this package never talks to the store, so it can
 * never learn that the bucket does not exist.
 */
import { CrewhausError } from "@crewhaus/errors";
import { encodePath, encodeRfc3986, utf8Length } from "./encode";

/** A URL this tool would refuse to sign, with the reason in the message. */
export class PresignError extends CrewhausError {
  override readonly name = "PresignError";
  constructor(message: string) {
    super("tool", message);
  }
}

export const ADDRESSING_STYLES = ["virtual-hosted", "path"] as const;
export type AddressingStyle = (typeof ADDRESSING_STYLES)[number];

/** S3's own limit on a key: 1024 BYTES of UTF-8, not 1024 characters. */
export const MAX_KEY_BYTES = 1024;

export type Endpoint = {
  scheme: "http" | "https";
  /** Host header value: lowercased, port present only when non-default. */
  host: string;
  hostname: string;
  isIpLiteral: boolean;
  isLoopback: boolean;
};

export type Target = {
  host: string;
  /** `https://bucket.s3.amazonaws.com` — no path, no trailing slash. */
  origin: string;
  /** Percent-encoded, leading slash included. */
  canonicalUri: string;
  warnings: string[];
};

function isIpv4(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Is this host the local machine?
 *
 * Decided on the parsed ADDRESS, never on the text of the hostname. The trap
 * this replaced was `/^127\./.test(hostname)`, which is a prefix match on a
 * string: `127.0.0.1.evil.example` is an ordinary registered domain that
 * somebody else controls, and it passes that test. The consequence is not
 * cosmetic — loopback is the one place `parseEndpoint` permits plain http, on
 * the grounds that there is no wire to listen on, and a presigned URL is a
 * bearer credential for the object until it expires. A hostname that merely
 * begins with "127." put that credential, and the object, on the open network
 * in clear.
 *
 * Requiring an IPv4 literal first is exact rather than approximate, because
 * the WHATWG parser has already normalized every form of one to dotted quad:
 * `0x7f000001`, `127.1` and `127.0.0.1` all arrive here as `127.0.0.1`, and a
 * host whose last label is not numeric is a domain, never an address.
 *
 * IPv4-mapped IPv6 (`[::ffff:7f00:1]`) is loopback in fact and is NOT
 * accepted here. That direction is safe: it costs a clear refusal, where the
 * opposite mistake costs a credential.
 */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "[::1]") return true;
  return isIpv4(hostname) && hostname.startsWith("127.");
}

/**
 * Quote an endpoint back in a refusal, WITHOUT anything credential-shaped.
 *
 * Two things a refused endpoint can carry, and both of them get quoted into
 * an error message, which is the one string guaranteed to be copied onward
 * into a transcript, a log line and a bug report:
 *
 *   - USERINFO. Two of the checks in `parseEndpoint` run before the one that
 *     refuses `https://KEY:SECRET@host`: a bad port never reaches the URL
 *     parser at all, and a non-http scheme is rejected first. So those two
 *     quoted the secret straight back.
 *   - A QUERY STRING. The likeliest way an endpoint acquires one is somebody
 *     pasting a whole presigned URL into the field — which carries
 *     `X-Amz-Signature` and, on temporary credentials, a live
 *     `X-Amz-Security-Token`.
 *
 * Redacting at the point of echo rather than relying on check order, because
 * check order is exactly what the next edit changes. The host and the path
 * survive, which is all the message needs to identify what was refused.
 */
function quoteEndpoint(raw: string): string {
  const trimmed = raw.trim();
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(trimmed);
  const prefix = scheme === null ? "" : scheme[0];
  const rest = trimmed.slice(prefix.length);
  const cut = rest.search(/[/?#]/);
  const authority = cut === -1 ? rest : rest.slice(0, cut);
  const at = authority.lastIndexOf("@");
  const shown = at === -1 ? authority : `<redacted>@${authority.slice(at + 1)}`;
  if (cut === -1) return `${prefix}${shown}`;
  const tail = rest.slice(cut);
  const mark = tail.search(/[?#]/);
  const path = mark === -1 ? tail : tail.slice(0, mark);
  const suffix = mark === -1 ? "" : `${tail[mark]}<redacted>`;
  return `${prefix}${shown}${path}${suffix}`;
}

/**
 * Parse the store's base URL into the pieces the signature needs.
 *
 * The WHATWG parser does three things here that a hand-rolled split would
 * get wrong: it lowercases the host, it converts an internationalized host to
 * punycode (which is what the Host header must carry), and it drops the port
 * when it is the scheme's default. That last one is load-bearing — a Host
 * header of `s3.amazonaws.com:443` signs fine and then fails, because every
 * HTTP client omits the default port and the server canonicalizes what it
 * received, not what was meant.
 */
export function parseEndpoint(raw: string): Endpoint {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PresignError(
      `endpoint "${quoteEndpoint(raw)}" is not a URL — write the store's origin, e.g. https://s3.us-east-1.amazonaws.com or http://127.0.0.1:9000`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PresignError(
      `endpoint "${quoteEndpoint(raw)}" uses ${url.protocol} — an object-store endpoint is http or https`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new PresignError(
      "endpoint carries a username or password — SigV4 credentials go in accessKeyId/secretAccessKey, and a credential in the URL would be signed into the result",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new PresignError(
      `endpoint "${quoteEndpoint(raw)}" carries a query string or fragment; pass the origin only`,
    );
  }
  if (url.pathname !== "/") {
    // A path-prefixed gateway (`https://gw.acme.io/s3`) is a real deployment,
    // and it is refused rather than guessed at: the prefix belongs in the
    // canonical URI ahead of the bucket, and whether THIS gateway wants it
    // signed is a fact about the gateway that nothing here can check.
    throw new PresignError(
      `endpoint "${quoteEndpoint(raw)}" has a path ("${url.pathname}") — this tool signs a path built from the bucket and key, so a prefix on the endpoint would be signed twice or not at all. Pass the origin only`,
    );
  }
  if (url.hostname === "") throw new PresignError(`endpoint "${quoteEndpoint(raw)}" has no host`);

  const hostname = url.hostname;
  const isLoopback = isLoopbackHost(hostname);
  const scheme = url.protocol === "https:" ? "https" : "http";
  if (scheme === "http" && !isLoopback) {
    // A presigned URL IS the credential for one object until it expires.
    // Over http it, and the object, cross the network in clear to anyone on
    // the path. Loopback is exempted because that is where MinIO runs in
    // development and there is no network to listen on.
    throw new PresignError(
      `endpoint "${quoteEndpoint(raw)}" is plain http and "${hostname}" is not loopback — a presigned URL is a bearer credential for the object, and http puts it and the object on the wire in clear. Use https, or point at localhost for a local MinIO`,
    );
  }
  return {
    scheme,
    host: url.host,
    hostname,
    isIpLiteral: isIpv4(hostname) || hostname.startsWith("["),
    isLoopback,
  };
}

/**
 * Check a bucket name, and say what is wrong in the terms of the style that
 * will be used.
 *
 * Virtual-hosted style is strict because the name becomes a DNS label: an
 * underscore or a capital cannot be a hostname, so the request would not even
 * reach the store. Path style is permissive because the name is just a path
 * segment — legacy us-east-1 buckets with capitals predate the modern rules
 * and still work there — but it warns, because such a bucket can never be
 * addressed the other way.
 */
export function checkBucket(bucket: string, style: AddressingStyle): string[] {
  const warnings: string[] = [];
  if (bucket.length === 0) throw new PresignError("bucket is empty");
  if (bucket.length > 255) {
    throw new PresignError(`bucket name is ${bucket.length} characters; the ceiling is 255`);
  }
  if (bucket.includes("/")) {
    throw new PresignError(
      `bucket "${bucket}" contains "/" — pass the bucket alone and put the rest in key`,
    );
  }
  const modern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !bucket.includes("..");
  if (style === "virtual-hosted") {
    if (!modern) {
      throw new PresignError(
        `bucket "${bucket}" cannot be a DNS label, so virtual-hosted addressing cannot reach it: names must be 3-63 characters of lowercase letters, digits, dots and hyphens, start and end alphanumeric, and contain no "..". Use addressingStyle "path" for a legacy or non-conforming name`,
      );
    }
    if (isIpv4(bucket)) {
      throw new PresignError(`bucket "${bucket}" is shaped like an IPv4 address, which S3 forbids`);
    }
    if (bucket.includes(".")) {
      warnings.push(
        `bucket "${bucket}" contains a dot: over https the wildcard certificate for the endpoint covers one label, so TLS verification typically fails for a dotted bucket in virtual-hosted style. Path style avoids it.`,
      );
    }
  } else if (!modern) {
    // No length exemption here. There used to be a `bucket.length > 1` guard
    // in front of this check, and it let a bucket of "." through entirely
    // unvalidated: path style then signed "/./key" — the very dot segment
    // `checkKey` refuses in a key, for the reason given there. Every HTTP
    // client resolves it away before sending, so the signature would cover a
    // path that never arrives and the store would answer 403 without
    // mentioning paths. A one-character bucket is checked like any other.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(bucket)) {
      throw new PresignError(
        `bucket "${bucket}" is not a usable path segment: it must start and end alphanumeric and contain only letters, digits, dots, hyphens and underscores`,
      );
    }
    warnings.push(
      `bucket "${bucket}" does not meet current S3 naming rules (3-63 lowercase alphanumerics, dots and hyphens), so it can only ever be addressed path-style.`,
    );
  }
  return warnings;
}

/**
 * Check an object key.
 *
 * The dot-segment refusal is the one that repays itself. S3 keys may legally
 * contain `.` and `..` segments, and S3 does not normalize the request path —
 * but nearly every HTTP client does, before sending. So a URL signed over
 * `/a/../b.txt` is sent as `/b.txt`, the signature is computed over a path
 * that never arrives, and the store answers 403 with no mention of paths.
 * Signing it would be minting a URL that is broken by design.
 */
export function checkKey(key: string): void {
  if (key.length === 0) throw new PresignError("key is empty");
  const bytes = utf8Length(key);
  if (bytes > MAX_KEY_BYTES) {
    throw new PresignError(
      `key is ${bytes} bytes of UTF-8 and S3's limit is ${MAX_KEY_BYTES} bytes (the limit counts bytes, not characters, so non-ASCII keys reach it sooner)`,
    );
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing C0 controls is the point.
  const control = key.match(/[\x00-\x1f\x7f]/);
  if (control !== null) {
    const code = control[0].charCodeAt(0).toString(16).padStart(4, "0").toUpperCase();
    throw new PresignError(
      `key contains the control character U+${code} — S3 permits it, but it cannot survive a URL that a human or a log line passes along, and a bare CR or LF splits the request in a careless client`,
    );
  }
  if (key.startsWith("/")) {
    throw new PresignError(
      `key "${key}" starts with "/" — the canonical URI already supplies it, so this would sign "//…", a different object from the one meant`,
    );
  }
  if (key.includes("//")) {
    throw new PresignError(
      `key "${key}" contains an empty path segment ("//"). S3 would store it, but URL normalization in most clients collapses it before the request is sent, so the signature would be over a path that never arrives`,
    );
  }
  const segments = key.split("/");
  if (segments.includes(".") || segments.includes("..")) {
    throw new PresignError(
      `key "${key}" contains a "." or ".." segment. HTTP clients resolve those before sending, so the request would arrive with a different path than the one signed and the store would answer 403 without explaining why`,
    );
  }
}

/**
 * Resolve endpoint + style + bucket + key into the Host header and the
 * canonical URI. These two strings are what the signature commits to; every
 * other difference between the two styles follows from them.
 */
export function resolveTarget(input: {
  endpoint: Endpoint;
  style: AddressingStyle;
  bucket: string;
  key: string;
}): Target {
  const warnings = checkBucket(input.bucket, input.style);
  checkKey(input.key);

  if (input.style === "path") {
    return {
      host: input.endpoint.host,
      origin: `${input.endpoint.scheme}://${input.endpoint.host}`,
      canonicalUri: `/${encodeRfc3986(input.bucket)}/${encodePath(input.key)}`,
      warnings,
    };
  }

  if (input.endpoint.isIpLiteral) {
    throw new PresignError(
      `endpoint host "${input.endpoint.hostname}" is an IP address, which cannot carry "${input.bucket}." as a subdomain. A store reached by IP — a local MinIO, most commonly — is addressed with addressingStyle "path"`,
    );
  }
  if (input.endpoint.hostname.startsWith(`${input.bucket.toLowerCase()}.`)) {
    throw new PresignError(
      `endpoint host "${input.endpoint.hostname}" already begins with the bucket name, so virtual-hosted addressing would sign "${input.bucket}.${input.endpoint.hostname}". Pass the store's own origin (e.g. https://s3.us-east-1.amazonaws.com) and let the bucket be added here`,
    );
  }
  const host = `${input.bucket}.${input.endpoint.host}`;
  return {
    host,
    origin: `${input.endpoint.scheme}://${host}`,
    canonicalUri: `/${encodePath(input.key)}`,
    warnings,
  };
}
