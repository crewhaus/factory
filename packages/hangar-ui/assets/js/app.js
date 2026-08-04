/**
 * Hangar console entry. Boot order: token bootstrap (read `#t=<token>`
 * from the URL fragment into sessionStorage and strip it via replaceState),
 * theme, shell render, router start, version footer. Booting is guarded on
 * `document` existing so the module can be imported by tests.
 *
 * M2 adds the fleet-wide nav (Runs, Approvals, Review, Activity) with live
 * counts, and gives the harness header its supervision pill, bundle
 * freshness badge, control availability and — when the spawn plan cannot be
 * built — the remedy as a BUTTON rather than an error.
 */

import { ApiError, api, onUnauthorized, setToken } from "./api.js";
import { clear, copyBtn, dot, el, skeleton, toast } from "./dom.js";
import {
  HARNESS_TABS,
  hrefGlobal,
  hrefHarness,
  hrefLibrary,
  parseRoute,
  startRouter,
} from "./router.js";
import { shapeAccent, shapeLabel } from "./shapes.js";
import { procRow } from "./supervision.js";
import { renderActivity } from "./views/activity.js";
import { renderApprovals } from "./views/approvals.js";
import { renderCosts } from "./views/costs.js";
import { renderDeploy } from "./views/deploy.js";
import { renderEvals } from "./views/evals.js";
import { renderLibrary } from "./views/library.js";
import { renderMemory } from "./views/memory.js";
import { renderOverview } from "./views/overview.js";
import { renderReview } from "./views/review.js";
import { renderRuns, renderRunsBoard } from "./views/runs.js";
import { renderSchedulers } from "./views/schedulers.js";
import { renderSessions } from "./views/sessions.js";
import { renderSpec } from "./views/spec.js";
import { renderTokenScreen } from "./views/token.js";

const THEME_KEY = "hangar.theme";
const TAB_LABELS = {
  overview: "Overview",
  spec: "Spec",
  runs: "Runs",
  schedulers: "Schedulers",
  sessions: "Sessions",
  evals: "Evals",
  memory: "Memory",
  costs: "Costs",
  deploy: "Deployments",
};

/** The fleet-wide screens in the header rail, with their count sources. */
const NAV = [
  { view: "runs", label: "Runs & daemons" },
  { view: "approvals", label: "Approvals" },
  { view: "review", label: "Review" },
  { view: "activity", label: "Activity" },
];

let viewRoot = null;
let footRoot = null;
let navRoot = null;
let dispatchSeq = 0;
let navCounts = {};

/** Move a `#t=<token>` fragment into sessionStorage and off the URL. */
function bootstrapToken() {
  const m = window.location.hash.match(/^#t=(.+)$/);
  if (m === null) return;
  let token = m[1];
  try {
    token = decodeURIComponent(token);
  } catch {
    // keep the raw fragment
  }
  setToken(token);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    // storage unavailable — default applies
  }
  applyTheme(stored === "light" ? "light" : "dark");
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // fine — the toggle just won't persist
  }
}

function renderShell(appRoot) {
  clear(appRoot);
  const themeBtn = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Theme",
    title: "Toggle light/dark",
    onClick: toggleTheme,
  });
  navRoot = el("nav", { class: "app-nav", "aria-label": "fleet screens" });
  const header = el("header", { class: "app-header" }, [
    el("a", { class: "brand", href: hrefLibrary() }, [
      el("span", { class: "logo", "aria-hidden": "true", text: "H" }),
      el("span", { class: "brand-name", text: "Hangar" }),
      el("span", { class: "brand-sub", text: "CrewHaus harness manager" }),
    ]),
    navRoot,
    el("span", { class: "spacer" }),
    themeBtn,
  ]);
  viewRoot = el("main", { class: "view", id: "view" });
  footRoot = el("footer", { class: "app-foot", id: "foot" }, [
    el("span", { class: "muted", text: "every action shows the CLI command it runs" }),
  ]);
  appRoot.appendChild(header);
  appRoot.appendChild(viewRoot);
  appRoot.appendChild(footRoot);
  drawNav(parseRoute(window.location.hash));
  loadVersion();
  loadNavCounts();
}

/** The nav, with the active screen marked. Counts arrive separately. */
function drawNav(route, counts = {}) {
  if (navRoot === null) return;
  clear(navRoot);
  navRoot.appendChild(
    el("a", {
      class: `navlink${route.view === "library" ? " active" : ""}`,
      href: hrefLibrary(),
      text: "Library",
    }),
  );
  for (const item of NAV) {
    const count = counts[item.view];
    const link = el("a", {
      class: `navlink${route.view === item.view ? " active" : ""}`,
      href: hrefGlobal(item.view),
    });
    link.appendChild(el("span", { text: item.label }));
    if (typeof count === "number" && count > 0) {
      link.appendChild(el("span", { class: "nav-badge", text: String(count) }));
    }
    navRoot.appendChild(link);
  }
}

/** Pending approvals + open review items — the two numbers worth a badge. */
async function loadNavCounts() {
  const [approvals, review] = await Promise.allSettled([api.approvals(), api.review()]);
  const counts = {};
  if (approvals.status === "fulfilled" && approvals.value && typeof approvals.value === "object") {
    counts.approvals = approvals.value.pending;
  }
  if (review.status === "fulfilled" && review.value && typeof review.value === "object") {
    counts.review = review.value.open;
  }
  navCounts = counts;
  drawNav(parseRoute(window.location.hash), counts);
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

async function dispatch(route) {
  const seq = ++dispatchSeq;
  drawNav(route, navCounts);
  clear(viewRoot).appendChild(skeleton(6));
  try {
    if (route.view === "library") {
      await renderLibrary(viewRoot);
    } else if (route.view === "harness") {
      await renderHarnessPage(viewRoot, route);
    } else if (route.view === "runs") {
      await renderRunsBoard(viewRoot);
    } else if (route.view === "approvals") {
      await renderApprovals(viewRoot);
    } else if (route.view === "review") {
      await renderReview(viewRoot);
    } else if (route.view === "activity") {
      await renderActivity(viewRoot);
    } else {
      renderNotFound(viewRoot, route);
    }
  } catch (err) {
    if (seq !== dispatchSeq) return; // superseded by a newer navigation
    if (err instanceof ApiError && err.status === 401) return; // token screen owns the view
    renderError(viewRoot, err);
  }
}

async function renderHarnessPage(root, route) {
  // The process picture rides along with the detail so the header can show
  // supervision without a second paint; a failure leaves the M1 header.
  const [detailRes, procRes] = await Promise.allSettled([
    api.harness(route.id),
    api.proc(route.id),
  ]);
  if (detailRes.status === "rejected") throw detailRes.reason;
  const detail = detailRes.value;
  const proc = procRes.status === "fulfilled" ? procRes.value : null;
  clear(root);
  if (detail === null) {
    root.appendChild(
      el("div", { class: "card" }, [
        el("h2", { text: "Not registered" }),
        el("p", { class: "muted", text: "No harness with that id is in the registry." }),
        el("a", { href: hrefLibrary(), text: "← back to Library" }),
      ]),
    );
    return;
  }
  const entry = detail.entry && typeof detail.entry === "object" ? detail.entry : {};
  const ctx = {
    id: route.id,
    detail,
    route,
    proc,
    dir: typeof entry.dir === "string" ? entry.dir : "",
    reload: () => renderHarnessPage(root, route),
  };
  root.appendChild(harnessHeader(detail, route, ctx));
  const nav = el(
    "nav",
    { class: "tabs", "aria-label": "harness tabs" },
    HARNESS_TABS.map((tab) =>
      el("a", {
        class: `tab${route.tab === tab ? " active" : ""}`,
        "aria-current": route.tab === tab ? "page" : null,
        href: hrefHarness(route.id, tab),
        text: TAB_LABELS[tab] ?? tab,
      }),
    ),
  );
  root.appendChild(nav);
  const tabRoot = el("div", { class: "tab-body" });
  root.appendChild(tabRoot);
  if (route.tab === "spec") await renderSpec(tabRoot, ctx);
  else if (route.tab === "runs") await renderRuns(tabRoot, ctx);
  else if (route.tab === "schedulers") await renderSchedulers(tabRoot, ctx);
  else if (route.tab === "sessions") await renderSessions(tabRoot, ctx);
  else if (route.tab === "evals") await renderEvals(tabRoot, ctx);
  else if (route.tab === "memory") await renderMemory(tabRoot, ctx);
  else if (route.tab === "costs") await renderCosts(tabRoot, ctx);
  else if (route.tab === "deploy") await renderDeploy(tabRoot, ctx);
  else await renderOverview(tabRoot, ctx);
}

/**
 * Detail header. The detail payload nests all identity fields under
 * `entry` (the registry row) with richer names on `inventory`; the header
 * reads those, never invented top-level fields. Capability chips come from
 * the server's `badges` (the lenient spec scan) — the M1 posture line — and
 * M2 adds the supervision strip beneath it.
 */
function harnessHeader(detail, route, ctx) {
  const entry = detail.entry && typeof detail.entry === "object" ? detail.entry : {};
  const inv = detail.inventory && typeof detail.inventory === "object" ? detail.inventory : {};
  const header = inv.header && typeof inv.header === "object" ? inv.header : {};
  const name = String(inv.specName ?? entry.specName ?? route.id);
  const target = String(header.target ?? entry.target ?? "");
  const dir = String(entry.dir ?? "");
  const missing = detail.missing === true || typeof entry.missingSince === "string";
  const head = el("div", { class: "h-head", style: { "--accent": shapeAccent(target) } }, [
    el("div", { class: "h-title" }, [
      el("span", { class: "shape-badge", text: shapeLabel(target) }),
      el("h2", { text: name }),
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
  ]);
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

function renderNotFound(root, route) {
  clear(root).appendChild(
    el("div", { class: "card" }, [
      el("h2", { text: "Nothing at this address" }),
      el("p", { class: "muted mono", text: String(route.hash ?? "") }),
      el("a", { href: hrefLibrary(), text: "← back to Library" }),
    ]),
  );
}

function renderError(root, err) {
  const message = err instanceof Error ? err.message : String(err);
  clear(root).appendChild(
    el("div", { class: "card error-card" }, [
      el("h2", null, [dot("bad", "request failed")]),
      el("p", { class: "muted", text: message }),
      el("button", {
        class: "btn",
        type: "button",
        text: "Retry",
        onClick: () => dispatch(parseRoute(window.location.hash)),
      }),
    ]),
  );
}

function boot() {
  bootstrapToken();
  initTheme();
  const appRoot = document.getElementById("app");
  renderShell(appRoot);
  onUnauthorized(() => {
    renderTokenScreen(viewRoot, () => {
      loadVersion();
      loadNavCounts();
      dispatch(parseRoute(window.location.hash));
    });
  });
  startRouter((route) => {
    dispatch(route);
  });
}

if (typeof document !== "undefined") boot();
