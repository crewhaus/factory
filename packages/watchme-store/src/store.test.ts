import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWatchmeStore } from "./store";
import type { WatchmeJudgment, WatchmeObservation } from "./types";

const TMP_ROOTS: string[] = [];
function newRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-watchme-store-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

function obsFixture(overrides: Partial<WatchmeObservation> = {}): WatchmeObservation {
  return {
    v: 1,
    sessionId: "sess_0123456789abcdef",
    specName: "helpdesk",
    target: "cli",
    ts: 1_700_000_000_000,
    turnCount: 3,
    joinConfidence: "exact",
    models: [
      {
        wire: "claude-haiku-4-5",
        provider: "anthropic",
        turns: 3,
        usage: { in: 900, out: 300, cacheRead: 0, cacheCreate: 0 },
        costUsdMicros: 1200,
      },
    ],
    toolStats: [{ name: "fs_read", calls: 4, errors: 1 }],
    intentKeys: ["billing-refund"],
    ...overrides,
  };
}

function judgmentFixture(overrides: Partial<WatchmeJudgment> = {}): WatchmeJudgment {
  return {
    v: 1,
    sessionId: "sess_0123456789abcdef",
    turnNumber: 2,
    model: "claude-haiku-4-5",
    judgeModel: "claude-haiku-4-5",
    score: 0.8,
    rationale: "grounded and complete",
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

describe("watchme store — observations append/read", () => {
  test("appends land one 0600 JSON line each and read back in order", () => {
    const store = openWatchmeStore(newRoot(), { specName: "helpdesk" });
    store.appendObservation(obsFixture({ sessionId: "sess_a000000000000000" }));
    store.appendObservation(obsFixture({ sessionId: "sess_b000000000000000", turnCount: 5 }));
    const path = join(store.dir, "observations.jsonl");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim().split("\n").length).toBe(2);
    const read = store.readObservations();
    expect(read.map((o) => o.sessionId)).toEqual([
      "sess_a000000000000000",
      "sess_b000000000000000",
    ]);
    expect(read[1]?.turnCount).toBe(5);
  });

  test("torn and garbage lines are skipped, not fatal", () => {
    const root = newRoot();
    const store = openWatchmeStore(root, { specName: "helpdesk" });
    store.appendObservation(obsFixture());
    const path = join(store.dir, "observations.jsonl");
    appendFileSync(path, "not json at all\n", "utf8");
    appendFileSync(path, '{"v":1,"sessionId":"sess_torn","specName":"helpdesk","turnCo', "utf8");
    expect(openWatchmeStore(root).readObservations().length).toBe(1);
  });

  test("concurrent handles on the same store never lose each other's appends (O_APPEND)", () => {
    const root = newRoot();
    const a = openWatchmeStore(root, { specName: "helpdesk" });
    const b = openWatchmeStore(root, { specName: "helpdesk" });
    for (let i = 0; i < 20; i += 1) {
      a.appendObservation(obsFixture({ sessionId: `sess_a${String(i).padStart(15, "0")}` }));
      b.appendObservation(obsFixture({ sessionId: `sess_b${String(i).padStart(15, "0")}` }));
    }
    const ids = new Set(a.readObservations().map((o) => o.sessionId));
    expect(ids.size).toBe(40);
  });
});

describe("watchme store — state + watermark", () => {
  test("default state before any write; patches persist across reopen (tmp+rename, 0600)", () => {
    const root = newRoot();
    const store = openWatchmeStore(root, { specName: "helpdesk" });
    expect(store.state()).toEqual({
      schemaVersion: 1,
      watching: false,
      watermark: { lastMtimeMs: 0 },
      windows: {},
    });
    store.setState({
      watching: true,
      startedAt: 42,
      watermark: { lastMtimeMs: 111, lastSessionId: "sess_a000000000000000" },
    });
    store.setState({ windows: { "watchme:helpdesk:5": "ok" } });
    const reopened = openWatchmeStore(root).state();
    expect(reopened.watching).toBe(true);
    expect(reopened.startedAt).toBe(42);
    expect(reopened.watermark).toEqual({
      lastMtimeMs: 111,
      lastSessionId: "sess_a000000000000000",
    });
    expect(reopened.windows["watchme:helpdesk:5"]).toBe("ok");
    expect(statSync(join(store.dir, "state.json")).mode & 0o777).toBe(0o600);
  });

  test("a torn state.json reads as the default rather than wedging", () => {
    const root = newRoot();
    const store = openWatchmeStore(root, { specName: "helpdesk" });
    store.setState({ watching: true });
    writeFileSync(join(store.dir, "state.json"), '{"schemaVersion":1,"watchi', "utf8");
    expect(store.state().watching).toBe(false);
  });
});

describe("watchme store — windowKey math", () => {
  test("epoch-anchored flooring with the spec name in the key", () => {
    const store = openWatchmeStore(newRoot(), { specName: "helpdesk" });
    const hour = 3_600_000;
    expect(store.windowKey(5 * hour + 3, hour)).toBe("watchme:helpdesk:5");
    expect(store.windowKey(6 * hour, hour)).toBe("watchme:helpdesk:6");
    expect(store.windowKey(6 * hour - 1, hour)).toBe("watchme:helpdesk:5");
  });

  test("without a specName the harness dir basename stands in", () => {
    const root = join(newRoot(), "my-harness", ".crewhaus");
    mkdirSync(root, { recursive: true });
    expect(openWatchmeStore(root).windowKey(1, 10)).toBe("watchme:my-harness:0");
  });
});

describe("watchme store — Welford compaction", () => {
  test("compact() folds raw digests into one aggregate per key with hand-computed stats", () => {
    const root = newRoot();
    const store = openWatchmeStore(root, { specName: "helpdesk" });
    store.appendObservation(
      obsFixture({ turnCount: 3, quality: { ratings: 2, meanRating: 0.5, judged: 0 } }),
    );
    store.appendObservation(
      obsFixture({ turnCount: 5, quality: { ratings: 0, judged: 2, meanJudge: 0.9 } }),
    );
    store.appendObservation(obsFixture({ turnCount: 10 }));
    store.compact();

    expect(store.readObservations()).toEqual([]);
    const aggs = openWatchmeStore(root).readAggregates();
    expect(aggs.length).toBe(1);
    const agg = aggs[0];
    expect(agg?.key).toBe("helpdesk|cli");
    expect(agg?.n).toBe(3);
    expect(agg?.meanTurns).toBeCloseTo(6, 9); // mean of {3, 5, 10}
    expect(agg?.m2Turns).toBeCloseTo(26, 9); // sum of squared deviations
    expect(agg?.qualityN).toBe(2); // third digest carried no quality
    expect(agg?.meanQuality).toBeCloseTo(0.7, 9); // mean of {0.5, 0.9}
    expect(agg?.m2Quality).toBeCloseTo(0.08, 9);
    expect(agg?.tokensIn).toBe(2700);
    expect(agg?.tokensOut).toBe(900);
    expect(agg?.costUsdMicros).toBe(3600);
    expect(agg?.toolCalls).toBe(12);
    expect(agg?.toolErrors).toBe(3);
    expect(agg?.intents).toEqual({ "billing-refund": 3 });
  });

  test("aggregate lines parallel-combine with later digests on the next compact", () => {
    const root = newRoot();
    const store = openWatchmeStore(root, { specName: "helpdesk" });
    store.appendObservation(
      obsFixture({ turnCount: 3, quality: { ratings: 2, meanRating: 0.5, judged: 0 } }),
    );
    store.appendObservation(
      obsFixture({ turnCount: 5, quality: { ratings: 0, judged: 2, meanJudge: 0.9 } }),
    );
    store.appendObservation(obsFixture({ turnCount: 10 }));
    store.compact();
    store.appendObservation(
      obsFixture({ turnCount: 2, quality: { ratings: 1, meanRating: 1.0, judged: 0 } }),
    );
    store.compact();

    const agg = store.readAggregates()[0];
    expect(agg?.n).toBe(4);
    expect(agg?.meanTurns).toBeCloseTo(5, 9); // mean of {3, 5, 10, 2}
    expect(agg?.m2Turns).toBeCloseTo(38, 9);
    expect(agg?.qualityN).toBe(3);
    expect(agg?.meanQuality).toBeCloseTo(0.8, 9); // mean of {0.5, 0.9, 1.0}
    expect(agg?.intents).toEqual({ "billing-refund": 4 });
  });

  test("distinct (specName, target) pairs compact to separate keys, sorted", () => {
    const store = openWatchmeStore(newRoot(), { specName: "helpdesk" });
    store.appendObservation(obsFixture({ specName: "helpdesk", target: "cli" }));
    store.appendObservation(obsFixture({ specName: "concierge", target: "channel" }));
    store.compact();
    expect(store.readAggregates().map((a) => a.key)).toEqual(["concierge|channel", "helpdesk|cli"]);
  });
});

describe("watchme store — judgments round-trip", () => {
  test("appends read back intact; garbage lines are skipped", () => {
    const root = newRoot();
    const store = openWatchmeStore(root, { specName: "helpdesk" });
    store.appendJudgment(judgmentFixture({ turnNumber: 1, score: 0.4 }));
    store.appendJudgment(judgmentFixture({ turnNumber: 2, score: 0.9 }));
    appendFileSync(join(store.dir, "judgments.jsonl"), '{"v":1,"sessionId":"sess_to', "utf8");
    const read = openWatchmeStore(root).readJudgments();
    expect(read.length).toBe(2);
    expect(read[0]).toMatchObject({ turnNumber: 1, score: 0.4, model: "claude-haiku-4-5" });
    expect(read[1]?.rationale).toBe("grounded and complete");
    expect(statSync(join(store.dir, "judgments.jsonl")).mode & 0o777).toBe(0o600);
  });
});

describe("watchme store — run.lock", () => {
  test("second acquire loses; release makes the lock acquirable again", () => {
    const store = openWatchmeStore(newRoot(), { specName: "helpdesk" });
    const release = store.acquireLock();
    expect(release).toBeDefined();
    expect(store.acquireLock()).toBeUndefined();
    expect(openWatchmeStore(store.dir.replace(/\/watchme$/, "")).acquireLock()).toBeUndefined();
    release?.();
    const again = store.acquireLock();
    expect(again).toBeDefined();
    again?.();
  });

  test("a lock idle past the model-phase stale window is stolen", () => {
    const store = openWatchmeStore(newRoot(), { specName: "helpdesk" });
    const held = store.acquireLock();
    expect(held).toBeDefined();
    const lockPath = join(store.dir, "run.lock");
    // Past the 15-minute stale window (the holder crashed without releasing).
    const past = (Date.now() - 16 * 60_000) / 1000;
    utimesSync(lockPath, past, past);
    const stolen = store.acquireLock();
    expect(stolen).toBeDefined();
    stolen?.();
  });

  test("a lock held minutes (a long report) is NOT stolen", () => {
    const store = openWatchmeStore(newRoot(), { specName: "helpdesk" });
    const held = store.acquireLock();
    expect(held).toBeDefined();
    const lockPath = join(store.dir, "run.lock");
    // A multi-minute-old lock is within the model-phase window: a concurrent
    // acquire must lose, not steal (the confirmed double-judge-spend bug).
    const recent = (Date.now() - 90_000) / 1000;
    utimesSync(lockPath, recent, recent);
    expect(store.acquireLock()).toBeUndefined();
    held?.();
  });
});
