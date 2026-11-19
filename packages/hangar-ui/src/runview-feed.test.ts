/**
 * The run view's feed, with a fake clock: it follows only at the bottom, counts
 * what arrived while the reader was scrolled up, draws a window, shows each
 * marker, backs off when reconnecting, drops a repeated cursor and says what
 * arrived at most every few seconds.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import * as feed from "../assets/js/runview/feed.js";

type Item = {
  id: string | null;
  card: { kind: string; title: string; severity: string };
  marker?: string;
};
type State = Record<string, unknown> & {
  options: Record<string, number>;
  lastId: string | null;
  attempt: number;
  retryAt: number | null;
};
type View = {
  items: Item[];
  earlier: number;
  later: number;
  unread: number;
  following: boolean;
  dropped: number;
  filter: string;
  hidden: number;
  total: number;
};
const F = feed as {
  createFeed(o?: Record<string, number>): State;
  append(s: State, items: Item[]): State;
  scrolled(s: State, atBottom: boolean): State;
  jumpToLatest(s: State): State;
  showEarlier(s: State): State;
  replayed(s: State, items: Item[]): State;
  emptyWords(v: View): { text: string; showAll: boolean } | null;
  setFilter(s: State, f: string): State;
  view(s: State): View;
  backoffMs(o: Record<string, number>, attempt: number): number;
  disconnected(s: State, now: number): State;
  connected(s: State): State;
  reconnectDue(s: State, now: number): boolean;
  resumeFrom(s: State): string | null;
  announce(s: State, now: number): { state: State; text: string | null };
  unreadWords(n: number): string;
};

let n = 0;
const ev = (severity = "notice", id: string | null = `c${++n}`): Item => ({
  id,
  card: { kind: "x", title: `event ${id}`, severity },
});

describe("follow and unread", () => {
  test("at the bottom the window follows; scrolled up it stays and counts", () => {
    let s = F.createFeed({ windowSize: 3 });
    s = F.append(s, [ev(), ev(), ev(), ev()]);
    let v = F.view(s);
    expect(v.following).toBe(true);
    expect(v.items.length).toBe(3);
    expect(v.earlier).toBe(1);
    s = F.scrolled(s, false);
    const shown = F.view(s).items.map((i) => i.id);
    s = F.append(s, [ev(), ev()]);
    v = F.view(s);
    expect(v.items.map((i) => i.id)).toEqual(shown);
    expect(v.unread).toBe(2);
    expect(F.unreadWords(v.unread)).toBe("2 new events — Jump to latest");
    s = F.jumpToLatest(s);
    v = F.view(s);
    expect(v.following).toBe(true);
    expect(v.unread).toBe(0);
    expect(v.later).toBe(0);
    s = F.scrolled(F.scrolled(s, false), true);
    expect(F.view(s).following).toBe(true);
  });

  test("thousands of events stay windowed, and Show earlier events steps back", () => {
    let s = F.createFeed({ windowSize: 200, keep: 5000 });
    s = F.append(
      s,
      Array.from({ length: 3000 }, () => ev()),
    );
    let v = F.view(s);
    expect(v.items.length).toBe(200);
    expect(v.earlier).toBe(2800);
    s = F.showEarlier(s);
    v = F.view(s);
    expect(v.earlier).toBe(2600);
    expect(v.following).toBe(false);
    s = F.append(
      s,
      Array.from({ length: 3000 }, () => ev()),
    );
    expect(F.view(s).dropped).toBe(1000);
  });
});

describe("filters and markers", () => {
  test("Important keeps notices and markers; Everything keeps all", () => {
    let s = F.createFeed();
    const marker: Item = {
      id: "m1",
      marker: "gap",
      card: { kind: "stream.gap", title: "gap", severity: "warn" },
    };
    s = F.append(s, [ev("quiet"), ev("info"), ev("notice"), marker]);
    expect(F.view(s).items.length).toBe(2);
    expect(F.view(s).items.some((i) => i.marker === "gap")).toBe(true);
    s = F.setFilter(s, "everything");
    expect(F.view(s).items.length).toBe(4);
    expect(F.setFilter(s, "nonsense").filter).toBe("important");
  });
});

describe("resume", () => {
  test("a repeated cursor is dropped, and a reconnect resumes after the last one", () => {
    let s = F.createFeed();
    s = F.append(s, [ev("notice", "a"), ev("notice", "b")]);
    s = F.append(s, [ev("notice", "b"), ev("notice", "c")]);
    expect(F.view(s).items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(F.resumeFrom(s)).toBe("c");
    // An item with no cursor is never taken for a repeat.
    s = F.append(s, [ev("notice", null), ev("notice", null)]);
    expect(F.view(s).items.length).toBe(5);
  });

  test("a stream's marker that shares the cursor of the frame before it is shown", () => {
    let s = F.createFeed();
    s = F.append(s, [ev("info", "x5")]);
    const pause: Item = {
      id: "x5",
      marker: "pause",
      card: { kind: "stream.pause", title: "Paused", severity: "notice" },
    };
    s = F.append(s, [pause]);
    expect(F.view(s).items.map((i) => i.marker ?? "event")).toEqual(["pause"]);
    expect(F.resumeFrom(s)).toBe("x5");
    // The reconnect resumes there and nothing it already holds is drawn twice.
    s = F.append(s, [ev("notice", "x5"), ev("notice", "x6")]);
    expect(F.view(s).items.map((i) => i.id)).toEqual(["x5", "x6"]);
    expect(F.resumeFrom(s)).toBe("x6");
  });

  test("reconnecting backs off, doubling to a cap, and starts over once connected", () => {
    const opts = { firstBackoffMs: 1000, maxBackoffMs: 8000 };
    expect([1, 2, 3, 4, 5].map((a) => F.backoffMs(opts, a))).toEqual([
      1000, 2000, 4000, 8000, 8000,
    ]);
    let s = F.createFeed(opts);
    s = F.disconnected(s, 10_000);
    expect(s.retryAt).toBe(11_000);
    expect(F.reconnectDue(s, 10_999)).toBe(false);
    expect(F.reconnectDue(s, 11_000)).toBe(true);
    s = F.disconnected(s, 11_000);
    expect(s.retryAt).toBe(13_000);
    s = F.connected(s);
    expect(s.attempt).toBe(0);
    expect(F.reconnectDue(s, 99_999)).toBe(false);
  });
});

describe("a stream that starts over", () => {
  const replay = (count: number): Item[] =>
    Array.from({ length: count }, (_, i) => ({
      id: null,
      at: `t${i}`,
      card: { kind: "x", title: `event ${i}`, severity: "notice" },
    })) as Item[];

  test("scrolled up, a replay moves nothing and counts only what is new", () => {
    let s = F.createFeed({ windowSize: 3 });
    s = F.replayed(s, replay(6));
    s = F.scrolled(s, false);
    s = F.showEarlier(s);
    const before = F.view(s);
    expect(before.following).toBe(false);
    s = F.replayed(s, replay(8));
    const after = F.view(s);
    expect(after.following).toBe(false);
    expect(after.unread).toBe(2);
    expect(after.earlier).toBe(before.earlier);
    // The same events keep their keys, so their drawn nodes survive.
    const keys = (v: View) => v.items.map((i) => (i as Item & { key: string }).key);
    expect(keys(after)).toEqual(keys(before));
  });

  test("at the bottom, a replay keeps following", () => {
    let s = F.replayed(F.createFeed({ windowSize: 3 }), replay(4));
    s = F.replayed(s, replay(5));
    expect(F.view(s).following).toBe(true);
    expect(F.view(s).items.map((i) => i.card.title)).toEqual(["event 2", "event 3", "event 4"]);
  });
});

describe("an empty list says why", () => {
  test("nothing yet, or the filter hides what came, with the way to show it", () => {
    let s = F.createFeed();
    expect(F.emptyWords(F.view(s))).toEqual({ text: "No events yet.", showAll: false });
    const marker: Item = {
      id: null,
      marker: "replayed",
      card: { kind: "stream.replayed", title: "Showing 3", severity: "notice" },
    };
    s = F.append(s, [marker, ev("info", null), ev("quiet", null), ev("info", null)]);
    expect(F.emptyWords(F.view(s))).toEqual({
      text: "Nothing important yet. 3 other events are hidden.",
      showAll: true,
    });
    expect(F.emptyWords(F.view(F.setFilter(s, "everything")))).toBeNull();
    expect(F.emptyWords(F.view(F.append(s, [ev("warn", null)])))).toBeNull();
  });
});

describe("announcements", () => {
  test("at most one polite summary every few seconds", () => {
    let s = F.createFeed({ announceEveryMs: 5000 });
    s = F.append(s, [ev(), ev()]);
    let out = F.announce(s, 1000);
    expect(out.text).toBe("2 new events");
    s = F.append(out.state, [ev()]);
    out = F.announce(s, 3000);
    expect(out.text).toBeNull();
    out = F.announce(out.state, 6000);
    expect(out.text).toBe("1 new event");
    expect(F.announce(out.state, 20_000).text).toBeNull();
  });
});
