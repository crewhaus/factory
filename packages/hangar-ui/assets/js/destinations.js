/**
 * The fleet side of the console: the four destinations in the header, Home's
 * panels, the Harnesses views, the connection kinds and the Settings pages.
 * Pure data plus lazy loaders, like the section tables: importing it loads no
 * view. A row is `{ id, title, describe, load, render }`, one per line, so an
 * area adds a page by appending a row; the router derives its grammar and the
 * route templates from these tables, and the shell draws from them.
 *
 * `load` names its module by a literal path, and `render` receives what
 * it resolved, the root to draw into and the view context (`{ route,
 * signal, setSub }`).
 */

/** The destinations, in header order. `badge` names the count the link wears. */
export const DESTINATIONS = Object.freeze([
  Object.freeze({ id: "home", label: "Home", path: "#/", badge: "needs-you" }),
  Object.freeze({ id: "harnesses", label: "Harnesses", path: "#/harnesses" }),
  Object.freeze({ id: "people", label: "People", path: "#/people" }),
  Object.freeze({ id: "connections", label: "Connections", path: "#/connections" }),
]);

/** The Needs-you filters, as `?type=<id>`. */
export const NEEDS_YOU_FILTERS = Object.freeze([
  Object.freeze({ id: "approvals", label: "Approvals" }),
  Object.freeze({ id: "review", label: "Review" }),
  Object.freeze({ id: "advice", label: "Advice" }),
]);

/**
 * Home's panels. Each draws a short list on Home (`panel`) and owns the page
 * its "See all" opens (`#/home/<id>`, drawn by `load`/`render`). Each panel
 * loads, empties and fails on its own.
 */
// biome-ignore format: one row per line, so an area appends its row without touching the shell
export const HOME_PANELS = Object.freeze([
  { id: "needs-you", title: "Needs you", describe: "Approvals, review items and advice waiting on a person.", filters: NEEDS_YOU_FILTERS, panel: { load: () => import("./views/home.js"), render: (m, root, ctx) => m.renderNeedsYouPanel(root, ctx) }, load: () => import("./views/needs-you.js"), render: (m, root, ctx) => m.renderNeedsYou(root, ctx) },
  { id: "working", title: "Working now", describe: "Harnesses whose process is running.", panel: { load: () => import("./views/home.js"), render: (m, root, ctx) => m.renderWorkingPanel(root, ctx) }, load: () => import("./views/runs.js"), render: (m, root, ctx) => m.renderRunsBoard(root, ctx) },
  { id: "changes", title: "What changed", describe: "What happened across your harnesses in the last day.", panel: { load: () => import("./views/home.js"), render: (m, root, ctx) => m.renderChangesPanel(root, ctx) }, load: () => import("./views/activity.js"), render: (m, root, ctx) => m.renderActivity(root, ctx) },
]);

/** The Harnesses views beside the list. */
// biome-ignore format: one row per line, so an area appends its row without touching the shell
export const HARNESS_VIEWS = Object.freeze([
  { id: "health", title: "Health", describe: "Every harness's health score, worst first.", load: () => import("./views/health.js"), render: (m, root, ctx) => m.renderHealthBoard(root, ctx) },
  { id: "feedback", title: "Feedback", describe: "Ratings and comments across every harness.", load: () => import("./views/feedback.js"), render: (m, root, ctx) => m.renderFeedbackBoard(root, ctx) },
]);

/** People's pages. None yet: the index says where profiles are kept. */
export const PEOPLE_PAGES = Object.freeze([]);

/**
 * The connection kinds with a fleet view. Settings that belong to one harness
 * live in that harness's Setup.
 */
// biome-ignore format: one row per line, so an area appends its row without touching the shell
export const CONNECTION_KINDS = Object.freeze([
  { id: "credentials", title: "Credentials", describe: "Which keys each harness has, provider by provider. Values are never shown.", load: () => import("./views/creds.js"), render: (m, root, ctx) => m.renderCredentialsMatrix(root, ctx) },
  { id: "thredz", title: "Thredz", describe: "The Thredz workspaces your harnesses share.", load: () => import("./views/thredz.js"), render: (m, root, ctx) => m.renderThredzGlobal(root, ctx) },
]);

/** The Settings pages, in menu order. */
// biome-ignore format: one row per line, so an area appends its row without touching the shell
export const SETTINGS_PAGES = Object.freeze([
  { id: "readability", title: "Readability", describe: "Text size, density, motion, contrast, shortcuts and theme on this device.", load: () => import("./views/settings.js"), render: (m, root, ctx) => m.renderReadabilitySettings(root, ctx) },
  { id: "notifications", title: "Notifications", describe: "What interrupts you, where, and when it stays quiet.", load: () => import("./views/settings.js"), render: (m, root, ctx) => m.renderNotificationSettings(root, ctx) },
  { id: "home", title: "Home settings", describe: "Read-only mode, and the plugins this Home has installed.", load: () => import("./views/settings.js"), render: (m, root, ctx) => m.renderHomeSettings(root, ctx) },
  { id: "account", title: "Your account", describe: "Sign this browser out, or allow a sign-in from another computer.", load: () => import("./views/settings.js"), render: (m, root, ctx) => m.renderAccountSettings(root, ctx) },
]);

/**
 * Every fleet address: its first path segment, its title, the page at its
 * index, and the table of pages under it. Home's index is `#/`; the others
 * are `#/<segment>`. `indexLabel` names the index in the area's own list.
 */
export const FLEET_AREAS = Object.freeze([
  Object.freeze({
    id: "home",
    segment: "home",
    title: "Home",
    pages: HOME_PANELS,
    index: {
      load: () => import("./views/home.js"),
      render: (m, root, ctx) => m.renderHome(root, ctx),
    },
  }),
  Object.freeze({
    id: "harnesses",
    segment: "harnesses",
    title: "Harnesses",
    indexLabel: "List",
    pages: HARNESS_VIEWS,
    index: {
      load: () => import("./views/library.js"),
      render: (m, root, ctx) => m.renderLibrary(root, ctx),
    },
  }),
  Object.freeze({
    id: "people",
    segment: "people",
    title: "People",
    pages: PEOPLE_PAGES,
    index: {
      load: () => import("./views/people.js"),
      render: (m, root, ctx) => m.renderPeople(root, ctx),
    },
  }),
  Object.freeze({
    id: "connections",
    segment: "connections",
    title: "Connections",
    indexLabel: "All connections",
    pages: CONNECTION_KINDS,
    index: {
      load: () => import("./views/connections.js"),
      render: (m, root, ctx) => m.renderConnections(root, ctx),
    },
  }),
  Object.freeze({
    id: "device",
    segment: "device",
    title: "Sign in a device",
    pages: [],
    index: {
      load: () => import("./views/device.js"),
      render: (m, root, ctx) => m.renderDevice(root, ctx),
    },
  }),
  Object.freeze({
    id: "settings",
    segment: "settings",
    title: "Settings",
    indexLabel: "All settings",
    pages: SETTINGS_PAGES,
    index: {
      load: () => import("./views/settings-index.js"),
      render: (m, root, ctx) => m.renderSettingsIndex(root, ctx),
    },
  }),
]);

/** A fleet area by id, or null. */
export function fleetArea(id) {
  return FLEET_AREAS.find((area) => area.id === id) ?? null;
}

/** A page of a fleet area by id, or null. */
export function fleetPage(area, id) {
  const a = typeof area === "string" ? fleetArea(area) : area;
  if (a === null || a === undefined) return null;
  return a.pages.find((page) => page.id === id) ?? null;
}
