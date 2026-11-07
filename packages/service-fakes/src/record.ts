/**
 * What a fake keeps of a request: everything a test wants to assert on, with
 * credentials gone. The masking is by key name and lives here on purpose: this
 * package is a leaf, so it cannot import the product's masker, and a recording
 * is the one place a fake could hand a credential on to a test log.
 */

/** Header names a recording never keeps, whatever their value. */
const DROPPED_HEADER = /^(authorization|x-api-key|cookie|set-cookie)$/i;
/** A key name whose string or object value is replaced in a recorded body. */
const CREDENTIAL_KEY = /key|token|secret|password/i;

export const MASKED = "[masked]";

/** The headers of a request, without the ones that carry a credential. */
export function maskHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (DROPPED_HEADER.test(name) || CREDENTIAL_KEY.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * A JSON value with every credential-named key redacted, at any depth. Numbers
 * and booleans survive: a Messages API body's `max_tokens` is a count, and no
 * credential is a bare number on these wires.
 */
export function maskBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskBody);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const keep = typeof inner === "number" || typeof inner === "boolean" || inner === null;
    out[key] = CREDENTIAL_KEY.test(key) && !keep ? MASKED : maskBody(inner);
  }
  return out;
}

/** A request as a fake recorded it. */
export type RecordedRequest = {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
};

/** Parse a body by its content type; an unparseable one is kept as text. */
export function parseBody(contentType: string | null, text: string): unknown {
  if (text === "") return null;
  if (contentType?.includes("application/x-www-form-urlencoded") === true) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** One request, masked, read without consuming the original. */
export async function recordRequest(req: Request): Promise<{
  readonly recorded: RecordedRequest;
  readonly parsed: unknown;
}> {
  const url = new URL(req.url);
  const parsed = parseBody(req.headers.get("content-type"), await req.clone().text());
  return {
    parsed,
    recorded: {
      method: req.method,
      path: url.pathname,
      search: url.search,
      headers: maskHeaders(req.headers),
      body: maskBody(parsed),
    },
  };
}
