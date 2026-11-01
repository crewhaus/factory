/**
 * Run detail — the ledger view and one run read back — with the two seams a
 * serving layer injects (`makeScrubber`, `mapEvent`) and the defaults a
 * caller that injects nothing gets.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_LEDGER_ROWS, isSupervisorRunId, runDetail, runLogFile, runsView } from "./run-detail";
import { appendRunLedger, ensureRunDir, runEventsPath, runLogPath } from "./runfiles";
import type { Scrubber } from "./scrub";
import type { RunLedgerEntry } from "./types";

const RUN = "run_00000000000000a1";
/** Built from parts: never a realistic-shaped literal in a fixture. */
const SECRET = ["sk", "detail", "0123456789abcdefghij"].join("-");

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function harness(): string {
  const root = mkdtempSync(join(tmpdir(), "run-detail-"));
  scratch.push(root);
  const dir = join(root, "harness");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function entry(runId: string, startedAt = "2026-10-31T12:00:00.000Z"): RunLedgerEntry {
  return {
    runId,
    kind: "daemon",
    argv: ["bun", "dist/daemon.ts"],
    startedAt,
    logFile: `logs/${runId}.log`,
  };
}

function writeEvents(dir: string, runId: string, events: readonly unknown[]): void {
  ensureRunDir(dir);
  writeFileSync(runEventsPath(dir, runId), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

function writeLog(dir: string, runId: string, text: string): void {
  ensureRunDir(dir);
  writeFileSync(runLogPath(dir, runId), text);
}

/** A `makeScrubber` that counts how often it is asked. */
function countingScrubber(): { make: () => Scrubber; calls: () => number } {
  let calls = 0;
  return {
    make: () => {
      calls += 1;
      return (text) => text.replaceAll(SECRET, "«INJECTED»");
    },
    calls: () => calls,
  };
}

describe("runDetail — what does not exist", () => {
  test("a malformed run id is undefined, and no scrubber is built", () => {
    const dir = harness();
    const scrubber = countingScrubber();
    for (const bad of ["run_123", "../run_00000000000000a1", "RUN_00000000000000A1", ""]) {
      expect(runDetail(dir, bad, { makeScrubber: scrubber.make })).toBeUndefined();
    }
    expect(scrubber.calls()).toBe(0);
  });

  test("no ledger row and no events file is undefined, and no scrubber is built", () => {
    const dir = harness();
    // A log alone does not make a run exist.
    writeLog(dir, RUN, "orphan log\n");
    const scrubber = countingScrubber();
    expect(runDetail(dir, RUN, { makeScrubber: scrubber.make })).toBeUndefined();
    expect(scrubber.calls()).toBe(0);
  });
});

describe("runDetail — what does", () => {
  test("a ledger row alone gives its entry, no events and no tail", () => {
    const dir = harness();
    appendRunLedger(dir, entry(RUN));
    const scrubber = countingScrubber();
    const detail = runDetail(dir, RUN, { makeScrubber: scrubber.make });
    expect(detail).toEqual({
      runId: RUN,
      entry: entry(RUN),
      live: false,
      events: [],
      eventsTruncated: false,
      proseTail: [],
    });
    expect(scrubber.calls()).toBe(1);
  });

  test("an events file with no ledger row is still a run", () => {
    const dir = harness();
    writeEvents(dir, RUN, [{ kind: "run_started", runId: RUN }]);
    const detail = runDetail(dir, RUN);
    expect(detail?.entry).toBeNull();
    expect(detail?.events).toEqual([{ kind: "run_started", runId: RUN }]);
  });

  test("by default a .env value becomes «NAME» in the events AND in the tail", () => {
    const dir = harness();
    writeFileSync(join(dir, ".env"), `DETAIL_API_KEY=${SECRET}\n`);
    appendRunLedger(dir, entry(RUN));
    writeEvents(dir, RUN, [{ kind: "run_failed", runId: RUN, error: `auth rejected ${SECRET}` }]);
    writeLog(dir, RUN, `boot with ${SECRET}\nready\n`);
    const detail = runDetail(dir, RUN, { env: {} });
    expect(JSON.stringify(detail)).not.toContain(SECRET);
    expect(detail?.events).toEqual([
      { kind: "run_failed", runId: RUN, error: "auth rejected «DETAIL_API_KEY»" },
    ]);
    expect(detail?.proseTail).toEqual(["boot with «DETAIL_API_KEY»", "ready"]);
  });

  test("the default scrubber is the MERGED spawn env, so a value only the manager holds is caught", () => {
    const dir = harness();
    appendRunLedger(dir, entry(RUN));
    writeLog(dir, RUN, `exported ${SECRET}\n`);
    const detail = runDetail(dir, RUN, { env: { SHELL_ONLY_TOKEN: SECRET } });
    expect(detail?.proseTail).toEqual(["exported «SHELL_ONLY_TOKEN»"]);
  });

  test("one injected scrubber serves both halves, and mapEvent runs on every event with it", () => {
    const dir = harness();
    appendRunLedger(dir, entry(RUN));
    writeEvents(dir, RUN, [
      { kind: "a", note: SECRET },
      { kind: "b", note: SECRET },
      { kind: "c", note: "clean" },
    ]);
    writeLog(dir, RUN, `tail ${SECRET}\n`);
    const scrubber = countingScrubber();
    const mapped: unknown[] = [];
    const detail = runDetail(dir, RUN, {
      live: true,
      makeScrubber: scrubber.make,
      mapEvent: (event, scrub) => {
        mapped.push(event);
        return { mapped: scrub(JSON.stringify(event)) };
      },
    });
    expect(scrubber.calls()).toBe(1);
    expect(mapped).toHaveLength(3);
    expect(detail?.live).toBe(true);
    expect(detail?.events).toEqual([
      { mapped: JSON.stringify({ kind: "a", note: "«INJECTED»" }) },
      { mapped: JSON.stringify({ kind: "b", note: "«INJECTED»" }) },
      { mapped: JSON.stringify({ kind: "c", note: "clean" }) },
    ]);
    expect(detail?.proseTail).toEqual(["tail «INJECTED»"]);
  });

  test("maxEvents keeps the NEWEST events and says the list was truncated", () => {
    const dir = harness();
    appendRunLedger(dir, entry(RUN));
    writeEvents(
      dir,
      RUN,
      [1, 2, 3, 4, 5].map((n) => ({ kind: "tick", n })),
    );
    const capped = runDetail(dir, RUN, { maxEvents: 2 });
    expect(capped?.events).toEqual([
      { kind: "tick", n: 4 },
      { kind: "tick", n: 5 },
    ]);
    expect(capped?.eventsTruncated).toBe(true);
    const whole = runDetail(dir, RUN, { maxEvents: 5 });
    expect(whole?.events).toHaveLength(5);
    expect(whole?.eventsTruncated).toBe(false);
  });
});

describe("runsView", () => {
  test("is the ledger newest first, capped, and says when it was", () => {
    const dir = harness();
    expect(runsView(dir)).toEqual({ runs: [], truncated: false });
    const ids = ["run_0000000000000001", "run_0000000000000002", "run_0000000000000003"];
    for (const id of ids) appendRunLedger(dir, entry(id));
    expect(runsView(dir).runs.map((r) => r.runId)).toEqual([...ids].reverse());
    const capped = runsView(dir, 2);
    expect(capped.runs.map((r) => r.runId)).toEqual([ids[2], ids[1]]);
    expect(capped.truncated).toBe(true);
    expect(MAX_LEDGER_ROWS).toBe(200);
  });

  test("run ids are the supervisor's run_<16 hex>", () => {
    expect(isSupervisorRunId(RUN)).toBe(true);
    expect(isSupervisorRunId("run_0000000000000g01")).toBe(false);
    expect(isSupervisorRunId("sess_00000000000000a1")).toBe(false);
  });
});

describe("runLogFile", () => {
  test("is the run's log path, and nothing for a malformed id", () => {
    const dir = harness();
    ensureRunDir(dir);
    expect(runLogFile(dir, RUN)).toBe(runLogPath(dir, RUN));
    expect(runLogFile(dir, "run_../../x")).toBeUndefined();
  });
});

// Symlinks need privileges Windows runners do not grant by default.
describe.skipIf(process.platform === "win32")("containment", () => {
  test("a logs directory symlinked outside the harness is refused, for the log and the detail", () => {
    const dir = harness();
    const outside = mkdtempSync(join(tmpdir(), "run-detail-outside-"));
    scratch.push(outside);
    writeFileSync(join(outside, `${RUN}.log`), `outside ${SECRET}\n`);
    writeFileSync(join(outside, `${RUN}.events.jsonl`), `${JSON.stringify({ leaked: SECRET })}\n`);
    mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
    symlinkSync(outside, join(dir, ".crewhaus", "run", "logs"));

    expect(runLogFile(dir, RUN)).toBeUndefined();
    // No ledger row, and the only events file is outside: the run does not
    // exist here.
    expect(runDetail(dir, RUN)).toBeUndefined();
    // With a ledger row it exists — and still reads nothing from outside.
    appendRunLedger(dir, entry(RUN));
    const detail = runDetail(dir, RUN);
    expect(detail?.events).toEqual([]);
    expect(detail?.proseTail).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(SECRET);
  });
});
