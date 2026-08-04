/**
 * The M1 route contract as pure data — the ONE place client code names a
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
