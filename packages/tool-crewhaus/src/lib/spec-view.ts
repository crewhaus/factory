/**
 * The SPEC VIEW: one shape-agnostic, sorted projection of a parsed spec, and
 * a semantic diff over two of them.
 *
 * Why a projection rather than reading the `Spec` union directly: a spec has
 * fourteen target shapes and the fleet questions ("what tools does this
 * harness have, what does it talk to, what may it do") are the same for all
 * of them. So the view is built by WALKING the parsed document — the same
 * walk `expandSpecToolCategories` uses, with the same load-bearing guard
 * (`tools` counts only when its value is an array of strings, because
 * `expose.mcp.tools` is a bare string) — and a new shape inherits it for
 * free.
 *
 * Everything here is pure: input is an already-parsed spec object, output is
 * plain data with every list sorted by plain string comparison. No clock, no
 * filesystem, no locale.
 *
 * SECRET HYGIENE. The view names MCP `env` and `headers` KEYS but never
 * their values (a literal secret pasted into a spec is exactly what those
 * values may hold), an `sse` server's endpoint is reduced to origin + path
 * so a token in a query string (or a `user:pass@` in its authority) is not
 * echoed into a report, and a stdio server's ARGV — which is the third place
 * an operator pastes a credential, `["--api-key", "sk-…"]` being the usual
 * shape, and a database URL with its password the next — is redacted by
 * `redactArgs` before it is shown.
 */

import { createHash } from "node:crypto";
import { ENV_REF_RE, UNPARSED_ENV_REF_RE } from "@crewhaus/preflight";
import {
  credentialShapeOf,
  isCredentialShapedName,
  nameWords,
  redactUrlCredentialsInText,
} from "@crewhaus/tool-safety/env";

export type LooseRecord = Record<string, unknown>;

/** One `tools:` array found in the document, with the path that owns it. */
export type ToolSite = {
  /** Dot/bracket path from the document root, e.g. `agent` or `steps[1]`. */
  readonly path: string;
  readonly tools: readonly string[];
};

/** A model slot: which model, and the spec paths that select it. */
export type ModelSlot = { readonly model: string; readonly sources: readonly string[] };

export type McpServerView = {
  readonly name: string;
  readonly transport: string;
  /** stdio: the command that is spawned. */
  readonly command?: string;
  /** stdio: argv after the command, with credential-shaped values redacted. */
  readonly args?: readonly string[];
  /** How many argv entries `redactArgs` replaced. Absent when none were. */
  readonly redactedArgs?: number;
  /** sse: `scheme://host/path` — query string dropped (it can carry a token). */
  readonly endpoint?: string;
  /** Absent `required` means required — the fail-fast default. */
  readonly required: boolean;
  /** Names only. Values are withheld: they may be literal credentials. */
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
  /** Tool names the spec narrows trust flags for (`tool_flags.per_tool`). */
  readonly flaggedTools?: readonly string[];
  /**
   * The trust flags `tool_flags` sets, by name (`destructive`,
   * `requireJustification`; `readOnly` only in a document the schema would
   * refuse): `defaults` for every tool on the server, `perTool` per tool.
   * Absent when the server declares no `tool_flags`.
   */
  readonly toolFlags?: {
    readonly defaults?: readonly string[];
    readonly perTool?: Readonly<Record<string, readonly string[]>>;
  };
};

/**
 * Fingerprints of what a server view withholds — env and header VALUES, the
 * raw argv, an `sse` URL's query, userinfo and fragment — so a diff can say a
 * value CHANGED without either side's value (or a digest of it) ever leaving
 * the process: this table is keyed by the view object and is never part of
 * the view's data, so no report can serialize it. A view that did not come
 * from {@link buildSpecView} in this process has no entry, and a diff then
 * compares what the view shows and nothing more.
 */
type WithheldDigests = {
  readonly env: ReadonlyMap<string, string>;
  readonly headers: ReadonlyMap<string, string>;
  readonly argv?: string;
  readonly url?: string;
};
const WITHHELD = new WeakMap<McpServerView, WithheldDigests>();

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex");
}

function digestMap(record: LooseRecord | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(record ?? {})) out.set(key, digest(value));
  return out;
}

/** The trust flags one `tool_flags` entry sets to true, sorted. */
const TRUST_FLAG_NAMES = ["destructive", "readOnly", "requireJustification"] as const;
function flagsSet(entry: unknown): string[] {
  const record = asRecord(entry);
  if (record === undefined) return [];
  return TRUST_FLAG_NAMES.filter((flag) => record[flag] === true);
}

function toolFlagsView(block: unknown): McpServerView["toolFlags"] | undefined {
  const flags = asRecord(block);
  if (flags === undefined) return undefined;
  const perToolRaw = asRecord(flags["per_tool"]);
  const perTool: Record<string, readonly string[]> = {};
  for (const tool of Object.keys(perToolRaw ?? {}).sort(compareStrings)) {
    perTool[tool] = flagsSet(perToolRaw?.[tool]);
  }
  return {
    ...(flags["defaults"] !== undefined ? { defaults: flagsSet(flags["defaults"]) } : {}),
    ...(perToolRaw !== undefined ? { perTool } : {}),
  };
}

export type PermissionRuleView = { readonly type: string; readonly pattern: string };

export type PermissionsView = {
  /** `default` when the spec declares no mode — the schema's own default. */
  readonly mode: string;
  /** What an unresolved `ask` does on a non-interactive surface. */
  readonly askMode: string;
  readonly rules: readonly PermissionRuleView[];
};

export type SpecView = {
  readonly name: string;
  readonly version?: string;
  readonly target: string;
  /** Top-level keys the spec declares, sorted — the "what is wired" list. */
  readonly blocks: readonly string[];
  readonly models: readonly ModelSlot[];
  readonly toolSites: readonly ToolSite[];
  /** Every tool granted anywhere in the document, de-duplicated and sorted. */
  readonly tools: readonly string[];
  readonly mcpServers: readonly McpServerView[];
  readonly permissions: PermissionsView;
  /** Shape sizes a fleet table wants: step/role/node counts and so on. */
  readonly counts: Readonly<Record<string, number>>;
};

export function asRecord(value: unknown): LooseRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as LooseRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** Plain byte-order comparison — never `localeCompare`, which is locale-dependent. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every `tools:` array in the document, in path order.
 *
 * The array-of-strings guard is load-bearing and is copied from the
 * compiler's category expansion: `expose.mcp.tools` is the string
 * `"chat" | "per-subagent"`, not a tool list.
 */
export function collectToolSites(spec: unknown): ToolSite[] {
  const sites: ToolSite[] = [];
  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    const record = asRecord(node);
    if (record === undefined) return;
    for (const [key, value] of Object.entries(record)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (key === "tools" && isStringArray(value)) {
        // The OWNER of the list reads better than the `tools` key itself:
        // `steps[1]`, not `steps[1].tools`.
        sites.push({ path: path === "" ? "<root>" : path, tools: [...value] });
        continue;
      }
      visit(value, childPath);
    }
  };
  visit(spec, "");
  sites.sort((a, b) => compareStrings(a.path, b.path));
  return sites;
}

/**
 * `scheme://host/path` — the query string is dropped, it can carry a token,
 * and a path segment that holds a key is withheld (`/v2/<key>`,
 * `/mcp/sk-…/sse`; see {@link redactPathSegments}).
 */
function safeEndpoint(raw: unknown): string | undefined {
  const url = asString(raw);
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    // `host` is authority WITHOUT userinfo, so a `https://user:token@h/p`
    // loses the credential here as well as in the query string.
    return `${parsed.protocol}//${parsed.host}${redactPathSegments(parsed.pathname)}`;
  } catch {
    // The schema requires a valid URL, so this is unreachable for a parsed
    // spec; withhold rather than echo an unparsed string that may be a secret.
    return "(unparseable url withheld)";
  }
}

// ---------------------------------------------------------------------------
// argv redaction
// ---------------------------------------------------------------------------

/** What a redacted argv entry is replaced with. */
export const REDACTED = "(redacted)";

/**
 * A value that is a credential on its own evidence: a vendor-prefixed key, a
 * JWT, or a long opaque run of token characters. Path-like and URL-like
 * strings are excluded — `/usr/local/bin/server` and `https://host/x` are
 * long and opaque too, and redacting them would hide what the server IS.
 */
const CREDENTIAL_VALUE_RE =
  /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[abperst]-|xapp-|glpat-|npm_|hf_|dop_v1_|shp(at|ss|ca|pa)_|AKIA|ASIA|AIza|Bearer\s)/;
const JWT_RE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9+/=_-]{32,}$/;

function looksLikeSecretValue(value: string): boolean {
  if (ENV_REF_RE.test(value)) return false; // a reference, not a secret
  if (CREDENTIAL_VALUE_RE.test(value)) return true;
  if (JWT_RE.test(value)) return true;
  // A long opaque run only counts when it mixes letters and digits: a
  // 40-character all-lowercase word is a package name, not a key.
  return OPAQUE_TOKEN_RE.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

/** `scheme://…` — a value whose credential PARTS can be cut out, keeping what it points at. */
const URL_VALUE_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Path segments after which hosted MCP servers and webhooks put a key:
 * Alchemy and Infura `/v2/<key>` and `/v3/<key>`, Zapier `/mcp/<key>/sse`
 * and `/api/mcp/s/<key>/mcp`, Slack `/services/T…/B…/<secret>`, Discord
 * `/api/webhooks/<id>/<token>`.
 */
const KEY_PATH_OWNERS: ReadonlySet<string> = new Set([
  "v1",
  "v2",
  "v3",
  "mcp",
  "s",
  "services",
  "hooks",
  "webhooks",
  "key",
  "keys",
  "token",
  "tokens",
  "apikey",
  "api-key",
  "secret",
  "secrets",
]);

/** A run of key characters, long enough to be a key rather than an id or a word. */
const KEYISH_RE = /^[A-Za-z0-9_-]{16,}$/;

/** Letters AND digits: a key has both; a word, a slug or a number has one kind. */
function mixesLettersAndDigits(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

/**
 * A URL path with every segment that holds a key withheld: one that is a
 * credential on its own evidence (a vendor prefix such as `sk-`, a JWT, a
 * long opaque run), or a run of 16+ key characters mixing letters and digits
 * anywhere after a {@link KEY_PATH_OWNERS} segment. A path segment carries no
 * name to judge it by, so this is shape alone, and errs towards hiding.
 */
function redactPathSegments(path: string): string {
  let owned = false;
  return path
    .split("/")
    .map((segment) => {
      const secret =
        segment !== "" &&
        (looksLikeSecretValue(segment) ||
          (owned && KEYISH_RE.test(segment) && mixesLettersAndDigits(segment)));
      if (KEY_PATH_OWNERS.has(segment.toLowerCase())) owned = true;
      return secret ? REDACTED : segment;
    })
    .join("/");
}

/** Characters that end a URL written inside a longer entry. */
const URL_END_RE = /[\s"'`<>]/;

/**
 * Every `scheme://…` URL inside `text` with its key-bearing path segments
 * withheld (see {@link redactPathSegments}), and a bare `#fragment` that
 * looks like a token (8+ key characters mixing letters and digits, no
 * `name=`) withheld too; tool-safety's URL redaction has already taken the
 * userinfo and the credential-named parameters. A linear scan.
 */
function redactUrlPathsInText(text: string): string {
  if (!text.includes("://")) return text;
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const sep = text.indexOf("://", from);
    if (sep < 0) break;
    let end = sep + 3;
    while (end < text.length && !URL_END_RE.test(text.charAt(end))) end++;
    from = end;
    if (sep === 0 || !/[A-Za-z0-9+.-]/.test(text.charAt(sep - 1))) continue;
    // The authority ends at the first `/`, `?` or `#`; the path runs to `?` or `#`.
    let pathStart = sep + 3;
    while (pathStart < end && !"/?#".includes(text.charAt(pathStart))) pathStart++;
    let pathEnd = pathStart;
    while (pathEnd < end && !"?#".includes(text.charAt(pathEnd))) pathEnd++;
    // Searched only up to the URL's end, so many URLs in one entry stay linear.
    let hash = pathEnd;
    while (hash < end && text.charAt(hash) !== "#") hash++;
    const fragment = hash < end ? text.slice(hash + 1, end) : undefined;
    out += text.slice(copied, pathStart) + redactPathSegments(text.slice(pathStart, pathEnd));
    copied = pathEnd;
    if (
      fragment !== undefined &&
      !fragment.includes("=") &&
      /^[A-Za-z0-9._~+/-]{8,}$/.test(fragment) &&
      mixesLettersAndDigits(fragment)
    ) {
      out += `${text.slice(copied, hash + 1)}${REDACTED}`;
      copied = end;
    }
  }
  return out + text.slice(copied);
}

/**
 * Whether `word` ENDS in a credential word (`KEY`, `APIKEY`, `GHTOKEN`,
 * `BEARER`, `COOKIE`, `SECRETS`, `CONNECTIONSTRING`), by tool-safety's one
 * table of credential words. A word that only STARTS with one —
 * `TOKENFILE`, `PASSWORDLESS`, `SECRETNAME` — names something else: a path,
 * a switch, a name.
 */
function endsInCredentialWord(word: string): boolean {
  // `PW` is a password in a flag or an assignment's last word (`--pw`,
  // `DB_PW=`), but too common a PREFIX of environment names (Playwright's
  // `PW_TEST_…`) for tool-safety's shared table, which flags a word anywhere.
  if (word === "PW") return true;
  // Lower-cased: tool-safety's one exception, `PWD`, is the shell's working
  // directory variable, and `--pwd` is a password.
  const shape = credentialShapeOf(word.toLowerCase());
  return shape !== undefined && (word.endsWith(shape) || word.endsWith(`${shape}S`));
}

/**
 * Whether a `NAME=value`, `"name": value` or header name says its value is a
 * credential: tool-safety's rule, plus a last word of `PW`.
 */
function isCredentialName(name: string): boolean {
  return isCredentialShapedName(name) || nameWords(name).at(-1) === "PW";
}

/**
 * A flag whose VALUE is a credential: its last word, or its last two words
 * run together, end in a credential word — `--api-key`, `--apiKey`,
 * `--oauth2Bearer`, `--accessToken`, `--client-secret`, `--cookie`, `--dsn`,
 * `--connection-string`. Words come from tool-safety's `nameWords`, so a
 * camelCase flag splits the way a separated one does. `--token-file`,
 * `--key-id` and `--secret-name` name something else, and a `--no-…` flag
 * is a switch that takes no value.
 */
function isCredentialFlag(arg: string): boolean {
  if (!arg.startsWith("-")) return false;
  const words = nameWords(arg);
  const last = words[words.length - 1];
  if (last === undefined || words[0] === "NO") return false;
  const lastTwo = words.length > 1 ? `${words[words.length - 2]}${last}` : undefined;
  return endsInCredentialWord(last) || (lastTwo !== undefined && endsInCredentialWord(lastTwo));
}

/**
 * Flags whose value is an HTTP header — `mcp-remote`'s `--header`, curl's
 * `-H`, `mcp-proxy`'s `--headers`/`-H`. Two spellings: one entry,
 * `Name: value`, or two, `Name` then `value` (the form `mcp-proxy`
 * documents). The value is withheld whatever the name: an `sse` server's
 * headers are reported by key only, and this is the same data reached
 * through a stdio bridge.
 */
const HEADER_FLAGS: ReadonlySet<string> = new Set(["--header", "--headers", "-H"]);

/** An HTTP header name (RFC 9110 `token`). */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * `Name: value`, or undefined when the text is not header-shaped. A URL
 * (`tcp://build-host:2375`, `ssh://deploy@host`) and a `host:port`
 * (`localhost:5432`) have a colon too, and docker spells ITS host flag
 * `-H`: neither is a header.
 */
function splitHeader(text: string): { name: string; value: string } | undefined {
  const colon = text.indexOf(":");
  if (colon <= 0) return undefined;
  const name = text.slice(0, colon).trim();
  if (!HEADER_NAME_RE.test(name)) return undefined;
  const value = text.slice(colon + 1);
  if (value.startsWith("//") || /^\d{1,5}(?:[/?#]|$)/.test(value)) return undefined;
  return { name, value };
}

/**
 * The first half of the two-entry header form: a header NAME with no value
 * of its own. A dotted name (`0.0.0.0`, `build.internal`) and `localhost`
 * are docker's `-H HOST`, not a header — no real header name has a dot.
 */
function isBareHeaderName(arg: string): boolean {
  return HEADER_NAME_RE.test(arg) && !arg.includes(".") && arg.toLowerCase() !== "localhost";
}

/**
 * A header value that is only an env REFERENCE — `${AUTH_HEADER}`,
 * `$TOKEN`, `Bearer ${TOKEN}` — which `mcp-remote` substitutes itself (the
 * form its README documents). It carries no secret, and hiding it costs the
 * reader the variable name.
 */
function isEnvRefHeaderValue(value: string): boolean {
  const bare = value.trim().replace(/^(?:Bearer|Basic|Token)\s+/i, "");
  return UNPARSED_ENV_REF_RE.test(bare);
}

/** `Name: (redacted)` — or the text unchanged when there is nothing to hide. */
function redactHeader(text: string): string {
  const header = splitHeader(text);
  if (header === undefined) return text;
  if (header.value.trim() === "" || isEnvRefHeaderValue(header.value)) return text;
  return `${header.name}: ${REDACTED}`;
}

/** A header value given as its own entry: withheld unless empty or an env reference. */
function redactHeaderValue(value: string): string {
  return value.trim() === "" || isEnvRefHeaderValue(value) ? value : REDACTED;
}

/**
 * A bearer credential anywhere in an entry: `Bearer eyJ…` inside a JSON
 * blob or a `KEY=Bearer …` pair. (`Basic` is not matched outside a header:
 * it is an English word too.) The class after the whitespace excludes
 * whitespace, so each match is linear.
 */
const BEARER_TOKEN_RE = /\bBearer(\s+)(?!\$)[A-Za-z0-9._~+/=-]{8,}/g;

/**
 * `NAME=value` inside an entry: an env assignment handed to a wrapper
 * (`docker run -e POSTGRES_PASSWORD=…`, `sh -c "API_KEY=… server"`) or one
 * parameter of a connection string (`Server=db;Password=…`,
 * `jdbc:sqlserver://db:1433;user=sa;password=…`). The name starts the entry
 * or follows whitespace, `;`, `&`, `?`, a quote, `{` or `,`, and the value
 * is quoted (`API_KEY='…'`, `API_KEY="…"`, the forms `sh -c` scripts use) or
 * runs to the next of those. The value's three alternatives start with
 * different characters and every class is disjoint from the one after it, so
 * a match is linear.
 */
const ASSIGNMENT_RE =
  /(^|[\s;&?"'{,])([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s;&"',}]+)/g;

/**
 * `"name": "value"` inside a JSON entry — `--config '{"apiKey":"…"}'`, the
 * form Smithery's CLI takes. Keys are capped at 128 characters and the
 * value's two alternatives are disjoint, so a match is linear.
 */
const JSON_STRING_MEMBER_RE = /"([A-Za-z_$][\w$.-]{0,127})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

/**
 * `'name': 'value'` — the single-quoted spelling of a JSON member that a
 * YAML or JavaScript object literal takes (`--config "{'apiKey':'…'}"`).
 * Linear for the same reasons as {@link JSON_STRING_MEMBER_RE}.
 */
const SINGLE_QUOTED_MEMBER_RE = /'([A-Za-z_$][\w$.-]{0,127})'(\s*:\s*)'((?:[^'\\]|\\.)*)'/g;

/**
 * `user:password@host…` without a scheme — the form `psql`, `mysql` and
 * `redis-cli` take. The user, host and the rest stay. A pinned image
 * (`node:20@sha256:…`) has the same shape and is not one: see
 * {@link IMAGE_DIGEST_RE}.
 */
const BARE_USERINFO_RE = /^([^\s:@/]+):([^\s@/]+)@([^\s@/]+)/;

/** The digest half of an image reference, `sha256:…`: a tag before it is not a password. */
const IMAGE_DIGEST_RE = /^sha\d+:/;

/** Flags whose value is `user:password` (curl's `-u`/`--user`). */
const USERINFO_FLAGS: ReadonlySet<string> = new Set(["-u", "--user"]);

/** `user:password` with the password withheld; a bare user, or `uid:gid`, is left alone. */
function redactUserPassword(value: string): string {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return value;
  const password = value.slice(colon + 1);
  if (/^\d+$/.test(password) || keepsNothingSecret(password)) return value;
  return `${value.slice(0, colon)}:${REDACTED}`;
}

/** A value an earlier rule already cut down to `Bearer (redacted)` or `(redacted)`. */
const ALREADY_REDACTED_RE = /^(?:(?:Bearer|Basic|Token)\s+)?\(redacted\)$/;

function keepsNothingSecret(value: string): boolean {
  return (
    value.trim() === "" ||
    ALREADY_REDACTED_RE.test(value) ||
    ENV_REF_RE.test(value) ||
    isEnvRefHeaderValue(value)
  );
}

/**
 * The credential-carrying PARTS of an entry that is not itself a secret:
 * a URL's userinfo and credential-named query or fragment parameters
 * (`postgresql://admin:…@db/prod`, `https://host/sse?token=…` — the scheme,
 * host and path stay, so the report still says what the server is), a
 * credential header written as one entry (`Authorization: Bearer …`,
 * `X-Api-Key: …`, `Cookie: …`), a `Bearer` credential inside any text, and
 * a credential-named `NAME=value` or JSON `"name": "value"` member.
 */
function redactEmbedded(text: string): string {
  let out = redactUrlPathsInText(redactUrlCredentialsInText(text, REDACTED));
  const bare = BARE_USERINFO_RE.exec(out);
  if (bare !== null && !URL_VALUE_RE.test(out)) {
    const [whole, user, password, host] = bare as unknown as [string, string, string, string];
    if (!keepsNothingSecret(password) && !IMAGE_DIGEST_RE.test(host))
      out = `${user}:${REDACTED}@${host}${out.slice(whole.length)}`;
  }
  const header = splitHeader(out);
  if (header !== undefined && isCredentialName(header.name)) out = redactHeader(out);
  out = out.replace(BEARER_TOKEN_RE, (_m, gap: string) => `Bearer${gap}${REDACTED}`);
  out = out.replace(
    ASSIGNMENT_RE,
    (whole, lead: string, name: string, eq: string, value: string) => {
      const quote = value.startsWith('"') || value.startsWith("'") ? value.charAt(0) : "";
      const inner = quote === "" ? value : value.slice(1, -1);
      return isCredentialName(name) && !keepsNothingSecret(inner)
        ? `${lead}${name}${eq}${quote}${REDACTED}${quote}`
        : whole;
    },
  );
  const member =
    (q: string) =>
    (whole: string, name: string, colon: string, value: string): string =>
      isCredentialName(name) && !keepsNothingSecret(value)
        ? `${q}${name}${q}${colon}${q}${REDACTED}${q}`
        : whole;
  return out
    .replace(JSON_STRING_MEMBER_RE, member('"'))
    .replace(SINGLE_QUOTED_MEMBER_RE, member("'"));
}

/**
 * The value after a credential flag: a URL keeps what it points at and
 * loses its credential parts (`--dsn postgresql://u:…@db/prod`); anything
 * else is withheld whole.
 */
function redactCredentialValue(value: string): string {
  return URL_VALUE_RE.test(value) ? redactEmbedded(value) : REDACTED;
}

/**
 * Redact the credential-shaped entries of an MCP server's argv.
 *
 * Caught, and only these:
 *
 * - `--api-key VALUE` (the entry AFTER a credential flag) and
 *   `--api-key=VALUE` (the half after the `=`); a URL value keeps its
 *   scheme, host and path;
 * - a bare value that is a credential on its own evidence (a vendor-prefixed
 *   key, a JWT, a long opaque token);
 * - `--header VALUE`, `-H VALUE`, `--header=VALUE` and the two-entry
 *   `--headers NAME VALUE`: the header keeps its name and loses its value,
 *   unless the value is only an env reference;
 * - inside any other entry, or the value half of any `--flag=VALUE`: a
 *   URL's userinfo and its credential-named query or fragment parameters, a
 *   credential header written as one entry, a `Bearer` credential, and a
 *   credential-named `NAME=value` or JSON string member.
 *
 * A `$NAME` env reference is shown as written wherever a whole value is
 * one. Exported because the honest thing to do with a redaction rule is
 * test it directly.
 */
export function redactArgs(args: readonly string[]): { args: string[]; redacted: number } {
  const out: string[] = [];
  let redacted = 0;
  let previous: "credential-flag" | "header-flag" | "header-name" | "userinfo-flag" | undefined;
  const push = (value: string, original: string): void => {
    out.push(value);
    if (value !== original) redacted += 1;
  };
  for (const arg of args) {
    const eq = arg.startsWith("-") ? arg.indexOf("=") : -1;
    const after = previous;
    previous = undefined;
    // A `$UPPER_SNAKE` value is an env REFERENCE, not a credential: hiding it
    // costs the reader the variable name and protects nothing.
    if (after === "credential-flag" && !arg.startsWith("-") && !ENV_REF_RE.test(arg)) {
      push(redactCredentialValue(arg), arg);
      continue;
    }
    if (after === "header-name" && !arg.startsWith("-")) {
      push(redactHeaderValue(arg), arg);
      continue;
    }
    if (after === "userinfo-flag" && !arg.startsWith("-")) {
      push(redactEmbedded(redactUserPassword(arg)), arg);
      continue;
    }
    if (after === "header-flag" && !arg.startsWith("-")) {
      if (splitHeader(arg) !== undefined) {
        push(redactHeader(arg), arg);
      } else if (isBareHeaderName(arg)) {
        // `--headers X-Api-Key VALUE`: the name now, the value next.
        push(arg, arg);
        previous = "header-name";
      } else {
        // Not a header at all (docker spells its HOST flag `-H`): only the
        // embedded rules apply.
        push(redactEmbedded(arg), arg);
      }
      continue;
    }
    if (/^-H[^-=]/.test(arg)) {
      // `-HAuthorization: Bearer …`: curl's short flag with its value attached.
      push(`-H${redactHeader(arg.slice(2))}`, arg);
      continue;
    }
    const colon = arg.startsWith("-") && eq === -1 ? arg.indexOf(":") : -1;
    if (colon > 0 && isCredentialFlag(arg.slice(0, colon))) {
      // `--token:VALUE`, the separator some CLIs take in place of `=`.
      const value = arg.slice(colon + 1);
      push(
        value === "" || ENV_REF_RE.test(value)
          ? arg
          : `${arg.slice(0, colon)}:${redactCredentialValue(value)}`,
        arg,
      );
      continue;
    }
    if (eq > 0) {
      const flag = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (HEADER_FLAGS.has(flag)) {
        push(`${flag}=${redactHeader(value)}`, arg);
        continue;
      }
      if (USERINFO_FLAGS.has(flag)) {
        push(`${flag}=${redactEmbedded(redactUserPassword(value))}`, arg);
        continue;
      }
      if (isCredentialFlag(flag) && value.length > 0 && !ENV_REF_RE.test(value)) {
        push(`${flag}=${redactCredentialValue(value)}`, arg);
        continue;
      }
      push(`${flag}=${redactEmbedded(value)}`, arg);
      continue;
    }
    if (!arg.startsWith("-") && looksLikeSecretValue(arg)) {
      push(REDACTED, arg);
      continue;
    }
    push(arg.startsWith("-") ? arg : redactEmbedded(arg), arg);
    if (HEADER_FLAGS.has(arg)) previous = "header-flag";
    else if (USERINFO_FLAGS.has(arg)) previous = "userinfo-flag";
    else if (isCredentialFlag(arg)) previous = "credential-flag";
  }
  return { args: out, redacted };
}

function mcpServerViews(block: unknown): McpServerView[] {
  const servers = asRecord(block);
  if (servers === undefined) return [];
  const out: McpServerView[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const config = asRecord(raw);
    if (config === undefined) continue;
    const env = asRecord(config["env"]);
    const headers = asRecord(config["headers"]);
    const perTool = asRecord(asRecord(config["tool_flags"])?.["per_tool"]);
    const rawArgs = config["args"];
    const args = isStringArray(rawArgs) ? redactArgs(rawArgs) : undefined;
    const toolFlags = toolFlagsView(config["tool_flags"]);
    const view: McpServerView = {
      name,
      transport: asString(config["transport"]) ?? "unknown",
      ...(asString(config["command"]) !== undefined
        ? { command: asString(config["command"]) as string }
        : {}),
      ...(args !== undefined ? { args: args.args } : {}),
      ...(args !== undefined && args.redacted > 0 ? { redactedArgs: args.redacted } : {}),
      ...(safeEndpoint(config["url"]) !== undefined
        ? { endpoint: safeEndpoint(config["url"]) as string }
        : {}),
      required: config["required"] !== false,
      ...(env !== undefined ? { envKeys: Object.keys(env).sort(compareStrings) } : {}),
      ...(headers !== undefined ? { headerKeys: Object.keys(headers).sort(compareStrings) } : {}),
      ...(perTool !== undefined ? { flaggedTools: Object.keys(perTool).sort(compareStrings) } : {}),
      ...(toolFlags !== undefined ? { toolFlags } : {}),
    };
    WITHHELD.set(view, {
      env: digestMap(env),
      headers: digestMap(headers),
      ...(rawArgs !== undefined ? { argv: digest(rawArgs) } : {}),
      ...(typeof config["url"] === "string" ? { url: digest(config["url"]) } : {}),
    });
    out.push(view);
  }
  out.sort((a, b) => compareStrings(a.name, b.name));
  return out;
}

function permissionsView(block: unknown): PermissionsView {
  const permissions = asRecord(block);
  const rawRules = permissions?.["rules"];
  const rules: PermissionRuleView[] = [];
  if (Array.isArray(rawRules)) {
    for (const raw of rawRules) {
      const rule = asRecord(raw);
      const type = asString(rule?.["type"]);
      const pattern = asString(rule?.["pattern"]);
      if (type !== undefined && pattern !== undefined) rules.push({ type, pattern });
    }
  }
  return {
    // The schema's own defaults, made explicit so a diff sees the real
    // posture rather than "absent".
    mode: asString(permissions?.["mode"]) ?? "default",
    askMode: asString(permissions?.["ask_mode"]) ?? "pause",
    rules,
  };
}

/** Container sizes worth a column in a fleet table. */
const COUNTED_PATHS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["steps", ["steps"]],
  ["roles", ["roles"]],
  ["nodes", ["nodes"]],
  ["edges", ["edges"]],
  ["channels", ["channels"]],
  ["hooks", ["hooks"]],
  ["subAgents", ["agent", "sub_agents"]],
  ["modelProfiles", ["models"]],
];

function sizeOf(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  const record = asRecord(value);
  return record !== undefined ? Object.keys(record).length : undefined;
}

function counts(spec: LooseRecord, mcpCount: number, ruleCount: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [label, path] of COUNTED_PATHS) {
    let node: unknown = spec;
    for (const segment of path) {
      node = asRecord(node)?.[segment];
    }
    const size = sizeOf(node);
    if (size !== undefined) out[label] = size;
  }
  out["mcpServers"] = mcpCount;
  out["permissionRules"] = ruleCount;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compareStrings(a, b)));
}

/**
 * Project a parsed spec into the view. `models` comes from the caller
 * (`collectSpecModels` in `@crewhaus/preflight` already resolves `$profile`
 * references against the `models:` registry, and re-implementing that would
 * be a second source of truth).
 */
export function buildSpecView(parsed: unknown, models: readonly ModelSlot[]): SpecView {
  const spec = asRecord(parsed) ?? {};
  const toolSites = collectToolSites(spec);
  const mcpServers = mcpServerViews(spec["mcp_servers"]);
  const permissions = permissionsView(spec["permissions"]);
  const tools = [...new Set(toolSites.flatMap((site) => site.tools))].sort(compareStrings);
  const sortedModels = [...models]
    .map((m) => ({ model: m.model, sources: [...m.sources].sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.model, b.model));
  return {
    name: asString(spec["name"]) ?? "(unnamed)",
    ...(asString(spec["version"]) !== undefined
      ? { version: asString(spec["version"]) as string }
      : {}),
    target: asString(spec["target"]) ?? "(unknown)",
    blocks: Object.keys(spec).sort(compareStrings),
    models: sortedModels,
    toolSites,
    tools,
    mcpServers,
    permissions,
    counts: counts(spec, mcpServers.length, permissions.rules.length),
  };
}

// ---------------------------------------------------------------------------
// semantic diff
// ---------------------------------------------------------------------------

/**
 * One semantic difference. `widens` is the field an operator actually reads:
 * true means the harness can now do something it could not before, or a
 * permission guard got looser.
 */
export type SpecChange = {
  readonly kind: string;
  readonly path: string;
  readonly from?: string;
  readonly to?: string;
  readonly widens: boolean;
};

/**
 * Top-level blocks whose ARRIVAL grants the harness a new outward reach, and
 * which therefore count as widening. Every other block change is reported as
 * a plain change: `memory` or `compaction` appearing alters behaviour but
 * grants no new capability.
 */
export const WIDENING_BLOCKS: ReadonlySet<string> = new Set([
  "chains",
  "contracts",
  "expose",
  "hooks",
  "mcp_servers",
  "plugins",
  "thredz",
  "wallets",
]);

/** Permission modes ordered least → most permissive. */
const MODE_RANK: Readonly<Record<string, number>> = { plan: 0, default: 1, auto: 2 };

function diffSets(
  before: readonly string[],
  after: readonly string[],
): { added: string[]; removed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter((x) => !b.has(x)).sort(compareStrings),
    removed: [...b].filter((x) => !a.has(x)).sort(compareStrings),
  };
}

/** Where each key first appears: the occurrence the first-match rule sees. */
function firstPositions(keys: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  keys.forEach((key, i) => {
    if (!out.has(key)) out.set(key, i);
  });
  return out;
}

/** How much a rule type lets through when it is the first to match. */
const RULE_LEAD: Readonly<Record<string, number>> = {
  alwaysAllow: 0,
  alwaysAsk: 1,
  alwaysDeny: 2,
};
const ruleLead = (key: string): number => RULE_LEAD[key.slice(0, key.indexOf(" "))] ?? 2;

/**
 * Two rules on both sides whose ORDER swapped, when their types differ.
 *
 * The engine takes the first matching rule in declaration order, so
 * `[alwaysDeny X, alwaysAllow X]` denies X and the same two rules reversed
 * allow it. A swap widens when the rule that now comes first lets more
 * through (an allow ahead of an ask or a deny, an ask ahead of a deny); it
 * is conservative in that it does not check the two patterns can match the
 * same call. A widening swap is reported in preference to a narrowing one.
 * Linear in the number of rules.
 */
function ruleReorder(
  before: readonly string[],
  after: readonly string[],
): { first: string; second: string; widens: boolean } | undefined {
  const posBefore = firstPositions(before);
  const posAfter = firstPositions(after);
  const common = [...posBefore.keys()]
    .filter((key) => posAfter.has(key))
    .sort((a, b) => (posBefore.get(a) ?? 0) - (posBefore.get(b) ?? 0));
  // For each lead (0..2), the seen rule of that type that now sits LATEST.
  const latest: Array<{ key: string; at: number } | undefined> = [undefined, undefined, undefined];
  let narrowing: { first: string; second: string; widens: boolean } | undefined;
  for (const key of common) {
    const at = posAfter.get(key) ?? 0;
    const lead = ruleLead(key);
    for (let other = 0; other < latest.length; other++) {
      const seen = latest[other];
      if (other === lead || seen === undefined || seen.at <= at) continue;
      // `seen` came first before, and `key` comes first now.
      if (lead < other) return { first: seen.key, second: key, widens: true };
      narrowing ??= { first: seen.key, second: key, widens: false };
    }
    const current = latest[lead];
    if (current === undefined || current.at < at) latest[lead] = { key, at };
  }
  return narrowing;
}

function sourceToModel(models: readonly ModelSlot[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const slot of models) {
    for (const source of slot.sources) out.set(source, slot.model);
  }
  return out;
}

function toolsByPath(sites: readonly ToolSite[]): Map<string, readonly string[]> {
  return new Map(sites.map((site) => [site.path, site.tools]));
}

/**
 * What changed between two specs, semantically. Textual reordering,
 * comments and whitespace are invisible here by construction: both sides are
 * already-parsed documents.
 *
 * The comparison is deliberately structural, not behavioural — it cannot
 * tell you that an instruction rewrite made an agent bolder, only that a
 * tool was granted, a server added, a rule dropped, a model swapped.
 */
export function diffSpecViews(before: SpecView, after: SpecView): SpecChange[] {
  const changes: SpecChange[] = [];
  const push = (c: SpecChange): void => {
    changes.push(c);
  };

  if (before.target !== after.target) {
    push({ kind: "target", path: "target", from: before.target, to: after.target, widens: false });
  }
  if (before.name !== after.name) {
    push({ kind: "name", path: "name", from: before.name, to: after.name, widens: false });
  }
  if (before.version !== after.version) {
    push({
      kind: "version",
      path: "version",
      ...(before.version !== undefined ? { from: before.version } : {}),
      ...(after.version !== undefined ? { to: after.version } : {}),
      widens: false,
    });
  }

  // models — keyed on the SLOT (`agent.model`, `steps[0].model`), so a swap
  // reads as one change rather than one removal plus one addition.
  const beforeModels = sourceToModel(before.models);
  const afterModels = sourceToModel(after.models);
  for (const source of [...new Set([...beforeModels.keys(), ...afterModels.keys()])].sort(
    compareStrings,
  )) {
    const from = beforeModels.get(source);
    const to = afterModels.get(source);
    if (from === to) continue;
    push({
      kind:
        from === undefined ? "model-slot-added" : to === undefined ? "model-slot-removed" : "model",
      path: source,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      widens: false,
    });
  }

  // tools, per site
  const beforeTools = toolsByPath(before.toolSites);
  const afterTools = toolsByPath(after.toolSites);
  for (const site of [...new Set([...beforeTools.keys(), ...afterTools.keys()])].sort(
    compareStrings,
  )) {
    const { added, removed } = diffSets(beforeTools.get(site) ?? [], afterTools.get(site) ?? []);
    for (const tool of added) {
      push({ kind: "tool-added", path: site, to: tool, widens: true });
    }
    for (const tool of removed) {
      push({ kind: "tool-removed", path: site, from: tool, widens: false });
    }
  }

  // mcp servers
  const beforeServers = new Map(before.mcpServers.map((s) => [s.name, s]));
  const afterServers = new Map(after.mcpServers.map((s) => [s.name, s]));
  for (const name of [...new Set([...beforeServers.keys(), ...afterServers.keys()])].sort(
    compareStrings,
  )) {
    const from = beforeServers.get(name);
    const to = afterServers.get(name);
    const path = `mcp_servers.${name}`;
    if (from === undefined && to !== undefined) {
      push({ kind: "mcp-server-added", path, to: describeServer(to), widens: true });
      continue;
    }
    if (to === undefined && from !== undefined) {
      push({ kind: "mcp-server-removed", path, from: describeServer(from), widens: false });
      continue;
    }
    if (from === undefined || to === undefined) continue;
    for (const change of diffServer(path, from, to)) push(change);
  }

  // permissions
  if (before.permissions.mode !== after.permissions.mode) {
    const fromRank = MODE_RANK[before.permissions.mode] ?? 1;
    const toRank = MODE_RANK[after.permissions.mode] ?? 1;
    push({
      kind: "permission-mode",
      path: "permissions.mode",
      from: before.permissions.mode,
      to: after.permissions.mode,
      widens: toRank > fromRank,
    });
  }
  if (before.permissions.askMode !== after.permissions.askMode) {
    // Neither direction widens: `pause` parks the turn for a human, `deny`
    // refuses it. Both are stricter than allowing the call.
    push({
      kind: "permission-ask-mode",
      path: "permissions.ask_mode",
      from: before.permissions.askMode,
      to: after.permissions.askMode,
      widens: false,
    });
  }
  const ruleKey = (r: PermissionRuleView): string => `${r.type} ${r.pattern}`;
  const beforeRules = before.permissions.rules.map(ruleKey);
  const afterRules = after.permissions.rules.map(ruleKey);
  const rules = diffSets(beforeRules, afterRules);
  const afterPos = firstPositions(afterRules);
  // The first matching rule decides, so an ask placed ahead of a deny can
  // turn that deny into a question for every call both match. One pass finds
  // the last deny, so the check stays linear however many rules are added.
  let lastDeny = -1;
  afterRules.forEach((key, i) => {
    if (key.startsWith("alwaysDeny ")) lastDeny = i;
  });
  for (const key of rules.added) {
    const aheadOfDeny = key.startsWith("alwaysAsk ") && (afterPos.get(key) ?? 0) < lastDeny;
    push({
      kind: "permission-rule-added",
      path: "permissions.rules",
      to: key,
      widens: key.startsWith("alwaysAllow ") || aheadOfDeny,
    });
  }
  const reorder = ruleReorder(beforeRules, afterRules);
  if (reorder !== undefined) {
    push({
      kind: "permission-rules-reordered",
      path: "permissions.rules",
      from: `${reorder.first}, then ${reorder.second}`,
      to: `${reorder.second}, then ${reorder.first}`,
      widens: reorder.widens,
    });
  }
  for (const key of rules.removed) {
    push({
      kind: "permission-rule-removed",
      path: "permissions.rules",
      from: key,
      // Dropping a deny or an ask removes a guard; dropping an allow does not.
      widens: key.startsWith("alwaysDeny ") || key.startsWith("alwaysAsk "),
    });
  }

  // top-level blocks
  const blocks = diffSets(before.blocks, after.blocks);
  for (const block of blocks.added) {
    if (block === "mcp_servers" || block === "permissions" || block === "tools") continue;
    push({ kind: "block-added", path: block, to: block, widens: WIDENING_BLOCKS.has(block) });
  }
  for (const block of blocks.removed) {
    if (block === "mcp_servers" || block === "permissions" || block === "tools") continue;
    push({ kind: "block-removed", path: block, from: block, widens: false });
  }

  changes.sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.from ?? "", b.from ?? "") ||
      compareStrings(a.to ?? "", b.to ?? ""),
  );
  return changes;
}

/**
 * What changed about ONE server present on both sides (security-5#4).
 *
 * A server is what it RUNS and what it runs WITH, so every one of these
 * widens: a different transport, command, argv or endpoint is a different
 * program behind the same tool names (a routine pin bump runs new code that
 * may expose new tools — conservative, and deliberately so); an added `env`
 * or `headers` key hands it something it did not have; a changed value
 * (withheld — see {@link WITHHELD}) may switch it from paper to live; and a
 * trust flag removed (`destructive`, `requireJustification`) or `readOnly`
 * added lets plan and auto mode run its tools without asking. Removing a key
 * or tightening a flag is reported and does not widen. Names only: no value,
 * and no digest of one, is ever put in a change.
 */
function diffServer(path: string, from: McpServerView, to: McpServerView): SpecChange[] {
  const out: SpecChange[] = [];
  const fromText = describeServer(from);
  const toText = describeServer(to);
  if (fromText !== toText) {
    out.push({ kind: "mcp-server", path, from: fromText, to: toText, widens: true });
  }
  const fromDigests = WITHHELD.get(from);
  const toDigests = WITHHELD.get(to);
  if (fromDigests !== undefined && toDigests !== undefined) {
    // Only what the display text above cannot show: a redacted argv entry,
    // or an `sse` URL's query, userinfo or fragment.
    if (fromText === toText && fromDigests.argv !== toDigests.argv) {
      out.push({
        kind: "mcp-server-args-value-changed",
        path,
        to: "a redacted argv value changed (withheld)",
        widens: true,
      });
    }
    if (fromText === toText && fromDigests.url !== toDigests.url) {
      out.push({
        kind: "mcp-server-url-value-changed",
        path,
        to: "a withheld part of the URL changed (its query, userinfo, fragment or a key in its path)",
        widens: true,
      });
    }
  }
  const keyed: ReadonlyArray<
    readonly ["env" | "header", readonly string[] | undefined, readonly string[] | undefined]
  > = [
    ["env", from.envKeys, to.envKeys],
    ["header", from.headerKeys, to.headerKeys],
  ];
  for (const [what, before, after] of keyed) {
    const { added, removed } = diffSets(before ?? [], after ?? []);
    for (const key of added) {
      out.push({ kind: `mcp-server-${what}-added`, path, to: key, widens: true });
    }
    for (const key of removed) {
      out.push({ kind: `mcp-server-${what}-removed`, path, from: key, widens: false });
    }
    const fromValues = what === "env" ? fromDigests?.env : fromDigests?.headers;
    const toValues = what === "env" ? toDigests?.env : toDigests?.headers;
    if (fromValues === undefined || toValues === undefined) continue;
    const kept = (before ?? []).filter((key) => (after ?? []).includes(key));
    for (const key of kept) {
      if (fromValues.get(key) === toValues.get(key)) continue;
      out.push({
        kind: `mcp-server-${what}-value-changed`,
        path,
        to: `${key} (value withheld)`,
        widens: true,
      });
    }
  }
  out.push(...diffToolFlags(path, from.toolFlags, to.toolFlags));
  if (from.required && !to.required) {
    // A peer that may now be absent is a smaller guarantee, not a wider
    // capability — reported, not flagged.
    out.push({
      kind: "mcp-server-optional",
      path,
      from: "required",
      to: "optional",
      widens: false,
    });
  }
  if (!from.required && to.required) {
    out.push({
      kind: "mcp-server-required",
      path,
      from: "optional",
      to: "required",
      widens: false,
    });
  }
  return out;
}

/** A trust flag whose REMOVAL loosens a tool: it asked, or it was gated. */
const TIGHTENING_FLAGS: ReadonlySet<string> = new Set(["destructive", "requireJustification"]);

function diffToolFlags(
  path: string,
  from: McpServerView["toolFlags"],
  to: McpServerView["toolFlags"],
): SpecChange[] {
  const out: SpecChange[] = [];
  const entries: Array<[string, readonly string[], readonly string[]]> = [
    [`${path}.tool_flags.defaults`, from?.defaults ?? [], to?.defaults ?? []],
  ];
  const tools = new Set([...Object.keys(from?.perTool ?? {}), ...Object.keys(to?.perTool ?? {})]);
  for (const tool of [...tools].sort(compareStrings)) {
    entries.push([
      `${path}.tool_flags.per_tool.${tool}`,
      from?.perTool?.[tool] ?? [],
      to?.perTool?.[tool] ?? [],
    ]);
  }
  for (const [flagPath, before, after] of entries) {
    const { added, removed } = diffSets(before, after);
    for (const flag of removed) {
      out.push({
        kind: "mcp-tool-flag-removed",
        path: flagPath,
        from: flag,
        widens: TIGHTENING_FLAGS.has(flag),
      });
    }
    for (const flag of added) {
      // `readOnly` is a GRANT: plan and auto mode run a read-only tool
      // without asking. Every other flag tightens.
      out.push({
        kind: "mcp-tool-flag-added",
        path: flagPath,
        to: flag,
        widens: flag === "readOnly",
      });
    }
  }
  return out;
}

function describeServer(server: McpServerView): string {
  if (server.transport === "stdio") {
    const args =
      server.args !== undefined && server.args.length > 0 ? ` ${server.args.join(" ")}` : "";
    return `stdio:${server.command ?? "?"}${args}`;
  }
  return `${server.transport}:${server.endpoint ?? "?"}`;
}
