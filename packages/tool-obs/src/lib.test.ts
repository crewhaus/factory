/**
 * The pure logic, tested without a filesystem or a socket.
 *
 * Everything here is a function over values: a log's TEXT rather than a file,
 * an array of events rather than a directory, a parsed response body rather
 * than a `Response`. That is deliberate — the arithmetic and the parsing are
 * where the bugs that matter live, and they should not need a server to catch.
 */
import { describe, expect, test } from "bun:test";
import { budgetCheck } from "./lib/budget";
import { costReport, priceTokens, utcDay } from "./lib/cost";
import { countEvents, nearestRankPercentile, toolCallStats } from "./lib/counts";
import {
  type ObsEvent,
  compareEvents,
  decodeCursor,
  encodeCursor,
  filterEvents,
  matchesPredicate,
  pageEvents,
  parseLog,
  readPath,
  renderEvent,
  runIdOf,
} from "./lib/events";
import { clusterErrors, errorText, fingerprint } from "./lib/fingerprint";
import { parseJsonBody, pluck, seriesKey, shapeMetrics, shapeRecords } from "./lib/remote";
import { evaluateSlo } from "./lib/slo";
import { buildTimeline } from "./lib/timeline";
import { _setDnsLookup, assertNotSsrf, canonicalizeOrigin, isPrivateIp } from "./net";

/** One JSONL line, as `@crewhaus/event-log` writes it. */
function line(kind: string, ts: number, payload: unknown): string {
  return JSON.stringify({ ts, version: 1, kind, payload });
}

function ev(kind: string, ts: number, payload: unknown, line = 1, session = "sess_a"): ObsEvent {
  return { session, line, kind, ts, payload };
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

describe("parseLog", () => {
  test("reads one event per line with its timestamp, kind and payload", () => {
    const text = `${line("tool_use", 100, { name: "Read" })}\n${line("tool_result", 150, { isError: false })}\n`;
    const parsed = parseLog("sess_a", text);
    expect(parsed.events.length).toBe(2);
    expect(parsed.events[0]).toEqual({
      session: "sess_a",
      line: 1,
      kind: "tool_use",
      ts: 100,
      payload: { name: "Read" },
    });
    expect(parsed.malformedLines).toBe(0);
  });

  test("a flat line with no payload envelope falls back to the object itself", () => {
    const parsed = parseLog(
      "sess_a",
      `${JSON.stringify({ ts: 1, kind: "tool_use", name: "Read" })}\n`,
    );
    expect(readPath(parsed.events[0]?.payload, "name")).toBe("Read");
  });

  test("a half-written last line is counted, not thrown — that is the normal case mid-incident", () => {
    const parsed = parseLog("sess_a", `${line("error", 1, { message: "x" })}\n{"ts":2,"kind":"err`);
    expect(parsed.events.length).toBe(1);
    expect(parsed.malformedLines).toBe(1);
  });

  test("JSON without a string kind is malformed, not an event", () => {
    const parsed = parseLog("sess_a", '{"ts":1}\n[1,2,3]\n"text"\n');
    expect(parsed.events.length).toBe(0);
    expect(parsed.malformedLines).toBe(3);
  });

  test("blank lines are skipped without counting as malformed", () => {
    const parsed = parseLog("sess_a", `\n\n${line("error", 1, {})}\n\n`);
    expect(parsed.events.length).toBe(1);
    expect(parsed.malformedLines).toBe(0);
  });

  test("line numbers are 1-based and survive blank and malformed lines", () => {
    const parsed = parseLog("sess_a", `\nnot json\n${line("error", 1, {})}\n`);
    expect(parsed.events[0]?.line).toBe(3);
  });

  test("the event cap stops the parse and says so", () => {
    const text = Array.from({ length: 10 }, (_, i) => line("error", i, { i })).join("\n");
    const parsed = parseLog("sess_a", text, 4);
    expect(parsed.events.length).toBe(4);
    expect(parsed.truncated).toBe(true);
  });

  test("an unknown kind is kept verbatim rather than dropped", () => {
    const parsed = parseLog("sess_a", `${line("kind_from_the_future", 1, { a: 1 })}\n`);
    expect(parsed.events[0]?.kind).toBe("kind_from_the_future");
  });
});

// ---------------------------------------------------------------------------
// filtering and paging
// ---------------------------------------------------------------------------

describe("readPath", () => {
  test("walks objects and array indices", () => {
    expect(readPath({ a: { b: [{ c: 7 }] } }, "a.b.0.c")).toBe(7);
  });

  test("a missing segment yields undefined rather than throwing", () => {
    expect(readPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(readPath(null, "a")).toBeUndefined();
  });

  test("a non-numeric segment into an array does not index it", () => {
    expect(readPath({ a: [1, 2] }, "a.length")).toBeUndefined();
  });
});

describe("matchesPredicate", () => {
  const payload = { toolName: "Read", durationMs: 120, nested: { ok: true } };

  test("eq compares as text so 120 and '120' agree", () => {
    expect(matchesPredicate(payload, { path: "durationMs", op: "eq", value: 120 })).toBe(true);
    expect(matchesPredicate(payload, { path: "durationMs", op: "eq", value: "120" })).toBe(true);
  });

  test("contains and startsWith work on strings", () => {
    expect(matchesPredicate(payload, { path: "toolName", op: "contains", value: "ea" })).toBe(true);
    expect(matchesPredicate(payload, { path: "toolName", op: "startsWith", value: "Re" })).toBe(
      true,
    );
  });

  test("exists and missing distinguish a present field from an absent one", () => {
    expect(matchesPredicate(payload, { path: "nested.ok", op: "exists" })).toBe(true);
    expect(matchesPredicate(payload, { path: "nested.no", op: "missing" })).toBe(true);
  });

  test("the ordering ops are numeric and refuse a non-numeric side rather than comparing text", () => {
    expect(matchesPredicate(payload, { path: "durationMs", op: "gt", value: 100 })).toBe(true);
    expect(matchesPredicate(payload, { path: "durationMs", op: "lte", value: 100 })).toBe(false);
    // The trap this avoids: "2026-01-02" > "2026-01-10" is true as text.
    expect(matchesPredicate({ d: "2026-01-02" }, { path: "d", op: "gt", value: 1 })).toBe(false);
  });
});

describe("filterEvents", () => {
  const events: ObsEvent[] = [
    ev("tool_use", 100, { name: "Read", runId: "run_1" }, 1),
    ev("error", 200, { message: "boom", runId: "run_1" }, 2),
    ev("tool_use", 300, { name: "Write", runId: "run_2" }, 3),
    { session: "sess_a", line: 4, kind: "note", payload: {} },
  ];

  test("kinds, time bounds, runId and a predicate all narrow", () => {
    expect(filterEvents(events, { kinds: ["tool_use"] }).length).toBe(2);
    expect(filterEvents(events, { sinceTs: 200, untilTs: 300 }).length).toBe(2);
    expect(filterEvents(events, { runId: "run_1" }).length).toBe(2);
    expect(
      filterEvents(events, { predicate: { path: "name", op: "eq", value: "Write" } }).length,
    ).toBe(1);
  });

  test("an event with no timestamp never satisfies a time bound", () => {
    expect(filterEvents(events, { sinceTs: 0 }).map((e) => e.line)).toEqual([1, 2, 3]);
  });

  test("runIdOf accepts both spellings the runtime's records use", () => {
    expect(runIdOf(ev("x", 1, { runId: "a" }))).toBe("a");
    expect(runIdOf(ev("x", 1, { run_id: "b" }))).toBe("b");
    expect(runIdOf(ev("x", 1, {}))).toBeUndefined();
  });
});

describe("paging", () => {
  const events: ObsEvent[] = [
    ev("a", 1, {}, 1, "sess_a"),
    ev("a", 2, {}, 2, "sess_a"),
    ev("a", 3, {}, 1, "sess_b"),
    ev("a", 4, {}, 2, "sess_b"),
  ].sort(compareEvents);

  test("the canonical order is session then line", () => {
    expect(events.map((e) => `${e.session}#${e.line}`)).toEqual([
      "sess_a#1",
      "sess_a#2",
      "sess_b#1",
      "sess_b#2",
    ]);
  });

  test("a cursor resumes strictly after the last event returned", () => {
    const first = pageEvents(events, 2);
    expect(first.events.map((e) => e.line)).toEqual([1, 2]);
    expect(first.nextCursor).toBe("sess_a#2");
    const second = pageEvents(events, 2, first.nextCursor);
    expect(second.events.map((e) => `${e.session}#${e.line}`)).toEqual(["sess_b#1", "sess_b#2"]);
    // A cursor still comes back on the last page: the log is appended to while
    // it is read, so `remaining` is what says there is nothing waiting NOW.
    expect(second.nextCursor).toBe("sess_b#2");
    expect(second.remaining).toBe(2);
  });

  test("an empty page carries no cursor, because there is no position to resume from", () => {
    const page = pageEvents(events, 2, "sess_z#1");
    expect(page.events.length).toBe(0);
    expect(page.nextCursor).toBeUndefined();
    expect(page.remaining).toBe(0);
  });

  test("the two pages together are the whole list, with nothing repeated", () => {
    const first = pageEvents(events, 3);
    const second = pageEvents(events, 3, first.nextCursor);
    const seen = [...first.events, ...second.events].map(encodeCursor);
    expect(seen).toEqual(events.map(encodeCursor));
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("an appended event is picked up by the next page and does not shift the first", () => {
    const grown = [...events, ev("a", 5, {}, 3, "sess_b")].sort(compareEvents);
    const first = pageEvents(events, 4);
    const second = pageEvents(grown, 4, first.nextCursor);
    expect(second.events.map((e) => e.line)).toEqual([3]);
  });

  test("a cursor that is not one this tool wrote is ignored rather than crashing", () => {
    expect(decodeCursor("nonsense")).toBeUndefined();
    expect(decodeCursor("sess_a#x")).toBeUndefined();
    expect(pageEvents(events, 2, "nonsense").events.length).toBe(2);
  });

  test("a session id containing a hash still round-trips, because the split is on the LAST one", () => {
    const odd = ev("a", 1, {}, 9, "weird#name");
    expect(decodeCursor(encodeCursor(odd))).toEqual({ session: "weird#name", line: 9 });
  });
});

describe("renderEvent", () => {
  test("a payload over budget is cut and flagged", () => {
    const rendered = renderEvent(ev("error", 1, { message: "x".repeat(400) }), 50);
    expect((rendered["payload"] as string).length).toBe(51);
    expect(rendered["payloadTruncated"]).toBe(true);
  });

  test("a payload under budget is neither cut nor flagged", () => {
    const rendered = renderEvent(ev("error", 1, { a: 1 }), 500);
    expect(rendered["payload"]).toBe('{"a":1}');
    expect(rendered["payloadTruncated"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// counting
// ---------------------------------------------------------------------------

describe("countEvents", () => {
  const events: ObsEvent[] = [
    ev("tool_use", 1, { name: "Read", id: "tu_1" }, 1),
    ev("tool_result", 2, { toolUseId: "tu_1", isError: false }, 2),
    ev("tool_stats", 3, { toolName: "Read", durationMs: 40, isError: false }, 3),
    ev("tool_use", 4, { name: "Read", id: "tu_2" }, 4),
    ev("tool_result", 5, { toolUseId: "tu_2", isError: true }, 5),
    ev("tool_stats", 6, { toolName: "Read", durationMs: 90, isError: true }, 6),
    ev("error", 7, { message: "boom" }, 7),
    ev("run_failed", 8, { class: "provider", message: "out of funds" }, 8),
    ev("model_meta", 9, { stopReason: "end_turn", model: "m" }, 9),
  ];

  test("a call is a tool_use line and the tool_stats mirror does not double it", () => {
    const counts = countEvents(events);
    expect(counts.byTool).toEqual([{ name: "Read", calls: 2, errors: 1, totalDurationMs: 130 }]);
  });

  test("with no tool_use lines the tool_stats mirror is the only evidence and is counted", () => {
    const counts = countEvents(events.filter((e) => e.kind !== "tool_use"));
    expect(counts.byTool[0]).toEqual({ name: "Read", calls: 2, errors: 1, totalDurationMs: 130 });
  });

  test("with neither mirror, errors are recovered by joining tool_result back to tool_use", () => {
    const counts = countEvents(events.filter((e) => e.kind !== "tool_stats"));
    expect(counts.byTool[0]).toEqual({ name: "Read", calls: 2, errors: 1 });
  });

  test("outcomes separate recoverable errors from the one failure a run died with", () => {
    const counts = countEvents(events);
    expect(counts.outcomes.errors).toBe(1);
    expect(counts.outcomes.runsFailed).toBe(1);
    expect(counts.outcomes.toolOk).toBe(1);
    expect(counts.outcomes.toolErrors).toBe(1);
    expect(counts.outcomes.stopReasons).toEqual([{ kind: "end_turn", count: 1 }]);
  });

  test("MCP tools are a separate namespace, never merged with the built-in of the same name", () => {
    const counts = countEvents([
      ...events,
      ev("mcp_stats", 10, { server: "srv", toolName: "Read", durationMs: 5, isError: false }, 10),
    ]);
    expect(counts.byTool.map((t) => t.name)).toEqual(["Read"]);
    expect(counts.byMcpTool.map((t) => t.name)).toEqual(["srv/Read"]);
  });

  test("byKind is a total order: count descending, then kind ascending", () => {
    const counts = countEvents([
      ev("b", 1, {}, 1),
      ev("a", 2, {}, 2),
      ev("c", 3, {}, 3),
      ev("c", 4, {}, 4),
    ]);
    expect(counts.byKind).toEqual([
      { kind: "c", count: 2 },
      { kind: "a", count: 1 },
      { kind: "b", count: 1 },
    ]);
  });

  test("first and last timestamps come from the events, never from a clock", () => {
    const counts = countEvents(events);
    expect(counts.firstTs).toBe(1);
    expect(counts.lastTs).toBe(9);
  });
});

describe("nearestRankPercentile", () => {
  test("returns an observed value, never an interpolated one", () => {
    const sample = [10, 20, 30, 40];
    expect(nearestRankPercentile(sample, 50)).toBe(20);
    expect(nearestRankPercentile(sample, 95)).toBe(40);
    expect(nearestRankPercentile(sample, 100)).toBe(40);
  });

  test("with one sample every percentile is that sample", () => {
    expect(nearestRankPercentile([7], 95)).toBe(7);
    expect(nearestRankPercentile([7], 1)).toBe(7);
  });

  test("an empty sample has no percentile", () => {
    expect(nearestRankPercentile([], 95)).toBeUndefined();
  });

  test("the documented formula is exactly ceil(p/100 * n) - 1", () => {
    const sample = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(nearestRankPercentile(sample, 95)).toBe(19); // ceil(19) - 1 = index 18 → value 19
  });
});

describe("toolCallStats", () => {
  const events: ObsEvent[] = [
    ...Array.from({ length: 4 }, (_, i) => ev("tool_use", i, { name: "Slow", id: `s${i}` }, i + 1)),
    ...Array.from({ length: 4 }, (_, i) =>
      ev(
        "tool_stats",
        i,
        { toolName: "Slow", durationMs: (i + 1) * 100, isError: i === 3 },
        i + 10,
      ),
    ),
    ev("tool_use", 20, { name: "Fast", id: "f0" }, 20),
    ev("tool_stats", 21, { toolName: "Fast", durationMs: 5, isError: false }, 21),
  ];

  test("mean, p50, p95 and max are reported per tool with the method named", () => {
    const stats = toolCallStats(events);
    expect(stats.percentileMethod).toBe("nearest-rank");
    const slow = stats.tools.find((t) => t.name === "Slow");
    expect(slow).toEqual({
      name: "Slow",
      calls: 4,
      errors: 1,
      errorRate: 0.25,
      timedCalls: 4,
      meanMs: 250,
      p50Ms: 200,
      p95Ms: 400,
      maxMs: 400,
      totalDurationMs: 1000,
    });
  });

  test("the failing tool sorts first, so the caller does not re-sort", () => {
    expect(toolCallStats(events).tools[0]?.name).toBe("Slow");
  });

  test("a log with no stats mirror reports counts and says latency is unavailable", () => {
    const stats = toolCallStats(events.filter((e) => e.kind === "tool_use"));
    expect(stats.latencyUnavailable).toBe(true);
    expect(stats.tools.find((t) => t.name === "Slow")?.p95Ms).toBeUndefined();
    expect(stats.tools.find((t) => t.name === "Slow")?.calls).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// error clustering
// ---------------------------------------------------------------------------

describe("fingerprint", () => {
  test("ids, numbers, paths, uuids, hex and quoted strings are masked", () => {
    const a = fingerprint('run sess_a1b2c3d4e5f6 failed after 12 tries at /tmp/x/y.json: "abc"');
    const b = fingerprint('run sess_9f8e7d6c5b4a failed after 3 tries at /var/z/q.json: "def"');
    expect(a).toBe(b);
  });

  test("a uuid is masked whole rather than shredded into per-uuid fingerprints", () => {
    const a = fingerprint("no route for 123e4567-e89b-12d3-a456-426614174000");
    const b = fingerprint("no route for 00000000-1111-2222-3333-444444444444");
    expect(a).toBe(b);
    expect(a).toContain("<uuid>");
  });

  test("a URL is masked before its digits are, so two URLs group", () => {
    const a = fingerprint("GET https://a.example.com/v1/items/42 failed");
    const b = fingerprint("GET https://b.example.com/v2/things/9 failed");
    expect(a).toBe(b);
    expect(a).toBe("GET <url> failed");
  });

  test("an ISO timestamp survives as one token rather than a pile of numbers", () => {
    expect(fingerprint("at 2026-09-17T10:00:00.123Z the lock expired")).toBe(
      "at <ts> the lock expired",
    );
  });

  test("genuinely different messages stay in different groups", () => {
    expect(fingerprint("connection refused")).not.toBe(fingerprint("permission denied"));
  });

  test("the same message wrapped across lines fingerprints identically", () => {
    expect(fingerprint("a\n  b")).toBe(fingerprint("a b"));
  });

  test("an id keeps its namespace prefix, so two namespaces do not collapse", () => {
    expect(fingerprint("sess_aaaaaaaa gone")).not.toBe(fingerprint("run_aaaaaaaa gone"));
  });
});

describe("clusterErrors", () => {
  const events: ObsEvent[] = [
    ev("error", 10, { message: "timeout after 5s calling /a/b" }, 1),
    ev("error", 20, { message: "timeout after 9s calling /c/d" }, 2),
    ev("error", 30, { message: "timeout after 1s calling /e/f" }, 3),
    ev("run_failed", 40, { class: "billing", message: "out of credit" }, 4),
    ev("tool_result", 50, { isError: true, message: "tool blew up" }, 5),
  ];

  test("a thousand variations become the handful of distinct problems", () => {
    const clustered = clusterErrors(events);
    expect(clustered.errors).toBe(4);
    expect(clustered.groups.length).toBe(2);
    expect(clustered.groups[0]?.count).toBe(3);
  });

  test("the example is the FIRST occurrence, so it does not move as the log grows", () => {
    expect(clusterErrors(events).groups[0]?.example).toBe("timeout after 5s calling /a/b");
    expect(clusterErrors(events).groups[0]?.exampleLine).toBe(1);
  });

  test("first and last timestamps bracket each group", () => {
    const group = clusterErrors(events).groups[0];
    expect(group?.firstTs).toBe(10);
    expect(group?.lastTs).toBe(30);
  });

  test("tool_result errors are excluded by default and included on request", () => {
    expect(clusterErrors(events).errors).toBe(4);
    expect(clusterErrors(events, 20, true).errors).toBe(5);
  });

  test("groups beyond the cap are counted, not silently dropped", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      ev("error", i, { message: `distinct ${"x".repeat(i)}` }, i),
    );
    const clustered = clusterErrors(many, 3);
    expect(clustered.groups.length).toBe(3);
    expect(clustered.groupsOmitted).toBe(5);
  });

  test("errorText caps a stack trace so one error is not the whole report", () => {
    expect(errorText({ message: "y".repeat(1000) }).length).toBe(301);
  });
});

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

describe("buildTimeline", () => {
  const events: ObsEvent[] = [
    ev("user_message", 1000, {}, 1),
    ev("tool_use", 1500, { name: "Read" }, 2),
    ev("tool_stats", 1900, { toolName: "Read", durationMs: 380, isError: false }, 3),
    { session: "sess_a", line: 4, kind: "toolset", payload: { toolNames: [] } },
    ev("assistant_message", 2400, {}, 5),
  ];

  test("each entry carries the gap before it and its offset from the start", () => {
    const timeline = buildTimeline(events);
    expect(timeline.entries[1]).toMatchObject({ kind: "tool_use", gapMs: 500, offsetMs: 500 });
    expect(timeline.entries[2]).toMatchObject({ gapMs: 400, offsetMs: 900, durationMs: 380 });
  });

  test("elapsed is first to last timestamp, from the events and not a clock", () => {
    const timeline = buildTimeline(events);
    expect(timeline.startTs).toBe(1000);
    expect(timeline.endTs).toBe(2400);
    expect(timeline.elapsedMs).toBe(1400);
  });

  test("an untimestamped event keeps its place and is given no gap at all", () => {
    const entry = buildTimeline(events).entries[3];
    expect(entry?.kind).toBe("toolset");
    expect(entry?.ts).toBeUndefined();
    expect(entry?.gapMs).toBeUndefined();
  });

  test("an untimestamped event does not break the gap of the one after it", () => {
    // 2400 - 1900 = 500, measured against the last TIMESTAMPED event.
    expect(buildTimeline(events).entries[4]?.gapMs).toBe(500);
  });

  test("measured time is only what the runtime measured, and is labelled as such", () => {
    expect(buildTimeline(events).measuredByKind).toEqual([
      { kind: "tool_stats", count: 1, totalMs: 380 },
    ]);
  });

  test("the entry cap truncates and says so", () => {
    const timeline = buildTimeline(events, 2);
    expect(timeline.entries.length).toBe(2);
    expect(timeline.truncated).toBe(true);
    expect(timeline.events).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// cost
// ---------------------------------------------------------------------------

describe("priceTokens", () => {
  test("tokens times USD-per-million is already micro-USD, with no division", () => {
    expect(
      priceTokens(
        { inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 0, cacheCreationTokens: 0 },
        { model: "m", inputPerMillionUsd: 3 },
      ),
    ).toBe(3_000_000);
  });

  test("a cache read falls back to the input rate — discounted, not free", () => {
    const priced = priceTokens(
      { inputTokens: 0, outputTokens: 0, cachedReadTokens: 1_000_000, cacheCreationTokens: 0 },
      { model: "m", inputPerMillionUsd: 3 },
    );
    expect(priced).toBe(3_000_000);
  });

  test("an explicit cache rate wins over the fallback", () => {
    const priced = priceTokens(
      { inputTokens: 0, outputTokens: 0, cachedReadTokens: 1_000_000, cacheCreationTokens: 0 },
      { model: "m", inputPerMillionUsd: 3, cachedReadPerMillionUsd: 0.3 },
    );
    expect(priced).toBe(300_000);
  });

  test("no rate row prices at zero, which is why the caller is told which models had none", () => {
    expect(
      priceTokens(
        { inputTokens: 5, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 },
        undefined,
      ),
    ).toBe(0);
  });
});

describe("costReport", () => {
  const day1 = Date.UTC(2026, 8, 16, 12);
  const day2 = Date.UTC(2026, 8, 17, 12);
  const events: ObsEvent[] = [
    ev(
      "cost_accrual",
      day1,
      {
        modelId: "claude-a",
        runId: "run_1",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cachedReadTokens: 0,
        cacheCreationTokens: 0,
        costUsdMicros: 100,
      },
      1,
    ),
    ev(
      "cost_accrual",
      day2,
      {
        modelId: "claude-b",
        runId: "run_2",
        inputTokens: 2_000_000,
        outputTokens: 0,
        cachedReadTokens: 0,
        cacheCreationTokens: 0,
        costUsdMicros: 0,
        unpriced: true,
      },
      2,
    ),
    ev(
      "cost_accrual",
      day2,
      { modelId: "claude-a", runId: "run_1", summary: true, costUsdMicros: 999 },
      3,
    ),
  ];
  const rates = [{ model: "claude-a", inputPerMillionUsd: 3, outputPerMillionUsd: 15 }];

  test("the runner's terminal roll-up is skipped so a run total is never counted twice", () => {
    expect(costReport(events, rates).accruals).toBe(2);
    expect(costReport(events, rates).totals.recordedUsdMicros).toBe(100);
  });

  test("recorded and recomputed costs come back side by side", () => {
    const report = costReport(events, rates);
    const a = report.byModel.find((b) => b.key === "claude-a");
    expect(a?.recordedUsdMicros).toBe(100);
    expect(a?.computedUsdMicros).toBe(1_000_000 * 3 + 500_000 * 15);
  });

  test("a model with no rate row is named rather than silently priced at zero", () => {
    const report = costReport(events, rates);
    expect(report.modelsWithoutRate).toEqual(["claude-b"]);
    expect(report.unratedAccruals).toBe(1);
    expect(report.byModel.find((b) => b.key === "claude-b")?.inputTokens).toBe(2_000_000);
  });

  test("an accrual the runtime itself could not price is counted separately", () => {
    expect(costReport(events, rates).unpricedAccruals).toBe(1);
  });

  test("the three breakdowns each total the same tokens", () => {
    const report = costReport(events, rates);
    const sum = (rows: readonly { inputTokens: number }[]): number =>
      rows.reduce((acc, r) => acc + r.inputTokens, 0);
    expect(sum(report.byModel)).toBe(report.totals.inputTokens);
    expect(sum(report.byDay)).toBe(report.totals.inputTokens);
    expect(sum(report.byRun)).toBe(report.totals.inputTokens);
  });

  test("days are UTC calendar days, and a line with no timestamp lands in 'unknown'", () => {
    expect(costReport(events, rates).byDay.map((d) => d.key)).toEqual(["2026-09-16", "2026-09-17"]);
    expect(utcDay(undefined)).toBe("unknown");
  });

  test("every listing is sorted, so the same log returns the same bytes", () => {
    expect(JSON.stringify(costReport(events, rates))).toBe(
      JSON.stringify(costReport(events, rates)),
    );
  });
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

describe("budgetCheck", () => {
  test("remaining, used and the crossed thresholds", () => {
    const result = budgetCheck(800_000, 1_000_000, [
      { percent: 50, label: "notice" },
      { percent: 80, label: "warn" },
      { percent: 100, label: "stop" },
    ]);
    expect(result.remainingUsdMicros).toBe(200_000);
    expect(result.usedPercent).toBe(80);
    expect(result.highestCrossed?.label).toBe("warn");
    expect(result.exhausted).toBe(false);
  });

  test("a threshold is crossed AT its limit, not strictly above it", () => {
    const result = budgetCheck(500_000, 1_000_000, [{ percent: 50 }]);
    expect(result.thresholds[0]?.crossed).toBe(true);
    expect(result.thresholds[0]?.headroomUsdMicros).toBe(0);
  });

  test("an overspend is reported as overUsdMicros, never as negative remaining", () => {
    const result = budgetCheck(1_500_000, 1_000_000);
    expect(result.remainingUsdMicros).toBe(0);
    expect(result.overUsdMicros).toBe(500_000);
    expect(result.exhausted).toBe(true);
  });

  test("a zero budget is exhausted the moment anything is spent, and does not divide by zero", () => {
    const result = budgetCheck(1, 0);
    expect(result.exhausted).toBe(true);
    expect(Number.isFinite(result.usedBasisPoints)).toBe(false);
    // Infinity serialises as null: a missing number, not a fabricated one.
    expect(JSON.parse(JSON.stringify(result))["usedBasisPoints"]).toBeNull();
  });

  test("a zero budget with zero spend is not yet exhausted", () => {
    expect(budgetCheck(0, 0).exhausted).toBe(false);
  });

  test("a projection appears only when the caller states the elapsed fraction", () => {
    expect(budgetCheck(500_000, 1_000_000).projection).toBeUndefined();
    const projected = budgetCheck(500_000, 1_000_000, [], 0.25);
    expect(projected.projection?.projectedUsdMicros).toBe(2_000_000);
    expect(projected.projection?.projectedOverBudget).toBe(true);
    expect(projected.projection?.budgetLastsFraction).toBe(0.5);
  });

  test("nothing spent means the budget lasts indefinitely rather than a made-up fraction", () => {
    expect(budgetCheck(0, 1_000_000, [], 0.5).projection?.budgetLastsFraction).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SLO
// ---------------------------------------------------------------------------

describe("evaluateSlo", () => {
  test("success_rate holds when failures are within the permitted count", () => {
    const result = evaluateSlo({
      objective: "success_rate",
      total: 1000,
      failures: 7,
      target: 0.99,
    });
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error(result);
    expect(result.holds).toBe(true);
    expect(result.errorsAllowed).toBe(10);
    expect(result.errorBudgetRemaining).toBe(3);
    expect(result.errorBudgetConsumed).toBe(0.7);
  });

  test("it breaks when they are not", () => {
    const result = evaluateSlo({
      objective: "success_rate",
      total: 1000,
      failures: 11,
      target: 0.99,
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.holds).toBe(false);
    expect(result.errorBudgetRemaining).toBe(-1);
  });

  test("successes and failures are interchangeable inputs", () => {
    const a = evaluateSlo({ objective: "success_rate", total: 100, failures: 5, target: 0.9 });
    const b = evaluateSlo({ objective: "success_rate", total: 100, successes: 95, target: 0.9 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("a target given as a max error rate is the same objective", () => {
    const result = evaluateSlo({
      objective: "success_rate",
      total: 100,
      failures: 1,
      target: 0.01,
      targetIs: "max_error_rate",
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.targetSuccessRate).toBe(0.99);
    expect(result.holds).toBe(true);
  });

  test("an empty window neither confirms nor breaks the objective", () => {
    const result = evaluateSlo({ objective: "success_rate", total: 0, failures: 0, target: 0.99 });
    if (typeof result === "string") throw new Error(result);
    expect(result.holds).toBe(true);
    expect(result.successRate).toBeUndefined();
    expect(result.verdict).toContain("nothing has confirmed it either");
  });

  test("latency_percentile returns an observed value against the ceiling", () => {
    const result = evaluateSlo({
      objective: "latency_percentile",
      durationsMs: [10, 20, 30, 40, 5000],
      percentile: 95,
      thresholdMs: 100,
      target: 0.95,
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.observedMs).toBe(5000);
    expect(result.holds).toBe(false);
    expect(result.percentileMethod).toBe("nearest-rank");
  });

  test("caller mistakes come back as readable strings, not exceptions", () => {
    expect(evaluateSlo({ objective: "success_rate", total: 10, target: 0.9 })).toContain(
      'needs "failures"',
    );
    expect(
      evaluateSlo({ objective: "latency_percentile", durationsMs: [1], target: 0.9 }),
    ).toContain("thresholdMs");
    expect(
      evaluateSlo({
        objective: "latency_percentile",
        durationsMs: [],
        thresholdMs: 1,
        target: 0.9,
      }),
    ).toContain("no percentile of nothing");
    expect(
      evaluateSlo({ objective: "success_rate", total: 10, failures: 2, successes: 2, target: 0.9 }),
    ).toContain("which is not total");
    expect(
      evaluateSlo({ objective: "success_rate", total: 10, failures: 11, target: 0.9 }),
    ).toContain("exceeds total");
  });

  test("error_budget asks the same arithmetic the other way round", () => {
    const result = evaluateSlo({
      objective: "error_budget",
      total: 200,
      failures: 3,
      target: 0.98,
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.errorsAllowed).toBe(4);
    expect(result.verdict).toContain("1 left");
  });

  test("a target permitting zero failures is not a division by zero", () => {
    const result = evaluateSlo({ objective: "error_budget", total: 10, failures: 1, target: 1 });
    if (typeof result === "string") throw new Error(result);
    expect(result.errorsAllowed).toBe(0);
    expect(result.holds).toBe(false);
    expect(JSON.parse(JSON.stringify(result))["errorBudgetConsumed"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// remote shaping
// ---------------------------------------------------------------------------

describe("pluck and parseJsonBody", () => {
  test("a dotted path walks into the response body", () => {
    expect(pluck({ data: { result: [1] } }, "data.result")).toEqual([1]);
    expect(pluck({ a: 1 }, "")).toEqual({ a: 1 });
    expect(pluck({ a: 1 }, "b.c")).toBeUndefined();
  });

  test("a non-JSON body comes back as a refusal carrying a capped excerpt", () => {
    const parsed = parseJsonBody(`<html>${"x".repeat(1000)}</html>`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected a refusal");
    expect(parsed.message.length).toBeLessThan(350);
  });
});

describe("shapeMetrics", () => {
  const data = {
    resultType: "matrix",
    result: [
      {
        metric: { job: "z", instance: "b" },
        values: [
          [1, "1"],
          [2, "2"],
          [3, "3"],
        ],
      },
      { metric: { job: "a" }, values: [[1, "9"]] },
    ],
  };

  test("series are re-sorted by label set, so two replicas return the same bytes", () => {
    const shaped = shapeMetrics(data, 10, 10);
    if (typeof shaped === "string") throw new Error(shaped);
    expect(shaped.series.map((s) => s.seriesKey)).toEqual(['{instance="b",job="z"}', '{job="a"}']);
  });

  test("values stay strings, so NaN and +Inf survive", () => {
    const shaped = shapeMetrics(
      { resultType: "vector", result: [{ metric: {}, value: [1, "NaN"] }] },
      10,
      10,
    );
    if (typeof shaped === "string") throw new Error(shaped);
    expect(shaped.series[0]?.samples[0]).toEqual({ t: 1, v: "NaN" });
  });

  test("the per-series sample cap cuts and flags", () => {
    const shaped = shapeMetrics(data, 10, 2);
    if (typeof shaped === "string") throw new Error(shaped);
    const z = shaped.series.find((s) => s.labels["job"] === "z");
    expect(z?.samples.length).toBe(2);
    expect(z?.truncated).toBe(true);
  });

  test("the series cap reports what was left out rather than hiding it", () => {
    const shaped = shapeMetrics(data, 1, 10);
    if (typeof shaped === "string") throw new Error(shaped);
    expect(shaped.seriesReturned).toBe(1);
    expect(shaped.seriesTotal).toBe(2);
  });

  test("a body that is not a Prometheus-style envelope is refused readably", () => {
    expect(typeof shapeMetrics(null, 1, 1)).toBe("string");
    expect(shapeMetrics({ resultType: "scalar", result: 4 }, 1, 1)).toContain("not an array");
  });

  test("seriesKey sorts its labels", () => {
    expect(seriesKey({ b: "2", a: "1" })).toBe('{a="1",b="2"}');
  });
});

describe("shapeRecords", () => {
  const rows = [
    { msg: "a".repeat(100), level: "error", extra: 1 },
    { msg: "b", level: "warn" },
    { msg: "c", level: "info" },
  ];

  test("fields projects and keys are sorted", () => {
    const shaped = shapeRecords(rows, 10, 1000, ["level", "msg"]);
    if (typeof shaped === "string") throw new Error(shaped);
    expect(Object.keys(shaped.records[1] as object)).toEqual(["level", "msg"]);
  });

  test("every field is cut to the budget, because one verbose field is a context window", () => {
    const shaped = shapeRecords(rows, 10, 10);
    if (typeof shaped === "string") throw new Error(shaped);
    expect((shaped.records[0] as Record<string, string>)["msg"]?.length).toBe(11);
  });

  test("the limit truncates and reports the total", () => {
    const shaped = shapeRecords(rows, 2, 1000);
    if (typeof shaped === "string") throw new Error(shaped);
    expect(shaped.records.length).toBe(2);
    expect(shaped.total).toBe(3);
    expect(shaped.truncated).toBe(true);
  });

  test("a result path that did not point at an array is a readable refusal", () => {
    expect(shapeRecords({ not: "an array" }, 1, 1)).toContain("result_path");
  });
});

// ---------------------------------------------------------------------------
// the SSRF classifier
// ---------------------------------------------------------------------------

/**
 * The gate itself, on values rather than on sockets.
 *
 * These are the encodings an allow-listed hostname can be dressed up in. A
 * classifier that recognises `169.254.169.254` and nothing else is not a
 * classifier, so each spelling that reaches the same address is asserted
 * against the address it actually carries — including the three IPv6 ranges
 * that embed an IPv4 one, which are the forms a string-prefix check misses.
 */
describe("the SSRF classifier", () => {
  test("every spelling of a private IPv4 address classifies as private", () => {
    for (const spelling of [
      "169.254.169.254", // the cloud metadata address, plainly
      "0xa9fea9fe", // hex
      "0251.0376.0251.0376", // octal
      "2852039166", // 32-bit integer
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1", // CGNAT
      "127.0.0.1",
      "0.0.0.0",
    ]) {
      expect(isPrivateIp(spelling)).toBe(true);
    }
  });

  test("an IPv6 form carrying an IPv4 address is judged by the address it carries", () => {
    for (const spelling of [
      "::ffff:169.254.169.254", // IPv4-mapped
      "::ffff:a9fe:a9fe", // the same, as the URL parser re-spells it
      "64:ff9b::169.254.169.254", // NAT64
      "64:ff9b::a9fe:a9fe",
      "2002:a9fe:a9fe::", // 6to4
      "::1",
      "0:0:0:0:0:0:0:1", // ::1, spelled out
      "[::0:1]", // ::1 again, bracketed
      "fe80::1", // link-local
      "fc00::1", // unique-local
    ]) {
      expect(isPrivateIp(spelling)).toBe(true);
    }
  });

  test("the local-use NAT64 prefix is judged by the IPv4 it carries, like the well-known one", () => {
    // RFC 8215's 64:ff9b:1::/48 is the prefix a `64:ff9b::/96` test misses, and
    // the one six copies of this classifier were confirmed reachable through.
    // The synchronised block treats the whole of 64:ff9b::/32 as NAT64 and
    // reads the last two groups, so each of these is refused for the address it
    // carries rather than for the prefix it wears.
    expect(isPrivateIp("64:ff9b:1::7f00:1")).toBe(true); // 127.0.0.1
    expect(isPrivateIp("64:ff9b:1:ffff::a9fe:a9fe")).toBe(true); // 169.254.169.254
    expect(isPrivateIp("64:ff9b:1::")).toBe(true); // 0.0.0.0
    expect(isPrivateIp("64:ff9b:2::1")).toBe(true); // 0.0.0.1, inside 0.0.0.0/8
    // Carrying a PUBLIC address is what keeps this from being a wall: the
    // prefix is not the verdict, the embedded address is.
    expect(isPrivateIp("64:ff9b::808:808")).toBe(false); // 8.8.8.8
  });

  test("a public address is not refused, or the gate would be a wall", () => {
    for (const spelling of ["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isPrivateIp(spelling)).toBe(false);
    }
  });

  test("an IPv6-shaped host the parser cannot expand is refused, not dialled", async () => {
    // The predicate answers "not a private address" for a string that is not an
    // address at all, so the fail-closed step is the GATE's: a host with a colon
    // in it that will not expand is one nothing could classify, and it is
    // refused rather than handed to the resolver.
    for (const host of ["::ffff:999.1.1.1", "1:2:3", "fe80:::1"]) {
      expect(isPrivateIp(host)).toBe(false);
      await expect(assertNotSsrf(host)).rejects.toThrow("not a valid IPv6 address");
    }
  });

  test("a zone id cannot dress a link-local address up as an unrecognised one", () => {
    expect(isPrivateIp("fe80::1%eth0")).toBe(true);
    expect(isPrivateIp("fe80::1%25eth0")).toBe(true);
  });

  /**
   * The audit matrix, kept as a test rather than as a one-off proof.
   *
   * These are the spellings the 2026-09-18 audit ran against every copy of the
   * private-address classifier: one address written every way a URL parser, a
   * DNS64 resolver or an `inet_aton` bypass can write it. The sharp ones are
   * the IPv6 forms of 169.254.169.254 — `a9fe:a9fe` IS the cloud metadata
   * service, and `new URL("http://[::ffff:169.254.169.254]/")` hands a guard
   * `::ffff:a9fe:a9fe`, so a check that compares TEXT never sees the spelling
   * it was written for. This copy already parsed numerically, and leaked
   * exactly one of them: `::ffff:0:a9fe:a9fe`, the RFC 6145 translated
   * `::ffff:0:0:0/96` form, which its IPv4-mapped test did not cover.
   */
  test("every spelling in the audit matrix is blocked, and no real address is", () => {
    const leaked = [
      "169.254.169.254",
      "2852039166", // 32-bit integer
      "0xA9FEA9FE", // hex
      "0251.0376.0251.0376", // octal
      "127.1", // short form: 127.0.0.1, not 127.1.0.0
      "::ffff:169.254.169.254", // IPv4-mapped, as written
      "::ffff:a9fe:a9fe", // IPv4-mapped, as the URL parser re-serialises it
      "0:0:0:0:0:ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:169.254.169.254",
      "64:ff9b::a9fe:a9fe", // NAT64 well-known prefix
      "64:ff9b::169.254.169.254",
      "64:ff9b:1::a9fe:a9fe", // NAT64 /48 variant
      "64:ff9b:1:0:0:0:a9fe:a9fe",
      "::a9fe:a9fe", // IPv4-compatible
      "::ffff:0:a9fe:a9fe", // translated ::ffff:0:0:0/96 — what this copy missed
      "2002:a9fe:a9fe::", // 6to4
      "127.0.0.1",
      "::1",
      "0:0:0:0:0:0:0:1",
      "64:ff9b::7f00:1", // NAT64 of loopback
      "fe80::1",
      "febf::1", // the top of fe80::/10, which a "fe80:" prefix test misses
      "fd00::1",
      "::",
      "0:0:0:0:0:0:0:0",
      "10.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "100.64.0.1", // CGNAT
      "198.18.0.1", // benchmarking
      "224.0.0.1", // multicast
      "255.255.255.255", // broadcast
      "0.0.0.0",
    ].filter((ip) => !isPrivateIp(ip));
    expect(leaked).toEqual([]);

    // Over-blocking is the other way to get this wrong, and it breaks real
    // usage rather than announcing itself.
    const overBlocked = [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ].filter((ip) => isPrivateIp(ip));
    expect(overBlocked).toEqual([]);

    // `fec0::1` (deprecated site-local) and `100::1` (discard-only) were
    // covered by this package's own classifier before the synchronised block
    // replaced it. The block does not cover those two ranges, and it is
    // byte-identical across packages, so they cannot be re-asserted here —
    // they have to be added to the block, for every copy at once. Nothing is
    // asserted about them either way, so a later fix in the block does not
    // have to come back and delete an assertion.
  });

  test("a hostname that RESOLVES to a private address is refused", async () => {
    _setDnsLookup(async () => ({ address: "10.0.0.5", family: 4 }));
    try {
      await expect(assertNotSsrf("obs.example.test")).rejects.toThrow("resolves to private IP");
    } finally {
      _setDnsLookup(undefined);
    }
  });

  test("a public resolution returns the vetted IP, which is what gets pinned", async () => {
    _setDnsLookup(async () => ({ address: "93.184.216.34", family: 4 }));
    try {
      expect(await assertNotSsrf("obs.example.test")).toBe("93.184.216.34");
    } finally {
      _setDnsLookup(undefined);
    }
  });

  test("a DNS lookup that never answers loses to the deadline instead of hanging", async () => {
    _setDnsLookup(() => new Promise(() => {}));
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(new Error("deadline of 150ms elapsed")), 150);
    try {
      await expect(assertNotSsrf("obs.example.test", controller.signal)).rejects.toThrow(
        "deadline",
      );
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      clearTimeout(timer);
      _setDnsLookup(undefined);
    }
  });

  test("an origin outside http/https is refused before anything else looks at it", () => {
    expect(() => canonicalizeOrigin("file:///etc/passwd")).toThrow("http/https");
    expect(() => canonicalizeOrigin("not a url")).toThrow("absolute URL");
  });

  test("an origin canonicalises case and elides only the default port", () => {
    expect(canonicalizeOrigin("HTTPS://Prom.Example.COM:443/ignored?q=1")).toBe(
      "https://prom.example.com",
    );
    expect(canonicalizeOrigin("http://prom.example.com:9090")).toBe("http://prom.example.com:9090");
  });
});
