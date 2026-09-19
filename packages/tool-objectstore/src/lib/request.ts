/**
 * What else gets signed, besides the path: the headers pinned into a PUT and
 * the query overrides pinned into a GET.
 *
 * These two look symmetrical and are not, and the asymmetry is the whole
 * reason this module exists:
 *
 *   - A PUT pins `content-type` (and any `x-amz-meta-*`) as a signed HEADER.
 *     It therefore lands in `SignedHeaders`, and the eventual upload must
 *     send that header with that exact value or the store answers 403. The
 *     tool that mints the URL is the only thing that knows the value, so it
 *     hands it back and says to send it verbatim.
 *   - A GET pins its overrides as signed QUERY parameters. They are already
 *     in the URL, so the caller sends them by doing nothing at all.
 *
 * Mixing the two — a `content-type` on a GET — is refused rather than
 * quietly dropped or quietly signed, because both of those produce a URL that
 * fails much later for a reason that does not mention content types.
 */
import type { QueryParam } from "./encode";
import { type Header, canonicalHeaderValue } from "./sigv4";
import { PresignError } from "./store";

export const OPERATIONS = ["get", "put"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** S3's ceiling on user metadata, counted over the names and values together. */
export const MAX_METADATA_BYTES = 2048;

/**
 * Refuse a header value this package cannot sign honestly.
 *
 * A CR or LF is a request-splitting attempt or a stray paste; neither belongs
 * in a signature. The second check is subtler: SigV4 canonicalization trims
 * the ends of a header value and collapses internal whitespace runs, so a
 * value with a doubled space is signed in a form the caller did not write.
 * The server applies the same reduction and it would in fact verify — but the
 * tool's promise is "send this back byte for byte", and a value that is not
 * its own canonical form makes that promise false. The spec's quoted-string
 * exemption lives in the same gap. Refusing is one sentence; explaining the
 * exemption to whoever hits the 403 is not.
 */
export function checkHeaderValue(name: string, value: string): void {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing C0 controls is the point.
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new PresignError(
      `${name} contains a control character (a CR, LF or tab). A header value that is signed here and sent later must be one line of printable text`,
    );
  }
  if (canonicalHeaderValue(value) !== value) {
    throw new PresignError(
      `${name} "${value}" has leading, trailing or repeated whitespace. SigV4 signs the whitespace-collapsed form, so the value handed back would not be the value signed — pass "${canonicalHeaderValue(value)}" if that is what you meant`,
    );
  }
}

/** A metadata name must be an HTTP token; S3 lowercases it on the way in. */
const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Turn `{ owner: "ops" }` into `[["x-amz-meta-owner", "ops"]]`.
 *
 * Names are lowercased here because S3 lowercases them on arrival: signing
 * `X-Amz-Meta-Owner` and receiving `x-amz-meta-owner` is a mismatch the
 * caller cannot see and cannot fix.
 */
export function metadataHeaders(metadata: Record<string, string>): Header[] {
  const headers: Header[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const [rawName, value] of Object.entries(metadata)) {
    if (!TOKEN.test(rawName)) {
      throw new PresignError(
        `metadata name "${rawName}" is not a valid HTTP header token — use letters, digits and -_.`,
      );
    }
    if (rawName.toLowerCase().startsWith("x-amz-meta-")) {
      throw new PresignError(
        `metadata name "${rawName}" already carries the x-amz-meta- prefix; pass the bare name ("${rawName.slice("x-amz-meta-".length)}") and the prefix is added here`,
      );
    }
    const name = `x-amz-meta-${rawName.toLowerCase()}`;
    if (seen.has(name)) {
      throw new PresignError(
        `metadata names "${rawName}" and another differ only in case; S3 lowercases them, so one would silently overwrite the other`,
      );
    }
    seen.add(name);
    if (!/^[\x20-\x7e]*$/.test(value)) {
      throw new PresignError(
        `metadata value for "${rawName}" is not printable US-ASCII. S3 carries user metadata in HTTP headers, which cannot hold it as-is — encode it yourself (base64, or RFC 2047) so that what is signed is what is sent`,
      );
    }
    checkHeaderValue(`metadata value for "${rawName}"`, value);
    bytes += name.length + value.length;
    headers.push([name, value]);
  }
  if (bytes > MAX_METADATA_BYTES) {
    throw new PresignError(
      `user metadata is ${bytes} bytes and S3's limit is ${MAX_METADATA_BYTES}; the store would reject the upload after the bytes were sent`,
    );
  }
  return headers;
}

export type Overrides = {
  responseContentType?: string;
  responseContentDisposition?: string;
  responseCacheControl?: string;
  versionId?: string;
};

/**
 * The GET-side pins, as signed query parameters.
 *
 * `response-content-disposition` is the reason this exists: it is how a
 * presigned link downloads as `invoice-2026-01.pdf` instead of as the key,
 * and it only works if it is signed in — adding it to a finished URL
 * invalidates the signature.
 */
export function responseOverrides(overrides: Overrides): QueryParam[] {
  const query: QueryParam[] = [];
  const push = (param: string, value: string | undefined) => {
    if (value === undefined) return;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing C0 controls is the point.
    if (/[\x00-\x1f\x7f]/.test(value)) {
      throw new PresignError(`${param} contains a control character`);
    }
    query.push([param, value]);
  };
  push("response-content-type", overrides.responseContentType);
  push("response-content-disposition", overrides.responseContentDisposition);
  push("response-cache-control", overrides.responseCacheControl);
  push("versionId", overrides.versionId);
  return query;
}

/**
 * Refuse the cross-operation mistakes before anything is signed.
 *
 * Each of these would otherwise produce a URL that looks correct and fails
 * for a reason the 403 does not name.
 */
export function checkOperationFields(
  operation: Operation,
  fields: { contentType?: string; metadata?: Record<string, string>; overrides: Overrides },
): void {
  const named = (name: string) => {
    throw new PresignError(
      operation === "get"
        ? `${name} applies to an upload, not a download. A GET cannot pin a request header the browser will not send; use responseContentType or responseContentDisposition, which are signed into the URL itself`
        : `${name} applies to a download, not an upload: the response-* overrides tell S3 how to answer a GET. For a PUT, pass contentType and metadata, which are signed as request headers`,
    );
  };
  if (operation === "get") {
    if (fields.contentType !== undefined) named("contentType");
    if (fields.metadata !== undefined) named("metadata");
    return;
  }
  if (fields.overrides.responseContentType !== undefined) named("responseContentType");
  if (fields.overrides.responseContentDisposition !== undefined)
    named("responseContentDisposition");
  if (fields.overrides.responseCacheControl !== undefined) named("responseCacheControl");
  if (fields.overrides.versionId !== undefined) {
    throw new PresignError(
      "versionId identifies an existing version to read; a PUT creates a new one, and the store assigns its id",
    );
  }
}
