/**
 * What a fake keeps of a request: everything a test wants to assert on, with
 * credentials gone. The masking is by key name and lives here on purpose: this
 * package is a leaf, so it cannot import the product's masker, and a recording
 * is the one place a fake could hand a credential on to a test log.
 */

/** Header names a recording never keeps, whatever their value. */
const DROPPED_HEADER = /^(authorization|x-api-key|cookie|set-cookie)$/i;
/**
 * What makes a name a credential, in the vocabulary the product's own name
 * classifier uses. `record.test.ts` pins this with a corpus of such names. A test
 * that wants a masked field back can read it from another name.
 */
/** Credential words wherever they appear, even run together (`PGPASSWORD`). */
const CREDENTIAL_WORDS = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "authorization",
  "bearer",
  "cookie",
  "mnemonic",
  "seedphrase",
  "recoveryphrase",
  "connectionstring",
  "connstr",
  "webhook",
];
/** Credential words only when whole: inside others they would take `author`, `path`, `bypass`. */
const WHOLE_CREDENTIAL_WORDS = new Set([
  "auth",
  "auths",
  "pass",
  "pwd",
  "pat",
  "pats",
  "creds",
  "dsn",
  "otp",
  "salt",
]);
/** A URL under one of these names carries a password in it. */
const URL_WORDS = new Set(["url", "urls", "uri", "uris"]);
const URL_OWNERS_WITH_PASSWORDS = new Set([
  "database",
  "db",
  "postgres",
  "postgresql",
  "pg",
  "mysql",
  "mariadb",
  "mongo",
  "mongodb",
  "redis",
  "amqp",
  "rabbitmq",
  "broker",
  "smtp",
]);

/** A name's words, lower-cased: split on separators and camelCase, trailing digits dropped. */
const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.replace(/[0-9]+$/, ""))
    .filter((word) => word !== "");

const namesCredential = (name: string): boolean => {
  const words = wordsOf(name);
  const joined = words.join("");
  return (
    CREDENTIAL_WORDS.some((word) => joined.includes(word)) ||
    words.some((word) => WHOLE_CREDENTIAL_WORDS.has(word)) ||
    (words.some((word) => URL_WORDS.has(word)) &&
      words.some((word) => URL_OWNERS_WITH_PASSWORDS.has(word)))
  );
};

export const MASKED = "[masked]";

/** The headers of a request, without the ones that carry a credential. */
export function maskHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (DROPPED_HEADER.test(name) || namesCredential(name)) continue;
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
    out[key] = namesCredential(key) && !keep ? MASKED : maskBody(inner);
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
