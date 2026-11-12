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
import { clear, el, skeleton } from "./dom.js";
import { bindingSheet, globalKey, initialKeyState, keyShape } from "./keys.js";
import { notifications } from "./notify.js";
import { openOmnibox } from "./omnibox.js";
import { applyPrefs, applyTheme, readPrefs, readTheme } from "./prefs.js";
import { parseRoute, startRouter } from "./router.js";
import {
  configureShell,
  currentNavCounts,
  drawNav,
  loadNavCounts,
  renderError,
  renderHarnessPage,
  renderNotFound,
  renderShell,
  viewRootNode,
} from "./shell.js";
import * as signIn from "./sign-in.js";
import { openDialog } from "./ui/dialog.js";
import { installLive } from "./ui/live.js";
import { dismissTooltip, installTooltips } from "./ui/tooltip.js";
import { renderActivity } from "./views/activity.js";
import { renderAdvisorBoard } from "./views/advisor.js";
import { renderApprovals } from "./views/approvals.js";
import { renderCredentialsMatrix } from "./views/creds.js";
import { renderFeedbackBoard } from "./views/feedback.js";
import { renderHealthBoard } from "./views/health.js";
import { renderLibrary } from "./views/library.js";
import { renderReview } from "./views/review.js";
import { renderRunsBoard } from "./views/runs.js";
import { renderSettings } from "./views/settings.js";
import { SESSION_ENDED, openSignInDialog, renderSignInScreen } from "./views/sign-in.js";
import { renderThredzGlobal } from "./views/thredz.js";

let dispatchSeq = 0;
// M4 (HM-190): overlay ownership. `inboxMounted` is set per navigation so
// `?` goes to the inbox's own sheet on the two screens that bind it, and to
// the app's sheet everywhere else.
let keyState = initialKeyState();
let omnibox = null;
let sheet = null;
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

async function dispatch(route) {
  const seq = ++dispatchSeq;
  const viewRoot = viewRootNode();
  drawNav(route, currentNavCounts());
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
    configureShell({
      openOverlay: () => openOverlay(),
      installKeyboard: () => installKeyboard(),
      redispatch: () => dispatch(parseRoute(window.location.hash)),
      isSigningIn: () => signInShowing,
    });
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
  renderSignInScreen(main, { message: signedIn.message ?? "", onSignedIn: start });
}

if (typeof document !== "undefined") boot();
