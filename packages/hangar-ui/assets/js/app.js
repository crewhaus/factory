/**
 * Hangar console entry. Boot order: token bootstrap (read `#t=<token>`
 * from the URL fragment into sessionStorage and strip it via replaceState),
 * theme, shell render, router start, version footer. Booting is guarded on
 * `document` existing so the module can be imported by tests.
 */

import { ApiError, api, onUnauthorized, setToken } from "./api.js";
import { clear, copyBtn, dot, el, skeleton } from "./dom.js";
import { HARNESS_TABS, hrefHarness, hrefLibrary, parseRoute, startRouter } from "./router.js";
import { shapeAccent, shapeLabel } from "./shapes.js";
import { renderCosts } from "./views/costs.js";
import { renderEvals } from "./views/evals.js";
import { renderLibrary } from "./views/library.js";
import { renderMemory } from "./views/memory.js";
import { renderOverview } from "./views/overview.js";
import { renderSessions } from "./views/sessions.js";
import { renderSpec } from "./views/spec.js";
import { renderTokenScreen } from "./views/token.js";

const THEME_KEY = "hangar.theme";
const TAB_LABELS = {
  overview: "Overview",
  spec: "Spec",
  sessions: "Sessions",
  evals: "Evals",
  memory: "Memory",
  costs: "Costs",
};

let viewRoot = null;
let footRoot = null;
let dispatchSeq = 0;

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
  const header = el("header", { class: "app-header" }, [
    el("a", { class: "brand", href: hrefLibrary() }, [
      el("span", { class: "logo", "aria-hidden": "true", text: "H" }),
      el("span", { class: "brand-name", text: "Hangar" }),
      el("span", { class: "brand-sub", text: "CrewHaus harness manager" }),
    ]),
    el("span", { class: "spacer" }),
    themeBtn,
  ]);
  viewRoot = el("main", { class: "view", id: "view" });
  footRoot = el("footer", { class: "app-foot", id: "foot" }, [
    el("span", { class: "muted", text: "read-only alpha — every write goes through the CLI" }),
  ]);
  appRoot.appendChild(header);
  appRoot.appendChild(viewRoot);
  appRoot.appendChild(footRoot);
  loadVersion();
}

async function loadVersion() {
  for (const old of footRoot.querySelectorAll(".foot-version")) old.remove();
  let node;
  try {
    const v = await api.version();
    if (!v || typeof v !== "object") return;
    node = el("span", {
      class: "muted mono foot-version",
      text: `hangar ${String(v.hangar ?? "?")} · crewhaus ${String(v.cli ?? "?")}`,
    });
  } catch {
    node = el("span", { class: "muted foot-version", text: "version unavailable" });
  }
  footRoot.appendChild(node);
}

async function dispatch(route) {
  const seq = ++dispatchSeq;
  clear(viewRoot).appendChild(skeleton(6));
  try {
    if (route.view === "library") {
      await renderLibrary(viewRoot);
    } else if (route.view === "harness") {
      await renderHarnessPage(viewRoot, route);
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
  const detail = await api.harness(route.id);
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
  root.appendChild(harnessHeader(detail, route));
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
  const ctx = { id: route.id, detail, route };
  if (route.tab === "spec") await renderSpec(tabRoot, ctx);
  else if (route.tab === "sessions") await renderSessions(tabRoot, ctx);
  else if (route.tab === "evals") await renderEvals(tabRoot, ctx);
  else if (route.tab === "memory") await renderMemory(tabRoot, ctx);
  else if (route.tab === "costs") await renderCosts(tabRoot, ctx);
  else await renderOverview(tabRoot, ctx);
}

function harnessHeader(detail, route) {
  const name = String(detail.specName ?? detail.name ?? route.id);
  const target = String(detail.target ?? "");
  const dir = String(detail.dir ?? "");
  const head = el("div", { class: "h-head", style: { "--accent": shapeAccent(target) } }, [
    el("div", { class: "h-title" }, [
      el("span", { class: "shape-badge", text: shapeLabel(target) }),
      el("h2", { text: name }),
      detail.missingSince ? dot("bad", "directory missing") : null,
    ]),
    dir !== ""
      ? el("div", { class: "h-dir" }, [
          el("span", { class: "mono muted", title: dir, text: dir }),
          copyBtn(dir, "copy"),
        ])
      : null,
    safetyStrip(detail.safety),
  ]);
  return head;
}

/**
 * The safety strip: the harness's whole posture on one line, straight from
 * the detail payload (parsed-spec values, computed server-side).
 */
function safetyStrip(safety) {
  const strip = el("div", { class: "safety-strip", "aria-label": "safety posture" });
  if (!safety || typeof safety !== "object") {
    strip.appendChild(el("span", { class: "chip", text: "safety posture unavailable" }));
    return strip;
  }
  const chip = (label, warn = false) =>
    strip.appendChild(el("span", { class: `chip${warn ? " chip-warn" : ""}`, text: label }));
  if (safety.permissionsMode) chip(`permissions: ${String(safety.permissionsMode)}`);
  if (safety.askMode) chip(`ask: ${String(safety.askMode)}`);
  if (typeof safety.budgetUsd === "number") {
    chip(`budget $${safety.budgetUsd}${safety.onExceed ? ` → ${String(safety.onExceed)}` : ""}`);
  } else {
    chip("no budget cap", true);
  }
  if (safety.transactionPolicy) chip(`tx: ${String(safety.transactionPolicy)}`);
  if (safety.allowPrivateTargets === true) chip("browser: private targets allowed", true);
  if (safety.thredzMessaging === true) chip("thredz messaging on", true);
  if (safety.justificationJudge) chip(`judge: ${String(safety.justificationJudge)}`);
  return strip;
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
      dispatch(parseRoute(window.location.hash));
    });
  });
  startRouter((route) => {
    dispatch(route);
  });
}

if (typeof document !== "undefined") boot();
