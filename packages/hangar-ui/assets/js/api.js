/**
 * API client. One place knows every server route, attaches the bearer
 * token, and enforces two read-path invariants:
 *
 *   - 404 → `null`, never an error ("absence is not an error" — the caller
 *     renders a "nothing yet" empty state);
 *   - 401 → the registered unauthorized handler fires (the app swaps in the
 *     token screen) and the request rejects with `ApiError(401)`.
 *
 * The token arrives via the `#t=<token>` URL fragment (fragments never
 * reach server logs) and lives in sessionStorage only — never in a cookie
 * (no cookies ⇒ no CSRF surface) and never in a query string.
 */

const TOKEN_KEY = "hangar.token";

let unauthorizedHandler = null;

/** Register the single 401 handler (the app's token screen). */
export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

/** Current bearer token, or null. */
export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Store (or clear, with null) the bearer token for this tab session. */
export function setToken(token) {
  try {
    if (token === null || token === "") sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // sessionStorage unavailable — requests proceed unauthenticated and the
    // server's 401 keeps routing the user to the token screen.
  }
}

/** Error for non-404 failures; `status` is the HTTP status (0 = network). */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(method, path, body) {
  const headers = { accept: "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(0, `network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) {
    if (unauthorizedHandler) unauthorizedHandler();
    throw new ApiError(401, "unauthorized");
  }
  if (res.status === 404) return null;
  if (res.status === 204) return null;
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // body unreadable — the status alone is the message
    }
    throw new ApiError(res.status, detail !== "" ? detail : `HTTP ${res.status}`);
  }
  return res.json();
}

const get = (path) => request("GET", path);
const post = (path, body) => request("POST", path, body);
const put = (path, body) => request("PUT", path, body);
const patch = (path, body) => request("PATCH", path, body);
const del = (path) => request("DELETE", path);

const enc = encodeURIComponent;

/**
 * Every server route the M1 console talks to, in one map. Reads everywhere;
 * the ONLY writes are registry CRUD (add/scan/groups/tags/pin/notes/
 * relocate/remove) — manager-state writes, never harness state.
 */
export const api = {
  // fleet feed + registry CRUD
  harnesses: () => get("/api/harnesses"),
  addHarness: (dir) => post("/api/harnesses", { dir }),
  scan: () => post("/api/scan", {}),
  groups: () => get("/api/registry/groups"),
  saveGroups: (groups) => put("/api/registry/groups", { groups }),
  updateRegistry: (id, fields) => patch(`/api/h/${enc(id)}/registry`, fields),
  relocateHarness: (id, dir) => post(`/api/h/${enc(id)}/relocate`, { dir }),
  removeHarness: (id) => del(`/api/h/${enc(id)}`),

  // per-harness reads
  harness: (id) => get(`/api/h/${enc(id)}`),
  spec: (id) => get(`/api/h/${enc(id)}/spec`),
  preflight: (id) => get(`/api/h/${enc(id)}/preflight`),
  sessions: (id) => get(`/api/h/${enc(id)}/sessions`),
  session: (id, sess) => get(`/api/h/${enc(id)}/sessions/${enc(sess)}`),
  evals: (id) => get(`/api/h/${enc(id)}/evals`),
  evalRun: (id, runId) => get(`/api/h/${enc(id)}/evals/${enc(runId)}`),
  evalSample: (id, runId, sampleId) =>
    get(`/api/h/${enc(id)}/evals/${enc(runId)}/${enc(sampleId)}`),
  memory: (id, area) => get(`/api/h/${enc(id)}/memory/${enc(area)}`),
  wikiArticle: (id, slug) => get(`/api/h/${enc(id)}/memory/wiki/${enc(slug)}`),
  costs: (id) => get(`/api/h/${enc(id)}/costs`),

  // cross-cutting
  version: () => get("/api/version"),
};
