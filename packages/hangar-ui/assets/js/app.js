/**
 * Hangar console entry. Boot order: theme, sign-in (`sign-in.js`: a one-time
 * `#x=` code from a boot link, this tab's session, this browser's own key, or
 * the sign-in screen), then shell render, router start, version footer.
 * Booting is guarded on `document` existing so the module can be imported by
 * tests.
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

import { ApiError, api, onUnauthorized } from "./api.js";
import { clear, copyBtn, dot, el, skeleton, toast } from "./dom.js";
import { bindingSheet, globalKey, initialKeyState, keyShape } from "./keys.js";
import { notifications } from "./notify.js";
import { openOmnibox } from "./omnibox.js";
import {
  applyPrefs,
  applyTheme,
  readPrefs,
  readTheme,
  requestFocus,
  writePrefs,
  writeTheme,
} from "./prefs.js";
import {
  hrefGlobal,
  hrefHarness,
  hrefLibrary,
  parseRoute,
  startRouter,
  tabAvailability,
} from "./router.js";
import { shapeAccentVars, shapeLabel } from "./shapes.js";
import * as signIn from "./sign-in.js";
import { procRow } from "./supervision.js";
import { openDialog } from "./ui/dialog.js";
import { installLive } from "./ui/live.js";
import { dismissTooltip, installTooltips } from "./ui/tooltip.js";
import { renderActivity } from "./views/activity.js";
import { renderAdvisor, renderAdvisorBoard } from "./views/advisor.js";
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
import { renderModels } from "./views/models.js";
import { renderOverview } from "./views/overview.js";
import { renderPanes } from "./views/panes.js";
import { renderReview } from "./views/review.js";
import { renderRuns, renderRunsBoard } from "./views/runs.js";
import { renderRuntime } from "./views/runtime.js";
import { renderSchedulers } from "./views/schedulers.js";
import { renderSecurity } from "./views/security.js";
import { renderSessions } from "./views/sessions.js";
import { renderSettings } from "./views/settings.js";
import {
  SESSION_ENDED,
  openSignInDialog,
  renderJoinScreen,
  renderSignInScreen,
} from "./views/sign-in.js";
import { renderSpecEdit } from "./views/spec-edit.js";
import { renderSpec } from "./views/spec.js";
import { renderThredz, renderThredzGlobal } from "./views/thredz.js";

const TAB_LABELS = {
  overview: "Overview",
  advisor: "Advisor",
  spec: "Spec",
  runs: "Runs",
  schedulers: "Schedulers",
  sessions: "Sessions",
  evals: "Evals",
  memory: "Memory",
  data: "Datasets",
  feedback: "Feedback",
  costs: "Costs",
  models: "Models",
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
  { view: "advisor", label: "Advisor" },
  { view: "credentials", label: "Credentials" },
  { view: "feedback", label: "Feedback" },
  { view: "thredz", label: "Thredz" },
  { view: "settings", label: "Settings" },
];

let viewRoot = null;
let footRoot = null;
let navRoot = null;
let bannerRoot = null;
let firstRunRoot = null;
let dispatchSeq = 0;
let navCounts = {};
// M4 (HM-190): overlay ownership. `inboxMounted` is set per navigation so
// `?` goes to the inbox's own sheet on the two screens that bind it, and to
// the app's sheet everywhere else.
let keyState = initialKeyState();
let omnibox = null;
let sheet = null;
let notificationsStarted = false;
/** The sign-in dialog is up over the shell: a 401 now has nothing more to do,
 *  and the background loops stay stopped until it is done. */
let signInShowing = false;
/** The last navigation met a 401 the silent sign-in could not cure, so the
 *  view holds a skeleton; the next sign-in draws it. */
let viewStale = false;

/** Theme and Readability go on the root before the first paint, so nothing
 *  draws once in the wrong size or colours. The record lives in prefs.js,
 *  where the Settings screen can reach it too. */
function initTheme() {
  applyTheme(document.documentElement, readTheme());
  applyPrefs(document.documentElement, readPrefs());
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
      if (parseRoute(window.location.hash).view === "settings" && first instanceof HTMLElement) {
        first.focus();
      } else {
        // Settings takes the request once it has drawn the card.
        requestFocus("readability");
        window.location.hash = hrefGlobal("settings");
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
  appRoot.appendChild(header);
  appRoot.appendChild(bannerRoot);
  appRoot.appendChild(firstRunRoot);
  appRoot.appendChild(viewRoot);
  appRoot.appendChild(footRoot);
  mountFirstRun(firstRunRoot);
  drawNav(parseRoute(window.location.hash));
  loadVersion();
  loadNavCounts();
  startNotifications();
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

/** Merge counts into the nav and redraw. The three numbers arrive from two
 *  sources — the inbox reads here, the notification badge from the shared
 *  poll — so they are merged rather than replaced, and neither can wipe the
 *  other's number on the way past. */
function setNavCounts(patch) {
  navCounts = { ...navCounts, ...patch };
  drawNav(parseRoute(window.location.hash), navCounts);
}

/** Pending approvals and open review items — the two inbox numbers. The
 *  notification badge is the shared poll's (see {@link startNotifications}). */
async function loadNavCounts() {
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
    else if (!signInShowing) notifications.start();
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

async function dispatch(route) {
  const seq = ++dispatchSeq;
  drawNav(route, navCounts);
  // The two screens that bind `?` for their own inbox sheet. Tracked here
  // rather than sniffed from the DOM so the ownership rule stays a pure
  // input to the `keys.js` reducer.
  keyState = { ...keyState, inboxMounted: route.view === "approvals" || route.view === "review" };
  viewStale = false;
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
    } else if (route.view === "advisor") {
      await renderAdvisorBoard(viewRoot);
    } else if (route.view === "settings") {
      await renderSettings(viewRoot);
    } else {
      renderNotFound(viewRoot, route);
    }
  } catch (err) {
    if (seq !== dispatchSeq) return; // superseded by a newer navigation
    if (err instanceof ApiError && err.status === 401) {
      viewStale = true; // sign-in is on screen; it draws this view when done
      return;
    }
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
  } else if (route.tab === "advisor") await renderAdvisor(tabRoot, ctx);
  else if (route.tab === "runs") await renderRuns(tabRoot, ctx);
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
  else if (route.tab === "models") await renderModels(tabRoot, ctx);
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
  const head = el(
    "div",
    { class: "h-head", "data-shape-accent": "", style: shapeAccentVars(target) },
    [
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
 * One listener, one pure reducer (`keys.js`). It claims ⌘K, `/`, Escape and —
 * outside an inbox list — `?`, and it claims NOTHING else, so an inbox list
 * keeps its own keys while it has focus. Two facts are read here, per key,
 * because only the document knows them: whether a dialog the reducer does
 * not own is open (then no shortcut may stack a second overlay on it), and
 * whether single-key shortcuts are on (Readability).
 *
 * Escape closes an open tooltip first and claims nothing else, so a tooltip
 * inside a dialog never takes the dialog with it.
 */
function installKeyboard() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dismissTooltip()) {
      event.preventDefault();
      return;
    }
    const dialogOpen = document.querySelector("dialog[open]:not([data-key-owned])") !== null;
    keyState = { ...keyState, singleKeys: readPrefs().singleKeys };
    const { state, effect, claimed } = globalKey(keyState, { ...keyShape(event), dialogOpen });
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
  omnibox = openOmnibox({
    onClose: () => {
      omnibox = null;
      keyState = { ...keyState, omniboxOpen: false };
    },
  });
}

function closeOverlay() {
  if (omnibox === null) return;
  const open = omnibox;
  omnibox = null;
  open.close();
}

/** The `?` bindings overlay. Rendered from `bindingSheet()` so the list and
 *  the reducer can never disagree about what a key does. It follows
 *  `keyState.sheetOpen`: open when it says open, closed when it does not. A
 *  sheet closed by its own Escape or backdrop tells the state through
 *  `onClose`, the way the command menu does. */
function drawSheet() {
  if (!keyState.sheetOpen) {
    if (sheet !== null) {
      const open = sheet;
      sheet = null;
      open.close();
    }
    return;
  }
  if (sheet !== null) return;
  sheet = openDialog({
    title: "Keyboard",
    className: "modal card sheet",
    dataset: { keyOwned: "" },
    dismissOnBackdrop: true,
    initialFocus: "heading",
    body: [
      ...bindingSheet(keyState.inboxMounted).flatMap((group) => [
        el("h3", { class: "sheet-section", text: group.section }),
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
      el("p", {
        class: "muted small",
        text: "Inbox keys work while the list has focus. Single-key shortcuts can be turned off in Settings.",
      }),
    ],
    actions: [
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Close",
        onClick: () => {
          keyState = { ...keyState, sheetOpen: false };
          drawSheet();
        },
      }),
    ],
    onClose: () => {
      sheet = null;
      keyState = { ...keyState, sheetOpen: false };
    },
  });
}

async function boot() {
  initTheme();
  installLive();
  installTooltips();
  const appRoot = document.getElementById("app");
  // Signed back in after a 401. The request that met it is sent again by
  // api.js, so the view and anything typed into it stay as they are: only the
  // shell's own readings are taken again (the polls that ran while the session
  // was missing returned nothing). A view whose own load was refused, or a run
  // stream that ended with its session, is drawn again; neither holds a draft.
  const resume = () => {
    if (document.hidden !== true) notifications.start();
    loadNavCounts();
    notifications.refresh();
    if (viewStale) dispatch(parseRoute(window.location.hash));
  };
  // The silent sign-in failed: ask over the view, never instead of it, so a
  // draft survives and focus goes back to it once the tab is signed in.
  const askToSignIn = () => {
    signInShowing = true;
    notifications.stop();
    openSignInDialog({
      message: SESSION_ENDED,
      onSignedIn: () => {
        signInShowing = false;
        resume();
      },
      onClose: () => {
        // Dismissed without signing in: the next request that meets a 401 asks again.
        signInShowing = false;
      },
    });
  };
  // Several requests can answer 401 at once; they all wait on one attempt.
  let reauth = null;
  const start = () => {
    renderShell(appRoot);
    onUnauthorized((info) => {
      if (signInShowing) return false;
      if (reauth === null) {
        reauth = signIn
          .recover()
          .then((ok) => {
            if (ok) resume();
            else askToSignIn();
            return ok;
          })
          .finally(() => {
            reauth = null;
          });
      }
      return reauth.then((ok) => {
        if (ok && info?.stream === true) dispatch(parseRoute(window.location.hash));
        return ok;
      });
    });
    startRouter((route) => {
      dispatch(route);
    });
  };
  const signedIn = await signIn.boot();
  if (signedIn.navigating === true) return;
  if (signedIn.signedIn) {
    start();
    return;
  }
  // Nothing on screen asks the server for anything until this tab is signed in.
  clear(appRoot);
  const main = el("main", { class: "view", id: "view", tabindex: "-1" });
  appRoot.appendChild(main);
  if (typeof signedIn.invite === "string") {
    renderJoinScreen(main, { code: signedIn.invite, onSignedIn: start });
    return;
  }
  renderSignInScreen(main, { message: signedIn.message ?? "", onSignedIn: start });
}

if (typeof document !== "undefined") boot();
