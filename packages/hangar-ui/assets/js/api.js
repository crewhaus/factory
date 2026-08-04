/**
 * API client. Every request is built from the `routes.js` contract map
 * (the same map the hangar server's contract test drives), attaches the
 * bearer token, and enforces two read-path invariants:
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

import { ROUTES, buildPath } from "./routes.js";

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

/** Issue one request from a `ROUTES` entry (+ params + optional body/query). */
function call(route, params, body, query = "") {
  return request(route.method, `${buildPath(route.path, params)}${query}`, body);
}

/**
 * Every server route the M1 console talks to — thin named wrappers over the
 * `ROUTES` contract map. Reads everywhere; the ONLY writes are registry
 * CRUD (add/scan/group-create/groups/tags/pin/notes/relocate/remove +
 * scan-root create) — manager-state writes, never harness state.
 */
export const api = {
  // fleet feed + registry CRUD
  harnesses: (hydrate = false) =>
    call(ROUTES.harnesses, {}, undefined, hydrate ? "?hydrate=1" : ""),
  addHarness: (dir) => call(ROUTES.addHarness, {}, { dir }),
  scan: () => call(ROUTES.scan, {}, {}),
  groups: () => call(ROUTES.groups, {}),
  addGroup: (name) => call(ROUTES.addGroup, {}, { name }),
  addScanRoot: (dir) => call(ROUTES.addScanRoot, {}, { dir }),
  setGroups: (id, groups) => call(ROUTES.setGroups, { id }, { groups }),
  setTags: (id, tags) => call(ROUTES.setTags, { id }, { tags }),
  setPin: (id, pinned) => call(ROUTES.setPin, { id }, { pinned }),
  setNotes: (id, notes) => call(ROUTES.setNotes, { id }, { notes }),
  relocateHarness: (id, newDir) => call(ROUTES.relocate, { id }, { newDir }),
  removeHarness: (id) => call(ROUTES.removeHarness, { id }),

  // per-harness reads
  harness: (id) => call(ROUTES.harness, { id }),
  spec: (id) => call(ROUTES.spec, { id }),
  preflight: (id) => call(ROUTES.preflight, { id }),
  sessions: (id) => call(ROUTES.sessions, { id }),
  session: (id, sess) => call(ROUTES.session, { id, sess }),
  evals: (id) => call(ROUTES.evals, { id }),
  evalRun: (id, runId) => call(ROUTES.evalRun, { id, runId }),
  evalSample: (id, runId, sampleId) => call(ROUTES.evalSample, { id, runId, sampleId }),
  memory: (id, area) => call(ROUTES.memory, { id, area }),
  wikiArticle: (id, slug) => call(ROUTES.wikiArticle, { id, slug }),
  costs: (id) => call(ROUTES.costs, { id }),

  // cross-cutting
  version: () => call(ROUTES.version, {}),
};
