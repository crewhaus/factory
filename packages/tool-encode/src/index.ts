/**
 * @crewhaus/tool-encode — deterministic encoding, hashing and identifier tools.
 *
 * Every tool here is pure: no filesystem, no network, no clock, no ambient
 * randomness. The same input always produces the same bytes. Where a value
 * would normally come from the environment — the current time, entropy for an
 * id — it is an explicit input instead, so a retried step, a replayed run and
 * a test all produce the same answer.
 *
 * The single exception is `Uuid` with `version: "v4"` and no `seed`, which
 * draws from the platform CSPRNG. It says so in its own description, it
 * reports `deterministic: false` in its result, and it offers two
 * deterministic alternatives in the same tool.
 *
 * Each tool is a thin wrapper over a function in `./lib`, which is where the
 * behaviour is tested against published vectors.
 */
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { z } from "zod";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  decodeInput,
  encodeOutput,
  hexToBytes,
  timingSafeEqual,
  utf8ToBytes,
} from "./lib/bytes";
import { CHECKSUM_ALGORITHMS, checksum as checksumOf, toHex32 } from "./lib/checksum";
import { BROKEN_FOR_SECURITY, digest, digestLength, hmac as hmacBytes } from "./lib/hash";
import {
  NANOID_ALPHABET,
  UUID_NAMESPACES,
  nanoId as nanoIdFrom,
  ulid as ulidFrom,
  uuidNamed,
  uuidV4Random,
  uuidV4Seeded,
} from "./lib/ids";
import { JWT_HMAC_ALGORITHMS, claimInstants, decodeJwt, verifyJwt as verifyJwtFn } from "./lib/jwt";
import { slugify as slugifyText } from "./lib/slug";
import { instantToMillis, isoFromMillis } from "./lib/time";
import {
  type UrlEncodeMode,
  buildUrl,
  decodeUrlText,
  encodeUrlText,
  normalizeUrl,
  parseUrl,
} from "./lib/url";

/** Compact JSON — no indentation, since the reader is a model, not a person. */
const json = (value: unknown): string => JSON.stringify(value);

/**
 * Guard for every tool that accepts a large string. Hashing a gigabyte is a
 * job for a streaming hasher over a file, not for a tool whose input arrived
 * inside a context window.
 */
const MAX_INPUT_CHARS = 2_000_000;

function tooLarge(text: string, field: string): string | undefined {
  if (text.length <= MAX_INPUT_CHARS) return undefined;
  return `${field} is ${text.length} characters, over the ${MAX_INPUT_CHARS} limit — work on the file with a streaming tool instead of passing it through a context window`;
}

/**
 * The seed the id at position `index` is drawn from.
 *
 * The index is always appended, even for a batch of one, so that `count: 1`
 * and `count: 10` agree on the first id. Deriving the first id from the bare
 * seed instead would mean a step that asked for one id and a retry that asked
 * for three disagreed about id zero, which is exactly the reproducibility the
 * seed is there to provide.
 */
function derivedSeed(seed: string, index: number): string {
  return `${seed}#${index}`;
}

/** A caller mistake should read as a sentence, not arrive as an exception. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const digestEncoding = z.enum(["hex", "base64", "base64url"]);
const inputEncoding = z.enum(["utf8", "hex", "base64", "base64url"]);
const hashAlgorithm = z.enum(["md5", "sha1", "sha256", "sha384", "sha512"]);
const shaAlgorithm = z.enum(["sha1", "sha256", "sha384", "sha512"]);

// ---------------------------------------------------------------------------
// Hashing

export const hash: RegisteredTool = buildTool({
  name: "Hash",
  description:
    "Hash text with SHA-256, SHA-1, SHA-384, SHA-512, MD5 or Keccak-256 and return the digest as hex, base64 or base64url. Use to fingerprint a payload for caching or change detection, to compare two blobs without holding both, or to check a published checksum. Keccak-256 is the Ethereum hash and is NOT SHA3-256 — same permutation, different padding — so it is the one to ask for when computing a function selector, an event topic or an address.",
  inputSchema: z.object({
    text: z.string().describe("the data to hash"),
    algorithm: hashAlgorithm.optional().describe("defaults to sha256"),
    encoding: digestEncoding.optional().describe("digest output encoding; defaults to hex"),
    inputEncoding: inputEncoding
      .optional()
      .describe("how `text` is encoded; use hex or base64 for binary data"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.text, "text");
    if (oversize !== undefined) return oversize;
    const algorithm = input.algorithm ?? "sha256";
    let bytes: Uint8Array;
    try {
      bytes = decodeInput(input.text, input.inputEncoding ?? "utf8");
    } catch (error) {
      return `could not read text as ${input.inputEncoding ?? "utf8"}: ${message(error)}`;
    }
    const digested = await digest(algorithm, bytes);
    const encoding = input.encoding ?? "hex";
    return json({
      algorithm,
      encoding,
      digest: encodeOutput(digested, encoding),
      digestBytes: digestLength(algorithm),
      inputBytes: bytes.length,
      ...(BROKEN_FOR_SECURITY.includes(algorithm)
        ? {
            warning: `${algorithm} is broken for security use — fine for a checksum, not for a signature or a password`,
          }
        : {}),
    });
  },
});

export const hmac: RegisteredTool = buildTool({
  name: "Hmac",
  description:
    "Compute a keyed HMAC over text with SHA-256, SHA-1, SHA-384 or SHA-512, and optionally compare it to an expected value in constant time. Use to sign an outbound webhook payload, or to verify an inbound one from Stripe, GitHub or Slack before acting on it.",
  inputSchema: z.object({
    message: z.string().describe("the exact bytes that were signed, including any prefix"),
    key: z.string().describe("the shared secret"),
    algorithm: shaAlgorithm.optional().describe("defaults to sha256"),
    keyEncoding: inputEncoding.optional().describe("how `key` is encoded; defaults to utf8"),
    messageEncoding: inputEncoding
      .optional()
      .describe("how `message` is encoded; defaults to utf8"),
    encoding: digestEncoding.optional().describe("signature output encoding; defaults to hex"),
    expected: z
      .string()
      .optional()
      .describe("a signature to compare against, in the same encoding; compared in constant time"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.message, "message");
    if (oversize !== undefined) return oversize;
    const algorithm = input.algorithm ?? "sha256";
    const encoding = input.encoding ?? "hex";
    let signature: string;
    try {
      const key = decodeInput(input.key, input.keyEncoding ?? "utf8");
      const body = decodeInput(input.message, input.messageEncoding ?? "utf8");
      signature = encodeOutput(await hmacBytes(algorithm, key, body), encoding);
    } catch (error) {
      return `could not compute the hmac: ${message(error)}`;
    }
    if (input.expected === undefined) return json({ algorithm, encoding, signature });
    // Compared as BYTES rather than as text, so an expected value that is
    // spelled differently but means the same thing — uppercase hex, base64
    // with or without padding, base64url — still matches. A value that does
    // not decode at all simply does not match.
    let matches: boolean;
    try {
      matches = timingSafeEqual(
        decodeInput(signature, encoding),
        decodeInput(input.expected.trim(), encoding),
      );
    } catch {
      matches = false;
    }
    return json({ algorithm, encoding, signature, matches });
  },
});

export const checksum: RegisteredTool = buildTool({
  name: "Checksum",
  description:
    "Compute a CRC-32 or Adler-32 checksum of text, as hex or as a number. Use to detect accidental corruption, to fill in a zip, gzip or PNG field, or to compare two copies cheaply — never to detect tampering, which needs a hash.",
  inputSchema: z.object({
    text: z.string(),
    algorithm: z.enum(["crc32", "adler32"]).optional().describe("defaults to crc32"),
    encoding: z.enum(["hex", "decimal"]).optional().describe("defaults to hex"),
    inputEncoding: inputEncoding.optional().describe("how `text` is encoded; defaults to utf8"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.text, "text");
    if (oversize !== undefined) return oversize;
    const algorithm = input.algorithm ?? "crc32";
    let bytes: Uint8Array;
    try {
      bytes = decodeInput(input.text, input.inputEncoding ?? "utf8");
    } catch (error) {
      return `could not read text as ${input.inputEncoding ?? "utf8"}: ${message(error)}`;
    }
    const value = checksumOf(algorithm, bytes);
    return json({
      algorithm,
      checksum: (input.encoding ?? "hex") === "hex" ? toHex32(value) : value,
      inputBytes: bytes.length,
      note: "non-cryptographic — detects accidental corruption, not tampering",
    });
  },
});

// ---------------------------------------------------------------------------
// Base64 and hex

export const base64Encode: RegisteredTool = buildTool({
  name: "Base64Encode",
  description:
    "Base64-encode text, with the standard or URL-safe alphabet and padding on or off. Use to put a payload into a JSON field, an Authorization header or a data URI, or to hand binary to an API that only accepts text.",
  inputSchema: z.object({
    text: z.string(),
    urlSafe: z.boolean().optional().describe("use -_ instead of +/; defaults to false"),
    padding: z.boolean().optional().describe("trailing = characters; defaults on, off for urlSafe"),
    inputEncoding: z
      .enum(["utf8", "hex"])
      .optional()
      .describe("how `text` is encoded; use hex to encode arbitrary bytes"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.text, "text");
    if (oversize !== undefined) return oversize;
    let bytes: Uint8Array;
    try {
      bytes = input.inputEncoding === "hex" ? hexToBytes(input.text) : utf8ToBytes(input.text);
    } catch (error) {
      return `could not read text as hex: ${message(error)}`;
    }
    const urlSafe = input.urlSafe ?? false;
    const padding = input.padding ?? !urlSafe;
    return json({
      encoded: bytesToBase64(bytes, { urlSafe, padding }),
      alphabet: urlSafe ? "base64url" : "base64",
      padded: padding,
      inputBytes: bytes.length,
    });
  },
});

export const base64Decode: RegisteredTool = buildTool({
  name: "Base64Decode",
  description:
    "Decode base64 or base64url back to text, hex or base64, tolerating missing padding and embedded newlines. Use to read a JWT segment, a data URI body, a PEM block or any API field that arrived encoded.",
  inputSchema: z.object({
    data: z.string().describe("base64 or base64url; whitespace and missing padding are tolerated"),
    outputEncoding: z
      .enum(["utf8", "hex", "base64"])
      .optional()
      .describe("defaults to utf8; ask for hex when the bytes are not text"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.data, "data");
    if (oversize !== undefined) return oversize;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(input.data);
    } catch (error) {
      return `not valid base64: ${message(error)}`;
    }
    const encoding = input.outputEncoding ?? "utf8";
    if (encoding === "utf8") {
      try {
        return json({ decoded: bytesToUtf8(bytes), encoding, bytes: bytes.length });
      } catch {
        return json({
          encoding: "hex",
          decoded: bytesToHex(bytes),
          bytes: bytes.length,
          note: "the decoded bytes are not valid UTF-8, so they are shown as hex",
        });
      }
    }
    return json({ decoded: encodeOutput(bytes, encoding), encoding, bytes: bytes.length });
  },
});

export const hexEncode: RegisteredTool = buildTool({
  name: "HexEncode",
  description:
    "Hex-encode text, optionally uppercase and with a separator between bytes. Use to show the exact bytes of a string, to produce a colon-separated fingerprint, or to feed a field that expects hex.",
  inputSchema: z.object({
    text: z.string(),
    uppercase: z.boolean().optional(),
    separator: z.string().max(4).optional().describe("placed between bytes, e.g. ':' or ' '"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.text, "text");
    if (oversize !== undefined) return oversize;
    const bytes = utf8ToBytes(input.text);
    return json({
      encoded: bytesToHex(bytes, input.uppercase ?? false, input.separator ?? ""),
      bytes: bytes.length,
    });
  },
});

export const hexDecode: RegisteredTool = buildTool({
  name: "HexDecode",
  description:
    "Decode hex back to text or base64, tolerating 0x prefixes and ':', '-', '_' or whitespace separators. Use to read a hex digest, a fingerprint or a hex-encoded field from a log or an API response.",
  inputSchema: z.object({
    hex: z.string(),
    outputEncoding: z.enum(["utf8", "base64", "base64url"]).optional().describe("defaults to utf8"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.hex, "hex");
    if (oversize !== undefined) return oversize;
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(input.hex);
    } catch (error) {
      return `not valid hex: ${message(error)}`;
    }
    const encoding = input.outputEncoding ?? "utf8";
    try {
      return json({ decoded: encodeOutput(bytes, encoding), encoding, bytes: bytes.length });
    } catch {
      return json({
        encoding: "base64",
        decoded: bytesToBase64(bytes),
        bytes: bytes.length,
        note: "the decoded bytes are not valid UTF-8, so they are shown as base64",
      });
    }
  },
});

// ---------------------------------------------------------------------------
// URLs

export const urlEncode: RegisteredTool = buildTool({
  name: "UrlEncode",
  description:
    "Percent-encode text for a URL, as a single component, as a whole URI, or as form-encoded data. Use before pasting a value into a query string or path segment, so an '&' or '/' in the value stops changing the URL's meaning.",
  inputSchema: z.object({
    text: z.string(),
    mode: z
      .enum(["component", "uri", "form"])
      .optional()
      .describe(
        "component encodes one value (default); uri leaves URL punctuation alone; form uses + for space",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.text, "text");
    if (oversize !== undefined) return oversize;
    try {
      return encodeUrlText(input.text, (input.mode ?? "component") as UrlEncodeMode);
    } catch (error) {
      return message(error);
    }
  },
});

export const urlDecode: RegisteredTool = buildTool({
  name: "UrlDecode",
  description:
    "Decode percent-encoded text, in component, whole-URI or form mode. Use to read a query value, a redirect target or a logged URL back as plain text.",
  inputSchema: z.object({
    text: z.string(),
    mode: z
      .enum(["component", "uri", "form"])
      .optional()
      .describe(
        "component (default) decodes everything; uri keeps reserved characters; form maps + to space",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.text, "text");
    if (oversize !== undefined) return oversize;
    try {
      return decodeUrlText(input.text, (input.mode ?? "component") as UrlEncodeMode);
    } catch (error) {
      return message(error);
    }
  },
});

export const urlParse: RegisteredTool = buildTool({
  name: "UrlParse",
  description:
    "Split a URL into scheme, host, port, path segments, query parameters and fragment, using the same parser a browser uses. Use to read one query parameter or host out of a URL instead of writing a regex that will be wrong for the next URL.",
  inputSchema: z.object({
    url: z.string().describe("an absolute URL, or a relative reference when `base` is given"),
    base: z.string().optional().describe("resolve a relative reference against this"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.url, "url");
    if (oversize !== undefined) return oversize;
    try {
      const parts = parseUrl(input.url, input.base);
      return json({
        ...parts,
        note: parts.password === null ? undefined : "a password in the URL is masked",
      });
    } catch (error) {
      return message(error);
    }
  },
});

export const urlBuild: RegisteredTool = buildTool({
  name: "UrlBuild",
  description:
    "Assemble a URL from scheme, host, port, path, query parameters and fragment, percent-encoding each part correctly. Use instead of string concatenation, which breaks the moment a value contains '&', '#' or a space.",
  inputSchema: z.object({
    scheme: z.string().min(1).describe("https, http, ftp, or any scheme name"),
    host: z.string().min(1).describe("hostname, or hostname:port"),
    port: z.number().int().min(1).max(65535).optional(),
    path: z.string().optional(),
    params: z
      .array(z.object({ key: z.string().min(1), value: z.string() }))
      .optional()
      .describe("appended in order; repeat a key for a repeated parameter"),
    fragment: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    try {
      return buildUrl({
        scheme: input.scheme,
        host: input.host,
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.path !== undefined ? { path: input.path } : {}),
        ...(input.params !== undefined ? { params: input.params } : {}),
        ...(input.fragment !== undefined ? { fragment: input.fragment } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.password !== undefined ? { password: input.password } : {}),
      });
    } catch (error) {
      return message(error);
    }
  },
});

export const urlNormalize: RegisteredTool = buildTool({
  name: "UrlNormalize",
  description:
    "Canonicalize a URL: lowercase the host, drop a default port, resolve dot segments, sort query parameters and optionally strip tracking parameters, the fragment, 'www.' and a trailing slash. Use to de-duplicate a crawl or link list, or to build a stable cache key from a URL.",
  inputSchema: z.object({
    url: z.string(),
    sortQuery: z
      .boolean()
      .optional()
      .describe("defaults to true; turn off for signed URLs whose signature covers the order"),
    stripFragment: z.boolean().optional(),
    stripTrailingSlash: z.boolean().optional(),
    stripWww: z.boolean().optional(),
    stripAuth: z.boolean().optional().describe("remove any user:password in the URL"),
    removeParams: z
      .array(z.string().min(1))
      .optional()
      .describe("parameter names to drop; a trailing * matches a prefix, e.g. utm_*"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.url, "url");
    if (oversize !== undefined) return oversize;
    try {
      const normalized = normalizeUrl(input.url, {
        sortQuery: input.sortQuery ?? true,
        stripFragment: input.stripFragment ?? false,
        stripTrailingSlash: input.stripTrailingSlash ?? false,
        stripWww: input.stripWww ?? false,
        stripAuth: input.stripAuth ?? false,
        removeParams: input.removeParams ?? [],
      });
      return json({ url: normalized, changed: normalized !== input.url });
    } catch (error) {
      return message(error);
    }
  },
});

// ---------------------------------------------------------------------------
// Identifiers

export const uuid: RegisteredTool = buildTool({
  name: "Uuid",
  description:
    "Generate UUIDs: v5 or v3 from a namespace and name (fully deterministic), v4 from a seed (reproducible), or v4 from the system CSPRNG. Use v5 for a stable id derived from a URL or key, and the seeded form inside retried or replayed steps. Plain v4 is the one non-deterministic path in this package and it says so in its result.",
  inputSchema: z.object({
    version: z.enum(["v3", "v4", "v5"]).optional().describe("defaults to v4"),
    namespace: z
      .string()
      .optional()
      .describe(`for v3/v5: a UUID, or one of ${Object.keys(UUID_NAMESPACES).join(", ")}`),
    name: z.string().optional().describe("for v3/v5: the name to hash within the namespace"),
    seed: z
      .string()
      .min(1)
      .optional()
      .describe("for v4: derive the bits from this seed instead of the CSPRNG"),
    count: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe(
        "defaults to 1; v4 only — a v3/v5 id is the hash of its name, so ask once per name",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const version = input.version ?? "v4";
    const count = input.count ?? 1;
    if (version === "v4") {
      const seed = input.seed;
      const ids =
        seed === undefined
          ? Array.from({ length: count }, () => uuidV4Random())
          : // Each id in a batch needs its own seed, or they would all be
            // equal — and the index is appended whatever the count, so the
            // first id of a batch of one and of a batch of ten are the same
            // id. A retry that batches differently must not renumber.
            Array.from({ length: count }, (_, i) => uuidV4Seeded(derivedSeed(seed, i)));
      return json({
        version: "v4",
        deterministic: seed !== undefined,
        uuids: ids,
        ...(seed === undefined
          ? {
              warning:
                "generated from the system CSPRNG — a repeated call returns different ids; pass `seed` for a reproducible one",
            }
          : {
              note: "seeded: reproducible, and therefore not unpredictable — never use as a token",
            }),
      });
    }
    if (input.namespace === undefined || input.name === undefined) {
      return `${version} needs both a namespace and a name`;
    }
    if (count > 1) {
      // A name-based UUID *is* the hash of its name, so there is no honest way
      // to make a batch of them out of one name. Inventing names by appending
      // an index — the obvious implementation — returns ids for "widget0" and
      // "widget1" while reporting the name as "widget", which is worse than
      // refusing.
      return `${version} derives the id from the name itself, so ${count} ids from one name is not a thing it can do — call once per name, or use a seeded v4 for a batch`;
    }
    try {
      const ids = [await uuidNamed(version === "v5" ? 5 : 3, input.namespace, input.name)];
      return json({
        version,
        deterministic: true,
        namespace: UUID_NAMESPACES[input.namespace] ?? input.namespace,
        uuids: ids,
        ...(version === "v3"
          ? { note: "v3 uses MD5; prefer v5 unless something else already uses v3" }
          : {}),
      });
    } catch (error) {
      return message(error);
    }
  },
});

export const ulid: RegisteredTool = buildTool({
  name: "Ulid",
  description:
    "Generate ULIDs — time-sortable 26-character ids — for an explicit instant, with the entropy derived from a seed. Use when ids must sort by creation time in a database key, and pass the run's timestamp so a replay produces the same ids.",
  inputSchema: z.object({
    timestamp: z
      .union([z.string(), z.number()])
      .describe("an ISO-8601 instant, or epoch milliseconds as a number"),
    seed: z.string().min(1).describe("derives the 80 entropy bits; same seed, same id"),
    count: z.number().int().min(1).max(1000).optional().describe("defaults to 1"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    let milliseconds: number;
    try {
      milliseconds = instantToMillis(input.timestamp, "ms");
    } catch (error) {
      return message(error);
    }
    const count = input.count ?? 1;
    try {
      const ids = Array.from({ length: count }, (_, i) =>
        ulidFrom(milliseconds, derivedSeed(input.seed, i)),
      );
      return json({
        timestamp: isoFromMillis(milliseconds) ?? String(milliseconds),
        ulids: ids,
        note: "entropy is seeded, so these are reproducible rather than unpredictable",
      });
    } catch (error) {
      return message(error);
    }
  },
});

export const nanoId: RegisteredTool = buildTool({
  name: "NanoId",
  description:
    "Generate compact URL-safe ids of a chosen length from a seed, using unbiased rejection sampling over the alphabet. Use for short public-facing ids in a test or a replayable run, where a random id would make the run irreproducible.",
  inputSchema: z.object({
    seed: z.string().min(1).describe("same seed and size, same id"),
    size: z.number().int().min(2).max(256).optional().describe("defaults to 21"),
    alphabet: z
      .string()
      .min(2)
      .optional()
      .describe("defaults to nanoid's URL-safe A-Za-z0-9_- set; duplicates are removed"),
    count: z.number().int().min(1).max(1000).optional().describe("defaults to 1"),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const size = input.size ?? 21;
    const alphabet = input.alphabet ?? NANOID_ALPHABET;
    const oversize = tooLarge(alphabet, "alphabet");
    if (oversize !== undefined) return oversize;
    const count = input.count ?? 1;
    try {
      const ids = Array.from({ length: count }, (_, i) =>
        nanoIdFrom(derivedSeed(input.seed, i), size, alphabet),
      );
      return json({
        ids,
        size,
        alphabetSize: new Set([...alphabet]).size,
        note: "seeded, so reproducible and therefore not unpredictable — never use as a token",
      });
    } catch (error) {
      return message(error);
    }
  },
});

export const slugify: RegisteredTool = buildTool({
  name: "Slugify",
  description:
    "Turn a title into a URL-safe slug, folding accented Latin letters to their base letter and collapsing everything else to a separator. Use for permalinks, branch names, filenames and anchor ids. Non-Latin scripts are not romanized — they are kept only with allowUnicode, and otherwise dropped.",
  inputSchema: z.object({
    text: z.string(),
    separator: z.string().max(4).optional().describe("defaults to '-'"),
    lowercase: z.boolean().optional().describe("defaults to true"),
    maxLength: z.number().int().min(1).max(500).optional().describe("cuts at a word boundary"),
    allowUnicode: z
      .boolean()
      .optional()
      .describe("keep non-Latin letters and digits instead of dropping them"),
    replacements: z
      .record(z.string())
      .optional()
      .describe('applied first, longest key first, e.g. {"&": "and"}'),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.text, "text");
    if (oversize !== undefined) return oversize;
    const result = slugifyText(input.text, {
      separator: input.separator ?? "-",
      lowercase: input.lowercase ?? true,
      ...(input.maxLength !== undefined ? { maxLength: input.maxLength } : {}),
      allowUnicode: input.allowUnicode ?? false,
      ...(input.replacements !== undefined ? { replacements: input.replacements } : {}),
    });
    return json({
      slug: result.slug,
      truncated: result.truncated,
      ...(result.empty
        ? {
            note: "the input had no characters this slugifier keeps — try allowUnicode, or supply a fallback",
          }
        : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// JWT

export const jwtDecode: RegisteredTool = buildTool({
  name: "JwtDecode",
  description:
    "Read a JWT's header and payload WITHOUT verifying its signature — decoding is not verification, and every claim it returns is attacker-controlled until JwtVerify says otherwise. Use to inspect a token while debugging: which issuer, which key id, which algorithm, when it expires.",
  inputSchema: z.object({
    token: z.string().describe("a compact JWS; a leading 'Bearer ' is ignored"),
    now: z
      .union([z.string(), z.number()])
      .optional()
      .describe(
        "an ISO instant or epoch seconds; when given, exp and nbf are reported relative to it",
      ),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.token, "token");
    if (oversize !== undefined) return oversize;
    let decoded: ReturnType<typeof decodeJwt>;
    try {
      decoded = decodeJwt(input.token);
    } catch (error) {
      return `not a readable JWT: ${message(error)}`;
    }
    const base = {
      header: decoded.header,
      payload: decoded.payload,
      instants: claimInstants(decoded.payload),
      signaturePresent: decoded.signature !== "",
      verified: false,
      warning: "NOT VERIFIED — the signature was not checked; do not trust these claims",
    };
    if (input.now === undefined) return json(base);
    let nowSeconds: number;
    try {
      nowSeconds = instantToMillis(input.now, "s") / 1000;
    } catch (error) {
      return message(error);
    }
    const nowIso = isoFromMillis(nowSeconds * 1000);
    if (nowIso === undefined) {
      return `now (${input.now}) is outside the range of instants a date can represent`;
    }
    const exp = decoded.payload["exp"];
    const nbf = decoded.payload["nbf"];
    return json({
      ...base,
      now: nowIso,
      expired: typeof exp === "number" ? nowSeconds > exp : null,
      notYetValid: typeof nbf === "number" ? nowSeconds < nbf : null,
      expiresInSeconds: typeof exp === "number" ? Math.round(exp - nowSeconds) : null,
    });
  },
});

export const jwtVerify: RegisteredTool = buildTool({
  name: "JwtVerify",
  description:
    "Verify an HMAC-signed JWT (HS256/HS384/HS512) against a shared secret and an explicit current time, checking exp, nbf and optionally iss, aud and sub. Use before trusting a token. RSA and ECDSA algorithms are refused rather than faked, and the expected algorithm comes from you, never from the token's own header.",
  inputSchema: z.object({
    token: z.string(),
    secret: z.string().min(1).describe("the shared HMAC secret"),
    secretEncoding: inputEncoding.optional().describe("how `secret` is encoded; defaults to utf8"),
    algorithm: z
      .enum(["HS256", "HS384", "HS512"])
      .optional()
      .describe("the algorithm you expect; defaults to HS256"),
    now: z
      .union([z.string(), z.number()])
      .describe("an ISO instant or epoch seconds — this tool never reads a clock"),
    leewaySeconds: z.number().int().min(0).max(86_400).optional().describe("clock-skew allowance"),
    issuer: z.string().optional(),
    audience: z.string().optional(),
    subject: z.string().optional(),
  }),
  readOnly: true,
  concurrencySafe: true,
  execute: async (input) => {
    const oversize = tooLarge(input.token, "token");
    if (oversize !== undefined) return oversize;
    let nowSeconds: number;
    try {
      nowSeconds = instantToMillis(input.now, "s") / 1000;
    } catch (error) {
      return message(error);
    }
    try {
      const result = await verifyJwtFn(
        input.token,
        decodeInput(input.secret, input.secretEncoding ?? "utf8"),
        {
          now: nowSeconds,
          algorithm: input.algorithm ?? "HS256",
          leewaySeconds: input.leewaySeconds ?? 0,
          ...(input.issuer !== undefined ? { issuer: input.issuer } : {}),
          ...(input.audience !== undefined ? { audience: input.audience } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
        },
      );
      return json({
        valid: result.valid,
        signatureValid: result.signatureValid,
        reasons: result.reasons,
        header: result.header,
        payload: result.payload,
        expiresInSeconds: result.expiresInSeconds,
        supportedAlgorithms: JWT_HMAC_ALGORITHMS,
      });
    } catch (error) {
      return `could not verify: ${message(error)}`;
    }
  },
});

/** Every tool this package registers, in the order a catalog should list them. */
export const ENCODE_TOOLS: ReadonlyArray<RegisteredTool> = Object.freeze([
  base64Decode,
  base64Encode,
  checksum,
  hash,
  hexDecode,
  hexEncode,
  hmac,
  jwtDecode,
  jwtVerify,
  nanoId,
  slugify,
  ulid,
  urlBuild,
  urlDecode,
  urlEncode,
  urlNormalize,
  urlParse,
  uuid,
]);

/**
 * Keccak-256, re-exported for the onchain tools.
 *
 * It lives here because it is a hash and this is where the hashes are, and
 * because `@crewhaus/tool-onchain` needs it for selectors, event topics and
 * EIP-712 digests. Two implementations of a hash is one too many.
 */
export { keccak256, keccak256Hex, toHex } from "./lib/keccak";
