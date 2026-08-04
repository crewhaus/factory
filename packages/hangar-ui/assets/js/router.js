/**
 * Hash router. `parseRoute` is pure (unit-tested under bun); `startRouter`
 * is the only function that touches `window`, so importing this module
 * outside a browser is safe.
 *
 * Route map (every screen deep-linkable):
 *   #/                                  → Library
 *   #/runs                              → Runs & daemons (fleet supervision)
 *   #/approvals                         → the approvals inbox
 *   #/review                            → the review queue
 *   #/activity                          → the activity digest
 *   #/h/<id>                            → harness detail, Overview tab
 *   #/h/<id>/spec                       → Spec
 *   #/h/<id>/runs                       → this harness's run ledger
 *   #/h/<id>/runs/<runId>               → one run's console (live SSE feed)
 *   #/h/<id>/schedulers                 → the four-lane timeline
 *   #/h/<id>/sessions                   → Sessions list
 *   #/h/<id>/sessions/<sess>            → one transcript
 *   #/h/<id>/evals                      → eval run history
 *   #/h/<id>/evals/<runId>              → one run
 *   #/h/<id>/evals/<runId>/<sampleId>   → one sample
 *   #/h/<id>/memory                     → memory fabric
 *   #/h/<id>/memory/wiki/<slug>         → wiki article reader
 *   #/h/<id>/costs                      → costs
 *   #/h/<id>/deploy                     → deployment records
 *
 * M3 adds the detail tabs and two more fleet screens:
 *   #/credentials                       → the fleet credential matrix
 *   #/thredz                            → the global Thredz explorer
 *   #/feedback                          → the fleet feedback rollup
 *   #/h/<id>/{data,feedback,creds,channels,security,thredz,inspect,dev}
 * Each M3 tab accepts trailing segments, captured verbatim as `rest` — the
 * sub-screens inside them (a dataset, a store, a Thredz article) are the
 * area implementer's to name, and the router should not have to be edited
 * again for each one.
 */

export const HARNESS_TABS = [
  "overview",
  "spec",
  "runs",
  "schedulers",
  "sessions",
  "evals",
  "memory",
  "data",
  "feedback",
  "costs",
  "creds",
  "channels",
  "security",
  "thredz",
  "deploy",
  "inspect",
  "dev",
];

/** The M3 tabs, whose trailing segments are captured generically as `rest`.
 *  Shape gating (which tabs a given target shows) is applied where the tab
 *  strip is drawn, not here: a deep link must still resolve. */
export const M3_TABS = [
  "data",
  "feedback",
  "creds",
  "channels",
  "security",
  "thredz",
  "inspect",
  "dev",
];

/** The global (fleet-wide) screens, in nav order. `#/` is the Library. */
export const GLOBAL_VIEWS = [
  "runs",
  "approvals",
  "review",
  "activity",
  "credentials",
  "feedback",
  "thredz",
];

function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Parse a location.hash string into a route object. Never throws. */
export function parseRoute(hash) {
  const raw = typeof hash === "string" ? hash : "";
  const h = raw.startsWith("#") ? raw.slice(1) : raw;
  if (h === "" || h === "/") return { view: "library" };
  const parts = h
    .split("/")
    .filter((p) => p !== "")
    .map(safeDecode);
  // Fleet-wide screens live at the root, harness screens under /h/<id>.
  if (parts[0] !== "h") {
    if (parts.length === 1 && GLOBAL_VIEWS.includes(parts[0])) return { view: parts[0] };
    return { view: "notfound", hash: raw };
  }
  if (parts.length < 2) return { view: "notfound", hash: raw };
  const id = parts[1];
  const tab = parts[2] ?? "overview";
  const rest = parts.slice(3);
  switch (tab) {
    case "overview":
    case "spec":
    case "costs":
    case "schedulers":
    case "deploy":
      return { view: "harness", id, tab };
    case "sessions":
      return rest[0] !== undefined
        ? { view: "harness", id, tab, sessionId: rest[0] }
        : { view: "harness", id, tab };
    case "runs":
      return rest[0] !== undefined
        ? { view: "harness", id, tab, runId: rest[0] }
        : { view: "harness", id, tab };
    case "evals": {
      const route = { view: "harness", id, tab };
      if (rest[0] !== undefined) route.runId = rest[0];
      if (rest[1] !== undefined) route.sampleId = rest[1];
      return route;
    }
    case "memory":
      return rest[0] === "wiki" && rest[1] !== undefined
        ? { view: "harness", id, tab, wikiSlug: rest[1] }
        : { view: "harness", id, tab };
    default:
      // The M3 tabs take their trailing segments generically, so adding a
      // sub-screen inside one is a view change, not a router change.
      if (M3_TABS.includes(tab)) {
        return rest.length > 0 ? { view: "harness", id, tab, rest } : { view: "harness", id, tab };
      }
      return { view: "notfound", hash: raw };
  }
}

/** Build a deep link for a harness tab (+ optional trailing segments). */
export function hrefHarness(id, tab = "overview", ...rest) {
  const segs = [`#/h/${encodeURIComponent(id)}`];
  if (tab !== "overview" || rest.length > 0) segs.push(tab);
  for (const part of rest) segs.push(encodeURIComponent(String(part)));
  return segs.join("/");
}

/** The Library link. */
export function hrefLibrary() {
  return "#/";
}

/** A fleet-wide screen's link (`#/runs`, `#/approvals`, …). */
export function hrefGlobal(view) {
  return `#/${view}`;
}

/** Wire hashchange → handler and fire once for the current hash. */
export function startRouter(onChange) {
  window.addEventListener("hashchange", () => onChange(parseRoute(window.location.hash)));
  onChange(parseRoute(window.location.hash));
}
