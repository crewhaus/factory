/**
 * The console's client for Home's versioned API (`crewhaus.hangar.v1`). It reads the
 * operation table Home publishes (`GET /api/v1`) once per session and builds every path
 * from it by operation id, so the console keeps no second route map for the API. It
 * sends this tab's session, and one `Idempotency-Key` per user action, reused when that
 * action is retried. An error comes back as the envelope's own words: `{code, message,
 * verb, needs, reason}`.
 *
 * No DOM: a test imports it with an injected fetch.
 */

import { getSession } from "./api.js";

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

/** The operation table, read once. A failed read is not kept. */
export function discover(fetchImpl = fetch) {
  if (table !== null) return table;
  table = (async () => {
    const res = await fetchImpl("/api/v1", { method: "GET", headers: headersFor({}) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body.operations)) {
      table = null;
      throw Object.assign(new Error("Home did not answer with its operations."), {
        code: "unsupported_protocol",
      });
    }
    return body;
  })();
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
 * error}`; never throws for an answer Home gave.
 */
export async function call(id, opts = {}, fetchImpl = fetch) {
  const found = await discover(fetchImpl);
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
