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
 *   #/health                            → the fleet health board (M4)
 *   #/settings                          → notification rules, read-only, plugins (M4)
 *   #/h/<id>/panes                      → sandboxed plugin panes (M4)
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
  // M5: the unified alert/suggestion feed — right after Overview because it
  // is the "what needs doing" screen; the strip order is the triage order.
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
  "creds",
  "channels",
  "security",
  "thredz",
  "deploy",
  "inspect",
  "dev",
  // M4 (HM-179): the sandboxed plugin panes this harness shows. Always on
  // the strip — a harness with no applicable pane renders the honest empty
  // state naming the install verb, which is more useful than a tab that
  // appears only once a plugin exists.
  "panes",
];

/** The M3 tabs, whose trailing segments are captured generically as `rest`.
 *  Shape gating (which tabs a given target shows) is applied where the tab
 *  strip is drawn, through {@link tabAvailability} below — never here: a deep
 *  link to an off-matrix tab must still RESOLVE, because the honest empty
 *  state that tab renders is a real answer and a shared URL must not 404. */
export const M3_TABS = [
  "data",
  "feedback",
  "creds",
  "channels",
  "security",
  "thredz",
  "inspect",
  "dev",
  // M5: the advisor's sub-screens (a saved report, say) are the view's to
  // name — the same generic `rest` capture the M3 tabs use.
  "advisor",
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
  // M4: the fleet health board (HM-11) and Settings (HM-198's console half:
  // notification rules, read-only mode, the plugin inventory).
  "health",
  "settings",
  // M5: the fleet advisor board — every harness's open alerts/suggestions,
  // worst first.
  "advisor",
];

/**
 * The compile targets, in the order the plan's shape × panel matrix lists
 * them. This is the strict union `@crewhaus/spec` validates against; a
 * target that is NOT in this list is unknown to this build, and an unknown
 * shape is gated at nothing — hiding a panel from a shape the console has
 * never heard of would be a guess wearing the clothes of a rule.
 */
export const SHAPE_TARGETS = [
  "cli",
  "workflow",
  "channel",
  "graph",
  "managed",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
  "eval",
  "onchain",
  "onchain-game",
];

/**
 * The shape × panel matrix, as data.
 *
 * Every target gets the universal set — Overview, Spec, Runs, Sessions,
 * Evals, Datasets, Costs, Credentials, Security, Deployments, Inspect and
 * Dev & MCP — because each of those reads something every harness has (a
 * directory, a spec, a session store, a ledger). The five tabs below are
 * per-shape ADDITIONS, and the rule for each is the same one the spec
 * schema already enforces: **a tab is on the matrix for a target when that
 * target's schema admits at least one of the blocks the tab configures.**
 *
 * That rule is deliberately narrower than "the store might hold something":
 * a tab whose subject the target cannot declare has nothing to configure
 * and nothing to wire, so linking to it buys the operator a screen whose
 * only content is the sentence "not applicable". It is also deliberately
 * NOT a hard gate — `parseRoute` still resolves the deep link and the
 * screen still answers, so nothing an operator saved is unreachable.
 */
export const SHAPE_GATED_TABS = {
  channels: {
    // `channels:`, `routing:` and `gateway:` are channel-only in the union.
    shapes: ["channel"],
    why: "a channels: block (with its routing and gateway) is only valid in a channel spec",
  },
  schedulers: {
    // heartbeat: channel · schedule: channel/managed/batch · memory.dream:
    // every shape with a memory block · janitor: the daemon shapes.
    shapes: ["cli", "channel", "managed", "crew", "research", "batch", "voice"],
    why: "no lane can arm here — this target's schema admits no heartbeat:, schedule: or memory.dream: block, and its bundle runs no janitor",
  },
  memory: {
    // memory:/knowledge:/learning:/watchme:, or continuity: on its own.
    shapes: [
      "cli",
      "workflow",
      "channel",
      "managed",
      "crew",
      "research",
      "batch",
      "voice",
      "browser",
    ],
    why: "this target's schema admits neither a memory: nor a continuity: block, so there is no fabric to read",
  },
  feedback: {
    shapes: ["cli", "channel", "managed"],
    why: "this target's schema admits no feedback: block, so the ratings loop — reactions, distill sinks, advice — is not wired here",
  },
  thredz: {
    shapes: ["cli", "channel", "managed", "crew", "research"],
    why: "this target's schema admits no thredz: block, so there is no workspace for the manager to proxy",
  },
};

/**
 * Which tabs this target shows, in strip order.
 *
 * Returns one row per {@link HARNESS_TABS} entry: `{ tab, on, reason }`.
 * `on:false` rows carry the sentence the strip renders instead of a link —
 * a disabled tab that says why is information; a live link into an empty
 * screen is a maze.
 */
export function tabAvailability(target) {
  const shape = typeof target === "string" ? target : "";
  const known = SHAPE_TARGETS.includes(shape);
  return HARNESS_TABS.map((tab) => {
    const gate = Object.hasOwn(SHAPE_GATED_TABS, tab) ? SHAPE_GATED_TABS[tab] : null;
    if (gate === null || !known || gate.shapes.includes(shape)) {
      return { tab, on: true, reason: null };
    }
    return { tab, on: false, reason: `${gate.why} — this harness's target is ${shape}` };
  });
}

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
    case "panes":
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
