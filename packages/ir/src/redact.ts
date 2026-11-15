/**
 * Credential redaction for HUMAN-READABLE renderings of spec/IR content —
 * changelog diff lines (`spec-patch`) and generated bundle READMEs (`ir`).
 * Two layers:
 *
 *   1. `isCredentialKey` — key-based: a value stored under a key that NAMES
 *      a credential (`api_key`, `botToken`, `headers`, `env`, …) is redacted
 *      wholesale, whatever the value looks like.
 *   2. `maskCredentialTokens` — value-based: strings that are NOT under a
 *      credential key (instructions prose, command args, URLs) are scanned
 *      for well-known credential token shapes (`sk-…`, `ghp_…`, `xoxb-…`,
 *      `AKIA…`, CrewHaus's `ch*_…`, `Bearer <token>`) plus high-length opaque
 *      tokens preceded by key-ish context words. Deliberately conservative: a
 *      bare 32-char identifier with no "key/token/secret/password" context is
 *      left alone so normal prose never gets chewed up.
 *   3. `carriesCredential` — a yes/no screen built on both layers: whether a
 *      value (a permission rule's pattern, a command line) carries a
 *      credential, so the caller can refuse to store or show it at all.
 *      `credentialFormIn` answers which form it found, in a closed vocabulary
 *      (`CREDENTIAL_FORM_WORDS`) that a refusal can name without the value.
 *
 * KEEP IN SYNC: this module is intentionally duplicated as
 * `packages/ir/src/redact.ts` and `packages/spec-patch/src/redact.ts`.
 * `@crewhaus/ir` keeps ZERO package dependencies (its `readme.ts` already
 * mirrors `OUTWARD_TOOL_NAMES` from tool-builder for the same reason) and
 * `spec-patch` is spec-layer infrastructure that must not grow an edge onto
 * the IR layer — so neither package can host the single copy without a new
 * dependency edge. Change one file, change both.
 */

/** Placeholder rendered in place of a value under a credential-carrying key. */
export const REDACTED_VALUE = "[redacted]";

/** Placeholder substituted for a credential-shaped token inside a string. */
export const MASKED_TOKEN = "***";

/**
 * Keys that carry credentials, matched case-insensitively after lowercasing.
 * Aligned with the spec schema's credential carriers (`botToken`,
 * `signingSecret`, `appToken`, `secretToken`, `accessToken`, `appSecret`,
 * `retrieve.apiKey`, wallet `keyRef`) and the compiler's `lowerCredential` /
 * `lowerWalletKeyRef` call sites — see `packages/compiler/src/index.ts` §12.
 * `headers` and `env` are container keys: everything under them redacts.
 */
const CREDENTIAL_KEY_EXACT: ReadonlySet<string> = new Set([
  "key",
  "apikey",
  "api_key",
  "api-key",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "headers",
  "env",
  "keyref",
  "key_ref",
  "key-ref",
  "privatekey",
  "private_key",
  "private-key",
]);

/**
 * Whether a property key names a credential. Suffix matches require a word
 * boundary (snake/kebab/camel) so `api_key` / `botToken` / `GITHUB_TOKEN` /
 * `signingSecret` redact while `monkey` / `max_tokens` don't.
 */
export function isCredentialKey(key: string): boolean {
  const k = key.toLowerCase();
  if (CREDENTIAL_KEY_EXACT.has(k)) return true;
  if (/[_-](?:key|token|secret|password)$/.test(k)) return true;
  return /[a-z0-9](?:Key|Token|Secret|Password)$/.test(key);
}

/** A path segment / standalone word shaped like an opaque credential
 *  (Alchemy/Infura-style `/v2/<key>`): 32+ chars of token alphabet. */
export const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{32,}$/;

/** Well-known credential token shapes, masked wherever they appear. */
const TOKEN_SHAPE_RES: ReadonlyArray<RegExp> = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI/Anthropic/Stripe-style secret keys
  /\bgh[oprsu]_[A-Za-z0-9]{16,}/g, // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[A-Z0-9]{12,}/g, // AWS access key ids
  /\bch[apsi]_[A-Za-z0-9_-]{43,}/g, // CrewHaus session, personal, service and invite secrets
];

/**
 * A CrewHaus scoped token, `chx_<payload>.<mac>`. Its `.<mac>` is OPTIONAL in the
 * pattern, and only a match that carries it is masked: a run of `chx_` with no mac is
 * then consumed whole and the search resumes after it. With the mac required, a run like
 * `chx_-chx_-…` was rescanned to its end from every `chx_` in it, quadratic in the run.
 * No class spans the dot, so neither part can give characters back to the other.
 */
const SCOPED_TOKEN_RE = /\bchx_[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]{43,})?/g;

/** `Bearer <token>` — the scheme word is kept, the token is masked. */
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi;

/**
 * Generic 32+-char opaque token, masked ONLY when preceded by a key-ish
 * context word — `key: XXXX…`, `token=XXXX…` — so hashes/ids in ordinary
 * prose survive. Group 1 (the context) is kept; the token is masked.
 */
const CONTEXTUAL_OPAQUE_RE =
  /\b((?:api[-_ ]?)?(?:key|token|secret|password|credential)s?\b["'\s:=-]{0,5})([A-Za-z0-9+/_-]{32,})/gi;

/**
 * Mask credential-shaped tokens inside a string. Non-credential text is
 * returned unchanged (hit/no-hit cases are unit-tested in both packages).
 */
export function maskCredentialTokens(text: string): string {
  let out = text;
  for (const re of TOKEN_SHAPE_RES) out = out.replace(re, MASKED_TOKEN);
  out = out.replace(SCOPED_TOKEN_RE, (whole: string, mac: string | undefined) =>
    mac === undefined ? whole : MASKED_TOKEN,
  );
  out = out.replace(BEARER_RE, `$1 ${MASKED_TOKEN}`);
  out = out.replace(CONTEXTUAL_OPAQUE_RE, `$1${MASKED_TOKEN}`);
  return out;
}

/**
 * A URL in a value: its scheme through the next space or quote (group 1). A
 * match starts only where a run of scheme characters starts, so each run is
 * scanned once, however long it is.
 */
const URL_IN_TEXT = /(?<![A-Za-z0-9+.-])[0-9+.-]*([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+)/g;
/** `NAME=value`, a variable a command sets. */
const ASSIGNMENT_IN_TEXT = /(?:^|[\s"'])([A-Za-z_][A-Za-z0-9_]*)=[^\s"']/g;
/** `Name: value`, a header line a command sends. */
const HEADER_IN_TEXT = /(?:^|[\s"'])([A-Za-z][A-Za-z0-9-]*)\s*:\s*[^\s/"']/g;

/**
 * The form a credential takes in a value, as {@link credentialFormIn} names it:
 *
 * - `token` — a credential-shaped token (the masker's own shapes);
 * - `url-password` — a URL with a password;
 * - `url-query` — a URL query key that names a credential (`isCredentialKey`);
 * - `url-fragment` — a URL fragment key that names one, or a signature key;
 * - `url-token-user` — a URL whose user name is an opaque token and holds no password;
 * - `signed-url` — a URL query key that carries a signature (`X-Amz-Signature`, `sig`);
 * - `webhook-url` — a webhook URL whose path is its secret (Slack, Discord, Telegram);
 * - `assignment` — a variable a command sets, whose name names a credential;
 * - `header` — a header line whose name names one, or a cookie or authentication header;
 * - `flag` — a command-line flag that names a credential, with a value;
 * - `user-password` — a `user:password` pair given to curl's user options;
 * - `attached-password` — a password attached to a MySQL or MariaDB client's `-p`.
 */
export type CredentialForm =
  | "token"
  | "url-password"
  | "url-query"
  | "url-fragment"
  | "url-token-user"
  | "signed-url"
  | "webhook-url"
  | "assignment"
  | "header"
  | "flag"
  | "user-password"
  | "attached-password";

/** Each {@link CredentialForm} in words. A closed vocabulary: no entry ever holds a value. */
export const CREDENTIAL_FORM_WORDS: Readonly<Record<CredentialForm, string>> = Object.freeze({
  token: "a credential-shaped token",
  "url-password": "a password in a URL",
  "url-query": "a URL query parameter that names a credential",
  "url-fragment": "a credential in a URL fragment",
  "url-token-user": "a token as a URL's user name",
  "signed-url": "a signed URL",
  "webhook-url": "a webhook URL, whose path is its secret",
  assignment: "a variable that names a credential",
  header: "a header that carries a credential",
  flag: "a command-line flag that names a credential",
  "user-password": "a user:password pair",
  "attached-password": "a password attached to -p",
});

/** Header names that carry a credential beside those `isCredentialKey` holds for (lower case). */
const CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "cookie",
  "set-cookie",
  "proxy-authorization",
]);

/**
 * `--name value` or `--name=value` (one dash too): group 1 is the name. The value is
 * what follows the `=` or the spaces, after one optional quote, and starts with
 * neither `-` (the next flag) nor `$` (a variable the shell expands).
 */
const FLAG_IN_TEXT = /(?:^|[\s"'])--?([A-Za-z][A-Za-z0-9_-]*)(?:=|[ \t]+)["']?[^\s"'$-]/g;

/**
 * Flag names that hold a credential's container or file, not the credential: `--env`
 * and `--headers` take a variable or header whose own name the other forms read, and a
 * key or credentials flag given a path names the file that holds it.
 */
const FLAG_CONTAINER_NAMES: ReadonlySet<string> = new Set(["env", "headers"]);
const FLAG_FILE_NAMES: ReadonlySet<string> = new Set([
  "key",
  "private-key",
  "private_key",
  "privatekey",
  "credential",
  "credentials",
]);

/** A file name a key or certificate is kept in. */
const KEY_FILE_RE = /\.(?:pem|key|json|crt|cer|der|p12|pfx|ppk|pub|jks|keystore)$/i;

/** Whether a flag's value reads as a path: it starts with `.`, `/` or `~`, or names a key file. */
function looksLikePath(value: string): boolean {
  return /^[./~]/.test(value) || KEY_FILE_RE.test(value);
}

/** A flag's value from its first character: up to the next space or quote. */
const FLAG_VALUE_AT = /[^\s"']*/y;

/** `--header=Name: value` (one dash too, `headers` too): group 1 is the header's name. */
const HEADER_FLAG_ASSIGNED =
  /(?:^|[\s"'])--?headers?=["']?([A-Za-z][A-Za-z0-9-]*)\s*:\s*[^\s/"']/gi;

/** Whether a header name carries a credential. */
function isCredentialHeader(name: string): boolean {
  const folded = name.toLowerCase();
  return (
    isCredentialKey(name) || CREDENTIAL_HEADER_NAMES.has(folded) || folded.startsWith("x-auth")
  );
}

/** Characters that end a shell segment outside quotes. */
const SEGMENT_SEPARATORS: ReadonlySet<string> = new Set([";", "&", "|", "(", ")", "`", "\n"]);

/** Characters a backslash outside quotes takes literally. */
const ESCAPED_OUTSIDE_QUOTES = /["'\\\s;&|()`$]/;

/** Characters a backslash inside double quotes takes literally. */
const ESCAPED_IN_DOUBLE_QUOTES: ReadonlySet<string> = new Set(['"', "\\", "$", "`"]);

/**
 * A command line's shell segments, each the list of its words with their quotes taken
 * off. One pass that tracks single and double quotes: a segment ends only at a
 * separator outside quotes, and a word only at whitespace outside quotes.
 */
function shellSegments(line: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (quote === '"') {
      const next = line[i + 1];
      if (c === '"') quote = undefined;
      else if (c === "\\" && next !== undefined && ESCAPED_IN_DOUBLE_QUOTES.has(next)) {
        word += next;
        i += 1;
      } else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (
      c === "\\" &&
      i + 1 < line.length &&
      ESCAPED_OUTSIDE_QUOTES.test(line[i + 1] as string)
    ) {
      word += line[i + 1];
      inWord = true;
      i += 1;
    } else if (SEGMENT_SEPARATORS.has(c)) {
      endWord();
      if (words.length > 0) segments.push(words);
      words = [];
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endWord();
  if (words.length > 0) segments.push(words);
  return segments;
}

/** A word as the program it names: its basename, lower-cased, without `.exe`. */
function programName(word: string): string {
  const base = word
    .slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1)
    .toLowerCase();
  return base.endsWith(".exe") ? base.slice(0, -4) : base;
}

/** curl's long options that take `user[:password]`. */
const CURL_USER_LONG_FLAGS: ReadonlySet<string> = new Set(["--user", "--proxy-user"]);

/** curl's short options that take `user[:password]`. */
const CURL_USER_SHORT_FLAGS: ReadonlySet<string> = new Set(["u", "U"]);

/** curl's other short options that take an argument: the rest of a group is that argument. */
const CURL_SHORT_FLAGS_WITH_ARG: ReadonlySet<string> = new Set("AbcCdDeEFHKmoPQrtTwxXyYz");

/** Clients whose `-p<password>` takes the password attached. */
const ATTACHED_PASSWORD_COMMANDS: ReadonlySet<string> = new Set([
  "mysql",
  "mysqldump",
  "mysqladmin",
  "mysqlimport",
  "mysqlcheck",
  "mysqlshow",
  "mariadb",
  "mariadb-dump",
]);

/** The hosts whose webhook URL holds its secret in the path, and the paths that do. */
const SLACK_HOOK_PATH = /^\/(?:services|workflows|triggers)\/[^/]/;
const DISCORD_HOOK_PATH = /^\/api\/(?:v\d{1,3}\/)?webhooks\/[^/]/;
const WEBHOOK_PATHS: ReadonlyMap<string, RegExp> = new Map([
  ["hooks.slack.com", SLACK_HOOK_PATH],
  ["discord.com", DISCORD_HOOK_PATH],
  ["discordapp.com", DISCORD_HOOK_PATH],
  ["ptb.discord.com", DISCORD_HOOK_PATH],
  ["canary.discord.com", DISCORD_HOOK_PATH],
  ["api.telegram.org", /^\/bot[^/]/],
]);

/** Whether a URL query or fragment key carries a signature. */
function isSignatureKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === "signature" || k === "sig" || k.endsWith("-signature") || k.endsWith("_signature");
}

/** The URLs in a value that the parser reads, in order. */
function* urlsIn(value: string): Generator<URL> {
  for (const match of value.matchAll(URL_IN_TEXT)) {
    try {
      yield new URL(match[1] as string);
    } catch {
      // Not a URL the parser reads: the other checks still apply.
    }
  }
}

/** The keys a URL fragment carries, read as parameters whole and after its first `?`. */
function fragmentKeys(fragment: string): string[] {
  const keys = [...new URLSearchParams(fragment).keys()];
  const query = fragment.indexOf("?");
  if (query !== -1) keys.push(...new URLSearchParams(fragment.slice(query + 1)).keys());
  return keys;
}

/** The credential a URL's fragment, user name, signature or webhook path holds. */
function urlFormOf(url: URL): CredentialForm | undefined {
  const fragment = url.hash.slice(1);
  if (fragment !== "") {
    for (const key of fragmentKeys(fragment)) {
      if (isCredentialKey(key) || isSignatureKey(key)) return "url-fragment";
    }
  }
  if (url.username !== "" && url.password === "" && OPAQUE_TOKEN_RE.test(url.username)) {
    return "url-token-user";
  }
  for (const key of url.searchParams.keys()) if (isSignatureKey(key)) return "signed-url";
  const host = url.hostname.toLowerCase();
  const hookPath = WEBHOOK_PATHS.get(host.endsWith(".") ? host.slice(0, -1) : host);
  if (hookPath?.test(url.pathname.toLowerCase())) return "webhook-url";
  return undefined;
}

/** A word with one quote taken off each end. */
function unquoted(word: string): string {
  const start = word.startsWith('"') || word.startsWith("'") ? 1 : 0;
  const end = word.length > start && (word.endsWith('"') || word.endsWith("'")) ? 1 : 0;
  return word.slice(start, word.length - end);
}

/** Whether `given` is `user:secret` with a secret. */
function holdsUserPassword(given: string): boolean {
  const pair = unquoted(given);
  const colon = pair.indexOf(":");
  return colon >= 0 && colon < pair.length - 1;
}

/** What curl's user option at `words[at]` is given, when that word is one. */
function curlUserValue(words: ReadonlyArray<string>, at: number): string | undefined {
  const word = words[at] as string;
  if (CURL_USER_LONG_FLAGS.has(word)) return words[at + 1];
  for (const flag of CURL_USER_LONG_FLAGS) {
    if (word.startsWith(`${flag}=`)) return word.slice(flag.length + 1);
  }
  if (word.length < 2 || word[0] !== "-" || word[1] === "-") return undefined;
  // A short option group: options without an argument, then at most one with it.
  for (let i = 1; i < word.length; i++) {
    const c = word[i] as string;
    if (CURL_USER_SHORT_FLAGS.has(c)) {
      const rest = word.slice(i + 1);
      if (rest === "") return words[at + 1];
      return rest.startsWith("=") ? rest.slice(1) : rest;
    }
    if (CURL_SHORT_FLAGS_WITH_ARG.has(c) || !/[A-Za-z0-9#:]/.test(c)) return undefined;
  }
  return undefined;
}

/** How deep a quoted command inside a command (`sh -c "…"`) is read. */
const MAX_NESTED_COMMANDS = 2;

/**
 * The credential a command line passes in a client's own grammar: curl's user options
 * given `user:password`, or a MySQL or MariaDB client's attached `-p<password>`. Every
 * word of each shell segment that names one of these clients is read, with the words
 * after it in that segment, and a quoted command inside a word is read the same way.
 */
function commandFormOf(line: string, depth: number): CredentialForm | undefined {
  for (const words of shellSegments(line)) {
    let curl = false;
    let attached = false;
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string;
      if (curl) {
        const given = curlUserValue(words, i);
        if (given !== undefined && holdsUserPassword(given)) return "user-password";
      }
      if (attached && word.startsWith("-p") && unquoted(word.slice(2)) !== "") {
        return "attached-password";
      }
      const program = programName(word);
      if (program === "curl") curl = true;
      else if (ATTACHED_PASSWORD_COMMANDS.has(program)) attached = true;
      if (depth < MAX_NESTED_COMMANDS && /[\s;&|()`]/.test(word)) {
        const nested = commandFormOf(word, depth + 1);
        if (nested !== undefined) return nested;
      }
    }
  }
  return undefined;
}

/**
 * The first form of credential a value carries (a permission rule's pattern, a command
 * line), or `undefined` when it carries none. Read in this order: a credential-shaped
 * token anywhere in it (the masker's own shapes); a URL with a password or a query key
 * that names one (`isCredentialKey`); a variable or a header line whose name names one;
 * a URL whose fragment, user name, signature or webhook path holds one; a cookie or
 * authentication header; a flag that names one, with a value; and a client's own
 * `user:password` or attached `-p<password>`.
 */
export function credentialFormIn(value: string): CredentialForm | undefined {
  if (maskCredentialTokens(value) !== value) return "token";
  for (const url of urlsIn(value)) {
    if (url.password !== "") return "url-password";
    for (const key of url.searchParams.keys()) if (isCredentialKey(key)) return "url-query";
  }
  for (const match of value.matchAll(ASSIGNMENT_IN_TEXT)) {
    if (isCredentialKey(match[1] as string)) return "assignment";
  }
  for (const match of value.matchAll(HEADER_IN_TEXT)) {
    if (isCredentialKey(match[1] as string)) return "header";
  }
  for (const url of urlsIn(value)) {
    const form = urlFormOf(url);
    if (form !== undefined) return form;
  }
  for (const match of value.matchAll(HEADER_IN_TEXT)) {
    const name = (match[1] as string).toLowerCase();
    if (CREDENTIAL_HEADER_NAMES.has(name) || name.startsWith("x-auth")) return "header";
  }
  for (const match of value.matchAll(HEADER_FLAG_ASSIGNED)) {
    if (isCredentialHeader(match[1] as string)) return "header";
  }
  for (const match of value.matchAll(FLAG_IN_TEXT)) {
    const name = match[1] as string;
    const folded = name.toLowerCase();
    if (folded.startsWith("no-") || FLAG_CONTAINER_NAMES.has(folded)) continue;
    if (folded !== "cookie" && !isCredentialKey(name)) continue;
    if (FLAG_FILE_NAMES.has(folded)) {
      FLAG_VALUE_AT.lastIndex = (match.index ?? 0) + match[0].length - 1;
      if (looksLikePath(FLAG_VALUE_AT.exec(value)?.[0] ?? "")) continue;
    }
    return "flag";
  }
  return commandFormOf(value, 0);
}

/** Whether a rule value carries a credential: {@link credentialFormIn} finds a form in it. */
export function carriesCredential(value: string): boolean {
  return credentialFormIn(value) !== undefined;
}
