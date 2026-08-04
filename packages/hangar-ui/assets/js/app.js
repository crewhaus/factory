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
 *
 * M3 adds the detail tabs (Datasets, Feedback, Credentials, Channels,
 * Security, Thredz, Inspect, Dev & MCP), stacks an M3 half beneath the
 * existing Spec, Evals and Memory panels, and puts the fleet credential
 * matrix, feedback rollup and Thredz explorer in the rail.
 *
 * The tab strip is where the shape × panel matrix is applied: the target
 * shape decides which tabs are live and which render disabled with the
 * reason (`tabAvailability` in router.js owns the table). Gating stops at
 * the strip — a deep link to an off-matrix tab still resolves and the
 * screen still answers, so no URL an operator saved goes dead.
 */

import { ApiError, api, onUnauthorized, setToken } from "./api.js";
import { clear, copyBtn, dot, el, skeleton, toast } from "./dom.js";
import { bindingSheet, globalKey, initialKeyState, keyShape } from "./keys.js";
import { openOmnibox } from "./omnibox.js";
import {
  hrefGlobal,
  hrefHarness,
  hrefLibrary,
  parseRoute,
  startRouter,
  tabAvailability,
} from "./router.js";
import { shapeAccent, shapeLabel } from "./shapes.js";
import { procRow } from "./supervision.js";
import { renderActivity } from "./views/activity.js";
import { renderApprovals } from "./views/approvals.js";
import { renderChannels } from "./views/channels.js";
import { renderCosts } from "./views/costs.js";
import { renderCredentialsMatrix, renderCreds } from "./views/creds.js";
import { renderData } from "./views/data.js";
import { renderDeploy } from "./views/deploy.js";
import { renderEvalsLab } from "./views/evals-lab.js";
import { renderEvals } from "./views/evals.js";
import { renderFeedback, renderFeedbackBoard } from "./views/feedback.js";
import { renderHealthBoard, renderHealthCard } from "./views/health.js";
import { renderInspect } from "./views/inspect.js";
import { renderLibrary } from "./views/library.js";
import { renderMemoryFabric } from "./views/memory-fabric.js";
import { renderMemory } from "./views/memory.js";
import { renderOverview } from "./views/overview.js";
import { renderPanes } from "./views/panes.js";
import { renderReview } from "./views/review.js";
import { renderRuns, renderRunsBoard } from "./views/runs.js";
import { renderRuntime } from "./views/runtime.js";
import { renderSchedulers } from "./views/schedulers.js";
import { renderSecurity } from "./views/security.js";
import { renderSessions } from "./views/sessions.js";
import { renderSettings } from "./views/settings.js";
import { renderSpecEdit } from "./views/spec-edit.js";
import { renderSpec } from "./views/spec.js";
import { renderThredz, renderThredzGlobal } from "./views/thredz.js";
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
  data: "Datasets",
  feedback: "Feedback",
  costs: "Costs",
  creds: "Credentials",
  channels: "Channels",
  security: "Security",
  thredz: "Thredz",
  deploy: "Deployments",
  inspect: "Inspect",
  dev: "Dev & MCP",
  panes: "Plugin panes",
};

/** The fleet-wide screens in the header rail, with their count sources. */
const NAV = [
  { view: "runs", label: "Runs & daemons" },
  { view: "approvals", label: "Approvals" },
  { view: "review", label: "Review" },
  { view: "activity", label: "Activity" },
  { view: "health", label: "Health" },
  { view: "credentials", label: "Credentials" },
  { view: "feedback", label: "Feedback" },
  { view: "thredz", label: "Thredz" },
  { view: "settings", label: "Settings" },
];

let viewRoot = null;
let footRoot = null;
let navRoot = null;
let bannerRoot = null;
let dispatchSeq = 0;
let navCounts = {};
// M4 (HM-190): overlay ownership. `inboxMounted` is set per navigation so
// `?` goes to the inbox's own sheet on the two screens that bind it, and to
// the app's sheet everywhere else.
let keyState = initialKeyState();
let omnibox = null;
let sheetNode = null;

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
  // A visible affordance for ⌘K: a keyboard-only feature is a feature only
  // the person who built it knows about.
  const searchBtn = el("button", {
    class: "btn btn-ghost omni-open",
    type: "button",
    title: "Search the fleet (⌘K)",
    onClick: () => openOverlay(),
  });
  searchBtn.appendChild(el("span", { text: "Search" }));
  searchBtn.appendChild(el("kbd", { class: "mono", text: "⌘K" }));
  const header = el("header", { class: "app-header" }, [
    el("a", { class: "brand", href: hrefLibrary() }, [
      el("span", { class: "logo", "aria-hidden": "true", text: "H" }),
      el("span", { class: "brand-name", text: "Hangar" }),
      el("span", { class: "brand-sub", text: "CrewHaus harness manager" }),
    ]),
    navRoot,
    el("span", { class: "spacer" }),
    searchBtn,
    themeBtn,
  ]);
  bannerRoot = el("div", { class: "banner-slot", id: "banners" });
  viewRoot = el("main", { class: "view", id: "view" });
  footRoot = el("footer", { class: "app-foot", id: "foot" }, [
    el("span", { class: "muted", text: "every action shows the CLI command it runs" }),
  ]);
  appRoot.appendChild(header);
  appRoot.appendChild(bannerRoot);
  appRoot.appendChild(viewRoot);
  appRoot.appendChild(footRoot);
  drawNav(parseRoute(window.location.hash));
  loadVersion();
  loadNavCounts();
  loadReadOnlyBanner();
  installKeyboard();
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
      el("a", { class: "banner-link", href: hrefGlobal("settings"), text: "Settings →" }),
      state.locked === true
        ? el("span", { class: "chip chip-warn", text: "locked at startup" })
        : null,
    ]),
  );
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

/** Pending approvals, open review items, and the notification badge —
 *  the three numbers worth carrying in the nav. The notifications poll is
 *  ALSO the rules evaluation pass (HM-183: the manager runs no timer), so a
 *  console left open keeps the badge honest without a background loop. */
async function loadNavCounts() {
  const [approvals, review, notifications] = await Promise.allSettled([
    api.approvals(),
    api.review(),
    api.notifications(),
  ]);
  const counts = {};
  if (approvals.status === "fulfilled" && approvals.value && typeof approvals.value === "object") {
    counts.approvals = approvals.value.pending;
  }
  if (review.status === "fulfilled" && review.value && typeof review.value === "object") {
    counts.review = review.value.open;
  }
  if (
    notifications.status === "fulfilled" &&
    notifications.value &&
    typeof notifications.value === "object"
  ) {
    counts.settings = notifications.value.badge;
    // Anything delivered on THIS poll is new since the last one: one toast,
    // and the badge carries the rest.
    const delivered = Array.isArray(notifications.value.delivered)
      ? notifications.value.delivered
      : [];
    if (delivered.length === 1) toast(String(delivered[0]?.label ?? "notification"), "info");
    else if (delivered.length > 1) toast(`${delivered.length} new notifications`, "info");
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
  // The two screens that bind `?` for their own inbox sheet. Tracked here
  // rather than sniffed from the DOM so the ownership rule stays a pure
  // input to the `keys.js` reducer.
  keyState = { ...keyState, inboxMounted: route.view === "approvals" || route.view === "review" };
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
    } else if (route.view === "credentials") {
      await renderCredentialsMatrix(viewRoot);
    } else if (route.view === "feedback") {
      await renderFeedbackBoard(viewRoot);
    } else if (route.view === "thredz") {
      await renderThredzGlobal(viewRoot);
    } else if (route.view === "health") {
      await renderHealthBoard(viewRoot);
    } else if (route.view === "settings") {
      await renderSettings(viewRoot);
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
  // The shape × panel matrix, applied where the strip is drawn: a tab this
  // target's schema cannot declare renders as a disabled label carrying the
  // reason, not as a link into a screen whose only content is "not
  // applicable". The deep link still resolves, so a shared URL still opens.
  const availability = tabAvailability(targetOf(detail));
  root.appendChild(
    el(
      "nav",
      { class: "tabs", "aria-label": "harness tabs" },
      availability.map((row) => tabNode(route, row)),
    ),
  );
  const current = availability.find((row) => row.tab === route.tab);
  if (current !== undefined && !current.on) {
    root.appendChild(
      el("div", { class: "rollup" }, [
        dot("off", "off this shape's panel matrix"),
        el("span", { class: "muted", text: current.reason }),
      ]),
    );
  }
  const tabRoot = el("div", { class: "tab-body" });
  root.appendChild(tabRoot);
  // The three tabs that gained an M3 half render the M1/M2 surface first and
  // the new one beneath it — one screen, not two competing ones.
  if (route.tab === "spec") {
    await renderSpec(tabRoot, ctx);
    await renderSpecEdit(section(tabRoot), ctx);
  } else if (route.tab === "runs") await renderRuns(tabRoot, ctx);
  else if (route.tab === "schedulers") await renderSchedulers(tabRoot, ctx);
  else if (route.tab === "sessions") await renderSessions(tabRoot, ctx);
  else if (route.tab === "evals") {
    await renderEvals(tabRoot, ctx);
    await renderEvalsLab(section(tabRoot), ctx);
  } else if (route.tab === "memory") {
    await renderMemory(tabRoot, ctx);
    await renderMemoryFabric(section(tabRoot), ctx);
  } else if (route.tab === "data") await renderData(tabRoot, ctx);
  else if (route.tab === "feedback") await renderFeedback(tabRoot, ctx);
  else if (route.tab === "costs") await renderCosts(tabRoot, ctx);
  else if (route.tab === "creds") await renderCreds(tabRoot, ctx);
  else if (route.tab === "channels") await renderChannels(tabRoot, ctx);
  else if (route.tab === "security") await renderSecurity(tabRoot, ctx);
  else if (route.tab === "thredz") await renderThredz(tabRoot, ctx);
  else if (route.tab === "deploy") await renderDeploy(tabRoot, ctx);
  else if (route.tab === "inspect") await renderInspect(tabRoot, ctx);
  else if (route.tab === "dev") await renderRuntime(tabRoot, ctx);
  else if (route.tab === "panes") await renderPanes(tabRoot, ctx);
  else {
    await renderOverview(tabRoot, ctx);
    // The explained score (HM-11) loads on its own: it runs a preflight, and
    // the Overview's first paint must not wait for one.
    await renderHealthCard(section(tabRoot), ctx);
  }
}

/**
 * One tab in the strip. An on-matrix tab is a link; an off-matrix one is a
 * disabled label whose accessible name carries the reason as TEXT — the
 * dimming is never the whole message.
 */
function tabNode(route, row) {
  const label = TAB_LABELS[row.tab] ?? row.tab;
  const active = route.tab === row.tab;
  if (row.on) {
    return el("a", {
      class: `tab${active ? " active" : ""}`,
      "aria-current": active ? "page" : null,
      href: hrefHarness(route.id, row.tab),
      text: label,
    });
  }
  return el("span", {
    class: `tab tab-off muted${active ? " active" : ""}`,
    // The console ships one stylesheet and this state is the only new one on
    // the strip, so it dims inline rather than growing the CSS a rule that
    // one span uses. The reason still travels as text, in both the tooltip
    // and the accessible name — the dimming is a hint, never the message.
    style: { opacity: "0.45", cursor: "not-allowed" },
    "aria-disabled": "true",
    "aria-current": active ? "page" : null,
    "aria-label": `${label} — not part of this shape: ${row.reason}`,
    title: row.reason,
    text: label,
  });
}

/** The target shape string, read from the same places the header reads it
 *  (the inventory's parsed header first, the registry row as the fallback).
 *  One reader, so the strip and the badge can never disagree. */
function targetOf(detail) {
  const entry = detail.entry && typeof detail.entry === "object" ? detail.entry : {};
  const inv = detail.inventory && typeof detail.inventory === "object" ? detail.inventory : {};
  const header = inv.header && typeof inv.header === "object" ? inv.header : {};
  const explicit = header.target ?? entry.target;
  return typeof explicit === "string" ? explicit : "";
}

/** Append a fresh sub-container so a second render into the same tab does
 *  not clear the first (every view clears the root it is handed). */
function section(root) {
  const node = el("div", { class: "tab-section" });
  root.appendChild(node);
  return node;
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
  const name = String(inv.specName ?? entry.specName ?? route.id);
  const target = targetOf(detail);
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

/**
 * HM-190 — the app-level keyboard layer.
 *
 * One listener, one pure reducer (`keys.js`). It claims ⌘K, Escape and — on
 * screens with no inbox — `?`, and it claims NOTHING else, so the inbox
 * triage reducer that shipped with M2 keeps receiving j/k/g/d untouched on
 * the two screens that mount it.
 */
function installKeyboard() {
  document.addEventListener("keydown", (event) => {
    const { state, effect, claimed } = globalKey(keyState, keyShape(event));
    keyState = state;
    if (claimed) event.preventDefault();
    if (effect === "open-omnibox") openOverlay();
    else if (effect === "close-omnibox") closeOverlay();
    else if (effect === "toggle-sheet") drawSheet();
    else if (effect === "close-sheet") drawSheet();
  });
}

function openOverlay() {
  if (omnibox !== null) return;
  keyState = { ...keyState, omniboxOpen: true, sheetOpen: false };
  drawSheet();
  omnibox = openOmnibox(document.body, {
    onClose: () => {
      omnibox = null;
      keyState = { ...keyState, omniboxOpen: false };
    },
  });
}

function closeOverlay() {
  if (omnibox === null) return;
  omnibox.close();
  omnibox = null;
}

/** The `?` bindings overlay. Rendered from `bindingSheet()` so the list and
 *  the reducer can never disagree about what a key does. */
function drawSheet() {
  if (sheetNode !== null) {
    sheetNode.remove();
    sheetNode = null;
  }
  if (!keyState.sheetOpen) return;
  sheetNode = el(
    "div",
    {
      class: "sheet-backdrop",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "keyboard bindings",
    },
    [
      el("div", { class: "card sheet" }, [
        el("h3", { class: "card-title", text: "Keyboard" }),
        ...bindingSheet(keyState.inboxMounted).flatMap((group) => [
          el("h4", { class: "sheet-section", text: group.section }),
          el(
            "ul",
            { class: "check-list" },
            group.bindings.map((b) =>
              el("li", null, [
                el("kbd", { class: "mono", text: b.keys }),
                el("span", { text: ` — ${b.does}` }),
              ]),
            ),
          ),
        ]),
        el("p", { class: "muted small", text: "Esc closes." }),
      ]),
    ],
  );
  sheetNode.addEventListener("click", (event) => {
    if (event.target === sheetNode) {
      keyState = { ...keyState, sheetOpen: false };
      drawSheet();
    }
  });
  document.body.appendChild(sheetNode);
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
