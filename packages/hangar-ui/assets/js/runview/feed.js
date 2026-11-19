/**
 * The run view's feed, as a pure reducer: what is kept, what is shown, where the
 * reader is, and when to reconnect. No DOM and no clock of its own: every step
 * that needs the time is handed `now`.
 *
 * - **Filters.** Important (the default: a stream's own markers and every card at
 *   `notice` or above) or Everything.
 * - **Follow.** New items keep the view at the latest only while the reader is at
 *   the bottom. Scrolled up, the view stays where it is and counts what arrived
 *   ("N new events — Jump to latest").
 * - **Window.** At most `windowSize` items are drawn; "Show earlier events" draws
 *   the window before. At most `keep` items are kept at all, the oldest dropped
 *   first.
 * - **Resume.** The last item's `id` is where a reconnect resumes from
 *   (`Last-Event-ID`); an event whose `id` was already seen is dropped. A stream's
 *   own marker (a pause, a gap, a reset) is never dropped as a repeat: it carries
 *   the cursor of the frame before it. A dropped connection is tried again after a
 *   backoff that doubles up to `maxBackoffMs`.
 * - **Replay.** A stream that starts over from its first event (Home's own run
 *   stream, on every reconnect) replaces the items and keeps where the reader is:
 *   scrolled up, nothing moves and only what is new counts as unread.
 * - **Keys.** Every kept item gets a `key` from its place in the stream and what it
 *   says, so the same event replayed keeps its drawn node (an open fold, focus).
 * - **Announcements.** A polite summary of what arrived, at most once every
 *   `announceEveryMs`.
 */

import { isImportant } from "./cards.js";

export const FEED_DEFAULTS = Object.freeze({
  windowSize: 200,
  keep: 5000,
  firstBackoffMs: 1000,
  maxBackoffMs: 30_000,
  announceEveryMs: 5000,
  seenIds: 10_000,
});

/** A fresh feed. */
export function createFeed(options = {}) {
  return {
    options: { ...FEED_DEFAULTS, ...options },
    items: [],
    dropped: 0,
    filter: "important",
    following: true,
    unread: 0,
    windowStart: 0,
    lastId: null,
    seen: [],
    attempt: 0,
    retryAt: null,
    pendingAnnounce: 0,
    announcedAt: null,
  };
}

/** Whether an item shows under a filter. */
export function shows(item, filter) {
  if (filter === "everything") return true;
  return item.marker !== undefined || isImportant(item.card);
}

/** The items a filter shows, in order. */
function filtered(state) {
  return state.items.filter((item) => shows(item, state.filter));
}

/** Where the window starts so its end is the latest item. */
function windowAtEnd(state, count) {
  return Math.max(0, count - state.options.windowSize);
}

/** An item's key: its place in the stream and what it says. */
function keyOf(item, at) {
  const card = item.card ?? {};
  return `${at}|${String(card.kind ?? "")}|${String(item.at ?? "")}|${String(card.title ?? "")}`;
}

/**
 * Items arrived. An event whose `id` was already seen is dropped, a stream's own
 * marker never is; the kept list is trimmed to `keep`; at the bottom the window
 * follows, scrolled up the unread count grows.
 */
export function append(state, incoming) {
  const seen = new Set(state.seen);
  const added = [];
  let lastId = state.lastId;
  let at = state.dropped + state.items.length;
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (item === null || typeof item !== "object") continue;
    if (typeof item.id === "string") {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        lastId = item.id;
      } else if (item.marker === undefined) {
        continue;
      }
    }
    added.push({ ...item, key: keyOf(item, at) });
    at += 1;
  }
  if (added.length === 0) return state;
  let items = [...state.items, ...added];
  let dropped = state.dropped;
  const over = items.length - state.options.keep;
  if (over > 0) {
    items = items.slice(over);
    dropped += over;
  }
  const seenList = [...seen].slice(-state.options.seenIds);
  const visibleAdded = added.filter((item) => shows(item, state.filter)).length;
  const next = {
    ...state,
    items,
    dropped,
    lastId,
    seen: seenList,
    pendingAnnounce: state.pendingAnnounce + visibleAdded,
  };
  const count = filtered(next).length;
  if (state.following) return { ...next, windowStart: windowAtEnd(next, count), unread: 0 };
  // Scrolled up: nothing moves; trimmed items shift the window start back.
  return {
    ...next,
    windowStart: Math.max(0, state.windowStart - Math.max(0, over)),
    unread: state.unread + visibleAdded,
  };
}

/**
 * The stream started over from its first event: its items replace the kept ones,
 * and the reader stays where they are. Following, the window goes to the latest;
 * scrolled up, nothing moves and only items beyond what was shown before count as
 * unread and are announced.
 */
export function replayed(state, incoming) {
  const before = filtered(state).length;
  const fresh = {
    ...state,
    items: [],
    dropped: 0,
    seen: [],
    lastId: null,
    following: true,
    unread: 0,
    pendingAnnounce: 0,
  };
  const filled = append(fresh, incoming);
  const after = filtered(filled).length;
  const added = Math.max(0, after - before);
  const pendingAnnounce = state.pendingAnnounce + added;
  if (state.following) return { ...filled, pendingAnnounce };
  return {
    ...filled,
    following: false,
    unread: state.unread + added,
    windowStart: Math.min(state.windowStart, Math.max(0, after - 1)),
    pendingAnnounce,
  };
}

/** The reader scrolled: following only at the bottom. */
export function scrolled(state, atBottom) {
  if (atBottom) return { ...state, following: true, unread: 0 };
  return state.following ? { ...state, following: false } : state;
}

/** "Jump to latest": back to the bottom, following. */
export function jumpToLatest(state) {
  const count = filtered(state).length;
  return { ...state, following: true, unread: 0, windowStart: windowAtEnd(state, count) };
}

/** "Show earlier events": the window before, and no longer following. */
export function showEarlier(state) {
  return {
    ...state,
    following: false,
    windowStart: Math.max(0, state.windowStart - state.options.windowSize),
  };
}

/** Change the filter; the window goes to the latest under it. */
export function setFilter(state, filter) {
  const next = { ...state, filter: filter === "everything" ? "everything" : "important" };
  return {
    ...next,
    following: true,
    unread: 0,
    windowStart: windowAtEnd(next, filtered(next).length),
  };
}

/**
 * What to draw: the window's items, how many come before and after it, and how
 * many kept items the filter hides.
 */
export function view(state) {
  const all = filtered(state);
  const start = Math.min(state.windowStart, Math.max(0, all.length - 1));
  const end = Math.min(all.length, start + state.options.windowSize);
  return {
    items: all.slice(start, end),
    earlier: start,
    later: all.length - end,
    unread: state.unread,
    following: state.following,
    dropped: state.dropped,
    filter: state.filter,
    hidden: state.items.length - all.length,
    total: state.items.length,
  };
}

/**
 * Why the list shows no events, or null when it shows some: nothing has arrived,
 * or the Important filter hides every event that has (its count, and the action
 * that shows them).
 */
export function emptyWords(v) {
  if (v.items.some((item) => item.marker === undefined)) return null;
  if (v.filter === "important" && v.hidden > 0) {
    const n = v.hidden;
    return {
      text: `Nothing important yet. ${n} other event${n === 1 ? " is" : "s are"} hidden.`,
      showAll: true,
    };
  }
  return v.items.length === 0 ? { text: "No events yet.", showAll: false } : null;
}

/** The wait before reconnect attempt `attempt` (1-based): doubling, capped. */
export function backoffMs(options, attempt) {
  const o = { ...FEED_DEFAULTS, ...options };
  const n = Math.max(1, attempt);
  return Math.min(o.maxBackoffMs, o.firstBackoffMs * 2 ** (n - 1));
}

/** The connection dropped at `now`: when to try again. */
export function disconnected(state, now) {
  const attempt = state.attempt + 1;
  return { ...state, attempt, retryAt: now + backoffMs(state.options, attempt) };
}

/** The connection is up: the backoff starts over. */
export function connected(state) {
  return { ...state, attempt: 0, retryAt: null };
}

/** Whether a reconnect is due at `now`. */
export function reconnectDue(state, now) {
  return state.retryAt !== null && now >= state.retryAt;
}

/** The `Last-Event-ID` a reconnect sends: the last item's cursor, or none. */
export function resumeFrom(state) {
  return state.lastId;
}

/**
 * The polite summary due at `now`, if any: at most once every
 * `announceEveryMs`, and only when something new is shown.
 */
export function announce(state, now) {
  if (state.pendingAnnounce === 0) return { state, text: null };
  if (state.announcedAt !== null && now - state.announcedAt < state.options.announceEveryMs) {
    return { state, text: null };
  }
  const n = state.pendingAnnounce;
  return {
    state: { ...state, pendingAnnounce: 0, announcedAt: now },
    text: `${n} new event${n === 1 ? "" : "s"}`,
  };
}

/** The words on the "Jump to latest" button. */
export function unreadWords(count) {
  return `${count} new event${count === 1 ? "" : "s"} — Jump to latest`;
}
