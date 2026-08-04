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

import { ROUTES, buildPath, m3RouteKeys } from "./routes.js";
import { createSseParser } from "./supervision.js";

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

function authHeaders(accept) {
  const headers = { accept };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** One request, reported as `{ status, body }` — no throwing on a non-2xx.
 *  401 still fires the unauthorized handler (the token screen owns the view). */
async function rawRequest(method, path, body) {
  const headers = authHeaders("application/json");
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
  if (res.status === 404 || res.status === 204) return { status: res.status, body: null };
  let parsed = null;
  let text = "";
  try {
    text = await res.text();
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null; // an unparseable body leaves `text` as the message
  }
  return { status: res.status, body: parsed, text };
}

async function request(method, path, body) {
  const { status, body: parsed, text } = await rawRequest(method, path, body);
  if (status === 404 || status === 204) return null;
  if (status < 200 || status >= 300) {
    throw new ApiError(status, text !== undefined && text !== "" ? text : `HTTP ${status}`);
  }
  return parsed;
}

/** Issue one request from a `ROUTES` entry (+ params + optional body/query). */
function call(route, params, body, query = "") {
  return request(route.method, `${buildPath(route.path, params)}${query}`, body);
}

/**
 * Issue one request whose REFUSAL is a payload, not an error: `POST
 * /proc/{start,restart}` answers 409 with the typed preflight refusal the
 * console renders as a modal, and `POST /proc/{stop,drain}` answers 409
 * `not-adopted` when a daemon is running that this manager never adopted.
 * Swallowing either into an ApiError would throw away the very thing the
 * screen exists to show. Returns `{ ok, status, body }`.
 */
async function callTyped(route, params, body) {
  const {
    status,
    body: parsed,
    text,
  } = await rawRequest(route.method, buildPath(route.path, params), body);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: parsed ?? (text !== undefined && text !== "" ? { message: text } : {}),
  };
}

/** Body for a start/restart: `{}` unless the operator waved findings through. */
function startBody(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const acknowledge = Array.isArray(o.acknowledge) ? o.acknowledge.map(String) : null;
  return {
    ...(o.force === true ? { force: true } : {}),
    ...(acknowledge !== null && acknowledge.length > 0 ? { acknowledge } : {}),
  };
}

/**
 * Open the run's SSE feed. Hand-rolled over `fetch` rather than
 * `EventSource`, which cannot carry the bearer header (its only credential
 * channel is cookies, and this app has none by design).
 *
 * The frame grammar is the server's: `replay` first, then live
 * `state`/`output`/`exit`, and ALWAYS `done` last — so a closed run replays
 * and terminates with no live-vs-dead branch here. A dropped connection
 * emits a synthetic `{ event: "closed" }` so the view can tell the two apart.
 */
export function streamRunEvents(id, runId, onFrame) {
  const controller = new AbortController();
  const path = buildPath(ROUTES.runEvents.path, { id, runId });
  const emit = (event, data) => {
    if (!controller.signal.aborted) onFrame({ event, data });
  };
  (async () => {
    let res;
    try {
      res = await fetch(path, {
        headers: authHeaders("text/event-stream"),
        signal: controller.signal,
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        emit("error", { message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    if (res.status === 401) {
      if (unauthorizedHandler) unauthorizedHandler();
      return;
    }
    if (!res.ok || res.body === null || res.body === undefined) {
      emit("error", { message: res.status === 404 ? "no such run" : `HTTP ${res.status}` });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break; // aborted or dropped — the synthetic `closed` frame says so
      }
      if (chunk.done) break;
      for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
        emit(frame.event, frame.data);
      }
    }
    emit("closed", null);
  })();
  return {
    close: () => {
      controller.abort();
    },
  };
}

/**
 * One M3 request. Uniform signature — `(params, body, query)` — and a
 * uniform ANSWER: `{ ok, status, body }`, never a throw for a non-2xx.
 *
 * That is deliberate for this surface. M3 refusals are the interesting part:
 * a `409` carrying the human-owned spec diff, a `409 stale_article_version`
 * with the version that moved under you, a `501 not implemented (M3)` while
 * a handler is still a stub. Turning any of those into an `ApiError` throws
 * away the exact payload the screen exists to render. `401` still routes to
 * the token screen (that is a session fact, not a route answer).
 */
async function callM3(route, params, body, query) {
  const path = `${buildPath(route.path, params ?? {})}${query ?? ""}`;
  const { status, body: parsed, text } = await rawRequest(route.method, path, body);
  return {
    ok: status >= 200 && status < 300,
    status,
    body: parsed ?? (text !== undefined && text !== "" ? { message: text } : {}),
  };
}

/**
 * The M3 wrappers, GENERATED from the route map rather than hand-written.
 *
 * There are ~180 of them across eleven groups; typing each one out would be
 * 180 chances to mistype a path that the contract test would then have to
 * catch. Generating them makes the map the only place a path exists on this
 * side, which is the same reason `routes.js` exists at all. Each wrapper
 * takes `(params, body, query)`; writes default to an empty body so a
 * no-argument call is still a well-formed request.
 */
const m3Api = {};
for (const key of m3RouteKeys()) {
  const route = ROUTES[key];
  const needsBody = route.method === "POST" || route.method === "PUT";
  m3Api[key] = (params, body, query) =>
    callM3(route, params, needsBody ? (body ?? {}) : undefined, query);
}

/**
 * Every server route the console talks to — thin named wrappers over the
 * `ROUTES` contract map. M1's writes were registry CRUD only (manager
 * state); M2 adds the driving verbs: process control, the control.v1 proxy,
 * the two inboxes' decisions, the job queue, and the two action faces
 * (session pin, eval baseline); M3's detail surface is spread in from the
 * generated wrappers above (hand-written names below win a collision, so a
 * route that later earns a friendlier signature can simply be written out).
 */
export const api = {
  ...m3Api,
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

  // ---- M2: the process layer ------------------------------------------
  proc: (id) => call(ROUTES.proc, { id }),
  // start/restart answer 409 with a typed refusal — surfaced, not thrown.
  procStart: (id, opts) => callTyped(ROUTES.procStart, { id }, startBody(opts)),
  procRestart: (id, opts) => callTyped(ROUTES.procRestart, { id }, startBody(opts)),
  // …and so do stop/drain: a 409 `not-adopted` says a daemon IS running
  // that this manager never adopted, so nothing was signalled. Thrown away
  // as an ApiError it reads as a transport fault; kept as a body the console
  // can say what actually happened.
  procStop: (id) => callTyped(ROUTES.procStop, { id }, {}),
  procDrain: (id) => callTyped(ROUTES.procDrain, { id }, {}),

  // run history + one run's detail (the live feed is `streamRunEvents`)
  runs: (id) => call(ROUTES.runs, { id }),
  run: (id, runId) => call(ROUTES.run, { id, runId }),

  // ---- M2: crewhaus.control.v1 (always a 200 envelope) ------------------
  controlStatus: (id) => call(ROUTES.controlStatus, { id }),
  controlWake: (id, lane, reason) =>
    call(
      ROUTES.controlWake,
      { id },
      typeof reason === "string" && reason !== "" ? { lane, reason } : { lane },
    ),
  controlDrain: (id) => call(ROUTES.controlDrain, { id }, {}),
  schedulers: (id) => call(ROUTES.schedulers, { id }),

  // ---- M2: fleet inboxes ------------------------------------------------
  approvals: (all = false) => call(ROUTES.approvals, {}, undefined, all ? "?all=1" : ""),
  grantApproval: (id, apprId, by) =>
    call(ROUTES.grantApproval, { id, apprId }, typeof by === "string" && by !== "" ? { by } : {}),
  denyApproval: (id, apprId, by) =>
    call(ROUTES.denyApproval, { id, apprId }, typeof by === "string" && by !== "" ? { by } : {}),
  review: (all = false) => call(ROUTES.review, {}, undefined, all ? "?all=1" : ""),
  adjudicateReview: (id, itemId, verdict, note) =>
    call(
      ROUTES.adjudicateReview,
      { id, itemId },
      typeof note === "string" && note !== "" ? { verdict, note } : { verdict },
    ),
  activity: (since) =>
    call(
      ROUTES.activity,
      {},
      undefined,
      typeof since === "string" && since !== "" ? `?since=${encodeURIComponent(since)}` : "",
    ),

  // ---- M2: jobs + the remaining action faces ----------------------------
  jobs: () => call(ROUTES.jobs, {}),
  submitJob: (id, kind, options) =>
    call(
      ROUTES.submitJob,
      { id },
      { kind, ...(options && typeof options === "object" ? options : {}) },
    ),
  deployments: (id) => call(ROUTES.deployments, { id }),
  pinSession: (id, sess, pinned) => call(ROUTES.pinSession, { id, sess }, { pinned }),
  pinBaseline: (id, runId) => call(ROUTES.pinBaseline, { id }, { runId }),

  // cross-cutting
  version: () => call(ROUTES.version, {}),
};
