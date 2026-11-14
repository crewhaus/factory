/**
 * HM-183's console half — the ONE notification poll.
 *
 * Home delivers notifications on its own ten-second tick while it runs (in a window or
 * as the installed service): `GET /api/notifications` is a read. It answers the rules,
 * the in-app queue and `delivered`, the recent deliveries, each with the `at` of the tick
 * that delivered it. Reading it twice returns the same deliveries, so the poll announces
 * each one once: it remembers the newest `at` it has shown and hands listeners only the
 * deliveries after it. That mark is kept in the tab's sessionStorage, so reloading the
 * page, or opening another screen, does not announce the same delivery again.
 *
 * The console still asks in exactly one place: here. The loop below is the only caller
 * of `api.notifications()` in the asset tree (a unit test pins that), a view that needs
 * the state {@link NotificationPoll.subscribe|subscribes} or asks for the shared
 * {@link NotificationPoll.current|snapshot} rather than issuing its own GET, and a payload
 * a mutating route returns (the PUT that saves the rules answers with the same view the
 * GET does) is folded back in through {@link NotificationPoll.accept}. Each poll is a
 * fleet-wide read on the server, so screens share one.
 *
 * The factory is exported, with its loader and its timer injectable, so the
 * loop can be driven to completion in a unit test with no browser and no
 * clock.
 */

import { api } from "./api.js";

/**
 * How often an open console asks for the notification state. This is a BADGE
 * cadence, not a live feed: often enough that a parked approval surfaces while
 * the operator is still at the keyboard. Home keeps each delivery in
 * `delivered` for a minute, two polls, so every one is seen.
 */
export const NOTIFICATION_POLL_MS = 30_000;

/** The deliveries in a payload, defensively. */
function deliveredOf(payload) {
  return Array.isArray(payload?.delivered) ? payload.delivered : [];
}

/** Where the newest announced delivery's `at` is kept for this tab. */
export const SHOWN_UP_TO_KEY = "crewhaus.hangar.notifications.shownUpTo";

/** The tab's storage, when the page has one it may use. */
function defaultStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readShownUpTo(storage) {
  try {
    const value = storage?.getItem(SHOWN_UP_TO_KEY);
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

function writeShownUpTo(storage, at) {
  try {
    storage?.setItem(SHOWN_UP_TO_KEY, at);
  } catch {
    // Storage refused: the mark is kept for this page only.
  }
}

/** The deliveries newer than `shown` (an ISO time, or null), oldest first. */
function newerThan(delivered, shown) {
  return delivered
    .filter((d) => typeof d?.at === "string" && (shown === null || d.at > shown))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Build a poll. `load` defaults to the real route; `schedule`/`cancel`
 * default to the browser timers; `storage` (sessionStorage by default, `null` for
 * none) keeps which deliveries were announced. Returns:
 *
 *   - `start()`     — poll now, then every `intervalMs` (idempotent);
 *   - `stop()`      — stop the loop, keeping the last snapshot;
 *   - `subscribe(fn)` — `fn(payload, delivered)` on every snapshot seen,
 *                     polled or folded in; returns an unsubscribe;
 *   - `snapshot()`  — the last payload (or null) without a request;
 *   - `current()`   — the state a view should render, awaiting the poll in
 *                     flight or reusing the snapshot before it will start
 *                     one;
 *   - `refresh()`   — force one read now, coalesced;
 *   - `accept(payload)` — fold in a payload a mutating route returned.
 */
export function createNotificationPoll(options = {}) {
  const load = typeof options.load === "function" ? options.load : () => api.notifications();
  const intervalMs = Number.isFinite(options.intervalMs)
    ? Number(options.intervalMs)
    : NOTIFICATION_POLL_MS;
  const schedule =
    typeof options.schedule === "function" ? options.schedule : (fn, ms) => setTimeout(fn, ms);
  const cancel =
    typeof options.cancel === "function" ? options.cancel : (handle) => clearTimeout(handle);

  const storage = options.storage !== undefined ? options.storage : defaultStorage();
  const listeners = new Set();
  let snapshot = null;
  /** The newest delivery `at` handed to listeners: each delivery is announced once. */
  let shownUpTo = readShownUpTo(storage);
  let inFlight = null;
  let timer = null;
  let running = false;

  const emit = (payload, delivered) => {
    for (const listener of [...listeners]) {
      try {
        listener(payload, delivered);
      } catch {
        // One listener throwing must never stop the loop that feeds the
        // others — a broken toast cannot be allowed to break the badge.
      }
    }
  };

  /** Record a payload and tell everyone. The ONLY place `snapshot` moves. */
  const fold = (payload) => {
    if (payload === null || typeof payload !== "object") return null;
    snapshot = payload;
    const fresh = newerThan(deliveredOf(payload), shownUpTo);
    const newest = fresh[fresh.length - 1];
    if (newest !== undefined) {
      shownUpTo = newest.at;
      writeShownUpTo(storage, newest.at);
    }
    emit(payload, fresh);
    return payload;
  };

  const poll = () => {
    // Coalesce: two callers asking at once share one GET, the fleet-wide read.
    if (inFlight !== null) return inFlight;
    const request = Promise.resolve()
      .then(load)
      .then(fold, () => null) // a failed poll is not a reason to stop polling
      .then((result) => {
        inFlight = null;
        return result;
      });
    inFlight = request;
    return request;
  };

  const tick = () => {
    timer = null;
    poll().then(() => {
      if (running && timer === null) timer = schedule(tick, intervalMs);
    });
  };

  return {
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    current() {
      if (inFlight !== null) return inFlight;
      if (snapshot !== null) return Promise.resolve(snapshot);
      return poll();
    },
    refresh: () => poll(),
    accept: (payload) => fold(payload),
  };
}

/** The console's one poll. Views import THIS; the factory above exists so a
 *  test can drive the same loop with its own clock. */
export const notifications = createNotificationPoll();
