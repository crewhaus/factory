/**
 * Hash router. `parseRoute` is pure (unit-tested under bun); `startRouter`
 * is the only function that touches `window`, so importing this module
 * outside a browser is safe.
 *
 * Route map (every screen deep-linkable):
 *   #/                                  → Library
 *   #/h/<id>                            → harness detail, Overview tab
 *   #/h/<id>/spec                       → Spec
 *   #/h/<id>/sessions                   → Sessions list
 *   #/h/<id>/sessions/<sess>            → one transcript
 *   #/h/<id>/evals                      → eval run history
 *   #/h/<id>/evals/<runId>              → one run
 *   #/h/<id>/evals/<runId>/<sampleId>   → one sample
 *   #/h/<id>/memory                     → memory fabric
 *   #/h/<id>/memory/wiki/<slug>         → wiki article reader
 *   #/h/<id>/costs                      → costs
 */

export const HARNESS_TABS = ["overview", "spec", "sessions", "evals", "memory", "costs"];

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
  if (parts[0] !== "h" || parts.length < 2) return { view: "notfound", hash: raw };
  const id = parts[1];
  const tab = parts[2] ?? "overview";
  const rest = parts.slice(3);
  switch (tab) {
    case "overview":
    case "spec":
    case "costs":
      return { view: "harness", id, tab };
    case "sessions":
      return rest[0] !== undefined
        ? { view: "harness", id, tab, sessionId: rest[0] }
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

/** Wire hashchange → handler and fire once for the current hash. */
export function startRouter(onChange) {
  window.addEventListener("hashchange", () => onChange(parseRoute(window.location.hash)));
  onChange(parseRoute(window.location.hash));
}
