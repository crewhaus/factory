/**
 * What an environment-variable NAME says about its value.
 *
 * Two questions, kept apart:
 *
 *   - Does this name say its value is a credential? (`ANTHROPIC_API_KEY`,
 *     `GITHUB_TOKEN`, `DATABASE_URL`.) A tool that reports on variables,
 *     such as EnvInspect, must never show those values, even to a caller
 *     that names them (flag-truth-4#1, security-8#3, docs-claims#6).
 *   - Is this "name" really a pasted secret? A model asked for the NAME of
 *     a variable sometimes passes the token itself, and `ghp_…` is a legal
 *     variable name as far as a character class is concerned. A refusal
 *     must then not quote it back.
 *
 * The repo already had four copies of the first heuristic, each narrower
 * than the last: the compiler's and preflight's `CREDENTIAL_SHAPED_KEY_RE`
 * (`_KEY|_TOKEN|_SECRET|_PASSWORD` at the end), tool-secrets'
 * `SECRETISH_KEY_RE` (adds PASSPHRASE, CREDENTIALS, PAT), and ir's and
 * spec-patch's `isCredentialKey` (adds camelCase and a few exact words).
 * {@link isCredentialShapedName} flags everything any of them flags;
 * `names.test.ts` finds the copies in the repo and checks that it still does.
 */

/** A POSIX environment-variable name: letters, digits and `_`, not starting with a digit. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Longest name accepted. Real names are short; a long one is a pasted value. */
export const MAX_ENV_NAME_LENGTH = 128;

/** A usable environment-variable name. */
export function isEnvName(name: unknown): name is string {
  return typeof name === "string" && name.length <= MAX_ENV_NAME_LENGTH && ENV_NAME_RE.test(name);
}

/**
 * Words that mark a credential wherever they appear, even run together
 * with other words (`GHTOKEN`, `PGPASSWORD`, `x-api-key`). Matched against
 * the name upper-cased with every separator removed.
 */
const ANYWHERE: readonly string[] = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "APIKEY",
  "PRIVATEKEY",
  "ACCESSKEY",
  "SIGNINGKEY",
  "CONNECTIONSTRING",
  "CONNSTR",
];

/**
 * Words that mark a credential only as a whole word (`API_KEY`, `apiKey`,
 * `GITHUB_PAT`): as a substring they would match `MONKEY`, `PATH` and
 * `BYPASS`.
 */
const WHOLE_WORD: ReadonlySet<string> = new Set([
  "KEY",
  "KEYS",
  "KEYREF",
  "PAT",
  "PATS",
  "AUTH",
  "AUTHS",
  "AUTHORIZATION",
  "PASS",
  "PWD",
  "CREDS",
  "COOKIE",
  "COOKIES",
  "BEARER",
  "BEARERS",
  "DSN",
  "OTP",
  "SALT",
]);

/** A URL-valued variable is a credential when it names one of these: its URL carries a password or IS the secret. */
const URL_WORDS: ReadonlySet<string> = new Set(["URL", "URI", "URLS", "URIS"]);
const SECRET_BEARING_URL_OWNERS: ReadonlySet<string> = new Set([
  "DATABASE",
  "DB",
  "POSTGRES",
  "POSTGRESQL",
  "PG",
  "MYSQL",
  "MARIADB",
  "MONGO",
  "MONGODB",
  "REDIS",
  "AMQP",
  "RABBITMQ",
  "BROKER",
  "SMTP",
  "WEBHOOK",
]);

/**
 * Names that match a word above but are not credentials: the shell's
 * working directories. Exact and case-sensitive, so `pwd` as a config
 * key (a password) is still flagged.
 */
const NOT_CREDENTIALS: ReadonlySet<string> = new Set(["PWD", "OLDPWD"]);

/**
 * The words of a name: split on anything that is not a letter or digit and
 * on camelCase boundaries, upper-cased, trailing digits dropped (`KEY2` is
 * `KEY`). A character-by-character scan, so a caller-sized name costs
 * linear time.
 */
export function nameWords(name: string): string[] {
  const words: string[] = [];
  const kind = (c: string | undefined): "lower" | "upper" | "digit" | "other" => {
    if (c === undefined) return "other";
    if (c >= "a" && c <= "z") return "lower";
    if (c >= "A" && c <= "Z") return "upper";
    if (c >= "0" && c <= "9") return "digit";
    return "other";
  };
  // Indexes into `name`, never a growing string: reading the last character
  // of a string built with `+=` flattens it each time, which made a long
  // name quadratic.
  let start = -1;
  const flush = (end: number): void => {
    if (start < 0) return;
    let stop = end;
    while (stop > start && kind(name[stop - 1]) === "digit") stop -= 1;
    if (stop > start) words.push(name.slice(start, stop).toUpperCase());
    start = -1;
  };
  for (let i = 0; i < name.length; i++) {
    const k = kind(name[i]);
    if (k === "other") {
      flush(i);
      continue;
    }
    if (k === "upper" && start >= 0) {
      const prev = kind(name[i - 1]);
      // `apiKey` → api|Key; `APIKey` → API|Key.
      if (
        prev === "lower" ||
        prev === "digit" ||
        (prev === "upper" && kind(name[i + 1]) === "lower")
      ) {
        flush(i);
      }
    }
    if (start < 0) start = i;
  }
  flush(name.length);
  return words;
}

/**
 * The word that makes `name` look like it holds a credential, or undefined.
 * For messages: `"ANTHROPIC_API_KEY" looks like a credential (KEY)`.
 */
export function credentialShapeOf(name: string): string | undefined {
  if (typeof name !== "string" || name === "" || NOT_CREDENTIALS.has(name)) return undefined;
  const words = nameWords(name);
  const joined = words.join("");
  for (const word of ANYWHERE) if (joined.includes(word)) return word;
  for (const word of words) if (WHOLE_WORD.has(word)) return word;
  if (words.some((w) => URL_WORDS.has(w))) {
    const owner = words.find((w) => SECRET_BEARING_URL_OWNERS.has(w));
    if (owner !== undefined) return `${owner} URL`;
  }
  return undefined;
}

/**
 * Whether `name` (an environment variable, a config key, a header or a
 * query parameter) says its value is a credential. Deliberately broad: a
 * false positive hides a value that was harmless, a false negative shows a
 * key. `PWD` and `OLDPWD` are the only exceptions.
 */
export function isCredentialShapedName(name: string): boolean {
  return credentialShapeOf(name) !== undefined;
}

/**
 * Token formats, by prefix: the union of the lists tool-obs, tool-codehost,
 * tool-notify and tool-crewhaus's spec view each kept. Case-sensitive, and
 * each needs a tail as long as the real format's, so that `NPM_TOKEN`,
 * `HF_HOME`, `sk_config` or `pk_version` are never taken for pasted
 * secrets. (The prefixes with `-` or a space can never be legal names; they
 * are here for callers that judge arbitrary strings.)
 */
const PASTED_PREFIXES: ReadonlyArray<readonly [prefix: string, minTail: number]> = [
  ["ghp_", 20],
  ["gho_", 20],
  ["ghu_", 20],
  ["ghs_", 20],
  ["ghr_", 20],
  ["github_pat_", 20],
  ["glpat-", 10],
  ["glptt-", 10],
  ["gldt-", 10],
  ["sk-", 20],
  ["sk_", 20],
  ["rk_", 20],
  ["pk_", 20],
  ["whsec_", 10],
  ["npm_", 30],
  ["hf_", 30],
  ["dop_v1_", 20],
  ["shpat_", 20],
  ["shpss_", 20],
  ["shpca_", 20],
  ["shppa_", 20],
  ["AIza", 30],
  ["xapp-", 10],
  ["xoxa-", 10],
  ["xoxb-", 10],
  ["xoxe-", 10],
  ["xoxp-", 10],
  ["xoxr-", 10],
  ["xoxs-", 10],
  ["xoxt-", 10],
  ["eyJ", 20],
  ["Bearer ", 8],
  ["bearer ", 8],
];

/**
 * Whether a value given where a variable NAME belongs is really a secret:
 * a known token format, an AWS access key id, a Twilio account sid, or a
 * long random-looking string no one would name a variable. A refusal
 * must then not quote it. Anything that is not even a legal name
 * ({@link isEnvName}) should not be quoted either; this answers for the
 * legal ones.
 */
export function looksLikePastedSecret(value: string): boolean {
  if (typeof value !== "string") return false;
  for (const [prefix, minTail] of PASTED_PREFIXES) {
    if (value.startsWith(prefix) && value.length - prefix.length >= minTail) return true;
  }
  if (/^(?:AKIA|ASIA)[A-Z0-9]{16}$/.test(value)) return true;
  if (/^AC[0-9a-f]{32}$/i.test(value)) return true;
  if (value.length >= 32 && /^[0-9a-fA-F]+$/.test(value)) return true;
  // Names are words joined by `_`; 24+ characters of mixed case and digits
  // with no separator at all is a random string.
  return (
    value.length >= 24 &&
    !value.includes("_") &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /[0-9]/.test(value)
  );
}
