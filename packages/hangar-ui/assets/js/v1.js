/**
 * The console's client for Home's versioned API (`crewhaus.hangar.v1`). It reads the
 * operation table Home publishes (`GET /api/v1`) once per session and builds every path
 * from it by operation id, so the console keeps no second route map for the API. It
 * sends this tab's session, and one `Idempotency-Key` per user action, reused when that
 * action is retried. An error comes back as the envelope's own words: `{code, message,
 * verb, needs, reason}`. A session that ended is signed in again the way every other
 * request does it (the sign-in dialog over the view), then the call is sent once more
 * with the same key.
 *
 * No DOM: a test imports it with an injected fetch.
 */

import { getSession, recoverSession } from "./api.js";

const PROTOCOL = "crewhaus.hangar.v1";
const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

let table = null;

/** Forget the table read this session, e.g. after signing in as someone else. */
export function resetDiscovery() {
  table = null;
}

function headersFor(extra) {
  const headers = { "CrewHaus-Protocol": PROTOCOL, accept: "application/json", ...extra };
  const session = getSession();
  if (session) headers.authorization = `Bearer ${session}`;
  return headers;
}

/**
 * The operation table, read once. A failed read is not kept. It rejects with `{code,
 * status, reason}` when Home cannot be reached or answers without its operations.
 */
export function discover(fetchImpl = fetch) {
  if (table !== null) return table;
  table = (async () => {
    let res;
    try {
      res = await fetchImpl("/api/v1", { method: "GET", headers: headersFor({}) });
    } catch {
      throw Object.assign(new Error("Home could not be reached."), {
        code: "unavailable",
        status: 0,
      });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body.operations)) {
      const error = errorOf(res.status, body);
      throw Object.assign(
        new Error(res.status === 401 ? error.message : "Home did not answer with its operations."),
        {
          code: res.status === 401 ? "unauthenticated" : "unsupported_protocol",
          status: res.status,
          ...(error.reason !== undefined ? { reason: error.reason } : {}),
        },
      );
    }
    return body;
  })();
  // A failed read is not kept: the next call asks again.
  table.catch(() => {
    table = null;
  });
  return table;
}

/** The path an operation answers on, with its params; `null` when one is missing. */
export function pathFor(operation, params = {}) {
  const parts = [];
  for (const piece of operation.path.split("/")) {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    if (name === undefined) {
      parts.push(piece);
      continue;
    }
    const value = params[name];
    if (typeof value !== "string" || value === "") return null;
    const segments = name === "ref" ? value.split("/") : [value];
    if (segments.some((s) => s === "")) return null;
    parts.push(segments.map(encodeURIComponent).join("/"));
  }
  return parts.join("/");
}

/** A fresh key for one user action. */
export function actionKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const key = `act-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  return KEY_RE.test(key) ? key : `act-${Date.now()}`;
}

function errorOf(status, body) {
  const error = body && typeof body.error === "object" && body.error !== null ? body.error : {};
  return {
    code: typeof error.code === "string" ? error.code : status === 0 ? "unavailable" : "internal",
    message:
      typeof error.message === "string"
        ? error.message
        : typeof body?.error === "string"
          ? body.error
          : `Home answered ${status}.`,
    ...(typeof error.verb === "string" ? { verb: error.verb } : {}),
    ...(typeof error.needs === "string" ? { needs: error.needs } : {}),
    ...(typeof error.reason === "string" ? { reason: error.reason } : {}),
    ...(typeof error.retryAfterMs === "number" ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

/**
 * Call one operation by id. Answers `{ok: true, status, body}` or `{ok: false, status,
 * error}`; never throws. A 401, from the call or from reading the table, asks the tab to
 * sign in again and, when it did, reads the table afresh and sends the call once more.
 */
export async function call(id, opts = {}, fetchImpl = fetch) {
  const first = await attempt(id, opts, fetchImpl);
  if (first.status !== 401 || !(await recoverSession())) return first;
  resetDiscovery();
  return attempt(id, opts, fetchImpl);
}

async function attempt(id, opts, fetchImpl) {
  let found;
  try {
    found = await discover(fetchImpl);
  } catch (err) {
    return {
      ok: false,
      status: typeof err?.status === "number" ? err.status : 0,
      error: {
        code: typeof err?.code === "string" ? err.code : "unavailable",
        message: err instanceof Error ? err.message : "Home could not be reached.",
        ...(typeof err?.reason === "string" ? { reason: err.reason } : {}),
      },
    };
  }
  const operation = found.operations.find((op) => op.id === id);
  if (operation === undefined) {
    return {
      ok: false,
      status: 0,
      error: { code: "unsupported", message: `Home does not offer ${id}.` },
    };
  }
  const path = pathFor(operation, opts.params);
  if (path === null) {
    return {
      ok: false,
      status: 0,
      error: { code: "invalid", message: `${id} needs more to go on.` },
    };
  }
  const query = new URLSearchParams(opts.query ?? {}).toString();
  const extra = {};
  if (opts.body !== undefined) extra["content-type"] = "application/json";
  if (opts.idempotencyKey !== undefined) extra["Idempotency-Key"] = opts.idempotencyKey;
  let res;
  try {
    res = await fetchImpl(`${path}${query === "" ? "" : `?${query}`}`, {
      method: operation.method,
      headers: headersFor(extra),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: "unavailable", message: "Home could not be reached." },
    };
  }
  const body = await res.json().catch(() => undefined);
  return res.ok
    ? { ok: true, status: res.status, body }
    : { ok: false, status: res.status, error: errorOf(res.status, body) };
}

/**
 * One user action: its key is made once, and every run of it, a retry included, sends
 * that same key, so Home answers a repeat with the receipt it already wrote.
 */
export function createAction(id, opts = {}, fetchImpl = fetch) {
  const key = actionKey();
  return {
    key,
    run: (more = {}) => call(id, { ...opts, ...more, idempotencyKey: key }, fetchImpl),
  };
}
