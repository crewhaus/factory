import { describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import type {
  HarnessEntry,
  WatchmeAggregate,
  WatchmeObservation,
  WatchmeState,
} from "@crewhaus/watchme-store";
import {
  WatchmeError,
  formatWatchmeStatus,
  resolveWatchmeEnv,
  resolveWatchmeSpecPath,
  watchmeStart,
  watchmeStatus,
  watchmeStop,
} from "./watchme";

function fakeStore(
  initial?: Partial<WatchmeState>,
  data?: {
    observations?: WatchmeObservation[];
    aggregates?: WatchmeAggregate[];
  },
) {
  let current: WatchmeState = {
    schemaVersion: 1,
    watching: false,
    watermark: { lastMtimeMs: 0 },
    windows: {},
    ...initial,
  };
  const patches: Partial<WatchmeState>[] = [];
  return {
    state: (): WatchmeState => current,
    setState: (patch: Partial<WatchmeState>): void => {
      patches.push(patch);
      current = { ...current, ...patch, schemaVersion: 1 };
    },
    readObservations: (): WatchmeObservation[] => data?.observations ?? [],
    readAggregates: (): WatchmeAggregate[] => data?.aggregates ?? [],
    patches,
  };
}

function obsFixture(sessionId: string): WatchmeObservation {
  return {
    v: 1,
    sessionId,
    specName: "demo",
    target: "cli",
    ts: 1_700_000_000_000,
    turnCount: 3,
    joinConfidence: "ordered",
    models: [],
    toolStats: [],
    intentKeys: [],
  };
}

function aggFixture(key: string, n: number): WatchmeAggregate {
  return {
    v: 1,
    agg: 1,
    key,
    n,
    meanTurns: 0,
    m2Turns: 0,
    meanQuality: 0,
    m2Quality: 0,
    qualityN: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsdMicros: 0,
    toolCalls: 0,
    toolErrors: 0,
    feedbackUp: 0,
    feedbackDown: 0,
    intents: {},
  };
}

function entryFixture(dir: string): HarnessEntry {
  return { dir, specName: "demo", target: "cli", registeredAt: 1, lastSeen: 2 };
}

describe("resolveWatchmeSpecPath", () => {
  const cwd = "/harness";

  test("returns the absolute --spec when it exists", () => {
    const exists = (p: string) => p === "/harness/agent.yaml";
    expect(resolveWatchmeSpecPath("agent.yaml", cwd, exists)).toBe("/harness/agent.yaml");
    expect(isAbsolute(resolveWatchmeSpecPath("agent.yaml", cwd, exists))).toBe(true);
  });

  test("keeps an absolute --spec as-is", () => {
    const exists = (p: string) => p === "/other/spec.yaml";
    expect(resolveWatchmeSpecPath("/other/spec.yaml", cwd, exists)).toBe("/other/spec.yaml");
  });

  test("throws WatchmeError naming the missing --spec", () => {
    const exists = () => false;
    expect(() => resolveWatchmeSpecPath("missing.yaml", cwd, exists)).toThrow(WatchmeError);
    try {
      resolveWatchmeSpecPath("missing.yaml", cwd, exists);
    } catch (err) {
      expect((err as Error).message).toContain("--spec not found");
      expect((err as Error).message).toContain("/harness/missing.yaml");
    }
  });

  test("falls back to cwd/crewhaus.yaml when no --spec is given", () => {
    const exists = (p: string) => p === join(cwd, "crewhaus.yaml");
    expect(resolveWatchmeSpecPath(undefined, cwd, exists)).toBe(join(cwd, "crewhaus.yaml"));
  });

  test("throws WatchmeError when neither --spec nor the fallback exists", () => {
    const exists = () => false;
    expect(() => resolveWatchmeSpecPath(undefined, cwd, exists)).toThrow(WatchmeError);
    try {
      resolveWatchmeSpecPath(undefined, cwd, exists);
    } catch (err) {
      expect((err as Error).message).toContain("no --spec given");
      expect((err as Error).message).toContain(cwd);
    }
  });
});

describe("watchmeStart", () => {
  const harness = { dir: "/h", specName: "demo", target: "cli" };

  test("fresh start: state flip, then registry upsert, then backfill", async () => {
    const calls: string[] = [];
    const store = fakeStore();
    const registered: unknown[] = [];
    const result = await watchmeStart({
      store: {
        state: store.state,
        setState: (patch) => {
          calls.push("setState");
          store.setState(patch);
        },
      },
      registry: {
        register: (entry) => {
          calls.push("register");
          registered.push(entry);
        },
      },
      harness,
      runBackfill: () => {
        calls.push("backfill");
        return { sessionsAnalyzed: 4 };
      },
      now: () => 1111,
    });
    expect(calls).toEqual(["setState", "register", "backfill"]);
    expect(result.alreadyWatching).toBe(false);
    expect(result.startedAt).toBe(1111);
    expect(result.backfill).toEqual({ sessionsAnalyzed: 4 });
    expect(registered).toEqual([harness]);
    expect(store.state().watching).toBe(true);
    expect(store.state().startedAt).toBe(1111);
  });

  test("idempotent restart: preserves startedAt, still registers + backfills", async () => {
    const store = fakeStore({ watching: true, startedAt: 42 });
    let registered = 0;
    let backfilled = 0;
    const result = await watchmeStart({
      store,
      registry: {
        register: () => {
          registered += 1;
        },
      },
      harness,
      runBackfill: () => {
        backfilled += 1;
      },
      now: () => 9999,
    });
    expect(result.alreadyWatching).toBe(true);
    expect(result.startedAt).toBe(42);
    expect(store.state().startedAt).toBe(42);
    expect(registered).toBe(1);
    expect(backfilled).toBe(1);
  });

  test("restart after a stop mints a fresh startedAt", async () => {
    const store = fakeStore({ watching: false, startedAt: 42 });
    const result = await watchmeStart({
      store,
      registry: { register: () => {} },
      harness,
      runBackfill: () => {},
      now: () => 9999,
    });
    expect(result.alreadyWatching).toBe(false);
    expect(result.startedAt).toBe(9999);
  });

  test("watching without a recorded startedAt falls back to now()", async () => {
    const store = fakeStore({ watching: true });
    const result = await watchmeStart({
      store,
      registry: { register: () => {} },
      harness,
      runBackfill: () => {},
      now: () => 7,
    });
    expect(result.alreadyWatching).toBe(true);
    expect(result.startedAt).toBe(7);
  });

  test("awaits an async backfill and returns its result", async () => {
    const store = fakeStore();
    const result = await watchmeStart({
      store,
      registry: { register: () => {} },
      harness,
      runBackfill: async () => "digested",
      now: () => 1,
    });
    expect(result.backfill).toBe("digested");
  });
});

describe("watchmeStop", () => {
  test("flips watching off, keeps data and registration by default", () => {
    const store = fakeStore({ watching: true, startedAt: 42 });
    let deregistered = 0;
    const result = watchmeStop({
      store,
      registry: {
        deregister: () => {
          deregistered += 1;
        },
      },
      harnessDir: "/h",
    });
    expect(result).toEqual({ wasWatching: true, forgotten: false });
    expect(store.state().watching).toBe(false);
    expect(store.state().startedAt).toBe(42);
    expect(deregistered).toBe(0);
  });

  test("--forget also deregisters the harness dir", () => {
    const store = fakeStore({ watching: true });
    const dirs: string[] = [];
    const result = watchmeStop({
      store,
      registry: { deregister: (dir) => dirs.push(dir) },
      harnessDir: "/h",
      forget: true,
    });
    expect(result).toEqual({ wasWatching: true, forgotten: true });
    expect(dirs).toEqual(["/h"]);
  });

  test("stopping when not watching reports wasWatching false", () => {
    const store = fakeStore();
    const result = watchmeStop({ store, registry: { deregister: () => {} }, harnessDir: "/h" });
    expect(result.wasWatching).toBe(false);
    expect(store.state().watching).toBe(false);
  });
});

describe("watchmeStatus", () => {
  test("assembles counts, coverage, windows, and registry size", () => {
    const store = fakeStore(
      {
        watching: true,
        startedAt: 5,
        watermark: { lastMtimeMs: 1_700_000_000_000, lastSessionId: "sess_0123456789abcdef" },
        windows: {
          "watchme:demo:1": "ok",
          "watchme:demo:2": "ok",
          "watchme:demo:3": "model_failed",
        },
        lastReportAt: 1_700_000_100_000,
      },
      {
        observations: [obsFixture("sess_aaaaaaaaaaaaaaaa"), obsFixture("sess_bbbbbbbbbbbbbbbb")],
        aggregates: [aggFixture("demo|cli", 5), aggFixture("other|cli", 3)],
      },
    );
    const summary = watchmeStatus({
      store,
      registry: { list: () => [entryFixture("/h1"), entryFixture("/h2")] },
      sessionFiles: [
        "sess_aaaaaaaaaaaaaaaa.json",
        "sess_aaaaaaaaaaaaaaaa.jsonl",
        "sess_aaaaaaaaaaaaaaaa.events.jsonl",
        "sess_bbbbbbbbbbbbbbbb.json",
        "sess_bbbbbbbbbbbbbbbb.jsonl",
        "sess_cccccccccccccccc.events.jsonl",
        "notes.txt",
      ],
    });
    expect(summary.watching).toBe(true);
    expect(summary.startedAt).toBe(5);
    expect(summary.watermark).toEqual({
      lastMtimeMs: 1_700_000_000_000,
      lastSessionId: "sess_0123456789abcdef",
    });
    expect(summary.sessionsCaptured).toBe(2);
    expect(summary.sessionsAnalyzed).toBe(10);
    // Orphan .events.jsonl (evicted session) is not coverage; only paired logs.
    expect(summary.eventsCoverage).toEqual({ withEvents: 1, total: 2 });
    expect(summary.lastReportAt).toBe(1_700_000_100_000);
    expect(summary.windows).toEqual({
      "watchme:demo:1": "ok",
      "watchme:demo:2": "ok",
      "watchme:demo:3": "model_failed",
    });
    expect(summary.registeredHarnesses).toBe(2);
  });

  test("empty defaults: nothing captured, analyzed, or registered", () => {
    const summary = watchmeStatus({
      store: fakeStore(),
      registry: { list: () => [] },
      sessionFiles: [],
    });
    expect(summary.watching).toBe(false);
    expect("startedAt" in summary).toBe(false);
    expect("lastReportAt" in summary).toBe(false);
    expect(summary.watermark).toEqual({ lastMtimeMs: 0 });
    expect(summary.sessionsCaptured).toBe(0);
    expect(summary.sessionsAnalyzed).toBe(0);
    expect(summary.eventsCoverage).toEqual({ withEvents: 0, total: 0 });
    expect(summary.windows).toEqual({});
    expect(summary.registeredHarnesses).toBe(0);
  });
});

describe("formatWatchmeStatus", () => {
  test("renders the watching block with counts and window outcomes", () => {
    const text = formatWatchmeStatus({
      watching: true,
      startedAt: Date.UTC(2026, 6, 24, 10, 0),
      watermark: {
        lastMtimeMs: Date.UTC(2026, 6, 24, 9, 58),
        lastSessionId: "sess_0123456789abcdef",
      },
      sessionsCaptured: 12,
      sessionsAnalyzed: 10,
      eventsCoverage: { withEvents: 8, total: 12 },
      lastReportAt: Date.UTC(2026, 6, 24, 9, 59),
      windows: { a: "ok", b: "ok", c: "model_failed" },
      registeredHarnesses: 3,
    });
    expect(text).toContain("watching since 2026-07-24T10:00Z");
    expect(text).toContain("12 captured · 10 analyzed · 8/12 with .events.jsonl siblings");
    expect(text).toContain("2026-07-24T09:58Z (sess_0123456789abcdef)");
    expect(text).toContain("last report 2026-07-24T09:59Z");
    expect(text).toContain("1 model_failed · 2 ok");
    expect(text).toContain("3 registered harnesses");
  });

  test("renders the not-watching block with the start hint and singulars", () => {
    const text = formatWatchmeStatus({
      watching: false,
      watermark: { lastMtimeMs: 0 },
      sessionsCaptured: 0,
      sessionsAnalyzed: 0,
      eventsCoverage: { withEvents: 0, total: 0 },
      windows: {},
      registeredHarnesses: 1,
    });
    expect(text).toContain("not watching ('crewhaus watchme start' to begin)");
    expect(text).toContain("watermark   none (no analysis yet)");
    expect(text).toContain("last report never");
    expect(text).toContain("windows     none consumed");
    expect(text).toContain("1 registered harness");
    expect(text).not.toContain("harnesses");
  });
});

describe("resolveWatchmeEnv re-export", () => {
  test("is the run-observability resolver (spec/state turn it on, ambient wins)", () => {
    expect(resolveWatchmeEnv(true, false, undefined)).toBe("1");
    expect(resolveWatchmeEnv(undefined, true, undefined)).toBe("1");
    expect(resolveWatchmeEnv(true, true, "0")).toBeUndefined();
    expect(resolveWatchmeEnv(false, false, undefined)).toBeUndefined();
  });
});
