/**
 * HM-183's console half — the ONE notification poll.
 *
 * The manager runs no timer of its own: the rules are evaluated when the
 * console asks for the notification state, and `GET /api/notifications` IS
 * that evaluation. Which makes an ordinary-looking read a MUTATION in one
 * respect — every delivery it returns is added to the server's dedupe set
 * and will never be returned again — and that turns two innocent facts into
 * a bug:
 *
 *   - a console that only asks at boot never notifies anybody, however long
 *     it is left open, which is exactly the case the one default-on rule
 *     (a parked approval) exists for; and
 *   - a second caller — the Settings screen drawing its rules table — can
 *     CONSUME a delivery that nothing renders, so the toast for it can
 *     never appear again in that manager process.
 *
 * So the console asks in exactly one place: here. The loop below is the only
 * caller of `api.notifications()` in the asset tree (a unit test pins that),
 * a view that needs the state {@link NotificationPoll.subscribe|subscribes}
 * or asks for the shared {@link NotificationPoll.current|snapshot} rather
 * than issuing its own GET, and a payload a mutating route already
 * evaluated — the PUT that saves the rules answers with the same view the
 * GET does, deliveries and all — is folded back in through
 * {@link NotificationPoll.accept}. One rule holds it together: nothing
 * consumes a delivery without showing it.
 *
 * The factory is exported, with its loader and its timer injectable, so the
 * loop can be driven to completion in a unit test with no browser and no
 * clock.
 */

import { api } from "./api.js";

/**
 * How often an open console re-evaluates the rules. Each poll is a
 * fleet-wide signal scan on the server, so this is a BADGE cadence, not a
 * live feed: often enough that a parked approval surfaces while the
 * operator is still at the keyboard, rare enough that a hundred-harness
 * fleet is not rescanned every second.
 */
export const NOTIFICATION_POLL_MS = 30_000;

/** The deliveries in a payload, defensively. */
function deliveredOf(payload) {
  return Array.isArray(payload?.delivered) ? payload.delivered : [];
}

/**
 * Build a poll. `load` defaults to the real route; `schedule`/`cancel`
 * default to the browser timers. Returns:
 *
 *   - `start()`     — poll now, then every `intervalMs` (idempotent);
 *   - `stop()`      — stop the loop, keeping the last snapshot;
 *   - `subscribe(fn)` — `fn(payload, delivered)` on every snapshot seen,
 *                     polled or folded in; returns an unsubscribe;
 *   - `snapshot()`  — the last payload (or null) without a request;
 *   - `current()`   — the state a view should render, awaiting the poll in
 *                     flight or reusing the snapshot before it will start
 *                     one;
 *   - `refresh()`   — force one evaluation now, coalesced;
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

  const listeners = new Set();
  let snapshot = null;
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
    emit(payload, deliveredOf(payload));
    return payload;
  };

  const poll = () => {
    // Coalesce: two callers asking at once must never become two evaluating
    // GETs, because the second would find the first one's deliveries already
    // deduped away and would show nothing.
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
