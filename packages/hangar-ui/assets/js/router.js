/**
 * Hash router. Everything here is pure (unit-tested under bun) except
 * `startRouter`, the only function that touches `window`, so importing this
 * module outside a browser is safe.
 *
 * The grammar (every screen deep-linkable; `?key=value` pairs after the path
 * are decoded into `route.query`, and a key nobody reads is kept and ignored):
 *
 *   #/                                  Home
 *   #/home/<panel>[?type=<filter>]      a Home panel's page (needs-you, working, changes)
 *   #/harnesses[/<view>]                the harness list, or its health or feedback view
 *   #/people                            People
 *   #/connections[/<kind>]              the connection kinds with a fleet view
 *   #/settings[/<page>]                 Settings
 *   #/h/<id>                            a harness's Overview
 *   #/h/<id>/<section>[/<sub>[/…rest]]  section ∈ overview | work | quality | knowledge | setup
 *
 * The fleet pages come from `destinations.js` and the harness sub-views from
 * `sections/*.js`, so a new page is a table row, not a router edit. Ids in
 * `#/h/<id>` are opaque.
 *
 * Every address the console used before this grammar redirects through ONE
 * table, `LEGACY_ROUTES`: `startRouter` replaces the address in place (no
 * history entry), `parseRoute` reads through it, and `hrefHarness` and
 * `hrefGlobal` build their old addresses and answer what it says, so their
 * call sites and the server's `screen` ids keep working unedited.
 */

import { FLEET_AREAS, fleetArea, fleetPage } from "./destinations.js";
import {
  CAPTURE_TOKENS,
  SECTIONS,
  SECTION_IDS,
  SHAPE_GATED_TABS,
  sectionById,
  subViewAvailability,
  subViewOf,
} from "./sections/index.js";

export { SHAPE_TARGETS } from "./shapes.js";
export { SECTION_IDS, SHAPE_GATED_TABS, subViewAvailability };

/** The harness tabs the console had before the five sections. Old addresses only. */
export const LEGACY_HARNESS_TABS = Object.freeze([
  "overview",
  "advisor",
  "spec",
  "runs",
  "schedulers",
  "sessions",
  "evals",
  "memory",
  "data",
  "feedback",
  "costs",
  "models",
  "creds",
  "channels",
  "security",
  "thredz",
  "deploy",
  "inspect",
  "dev",
  "panes",
]);

/** The old tabs that took their trailing segments generically. Old addresses only. */
export const LEGACY_REST_TABS = Object.freeze([
  "data",
  "models",
  "feedback",
  "creds",
  "channels",
  "security",
  "thredz",
  "inspect",
  "dev",
  "advisor",
]);

/** The fleet screens the console had at `#/<view>`. Old addresses only. */
export const LEGACY_GLOBAL_VIEWS = Object.freeze([
  "runs",
  "approvals",
  "review",
  "activity",
  "credentials",
  "feedback",
  "thredz",
  "health",
  "settings",
  "advisor",
]);

/**
 * Every old address and where it lives now, first match wins. A pattern
 * segment is a literal, `:name` (one segment), `[:name]` (one, if there is
 * one) or a final `*` (whatever is left). The new address takes the same
 * captures; a `*` it does not name is dropped, as the old router ignored
 * those segments. The address's own query is kept.
 *
 * `#/settings` and `#/` are absent on purpose: both are new addresses too.
 * The wiki article row comes before the memory row, because the memory
 * fabric's Wiki panel is `knowledge/memory/wiki` and an article is not.
 */
export const LEGACY_ROUTES = Object.freeze(
  [
    ["#/runs", "#/home/working"],
    ["#/approvals", "#/home/needs-you?type=approvals"],
    ["#/review", "#/home/needs-you?type=review"],
    ["#/advisor", "#/home/needs-you?type=advice"],
    ["#/activity", "#/home/changes"],
    ["#/health", "#/harnesses/health"],
    ["#/feedback", "#/harnesses/feedback"],
    ["#/credentials", "#/connections/credentials"],
    ["#/thredz", "#/connections/thredz"],
    ["#/h/:id/overview", "#/h/:id"],
    ["#/h/:id/advisor/*", "#/h/:id/overview/needs-you/*"],
    ["#/h/:id/spec/*", "#/h/:id/setup/spec"],
    ["#/h/:id/runs/[:run]/*", "#/h/:id/work/runs/[:run]"],
    ["#/h/:id/schedulers/*", "#/h/:id/work/schedule"],
    ["#/h/:id/sessions/[:session]/*", "#/h/:id/work/sessions/[:session]"],
    ["#/h/:id/evals/[:run]/[:sample]/*", "#/h/:id/quality/results/[:run]/[:sample]"],
    ["#/h/:id/memory/wiki/:slug/*", "#/h/:id/knowledge/wiki/:slug"],
    ["#/h/:id/memory/*", "#/h/:id/knowledge/memory"],
    ["#/h/:id/data/*", "#/h/:id/quality/datasets/*"],
    ["#/h/:id/feedback/*", "#/h/:id/quality/feedback/*"],
    ["#/h/:id/costs/*", "#/h/:id/setup/budget"],
    ["#/h/:id/models/*", "#/h/:id/setup/models/*"],
    ["#/h/:id/creds/*", "#/h/:id/setup/credentials/*"],
    ["#/h/:id/channels/*", "#/h/:id/setup/channels/*"],
    ["#/h/:id/security/*", "#/h/:id/setup/security/*"],
    ["#/h/:id/thredz/*", "#/h/:id/knowledge/thredz/*"],
    ["#/h/:id/deploy/*", "#/h/:id/setup/deployment"],
    ["#/h/:id/inspect/*", "#/h/:id/setup/files/*"],
    ["#/h/:id/dev/*", "#/h/:id/setup/tools/*"],
    ["#/h/:id/panes/*", "#/h/:id/setup/plugins"],
  ].map(([from, to]) => Object.freeze({ from, to })),
);

function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** `#/a/b?k=v` → the raw path segments (empty ones dropped) and raw query pairs. */
function splitHash(hash) {
  const raw = typeof hash === "string" ? hash : "";
  const h = raw.startsWith("#") ? raw.slice(1) : raw;
  const at = h.indexOf("?");
  const path = at === -1 ? h : h.slice(0, at);
  const qs = at === -1 ? "" : h.slice(at + 1);
  return {
    segments: path.split("/").filter((part) => part !== ""),
    pairs: qs.split("&").filter((pair) => pair !== ""),
  };
}

/** Raw `k=v` pairs → `{ key: value }`, decoded. A later key wins. */
function decodeQuery(pairs) {
  const query = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = safeDecode(eq === -1 ? pair : pair.slice(0, eq));
    if (key === "" || key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    query[key] = eq === -1 ? "" : safeDecode(pair.slice(eq + 1));
  }
  return query;
}

/** Match raw segments against a pattern's; the captures, or null. */
function matchPattern(pattern, segments) {
  const captures = {};
  let at = 0;
  for (const part of pattern) {
    if (part === "*") {
      captures["*"] = segments.slice(at);
      return captures;
    }
    if (part.startsWith("[:") && part.endsWith("]")) {
      if (at < segments.length) captures[part.slice(2, -1)] = segments[at++];
      continue;
    }
    if (at >= segments.length) return null;
    if (part.startsWith(":")) captures[part.slice(1)] = segments[at++];
    else if (part === segments[at]) at += 1;
    else return null;
  }
  return at === segments.length ? captures : null;
}

const LEGACY_PATTERNS = LEGACY_ROUTES.map((row) => ({
  from: splitHash(row.from).segments,
  to: splitHash(row.to),
}));

/**
 * The new address for an old one, or null when `hash` is not an old address
 * (a new address, or one no screen ever answered). Pure; segments are kept
 * exactly as written, so an encoded id stays encoded.
 */
export function redirectFor(hash) {
  const { segments, pairs } = splitHash(hash);
  for (const row of LEGACY_PATTERNS) {
    const captures = matchPattern(row.from, segments);
    if (captures === null) continue;
    const out = [];
    for (const part of row.to.segments) {
      if (part === "*") out.push(...(captures["*"] ?? []));
      else if (part.startsWith("[:") && part.endsWith("]")) {
        const value = captures[part.slice(2, -1)];
        if (value !== undefined) out.push(value);
      } else if (part.startsWith(":")) out.push(captures[part.slice(1)]);
      else out.push(part);
    }
    const keys = new Set(row.to.pairs.map((pair) => safeDecode(pair.split("=")[0])));
    const query = [
      ...row.to.pairs,
      ...pairs.filter((pair) => !keys.has(safeDecode(pair.split("=")[0]))),
    ];
    return `#/${out.join("/")}${query.length > 0 ? `?${query.join("&")}` : ""}`;
  }
  return null;
}

function fleetRoute(area, sub, query) {
  return { view: area, section: null, sub, rest: [], query };
}

function parseHarness(id, tail, query, raw) {
  const route = { view: "harness", id, section: "overview", sub: null, rest: [], query };
  if (tail.length === 0) return route;
  const section = sectionById(tail[0]);
  if (section === null) return { view: "notfound", hash: raw };
  route.section = section.id;
  if (tail.length === 1) return route;
  const row = subViewOf(section, tail[1]);
  if (row === null) return { view: "notfound", hash: raw };
  route.sub = row.id;
  const rest = tail.slice(2);
  if (Array.isArray(row.capture)) {
    if (rest.length > row.capture.length) return { view: "notfound", hash: raw };
    if (row.required === true && rest.length < row.capture.length) {
      return { view: "notfound", hash: raw };
    }
    row.capture.forEach((name, i) => {
      if (rest[i] !== undefined) route[name] = rest[i];
    });
  } else if (row.rest !== true && rest.length > 0) {
    return { view: "notfound", hash: raw };
  }
  route.rest = rest;
  return route;
}

/**
 * Parse a location hash into a route object. Never throws. An old address
 * parses as the new one it redirects to; an unknown one is `notfound`.
 *
 *   fleet:    { view: <area>, section: null, sub: <page id> | null, rest: [], query }
 *   harness:  { view: "harness", id, section, sub, rest, query,
 *               runId?, sampleId?, sessionId?, wikiSlug? }
 *   unknown:  { view: "notfound", hash }
 */
export function parseRoute(hash) {
  const raw = typeof hash === "string" ? hash : "";
  const { segments, pairs } = splitHash(redirectFor(raw) ?? raw);
  const parts = segments.map(safeDecode);
  const query = decodeQuery(pairs);
  if (parts.length === 0) return fleetRoute("home", null, query);
  if (parts[0] === "h") {
    if (parts.length < 2) return { view: "notfound", hash: raw };
    return parseHarness(parts[1], parts.slice(2), query, raw);
  }
  const area = FLEET_AREAS.find((a) => a.segment === parts[0]);
  if (area === undefined) return { view: "notfound", hash: raw };
  if (parts.length === 1) return fleetRoute(area.id, null, query);
  if (parts.length === 2 && fleetPage(area, parts[1]) !== null) {
    return fleetRoute(area.id, parts[1], query);
  }
  return { view: "notfound", hash: raw };
}

/**
 * A harness link. `tab` may be a section id (`hrefHarness(id, "work",
 * "runs", runId)`) or a tab id from before the sections
 * (`hrefHarness(id, "memory", "wiki", slug)`): the old address is built and
 * the legacy table decides where it lives now, so every call site and every
 * server `screen` id lands where it always meant to.
 */
export function hrefHarness(id, tab = "overview", ...rest) {
  const segs = [`#/h/${encodeURIComponent(id)}`];
  if (tab !== "overview" || rest.length > 0) segs.push(tab);
  for (const part of rest) segs.push(encodeURIComponent(String(part)));
  const built = segs.join("/");
  return redirectFor(built) ?? built;
}

/** A fleet screen's link by its old name or its new path (`approvals`, `harnesses/health`). */
export function hrefGlobal(view) {
  const built = `#/${view}`;
  return redirectFor(built) ?? built;
}

/** A fleet page's link: an area's index, or one of its pages. */
export function hrefFleet(area, page = null, query = null) {
  const a = fleetArea(area);
  const base =
    a === null ? `#/${area}` : a.id === "home" && page === null ? "#/" : `#/${a.segment}`;
  const path = page === null ? base : `${base}/${encodeURIComponent(page)}`;
  const pairs =
    query === null
      ? []
      : Object.entries(query).map(
          ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
        );
  return pairs.length > 0 ? `${path}?${pairs.join("&")}` : path;
}

/** Home's link. */
export function hrefHome() {
  return "#/";
}

/** The harness list's link (what the Library was). */
export function hrefLibrary() {
  return "#/harnesses";
}

/** The template a route stands for, as the gate and the ready mark spell it. */
export function routeTemplate(route) {
  if (!route || typeof route !== "object") return null;
  if (route.view === "notfound") return null;
  if (route.view === "harness") {
    const base = route.section === "overview" && route.sub === null ? "#/h/:id" : null;
    if (base !== null) return base;
    if (route.sub === null) return `#/h/:id/${route.section}`;
    const row = subViewOf(route.section, route.sub);
    const tokens = Array.isArray(row?.capture)
      ? row.capture.filter((name) => route[name] !== undefined).map((n) => CAPTURE_TOKENS[n])
      : [];
    return [`#/h/:id/${route.section}/${route.sub}`, ...tokens].join("/");
  }
  const area = fleetArea(route.view);
  if (area === null) return null;
  if (route.sub === null) return area.id === "home" ? "#/" : `#/${area.segment}`;
  const page = fleetPage(area, route.sub);
  const type = route.query?.type;
  const filtered =
    Array.isArray(page?.filters) && page.filters.some((f) => f.id === type) ? `?type=${type}` : "";
  return `#/${area.segment}/${route.sub}${filtered}`;
}

function deriveTemplates() {
  const out = [];
  for (const area of FLEET_AREAS) {
    out.push(area.id === "home" ? "#/" : `#/${area.segment}`);
    for (const page of area.pages) {
      out.push(`#/${area.segment}/${page.id}`);
      for (const filter of page.filters ?? []) {
        out.push(`#/${area.segment}/${page.id}?type=${filter.id}`);
      }
    }
  }
  for (const section of SECTIONS) {
    out.push(section.id === "overview" ? "#/h/:id" : `#/h/:id/${section.id}`);
    for (const row of section.views) {
      const base = `#/h/:id/${section.id}/${row.id}`;
      if (row.required !== true) out.push(base);
      if (row.deep === true)
        out.push([base, ...row.capture.map((n) => CAPTURE_TOKENS[n])].join("/"));
    }
  }
  return Object.freeze(out);
}

/**
 * Every fleet and harness template the console serves, derived from the
 * destination and section tables. The accessibility gate sweeps each one.
 */
export const ROUTE_TEMPLATES = deriveTemplates();

const TOKEN_PARAMS = {
  ":id": "id",
  ":run": "run",
  ":session": "session",
  ":slug": "slug",
  ":sample": "sample",
};

/** A template filled in: `routeFor("#/h/:id/work/runs/:run", { id, run })`. Throws on a missing value. */
export function routeFor(template, params = {}) {
  const [path, query] = String(template).split("?");
  const filled = path
    .split("/")
    .map((part) => {
      if (!Object.hasOwn(TOKEN_PARAMS, part)) return part;
      const value = params[TOKEN_PARAMS[part]];
      if (typeof value !== "string" || value === "") {
        throw new Error(`routeFor: ${template} needs ${TOKEN_PARAMS[part]}`);
      }
      return encodeURIComponent(value);
    })
    .join("/");
  return query === undefined ? filled : `${filled}?${query}`;
}

/** The heading a fleet page carries, or null for a route that is not one. */
export function fleetHeading(route) {
  const area = fleetArea(route?.view);
  if (area === null) return null;
  if (route.sub === null) return area.title;
  return fleetPage(area, route.sub)?.title ?? area.title;
}

/** `<Section> › <sub-view>` for a harness route ("Setup › Spec"), or the section alone. */
export function sectionLabel(route) {
  const section = sectionById(route?.section);
  if (section === null) return "";
  if (route.sub === null) return section.label;
  return `${section.label} › ${subViewOf(section, route.sub)?.label ?? route.sub}`;
}

/**
 * The link for a server `screen` id on harness `id`: the approvals inbox is
 * a fleet screen, every other screen is on the harness. The advisor and
 * health views link through this, and `screenLabel` names what it builds.
 */
export function screenHref(id, screen) {
  const s = String(screen ?? "");
  return s === "approvals" ? hrefGlobal(s) : hrefHarness(id, s);
}

/**
 * Where a server `screen` id is fixed, in the console's words: "Setup › Spec"
 * for `spec`, "Home › Needs you" for `approvals`. It names the route
 * `screenHref` builds, so the label and the link can never disagree.
 */
export function screenLabel(screen) {
  const id = String(screen ?? "");
  const route = parseRoute(screenHref("_", id));
  if (route.view === "harness") return sectionLabel(route);
  const area = fleetArea(route.view);
  if (area === null) return id;
  return route.sub === null ? area.title : `${area.title} › ${fleetHeading(route)}`;
}

/**
 * The document title for a route: `<page> — Hangar`, or
 * `<sub-view> — <harness name> — Hangar` inside a harness.
 */
export function pageTitle(route, names = {}) {
  if (!route || route.view === "notfound") return "Nothing at this address — Hangar";
  if (route.view === "harness") {
    const section = sectionById(route.section);
    const page =
      route.sub === null ? (section?.label ?? "") : (subViewOf(section, route.sub)?.label ?? "");
    const name =
      typeof names.harness === "string" && names.harness !== "" ? names.harness : route.id;
    return `${page} — ${name} — Hangar`;
  }
  return `${fleetHeading(route) ?? "Hangar"} — Hangar`;
}

/**
 * Wire hashchange → handler and fire once for the current address. An old
 * address is replaced in place first (no history entry, no second
 * hashchange), so the handler sees one navigation to the new route.
 */
export function startRouter(onChange) {
  const go = () => {
    const hash = window.location.hash;
    const target = redirectFor(hash);
    if (target !== null) {
      window.history.replaceState(window.history.state, "", target);
      onChange(parseRoute(target));
      return;
    }
    onChange(parseRoute(hash));
  };
  window.addEventListener("hashchange", go);
  go();
}
