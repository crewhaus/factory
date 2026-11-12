/**
 * The console's shell: the header (four destinations, Search, Help and
 * Settings, and a Menu on narrow screens), the banner and first-run slots,
 * the main region, the footer, and the frame every page is drawn in — a
 * fleet page's heading, a harness page's header, its section nav and its
 * sub-view list. app.js keeps boot, the one document key listener, the
 * overlays and the sheet, and hands the shell what it calls back into
 * through `renderShell`'s hooks.
 *
 * Every page has exactly one `<h1>`, drawn here, never by a view: a fleet
 * page's from its destination, page or Settings row; a harness page's is the
 * harness name; not found's is "Nothing at this address". Re-hosted views
 * keep their own `<h2>`/`<h3>`.
 *
 * What a page holds comes from the tables (`destinations.js`,
 * `sections/*.js`), so a new screen is a row there, not an edit here. Views
 * load when first opened: each row's `load` names its module by a literal path.
 */

import { api } from "./api.js";
import { DESTINATIONS, SETTINGS_PAGES, fleetArea, fleetPage } from "./destinations.js";
import { clear, copyBtn, dot, el, skeleton, toast } from "./dom.js";
import { notifications } from "./notify.js";
import { applyTheme, readPrefs, requestFocus, writePrefs, writeTheme } from "./prefs.js";
import {
  hrefFleet,
  hrefHarness,
  hrefHome,
  pageTitle,
  routeTemplate,
  sectionLabel,
  subViewAvailability,
} from "./router.js";
import { SECTIONS, sectionById, subViewGroups, subViewOf } from "./sections/index.js";
import { shapeAccentVars, shapeLabel } from "./shapes.js";
import { procRow } from "./supervision.js";
import { announce } from "./ui/live.js";

/** Where the releases and the docs live, linked from Help. */
const RELEASES_URL = "https://github.com/crewhaus/factory/releases";
const DOCS_URL = "https://github.com/crewhaus/docs";

/** What the shell calls back into app.js for. */
const hooks = {
  openOverlay: () => {},
  openSheet: () => {},
  installKeyboard: () => {},
  redispatch: () => {},
  isSigningIn: () => false,
};

let viewRoot = null;
let footRoot = null;
let bannerRoot = null;
let firstRunRoot = null;
let navCounts = {};
let notificationsStarted = false;
let lastRoute = null;
/** The header's parts that change per navigation or per count. */
const header = { nav: null, settings: null, menuNav: null, closers: [] };

/** The main region, for app.js. */
export function viewRootNode() {
  return viewRoot;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(document.documentElement, writeTheme(next));
}

/**
 * The skip link: the first stop on every page. This is a hash router, so
 * `href="#view"` would navigate to "Nothing at this address"; it moves focus
 * to the main region instead and leaves the address alone.
 */
function skipLink() {
  return el("a", {
    class: "skip-link",
    href: "#view",
    text: "Skip to content",
    onClick: (event) => {
      event.preventDefault();
      if (viewRoot !== null) viewRoot.focus();
    },
  });
}

/**
 * The first-run card, asked once per device: an offer to adjust Readability,
 * with no question about why anyone might want to. Either answer puts it
 * away for good.
 */
function mountFirstRun(slot) {
  clear(slot);
  if (readPrefs().firstRunDone) return;
  const answer = () => {
    writePrefs({ firstRunDone: true });
    clear(slot);
  };
  const adjust = el("button", {
    class: "btn btn-primary",
    type: "button",
    text: "Adjust",
    onClick: () => {
      answer();
      const first = document.querySelector("#readability input:checked");
      const here = lastRoute?.view === "settings" && lastRoute?.sub === "readability";
      if (here && first instanceof HTMLElement) {
        first.focus();
      } else {
        // The Readability page takes the request once it has drawn the card.
        requestFocus("readability");
        window.location.hash = hrefFleet("settings", "readability");
      }
    },
  });
  const later = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Not now",
    onClick: () => {
      answer();
      if (viewRoot !== null) viewRoot.focus();
    },
  });
  slot.appendChild(
    el("section", { class: "card firstrun", "aria-label": "Readability" }, [
      el("p", { text: "Make this easier to read: text size, motion and contrast." }),
      adjust,
      later,
    ]),
  );
}

/**
 * A disclosure: a button and the list it shows. Not a menu: the list holds
 * ordinary links and buttons, reached with Tab. Escape closes it and gives
 * focus back to the button; Tab out of it closes it; choosing an item closes
 * it. All of that is handled on the widget's own element.
 */
function disclosure(opts) {
  const list = el("div", { class: `disclosure-panel ${opts.panelClass ?? ""}`, id: opts.id });
  list.hidden = true;
  const button = el(
    "button",
    {
      class: `btn btn-ghost disclosure-btn ${opts.buttonClass ?? ""}`,
      type: "button",
      "aria-expanded": "false",
      "aria-controls": opts.id,
    },
    opts.button,
  );
  const wrap = el("div", { class: `disclosure ${opts.wrapClass ?? ""}` }, [button, list]);
  const setOpen = (open) => {
    button.setAttribute("aria-expanded", String(open));
    list.hidden = !open;
  };
  button.addEventListener("click", () => setOpen(list.hidden));
  wrap.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || list.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    button.focus();
  });
  wrap.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !wrap.contains(next)) setOpen(false);
  });
  list.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest("a, button") !== null) setOpen(false);
  });
  header.closers.push(() => setOpen(false));
  return { node: wrap, button, list, setOpen };
}

/** A count as a visible number and the words a screen reader says with it. */
function badge(count, words) {
  if (typeof count !== "number" || count <= 0) return [];
  return [
    el("span", { class: "nav-badge", "aria-hidden": "true", text: String(count) }),
    el("span", { class: "sr-only", text: `, ${count} ${words}` }),
  ];
}

/** Pending approvals and open review items: the number Home's link wears. */
function needsYouCount() {
  const approvals = typeof navCounts.approvals === "number" ? navCounts.approvals : 0;
  const review = typeof navCounts.review === "number" ? navCounts.review : 0;
  return approvals + review;
}

function settingsItems() {
  return [
    el("a", { class: "menu-link", href: hrefFleet("settings"), text: "All settings" }),
    ...SETTINGS_PAGES.map((page) =>
      el("a", { class: "menu-link", href: hrefFleet("settings", page.id), text: page.title }),
    ),
    el("button", {
      class: "menu-link",
      type: "button",
      text: "Theme: light or dark",
      onClick: toggleTheme,
    }),
  ];
}

function helpItems() {
  return [
    el("button", {
      class: "menu-link",
      type: "button",
      text: "Keyboard shortcuts",
      onClick: () => hooks.openSheet(),
    }),
    el("a", {
      class: "menu-link",
      href: RELEASES_URL,
      rel: "noopener noreferrer",
      text: "What changed in this version",
    }),
    el("a", {
      class: "menu-link",
      href: DOCS_URL,
      rel: "noopener noreferrer",
      text: "Documentation",
    }),
  ];
}

const listOf = (items) =>
  el(
    "ul",
    { class: "menu-list" },
    items.map((item) => el("li", null, item)),
  );

/**
 * The shell. `nextHooks`: `{ openOverlay, openSheet, installKeyboard,
 * redispatch, isSigningIn }`.
 */
export function renderShell(appRoot, nextHooks = {}) {
  Object.assign(hooks, nextHooks);
  clear(appRoot);
  header.closers = [];
  header.nav = el("ul", { class: "app-nav-list" });
  const mainNav = el("nav", { class: "app-nav", "aria-label": "Main" }, [header.nav]);
  // A visible affordance for ⌘K: a keyboard-only feature is a feature only
  // the person who built it knows about.
  const searchBtn = el("button", {
    class: "btn btn-ghost omni-open",
    type: "button",
    title: "Search the fleet (⌘K)",
    onClick: () => hooks.openOverlay(),
  });
  searchBtn.appendChild(el("span", { text: "Search" }));
  searchBtn.appendChild(el("kbd", { class: "mono", text: "⌘K" }));
  const help = disclosure({
    id: "help-menu",
    button: [el("span", { text: "Help" }), el("span", { "aria-hidden": "true", text: " ▾" })],
    wrapClass: "wide-only",
    panelClass: "menu-panel",
  });
  help.list.appendChild(listOf(helpItems()));
  const settings = disclosure({
    id: "settings-menu",
    button: [],
    wrapClass: "wide-only",
    panelClass: "menu-panel",
  });
  settings.list.appendChild(listOf(settingsItems()));
  header.settings = settings.button;
  header.menuNav = el("ul", { class: "menu-list" });
  const menu = disclosure({
    id: "narrow-menu",
    button: [el("span", { text: "Menu" })],
    wrapClass: "narrow-only",
    buttonClass: "menu-toggle",
    panelClass: "menu-panel narrow-menu",
  });
  menu.list.append(
    el("nav", { "aria-label": "Menu" }, [
      header.menuNav,
      el("h2", { class: "menu-heading", text: "Settings" }),
      listOf(settingsItems()),
      el("h2", { class: "menu-heading", text: "Help" }),
      listOf(helpItems()),
    ]),
  );
  const head = el("header", { class: "app-header" }, [
    el("a", { class: "brand", href: hrefHome() }, [
      el("span", { class: "logo", "aria-hidden": "true", text: "H" }),
      el("span", { class: "brand-name", text: "Hangar" }),
      el("span", { class: "brand-sub", text: "CrewHaus" }),
    ]),
    mainNav,
    el("span", { class: "spacer" }),
    searchBtn,
    help.node,
    settings.node,
    menu.node,
  ]);
  bannerRoot = el("div", { class: "banner-slot", id: "banners" });
  // Its own slot: the read-only banner clears `bannerRoot` when it loads.
  firstRunRoot = el("div", { class: "firstrun-slot", id: "first-run" });
  viewRoot = el("main", { class: "view", id: "view", tabindex: "-1" });
  footRoot = el("footer", { class: "app-foot", id: "foot" }, [
    el("span", {
      class: "muted",
      text: "Actions show their command-line equivalent where one exists.",
    }),
  ]);
  appRoot.appendChild(skipLink());
  appRoot.appendChild(head);
  appRoot.appendChild(bannerRoot);
  appRoot.appendChild(firstRunRoot);
  appRoot.appendChild(viewRoot);
  appRoot.appendChild(footRoot);
  mountFirstRun(firstRunRoot);
  drawNav(null);
  loadVersion();
  loadNavCounts();
  startNotifications();
  loadReadOnlyBanner();
  hooks.installKeyboard();
}

/**
 * HM-187 — the read-only banner. The mode is enforced SERVER-side; this
 * banner exists so an operator is not left guessing why a button just
 * answered 403. It states the mode, and it links to the toggle.
 */
async function loadReadOnlyBanner() {
  if (bannerRoot === null) return;
  let state = null;
  try {
    state = await api.readOnly();
  } catch {
    return; // an old server without the route: no banner, no error
  }
  clear(bannerRoot);
  if (state?.enabled !== true) return;
  bannerRoot.appendChild(
    el("div", { class: "banner banner-warn", role: "status" }, [
      dot("warn", "read-only mode"),
      el("span", {
        text: "every mutating request is refused by the server — this manager is in demo/screen-share mode.",
      }),
      el("a", {
        class: "banner-link",
        href: hrefFleet("settings", "home"),
        text: "Home settings →",
      }),
      state.locked === true
        ? el("span", { class: "chip chip-warn", text: "locked at startup" })
        : null,
    ]),
  );
}

/** The header's destinations and the Settings badge, with the current page marked. */
export function drawNav(route) {
  if (route !== null) lastRoute = route;
  for (const close of header.closers) close();
  const current = lastRoute?.view ?? null;
  const link = (dest) => {
    const here = current === dest.id;
    return el(
      "a",
      {
        class: `navlink${here ? " active" : ""}`,
        href: dest.path,
        "aria-current": here ? "page" : null,
      },
      [
        el("span", { text: dest.label }),
        ...(dest.badge === "needs-you" ? badge(needsYouCount(), "need you") : []),
      ],
    );
  };
  if (header.nav !== null) {
    clear(header.nav);
    for (const dest of DESTINATIONS) header.nav.appendChild(el("li", null, link(dest)));
  }
  if (header.menuNav !== null) {
    clear(header.menuNav);
    for (const dest of DESTINATIONS) header.menuNav.appendChild(el("li", null, link(dest)));
  }
  if (header.settings !== null) {
    header.settings.classList.toggle("active", current === "settings");
    header.settings.replaceChildren(
      el("span", { text: "Settings" }),
      ...badge(Number(navCounts.settings ?? 0), "new notifications"),
      el("span", { "aria-hidden": "true", text: " ▾" }),
    );
  }
}

/** Merge counts into the header and redraw. The numbers arrive from two
 *  sources — the inbox reads here, the notification badge from the shared
 *  poll — so they are merged rather than replaced, and neither can wipe the
 *  other's number on the way past. */
function setNavCounts(patch) {
  navCounts = { ...navCounts, ...patch };
  drawNav(null);
}

/** Pending approvals and open review items — the two inbox numbers. The
 *  notification badge is the shared poll's (see {@link startNotifications}). */
export async function loadNavCounts() {
  const [approvals, review] = await Promise.allSettled([api.approvals(), api.review()]);
  const counts = {};
  if (approvals.status === "fulfilled" && approvals.value && typeof approvals.value === "object") {
    counts.approvals = approvals.value.pending;
  }
  if (review.status === "fulfilled" && review.value && typeof review.value === "object") {
    counts.review = review.value.open;
  }
  setNavCounts(counts);
}

/**
 * HM-183 — the notification loop.
 *
 * The manager runs no timer of its own: `GET /api/notifications` IS the
 * rules evaluation, so a console that asks only at boot never notifies
 * anybody however long it is left open — which is precisely the case the
 * one default-on rule (a parked approval) exists for. The console asks on
 * an interval instead, through the single shared poll in `notify.js`, so
 * that no OTHER screen can consume a delivery this listener would have
 * toasted. Every snapshot the poll sees lands here: the badge follows it,
 * and anything delivered on that pass is said out loud.
 */
function startNotifications() {
  if (notificationsStarted) return;
  notificationsStarted = true;
  notifications.subscribe((payload, delivered) => {
    setNavCounts({ settings: Number(payload?.badge ?? 0) });
    if (delivered.length === 1) toast(String(delivered[0]?.label ?? "notification"), "info");
    else if (delivered.length > 1) toast(`${delivered.length} new notifications`, "info");
  });
  notifications.start();
  // A hidden tab is nobody's console: stop the fleet-wide scan each poll
  // costs the server, and take a fresh reading the moment it comes back.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden === true) notifications.stop();
    else if (!hooks.isSigningIn()) notifications.start();
  });
}

async function loadVersion() {
  for (const old of footRoot.querySelectorAll(".foot-version")) old.remove();
  let node;
  try {
    const v = await api.version();
    if (!v || typeof v !== "object") return;
    // The version route reports { hangar, protocolV }.
    node = el("span", {
      class: "muted mono foot-version",
      text: `hangar ${String(v.hangar ?? "?")} · protocol v${String(v.protocolV ?? "?")}`,
    });
  } catch {
    node = el("span", { class: "muted foot-version", text: "version unavailable" });
  }
  footRoot.appendChild(node);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** The page's one heading. It takes focus after each navigation. */
const pageHeading = (text) =>
  el("h1", { class: "page-title", id: "page-title", tabindex: "-1", text });

/** A fleet area's own list of its pages (Harnesses, Connections, Settings). */
function areaNav(area, route) {
  if (area.indexLabel === undefined || area.pages.length === 0) return null;
  const item = (label, href, here) =>
    el("li", null, [
      el("a", {
        class: `tab${here ? " active" : ""}`,
        href,
        "aria-current": here ? "page" : null,
        text: label,
      }),
    ]);
  return el("nav", { class: "page-nav", "aria-label": `${area.title} pages` }, [
    el("ul", { class: "tabs page-nav-list" }, [
      item(area.indexLabel, hrefFleet(area.id), route.sub === null),
      ...area.pages.map((page) =>
        item(page.title, hrefFleet(area.id, page.id), route.sub === page.id),
      ),
    ]),
  ]);
}

/**
 * A fresh container for one navigation, attached at once. A fleet page gets
 * its heading straight away; a harness page waits for the harness's name.
 */
export function mountRoute(route) {
  if (viewRoot === null) return null;
  viewRoot.removeAttribute("data-ready");
  const page = el("div", { class: "page" });
  const area = fleetArea(route.view);
  if (area !== null) {
    const row = route.sub === null ? null : fleetPage(area, route.sub);
    page.append(
      pageHeading(row === null ? area.title : row.title),
      areaNav(area, route),
      el("div", { class: "page-body" }, [skeleton(6)]),
    );
  } else {
    page.appendChild(skeleton(6));
  }
  clear(viewRoot).appendChild(page);
  return page;
}

/** Draw a route into its container. Resolves to the names its title needs. */
export async function renderRoute(route, container, { signal }) {
  if (route.view === "harness") return renderHarnessPage(container, route, signal);
  const area = fleetArea(route.view);
  if (area === null) {
    renderNotFound(container, route);
    return {};
  }
  const row = route.sub === null ? area.index : fleetPage(area, route.sub);
  const body = container.querySelector(".page-body") ?? container;
  const ctx = { route, signal, setSub: () => {} };
  const mod = await row.load();
  if (signal.aborted) return {};
  await row.render(mod, body, ctx);
  return {};
}

/** Mark the screen arrived: the ready mark the browser journeys wait for. */
export function markReady(route) {
  if (viewRoot !== null) viewRoot.dataset.ready = routeTemplate(route) ?? "notfound";
}

/**
 * After the current navigation has drawn: its heading takes focus (unless
 * the screen already put focus inside itself on purpose, or this is the
 * page's first load, where the skip link stays the first stop), the document
 * title names the page, the page's name is said politely, and the ready mark
 * is set.
 */
export function afterRoute(route, container, result = {}, opts = {}) {
  const heading = container.querySelector("h1");
  const active = document.activeElement;
  const kept = active instanceof Node && active !== document.body && container.contains(active);
  if (heading instanceof HTMLElement && !kept && opts.focus !== false) heading.focus();
  const title = pageTitle(route, { harness: result?.harness });
  document.title = title;
  announce(title.replace(/ — Hangar$/, ""));
  markReady(route);
}

function renderNotFound(container, route) {
  clear(container).appendChild(
    el("div", { class: "card notfound" }, [
      pageHeading("Nothing at this address"),
      el("p", { class: "muted mono", text: String(route.hash ?? "") }),
      el("div", { class: "notfound-actions" }, [
        el("a", { class: "btn btn-primary", href: hrefHome(), text: "Go to Home" }),
        el("button", {
          class: "btn",
          type: "button",
          text: "Search",
          onClick: () => hooks.openOverlay(),
        }),
      ]),
    ]),
  );
}

/** A screen whose request failed: the card says so, and Retry draws it again. */
export function renderError(container, err) {
  const message = err instanceof Error ? err.message : String(err);
  const slot = container.querySelector(".tab-body") ?? container.querySelector(".page-body");
  const host = slot ?? container;
  clear(host);
  if (container.querySelector("h1") === null)
    host.appendChild(pageHeading("This page could not load"));
  host.appendChild(
    el("div", { class: "card error-card" }, [
      el("h2", null, [dot("bad", "request failed")]),
      el("p", { class: "muted", text: message }),
      el("button", {
        class: "btn",
        type: "button",
        text: "Retry",
        onClick: () => hooks.redispatch(),
      }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// The harness page
// ---------------------------------------------------------------------------

/** Replace the address with a sub-panel's, without a navigation. */
function setSubFor(route, signal) {
  return (segments) => {
    if (signal.aborted || route.view !== "harness" || route.sub === null) return;
    const parts = Array.isArray(segments) ? segments.filter((s) => s !== "" && s != null) : [];
    const href = hrefHarness(route.id, route.section, route.sub, ...parts);
    window.history.replaceState(window.history.state, "", href);
  };
}

async function renderHarnessPage(container, route, signal) {
  // The process picture rides along with the detail so the header can show
  // supervision without a second paint; a failure leaves the plain header.
  const [detailRes, procRes] = await Promise.allSettled([
    api.harness(route.id),
    api.proc(route.id),
  ]);
  if (signal.aborted) return {};
  if (detailRes.status === "rejected") throw detailRes.reason;
  const detail = detailRes.value;
  const proc = procRes.status === "fulfilled" ? procRes.value : null;
  clear(container);
  if (detail === null) {
    container.appendChild(
      el("div", { class: "card" }, [
        pageHeading("Not registered"),
        el("p", { class: "muted", text: "No harness with that id is in the registry." }),
        el("a", { href: hrefFleet("harnesses"), text: "Go to Harnesses" }),
      ]),
    );
    return {};
  }
  const entry = detail.entry && typeof detail.entry === "object" ? detail.entry : {};
  const ctx = {
    id: route.id,
    detail,
    route,
    proc,
    dir: typeof entry.dir === "string" ? entry.dir : "",
    signal,
    reload: () => hooks.redispatch(),
    setSub: setSubFor(route, signal),
  };
  const name = harnessName(detail, route);
  container.appendChild(harnessHeader(detail, route, ctx));
  container.appendChild(sectionNav(route));
  const section = sectionById(route.section);
  const availability = subViewAvailability(section, targetOf(detail));
  const content = el("div", { class: "section-content" });
  container.appendChild(
    el("div", { class: "section-layout" }, [subViewNav(route, section, availability), content]),
  );
  const current = availability.find((row) => row.id === route.sub);
  if (current !== undefined && !current.on) {
    content.appendChild(
      el("div", { class: "rollup" }, [
        dot("off", "off this shape's panel matrix"),
        el("span", { class: "muted", text: current.reason }),
      ]),
    );
  }
  const body = el("div", { class: "tab-body" });
  content.appendChild(body);
  if (route.sub === null && section.index === null) {
    drawSectionIndex(body, route, section, availability);
    return { harness: name };
  }
  const row = route.sub === null ? section.index : subViewOf(section, route.sub);
  const mod = await row.load();
  if (signal.aborted) return { harness: name };
  await row.render(mod, body, ctx);
  return { harness: name };
}

function harnessName(detail, route) {
  const entry = detail.entry && typeof detail.entry === "object" ? detail.entry : {};
  const inv = detail.inventory && typeof detail.inventory === "object" ? detail.inventory : {};
  return String(inv.specName ?? entry.specName ?? route.id);
}

/** The five sections, as links, with the current one marked. */
function sectionNav(route) {
  return el("nav", { class: "section-nav", "aria-label": "Harness sections" }, [
    el(
      "ul",
      { class: "tabs section-nav-list" },
      SECTIONS.map((section) => {
        const here = route.section === section.id;
        return el("li", null, [
          el("a", {
            class: `tab${here ? " active" : ""}`,
            href: hrefHarness(route.id, section.id),
            "aria-current": here ? "page" : null,
            text: section.label,
          }),
        ]);
      }),
    ),
  ]);
}

/** One sub-view in a list: a link, or, off this shape's matrix, its name and why. */
function subViewItem(route, section, row, availability) {
  const state = availability.find((a) => a.id === row.id);
  const here = route.sub === row.id;
  if (state !== undefined && !state.on) {
    return el("li", { class: "subview-off" }, [
      el("span", { class: `subview-name${here ? " active" : ""}`, text: row.label }),
      el("span", { class: "subview-why", text: `Not part of this shape: ${state.reason}` }),
    ]);
  }
  return el("li", null, [
    el("a", {
      class: `subview-link${here ? " active" : ""}`,
      href: hrefHarness(route.id, section.id, row.id),
      "aria-current": here ? "page" : null,
      text: row.label,
    }),
  ]);
}

/**
 * The section's sub-views: a rail beside the content on a wide screen, a
 * disclosure above it on a narrow one. Setup's groups are headed lists.
 */
function subViewNav(route, section, availability) {
  const label = `${section.label} views`;
  const list = el("div", { class: "subview-list", id: "subview-list" });
  const summaryHere = route.sub === null;
  list.appendChild(
    el("ul", { class: "subview-group-list" }, [
      el("li", null, [
        el("a", {
          class: `subview-link${summaryHere ? " active" : ""}`,
          href: hrefHarness(route.id, section.id),
          "aria-current": summaryHere ? "page" : null,
          text: section.id === "overview" ? "Overview" : "Summary",
        }),
      ]),
    ]),
  );
  for (const group of subViewGroups(section)) {
    if (group.group !== null)
      list.appendChild(el("h2", { class: "subview-group", text: group.group }));
    list.appendChild(
      el(
        "ul",
        { class: "subview-group-list" },
        group.rows.map((row) => subViewItem(route, section, row, availability)),
      ),
    );
  }
  const toggle = el("button", {
    class: "btn btn-ghost subview-toggle",
    type: "button",
    "aria-expanded": "false",
    "aria-controls": "subview-list",
    text: label,
  });
  const nav = el("nav", { class: "subview-nav", "aria-label": label }, [toggle, list]);
  const setOpen = (open) => {
    toggle.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("open", open);
  };
  toggle.addEventListener("click", () => setOpen(!nav.classList.contains("open")));
  nav.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !nav.classList.contains("open")) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    toggle.focus();
  });
  return nav;
}

/** A section's own page: its sub-views, each with what it is for. */
function drawSectionIndex(body, route, section, availability) {
  const lists = subViewGroups(section).map((group) => {
    const items = group.rows.map((row) => {
      const state = availability.find((a) => a.id === row.id);
      const on = state === undefined || state.on;
      return el("li", { class: `section-index-item${on ? "" : " off"}` }, [
        on
          ? el("a", { href: hrefHarness(route.id, section.id, row.id), text: row.label })
          : el("span", { class: "subview-name", text: row.label }),
        el("p", { class: "muted section-index-describe", text: row.describe }),
        on
          ? null
          : el("p", { class: "subview-why", text: `Not part of this shape: ${state.reason}` }),
      ]);
    });
    return [
      group.group === null ? null : el("h2", { class: "section-index-group", text: group.group }),
      el("ul", { class: "section-index" }, items),
    ];
  });
  clear(body).appendChild(
    el("section", { class: "card section-summary", "aria-label": sectionLabel(route) }, [
      el("p", { class: "muted", text: section.describe }),
      ...lists.flat(),
    ]),
  );
}

/** The target shape string, read from the same places the header reads it
 *  (the inventory's parsed header first, the registry row as the fallback).
 *  One reader, so the list and the badge can never disagree. */
function targetOf(detail) {
  const entry = detail.entry && typeof detail.entry === "object" ? detail.entry : {};
  const inv = detail.inventory && typeof detail.inventory === "object" ? detail.inventory : {};
  const header = inv.header && typeof inv.header === "object" ? inv.header : {};
  const explicit = header.target ?? entry.target;
  return typeof explicit === "string" ? explicit : "";
}

/**
 * Detail header. The detail payload nests all identity fields under
 * `entry` (the registry row) with richer names on `inventory`; the header
 * reads those, never invented top-level fields. Capability chips come from
 * the server's `badges` (the lenient spec scan) — the M1 posture line — and
 * M2 adds the supervision strip beneath it. The name is the page's heading.
 */
function harnessHeader(detail, route, ctx) {
  const entry = detail.entry && typeof detail.entry === "object" ? detail.entry : {};
  const name = harnessName(detail, route);
  const target = targetOf(detail);
  const dir = String(entry.dir ?? "");
  const missing = detail.missing === true || typeof entry.missingSince === "string";
  const head = el(
    "div",
    { class: "h-head", "data-shape-accent": "", style: shapeAccentVars(target) },
    [
      el("div", { class: "h-title" }, [
        el("span", { class: "shape-badge", text: shapeLabel(target) }),
        pageHeading(name),
        missing ? dot("bad", "directory missing") : null,
      ]),
      dir !== ""
        ? el("div", { class: "h-dir" }, [
            el("span", { class: "mono muted", title: dir, text: dir }),
            copyBtn(dir, "copy"),
          ])
        : null,
      badgeStrip(detail.badges),
      supervisionStrip(ctx),
    ],
  );
  return head;
}

/** Supervision pill + bundle freshness + control availability + remedy. */
function supervisionStrip(ctx) {
  if (ctx.proc === null) return null;
  const row = procRow(ctx.proc, Date.now());
  const strip = el("div", { class: "sup-strip" }, [
    dot(row.pill.dot, row.pill.label),
    row.adopted ? el("span", { class: "chip", text: "adopted" }) : null,
    row.draining ? el("span", { class: "chip chip-warn", text: "draining" }) : null,
    row.runId !== null
      ? el("a", {
          class: "chip",
          href: hrefHarness(ctx.id, "runs", row.runId),
          text: "watch this run",
        })
      : null,
    // The exact/approximate distinction is the badge's whole point — but
    // only where there IS a verdict to qualify.
    el("span", {
      class: `chip${row.bundle.dot === "warn" ? " chip-warn" : ""}`,
      title: row.bundle.precision,
      text: row.bundle.present
        ? `${row.bundle.label} · ${row.bundle.exact ? "exact" : "approximate"}`
        : row.bundle.label,
    }),
    dot(row.control.dot, row.control.label),
  ]);
  const planError = row.launch.error;
  if (planError !== null) {
    strip.appendChild(el("span", { class: "muted gated-why", text: planError.message }));
    if (planError.action !== null) {
      const btn = el("button", {
        class: "btn",
        type: "button",
        text: planError.action.label,
        title: planError.action.hint,
      });
      if (planError.action.jobKind === null) {
        btn.disabled = true;
      } else {
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          try {
            await api.submitJob(ctx.id, planError.action.jobKind);
            toast(`Queued ${planError.action.jobKind}`, "info");
            ctx.reload();
          } catch (err) {
            btn.disabled = false;
            toast(`Could not queue: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }
      strip.appendChild(btn);
    }
  }
  return strip;
}

/** Capability-badge chips from the detail payload's `badges` booleans. */
function badgeStrip(badges) {
  if (!badges || typeof badges !== "object") return null;
  const active = Object.keys(badges).filter((k) => badges[k] === true);
  if (active.length === 0) return null;
  return el(
    "div",
    { class: "safety-strip", "aria-label": "capabilities" },
    active.map((k) => el("span", { class: "chip", text: k })),
  );
}
