/**
 * Credential hygiene for everything the server serializes. Composes the two
 * `@crewhaus/spec-patch` layers — key-based redaction (`isCredentialKey`)
 * and value-shape masking (`maskCredentialTokens`) — into helpers for JSON
 * trees and raw YAML text, and adds the third layer neither of them can be:
 * the harness's own env SCRUBBER.
 *
 * ---------------------------------------------------------------------------
 * THREE LAYERS, AND WHY NONE OF THEM IS ENOUGH ALONE
 * ---------------------------------------------------------------------------
 *   KEY NAME    — `isCredentialKey`: a value under `botToken` / `headers` /
 *                 `env` is redacted whatever it looks like. Blind to prose and
 *                 to a credential parked under an innocent key (`body`,
 *                 `note`, `patch`, an `args[]` element).
 *   VALUE SHAPE — `maskCredentialTokens` (plus the widenings below): catches
 *                 `sk-…`, `ghp_…`, `Bearer …`, and long opaque tokens NEXT TO
 *                 a key-ish word. Blind to a credential with no shape and no
 *                 neighbouring context word.
 *   ENV VALUE   — {@link TextScrubber}: the value this manager demonstrably
 *                 holds, because it read the harness `.env` chain under its
 *                 own environment. Replaces it with its NAME (`«BOT_TOKEN»`)
 *                 whatever it looks like and wherever it sits.
 *
 * The scrubber is the one that closes the opaque-credential hole, and it only
 * closes it where it is APPLIED — so it is threaded through `maskDeep` and
 * applied ONCE at the M3 dispatch site (plus the M1/M2 payload seams), rather
 * than remembered per handler. A handler that forgets it inherits it anyway.
 */
import { REDACTED_VALUE, isCredentialKey, maskCredentialTokens } from "@crewhaus/spec-patch";

/**
 * Rewrites one string on its way out — the harness env scrubber
 * (`createEnvScrubber`), or any equivalent value→name substitution.
 *
 * Structurally identical to `@crewhaus/harness-supervisor`'s `Scrubber`;
 * declared here so this module keeps its single dependency and so a caller
 * can pass a composed or identity scrubber without importing the supervisor.
 */
export type TextScrubber = (text: string) => string;

/**
 * Mask a JSON tree: values under credential-naming keys are replaced
 * wholesale; every other string is scrubbed (when a scrubber is supplied) and
 * then token-shape masked. Arrays/objects are walked; non-string scalars pass
 * through.
 *
 * **Naming hazard — read before adding a response field.** Redaction is by
 * KEY NAME: `isCredentialKey` matches an exact `key` and any camel-case
 * `…Key` / `…Token` / `…Secret` / `…Password`. It cannot tell a secret from
 * a field that merely rhymes with one, and it is applied to EVERY payload
 * this server serves — so a perfectly innocent field name silently becomes
 * `"[redacted]"` with no error and no warning.
 *
 * Six independent M3 areas each lost time to this: `sessionKey` (a routing
 * mode), `filterKey`, `idempotencyKey`, and a bare `key` on a table cell all
 * vanished from their payloads. The convention that works is to NAME AROUND
 * it — `sessionKeyMode`, `filterParam`, `idempotency`, `name` — rather than
 * to widen the matcher, because every exemption is a place a real credential
 * could later hide. If a field must keep a credential-shaped name, prove it
 * carries no secret and add it to a scoped allowlist next to its own reader,
 * never to a global one.
 */
export function maskDeep(value: unknown, scrub?: TextScrubber): unknown {
  return maskTree(value, false, scrub);
}

function maskTree(value: unknown, underCredentialKey: boolean, scrub?: TextScrubber): unknown {
  if (typeof value === "string") {
    if (underCredentialKey) return REDACTED_VALUE;
    return maskText(scrub === undefined ? value : scrub(value));
  }
  if (Array.isArray(value)) {
    // ARGV PAIRS. `["--api-key", "kZ8b…"]` splits the context word from the
    // value across two elements, so no value-shape rule can ever see them
    // adjacent — the flag has to be carried forward explicitly. That is the
    // shape an MCP stdio connector's `args` takes.
    return value.map((v, i) =>
      maskTree(v, underCredentialKey || isCredentialFlag(value[i - 1]), scrub),
    );
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskTree(v, underCredentialKey || isCredentialKey(k), scrub);
    }
    return out;
  }
  return value;
}

/** Mask one free-text document (a transcript chunk, a memory fact, a wiki
 *  body, a continuity note). Key-based redaction does not apply to prose, so
 *  this is value-shape masking only — the same pass `maskDeep` gives every
 *  string it walks. */
export function maskText(text: string): string {
  let out = maskCredentialTokens(text);
  out = maskUrlsIn(out);
  out = out.replace(CAMEL_KEYED_OPAQUE_RE, `$1${MASKED_TOKEN}`);
  out = out.replace(SNAKE_KEYED_OPAQUE_RE, `$1${MASKED_TOKEN}`);
  out = out.replace(ARGV_FLAG_VALUE_RE, `$1${MASKED_TOKEN}$3`);
  return out;
}

// ---------------------------------------------------------------------------
// The value-shape widenings — the two blind spots `maskCredentialTokens` has
// ---------------------------------------------------------------------------

/** Mirrors `MASKED_TOKEN` in `@crewhaus/spec-patch`'s redactor, which the
 *  package index does not re-export. */
const MASKED_TOKEN = "***";

/**
 * `--api-key", "<value>"` — an argv pair rendered as TEXT.
 *
 * `maskDeep` carries a credential flag forward onto the next ARRAY element,
 * which covers the parsed shape. But the same `args` list is also served as
 * spec text (the raw browser, a spec view, a diff), and there the pair is
 * just characters: the flag and its value are separated by `", "`, whose
 * COMMA no keyed rule's separator class allows. So one value was masked when
 * the payload happened to be JSON and verbatim when it happened to be text —
 * the same inconsistency that let the raw browser serve what `/spec`
 * redacted.
 *
 * No length floor here, deliberately. The flag NAMES the value a credential,
 * so its shape is irrelevant — an 8-character key is still a key. The value
 * is bounded and the separators are a fixed-size class, so this cannot
 * backtrack the way a variable-length prefix would.
 */
const ARGV_FLAG_VALUE_RE =
  /(--?[A-Za-z0-9_-]{0,32}(?:key|token|secret|password|credential|auth)["']?[,:=\s]{1,4}["']?)([A-Za-z0-9+/_.-]{8,})(["']?)/gi;

/** Mirrors `OPAQUE_TOKEN_RE` there: a standalone word shaped like an opaque
 *  credential (Alchemy/Infura-style `/v2/<key>`). */
const OPAQUE_SEGMENT_RE = /^[A-Za-z0-9_-]{32,}$/;

/**
 * `signingSecret: <32+ opaque chars>` — the CAMEL-CASE half of the blind
 * spot.
 *
 * `CONTEXTUAL_OPAQUE_RE` opens with `\b` before its context word, and there
 * is no word boundary inside `signingSecret` / `botToken` / `appToken`, so
 * that rule never fires on precisely the keys `isCredentialKey`'s camel-case
 * suffix rule exists for. The two matchers disagreed, and the raw browser
 * served in cleartext what the spec view redacted.
 *
 * The capital letter is load-bearing: `monkey` must NOT match, which is why
 * this is case-SENSITIVE and demands `[a-z0-9]` immediately before `Key`.
 *
 * LOOKBEHIND, NOT A PREFIX GROUP. Every quantifier here is anchored or
 * bounded on purpose: a variable-length prefix (`[A-Za-z0-9_]*`) in front of
 * an alternation backtracks over every split point at every start offset,
 * which is quadratic per line and hangs outright on a 256 KiB document — the
 * exact documents this masker exists to serve.
 */
const CAMEL_KEYED_OPAQUE_RE =
  /(?<=[a-z0-9])((?:Key|Token|Secret|Password|Credential)s?["'\s:=-]{0,5})([A-Za-z0-9+/_-]{32,})/g;

/** `SLACK_SIGNING_SECRET=<32+>` / `bot-token: <32+>` — the same blind spot on
 *  the snake/kebab side, where the `\b` lands inside the word too. The
 *  separator is required (and un-consumed, via lookbehind), so `monkey`
 *  cannot match here either. */
const SNAKE_KEYED_OPAQUE_RE =
  /(?<=[_-])((?:key|token|secret|password|credential)s?["'\s:=-]{0,5})([A-Za-z0-9+/_-]{32,})/gi;

/** A URL anywhere inside a string. The scheme is length-BOUNDED so a long
 *  run of scheme-legal characters with no `://` cannot backtrack quadratically
 *  (see {@link CAMEL_KEYED_OPAQUE_RE}); no real scheme is 32 characters. */
const URL_IN_TEXT_RE = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'`<>()[\]{},\\]+/gi;

/** A `--flag` / `-f` whose NAME says credential. */
const FLAG_RE = /^--?([A-Za-z][A-Za-z0-9_-]*)$/;

function isCredentialFlag(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = FLAG_RE.exec(value);
  return m !== null && isCredentialKey(m[1] as string);
}

function maskUrlsIn(text: string): string {
  if (!text.includes("://")) return text;
  return text.replace(URL_IN_TEXT_RE, (url) => maskUrlCredentials(url));
}

/**
 * Mask the credential-bearing parts of a URL: userinfo, path segments shaped
 * like opaque credentials (`/v2/<key>` → `/v2/***`), and query values that
 * are either credential-NAMED or opaque-shaped.
 *
 * This is where hosted MCP servers put their keys — Alchemy `/v2/<key>`,
 * Zapier `/api/mcp/s/<token>/mcp` — and it is invisible to both other layers:
 * the key sits under the innocent field name `url`, and a path segment has no
 * neighbouring context word for the shape rule to anchor on.
 *
 * Regex-driven rather than `new URL()`: a not-quite-parseable URL must still
 * get masked rather than fall through raw.
 */
function maskUrlCredentials(url: string): string {
  let out = url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/)([^/?#@]*)@/i,
    (whole: string, scheme: string, userinfo: string): string => {
      const colon = userinfo.indexOf(":");
      // `user:password@` — the user identifies, the password never does.
      if (colon !== -1) return `${scheme}${userinfo.slice(0, colon)}:${MASKED_TOKEN}@`;
      // A userinfo with no password is a username (`ssh://git@…`) until it is
      // long enough to be a token instead.
      if (userinfo.length >= 16) return `${scheme}${MASKED_TOKEN}@`;
      return whole;
    },
  );
  const hash = out.indexOf("#");
  const fragment = hash === -1 ? "" : out.slice(hash);
  if (hash !== -1) out = out.slice(0, hash);
  const q = out.indexOf("?");
  const query = q === -1 ? "" : maskQueryValues(out.slice(q));
  const base = q === -1 ? out : out.slice(0, q);
  const origin = base.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i)?.[0] ?? "";
  const path = base
    .slice(origin.length)
    .split("/")
    .map((segment) => (OPAQUE_SEGMENT_RE.test(segment) ? MASKED_TOKEN : segment))
    .join("/");
  return `${origin}${path}${query}${fragment}`;
}

function maskQueryValues(query: string): string {
  return query.replace(
    /([?&;])([^=&;]*)=([^&;]*)/g,
    (whole: string, sep: string, name: string, value: string): string =>
      isCredentialKey(name) || OPAQUE_SEGMENT_RE.test(value)
        ? `${sep}${name}=${MASKED_TOKEN}`
        : whole,
  );
}

// ---------------------------------------------------------------------------
// Key-aware masking of a document served as TEXT
// ---------------------------------------------------------------------------

/** A `$UPPER_SNAKE` env REFERENCE — a name, not a value; safe to show. */
const ENV_REF_VALUE_RE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

/** The same reference as a compiled bundle renders it — still a name, not a
 *  value. Built from parts so this file carries no literal member access. */
const RUNTIME_ENV_VALUE_RE = new RegExp(`^${["process", "env"].join("\\.")}\\b`);

/** `key: value` at the head of a line — optionally quoted (JSON), optionally
 *  a sequence item (YAML). */
const KEYED_SCALAR_LINE_RE = /^([ \t]*(?:- )?)(["']?)([A-Za-z0-9_.-]+)\2:([ \t]*)(.*)$/;

/**
 * Spec keys that LOOK credential-shaped to `isCredentialKey` (which matches a
 * trailing `Key`/`Token`/`Secret`/`Password`) but carry no secret.
 *
 * `sessionKey` is the one that bit: it selects a channel's session-routing
 * MODE — `thread` | `channel` | `user` — so redacting it hid a routing
 * decision from every channel harness's spec view while protecting nothing.
 *
 * Keep this list tiny and evidence-driven. A wrong entry here leaks a
 * credential, which is far worse than the over-redaction it cures.
 */
const NON_CREDENTIAL_SPEC_KEYS: ReadonlySet<string> = new Set(["sessionKey"]);

/**
 * Redaction placeholder, YAML-QUOTED.
 *
 * `[redacted]` unquoted is a flow SEQUENCE — a bare `botToken: [redacted]`
 * re-parses as a one-item list, so the masked document no longer has the
 * shape the original did. Quoting keeps a redacted scalar a scalar.
 */
const REDACTED_YAML_SCALAR = `"${REDACTED_VALUE}"`;

/**
 * Mask any document served as TEXT, line by line, WITHOUT parsing it.
 *
 * KEY-BASED REDACTION FOR TEXT. `maskDeep` redacts by key name, but only for
 * a document that was parsed into a tree — and a document served as text is
 * exactly the case that never was. So this reads the key off the line itself:
 * a scalar under a credential-naming key is redacted unless it is an env
 * REFERENCE (a name the operator needs to see) or a known non-secret key;
 * every other line still passes the value-shape masker, so a credential
 * pasted into prose or parked under an innocent key never survives either.
 *
 * That equivalence is the point. Before it, `GET /spec` answered
 * `signingSecret: "[redacted]"` while the raw browser handed the same bytes
 * over verbatim — and the compiled bundle, where the compiler bakes an inline
 * spec credential in as a literal, was covered by no per-extension special
 * case at all. One line-level rule covers YAML, the compiled bundle,
 * `.ini`/`.properties`, and a truncated JSON document served as text.
 */
export function maskKeyedText(text: string): string {
  const lines = text.split("\n").map((line) => {
    const m = line.match(KEYED_SCALAR_LINE_RE);
    if (m !== null) {
      const [, indent = "", quote = "", key = "", gap = "", rest = ""] = m;
      const value = rest.trim();
      if (
        value !== "" &&
        !value.startsWith("#") &&
        isCredentialKey(key) &&
        !NON_CREDENTIAL_SPEC_KEYS.has(key) &&
        !ENV_REF_VALUE_RE.test(stripQuotes(value)) &&
        !RUNTIME_ENV_VALUE_RE.test(value)
      ) {
        return `${indent}${quote}${key}${quote}:${gap === "" ? " " : gap}${REDACTED_YAML_SCALAR}`;
      }
    }
    return maskText(line);
  });
  return lines.join("\n");
}

/**
 * Mask a YAML spec text (the spec may not parse — masking must still hold).
 * This is {@link maskKeyedText}, the line-level rule, under the name the spec
 * call sites read by.
 */
export function maskSpecYaml(yamlText: string): string {
  return maskKeyedText(yamlText);
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}
