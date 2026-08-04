/**
 * The route contract as pure data — the ONE place client code names a
 * server path. `api.js` builds every request from this map, and the hangar
 * server's contract test (`packages/hangar-server/src/contract.test.ts`)
 * imports the same map and drives every route here against a live fixture
 * server: writes must 2xx with a visible effect, reads must 2xx with every
 * field the views consume present. A route drifting from the server fails
 * that test — the alarm that keeps this file honest.
 *
 * Each entry: `{ method, path }` where `path` is a template whose `:name`
 * segments `buildPath` fills (values URI-encoded). Writes carry `body`, the
 * name of their request-body shape (documentation for humans + the contract
 * test; the shapes themselves are defined by the server handlers).
 * `stream: "sse"` marks a route whose response is `text/event-stream`, not
 * JSON — `api.js` must not `res.json()` it.
 *
 * M1 was read-only over harness state. M2 makes the console a DRIVER: the
 * process routes start/stop/restart/drain a supervised harness, the control
 * routes proxy `crewhaus.control.v1` (the token is read server-side and
 * never crosses this boundary), and the approvals/review routes settle
 * parked work through the same stores the CLI writes through.
 */

export const ROUTES = {
  // cross-cutting
  version: { method: "GET", path: "/api/version" },

  // fleet feed + registry CRUD (the ONLY writes in M1 — manager state)
  harnesses: { method: "GET", path: "/api/harnesses" },
  addHarness: { method: "POST", path: "/api/harnesses", body: "AddHarness" }, // {dir}
  scan: { method: "POST", path: "/api/scan", body: "Empty" }, // {}
  groups: { method: "GET", path: "/api/registry/groups" },
  addGroup: { method: "POST", path: "/api/registry/groups", body: "GroupCreate" }, // {name, color?}
  addScanRoot: { method: "POST", path: "/api/registry/scan-roots", body: "ScanRootCreate" }, // {dir}
  removeHarness: { method: "DELETE", path: "/api/h/:id" },
  relocate: { method: "POST", path: "/api/h/:id/relocate", body: "Relocate" }, // {newDir}
  setGroups: { method: "PUT", path: "/api/h/:id/groups", body: "SetGroups" }, // {groups}
  setTags: { method: "PUT", path: "/api/h/:id/tags", body: "SetTags" }, // {tags}
  setPin: { method: "PUT", path: "/api/h/:id/pin", body: "SetPin" }, // {pinned}
  setNotes: { method: "PUT", path: "/api/h/:id/notes", body: "SetNotes" }, // {notes}

  // per-harness reads
  harness: { method: "GET", path: "/api/h/:id" },
  spec: { method: "GET", path: "/api/h/:id/spec" },
  preflight: { method: "GET", path: "/api/h/:id/preflight" },
  sessions: { method: "GET", path: "/api/h/:id/sessions" },
  session: { method: "GET", path: "/api/h/:id/sessions/:sess" },
  evals: { method: "GET", path: "/api/h/:id/evals" },
  evalRun: { method: "GET", path: "/api/h/:id/evals/:runId" },
  evalSample: { method: "GET", path: "/api/h/:id/evals/:runId/:sampleId" },
  memory: { method: "GET", path: "/api/h/:id/memory/:area" },
  wikiArticle: { method: "GET", path: "/api/h/:id/memory/wiki/:slug" },
  costs: { method: "GET", path: "/api/h/:id/costs" },

  // ---- M2: the process layer -------------------------------------------
  // `start` runs the preflight gate FIRST and answers the typed refusal
  // instead of spawning; `{force}` waves through every forceable blocking
  // item and `{acknowledge:[id]}` waves through named ones — neither can
  // clear an UNFORCEABLE finding (missing channel secrets), because the
  // compiled daemon exits 2 on exactly that set.
  proc: { method: "GET", path: "/api/h/:id/proc" },
  procStart: { method: "POST", path: "/api/h/:id/proc/start", body: "ProcStart" }, // {force?, acknowledge?}
  procStop: { method: "POST", path: "/api/h/:id/proc/stop", body: "Empty" }, // {}
  procRestart: { method: "POST", path: "/api/h/:id/proc/restart", body: "ProcStart" }, // {force?, acknowledge?}
  procDrain: { method: "POST", path: "/api/h/:id/proc/drain", body: "Empty" }, // {}

  // run history + the live feed. `runEvents` is SSE: it opens with a
  // `replay` frame of durable history and ALWAYS ends with `done`.
  runs: { method: "GET", path: "/api/h/:id/runs" },
  run: { method: "GET", path: "/api/h/:id/runs/:runId" },
  runEvents: { method: "GET", path: "/api/h/:id/runs/:runId/events", stream: "sse" },

  // ---- M2: crewhaus.control.v1 proxy -----------------------------------
  // Always 200 with a typed envelope: `{ok:true,…}` or `{ok:false, code,
  // reason, retryable, expected}`. `no_control_port` (pre-0.5.0 bundle) and
  // `lane_not_armed` are FACTS, not errors — render disabled-with-reason.
  // The two 409s differ: `tick_in_flight` retries, `draining` does not.
  controlStatus: { method: "GET", path: "/api/h/:id/control/status" },
  controlWake: { method: "POST", path: "/api/h/:id/control/wake", body: "ControlWake" }, // {lane, reason?}
  controlDrain: { method: "POST", path: "/api/h/:id/control/drain", body: "Empty" }, // {}

  // the four-lane timeline: spec cadence (offline) merged with control.v1
  // phase (online only), plus dream state and janitor rows
  schedulers: { method: "GET", path: "/api/h/:id/schedulers" },

  // ---- M2: fleet inboxes ------------------------------------------------
  approvals: { method: "GET", path: "/api/approvals" },
  grantApproval: {
    method: "POST",
    path: "/api/h/:id/approvals/:apprId/grant",
    body: "ApprovalDecision", // {by?}
  },
  denyApproval: {
    method: "POST",
    path: "/api/h/:id/approvals/:apprId/deny",
    body: "ApprovalDecision", // {by?}
  },
  review: { method: "GET", path: "/api/review" },
  adjudicateReview: {
    method: "POST",
    path: "/api/h/:id/review/:itemId",
    body: "ReviewVerdict", // {verdict: up|down|pass|fail, note?}
  },
  activity: { method: "GET", path: "/api/activity" }, // ?since=<iso|epochMs|7d>

  // ---- M2: jobs + the remaining action faces ----------------------------
  jobs: { method: "GET", path: "/api/jobs" },
  submitJob: { method: "POST", path: "/api/h/:id/jobs", body: "JobSubmit" }, // {kind, dataset?, graders?}
  deployments: { method: "GET", path: "/api/h/:id/deployments" },
  pinSession: { method: "POST", path: "/api/h/:id/sessions/:sess/pin", body: "PinSession" }, // {pinned}
  pinBaseline: { method: "POST", path: "/api/h/:id/evals/baseline", body: "PinBaseline" }, // {runId}
};

/** Fill a path template's `:name` segments from `params`, URI-encoding each
 *  value. Throws on a missing param — a build bug, never a user input. */
export function buildPath(template, params = {}) {
  return template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new Error(`missing route param "${name}" for ${template}`);
    }
    return encodeURIComponent(String(value));
  });
}
