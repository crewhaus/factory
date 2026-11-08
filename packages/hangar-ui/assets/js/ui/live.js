/**
 * Announcements: one polite and one assertive live region for the whole
 * console, children of `<body>` and outside `#app`, so a re-render of the
 * shell never removes them.
 *
 * Three rules this module keeps:
 *
 *   - Only an error is assertive. Information waits its turn
 *     ({@link politenessFor}), so a screen-reader user is interrupted only
 *     by something that went wrong.
 *   - A region that is told the same words twice stays silent, so every
 *     announcement clears the region first and writes on the next task.
 *   - A modal `<dialog>` makes everything outside it inert, and an inert
 *     region announces nothing. While a dialog is open the regions — and any
 *     toast — move into the top one, and back out when it closes.
 *
 * Nothing here builds a node or registers a listener when the module is
 * imported (`dom.js` imports this file, and this file imports `el` from
 * `dom.js`; the cycle is safe only while neither side runs at import time).
 */

import { el } from "../dom.js";

/** How long a region stays empty before the new words go in. */
const CLEAR_MS = 60;

let regions = null;
const timers = { polite: null, assertive: null };
/** Open dialogs, oldest first; the last one hosts the regions. */
const dialogs = [];

/** Which region a message of this kind goes to. Pure. */
export function politenessFor(kind) {
  return kind === "error" ? "assertive" : "polite";
}

/** Where the live regions and toasts belong right now: the top open dialog,
 *  or the body. */
export function liveHost() {
  for (let i = dialogs.length - 1; i >= 0; i -= 1) {
    const dialog = dialogs[i];
    if (dialog.isConnected && dialog.open) return dialog;
  }
  return document.body;
}

function ensureRegions() {
  if (regions?.polite.isConnected && regions.assertive.isConnected) {
    return regions;
  }
  regions = {
    polite: el("div", {
      class: "sr-only",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
      "data-live": "polite",
    }),
    assertive: el("div", {
      class: "sr-only",
      role: "alert",
      "aria-live": "assertive",
      "aria-atomic": "true",
      "data-live": "assertive",
    }),
  };
  const host = liveHost();
  host.appendChild(regions.polite);
  host.appendChild(regions.assertive);
  return regions;
}

/** Create the two regions now, so they exist before the first message. */
export function installLive() {
  ensureRegions();
}

/**
 * Say `text`. `{ assertive: true }` interrupts, and is for errors only;
 * everything else is polite.
 */
export function announce(text, opts = {}) {
  const which = opts && opts.assertive === true ? "assertive" : "polite";
  const node = ensureRegions()[which];
  const value = String(text ?? "");
  if (timers[which] !== null) clearTimeout(timers[which]);
  node.textContent = "";
  if (value === "") return;
  timers[which] = setTimeout(() => {
    timers[which] = null;
    node.textContent = value;
  }, CLEAR_MS);
}

/** Move the regions and any toast to wherever {@link liveHost} now says. */
function rehome() {
  const host = liveHost();
  if (regions !== null) {
    if (regions.polite.parentNode !== host) host.appendChild(regions.polite);
    if (regions.assertive.parentNode !== host) host.appendChild(regions.assertive);
  }
  for (const toastNode of document.querySelectorAll(".toast")) {
    if (toastNode.parentNode !== host) host.appendChild(toastNode);
  }
}

/** A modal dialog opened: it hosts the regions until it closes. */
export function enterDialog(dialog) {
  if (!dialogs.includes(dialog)) dialogs.push(dialog);
  rehome();
}

/** A modal dialog closed: the regions go back to whatever is beneath it. */
export function leaveDialog(dialog) {
  const at = dialogs.indexOf(dialog);
  if (at >= 0) dialogs.splice(at, 1);
  rehome();
}
