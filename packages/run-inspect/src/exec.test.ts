/**
 * A supervised execution's trace events in the run's timeline and summary: entries the
 * session log has no line for, each with the id `x:<offset>`, read from the run's place in
 * the execution's run index, or pieced together by a scan without one; and what cannot be
 * read is a named gap, never a failure.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LogBuilder,
  NOW,
  SESSION,
  harnessWith,
  removeFixtures,
  runId,
  simpleRun,
} from "./__fixtures__/build";
import { type TimelinePage, foldSummary, foldTimeline, loadRun } from "./index";

afterAll(removeFixtures);

const EXEC = "run_00000000000000c1";
const RUN = runId(1);
const OTHER = runId(2);

function event(run: string, kind: string, fields: Readonly<Record<string, unknown>> = {}) {
  return JSON.stringify({
    runId: run,
    sessionId: SESSION,
    turnNumber: 1,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    timestamp: "2026-11-14T11:59:10.000Z",
    kind,
    ...fields,
  });
}

/** A supervised run: its session log, its row, and its execution's events file. */
function supervised(options: { readonly index?: boolean; readonly tail?: string } = {}) {
  const b = new LogBuilder();
  simpleRun(b, RUN, 0x100, { execution: EXEC });
  const { dir } = harnessWith({
    log: b.text(),
    rows: [
      {
        id: RUN,
        state: "succeeded",
        trigger: { kind: "cli" },
        session: SESSION,
        sessionAt: 0,
        execution: EXEC,
      },
    ],
  });
  const logs = join(dir, ".crewhaus", "run", "logs");
  mkdirSync(logs, { recursive: true });
  const lines = [
    event(OTHER, "tool_call_end", { toolName: "Bash", isError: false, durationMs: 3 }),
    event(RUN, "turn_start", { turn: 1, messageCount: 1 }),
    event(RUN, "circuit_state_changed", {
      adapter: "anthropic",
      fromState: "closed",
      toState: "open",
    }),
    event(RUN, "tool_call_end", { toolName: "Read", isError: false, durationMs: 12 }),
    event(RUN, "run_failed", { class: "billing", message: "the card was declined", exitCode: 42 }),
  ];
  const offsets: number[] = [];
  let off = 0;
  for (const line of lines) {
    offsets.push(off);
    off += Buffer.byteLength(line) + 1;
  }
  writeFileSync(join(logs, `${EXEC}.events.jsonl`), `${lines.join("\n")}\n${options.tail ?? ""}`);
  if (options.index !== false) {
    writeFileSync(
      join(logs, `${EXEC}.runs.jsonl`),
      `${JSON.stringify({ run: OTHER, off: offsets[0], at: "t" })}\n${JSON.stringify({ run: RUN, off: offsets[1], at: "t" })}\n`,
    );
  }
  return { dir, offsets, logs };
}

function load(dir: string) {
  const got = loadRun({ harnessDir: dir, ref: RUN, envVars: {}, now: NOW });
  if (!got.ok) throw new Error(got.message);
  return got;
}

function full(dir: string): TimelinePage {
  const page = foldTimeline(load(dir), { view: "full", limit: 500 });
  if ("ok" in page) throw new Error(page.message);
  return page;
}

describe("the execution's events in the run", () => {
  test("listed events join the timeline with ids x:<offset>, read from the run's index entry", () => {
    const { dir, offsets } = supervised();
    const loaded = load(dir);
    expect(loaded.executionEvents?.from).toBe("index");
    const traced = full(dir).entries.filter((e) => e.id.startsWith("x:"));
    expect(traced.map((e) => e.id).sort()).toEqual(
      [offsets[2], offsets[3], offsets[4]].map((o) => `x:${o}`).sort(),
    );
    const titles = Object.fromEntries(traced.map((e) => [e.id, e]));
    expect(titles[`x:${offsets[2]}`]).toMatchObject({
      kind: "failover",
      importance: "detail",
      title: "Model breaker anthropic: closed → open",
    });
    expect(titles[`x:${offsets[4]}`]).toMatchObject({
      kind: "run-failed",
      importance: "key",
      title: "Run failed: billing",
      detail: "the card was declined",
      sensitivity: "restricted",
    });
    // Recorded through the index: no rule pieced it together.
    for (const entry of traced) expect(entry.rule).toBeUndefined();
    // Another run's events, and the events the timeline does not list, are not entries.
    expect(traced.some((e) => e.title.includes("Bash"))).toBe(false);
    const summary = foldSummary(loaded);
    expect(summary.trace).toEqual({ present: true, events: 4, truncated: false });
    expect(summary.gaps.some((g) => g.reason === "not-supervised")).toBe(false);
  });

  test("without an index entry the events are scanned for, and say they were pieced together", () => {
    const { dir } = supervised({ index: false });
    expect(load(dir).executionEvents?.from).toBe("scan");
    const traced = full(dir).entries.filter((e) => e.id.startsWith("x:"));
    expect(traced).toHaveLength(3);
    for (const entry of traced) expect(entry.rule).toBe("execution-scan");
  });

  test("a damaged last line is a torn gap; a missing file is not recorded; neither fails", () => {
    const torn = supervised({ tail: '{"runId":"run_' });
    const summary = foldSummary(load(torn.dir));
    expect(summary.gaps).toContainEqual({ reason: "torn", count: 1 });
    expect(summary.trace?.events).toBe(4);
    const gone = supervised();
    writeFileSync(join(gone.logs, `${EXEC}.events.jsonl`), "");
    const empty = foldSummary(load(gone.dir));
    expect(empty.trace).toEqual({ present: true, events: 0, truncated: false });
    const b = new LogBuilder();
    simpleRun(b, RUN, 0x100, { execution: EXEC });
    const { dir } = harnessWith({
      log: b.text(),
      rows: [
        { id: RUN, state: "succeeded", trigger: { kind: "cli" }, session: SESSION, sessionAt: 0 },
      ],
    });
    const missing = foldSummary(load(dir));
    expect(missing.gaps).toContainEqual({ reason: "not-recorded" });
    expect(missing.trace).toEqual({ present: false, events: 0, truncated: false });
    expect(full(dir).entries.some((e) => e.id.startsWith("x:"))).toBe(false);
  });
});
