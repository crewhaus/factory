/**
 * Relative times that stay true while a screen is open: "as of 3m ago"
 * becomes "as of 4m ago" a minute later, from one shared ticker rather than a
 * timer per chip.
 *
 * The ticker stops when nobody can see it — the tab is hidden, or the reader
 * asked for reduced motion (text that changes under the eye is motion too) —
 * and it never announces: a live region that counted the minutes would talk
 * over everything else.
 *
 * {@link createTicker} takes its clock, scheduler and visibility checks as
 * options, the way `notify.js` does, so a unit test drives it with no
 * browser and no real time. Nothing runs at import.
 */

import { el } from "../dom.js";
import { fmtRelativeTime } from "../util.js";

/** How often the shared ticker refreshes. Minutes are the finest unit shown. */
export const TICK_MS = 30_000;

/**
 * A ticker over tracked entries `{ node, iso, format }`.
 *
 * options: now(), schedule(fn, ms), cancel(handle), intervalMs,
 *          paused() — true while the tab is hidden or motion is reduced.
 *
 * Returns { track, tick, start, stop, running, size }.
 */
export function createTicker(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const schedule =
    typeof options.schedule === "function" ? options.schedule : (fn, ms) => setTimeout(fn, ms);
  const cancel =
    typeof options.cancel === "function" ? options.cancel : (handle) => clearTimeout(handle);
  const paused = typeof options.paused === "function" ? options.paused : () => false;
  const intervalMs = Number.isFinite(options.intervalMs) ? Number(options.intervalMs) : TICK_MS;
  const entries = new Set();
  let handle = null;

  const isLive = (entry) => entry.node.isConnected !== false;

  const tick = () => {
    const at = now();
    for (const entry of [...entries]) {
      if (!isLive(entry)) {
        entries.delete(entry);
        continue;
      }
      const text = entry.format(entry.iso, at);
      if (entry.node.textContent !== text) entry.node.textContent = text;
    }
  };

  const loop = () => {
    handle = null;
    if (paused() || entries.size === 0) return;
    tick();
    if (entries.size > 0) handle = schedule(loop, intervalMs);
  };

  const start = () => {
    if (handle !== null || paused() || entries.size === 0) return;
    handle = schedule(loop, intervalMs);
  };

  const stop = () => {
    if (handle !== null) cancel(handle);
    handle = null;
  };

  return {
    track(node, iso, format) {
      entries.add({ node, iso, format });
      start();
    },
    tick,
    start,
    stop,
    running: () => handle !== null,
    size: () => entries.size,
  };
}

let shared = null;

function motionReduced() {
  const root = document.documentElement;
  if (root.dataset.motion === "reduce") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function sharedTicker() {
  if (shared === null) {
    shared = createTicker({ paused: () => document.hidden === true || motionReduced() });
    // Back from a hidden tab: a fresh reading, then the loop resumes.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden === true) shared.stop();
      else {
        shared.tick();
        shared.start();
      }
    });
  }
  return shared;
}

/**
 * A `<time datetime>` reading as a relative time ("3m ago"), kept current by
 * the shared ticker. `format(iso, nowMs)` overrides the wording (the runs
 * board shows an uptime). Null when `iso` is not a string.
 */
export function timeEl(iso, opts = {}) {
  if (typeof iso !== "string" || iso === "") return null;
  const format =
    opts && typeof opts.format === "function"
      ? opts.format
      : (value, at) => fmtRelativeTime(value, at);
  const node = el("time", { datetime: iso, text: format(iso, Date.now()) });
  sharedTicker().track(node, iso, format);
  return node;
}
