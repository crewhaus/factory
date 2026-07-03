/**
 * Ops item 38 — the mcp-stats persistence subscriber: mirror the trace-bus-only
 * `mcp_call_end` events into the session JSONL as the durable `mcp_stats` kind
 * so `crewhaus mcp doctor` can score per-server health offline. Default-on
 * (shares the advisor gate), disabled by CREWHAUS_ADVISOR_EVENTS=0.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventLog } from "@crewhaus/event-log";
import { createRunContext } from "@crewhaus/run-context";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { attachMcpStatsPersistence } from "./observability";

let root = "";
const SESSION_ID = "sess_00000000000000aa";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-stats-persist-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function readMcpStats(): Array<{ kind: string; payload: Record<string, unknown> }> {
  const path = join(root, `${SESSION_ID}.jsonl`);
  const out: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line === "") continue;
    const rec = JSON.parse(line) as { kind: string; payload: Record<string, unknown> };
    if (rec.kind === "mcp_stats") out.push(rec);
  }
  return out;
}

function endEvent(bus: TraceEventBus, server: string, isError: boolean, durationMs: number): void {
  bus.publish({
    ...bus.envelope(),
    kind: "mcp_call_end",
    server,
    toolName: "forecast",
    isError,
    durationMs,
  } as TraceEvent);
}

describe("attachMcpStatsPersistence", () => {
  test("persists one mcp_stats line per mcp_call_end", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: SESSION_ID });
    const ctx = createRunContext({ sessionId: SESSION_ID });
    const log = await openEventLog(SESSION_ID, { rootDir: root });
    const attached = attachMcpStatsPersistence(bus, log, ctx, { CREWHAUS_ADVISOR_EVENTS: "1" });
    expect(attached).not.toBeUndefined();

    endEvent(bus, "weather", false, 123.7);
    endEvent(bus, "weather", true, 456.2);
    // let the async append settle
    await new Promise((r) => setTimeout(r, 20));

    const lines = readMcpStats();
    expect(lines).toHaveLength(2);
    expect(lines[0]?.payload).toEqual({
      server: "weather",
      toolName: "forecast",
      durationMs: 124, // rounded
      isError: false,
    });
    expect(lines[1]?.payload["isError"]).toBe(true);
    attached?.unsubscribe();
  });

  test("ignores non-mcp events", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: SESSION_ID });
    const ctx = createRunContext({ sessionId: SESSION_ID });
    const log = await openEventLog(SESSION_ID, { rootDir: root });
    const attached = attachMcpStatsPersistence(bus, log, ctx, { CREWHAUS_ADVISOR_EVENTS: "1" });
    bus.publish({ ...bus.envelope(), kind: "turn_end", turn: 1, durationMs: 10 } as TraceEvent);
    await new Promise((r) => setTimeout(r, 20));
    expect(readMcpStats()).toHaveLength(0);
    attached?.unsubscribe();
  });

  test("no subscriber when CREWHAUS_ADVISOR_EVENTS=0", async () => {
    const bus = new TraceEventBus({ runId: "run_a", sessionId: SESSION_ID });
    const ctx = createRunContext({ sessionId: SESSION_ID });
    const log = await openEventLog(SESSION_ID, { rootDir: root });
    const attached = attachMcpStatsPersistence(bus, log, ctx, { CREWHAUS_ADVISOR_EVENTS: "0" });
    expect(attached).toBeUndefined();
  });
});
