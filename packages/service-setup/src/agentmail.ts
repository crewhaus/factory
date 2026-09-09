/**
 * AgentMail — the inbox an agent sends and receives mail from.
 *
 * A harness that mails anyone (the escalation ladder's email tier, a support
 * agent answering a queue) needs an inbox of its own, and the inbox is the
 * sender identity: sends go to `POST /v0/inboxes/{inbox_id}/messages/send`.
 * Creating that inbox is a console trip nobody should take per harness.
 *
 * TWO THINGS ABOUT THIS API ARE WORTH KNOWING BEFORE READING THE CODE.
 *
 * `client_id` is a real idempotency key, not a label. The documented contract:
 * the first request carrying a given `client_id` creates the resource and the
 * id is stored against that `client_id`; a later request with the same one
 * returns `200 OK` with the data from the ORIGINAL request rather than
 * creating a second inbox. That is why {@link ensureInbox} is a single POST
 * with a derived `client_id` and no list-then-create dance — there is no
 * window in which two concurrent runs can both create.
 *
 * Errors carry their own remediation. The error body is
 * `{ code, message, docs, fix, name }`, and `fix` is prose written for the
 * person who has to act. Where it is present this module prefers it over
 * anything it could invent, and appends `docs` — a provider that has already
 * written the fix should not have it paraphrased.
 */
import { asRecord, readString, requestJson } from "./http";
import { type ServiceDeps, ServiceSetupError } from "./types";

/** Documented base URL: "All API requests should be made to … /v0/". */
export const AGENTMAIL_API_BASE = "https://api.agentmail.to/v0";

/** Where an operator mints the org key. Keys are shown once and start `am_`. */
export const AGENTMAIL_CONSOLE_URL = "https://console.agentmail.to";

export type AgentMailAuth = { readonly apiKey: string };
export type AgentMailDeps = ServiceDeps & { readonly apiBase?: string };

/**
 * An inbox. `inboxId` is what the send path takes; `email` is what a human
 * reads. They are separate fields in the API response and this module keeps
 * both — writing the address into a variable the runtime uses as an id would
 * fail only at the first send.
 */
export type Inbox = {
  readonly inboxId: string;
  readonly email: string;
  readonly displayName: string | undefined;
  readonly clientId: string | undefined;
  readonly createdAt: string | undefined;
};

/** A newly minted API key. The secret is returned ONCE and never again. */
export type InboxApiKey = {
  readonly apiKeyId: string;
  /** The secret. Never log this; write it straight to the env file. */
  readonly apiKey: string;
  readonly name: string | undefined;
};

/** What `ensureInbox` was asked for. */
export type InboxInput = {
  /** Local part. Omitted ⇒ AgentMail generates one. */
  readonly username?: string;
  /** Must be verified on the account. Omitted ⇒ `agentmail.to`. */
  readonly domain?: string;
  readonly displayName?: string;
  /** The idempotency key. {@link ensureInbox} requires it. */
  readonly clientId: string;
};

/**
 * The `client_id` for a harness's inbox.
 *
 * Deterministic and namespaced, because it is the ONLY thing standing between
 * a re-run and a second inbox: the same harness must derive the same value on
 * every machine and every run. The `crewhaus:` prefix keeps it from colliding
 * with client ids an operator's other tooling uses on the same account.
 */
export function inboxClientId(harnessName: string): string {
  // AgentMail constrains `client_id` to 1-256 characters from
  // `A-Z a-z 0-9 - . _ ~`. A colon is NOT in that set, so the obvious
  // `crewhaus:<name>` would be rejected on every create. Anything outside the
  // set collapses to `-`, which keeps the value derivable from the name
  // without depending on what characters a spec author used.
  const safe = harnessName.replace(/[^A-Za-z0-9._~-]+/g, "-").replace(/^-+|-+$/g, "");
  return `crewhaus-${safe === "" ? "harness" : safe}`.slice(0, 256);
}

/**
 * Confirm the key works before anything is created.
 *
 * A one-page list is the cheapest authenticated call available, and it turns
 * "401 halfway through provisioning" into "nothing happened, fix the key".
 */
export async function verifyKey(
  auth: AgentMailAuth,
  deps: AgentMailDeps = {},
): Promise<{ readonly inboxCount: number }> {
  const res = await call(auth, deps, { path: "/inboxes?limit=1" });
  const body = unwrap(
    res,
    "AgentMail key rejected",
    `Mint an org key at ${AGENTMAIL_CONSOLE_URL} → API Keys (it starts "am_" and is shown once).`,
  );
  const count = asRecord(body)["count"];
  return { inboxCount: typeof count === "number" ? count : 0 };
}

/**
 * List one page of inboxes. Exposed for callers that want to show what exists;
 * {@link ensureInbox} does NOT use it, because `client_id` makes create
 * idempotent on its own and a list-then-create would reintroduce the race it
 * avoids.
 */
export async function listInboxes(
  auth: AgentMailAuth,
  deps: AgentMailDeps = {},
  opts: { readonly limit?: number; readonly pageToken?: string } = {},
): Promise<{ readonly inboxes: readonly Inbox[]; readonly nextPageToken: string | undefined }> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.pageToken !== undefined) params.set("page_token", opts.pageToken);
  const query = params.toString();
  const res = await call(auth, deps, { path: `/inboxes${query === "" ? "" : `?${query}`}` });
  const body = asRecord(
    unwrap(res, "AgentMail inboxes could not be listed", "Check the key's permissions."),
  );
  const raw = body["inboxes"];
  const inboxes = Array.isArray(raw)
    ? raw.map(toInbox).filter((i): i is Inbox => i !== undefined)
    : [];
  return { inboxes, nextPageToken: readString(body, "next_page_token") };
}

/**
 * Create the harness's inbox, or return the one this `client_id` already made.
 *
 * `created` is a BEST GUESS and named accordingly at the call site. The create
 * reference documents exactly one success response — 200 — and the
 * idempotency guide says a replay also returns 200, so the status cannot
 * separate them. Some deployments answer 201 on a genuine create, so that is
 * treated as proof of one; a 200 is genuinely ambiguous and the caller
 * resolves it against what it already recorded locally, which is the only
 * state we actually control.
 */
export async function ensureInbox(
  auth: AgentMailAuth,
  input: InboxInput,
  deps: AgentMailDeps = {},
): Promise<{ readonly inbox: Inbox; readonly created: boolean }> {
  const res = await call(auth, deps, {
    path: "/inboxes",
    method: "POST",
    json: {
      client_id: input.clientId,
      ...(input.username === undefined ? {} : { username: input.username }),
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
    },
  });

  const body = unwrap(
    res,
    "AgentMail inbox could not be created",
    "Check the key's permissions, and that any --mail-domain is verified on the account.",
  );
  const inbox = toInbox(body);
  if (inbox === undefined) {
    throw new ServiceSetupError("agentmail", "AgentMail returned an inbox with no id", {
      status: res.status,
      fix: "Retry; if it persists the API response shape has changed and this client needs updating.",
    });
  }
  // 201 proves a create. 200 does not distinguish one from a replay — see the
  // docstring — so it is reported as "not proven created" and the caller
  // decides from its own records.
  return { inbox, created: res.status === 201 };
}

/**
 * Mint an API key scoped to ONE inbox.
 *
 * Why this exists: the org key can read and send from every inbox on the
 * account, and a fleet that pastes it into every harness has given each one
 * the ability to mail as any of the others. A key scoped to one inbox cannot.
 *
 * BUT IT IS NOT "LEAST AUTHORITY", and the distinction matters enough to say
 * plainly. The create reference notes that when `permissions` is omitted
 * "all permissions are granted" — so a scoped key still carries the whole
 * grant set WITHIN its scope. It narrows which inbox, not what may be done.
 * This module does not send a `permissions` object because the exact grant
 * names are not verified here; narrowing them further is a real improvement
 * and is left explicitly undone rather than quietly claimed.
 *
 * It is NOT idempotent — there is no `client_id` here, so every call mints
 * another key. The caller must therefore only call it when the target
 * variable is unset; see the AgentMail step in `plan.ts`.
 */
export async function createInboxApiKey(
  auth: AgentMailAuth,
  inboxId: string,
  name: string,
  deps: AgentMailDeps = {},
): Promise<InboxApiKey> {
  const res = await call(auth, deps, {
    path: `/inboxes/${encodeURIComponent(inboxId)}/api-keys`,
    method: "POST",
    json: { name },
  });
  const body = asRecord(
    unwrap(
      res,
      "AgentMail inbox-scoped key could not be created",
      "An org-level key is required to mint scoped keys.",
    ),
  );
  const apiKey = readString(body, "api_key");
  const apiKeyId = readString(body, "api_key_id");
  if (apiKey === undefined || apiKeyId === undefined) {
    throw new ServiceSetupError("agentmail", "AgentMail returned no key material", {
      status: res.status,
      fix: "The secret is returned only at creation; re-run to mint a fresh key.",
    });
  }
  return { apiKeyId, apiKey, name: readString(body, "name") };
}

// ---------------------------------------------------------------------------
// Wire plumbing
// ---------------------------------------------------------------------------

async function call(
  auth: AgentMailAuth,
  deps: AgentMailDeps,
  req: { readonly path: string; readonly method?: "GET" | "POST"; readonly json?: unknown },
): Promise<{ status: number; ok: boolean; body: unknown }> {
  // Tolerate a trailing slash on an injected base, matching thredz.ts — an
  // apiBase is a test seam and \ would silently 404.
  const base = (deps.apiBase ?? AGENTMAIL_API_BASE).replace(/\/+$/, "");
  return requestJson(
    {
      url: `${base}${req.path}`,
      ...(req.method === undefined ? {} : { method: req.method }),
      headers: { authorization: `Bearer ${auth.apiKey}` },
      ...(req.json === undefined ? {} : { json: req.json }),
    },
    deps,
  );
}

/**
 * Return the body, or throw the provider's own error.
 *
 * The `fix` field in an AgentMail error is written for the operator, so it
 * wins over `fallbackFix`; `docs` is appended because the error codes are
 * documented per-code and the link lands on the right anchor.
 */
function unwrap(
  res: { readonly status: number; readonly ok: boolean; readonly body: unknown },
  context: string,
  fallbackFix: string,
): unknown {
  if (res.ok) return res.body;

  const err = asRecord(res.body);
  const code = readString(err, "code");
  const message = readString(err, "message");
  const providerFix = readString(err, "fix");
  const docs = readString(err, "docs");

  const fix = [providerFix ?? fallbackFix, docs === undefined ? undefined : `See ${docs}`]
    .filter((p): p is string => p !== undefined)
    .join(" ");

  throw new ServiceSetupError(
    "agentmail",
    `${context}${message === undefined ? "" : `: ${message}`}${code === undefined ? "" : ` (${code})`}`,
    { status: res.status, ...(code === undefined ? {} : { code }), fix },
  );
}

/** Parse an inbox record; one without an id is not usable as a sender. */
function toInbox(value: unknown): Inbox | undefined {
  const rec = asRecord(value);
  const inboxId = readString(rec, "inbox_id");
  const email = readString(rec, "email");
  if (inboxId === undefined) return undefined;
  return {
    inboxId,
    // The address is informational; the id is what the runtime sends through.
    email: email ?? inboxId,
    displayName: readString(rec, "display_name"),
    clientId: readString(rec, "client_id"),
    createdAt: readString(rec, "created_at"),
  };
}
