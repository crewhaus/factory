/**
 * M3 · THREDZ — the server-side proxied explorer: wiki, records + schemas,
 * goals/tasks, views, dashboards + cards, listeners, webhooks, connectors,
 * activity, traverse, and API-key administration.
 *
 * ---------------------------------------------------------------------------
 * KEY CUSTODY — the rule the whole module exists to protect
 * ---------------------------------------------------------------------------
 * A Thredz API key lives in the HARNESS's `.env`/spec and nowhere else. Every
 * request here is proxied SERVER-SIDE: the key is read at request time from
 * the harness's own environment, attached to the upstream call, and dropped.
 * It is never:
 *   - returned to the browser (the client calls `/api/h/:id/thredz/*`, never
 *     the Thredz API directly),
 *   - persisted into manager state, the registry, or the rollup cache,
 *   - written into a log line or an error message,
 *   - placed in a URL or query string.
 * The harness-LESS global explorer (`GET /api/thredz`) may use
 * `CREWHAUS_THREDZ_KEY` from the MANAGER's own process environment — still
 * never persisted to manager config. A harness with no key configured is an
 * honest empty state ("no key in this harness"), not an error.
 *
 * Three implementation consequences, each load-bearing:
 *
 *   1. THE SPEC IS THE GATE. A per-harness route activates only when the
 *      harness's `crewhaus.yaml` declares `thredz:`. An ambient
 *      `THREDZ_API_KEY` in the MANAGER's environment can therefore never
 *      silently make a local-wiki harness talk to a hosted workspace — and
 *      the payload says WHERE the value came from (`keySource`), because
 *      "where does this key live" is the first question an operator asks.
 *   2. QUERY + BODY FORWARDING IS A CLOSED VOCABULARY. The upstream API also
 *      accepts a key as `?apiKey=`, so forwarding client query params
 *      verbatim would hand the browser a way to swap the identity this proxy
 *      authenticates with. Every route picks the params it forwards by name.
 *   3. NO KEY MATERIAL COMES BACK. `GET /keys` upstream returns each key's
 *      value; this module strips it from every row BEFORE the payload is
 *      built, on top of `maskDeep`'s key-name redaction at the dispatch site.
 *
 * ---------------------------------------------------------------------------
 * OTHER CONTRACTS THAT ARE EASY TO BREAK
 * ---------------------------------------------------------------------------
 *   - SOFT DELETE ONLY. Every Thredz delete is soft with a restore path. The
 *     manager ships no hard-delete affordance for any Thredz object. The wiki
 *     has a first-class soft delete upstream; RECORDS DO NOT — upstream
 *     `DELETE /records/:id` destroys the document — so a record "delete" here
 *     is an UPDATE that parks the record in the `deleted` status and stashes
 *     the status it had, and restore puts that status back. This module never
 *     issues an upstream DELETE. BOTH HALVES ARE IDEMPOTENT: delete refuses a
 *     record already parked, restore refuses one that is not, and neither
 *     ever writes a `null` status over a live one.
 *   - VISIBILITY IS ALWAYS EXPLICIT. Hangar sets `visibility` on every CREATE,
 *     defaulting to private — the API's shared-by-default behaviour is a
 *     foot-gun the manager neutralizes rather than inherits. An UPDATE sends
 *     `visibility` only when the caller explicitly asked to change it, so an
 *     edit can never silently flip an article public.
 *   - WIKI WRITES CARRY `expectedVersion` and use the same
 *     `stale_article_version` re-read-retry UX as the local wiki
 *     (`wiki-ops.ts`). Identical, deliberately — including the REFUSAL when
 *     an update arrives without one, because a blind write is a lost update
 *     and the local store refuses the byte-identical request.
 *   - AN UPDATE SENDS ONLY WHAT THE CALLER SUPPLIED, and never a body that
 *     newly carries the mask mark. Every article is served masked; a default
 *     or a masked span written back destroys what it replaced.
 *   - THE `## Sources` GATE IS LOCAL-ONLY. Not displayed as a Thredz rule.
 *   - DASHBOARD CARD GRAMMAR IS VALIDATED UPSTREAM AND IT IS FUSSY: KPI
 *     cards require both `display.aggregation` AND `display.aggregationField`;
 *     record filters take a `tags` ARRAY (AND semantics) while task/goal
 *     filters take a SINGULAR `tag`; graph cards are line|bar|pie|dot.
 *     Surface the API's validation messages VERBATIM — paraphrasing them
 *     makes a fixable card look broken.
 *   - FREE-PLAN QUOTAS ARE REAL (3 goals; listeners are plan-quota'd).
 *     Render the quota refusal as a fact, not a failure.
 *   - LISTENER INGEST IS IDEMPOTENCY-KEYED. Preserve the key when replaying.
 *   - THE LOCAL STORE STAYS AUTHORITATIVE. When a harness mirrors its wiki
 *     to Thredz, a degraded mirror is a BADGE — the local store is still the
 *     source of truth and the panel says which backend it is showing.
 *
 * ---------------------------------------------------------------------------
 * THE ANSWER SHAPE — why an upstream refusal is still a 200
 * ---------------------------------------------------------------------------
 * Every route answers 200 with the M3 read envelope (`present`/`note`/`verb`)
 * plus `ok` and, when the upstream refused, a typed `upstream` block carrying
 * the UPSTREAM STATUS and its message verbatim. Propagating that status as
 * this server's status would make a 402 (plan cap) or 429 (rate limit) read
 * as a manager bug, and the console's generic non-2xx path would throw away
 * the very message the screen exists to show — the card-grammar validation
 * text, the stale-version conflict, the quota fact. So the status travels IN
 * the payload and the transport stays honest: 200 means "the manager
 * answered", `ok: false` means "the workspace refused, here is exactly what
 * it said".
 *
 * Upstream responses pass `maskDeep` on the way out like every other payload
 * (they are third-party content); free text this module lifts out by hand
 * (messages, article bodies) additionally passes `maskText`, because
 * key-based redaction cannot see into prose.
 */
import { readFileSync } from "node:fs";
import { parseEnvText } from "./env-file";
import type { M3Context, M3Handler } from "./m3";
import { maskText } from "./mask";
import { resolveInside } from "./safety";

// ---------------------------------------------------------------------------
// transport constants
// ---------------------------------------------------------------------------

/** The hosted workspace, when a spec names no `base_url` of its own. */
export const THREDZ_DEFAULT_BASE = "https://thredz.crewhaus.ai/api";

/** Per-request timeout. Every call carries one: a hung workspace must
 *  degrade this screen to "unreachable", never hold a manager request open. */
export const THREDZ_TIMEOUT_MS = 10_000;

/** Shorter budget for the status probes, which fan out several at once. */
const THREDZ_PROBE_TIMEOUT_MS = 5_000;

/** Cap on rows requested from any upstream list. */
const PAGE_LIMIT = 50;

/** The status a soft-deleted record is parked in (upstream `DELETE` is a hard
 *  delete, so the manager never calls it). */
const DELETED_STATUS = "deleted";

/** Where a soft delete stashes the status it replaced, so restore is exact. */
const RESTORE_FIELD = "hangarRestoreStatus";

/** When the soft delete happened — bookkeeping in the record's own custom
 *  fields, since the API has no record tombstone of its own. */
const DELETED_AT_FIELD = "hangarDeletedAt";

// ---------------------------------------------------------------------------
// the `thredz:` spec block — a lenient scan, never a schema parse
// ---------------------------------------------------------------------------
//
// A fleet manager must render a spec one schema version AHEAD of itself, so
// this reads the block the way the scheduler timeline reads cadences: by
// indentation, tolerantly, with every field optional.

/** What the harness's spec says about its Thredz backend. */
export type ThredzSpecConfig = {
  /** True when `crewhaus.yaml` carries a `thredz:` block that is not `false`. */
  readonly declared: boolean;
  /** Which spelling of the block was found (`thredz: true`, `thredz: $VAR`…). */
  readonly form: "absent" | "disabled" | "boolean" | "string" | "object" | "unreadable";
  /** The env var the `api_key` reference names, when it is a `$VAR` ref. */
  readonly envName: string | null;
  /** True when the spec carries a LITERAL key instead of a `$VAR` reference —
   *  a hygiene problem the panel names, never a value it prints. */
  readonly inlineKey: boolean;
  readonly baseUrl: string;
  /** Hangar's write default. `private` unless the spec says otherwise. */
  readonly defaultVisibility: "private" | "shared";
  readonly goalsMirror: boolean | null;
  readonly agentHandle: string | null;
  readonly messaging: boolean;
};

const ABSENT_CONFIG: ThredzSpecConfig = {
  declared: false,
  form: "absent",
  envName: null,
  inlineKey: false,
  baseUrl: THREDZ_DEFAULT_BASE,
  defaultVisibility: "private",
  goalsMirror: null,
  agentHandle: null,
  messaging: false,
};

const THREDZ_HEADER_RE = /^thredz\s*:/;
const ENV_REF_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

/** Strip surrounding quotes and a trailing ` # comment` from a YAML scalar. */
function cleanScalar(raw: string): string {
  let value = raw.trim();
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;
  if (quote !== undefined && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  const hash = value.indexOf(" #");
  if (hash !== -1) value = value.slice(0, hash).trim();
  return value;
}

/** Leading whitespace width of a line. */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n += 1;
  return n;
}

/** `key: value` inside an already-extracted block, or undefined. */
function scalarIn(block: readonly string[], key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`);
  for (const line of block) {
    const m = line.match(re);
    if (m === null) continue;
    const value = cleanScalar(m[1] ?? "");
    if (value === "" || value.startsWith("#")) continue;
    return value;
  }
  return undefined;
}

/** `$VAR` / `${VAR}` → `VAR`; anything else → null (a literal). */
function envRefName(value: string): string | null {
  return value.match(ENV_REF_RE)?.[1] ?? null;
}

/**
 * Scan a spec's top-level `thredz:` block. Handles all three spellings the
 * schema allows — `thredz: true`, `thredz: $VAR`, and the object form — plus
 * the explicit opt-out `thredz: false`.
 */
export function scanThredzBlock(yamlText: string): ThredzSpecConfig {
  const lines = yamlText.split("\n");
  const headerIndex = lines.findIndex((line) => THREDZ_HEADER_RE.test(line));
  if (headerIndex === -1) return ABSENT_CONFIG;
  const header = lines[headerIndex] as string;
  const inline = cleanScalar(header.slice(header.indexOf(":") + 1));

  if (inline !== "" && !inline.startsWith("#")) {
    if (inline === "false") return { ...ABSENT_CONFIG, form: "disabled" };
    if (inline === "true") {
      return { ...ABSENT_CONFIG, declared: true, form: "boolean", envName: "THREDZ_API_KEY" };
    }
    const name = envRefName(inline);
    return {
      ...ABSENT_CONFIG,
      declared: true,
      form: "string",
      envName: name,
      inlineKey: name === null,
    };
  }

  const block: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const next = lines[i] as string;
    if (next.trim() === "") continue;
    if (indentOf(next) === 0) break;
    block.push(next);
  }
  const apiKey = scalarIn(block, "api_key");
  const name = apiKey === undefined ? null : envRefName(apiKey);
  const visibility = scalarIn(block, "visibility");
  const goals = scalarIn(block, "goals");
  const agents = scalarIn(block, "agents");
  const messaging = scalarIn(block, "messaging");
  const baseUrl = scalarIn(block, "base_url");
  return {
    declared: true,
    form: "object",
    envName: name,
    inlineKey: apiKey !== undefined && name === null,
    baseUrl: baseUrl !== undefined && baseUrl !== "" ? baseUrl : THREDZ_DEFAULT_BASE,
    defaultVisibility: visibility === "shared" ? "shared" : "private",
    goalsMirror: goals === undefined ? null : goals === "true",
    agentHandle: agents === undefined || agents === "false" || agents === "true" ? null : agents,
    messaging: messaging === "true",
  };
}

// ---------------------------------------------------------------------------
// session resolution — the one place a key is ever read
// ---------------------------------------------------------------------------

/** An authenticated upstream session. The `key` never leaves this process. */
type Session = {
  readonly key: string;
  readonly baseUrl: string;
  readonly defaultVisibility: "private" | "shared";
};

/** Where the resolved value came from — a provenance label, never a value. */
type KeySource = "harness-env" | "manager-env" | "spec-literal";

type Resolution = {
  readonly config: ThredzSpecConfig;
  readonly session: Session | null;
  /** Why there is no session, when there is none. Always a sentence. */
  readonly note: string | null;
  readonly keySource: KeySource | null;
  /** Which backend this harness's wiki actually uses right now. */
  readonly backend: "local" | "thredz";
};

/** Read one harness-relative text file through the containment helper. Every
 *  read goes through it per FILE: a listed name can be a symlink out. */
function readContained(ctx: M3Context, segments: readonly string[]): string | undefined {
  let path: string;
  try {
    path = ctx.contain(segments);
  } catch {
    return undefined;
  }
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The harness's own `.env` chain, values included — read to answer "does
 *  this harness carry the key ITSELF", never to serialize anything. */
function harnessEnvVars(ctx: M3Context): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of [".env", ".env.local"]) {
    const text = readContained(ctx, [name]);
    if (text === undefined) continue;
    Object.assign(vars, parseEnvText(text));
  }
  return vars;
}

/**
 * Resolve the per-harness session.
 *
 * The SPEC gates: no `thredz:` block means this harness's wiki is the local
 * store and there is nothing to explore, whatever the environment holds. When
 * the block IS there, the named variable is resolved from the environment a
 * spawn from this harness would actually receive (harness `.env` under the
 * manager's own env — the same layering preflight sees), and the provenance
 * is reported so an operator can see a manager-level variable shadowing the
 * harness's own.
 */
export function resolveHarnessSession(ctx: M3Context): Resolution {
  const yamlText = readContained(ctx, ["crewhaus.yaml"]);
  if (yamlText === undefined) {
    return {
      config: { ...ABSENT_CONFIG, form: "unreadable" },
      session: null,
      note: "this harness has no readable crewhaus.yaml, so its Thredz configuration is unknown",
      keySource: null,
      backend: "local",
    };
  }
  const config = scanThredzBlock(yamlText);
  if (!config.declared) {
    return {
      config,
      session: null,
      note:
        config.form === "disabled"
          ? "this harness's spec sets `thredz: false` — its wiki backend is the local store"
          : "this harness's spec declares no `thredz:` block — its wiki backend is the local store",
      keySource: null,
      backend: "local",
    };
  }
  if (config.inlineKey) {
    // A literal key in a spec is a hygiene problem, not a usable credential
    // path: the spec is committed, diffed and rendered. Refuse to read it and
    // say so, rather than quietly proxying with it.
    return {
      config,
      session: null,
      note: "this harness's `thredz.api_key` is a literal value rather than a `$VAR` reference — move it into the harness's .env and reference it by name; the manager will not read a key out of a committed spec",
      keySource: "spec-literal",
      backend: "thredz",
    };
  }
  const envName = config.envName ?? "THREDZ_API_KEY";
  const value = ctx.env[envName];
  if (value === undefined || value === "") {
    return {
      config,
      session: null,
      note: `this harness declares \`thredz:\` but ${envName} is not set in its environment`,
      keySource: null,
      backend: "thredz",
    };
  }
  const fromHarness = harnessEnvVars(ctx)[envName];
  return {
    config,
    session: {
      key: value,
      baseUrl: config.baseUrl,
      defaultVisibility: config.defaultVisibility,
    },
    note: null,
    keySource: fromHarness !== undefined && fromHarness === value ? "harness-env" : "manager-env",
    backend: "thredz",
  };
}

/**
 * Resolve the harness-LESS global explorer's session from the MANAGER's own
 * process environment. Never persisted; absent is an honest empty state that
 * points at the per-harness explorers instead.
 */
export function resolveGlobalSession(ctx: M3Context): Resolution {
  const key = ctx.env["CREWHAUS_THREDZ_KEY"];
  const base = ctx.env["CREWHAUS_THREDZ_BASE"];
  const config: ThredzSpecConfig = {
    ...ABSENT_CONFIG,
    baseUrl: base !== undefined && base !== "" ? base : THREDZ_DEFAULT_BASE,
    envName: "CREWHAUS_THREDZ_KEY",
  };
  if (key === undefined || key === "") {
    return {
      config,
      session: null,
      note: "no CREWHAUS_THREDZ_KEY in the manager's environment — open a harness that declares `thredz:` to explore its workspace instead",
      keySource: null,
      backend: "local",
    };
  }
  return {
    config,
    session: { key, baseUrl: config.baseUrl, defaultVisibility: "private" },
    note: null,
    keySource: "manager-env",
    backend: "thredz",
  };
}

// ---------------------------------------------------------------------------
// the upstream call
// ---------------------------------------------------------------------------

type UpstreamResult = {
  readonly ok: boolean;
  /** HTTP status, or 0 when the workspace never answered. */
  readonly status: number;
  readonly data: unknown;
  readonly retryAfter: string | null;
};

type CallOptions = {
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  /** Extra request headers (`Idempotency-Key`), never credentials. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

/** The host of a base URL, for error text. A host is not a secret; a key is,
 *  and no code path here puts one in a URL. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "the Thredz API";
  }
}

/**
 * The workspace URL as it may be SHOWN: userinfo stripped.
 *
 * `https://user:secret@host/api` is a legal `base_url`, and a self-hosted
 * workspace behind basic auth is exactly the case that would write one. The
 * credential lives in the URL's userinfo, where `maskDeep`'s key-name
 * redaction cannot see it — so it is removed before the URL is ever part of a
 * payload. The proxy still calls the URL as the operator wrote it.
 */
function displayBase(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.username === "" && url.password === "") return baseUrl;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return baseUrl;
  }
}

/**
 * One authenticated upstream request.
 *
 * The key rides the `Authorization` header (plus the compat `x-api-key` the
 * published client sends) and NEVER the URL. Every call carries a timeout;
 * a transport failure becomes `status: 0` rather than a thrown 500, so the
 * screen degrades to "unreachable" instead of breaking.
 */
async function callThredz(
  session: Session,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<UpstreamResult> {
  const base = session.baseUrl.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${base}${path}`);
  } catch {
    return {
      ok: false,
      status: 0,
      data: { message: `"${session.baseUrl}" is not a usable Thredz API base URL` },
      retryAfter: null,
    };
  }
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const one of value) url.searchParams.append(key, String(one));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${session.key}`,
    "x-api-key": session.key,
    accept: "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const timeoutMs = opts.timeoutMs ?? THREDZ_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // The message is built from the HOST and the error NAME only: a thrown
    // fetch error can echo the request, and the request carries the key in a
    // header.
    const name = err instanceof Error ? err.name : "Error";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    return {
      ok: false,
      status: 0,
      data: {
        message: timedOut
          ? `${hostOf(session.baseUrl)} did not answer within ${Math.round(timeoutMs / 1000)}s`
          : `could not reach ${hostOf(session.baseUrl)} (${name})`,
      },
      retryAfter: null,
    };
  }
  const text = await res.text().catch(() => "");
  let data: unknown = text === "" ? null : text;
  if (text !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      // A non-JSON body (an HTML error page from a proxy) stays as text.
    }
  }
  return { ok: res.ok, status: res.status, data, retryAfter: res.headers.get("retry-after") };
}

// ---------------------------------------------------------------------------
// failure classification — one choke point, keyed on status + machine code
// ---------------------------------------------------------------------------

/** The failure classes this surface distinguishes. None is a manager bug. */
export type ThredzFailureClass =
  | "auth"
  | "billing"
  | "quota"
  | "rate-limit"
  | "validation"
  | "conflict"
  | "not-found"
  | "forbidden"
  | "unreachable"
  | "upstream-error";

export type ThredzFailure = {
  /** The UPSTREAM status (0 = never answered), so a 402 never reads as ours. */
  readonly status: number;
  readonly code: string | null;
  readonly failureClass: ThredzFailureClass;
  /** The upstream's own message, VERBATIM (masked, never paraphrased). */
  readonly message: string;
  /** Field-level details — schema/card validation carries these. */
  readonly details: readonly string[];
  /** What an operator can do about it, when there is something. */
  readonly remediation: string | null;
  readonly retryAfter: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Map an upstream refusal onto a class plus its verbatim message.
 *
 * Keyed on the STATUS and the body's machine `code` — never on the
 * remediation prose, so wording changes upstream cannot reclassify a failure.
 * The message is the upstream's own text (the API answers `message` on most
 * routes and `error` on the wiki ones) so a card-grammar refusal reaches the
 * operator exactly as written.
 */
export function classifyThredzFailure(result: UpstreamResult): ThredzFailure {
  const body = asRecord(result.data);
  const code = stringField(body["code"]);
  const raw =
    stringField(body["message"]) ??
    stringField(body["error"]) ??
    (typeof result.data === "string" && result.data !== "" ? result.data : null) ??
    (result.status === 0 ? "the Thredz API did not answer" : `HTTP ${result.status}`);
  const details = Array.isArray(body["errors"])
    ? body["errors"].map((e) => maskText(typeof e === "string" ? e : JSON.stringify(e)))
    : [];
  const status = result.status;
  let failureClass: ThredzFailureClass;
  let remediation: string | null = null;
  if (status === 0) {
    failureClass = "unreachable";
    remediation = "the workspace is unreachable — this panel is showing nothing, not zero";
  } else if (status === 402 || code === "quota_exceeded" || code === "upgrade_required") {
    failureClass = "quota";
    remediation = "a plan limit, not a fault — the write was not saved";
  } else if (status === 403 && /disabled/i.test(raw)) {
    failureClass = "billing";
    remediation =
      "the key is disabled, usually a lapsed subscription — re-enable it in the Thredz account portal";
  } else if (status === 401) {
    failureClass = "auth";
    remediation = "no key reached Thredz — check the variable the spec's `thredz.api_key` names";
  } else if (status === 403 && code !== null && /wiki_(access|permission)/.test(code)) {
    failureClass = "forbidden";
    remediation = "this key has no (or too low a) wiki grant";
  } else if (status === 403) {
    failureClass = "auth";
    remediation = "Thredz rejected this key — check it for typos or regenerate it";
  } else if (status === 404) {
    failureClass = "not-found";
  } else if (status === 409) {
    failureClass = "conflict";
    remediation =
      code === "stale_article_version"
        ? "the article moved under you — re-read it, then re-apply the edit"
        : null;
  } else if (status === 400 || status === 422) {
    failureClass = "validation";
  } else if (status === 429) {
    failureClass = "rate-limit";
    remediation = `rate limited — retry after ${result.retryAfter ?? "a few"} seconds`;
  } else {
    failureClass = "upstream-error";
  }
  return {
    status,
    code,
    failureClass,
    message: maskText(raw),
    details,
    remediation,
    retryAfter: result.retryAfter,
  };
}

// ---------------------------------------------------------------------------
// the answer envelope
// ---------------------------------------------------------------------------

type Extra = Record<string, unknown>;

/** Fields every answer carries, so the console never has to branch on shape. */
function envelope(
  ctx: M3Context,
  fields: {
    readonly present: boolean;
    readonly note: string | null;
    readonly verb: string | null;
    readonly ok: boolean;
    readonly upstream?: ThredzFailure | null;
    readonly resolution: Resolution;
  },
  extra: Extra,
): Extra {
  const { resolution } = fields;
  return {
    present: fields.present,
    note: fields.note,
    verb: fields.verb,
    ok: fields.ok,
    upstream: fields.upstream ?? null,
    fetchedAt: new Date(ctx.now()).toISOString(),
    backend: resolution.backend,
    keyPresent: resolution.session !== null,
    keySource: resolution.keySource,
    workspace: displayBase(resolution.session?.baseUrl ?? resolution.config.baseUrl),
    defaultVisibility: resolution.config.defaultVisibility,
    ...extra,
  };
}

/** The "no key here" answer: honest, empty, and it names what is missing. */
function keyless(ctx: M3Context, r: Resolution, verb: string | null, extra: Extra): Extra {
  return envelope(
    ctx,
    { present: false, note: r.note, verb, ok: false, resolution: r },
    { ...extra, unconfigured: true },
  );
}

/** An upstream refusal, rendered as a fact rather than a broken screen. */
function refused(
  ctx: M3Context,
  r: Resolution,
  result: UpstreamResult,
  verb: string | null,
  extra: Extra,
): Extra {
  const failure = classifyThredzFailure(result);
  return envelope(
    ctx,
    { present: false, note: failure.message, verb, ok: false, upstream: failure, resolution: r },
    extra,
  );
}

/** A successful read. `present` is about DATA, not about the request. */
function answered(
  ctx: M3Context,
  r: Resolution,
  opts: { readonly present: boolean; readonly note?: string | null; readonly verb?: string | null },
  extra: Extra,
): Extra {
  return envelope(
    ctx,
    {
      present: opts.present,
      note: opts.note ?? null,
      verb: opts.verb ?? null,
      ok: true,
      resolution: r,
    },
    extra,
  );
}

/** A write the MANAGER itself refused (a missing argument, an unconfirmed
 *  destructive step). Still a 200: it is an answer, not a fault. */
function declined(ctx: M3Context, r: Resolution, note: string, extra: Extra = {}): Extra {
  return envelope(ctx, { present: false, note, verb: null, ok: false, resolution: r }, extra);
}

// ---------------------------------------------------------------------------
// small shared readers
// ---------------------------------------------------------------------------

/** Pull an array out of an upstream body that may be bare or wrapped. */
function arrayFrom(data: unknown, ...keys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  const body = asRecord(data);
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** The `pagination` block upstream attaches to its list routes, or null. */
function paginationFrom(data: unknown): unknown {
  const value = asRecord(data)["pagination"];
  return typeof value === "object" && value !== null ? value : null;
}

/** Read query params by NAME — the closed vocabulary a route forwards. */
function pick(
  query: URLSearchParams,
  names: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of names) {
    const value = query.get(name);
    if (value !== null && value !== "") out[name] = value;
  }
  return out;
}

/** A positive integer query param, clamped. */
function intParam(query: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = query.get(name);
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** Strip anything key-shaped from an upstream key row BEFORE it is a payload.
 *  `maskDeep` would redact a `key` field at the dispatch site anyway; this
 *  makes the value's absence a property of the code, not of the masker. */
function keyMetadata(row: unknown): Extra {
  const doc = asRecord(row);
  return {
    id: stringField(doc["_id"]) ?? stringField(doc["id"]),
    owner: stringField(doc["owner"]),
    permissions: stringField(doc["permissions"]),
    accountId: stringField(doc["accountId"]),
    createdAt: stringField(doc["createdAt"]),
    updatedAt: stringField(doc["updatedAt"]),
    disabled: doc["disabled"] === true || doc["userDisabled"] === true,
  };
}

/** A body field that must be a plain object, or `{}`. */
function objectField(body: Readonly<Record<string, unknown>>, key: string): Extra {
  return asRecord(body[key]);
}

/**
 * What value-shape masking leaves behind (`MASKED_TOKEN` in
 * `@crewhaus/spec-patch`, which does not re-export it).
 *
 * It matters on the WRITE side: every article this module serves has been
 * through `maskText`, so text that came from a console editor may carry a
 * mark where a real span used to be. Persisting it replaces what it hid.
 */
const MASK_MARK = "***";

/** How many mask marks a document carries. Comparing the incoming count with
 *  the stored one is what separates "the operator wrote three asterisks" from
 *  "the masked view is being written back". */
function countMaskMarks(text: string): number {
  return text.split(MASK_MARK).length - 1;
}

/** Article free text is masked by hand as well as by `maskDeep`: prose is
 *  where a pasted credential hides from key-based redaction. */
function maskArticle(article: unknown): unknown {
  const doc = asRecord(article);
  if (Object.keys(doc).length === 0) return article;
  const out: Extra = { ...doc };
  for (const field of ["body", "summary", "editMessage", "title"]) {
    const value = out[field];
    if (typeof value === "string") out[field] = maskText(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/**
 * `GET /api/h/:id/thredz` — the harness's Thredz status.
 *
 * Key PRESENCE (never the key), the resolved workspace, the permission tier
 * the key carries, the wiki backend badge (local vs thredz), plan quotas, and
 * the mirror's degraded state if it has one.
 *
 * The tier is PROBED rather than declared, because the API has no "describe
 * me" route: `/wiki/stats` answering proves a wiki grant, `/keys` answering
 * proves the admin tier, and a 403 from either is a fact about the key rather
 * than an error.
 */
export const thredzStatus: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const specText = readContained(ctx, ["crewhaus.yaml"]) ?? "";
  const localWikiDeclared = /^memory:/m.test(specText) && /^\s+wiki\s*:/m.test(specText);
  const base: Extra = {
    spec: {
      declared: r.config.declared,
      form: r.config.form,
      envName: r.config.envName,
      inlineKey: r.config.inlineKey,
      goalsMirror: r.config.goalsMirror,
      agentHandle: r.config.agentHandle,
      messaging: r.config.messaging,
    },
    localWikiDeclared,
    reachable: null,
    tier: null,
    wikiStats: null,
    listenerQuota: null,
    probes: [],
  };
  if (r.session === null) return keyless(ctx, r, null, base);

  const session = r.session;
  const [stats, keys, listeners] = await Promise.all([
    callThredz(session, "GET", "/wiki/stats", { timeoutMs: THREDZ_PROBE_TIMEOUT_MS }),
    callThredz(session, "GET", "/keys", { timeoutMs: THREDZ_PROBE_TIMEOUT_MS }),
    callThredz(session, "GET", "/listeners/usage", { timeoutMs: THREDZ_PROBE_TIMEOUT_MS }),
  ]);
  const reachable = [stats, keys, listeners].some((probe) => probe.status !== 0);
  if (!reachable) return refused(ctx, r, stats, null, base);

  const failure = stats.ok ? null : classifyThredzFailure(stats);
  return envelope(
    ctx,
    {
      present: true,
      note: failure?.message ?? null,
      verb: null,
      ok: stats.ok,
      upstream: failure,
      resolution: r,
    },
    {
      ...base,
      reachable: true,
      tier: keys.ok ? "admin" : stats.ok ? "wiki" : "none",
      wikiStats: stats.ok ? stats.data : null,
      listenerQuota: listeners.ok ? listeners.data : null,
      probes: [
        { probe: "wiki", ok: stats.ok, status: stats.status },
        { probe: "admin", ok: keys.ok, status: keys.status },
        { probe: "listeners", ok: listeners.ok, status: listeners.status },
      ],
    },
  );
};

// ---------------------------------------------------------------------------
// wiki
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/thredz/wiki` — the Thredz wiki list with tag/status
 *  filters and semantic search applied UPSTREAM (the manager forwards the
 *  query, it does not re-implement search). */
export const thredzWiki: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { articles: [], mode: "list", pagination: null };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const q = ctx.query.get("q") ?? "";
  const semantic = ctx.query.get("semantic") === "1" && q !== "";
  const mode = semantic ? "semantic" : "list";
  const result = semantic
    ? await callThredz(r.session, "POST", "/wiki/search/semantic", {
        body: { query: q, limit: intParam(ctx.query, "limit", 25, PAGE_LIMIT) },
      })
    : await callThredz(r.session, "GET", "/wiki/articles", {
        query: {
          ...pick(ctx.query, ["q", "tags", "category", "status", "sort", "order"]),
          limit: intParam(ctx.query, "limit", 25, PAGE_LIMIT),
          fields: "slug,title,tags,status,visibility,updatedAt,verified,confidenceScore,version",
        },
      });
  if (!result.ok) return refused(ctx, r, result, null, { ...empty, mode });
  const articles = arrayFrom(result.data, "articles", "results", "hits").map(maskArticle);
  return answered(
    ctx,
    r,
    {
      present: articles.length > 0,
      note: articles.length === 0 ? "no articles match this filter in the workspace" : null,
    },
    { articles, mode, pagination: paginationFrom(result.data) },
  );
};

/** `GET /api/h/:id/thredz/wiki/:slug` — one article with its frontmatter,
 *  backlinks, comments and votes/signals. */
export const thredzWikiArticle: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const slug = ctx.params["slug"] ?? "";
  const empty: Extra = { slug, article: null, backlinks: [], comments: [], related: [] };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const encoded = encodeURIComponent(slug);
  // The article read carries backlinks already; comments and related are
  // separate routes, and either failing must not hide the article itself.
  const [article, comments, related] = await Promise.all([
    callThredz(r.session, "GET", `/wiki/articles/${encoded}`),
    callThredz(r.session, "GET", `/wiki/articles/${encoded}/comments`),
    callThredz(r.session, "GET", `/wiki/articles/${encoded}/related`, { query: { limit: 5 } }),
  ]);
  if (!article.ok) return refused(ctx, r, article, null, empty);
  const doc = asRecord(article.data);
  const inner = asRecord(doc["article"]);
  const body = Object.keys(inner).length > 0 ? inner : doc;
  return answered(
    ctx,
    r,
    { present: true },
    {
      slug,
      article: maskArticle(body),
      version: typeof body["version"] === "number" ? body["version"] : null,
      visibility: stringField(body["visibility"]),
      deleted: stringField(body["deletedAt"]) !== null,
      backlinks: arrayFrom(doc["backlinks"], "backlinks"),
      comments: comments.ok ? arrayFrom(comments.data, "comments") : [],
      commentsError: comments.ok ? null : classifyThredzFailure(comments).message,
      related: related.ok ? arrayFrom(related.data, "related", "articles") : [],
    },
  );
};

/**
 * `PUT /api/h/:id/thredz/wiki/:slug` — write an article.
 *
 * Body: `{ body, title?, tags?, visibility?, expectedVersion }`. `visibility`
 * is ALWAYS sent on a CREATE, defaulting to private; on an UPDATE it is sent
 * only when the caller explicitly asked to change it. A version conflict
 * answers with the current version so the client runs the same re-read-retry
 * flow as the local wiki.
 *
 * Three rules an UPDATE holds that a CREATE does not, each one a way this
 * route could otherwise destroy someone else's writing:
 *
 *   1. AN OMITTED FIELD IS LEFT ALONE. A PATCH carries only what the caller
 *      explicitly supplied. `title` defaulting to the slug and `status`
 *      defaulting to `published` are CREATE defaults; applied to an existing
 *      article they rename it and force-publish a draft, silently. The local
 *      wiki spreads its optional fields conditionally for exactly this
 *      reason (`wiki-ops.ts`).
 *   2. `expectedVersion` IS REQUIRED. Without it neither side can detect a
 *      concurrent edit, and `@crewhaus/wiki-store` refuses the identical
 *      write — the two backends must not disagree about a lost update. It
 *      stays optional on the CREATE branch, where there is nothing to lose.
 *   3. A BODY THAT NEWLY CARRIES THE MASK MARK IS REFUSED. Every article is
 *      served masked; writing that view back persists `***` over whatever it
 *      hid. The console guards its editor, but the guard has to hold for a
 *      direct API call too.
 */
export const thredzWikiWrite: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const slug = ctx.params["slug"] ?? "";
  if (r.session === null) return keyless(ctx, r, null, { slug, wrote: false });
  const bodyText = ctx.body["body"];
  if (typeof bodyText !== "string" || bodyText === "") {
    return declined(ctx, r, 'a wiki write needs a "body"', { slug, wrote: false });
  }
  const explicitVisibility =
    ctx.body["visibility"] === "private" || ctx.body["visibility"] === "shared"
      ? (ctx.body["visibility"] as "private" | "shared")
      : undefined;
  const rawVersion = ctx.body["expectedVersion"];
  const expectedVersion =
    typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0
      ? rawVersion
      : undefined;
  const explicitTitle = stringField(ctx.body["title"]);
  const explicitStatus = stringField(ctx.body["status"]);
  // Everything the caller ACTUALLY asked for. `title` and `status` are
  // spread conditionally like their siblings; their CREATE defaults are
  // applied on the create branch alone.
  const fields: Extra = {
    slug,
    body: bodyText,
    ...(explicitTitle !== null ? { title: explicitTitle } : {}),
    ...(stringField(ctx.body["summary"]) !== null ? { summary: ctx.body["summary"] } : {}),
    ...(Array.isArray(ctx.body["tags"]) ? { tags: ctx.body["tags"] } : {}),
    ...(stringField(ctx.body["category"]) !== null ? { category: ctx.body["category"] } : {}),
    ...(explicitStatus !== null ? { status: explicitStatus } : {}),
    editMessage: stringField(ctx.body["editMessage"]) ?? "hangar edit",
  };
  const encoded = encodeURIComponent(slug);
  // The projection carries `body` because the write path needs the STORED
  // text to tell an edit apart from a masked view being written back.
  const existing = await callThredz(r.session, "GET", `/wiki/articles/${encoded}`, {
    query: { fields: "id,slug,version,title,status,body" },
  });
  if (existing.ok) {
    const doc = asRecord(existing.data);
    const inner = asRecord(doc["article"]);
    const current = Object.keys(inner).length > 0 ? inner : doc;
    const currentVersion = typeof current["version"] === "number" ? current["version"] : null;
    if (expectedVersion === undefined) {
      // A blind update is a lost update. The local backend refuses this exact
      // request (`stale_article_version` with `expectedVersion: null`), so
      // this one does too — and says so in the same first-class shape, which
      // is also what a "create" aimed at an existing slug lands on.
      return envelope(
        ctx,
        {
          present: false,
          note:
            currentVersion === null
              ? `"${slug}" already exists in this workspace — an update carries the version you read ("expectedVersion"); re-read it and re-apply the edit`
              : `"${slug}" already exists at version ${currentVersion} — an update carries the version you read ("expectedVersion"); re-read it and re-apply the edit`,
          verb: null,
          ok: false,
          resolution: r,
        },
        {
          slug,
          wrote: false,
          stale: true,
          versionRequired: true,
          currentVersion,
          expectedVersion: null,
        },
      );
    }
    if (currentVersion !== null && currentVersion !== expectedVersion) {
      // The same first-class refusal the local wiki gives: nothing is
      // written, the mover's version comes back, the client re-reads.
      return envelope(
        ctx,
        {
          present: false,
          note: `this article is at version ${currentVersion}, not ${expectedVersion} — re-read it and re-apply the edit`,
          verb: null,
          ok: false,
          resolution: r,
        },
        { slug, wrote: false, stale: true, currentVersion, expectedVersion },
      );
    }
    // `maskArticle` masks the title as well as the body, so both round-trip
    // through a console editor and both are checked. A field carrying more
    // mask marks than the stored one is that masked VIEW coming back:
    // writing it replaces a real span with `***`, which the manager cannot
    // un-mask. With no stored text to compare against the guard fails
    // CLOSED — a mask mark it cannot account for is refused, not written.
    const storedBody = typeof current["body"] === "string" ? current["body"] : null;
    const storedTitle = typeof current["title"] === "string" ? current["title"] : null;
    const maskedField =
      countMaskMarks(bodyText) > countMaskMarks(storedBody ?? "")
        ? "body"
        : explicitTitle !== null &&
            countMaskMarks(explicitTitle) > countMaskMarks(storedTitle ?? "")
          ? "title"
          : null;
    if (maskedField !== null) {
      const blind = maskedField === "body" ? storedBody === null : storedTitle === null;
      return envelope(
        ctx,
        {
          present: false,
          note: blind
            ? `this ${maskedField} carries a masked credential-shaped span ("${MASK_MARK}") and the workspace returned no stored text to compare it against — saving it could persist the mask over whatever it hid; edit "${slug}" in the Thredz workspace instead`
            : `this ${maskedField} carries a masked credential-shaped span ("${MASK_MARK}") that the stored article does not — saving it would persist the mask over whatever it hid; edit "${slug}" in the Thredz workspace instead`,
          verb: null,
          ok: false,
          resolution: r,
        },
        { slug, wrote: false, maskedWrite: true, maskedField, currentVersion, expectedVersion },
      );
    }
    const patch = await callThredz(r.session, "PATCH", `/wiki/articles/${encoded}`, {
      body: {
        ...fields,
        ...(explicitVisibility !== undefined ? { visibility: explicitVisibility } : {}),
        version: expectedVersion,
      },
    });
    if (!patch.ok) {
      const failure = classifyThredzFailure(patch);
      return envelope(
        ctx,
        {
          present: false,
          note: failure.message,
          verb: null,
          ok: false,
          upstream: failure,
          resolution: r,
        },
        {
          slug,
          wrote: false,
          stale: failure.code === "stale_article_version" || failure.status === 409,
          currentVersion,
          expectedVersion: expectedVersion ?? null,
        },
      );
    }
    return answered(
      ctx,
      r,
      { present: true },
      { slug, wrote: true, created: false, article: maskArticle(patch.data) },
    );
  }
  if (existing.status !== 404) return refused(ctx, r, existing, null, { slug, wrote: false });
  const visibility = explicitVisibility ?? r.session.defaultVisibility;
  // CREATE defaults — a new article needs a title and a status, and there is
  // nothing here to overwrite. They are deliberately NOT applied above.
  const created = await callThredz(r.session, "POST", "/wiki/articles", {
    body: {
      ...fields,
      title: explicitTitle ?? slug,
      status: explicitStatus ?? "published",
      visibility,
    },
  });
  if (!created.ok) return refused(ctx, r, created, null, { slug, wrote: false });
  return answered(
    ctx,
    r,
    { present: true },
    { slug, wrote: true, created: true, visibility, article: maskArticle(created.data) },
  );
};

/** `GET /api/h/:id/thredz/wiki/:slug/versions` — version list + diffs. */
export const thredzWikiVersions: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const slug = ctx.params["slug"] ?? "";
  const empty: Extra = { slug, versions: [], diff: null, diffError: null };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const encoded = encodeURIComponent(slug);
  const versions = await callThredz(r.session, "GET", `/wiki/articles/${encoded}/versions`);
  if (!versions.ok) return refused(ctx, r, versions, null, empty);
  const from = ctx.query.get("from");
  const to = ctx.query.get("to");
  let diff: unknown = null;
  let diffError: string | null = null;
  if (from !== null && to !== null) {
    const result = await callThredz(r.session, "GET", `/wiki/articles/${encoded}/diff`, {
      query: { from, to },
    });
    if (result.ok) diff = result.data;
    else diffError = classifyThredzFailure(result).message;
  }
  const rows = arrayFrom(versions.data, "versions");
  return answered(
    ctx,
    r,
    {
      present: rows.length > 0,
      note: rows.length === 0 ? "this article has no recorded versions yet" : null,
    },
    { slug, versions: rows.map(maskArticle), diff, diffError },
  );
};

/** `POST /api/h/:id/thredz/wiki/:slug/rollback` — roll back to a version.
 *  Body: `{ version, confirm }`. A rollback creates a NEW version; it never
 *  removes the ones in between, which is why one confirmation is the right
 *  rung rather than a typed one. */
export const thredzWikiRollback: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const slug = ctx.params["slug"] ?? "";
  if (r.session === null) return keyless(ctx, r, null, { slug, rolledBack: false });
  const version = ctx.body["version"];
  if (typeof version !== "number") {
    return declined(ctx, r, 'a rollback needs the "version" to roll back to', {
      slug,
      rolledBack: false,
    });
  }
  if (ctx.body["confirm"] !== true) {
    return declined(
      ctx,
      r,
      `rolling back "${slug}" to version ${version} creates a new version on top — confirm to proceed`,
      { slug, rolledBack: false, needsConfirm: true },
    );
  }
  const result = await callThredz(
    r.session,
    "POST",
    `/wiki/articles/${encodeURIComponent(slug)}/rollback`,
    { body: { toVersion: version } },
  );
  if (!result.ok) return refused(ctx, r, result, null, { slug, rolledBack: false });
  return answered(
    ctx,
    r,
    { present: true },
    { slug, rolledBack: true, toVersion: version, article: maskArticle(result.data) },
  );
};

// ---------------------------------------------------------------------------
// records + schemas
// ---------------------------------------------------------------------------

/**
 * `GET /api/h/:id/thredz/records` — records with filters.
 *
 * The records LIST route filters on a singular `tag`; the `tags` ARRAY with
 * AND semantics is the VIEW/CARD grammar. Rather than re-implement an AND
 * filter over one page of results (which would then silently disagree with
 * what a card shows), a multi-tag request forwards the first tag and says
 * where the real AND filter lives.
 */
export const thredzRecords: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { records: [], pagination: null, tagsNote: null, softDeleted: 0 };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const tags = ctx.query.getAll("tag").filter((t) => t !== "");
  const tagsNote =
    tags.length > 1
      ? "the records list filters on ONE tag; multi-tag AND lives in the view and card grammar, where a record filter's `tags` is an array"
      : null;
  const result = await callThredz(r.session, "GET", "/records", {
    query: {
      ...pick(ctx.query, ["type", "graphId", "status", "sortBy", "sortDir", "page"]),
      ...(tags[0] !== undefined ? { tag: tags[0] } : {}),
      limit: intParam(ctx.query, "limit", 25, PAGE_LIMIT),
    },
  });
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const records = arrayFrom(result.data, "records");
  const softDeleted = records.filter((row) => asRecord(row)["status"] === DELETED_STATUS).length;
  return answered(
    ctx,
    r,
    {
      present: records.length > 0,
      note: records.length === 0 ? "no records match this filter in the workspace" : tagsNote,
    },
    { records, pagination: paginationFrom(result.data), softDeleted, tagsNote },
  );
};

/** `POST /api/h/:id/thredz/records` — create a record against a schema.
 *  Schema-validation messages are surfaced verbatim. */
export const thredzRecordCreate: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  if (r.session === null) return keyless(ctx, r, null, { created: false, record: null });
  const type = stringField(ctx.body["type"]) ?? stringField(ctx.body["schema"]);
  const body: Extra = {
    ...(stringField(ctx.body["graphId"]) !== null ? { graphId: ctx.body["graphId"] } : {}),
    ...(type !== null ? { type } : {}),
    ...(stringField(ctx.body["title"]) !== null ? { title: ctx.body["title"] } : {}),
    ...(stringField(ctx.body["status"]) !== null ? { status: ctx.body["status"] } : {}),
    ...(Array.isArray(ctx.body["tags"]) ? { tags: ctx.body["tags"] } : {}),
    customFields: { ...objectField(ctx.body, "customFields"), ...objectField(ctx.body, "fields") },
  };
  const result = await callThredz(r.session, "POST", "/records", { body });
  if (!result.ok) return refused(ctx, r, result, null, { created: false, record: null });
  return answered(ctx, r, { present: true }, { created: true, record: result.data });
};

/** `GET /api/h/:id/thredz/records/:recordId` — one record, with its history. */
export const thredzRecord: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const recordId = ctx.params["recordId"] ?? "";
  const empty: Extra = { recordId, record: null, history: [], softDeleted: false };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const encoded = encodeURIComponent(recordId);
  const [record, history] = await Promise.all([
    callThredz(r.session, "GET", `/records/${encoded}`),
    callThredz(r.session, "GET", `/records/${encoded}/history`),
  ]);
  if (!record.ok) return refused(ctx, r, record, null, empty);
  const doc = asRecord(record.data);
  return answered(
    ctx,
    r,
    { present: true },
    {
      recordId,
      record: record.data,
      history: history.ok ? arrayFrom(history.data, "history", "entries") : [],
      softDeleted: doc["status"] === DELETED_STATUS,
    },
  );
};

/**
 * `DELETE /api/h/:id/thredz/records/:recordId` — SOFT delete.
 *
 * Upstream `DELETE /records/:id` DESTROYS the document and there is no
 * upstream restore for records, so this route never issues it. It parks the
 * record in the `deleted` status and stashes the status it replaced, which is
 * what makes the restore below exact rather than approximate.
 */
export const thredzRecordDelete: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const recordId = ctx.params["recordId"] ?? "";
  if (r.session === null) return keyless(ctx, r, null, { recordId, deleted: false });
  const encoded = encodeURIComponent(recordId);
  const current = await callThredz(r.session, "GET", `/records/${encoded}`);
  if (!current.ok) return refused(ctx, r, current, null, { recordId, deleted: false });
  const doc = asRecord(current.data);
  if (doc["status"] === DELETED_STATUS) {
    return answered(
      ctx,
      r,
      { present: true, note: "this record is already soft-deleted" },
      { recordId, deleted: true, alreadyDeleted: true },
    );
  }
  const result = await callThredz(r.session, "PUT", `/records/${encoded}`, {
    body: {
      status: DELETED_STATUS,
      customFields: {
        ...asRecord(doc["customFields"]),
        [RESTORE_FIELD]: doc["status"] ?? null,
        [DELETED_AT_FIELD]: new Date(ctx.now()).toISOString(),
      },
    },
  });
  if (!result.ok) return refused(ctx, r, result, null, { recordId, deleted: false });
  return answered(
    ctx,
    r,
    { present: true, note: "soft-deleted — restore puts its previous status back" },
    { recordId, deleted: true, alreadyDeleted: false, record: result.data },
  );
};

/**
 * `POST /api/h/:id/thredz/records/:recordId/restore` — undo a soft delete.
 * Its existence is what makes the delete affordance acceptable.
 *
 * IT MUST BE IDEMPOTENT. A restore that ran already has consumed the stash,
 * so a second one has nothing to put back — and a double-clicked button, a
 * retried request after the 10 s timeout, or a restore aimed at a record
 * that was never deleted all arrive here. Each of those is a NO-OP reported
 * as a fact (the shape the delete route uses for `alreadyDeleted`), never a
 * write of `null` over a live status.
 */
export const thredzRecordRestore: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const recordId = ctx.params["recordId"] ?? "";
  if (r.session === null) return keyless(ctx, r, null, { recordId, restored: false });
  const encoded = encodeURIComponent(recordId);
  const current = await callThredz(r.session, "GET", `/records/${encoded}`);
  if (!current.ok) return refused(ctx, r, current, null, { recordId, restored: false });
  const doc = asRecord(current.data);
  if (doc["status"] !== DELETED_STATUS) {
    return answered(
      ctx,
      r,
      {
        present: true,
        note: "this record is not soft-deleted — there is nothing to restore, and nothing was written",
      },
      {
        recordId,
        restored: false,
        notDeleted: true,
        status: stringField(doc["status"]),
      },
    );
  }
  const customFields = asRecord(doc["customFields"]);
  const previous = customFields[RESTORE_FIELD];
  const status = typeof previous === "string" && previous !== "" ? previous : null;
  const restored: Extra = { ...customFields };
  delete restored[RESTORE_FIELD];
  delete restored[DELETED_AT_FIELD];
  const result = await callThredz(r.session, "PUT", `/records/${encoded}`, {
    body: {
      // No stashed status means the manager does not KNOW what to put back.
      // The field is omitted rather than sent as `null`, which would blank
      // whatever status the record carries.
      ...(status !== null ? { status } : {}),
      customFields: restored,
    },
  });
  if (!result.ok) return refused(ctx, r, result, null, { recordId, restored: false });
  return answered(
    ctx,
    r,
    {
      present: true,
      note:
        status === null
          ? "no previous status was stashed, so the record's status is left exactly as it is — set it in the workspace"
          : null,
    },
    { recordId, restored: status !== null, status, record: result.data },
  );
};

/** `GET /api/h/:id/thredz/schemas` — record schemas, so the record forms and
 *  the view builder can be generated rather than hand-written. */
export const thredzSchemas: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { schemas: [] };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const result = await callThredz(r.session, "GET", "/schemas", {
    query: pick(ctx.query, ["type", "graphId"]),
  });
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const schemas = arrayFrom(result.data, "schemas");
  return answered(
    ctx,
    r,
    {
      present: schemas.length > 0,
      note: schemas.length === 0 ? "this workspace defines no record schemas" : null,
    },
    { schemas },
  );
};

// ---------------------------------------------------------------------------
// goals + tasks
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/thredz/goals` — goals. Free-plan workspaces cap at three,
 *  and that refusal is rendered as a fact. Goal filters use a SINGULAR
 *  `tag`. */
export const thredzGoals: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { goals: [], mirrored: r.config.goalsMirror === true, filterParam: "tag" };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const result = await callThredz(r.session, "GET", "/goals", {
    query: pick(ctx.query, ["graph", "tag", "overdue"]),
  });
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const goals = arrayFrom(result.data, "goals");
  return answered(
    ctx,
    r,
    {
      present: goals.length > 0,
      note: goals.length === 0 ? "this workspace has no goals yet" : null,
    },
    {
      goals,
      // The local continuity store stays authoritative for a mirroring
      // harness; these are the mirrored copies.
      mirrored: r.config.goalsMirror === true,
      // Named `filterParam`, not `filterKey`: the credential masker redacts
      // any field whose NAME ends in `Key`, and a redacted hint is worse than
      // no hint. The value it carries is a query-parameter name.
      filterParam: "tag",
    },
  );
};

/** `GET /api/h/:id/thredz/tasks` — tasks. The `knowledge-gap` tag is the
 *  learning subsystem's study queue, counted separately. Task filters use a
 *  SINGULAR `tag`. */
export const thredzTasks: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { tasks: [], studyQueue: 0, filterParam: "tag", pagination: null };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const result = await callThredz(r.session, "GET", "/tasks", {
    query: {
      ...pick(ctx.query, ["status", "priority", "tag", "goal", "overdue", "sortBy", "sortDir"]),
      limit: intParam(ctx.query, "limit", 25, PAGE_LIMIT),
    },
  });
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const tasks = arrayFrom(result.data, "tasks");
  const studyQueue = tasks.filter((task) => {
    const tags = asRecord(task)["tags"];
    return Array.isArray(tags) && tags.includes("knowledge-gap");
  }).length;
  return answered(
    ctx,
    r,
    {
      present: tasks.length > 0,
      note: tasks.length === 0 ? "this workspace has no tasks yet" : null,
    },
    { tasks, studyQueue, filterParam: "tag", pagination: paginationFrom(result.data) },
  );
};

/** `POST /api/h/:id/thredz/tasks/:taskId` — update one task (status,
 *  assignee, tags). Completion has its own upstream route. */
export const thredzTaskUpdate: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const taskId = ctx.params["taskId"] ?? "";
  if (r.session === null) return keyless(ctx, r, null, { taskId, updated: false });
  const encoded = encodeURIComponent(taskId);
  const status = stringField(ctx.body["status"]);
  if (status === "done" || status === "complete" || status === "completed") {
    const result = await callThredz(r.session, "PUT", `/tasks/${encoded}/complete`);
    if (!result.ok) return refused(ctx, r, result, null, { taskId, updated: false });
    return answered(
      ctx,
      r,
      { present: true },
      { taskId, updated: true, completed: true, task: result.data },
    );
  }
  const patch: Extra = {};
  for (const field of ["title", "description", "priority", "deadline", "goal", "status"]) {
    if (ctx.body[field] !== undefined) patch[field] = ctx.body[field];
  }
  if (Array.isArray(ctx.body["tags"])) patch["tags"] = ctx.body["tags"];
  if (Object.keys(patch).length === 0) {
    return declined(ctx, r, "a task update needs at least one field to change", {
      taskId,
      updated: false,
    });
  }
  const result = await callThredz(r.session, "PUT", `/tasks/${encoded}`, { body: patch });
  if (!result.ok) return refused(ctx, r, result, null, { taskId, updated: false });
  return answered(
    ctx,
    r,
    { present: true },
    { taskId, updated: true, completed: false, task: result.data },
  );
};

// ---------------------------------------------------------------------------
// views + dashboards
// ---------------------------------------------------------------------------

/** The filter vocabulary the view/card grammar accepts per entity type. Kept
 *  here so a builder can LABEL its fields honestly — the API is still the
 *  authority, and its refusal is what the screen shows. */
export const THREDZ_FILTER_KEYS: Readonly<Record<string, readonly string[]>> = {
  record: ["type", "status", "tags", "graphId", "customFields"],
  task: ["goal", "status", "priority", "tag", "overdue", "incomplete"],
  goal: ["graph", "tag", "overdue", "healthMode"],
  activity: ["since", "entityType", "action", "graphId"],
  log: ["graphId", "objectType", "objectId", "tags"],
  graph: ["isTemplate"],
  connector: ["sourceId", "sourceType", "destinationId", "destinationType", "type", "tag"],
};

/** Card types, graph types and KPI aggregations, for the same reason. */
export const THREDZ_CARD_GRAMMAR = {
  cardTypes: ["table", "kpi", "graph", "custom"] as const,
  graphTypes: ["line", "bar", "pie", "dot"] as const,
  aggregations: ["count", "sum", "avg", "min", "max"] as const,
  /** KPI cards need BOTH — the single most-hit validation refusal. */
  kpiRequires: ["display.aggregation", "display.aggregationField"] as const,
};

/** `GET /api/h/:id/thredz/views` — saved views. */
export const thredzViews: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { views: [], filterKeys: THREDZ_FILTER_KEYS, pagination: null };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const result = await callThredz(r.session, "GET", "/views", {
    query: {
      ...pick(ctx.query, ["entityType", "graphId", "page"]),
      limit: intParam(ctx.query, "limit", 25, PAGE_LIMIT),
    },
  });
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const views = arrayFrom(result.data, "views");
  return answered(
    ctx,
    r,
    {
      present: views.length > 0,
      note: views.length === 0 ? "this workspace has no saved views yet" : null,
    },
    { views, filterKeys: THREDZ_FILTER_KEYS, pagination: paginationFrom(result.data) },
  );
};

/** `POST /api/h/:id/thredz/views/:viewId/execute` — run a view and return its
 *  rows. The body carries the view's parameters; a POST because the parameter
 *  set is structured, not because it writes. */
export const thredzViewExecute: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const viewId = ctx.params["viewId"] ?? "";
  const empty: Extra = {
    viewId,
    results: [],
    viewName: null,
    entityType: null,
    pagination: null,
  };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const params = objectField(ctx.body, "params");
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      query[key] = value;
    }
  }
  const limit = typeof ctx.body["limit"] === "number" ? ctx.body["limit"] : 25;
  const result = await callThredz(
    r.session,
    "GET",
    `/views/${encodeURIComponent(viewId)}/execute`,
    { query: { ...query, limit: Math.min(Math.max(1, limit), PAGE_LIMIT) } },
  );
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const body = asRecord(result.data);
  const rows = arrayFrom(result.data, "results");
  return answered(
    ctx,
    r,
    { present: rows.length > 0, note: rows.length === 0 ? "this view matched no rows" : null },
    {
      viewId,
      viewName: stringField(body["viewName"]),
      entityType: stringField(body["entityType"]),
      results: rows,
      pagination: paginationFrom(result.data),
    },
  );
};

/** `GET /api/h/:id/thredz/dashboards` — dashboards. */
export const thredzDashboards: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = {
    dashboards: [],
    cardGrammar: THREDZ_CARD_GRAMMAR,
    filterKeys: THREDZ_FILTER_KEYS,
    pagination: null,
  };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const result = await callThredz(r.session, "GET", "/dashboards", {
    query: { ...pick(ctx.query, ["page"]), limit: intParam(ctx.query, "limit", 25, PAGE_LIMIT) },
  });
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const dashboards = arrayFrom(result.data, "dashboards");
  return answered(
    ctx,
    r,
    {
      present: dashboards.length > 0,
      note: dashboards.length === 0 ? "this workspace has no dashboards yet" : null,
    },
    {
      dashboards,
      cardGrammar: THREDZ_CARD_GRAMMAR,
      filterKeys: THREDZ_FILTER_KEYS,
      pagination: paginationFrom(result.data),
    },
  );
};

/** `GET /api/h/:id/thredz/dashboards/:dashboardId` — one dashboard with its
 *  cards and their rendered data. When card data fails to resolve the
 *  dashboard still renders; only the data says why it is missing. */
export const thredzDashboard: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const dashboardId = ctx.params["dashboardId"] ?? "";
  const empty: Extra = {
    dashboardId,
    dashboard: null,
    cards: [],
    dataResolved: false,
    dataError: null,
    cardGrammar: THREDZ_CARD_GRAMMAR,
    filterKeys: THREDZ_FILTER_KEYS,
  };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const encoded = encodeURIComponent(dashboardId);
  const [dashboard, executed] = await Promise.all([
    callThredz(r.session, "GET", `/dashboards/${encoded}`),
    callThredz(r.session, "GET", `/dashboards/${encoded}/execute`),
  ]);
  if (!dashboard.ok) return refused(ctx, r, dashboard, null, empty);
  const cards = executed.ok
    ? arrayFrom(executed.data, "cards")
    : arrayFrom(asRecord(dashboard.data)["cards"], "cards");
  return answered(
    ctx,
    r,
    { present: true },
    {
      dashboardId,
      dashboard: dashboard.data,
      cards,
      dataResolved: executed.ok,
      dataError: executed.ok ? null : classifyThredzFailure(executed).message,
      cardGrammar: THREDZ_CARD_GRAMMAR,
      filterKeys: THREDZ_FILTER_KEYS,
    },
  );
};

/**
 * `POST /api/h/:id/thredz/dashboards/:dashboardId/cards` — add a card.
 *
 * The card grammar is validated UPSTREAM and it is fussy: KPI cards need BOTH
 * `display.aggregation` and `display.aggregationField`; record filters take a
 * `tags` ARRAY (AND) while task/goal filters take a singular `tag`; graph
 * cards are line|bar|pie|dot. The refusal NAMES the valid keys for the entity
 * type — so it is forwarded VERBATIM, never paraphrased, and never pre-empted
 * by a local copy of the rules that could drift from the server's.
 */
export const thredzCardCreate: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const dashboardId = ctx.params["dashboardId"] ?? "";
  const empty: Extra = {
    dashboardId,
    added: false,
    validation: false,
    cardGrammar: THREDZ_CARD_GRAMMAR,
  };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const dataSource = objectField(ctx.body, "dataSource");
  const sort = dataSource["sort"];
  const card: Extra = {
    ...(stringField(ctx.body["title"]) !== null ? { title: ctx.body["title"] } : {}),
    ...(stringField(ctx.body["type"]) !== null ? { type: ctx.body["type"] } : {}),
    dataSource: {
      ...(stringField(dataSource["entityType"]) !== null
        ? { entityType: dataSource["entityType"] }
        : {}),
      filters: asRecord(dataSource["filters"]),
      ...(sort !== undefined ? { sort: asRecord(sort) } : {}),
      ...(typeof dataSource["limit"] === "number" ? { limit: dataSource["limit"] } : {}),
      ...(stringField(dataSource["graphId"]) !== null ? { graphId: dataSource["graphId"] } : {}),
    },
    display: objectField(ctx.body, "display"),
  };
  const result = await callThredz(
    r.session,
    "POST",
    `/dashboards/${encodeURIComponent(dashboardId)}/cards`,
    { body: card },
  );
  if (!result.ok) {
    const failure = classifyThredzFailure(result);
    return envelope(
      ctx,
      {
        present: false,
        // Verbatim: this string names the valid filter keys for the entity
        // type, and rewording it turns a fixable card into a broken one.
        note: failure.message,
        verb: null,
        ok: false,
        upstream: failure,
        resolution: r,
      },
      { ...empty, validation: failure.failureClass === "validation" },
    );
  }
  return answered(
    ctx,
    r,
    { present: true },
    {
      dashboardId,
      added: true,
      validation: false,
      dashboard: result.data,
      cardGrammar: THREDZ_CARD_GRAMMAR,
    },
  );
};

// ---------------------------------------------------------------------------
// listeners, webhooks, connectors, activity, traverse
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/thredz/listeners` — event-driven automations, with their
 *  plan quota and recent ingest events. */
export const thredzListeners: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { listeners: [], quota: null, quotaLocked: false, events: [] };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const [listeners, usage, events] = await Promise.all([
    callThredz(r.session, "GET", "/listeners", {
      query: pick(ctx.query, ["source", "goal", "enabled"]),
    }),
    callThredz(r.session, "GET", "/listeners/usage"),
    callThredz(r.session, "GET", "/listeners/events", {
      query: { limit: intParam(ctx.query, "limit", 25, PAGE_LIMIT) },
    }),
  ]);
  if (!listeners.ok) return refused(ctx, r, listeners, null, empty);
  const rows = arrayFrom(listeners.data, "listeners");
  const quota = usage.ok ? usage.data : null;
  const locked = asRecord(quota)["locked"] === true;
  return answered(
    ctx,
    r,
    {
      present: rows.length > 0,
      note: locked
        ? "this workspace's plan has no listener slots left — a quota fact, not a failure"
        : rows.length === 0
          ? "this workspace has no listeners yet"
          : null,
    },
    {
      listeners: rows,
      quota,
      quotaLocked: locked,
      events: events.ok ? arrayFrom(events.data, "events") : [],
    },
  );
};

/** `POST /api/h/:id/thredz/listeners` — create a listener. The
 *  Idempotency-Key is preserved from the request when the caller supplies
 *  one, and otherwise derived deterministically, so a replayed create can
 *  never duplicate the automation. */
export const thredzListenerCreate: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  if (r.session === null) return keyless(ctx, r, null, { created: false, listener: null });
  const event = stringField(ctx.body["event"]);
  if (event === null) {
    return declined(ctx, r, 'a listener needs the "event" it reacts to', {
      created: false,
      listener: null,
    });
  }
  const name = stringField(ctx.body["name"]) ?? "default";
  const idempotencyKey =
    stringField(ctx.body["idempotencyKey"]) ??
    `hangar:${ctx.entry?.id ?? "fleet"}:listener:${event}:${name}`;
  const body: Extra = { event };
  for (const field of ["name", "source", "goal", "action", "enabled", "filter", "config"]) {
    if (ctx.body[field] !== undefined) body[field] = ctx.body[field];
  }
  const result = await callThredz(r.session, "POST", "/listeners", {
    body,
    headers: { "idempotency-key": idempotencyKey },
  });
  if (!result.ok) {
    // Reported as `idempotency` rather than `idempotencyKey` for the same
    // reason the goal filter hint is: a `*Key` field name is redacted by the
    // credential masker, and this value is a replay guard, not a secret.
    return refused(ctx, r, result, null, {
      created: false,
      listener: null,
      idempotency: idempotencyKey,
    });
  }
  return answered(
    ctx,
    r,
    { present: true },
    { created: true, listener: result.data, idempotency: idempotencyKey },
  );
};

/** `GET /api/h/:id/thredz/webhooks` — webhook registrations and their
 *  delivery state. */
export const thredzWebhooks: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = {
    webhooks: [],
    deliveries: [],
    failedDeliveries: 0,
    deliveriesError: null,
  };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const [webhooks, deliveries] = await Promise.all([
    callThredz(r.session, "GET", "/webhooks"),
    callThredz(r.session, "GET", "/webhooks/deliveries", {
      query: {
        ...pick(ctx.query, ["status"]),
        limit: intParam(ctx.query, "limit", 25, PAGE_LIMIT),
      },
    }),
  ]);
  if (!webhooks.ok) return refused(ctx, r, webhooks, null, empty);
  const rows = arrayFrom(webhooks.data, "webhooks");
  const sent = deliveries.ok ? arrayFrom(deliveries.data, "deliveries") : [];
  const failed = sent.filter((delivery) => {
    const status = asRecord(delivery)["status"];
    return status !== undefined && status !== "delivered" && status !== "success";
  }).length;
  return answered(
    ctx,
    r,
    {
      present: rows.length > 0,
      note: rows.length === 0 ? "this workspace has no webhooks registered" : null,
    },
    {
      webhooks: rows,
      deliveries: sent,
      failedDeliveries: failed,
      deliveriesError: deliveries.ok ? null : classifyThredzFailure(deliveries).message,
    },
  );
};

/** `GET /api/h/:id/thredz/connectors` — configured connectors and their
 *  health. */
export const thredzConnectors: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { connectors: [] };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const result = await callThredz(r.session, "GET", "/connectors", {
    query: pick(ctx.query, ["type", "sourceId", "destinationId", "tag"]),
  });
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const connectors = arrayFrom(result.data, "connectors");
  return answered(
    ctx,
    r,
    {
      present: connectors.length > 0,
      note: connectors.length === 0 ? "this workspace has no connectors configured" : null,
    },
    { connectors },
  );
};

/**
 * `GET /api/h/:id/thredz/activity` — the workspace activity feed, distinct
 * from the manager's own `/api/activity` digest.
 *
 * The wiki keeps a SEPARATE audit log (who edited, rolled back, re-graded an
 * article), and the frozen route map has no route of its own for it — so it
 * rides here beside the general feed rather than going unshown. Its failure
 * is reported on its own field: an audit log the key cannot read must not
 * hide the activity that it can.
 */
export const thredzActivity: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { items: [], pagination: null, wikiAudit: [], wikiAuditError: null };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const limit = intParam(ctx.query, "limit", 25, PAGE_LIMIT);
  const [result, audit] = await Promise.all([
    callThredz(r.session, "GET", "/activity", {
      query: {
        ...pick(ctx.query, ["since", "entityType", "action", "graphId", "page"]),
        limit,
      },
    }),
    callThredz(r.session, "GET", "/wiki/audit", { query: { limit } }),
  ]);
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const items = arrayFrom(result.data, "activities", "items");
  return answered(
    ctx,
    r,
    {
      present: items.length > 0,
      note: items.length === 0 ? "no workspace activity in this window" : null,
    },
    {
      items,
      pagination: paginationFrom(result.data),
      wikiAudit: audit.ok ? arrayFrom(audit.data, "audit", "entries", "items") : [],
      wikiAuditError: audit.ok ? null : classifyThredzFailure(audit).message,
    },
  );
};

/** `POST /api/h/:id/thredz/traverse` — the graph traversal endpoint. The body
 *  carries the start node + traversal spec; a POST because the spec is
 *  structured, not because it writes. */
export const thredzTraverse: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { startId: null, nodes: [], edges: [] };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const startId = stringField(ctx.body["startId"]) ?? stringField(ctx.body["start"]);
  if (startId === null) {
    return declined(ctx, r, 'a traversal needs a "startId" to start from', empty);
  }
  const depth = typeof ctx.body["maxDepth"] === "number" ? ctx.body["maxDepth"] : ctx.body["depth"];
  const body: Extra = {
    startId,
    startType: stringField(ctx.body["startType"]) ?? "record",
    direction: stringField(ctx.body["direction"]) ?? "both",
    maxDepth: typeof depth === "number" ? Math.min(Math.max(1, depth), 10) : 3,
    ...(Array.isArray(ctx.body["types"]) ? { types: ctx.body["types"] } : {}),
    ...(Array.isArray(ctx.body["recordTypes"]) ? { recordTypes: ctx.body["recordTypes"] } : {}),
    ...(Array.isArray(ctx.body["connectorTypes"])
      ? { connectorTypes: ctx.body["connectorTypes"] }
      : {}),
    ...(Array.isArray(ctx.body["statuses"]) ? { statuses: ctx.body["statuses"] } : {}),
  };
  const result = await callThredz(r.session, "POST", "/traverse", { body });
  if (!result.ok) return refused(ctx, r, result, null, { ...empty, startId });
  const data = asRecord(result.data);
  const nodes = arrayFrom(data["nodes"], "nodes");
  return answered(
    ctx,
    r,
    {
      present: nodes.length > 0,
      note: nodes.length === 0 ? "nothing is connected to this node in that direction" : null,
    },
    {
      startId,
      startType: body["startType"],
      direction: body["direction"],
      depth: data["depth"] ?? body["maxDepth"],
      nodes,
      edges: arrayFrom(data["edges"], "edges"),
    },
  );
};

// ---------------------------------------------------------------------------
// key administration
// ---------------------------------------------------------------------------

/**
 * `GET /api/h/:id/thredz/keys` — key administration (admin-tier keys only).
 *
 * Lists key METADATA and the wiki grants — never key material. A 403 here is
 * a FACT about the key ("this one is not admin-tier"), not a fault, and the
 * panel says exactly that instead of showing an error.
 */
export const thredzKeys: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { keys: [], grants: [], grantsError: null, tier: null };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const [keys, grants] = await Promise.all([
    callThredz(r.session, "GET", "/keys"),
    callThredz(r.session, "GET", "/wiki/access"),
  ]);
  if (!keys.ok) {
    const failure = classifyThredzFailure(keys);
    const notAdmin = failure.status === 403;
    return envelope(
      ctx,
      {
        present: false,
        note: notAdmin
          ? "this harness's key is not admin-tier, so it cannot administer keys — a property of the key, not a failure"
          : failure.message,
        verb: null,
        ok: false,
        upstream: failure,
        resolution: r,
      },
      { ...empty, tier: notAdmin ? "wiki" : null },
    );
  }
  // Key material is stripped HERE, before the payload exists.
  const rows = arrayFrom(keys.data, "keys").map(keyMetadata);
  return answered(
    ctx,
    r,
    { present: rows.length > 0, note: rows.length === 0 ? "no keys in this workspace" : null },
    {
      keys: rows,
      grants: grants.ok ? arrayFrom(grants.data, "access", "grants") : [],
      grantsError: grants.ok ? null : classifyThredzFailure(grants).message,
      tier: "admin",
    },
  );
};

/**
 * `POST /api/h/:id/thredz/keys` — create a key (`POST /keys`, plus a
 * `/wiki/access` grant when one is asked for).
 *
 * The VALUE is supplied by the operator and is write-only: it goes up, it
 * never comes back, and the manager stores nothing. The manager deliberately
 * does not MINT key material — a minted value would have to be shown once,
 * and "shown once" is a credential value leaving the process, which this
 * surface does not do. The answer is metadata plus the grant result.
 */
export const thredzKeyCreate: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const empty: Extra = { created: false, key: null, grant: null, grantError: null };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const value = ctx.body["value"];
  if (typeof value !== "string" || value === "") {
    return declined(
      ctx,
      r,
      'creating a key needs its value in "value" — paste the key you minted in the Thredz account portal; the manager forwards it once and never stores, logs or returns it',
      { ...empty, needsValue: true },
    );
  }
  const owner = stringField(ctx.body["owner"]) ?? stringField(ctx.body["label"]);
  const result = await callThredz(r.session, "POST", "/keys", {
    body: {
      key: value,
      permissions: stringField(ctx.body["permissions"]) ?? "read-write",
      ...(owner !== null ? { owner } : {}),
    },
  });
  if (!result.ok) return refused(ctx, r, result, null, empty);
  const meta = keyMetadata(result.data);
  const wikiGrant = stringField(ctx.body["wikiAccess"]);
  const keyId = meta["id"];
  let grant: unknown = null;
  let grantError: string | null = null;
  if (wikiGrant !== null && typeof keyId === "string") {
    const granted = await callThredz(r.session, "POST", "/wiki/access", {
      body: { keyId, permission: wikiGrant },
    });
    if (granted.ok) grant = granted.data;
    else grantError = classifyThredzFailure(granted).message;
  }
  return answered(
    ctx,
    r,
    { present: true, note: "the key value was forwarded once and is not stored by the manager" },
    { created: true, key: meta, grant, grantError },
  );
};

/**
 * `POST /api/h/:id/thredz/keys/:keyId/rotate` — rotate a key.
 *
 * Typed-confirm, because rotation breaks anything still holding the old
 * value. It is implemented as a REPLACEMENT — a new key with the same owner
 * and permissions, plus a matching wiki grant — and it deliberately does NOT
 * delete the key it replaces: this surface ships no hard-delete affordance,
 * so retiring the old value stays an explicit act in the Thredz account
 * portal, named in the answer.
 */
export const thredzKeyRotate: M3Handler = async (ctx) => {
  const r = resolveHarnessSession(ctx);
  const keyId = ctx.params["keyId"] ?? "";
  const empty: Extra = { keyId, rotated: false, replacement: null, retiredOldKey: false };
  if (r.session === null) return keyless(ctx, r, null, empty);
  const value = ctx.body["value"];
  if (typeof value !== "string" || value === "") {
    return declined(
      ctx,
      r,
      'rotating needs the replacement value in "value" — mint it in the Thredz account portal; the manager forwards it once and never stores, logs or returns it',
      { ...empty, needsValue: true },
    );
  }
  const current = await callThredz(r.session, "GET", `/keys/${encodeURIComponent(keyId)}`);
  if (!current.ok) return refused(ctx, r, current, null, empty);
  const meta = keyMetadata(current.data);
  const expected =
    typeof meta["owner"] === "string" && meta["owner"] !== "" ? meta["owner"] : keyId;
  if (ctx.body["confirmName"] !== expected) {
    return declined(
      ctx,
      r,
      `rotating this key breaks everything still using it — send "confirmName": "${expected}" to proceed`,
      { ...empty, needsTypedConfirm: true, confirmExpects: expected },
    );
  }
  const permissions = typeof meta["permissions"] === "string" ? meta["permissions"] : "read-write";
  const created = await callThredz(r.session, "POST", "/keys", {
    body: {
      key: value,
      permissions,
      ...(typeof meta["owner"] === "string" ? { owner: meta["owner"] } : {}),
      ...(typeof meta["accountId"] === "string" ? { accountId: meta["accountId"] } : {}),
    },
  });
  if (!created.ok) return refused(ctx, r, created, null, empty);
  const replacement = keyMetadata(created.data);
  const replacementId = replacement["id"];
  let grantError: string | null = null;
  if (typeof replacementId === "string") {
    const granted = await callThredz(r.session, "POST", "/wiki/access", {
      body: { keyId: replacementId, permission: permissions },
    });
    if (!granted.ok) grantError = classifyThredzFailure(granted).message;
  }
  return answered(
    ctx,
    r,
    {
      present: true,
      note: "the replacement key is live; the old one stays valid until you disable it in the Thredz account portal — the manager ships no hard-delete affordance",
    },
    { keyId, rotated: true, replacement, grantError, retiredOldKey: false },
  );
};

// ---------------------------------------------------------------------------
// the harness-less global explorer
// ---------------------------------------------------------------------------

/**
 * `GET /api/thredz` — the harness-less global explorer (fleet-wide).
 *
 * Uses `CREWHAUS_THREDZ_KEY` from the MANAGER's own process environment when
 * one is set — never persisted to manager config, and absent is an honest
 * empty state that points at the per-harness explorers instead. Either way it
 * lists which registered harnesses declare `thredz:`, because "which of my
 * harnesses talk to a workspace" is answerable with no key at all.
 */
export const thredzGlobal: M3Handler = async (ctx) => {
  const harnesses = ctx.harnesses().map((harness) => {
    // Fleet-wide: no per-harness containment closure exists here, so each
    // spec read is contained against ITS OWN harness root.
    const specPath = resolveInside(harness.dir, ["crewhaus.yaml"]);
    let config = ABSENT_CONFIG;
    if (specPath !== undefined) {
      try {
        config = scanThredzBlock(readFileSync(specPath, "utf8"));
      } catch {
        config = { ...ABSENT_CONFIG, form: "unreadable" };
      }
    }
    return {
      id: harness.id,
      specName: harness.specName,
      declared: config.declared,
      envName: config.envName,
      defaultVisibility: config.defaultVisibility,
      workspace: displayBase(config.baseUrl),
    };
  });
  const r = resolveGlobalSession(ctx);
  const base: Extra = {
    harnesses,
    wired: harnesses.filter((harness) => harness.declared).length,
    counts: null,
    reachable: null,
    wikiStats: null,
  };
  if (r.session === null) return keyless(ctx, r, null, base);
  const [stats, records, dashboards] = await Promise.all([
    callThredz(r.session, "GET", "/wiki/stats", { timeoutMs: THREDZ_PROBE_TIMEOUT_MS }),
    callThredz(r.session, "GET", "/records", {
      query: { limit: 1 },
      timeoutMs: THREDZ_PROBE_TIMEOUT_MS,
    }),
    callThredz(r.session, "GET", "/dashboards", {
      query: { limit: 1 },
      timeoutMs: THREDZ_PROBE_TIMEOUT_MS,
    }),
  ]);
  if (stats.status === 0 && records.status === 0 && dashboards.status === 0) {
    return refused(ctx, r, stats, null, base);
  }
  const totalOf = (result: UpstreamResult): number | null => {
    if (!result.ok) return null;
    const total = asRecord(paginationFrom(result.data))["total"];
    return typeof total === "number" ? total : null;
  };
  const failure = stats.ok ? null : classifyThredzFailure(stats);
  return envelope(
    ctx,
    {
      present: true,
      note: failure?.message ?? null,
      verb: null,
      ok: stats.ok,
      upstream: failure,
      resolution: r,
    },
    {
      ...base,
      reachable: true,
      wikiStats: stats.ok ? stats.data : null,
      counts: { records: totalOf(records), dashboards: totalOf(dashboards) },
    },
  );
};
