/**
 * @crewhaus/tool-objectstore — handing out a door key instead of the building.
 *
 * `ObjectPresign` mints a time-limited URL that downloads or uploads one
 * object in an S3-compatible store. Nothing else in the harness has to touch
 * the bytes: the URL goes to whoever needs the file, they talk to the store
 * directly, and the URL stops working when it expires.
 *
 * This is arithmetic, not I/O. The whole package is HMAC-SHA256 from
 * `node:crypto` over strings; it opens no socket, reads no file, spawns
 * nothing and keeps no state between calls beyond the injectable clock. That
 * is why it declares no `ioCapability` — the test suite asserts it, over the
 * package's own source, so the claim cannot rot.
 *
 * It holds no credential either, and never takes one as an argument. The
 * operator names a credential PROFILE in `tool_config.objectstore.credentials`
 * — the environment variables holding the access key id, the secret and (for
 * STS) the session token — and a call picks a profile by name. 0.7.0 took the
 * secret and the session token as tool arguments, which put them in the
 * model's context, the transcript, every later provider request and the
 * session event log, while this header and the schema said the secret was
 * "not logged" (flag-truth-5#8). The secret is consumed by the signing-key
 * derivation and referenced in no result and no error. (The access key ID
 * does appear in the URL: SigV4 puts it in `X-Amz-Credential` by
 * construction, which is how the store knows which key to verify against.
 * That is public by design; the secret is not. A session token rides in the
 * URL too, as `X-Amz-Security-Token`: SigV4 has nowhere else for it.)
 *
 * Three things are easy to get wrong here and all three fail late:
 *
 *   1. **Encoding.** `encodeURIComponent` is not SigV4's encoder. See
 *      `lib/encode.ts`.
 *   2. **Signed headers.** Pinning a content type puts `content-type` into
 *      `SignedHeaders`, so the upload must send that value byte for byte.
 *      The result carries the exact headers for that reason.
 *   3. **Addressing style.** Virtual-hosted and path style change both the
 *      Host header and the path, so the style is an argument, never a guess.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool, ToolExecuteContext } from "@crewhaus/tool-catalog";
import { isEnvName, looksLikePastedSecret, resolveCredentialEnv } from "@crewhaus/tool-safety/env";
import { z } from "zod";
import { nowMs, parseInstant } from "./lib/clock";
import {
  OPERATIONS,
  type Operation,
  checkHeaderValue,
  checkOperationFields,
  metadataHeaders,
  responseOverrides,
} from "./lib/request";
import { type Header, UNSIGNED_PAYLOAD, presign } from "./lib/sigv4";
import { ADDRESSING_STYLES, PresignError, parseEndpoint, resolveTarget } from "./lib/store";

export { _setClock, type Clock } from "./lib/clock";
export { PresignError };
export {
  canonicalQuery,
  encodePath,
  encodeRfc3986,
  type QueryParam,
} from "./lib/encode";
export {
  ALGORITHM,
  UNSIGNED_PAYLOAD,
  type Header,
  amzTimestamps,
  canonicalRequest,
  credentialScope,
  presign,
  sign,
  signedHeaderList,
  signingKey,
  stringToSign,
} from "./lib/sigv4";

const json = (value: unknown): string => JSON.stringify(value);

/** SigV4 query authentication expires at seven days. Past that, S3 refuses. */
const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_EXPIRY_SECONDS = 900;

/** Past this, a link is less "a link" and more "a copy of the object". */
const LONG_LIVED_SECONDS = 24 * 60 * 60;

/** S3 is the only service whose canonical URI is single-encoded; see lib/encode.ts. */
const SERVICE = "s3";

/** Shell-quote for the copy-pasteable example. Single quotes, POSIX style. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function checkCredential(name: string, value: string): void {
  if (value.trim() !== value) {
    // The classic: a secret read from a file or pasted from a console arrives
    // with a trailing newline. It signs perfectly and verifies nowhere, and
    // the store's answer is SignatureDoesNotMatch with no mention of
    // whitespace. Nothing downstream can detect this; here it is one check.
    throw new PresignError(
      `${name} has leading or trailing whitespace — almost always a newline picked up when the secret was read or pasted. It would produce a signature that fails with "SignatureDoesNotMatch" and no other clue`,
    );
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing C0 controls is the point.
  if (/[\x00-\x1f\x7f\s]/.test(value)) {
    throw new PresignError(`${name} contains whitespace or a control character`);
  }
}

/** One operator-configured credential: the variables that hold each part. */
export type CredentialProfile = {
  readonly accessKeyIdEnv: string;
  readonly secretAccessKeyEnv: string;
  readonly sessionTokenEnv?: string;
};

/** Where the profiles live in a spec, for messages. */
export const CREDENTIALS_CONFIG_KEY = "tool_config.objectstore.credentials";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The profiles from the boot block; none until one is registered. */
let registeredProfiles: ReadonlyMap<string, CredentialProfile> = new Map();

/** One field of a profile, in either spelling, as a variable name, never echoing a pasted value. */
function envField(
  block: Record<string, unknown>,
  snake: string,
  camel: string,
  where: string,
  required: boolean,
): string | undefined {
  const a = block[snake];
  const b = block[camel];
  if (a !== undefined && b !== undefined) {
    throw new PresignError(`${where} sets both ${snake} and ${camel}; keep one`);
  }
  const value = a ?? b;
  if (value === undefined) {
    if (required) {
      throw new PresignError(
        `${where}.${snake} is required: the NAME of the environment variable that holds it`,
      );
    }
    return undefined;
  }
  if (typeof value !== "string" || !isEnvName(value) || looksLikePastedSecret(value)) {
    const pasted = typeof value === "string" && looksLikePastedSecret(value);
    throw new PresignError(
      `${where}.${snake} must be the NAME of an environment variable${pasted ? "; it looks like the credential itself, which has not been echoed back — treat it as exposed" : ""}`,
    );
  }
  return value;
}

/** The credential profiles a `tool_config` block declares. Throws on a malformed one. */
function profilesOf(config: unknown, where: string): ReadonlyMap<string, CredentialProfile> {
  if (config === undefined || config === null) return new Map();
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new PresignError(`${where} must be a mapping with a credentials block`);
  }
  const credentials = (config as Record<string, unknown>)["credentials"];
  if (credentials === undefined) return new Map();
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    throw new PresignError(
      `${where}.credentials must map a profile name to { access_key_id_env, secret_access_key_env, session_token_env? }`,
    );
  }
  const out = new Map<string, CredentialProfile>();
  for (const [name, raw] of Object.entries(credentials as Record<string, unknown>)) {
    if (!PROFILE_NAME.test(name)) {
      throw new PresignError(
        `${where}.credentials has a profile name that is not letters, digits, ".", "_" or "-" (at most 64)`,
      );
    }
    const at = `${where}.credentials.${name}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PresignError(`${at} must be a mapping of environment variable names`);
    }
    const block = raw as Record<string, unknown>;
    const known = new Set([
      "access_key_id_env",
      "accessKeyIdEnv",
      "secret_access_key_env",
      "secretAccessKeyEnv",
      "session_token_env",
      "sessionTokenEnv",
    ]);
    const unknown = Object.keys(block).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      throw new PresignError(
        `${at} holds ${unknown.map((k) => JSON.stringify(k)).join(", ")}; a profile names environment variables only (access_key_id_env, secret_access_key_env, session_token_env) — never the credentials themselves`,
      );
    }
    const sessionTokenEnv = envField(block, "session_token_env", "sessionTokenEnv", at, false);
    out.set(name, {
      accessKeyIdEnv: envField(block, "access_key_id_env", "accessKeyIdEnv", at, true) as string,
      secretAccessKeyEnv: envField(
        block,
        "secret_access_key_env",
        "secretAccessKeyEnv",
        at,
        true,
      ) as string,
      ...(sessionTokenEnv === undefined ? {} : { sessionTokenEnv }),
    });
  }
  return out;
}

/**
 * Boot seam: the `tool_config.objectstore` (or `objectPresign`) block. Its
 * `credentials` are the ONLY credentials ObjectPresign signs with.
 *
 * ```yaml
 * tool_config:
 *   objectstore:
 *     credentials:
 *       r2:
 *         access_key_id_env: R2_ACCESS_KEY_ID
 *         secret_access_key_env: R2_SECRET_ACCESS_KEY
 * ```
 */
export function registerObjectStoreConfig(config: unknown): void {
  registeredProfiles = profilesOf(config, "tool_config.objectstore");
}

type ResolvedCredentials = {
  readonly profile: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
};

/**
 * The credentials one call signs with: the profile it named (or the only one),
 * each part read from the variable the operator named — never from the call.
 * A model-pool candidate's own block replaces the boot block for its calls.
 */
function resolveCredentials(
  requested: string | undefined,
  ctx: ToolExecuteContext | undefined,
): ResolvedCredentials {
  const profiles =
    typeof ctx?.toolConfig === "object" && ctx.toolConfig !== null
      ? profilesOf(ctx.toolConfig, "the tool_config block for ObjectPresign")
      : registeredProfiles;
  const names = [...profiles.keys()].sort();
  if (names.length === 0) {
    throw new PresignError(
      `no credential profile is configured. An operator adds one in ${CREDENTIALS_CONFIG_KEY}, naming the environment variables that hold the access key id, the secret and (for STS) the session token; credentials are never tool arguments`,
    );
  }
  const name = requested ?? (names.length === 1 ? names[0] : undefined);
  if (name === undefined) {
    throw new PresignError(
      `pass credentials: the profile to sign with, one of ${names.map((n) => JSON.stringify(n)).join(", ")}`,
    );
  }
  const profile = profiles.get(name);
  if (profile === undefined) {
    throw new PresignError(
      `there is no credential profile ${JSON.stringify(name)} in ${CREDENTIALS_CONFIG_KEY}; the profiles are ${names.map((n) => JSON.stringify(n)).join(", ")}`,
    );
  }
  const read = (env: string, what: string, field: string): string => {
    const found = resolveCredentialEnv(env, {
      allowed: [env],
      purpose: `the ${JSON.stringify(name)} profile's ${what}`,
      configKey: `${CREDENTIALS_CONFIG_KEY}.${name}.${field}`,
    });
    if (!found.ok) throw new PresignError(found.reason);
    return found.value;
  };
  return {
    profile: name,
    accessKeyId: read(profile.accessKeyIdEnv, "access key id", "access_key_id_env"),
    secretAccessKey: read(profile.secretAccessKeyEnv, "secret access key", "secret_access_key_env"),
    ...(profile.sessionTokenEnv === undefined
      ? {}
      : { sessionToken: read(profile.sessionTokenEnv, "session token", "session_token_env") }),
  };
}

const inputSchema = z
  .object({
    operation: z
      .enum(OPERATIONS)
      .describe("get to hand out a download link, put to hand out an upload target"),
    endpoint: z
      .string()
      .min(1)
      .max(512)
      .describe(
        "the store's origin and nothing else, e.g. https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com or http://127.0.0.1:9000 for a local MinIO",
      ),
    addressingStyle: z
      .enum(ADDRESSING_STYLES)
      .describe(
        "virtual-hosted puts the bucket in the hostname (AWS S3 and most R2 setups); path puts it in the path (MinIO, and R2 or gateways configured that way). This is not inferred: the two produce different Host headers and different paths, so a wrong guess signs a request that can never verify",
      ),
    region: z
      .string()
      .min(1)
      .max(64)
      .describe("the region in the credential scope, e.g. us-east-1, or auto for R2"),
    bucket: z.string().min(1).max(255),
    key: z.string().min(1).max(2048).describe("the object key, without a leading slash"),
    credentials: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        `the operator's credential profile to sign with, by name (${CREDENTIALS_CONFIG_KEY}); optional when exactly one is configured. The access key id, secret and session token are read from the environment variables the profile names — they are never arguments`,
      ),
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .optional()
      .describe(`how long the URL works; default ${DEFAULT_EXPIRY_SECONDS}, ceiling 7 days`),
    contentType: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "PUT only: pin the upload's Content-Type. This puts content-type into SignedHeaders, so the upload MUST send exactly this value — it comes back in headers for that reason",
      ),
    metadata: z
      .record(z.string())
      .optional()
      .describe(
        "PUT only: user metadata, named without the x-amz-meta- prefix. Each entry becomes a signed header the upload must send verbatim",
      ),
    responseContentType: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("GET only: the Content-Type the store should answer with"),
    responseContentDisposition: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe(
        'GET only: e.g. attachment; filename="invoice.pdf" to control the downloaded filename',
      ),
    responseCacheControl: z.string().min(1).max(256).optional().describe("GET only"),
    versionId: z.string().min(1).max(1024).optional().describe("GET only: read one version"),
    signedAt: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        "the instant to sign at, as epoch ms or ISO-8601 with an offset; defaults to now. Pass it to reproduce a URL exactly",
      ),
    includeCanonical: z
      .boolean()
      .optional()
      .describe(
        "include the canonical request and string-to-sign, to diff against the CanonicalRequest S3 echoes in a 403 body",
      ),
  })
  .strict();

export const objectPresign: RegisteredTool = buildTool({
  name: "ObjectPresign",
  description:
    "Mint a time-limited URL that downloads or uploads one object in an S3-compatible store (AWS S3, Cloudflare R2, MinIO, anything that speaks SigV4). Use it to move a file without the bytes passing through this harness and without handing anyone a long-lived key: the URL grants one operation on one object until it expires, and nothing else. It is pure computation (HMAC-SHA256, no SDK, no network, no credential kept), so it works offline and the same inputs give the same URL. For an upload that pins a content type or metadata, the exact headers come back with the URL and MUST be sent byte-identically, or the store answers 403 long after this call succeeded. The addressing style (virtual-hosted or path) is required, never inferred. Credentials are never arguments: the call names one of the operator's credential profiles (tool_config.objectstore.credentials), whose environment variables hold the keys, and the secret key appears in no output.",
  inputSchema,
  readOnly: true,
  concurrencySafe: true,
  // No scope or ioCapability: this reaches nothing. The package's own test
  // suite greps its source to keep that true.
  execute: async (input, ctx) => {
    const operation: Operation = input.operation;
    const overrides = {
      responseContentType: input.responseContentType,
      responseContentDisposition: input.responseContentDisposition,
      responseCacheControl: input.responseCacheControl,
      versionId: input.versionId,
    };
    checkOperationFields(operation, {
      contentType: input.contentType,
      metadata: input.metadata,
      overrides,
    });
    const creds = resolveCredentials(input.credentials, ctx);
    checkCredential("the access key id", creds.accessKeyId);
    checkCredential("the secret access key", creds.secretAccessKey);
    if (creds.sessionToken !== undefined) checkCredential("the session token", creds.sessionToken);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(input.region)) {
      throw new PresignError(
        `region "${input.region}" is not a region name — the credential scope is case-sensitive and matched literally, so "US-East-1" signs cleanly and then fails. Regions are lowercase letters, digits and hyphens (us-east-1, eu-central-1, or auto for R2)`,
      );
    }

    const expiresInSeconds = input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
    if (expiresInSeconds > MAX_EXPIRY_SECONDS) {
      throw new PresignError(
        `expiresInSeconds ${expiresInSeconds} is over the 7-day (${MAX_EXPIRY_SECONDS}s) ceiling that SigV4 query authentication allows; S3 rejects a longer one outright. For standing access, hand out a short URL each time rather than one long one`,
      );
    }

    const endpoint = parseEndpoint(input.endpoint);
    const target = resolveTarget({
      endpoint,
      style: input.addressingStyle,
      bucket: input.bucket,
      key: input.key,
    });

    const headers: Header[] = [];
    if (input.contentType !== undefined) {
      checkHeaderValue("contentType", input.contentType);
      headers.push(["content-type", input.contentType]);
    }
    if (input.metadata !== undefined) headers.push(...metadataHeaders(input.metadata));

    // Floored to the second BEFORE anything reads it. X-Amz-Date has second
    // resolution, so the store's clock for this URL starts at the truncated
    // instant; reporting signedAt/expiresAt from the millisecond one would
    // hand back a window up to a second longer than the URL actually has.
    const epochMs =
      Math.floor(
        (input.signedAt === undefined ? nowMs() : parseInstant(input.signedAt, "signedAt")) / 1000,
      ) * 1000;
    const signed = presign({
      method: operation === "get" ? "GET" : "PUT",
      origin: target.origin,
      host: target.host,
      canonicalUri: target.canonicalUri,
      region: input.region,
      service: SERVICE,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
      epochMs,
      expiresInSeconds,
      query: responseOverrides(overrides),
      headers,
    });

    const warnings = [...target.warnings];
    if (creds.sessionToken !== undefined) {
      warnings.push(
        "signed with temporary credentials: the URL also stops working when the session token expires, which is often sooner than expiresAt.",
      );
    }
    if (expiresInSeconds > LONG_LIVED_SECONDS) {
      warnings.push(
        "this URL is a bearer credential for the object for its whole lifetime — anyone who sees it in a log, a referrer header or a chat message can use it until it expires.",
      );
    }

    const sendHeaders = Object.fromEntries(headers);
    const quoted = Object.entries(sendHeaders).map(
      ([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`,
    );
    // `-o <name>`: curl would otherwise write the object to stdout, and the
    // name it would guess from a URL this long is not the object's.
    const filename = input.key.split("/").pop();
    const curl =
      operation === "get"
        ? `curl -fSL -o ${shellQuote(filename === undefined || filename === "" ? "downloaded" : filename)} ${shellQuote(signed.url)}`
        : ["curl -fS -X PUT --upload-file ./FILE", ...quoted, shellQuote(signed.url)].join(" ");

    return json({
      url: signed.url,
      method: operation === "get" ? "GET" : "PUT",
      headers: sendHeaders,
      sendHeadersVerbatim:
        headers.length === 0
          ? "no extra headers: everything signed is already in the URL, so the request needs nothing added. Adding a header that is not listed in signedHeaders is harmless; changing the URL is not."
          : "send every header above exactly as written — they are inside the signature, and a client that adds a charset, changes the case of a value or drops one gets a 403 that does not mention headers.",
      signedHeaders: signed.signedHeaders.split(";"),
      host: target.host,
      addressingStyle: input.addressingStyle,
      bucket: input.bucket,
      key: input.key,
      region: input.region,
      service: SERVICE,
      payloadHash: UNSIGNED_PAYLOAD,
      signedAt: new Date(epochMs).toISOString(),
      expiresAt: new Date(epochMs + expiresInSeconds * 1000).toISOString(),
      expiresInSeconds,
      curl,
      credentialProfile: creds.profile,
      credentials:
        creds.sessionToken === undefined
          ? "the access key id is inside the URL because SigV4 puts it there; the secret key was used to derive the signing key and appears nowhere in this result"
          : // The session token is in the URL too, and saying only that the
            // secret is absent reads as a full account of what is in here.
            // A session token is a live credential with a blast radius far
            // past this one object — worth naming before someone pastes the
            // URL into a ticket.
            "the access key id is inside the URL because SigV4 puts it there, and so is the session token (X-Amz-Security-Token) — SigV4 has nowhere else to carry it, and it is a live credential in its own right, so treat this URL accordingly. The secret key was used to derive the signing key and appears nowhere in this result",
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(input.includeCanonical === true
        ? { canonicalRequest: signed.canonicalRequest, stringToSign: signed.stringToSign }
        : {}),
    });
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const OBJECTSTORE_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([objectPresign]);
