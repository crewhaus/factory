import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventLog } from "@crewhaus/event-log";
import { createSessionStore } from "@crewhaus/session-store";
import { type JanitorActionEvent, TraceEventBus } from "@crewhaus/trace-event-bus";
import { createJanitor } from "./janitor";

const MS_PER_DAY = 86_400_000;

let rootDir: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "crewhaus-janitor-"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function sessId(n: number): string {
  return `sess_${n.toString(16).padStart(16, "0")}`;
}

/** Create a session .json (via the real store) and age its mtime by `ageDays`. */
async function seedSession(id: string, ageDays: number): Promise<void> {
  const store = createSessionStore({ rootDir });
  await store.create({ id, name: id, target: "test", model: "m" });
  const aged = new Date(Date.now() - ageDays * MS_PER_DAY);
  utimesSync(join(rootDir, `${id}.json`), aged, aged);
}

/** Append events to a session's .jsonl and age its mtime by `ageDays`. */
async function seedLog(
  id: string,
  events: ReadonlyArray<{ kind: string; payload: unknown }>,
  ageDays: number,
): Promise<void> {
  const log = await openEventLog(id, { rootDir });
  for (const ev of events) {
    await log.append(ev as Parameters<typeof log.append>[0]);
  }
  await log.close();
  const aged = new Date(Date.now() - ageDays * MS_PER_DAY);
  utimesSync(join(rootDir, `${id}.jsonl`), aged, aged);
}

function assistantWithToolUse(toolUseId: string): { kind: string; payload: unknown } {
  return {
    kind: "assistant_message",
    payload: {
      content: [
        { type: "text", text: "calling a tool" },
        { type: "tool_use", id: toolUseId, name: "Read", input: {} },
      ],
    },
  };
}

function userWithToolResult(toolUseId: string): { kind: string; payload: unknown } {
  return {
    kind: "user_message",
    payload: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
  };
}

function step(
  result: Awaited<ReturnType<ReturnType<typeof createJanitor>["runOnce"]>>,
  name: string,
) {
  const found = result.steps.find((s) => s.step === name);
  if (found === undefined) throw new Error(`step ${name} missing from report`);
  return found;
}

describe("createJanitor — reservation cleanup", () => {
  test("skipped when no budget store is provided", async () => {
    const janitor = createJanitor({ sessionRootDirs: [rootDir] });
    const result = await janitor.runOnce();
    const s = step(result, "reservation_cleanup");
    expect(s.status).toBe("skipped");
    expect(s.detail).toContain("no budget store");
  });

  test("clears reservations on the first run only (boot-only semantics)", async () => {
    let calls = 0;
    const janitor = createJanitor({
      budgetStore: {
        async clearReservations() {
          calls += 1;
        },
      },
      sessionRootDirs: [rootDir],
    });
    const first = await janitor.runOnce();
    expect(step(first, "reservation_cleanup").status).toBe("ok");
    expect(calls).toBe(1);
    const second = await janitor.runOnce();
    expect(step(second, "reservation_cleanup").status).toBe("skipped");
    expect(step(second, "reservation_cleanup").detail).toContain("already cleared");
    expect(calls).toBe(1);
  });

  test("a throwing clearReservations is isolated and retried next run", async () => {
    let calls = 0;
    const janitor = createJanitor({
      budgetStore: {
        async clearReservations() {
          calls += 1;
          if (calls === 1) throw new Error("sqlite locked");
        },
      },
      sessionRootDirs: [rootDir],
    });
    const first = await janitor.runOnce();
    const failed = step(first, "reservation_cleanup");
    expect(failed.status).toBe("error");
    expect(failed.detail).toBe("sqlite locked");
    // The other steps still ran despite the failure.
    expect(step(first, "session_ttl_eviction").status).toBe("ok");
    expect(step(first, "orphan_tool_use_sweep").status).toBe("ok");
    // Not marked cleared — the next run retries and succeeds.
    const second = await janitor.runOnce();
    expect(step(second, "reservation_cleanup").status).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("createJanitor — session TTL eviction", () => {
  test("evicts sessions older than the TTL and keeps fresh ones", async () => {
    await seedSession(sessId(1), 40);
    await seedSession(sessId(2), 1);
    const janitor = createJanitor({ sessionRootDirs: [rootDir], sessionTtlDays: 30 });
    const result = await janitor.runOnce();
    const s = step(result, "session_ttl_eviction");
    expect(s.status).toBe("ok");
    expect(s.count).toBe(1);
    expect(existsSync(join(rootDir, `${sessId(1)}.json`))).toBe(false);
    expect(existsSync(join(rootDir, `${sessId(2)}.json`))).toBe(true);
  });

  test("evicts the sibling .jsonl event log alongside the session file", async () => {
    await seedSession(sessId(3), 40);
    await seedLog(sessId(3), [assistantWithToolUse("toolu_1")], 40);
    const janitor = createJanitor({ sessionRootDirs: [rootDir], sessionTtlDays: 30 });
    await janitor.runOnce();
    expect(existsSync(join(rootDir, `${sessId(3)}.json`))).toBe(false);
    expect(existsSync(join(rootDir, `${sessId(3)}.jsonl`))).toBe(false);
  });

  test("sweeps every configured session root", async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "crewhaus-janitor-b-"));
    try {
      await seedSession(sessId(4), 40);
      const otherStore = createSessionStore({ rootDir: otherRoot });
      await otherStore.create({ id: sessId(5), name: "other", target: "test", model: "m" });
      const aged = new Date(Date.now() - 40 * MS_PER_DAY);
      utimesSync(join(otherRoot, `${sessId(5)}.json`), aged, aged);
      const janitor = createJanitor({
        sessionRootDirs: [rootDir, otherRoot],
        sessionTtlDays: 30,
      });
      const result = await janitor.runOnce();
      expect(step(result, "session_ttl_eviction").count).toBe(2);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  test("a missing session root is not an error", async () => {
    const janitor = createJanitor({ sessionRootDirs: [join(rootDir, "does-not-exist")] });
    const result = await janitor.runOnce();
    expect(step(result, "session_ttl_eviction").status).toBe("ok");
    expect(step(result, "session_ttl_eviction").count).toBe(0);
  });
});

describe("createJanitor — orphan tool_use sweep (report-only)", () => {
  test("counts orphaned tool_use ids and does NOT modify the log", async () => {
    await seedSession(sessId(6), 1);
    await seedLog(
      sessId(6),
      [
        assistantWithToolUse("toolu_answered"),
        userWithToolResult("toolu_answered"),
        assistantWithToolUse("toolu_orphan"),
      ],
      1,
    );
    const before = await Bun.file(join(rootDir, `${sessId(6)}.jsonl`)).text();
    const janitor = createJanitor({ sessionRootDirs: [rootDir], orphanQuietPeriodMs: 0 });
    const result = await janitor.runOnce();
    const s = step(result, "orphan_tool_use_sweep");
    expect(s.status).toBe("ok");
    expect(s.count).toBe(1);
    expect(s.detail).toContain(sessId(6));
    expect(s.detail).toContain("report-only");
    // Detect-and-report only: the persisted transcript is untouched.
    const after = await Bun.file(join(rootDir, `${sessId(6)}.jsonl`)).text();
    expect(after).toBe(before);
  });

  test("a healthy log reports zero orphans", async () => {
    await seedLog(sessId(7), [assistantWithToolUse("toolu_ok"), userWithToolResult("toolu_ok")], 1);
    const janitor = createJanitor({ sessionRootDirs: [rootDir], orphanQuietPeriodMs: 0 });
    const result = await janitor.runOnce();
    expect(step(result, "orphan_tool_use_sweep").count).toBe(0);
  });

  test("ignores nested sub-agent transcripts (depth > 0)", async () => {
    await seedLog(
      sessId(8),
      [
        { kind: "sub_agent_start", payload: {} },
        assistantWithToolUse("toolu_nested_orphan"),
        { kind: "sub_agent_end", payload: {} },
      ],
      1,
    );
    const janitor = createJanitor({ sessionRootDirs: [rootDir], orphanQuietPeriodMs: 0 });
    const result = await janitor.runOnce();
    expect(step(result, "orphan_tool_use_sweep").count).toBe(0);
  });

  test("skips logs modified inside the quiet period (presumed mid-turn)", async () => {
    await seedLog(sessId(9), [assistantWithToolUse("toolu_live")], 0);
    const janitor = createJanitor({
      sessionRootDirs: [rootDir],
      orphanQuietPeriodMs: 60 * 60_000,
    });
    const result = await janitor.runOnce();
    const s = step(result, "orphan_tool_use_sweep");
    expect(s.count).toBe(0);
    expect(s.detail).toContain("recently-active");
  });

  test("orphanScanLimit 0 disables the step", async () => {
    await seedLog(sessId(10), [assistantWithToolUse("toolu_x")], 1);
    const janitor = createJanitor({
      sessionRootDirs: [rootDir],
      orphanScanLimit: 0,
      orphanQuietPeriodMs: 0,
    });
    const result = await janitor.runOnce();
    expect(step(result, "orphan_tool_use_sweep").status).toBe("skipped");
  });

  test("orphanScanLimit bounds how many logs are scanned per root", async () => {
    await seedLog(sessId(11), [assistantWithToolUse("toolu_a")], 3);
    await seedLog(sessId(12), [assistantWithToolUse("toolu_b")], 2);
    await seedLog(sessId(13), [assistantWithToolUse("toolu_c")], 1);
    const janitor = createJanitor({
      sessionRootDirs: [rootDir],
      orphanScanLimit: 2,
      orphanQuietPeriodMs: 0,
    });
    const result = await janitor.runOnce();
    // Only the 2 most recent logs are scanned → 2 orphans, not 3.
    expect(step(result, "orphan_tool_use_sweep").count).toBe(2);
  });

  test("a malformed log is skipped without failing the step", async () => {
    writeFileSync(join(rootDir, `${sessId(14)}.jsonl`), "not json\n");
    const aged = new Date(Date.now() - MS_PER_DAY);
    utimesSync(join(rootDir, `${sessId(14)}.jsonl`), aged, aged);
    await seedLog(sessId(15), [assistantWithToolUse("toolu_orphan2")], 1);
    const janitor = createJanitor({ sessionRootDirs: [rootDir], orphanQuietPeriodMs: 0 });
    const result = await janitor.runOnce();
    const s = step(result, "orphan_tool_use_sweep");
    expect(s.status).toBe("ok");
    expect(s.count).toBe(1);
    expect(s.detail).toContain("unreadable");
  });
});

describe("createJanitor — trace bus", () => {
  test("publishes one janitor_action event per step", async () => {
    const bus = new TraceEventBus({ runId: "run_janitor", sessionId: sessId(20) });
    const seen: JanitorActionEvent[] = [];
    bus.subscribe((ev) => {
      if (ev.kind === "janitor_action") seen.push(ev);
    });
    const janitor = createJanitor({ sessionRootDirs: [rootDir], bus });
    await janitor.runOnce();
    expect(seen.map((e) => e.step)).toEqual([
      "reservation_cleanup",
      "session_ttl_eviction",
      "orphan_tool_use_sweep",
    ]);
    expect(seen[0]?.status).toBe("skipped");
    expect(seen[1]?.status).toBe("ok");
    expect(seen[0]?.runId).toBe("run_janitor");
  });

  test("without a bus, runOnce still reports (no throw)", async () => {
    const janitor = createJanitor({ sessionRootDirs: [rootDir] });
    const result = await janitor.runOnce();
    expect(result.steps).toHaveLength(3);
    expect(result.startedAt).toMatch(/^\d{4}-/);
  });
});

describe("createJanitor — timer", () => {
  /** Poll until `read()` >= target or the deadline passes (load-tolerant). */
  async function waitForRuns(read: () => number, target: number, deadlineMs = 5000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (read() < target && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** After stop(), let any in-flight run finish, then assert the cadence halted. */
  async function expectHalted(read: () => number): Promise<void> {
    await new Promise((r) => setTimeout(r, 60));
    const settled = read();
    await new Promise((r) => setTimeout(r, 120));
    expect(read()).toBe(settled);
  }

  test("start(intervalMs) re-runs and stop() halts it", async () => {
    const bus = new TraceEventBus({ runId: "run_timer", sessionId: sessId(21) });
    let runs = 0;
    bus.subscribe((ev) => {
      if (ev.kind === "janitor_action" && ev.step === "session_ttl_eviction") runs += 1;
    });
    const janitor = createJanitor({ sessionRootDirs: [rootDir], bus });
    janitor.start(10);
    await waitForRuns(() => runs, 2);
    janitor.stop();
    expect(runs).toBeGreaterThanOrEqual(2);
    await expectHalted(() => runs);
  });

  test("start(0) and negative/NaN intervals are no-ops", async () => {
    const bus = new TraceEventBus({ runId: "run_noop", sessionId: sessId(22) });
    let runs = 0;
    bus.subscribe((ev) => {
      if (ev.kind === "janitor_action" && ev.step === "session_ttl_eviction") runs += 1;
    });
    const janitor = createJanitor({ sessionRootDirs: [rootDir], bus });
    janitor.start(0);
    janitor.start(-100);
    janitor.start(Number.NaN);
    await new Promise((r) => setTimeout(r, 60));
    expect(runs).toBe(0);
    janitor.stop(); // idempotent even when never started
  });

  test("start is idempotent — a single stop halts everything", async () => {
    const bus = new TraceEventBus({ runId: "run_idem", sessionId: sessId(23) });
    let runs = 0;
    bus.subscribe((ev) => {
      if (ev.kind === "janitor_action" && ev.step === "session_ttl_eviction") runs += 1;
    });
    const janitor = createJanitor({ sessionRootDirs: [rootDir], bus });
    janitor.start(10);
    janitor.start(10); // must NOT schedule a second (untracked) timer
    await waitForRuns(() => runs, 1);
    expect(runs).toBeGreaterThanOrEqual(1);
    // One stop() must halt the cadence entirely — if the second start had
    // scheduled its own timer, stop() could not have cleared it.
    janitor.stop();
    await expectHalted(() => runs);
  });
});
