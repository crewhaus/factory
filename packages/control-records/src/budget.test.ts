/**
 * Budget periods: period math across zones and DST, the cross-process ledger
 * and its crash-safe fold, the exhaustion state and the intake reason. Fake
 * clocks only; no timers are waited on.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type BudgetPeriodDef,
  type BudgetSweepStop,
  _setBudgetSweepSeamsForTest,
  budgetPeriodProblem,
  extendBudget,
  foldBudget,
  openBudgetLedger,
  periodOf,
  readBudgetState,
  renewalDay,
  sweepBudgetPeriods,
  writeBudgetState,
} from "./budget";
import { intakeVerdict } from "./intake";
import { type LeaseProbe, defaultLeaseProbe } from "./lease";
import { systemLeaseProbe } from "./process-start";
import { assertRunnable } from "./runnable";
import { controlFile, jsonLine, plant, removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const BERLIN = "Europe/Berlin";
const at = (iso: string): number => Date.parse(iso);

describe("period identity", () => {
  test("a UTC month is the 1st to the 1st, for months of 28 to 31 days", () => {
    const def: BudgetPeriodDef = { every: "month", usdMicros: 1 };
    const cases: Array<[string, string, string, string]> = [
      [
        "2026-02-14T12:00:00Z",
        "month-2026-02-01",
        "2026-02-01T00:00:00.000Z",
        "2026-03-01T00:00:00.000Z",
      ],
      [
        "2028-02-29T23:59:59Z",
        "month-2028-02-01",
        "2028-02-01T00:00:00.000Z",
        "2028-03-01T00:00:00.000Z",
      ],
      [
        "2026-04-30T00:00:00Z",
        "month-2026-04-01",
        "2026-04-01T00:00:00.000Z",
        "2026-05-01T00:00:00.000Z",
      ],
      [
        "2026-12-31T23:00:00Z",
        "month-2026-12-01",
        "2026-12-01T00:00:00.000Z",
        "2027-01-01T00:00:00.000Z",
      ],
    ];
    for (const [now, id, startsAt, renewsAt] of cases) {
      expect(periodOf(def, at(now))).toEqual({ periodId: id, startsAt, renewsAt });
    }
    // A monthly anchor on the 28th: every month has one.
    const anchored = periodOf(
      { every: "month", usdMicros: 1, starts: "2026-01-28" },
      at("2026-03-01T00:00:00Z"),
    );
    expect(anchored.startsAt).toBe("2026-02-28T00:00:00.000Z");
    expect(anchored.renewsAt).toBe("2026-03-28T00:00:00.000Z");
    expect(anchored.periodId).toMatch(/^month-2026-02-28-[0-9a-f]{6}$/);
  });

  test("Berlin days, weeks and months across both DST changes", () => {
    // Spring forward: Sunday 2026-03-29, 02:00 → 03:00 (a 23-hour day).
    const spring = periodOf(
      { every: "day", usdMicros: 1, timezone: BERLIN },
      at("2026-03-29T10:00:00Z"),
    );
    expect(spring.startsAt).toBe("2026-03-28T23:00:00.000Z");
    expect(spring.renewsAt).toBe("2026-03-29T22:00:00.000Z");
    // Fall back: Sunday 2026-10-25, 03:00 → 02:00 (a 25-hour day).
    const fall = periodOf(
      { every: "day", usdMicros: 1, timezone: BERLIN },
      at("2026-10-25T10:00:00Z"),
    );
    expect(fall.startsAt).toBe("2026-10-24T22:00:00.000Z");
    expect(fall.renewsAt).toBe("2026-10-25T23:00:00.000Z");
    // A week that spans the spring change: Monday to Monday, local midnight each.
    const week = periodOf(
      { every: "week", usdMicros: 1, timezone: BERLIN },
      at("2026-03-28T12:00:00Z"),
    );
    expect(week.startsAt).toBe("2026-03-22T23:00:00.000Z");
    expect(week.renewsAt).toBe("2026-03-29T22:00:00.000Z");
    // Just before local midnight on Sunday is still that week; just after is the next.
    const sundayLate = periodOf(
      { every: "week", usdMicros: 1, timezone: BERLIN },
      at("2026-03-29T21:59:59Z"),
    );
    expect(sundayLate.startsAt).toBe(week.startsAt);
    const mondayEarly = periodOf(
      { every: "week", usdMicros: 1, timezone: BERLIN },
      at("2026-03-29T22:00:00Z"),
    );
    expect(mondayEarly.startsAt).toBe("2026-03-29T22:00:00.000Z");
    // The month that holds the fall change.
    const month = periodOf(
      { every: "month", usdMicros: 1, timezone: BERLIN },
      at("2026-10-31T23:30:00Z"),
    );
    expect(month.startsAt).toBe("2026-10-31T23:00:00.000Z");
    expect(month.renewsAt).toBe("2026-11-30T23:00:00.000Z");
    const october = periodOf(
      { every: "month", usdMicros: 1, timezone: BERLIN },
      at("2026-10-31T22:30:00Z"),
    );
    expect(october.startsAt).toBe("2026-09-30T22:00:00.000Z");
    expect(october.renewsAt).toBe("2026-10-31T23:00:00.000Z");
  });

  test("a week anchored on a date counts seven days from it", () => {
    const def: BudgetPeriodDef = { every: "week", usdMicros: 1, starts: "2026-11-04" };
    const p = periodOf(def, at("2026-11-17T08:00:00Z"));
    expect(p.startsAt).toBe("2026-11-11T00:00:00.000Z");
    expect(p.renewsAt).toBe("2026-11-18T00:00:00.000Z");
  });

  test("a changed definition is a new period id", () => {
    const now = at("2026-11-17T08:00:00Z");
    const ids = new Set([
      periodOf({ every: "month", usdMicros: 1 }, now).periodId,
      periodOf({ every: "month", usdMicros: 1, timezone: BERLIN }, now).periodId,
      periodOf({ every: "month", usdMicros: 1, starts: "2026-01-05" }, now).periodId,
      periodOf({ every: "week", usdMicros: 1 }, now).periodId,
    ]);
    expect(ids.size).toBe(4);
  });

  test("a definition that keeps the default grid keeps the default id", () => {
    const now = at("2026-11-17T08:00:00Z");
    const month = periodOf({ every: "month", usdMicros: 1 }, now).periodId;
    expect(month).toBe("month-2026-11-01");
    expect(periodOf({ every: "month", usdMicros: 1, timezone: "UTC" }, now).periodId).toBe(month);
    expect(periodOf({ every: "month", usdMicros: 1, starts: "2026-01-01" }, now).periodId).toBe(
      month,
    );
    const week = periodOf({ every: "week", usdMicros: 1 }, now).periodId;
    // 2026-11-02 is a Monday: on the default grid.
    expect(periodOf({ every: "week", usdMicros: 1, starts: "2026-11-02" }, now).periodId).toBe(
      week,
    );
    const day = periodOf({ every: "day", usdMicros: 1 }, now).periodId;
    expect(periodOf({ every: "day", usdMicros: 1, starts: "2026-03-14" }, now).periodId).toBe(day);
  });

  test("a monthly anchor past the 28th, an unknown zone and a non-date are refused", () => {
    expect(budgetPeriodProblem({ every: "month", usdMicros: 1, starts: "2026-01-29" })).toMatch(
      /day 1 to 28/,
    );
    expect(
      budgetPeriodProblem({ every: "week", usdMicros: 1, starts: "2026-01-29" }),
    ).toBeUndefined();
    expect(budgetPeriodProblem({ every: "day", usdMicros: 1, timezone: "Mars/Olympus" })).toMatch(
      /not a zone/,
    );
    expect(budgetPeriodProblem({ every: "day", usdMicros: 1, starts: "2026-02-30" })).toMatch(
      /not a date/,
    );
    expect(() => periodOf({ every: "day", usdMicros: 0 }, 0)).toThrow(/positive/);
  });
});

/** A probe that answers from a fixed set of live pids. */
function probeOf(live: ReadonlySet<number>): LeaseProbe {
  return { isAlive: (pid) => live.has(pid), startTimeMs: () => undefined };
}

describe("the period ledger", () => {
  const DEF: BudgetPeriodDef = { every: "month", usdMicros: 1_000 };
  const NOW = at("2026-11-17T08:00:00Z");

  test("two processes on one directory reserve under the lock, and the fold sees both", async () => {
    const dir = tempDir();
    const live = probeOf(new Set([1, 2]));
    const a = openBudgetLedger(dir, DEF, { now: () => NOW, pid: 1, host: "h", probe: live });
    const b = openBudgetLedger(dir, DEF, { now: () => NOW, pid: 2, host: "h", probe: live });
    const [ra, rb] = await Promise.all([
      a.reserve({ id: "rsv_a", usdMicros: 300 }),
      b.reserve({ id: "rsv_b", usdMicros: 300 }),
    ]);
    expect(ra).toEqual({ admit: true });
    expect(rb).toEqual({ admit: true });
    const fold = foldBudget(dir, DEF, NOW, { probe: live, host: "h" });
    expect(fold.reservedUsdMicros).toBe(600);
    expect(fold.spentUsdMicros).toBe(0);
    await a.settle({ id: "rsv_a", usdMicros: 250 });
    await b.release("rsv_b");
    const after = foldBudget(dir, DEF, NOW, { probe: live, host: "h" });
    expect(after).toMatchObject({ spentUsdMicros: 250, reservedUsdMicros: 0, unknownCalls: 0 });
  });

  test("admission: spent + others < cap admits, equality refuses on others, spent at the cap refuses and writes the state", async () => {
    const dir = tempDir();
    const live = probeOf(new Set([1]));
    const port = openBudgetLedger(dir, DEF, { now: () => NOW, pid: 1, host: "h", probe: live });
    expect(await port.reserve({ id: "r1", usdMicros: 1_000 })).toEqual({ admit: true });
    const blocked = await port.reserve({ id: "r2", usdMicros: 1 });
    expect(blocked.admit).toBe(false);
    if (blocked.admit) throw new Error("unreachable");
    expect(blocked.on).toBe("others");
    expect(existsSync(join(dir, ".crewhaus/run/control/budget-state.json"))).toBe(false);
    await port.settle({ id: "r1", usdMicros: 1_000 });
    expect(await port.reserve({ id: "r3", usdMicros: 1 })).toEqual({ admit: false, on: "spent" });
    const state = readBudgetState(dir);
    expect(state.state).toBe("present");
    if (state.state !== "present") throw new Error("unreachable");
    expect(state.record).toEqual({
      v: 1,
      periodId: "month-2026-11-01",
      exhaustedAt: new Date(NOW).toISOString(),
      renewsAt: "2026-12-01T00:00:00.000Z",
    });
  });

  test("an unpriced settle counts an unknown call and adds no spend", async () => {
    const dir = tempDir();
    const port = openBudgetLedger(dir, DEF, { now: () => NOW });
    await port.settle({ id: "r1", usdMicros: null });
    expect(port.fold()).toMatchObject({ spentUsdMicros: 0, unknownCalls: 1 });
    const lines = readFileSync(
      join(dir, ".crewhaus/run/control/budget/month-2026-11-01/000001.jsonl"),
      "utf8",
    );
    expect(JSON.parse(lines.trim())).toMatchObject({
      op: "settle",
      usdMicros: null,
      unpriced: true,
    });
  });

  test("a reservation stops counting only when its holder is provably dead AND its lease has passed, with no write", async () => {
    const dir = tempDir();
    const port = openBudgetLedger(dir, DEF, {
      now: () => NOW,
      pid: 7,
      host: "h",
      probe: probeOf(new Set([7])),
      leaseMs: 60_000,
    });
    await port.reserve({ id: "r", usdMicros: 400 });
    const files = readdirSync(join(dir, ".crewhaus/run/control/budget/month-2026-11-01"));
    const bytes = readFileSync(
      join(dir, ".crewhaus/run/control/budget/month-2026-11-01", files[0] as string),
    );
    const dead = probeOf(new Set());
    const alive = probeOf(new Set([7]));
    // Dead, inside its lease: still counts.
    expect(foldBudget(dir, DEF, NOW + 30_000, { probe: dead, host: "h" }).reservedUsdMicros).toBe(
      400,
    );
    // Alive, past its lease: still counts.
    expect(foldBudget(dir, DEF, NOW + 120_000, { probe: alive, host: "h" }).reservedUsdMicros).toBe(
      400,
    );
    // Dead and past its lease: no longer counts.
    expect(foldBudget(dir, DEF, NOW + 120_000, { probe: dead, host: "h" }).reservedUsdMicros).toBe(
      0,
    );
    // Reading wrote nothing.
    expect(
      readFileSync(join(dir, ".crewhaus/run/control/budget/month-2026-11-01", files[0] as string)),
    ).toEqual(bytes);
  });

  test("a process that runs across a renewal reserves into the new period, and settles where it reserved", async () => {
    const dir = tempDir();
    const day: BudgetPeriodDef = { every: "day", usdMicros: 100 };
    let clock = at("2026-11-17T23:59:00Z");
    const live = probeOf(new Set([1]));
    const port = openBudgetLedger(dir, day, { now: () => clock, pid: 1, host: "h", probe: live });
    expect(port.periodId).toBe("day-2026-11-17");
    // Yesterday: one call reserved before midnight, then the day used up.
    expect(await port.reserve({ id: "late", usdMicros: 10 })).toEqual({ admit: true });
    await openBudgetLedger(dir, day, { now: () => clock }).settle({ id: "x", usdMicros: 100 });
    clock = at("2026-11-18T00:00:30Z");
    expect(port.periodId).toBe("day-2026-11-18");
    // The new day has its full limit: yesterday's exhaustion does not refuse it.
    expect(await port.reserve({ id: "fresh", usdMicros: 10 })).toEqual({ admit: true });
    expect(readBudgetState(dir).state).toBe("absent");
    // The call reserved yesterday settles into yesterday; today's settles today.
    await port.settle({ id: "late", usdMicros: 9 });
    await port.settle({ id: "fresh", usdMicros: 4 });
    expect(foldBudget(dir, day, clock, { probe: live, host: "h" })).toMatchObject({
      periodId: "day-2026-11-18",
      spentUsdMicros: 4,
      reservedUsdMicros: 0,
    });
    expect(
      foldBudget(dir, day, at("2026-11-17T12:00:00Z"), { probe: live, host: "h" }),
    ).toMatchObject({ periodId: "day-2026-11-17", spentUsdMicros: 109, reservedUsdMicros: 0 });
    expect(port.fold().periodId).toBe("day-2026-11-18");
  });

  test("a reservation records its holder's start time when the probe knows it", async () => {
    const dir = tempDir();
    const probe: LeaseProbe = { isAlive: () => true, startTimeMs: () => 1_700_000_000_000 };
    const port = openBudgetLedger(dir, DEF, { now: () => NOW, pid: 9, host: "h", probe });
    await port.reserve({ id: "r", usdMicros: 5 });
    const seg = join(dir, ".crewhaus/run/control/budget/month-2026-11-01");
    const line = JSON.parse(
      readFileSync(join(seg, readdirSync(seg)[0] as string), "utf8").trim(),
    ) as { holder: unknown };
    expect(line.holder).toEqual({ pid: 9, startedAt: 1_700_000_000_000, host: "h" });
    // A recycled pid (another start time) is provably another process.
    const recycled: LeaseProbe = { isAlive: () => true, startTimeMs: () => 1_800_000_000_000 };
    expect(
      foldBudget(dir, DEF, NOW + 60 * 60_000, { probe: recycled, host: "h" }).reservedUsdMicros,
    ).toBe(0);
  });

  test("reservations past their lease that cannot be proved dead end the wait with a final refusal", async () => {
    const dir = tempDir();
    // A holder on another host, or one that answers alive: never provably dead.
    const alive: LeaseProbe = { isAlive: () => true, startTimeMs: () => undefined };
    const crashed = openBudgetLedger(dir, DEF, {
      now: () => NOW,
      pid: 4,
      host: "other-host",
      probe: alive,
      leaseMs: 60_000,
    });
    expect(await crashed.reserve({ id: "leaked", usdMicros: 1_000 })).toEqual({ admit: true });
    let clock = NOW + 30_000;
    const port = openBudgetLedger(dir, DEF, { now: () => clock, pid: 5, host: "h", probe: alive });
    // Inside the lease: worth waiting for.
    const waiting = await port.reserve({ id: "mine", usdMicros: 200 });
    expect(waiting.admit === false && waiting.on).toBe("others");
    // Past it: a final answer, never another wait, and no exhaustion state.
    clock = NOW + 24 * 60 * 60_000;
    let answer = await port.reserve({ id: "mine", usdMicros: 200 });
    let tries = 1;
    while (answer.admit === false && answer.on === "others" && tries < 3) {
      answer = await port.reserve({ id: "mine", usdMicros: 200 });
      tries += 1;
    }
    expect(answer).toEqual({ admit: false, on: "spent", held: true });
    expect(tries).toBe(1);
    expect(readBudgetState(dir).state).toBe("absent");
    // The leaked reservation still counts in the fold.
    expect(foldBudget(dir, DEF, clock, { probe: alive, host: "h" }).reservedUsdMicros).toBe(1_000);
  });

  test("a torn final line waits; a malformed middle line is a counted gap", () => {
    const dir = tempDir();
    const seg = join(dir, ".crewhaus/run/control/budget/month-2026-11-01");
    mkdirSync(seg, { recursive: true });
    const file = join(seg, "000001.jsonl");
    const line = (o: object) => `${JSON.stringify({ v: 1, at: "x", ...o })}\n`;
    appendFileSync(file, line({ op: "settle", id: "a", usdMicros: 10 }));
    appendFileSync(file, "{not json\n");
    appendFileSync(file, line({ op: "settle", id: "b", usdMicros: 5 }));
    appendFileSync(file, '{"v":1,"op":"settle","usdMicros":1000');
    const fold = foldBudget(dir, DEF, NOW);
    expect(fold).toMatchObject({ spentUsdMicros: 15, gaps: 1 });
    // The torn line lands whole: the next read counts it.
    appendFileSync(file, "}\n");
    expect(foldBudget(dir, DEF, NOW).spentUsdMicros).toBe(1_015);
  });

  test("a read of a harness with no period ledger creates nothing", () => {
    const dir = tempDir();
    expect(foldBudget(dir, DEF, NOW)).toMatchObject({ spentUsdMicros: 0, exhausted: false });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("extension", () => {
  const DEF: BudgetPeriodDef = { every: "month", usdMicros: 100 };
  const NOW = at("2026-11-17T08:00:00Z");

  test("a raise tops up the current period and clears the state once spend is under the cap", async () => {
    const dir = tempDir();
    const port = openBudgetLedger(dir, DEF, { now: () => NOW });
    await port.settle({ id: "r", usdMicros: 100 });
    expect(await port.reserve({ id: "r2", usdMicros: 1 })).toEqual({ admit: false, on: "spent" });
    expect(readBudgetState(dir).state).toBe("present");
    const stale = await extendBudget(dir, DEF, {
      usdMicros: 50,
      reasonCode: "planned-work",
      expect: "month-2026-10-01",
      cmd: "cmd_x",
      by: "local:#abc",
      nowMs: NOW,
    });
    expect(stale).toEqual({ ok: false, reason: "stale", periodId: "month-2026-11-01" });
    const raised = await extendBudget(dir, DEF, {
      usdMicros: 50,
      reasonCode: "planned-work",
      expect: "month-2026-11-01",
      cmd: "cmd_x",
      by: "local:#abc",
      nowMs: NOW,
    });
    expect(raised.ok).toBe(true);
    if (!raised.ok) throw new Error("unreachable");
    expect(raised.fold).toMatchObject({
      extensionsUsdMicros: 50,
      spentUsdMicros: 100,
      exhausted: false,
    });
    expect(readBudgetState(dir).state).toBe("absent");
    expect(await port.reserve({ id: "r3", usdMicros: 1 })).toEqual({ admit: true });
  });
});

describe("closed periods", () => {
  test("a closed period is summarized once, and its segments go after the next one closes", async () => {
    const dir = tempDir();
    const def: BudgetPeriodDef = { every: "day", usdMicros: 100 };
    const day1 = at("2026-11-01T12:00:00Z");
    await openBudgetLedger(dir, def, { now: () => day1 }).settle({ id: "a", usdMicros: 7 });
    expect(sweepBudgetPeriods(dir, def, day1)).toEqual({ summarized: [], removed: [] });
    const day3 = at("2026-11-03T12:00:00Z");
    expect(sweepBudgetPeriods(dir, def, day3)).toEqual({
      summarized: ["day-2026-11-01"],
      removed: [],
    });
    expect(sweepBudgetPeriods(dir, def, day3)).toEqual({ summarized: [], removed: [] });
    const day4 = at("2026-11-04T12:00:00Z");
    expect(sweepBudgetPeriods(dir, def, day4)).toEqual({
      summarized: [],
      removed: ["day-2026-11-01"],
    });
    const summary = readFileSync(join(dir, ".crewhaus/run/control/budget/periods.jsonl"), "utf8");
    expect(JSON.parse(summary.trim())).toMatchObject({
      periodId: "day-2026-11-01",
      spentUsdMicros: 7,
    });
  });
});

describe("the closed-period sweep never leaves the harness", () => {
  test("a period directory that is a link is neither read nor emptied", async () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "keep.txt"), "precious");
    writeFileSync(join(outside, "000001.jsonl"), "{}\n");
    const budget = join(dir, ".crewhaus/run/control/budget");
    mkdirSync(budget, { recursive: true });
    symlinkSync(outside, join(budget, "day-2026-01-01"));
    writeFileSync(
      join(budget, "periods.jsonl"),
      `${JSON.stringify({ v: 1, periodId: "day-2026-01-01", closedAt: "x", spentUsdMicros: 0, extensionsUsdMicros: 0, unknownCalls: 0, truncated: false })}\n`,
    );
    const def: BudgetPeriodDef = { every: "day", usdMicros: 100 };
    expect(sweepBudgetPeriods(dir, def, at("2026-11-04T12:00:00Z"))).toEqual({
      summarized: [],
      removed: [],
    });
    expect(readdirSync(outside).sort()).toEqual(["000001.jsonl", "keep.txt"]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("precious");
  });

  test("a link inside a period directory is left, and so is the directory", async () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "keep.txt"), "precious");
    const def: BudgetPeriodDef = { every: "day", usdMicros: 100 };
    await openBudgetLedger(dir, def, { now: () => at("2026-11-01T12:00:00Z") }).settle({
      id: "a",
      usdMicros: 1,
    });
    const seg = join(dir, ".crewhaus/run/control/budget/day-2026-11-01");
    symlinkSync(join(outside, "keep.txt"), join(seg, "000002.jsonl"));
    sweepBudgetPeriods(dir, def, at("2026-11-03T12:00:00Z"));
    expect(sweepBudgetPeriods(dir, def, at("2026-11-04T12:00:00Z")).removed).toEqual([]);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("precious");
    expect(existsSync(join(seg, "000001.jsonl"))).toBe(false);
  });
});

describe("the budget intake reason", () => {
  const STATE = {
    v: 1,
    periodId: "month-2026-11-01",
    exhaustedAt: "2026-11-17T08:00:00.000Z",
    renewsAt: "2026-12-01T00:00:00.000Z",
  };
  const before = at("2026-11-30T23:59:00Z");

  test("an exhausted period closes intake with budget_exceeded and the wait to renewal; after renewal it is open, with zero writes", () => {
    const dir = tempDir();
    plant(controlFile(dir, "budget-state.json"), jsonLine(STATE));
    const bytes = readFileSync(controlFile(dir, "budget-state.json"));
    const closed = intakeVerdict(dir, { now: () => before });
    expect(closed).toMatchObject({
      state: "closed",
      code: "budget_exceeded",
      exitName: "crewhaus_budget",
      retryAfter: 60,
      notice: "Its budget for this period is used up; this message was not processed.",
    });
    if (closed.state !== "closed") throw new Error("unreachable");
    expect(closed.reasons).toEqual([
      { kind: "budget", periodId: STATE.periodId, renewsAt: STATE.renewsAt },
    ]);
    expect(intakeVerdict(dir, { now: () => at("2026-12-01T00:00:00Z") })).toEqual({
      state: "open",
    });
    expect(readFileSync(controlFile(dir, "budget-state.json"))).toEqual(bytes);
  });

  test("an unreadable budget state closes nothing and says why without printing", () => {
    const dir = tempDir();
    plant(controlFile(dir, "budget-state.json"), "{ torn");
    const verdict = intakeVerdict(dir, { now: () => before });
    expect(verdict.state).toBe("open");
    expect(verdict.state === "open" && verdict.detail).toMatch(/budget state cannot be read/);
  });

  test("a paused AND exhausted harness keeps each reason: the operator wins the code, and lifting one leaves the other", () => {
    const dir = tempDir();
    plant(controlFile(dir, "budget-state.json"), jsonLine(STATE));
    plant(
      controlFile(dir, "operator.json"),
      jsonLine({
        v: 1,
        rev: 1,
        desired: "running",
        intake: { paused: true, since: "x" },
        deployment: null,
      }),
    );
    const both = intakeVerdict(dir, {
      now: () => before,
      read: () =>
        ({
          state: "present",
          record: { v: 1, rev: 1, desired: "running", intake: { paused: true }, deployment: null },
        }) as never,
    });
    expect(both).toMatchObject({ state: "closed", code: "paused" });
    if (both.state !== "closed") throw new Error("unreachable");
    expect(both.reasons.map((r) => r.kind).sort()).toEqual(["budget", "operator"]);
    // Resume lifts the pause: the budget reason stays.
    const resumed = intakeVerdict(dir, {
      now: () => before,
      read: () => ({ state: "absent" }) as never,
    });
    expect(resumed).toMatchObject({ state: "closed", code: "budget_exceeded" });
    // Renewal lifts the budget: the pause stays.
    const renewed = intakeVerdict(dir, {
      now: () => at("2026-12-02T00:00:00Z"),
      read: () =>
        ({
          state: "present",
          record: { v: 1, rev: 1, desired: "running", intake: { paused: true }, deployment: null },
        }) as never,
    });
    expect(renewed).toMatchObject({ state: "closed", code: "paused" });
  });

  test("a period in a zone carries the zone from the refusal to the reason, so its renewal reads as that local day", async () => {
    const dir = tempDir();
    const berlin: BudgetPeriodDef = { every: "month", usdMicros: 10, timezone: "Europe/Berlin" };
    const now = at("2026-11-19T12:00:00Z");
    const port = openBudgetLedger(dir, berlin, { now: () => now });
    await port.settle({ id: "x", usdMicros: 10 });
    expect(await port.reserve({ id: "y", usdMicros: 1 })).toEqual({ admit: false, on: "spent" });
    const state = readBudgetState(dir);
    expect(state.state === "present" && state.record).toMatchObject({
      renewsAt: "2026-11-30T23:00:00.000Z",
      timezone: "Europe/Berlin",
    });
    const verdict = intakeVerdict(dir, { now: () => now });
    expect(verdict.state === "closed" && verdict.reasons[0]).toMatchObject({
      kind: "budget",
      timezone: "Europe/Berlin",
    });
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(assertRunnable(dir, { mode: "run" })).toMatchObject({ timezone: "Europe/Berlin" });
    } finally {
      clock.mockRestore();
    }
    expect(foldBudget(dir, berlin, now).timezone).toBe("Europe/Berlin");
    expect(foldBudget(dir, { every: "month", usdMicros: 10 }, now).timezone).toBe("UTC");
    // The local day it renews on, not the UTC one.
    expect(renewalDay("2026-11-30T23:00:00.000Z", "Europe/Berlin")).toBe("1 Dec 2026");
    expect(renewalDay("2026-11-30T23:00:00.000Z", undefined)).toBe("30 Nov 2026");
    expect(renewalDay("2026-11-19T23:00:00.000Z", "Europe/Berlin", { year: false })).toBe("20 Nov");
    expect(renewalDay("2026-11-30T15:00:00.000Z", "Asia/Tokyo")).toBe("1 Dec 2026");
    expect(renewalDay("not a date", "UTC")).toBeUndefined();
  });

  test("a state written without a zone, or with one the runtime does not know, carries none", () => {
    const dir = tempDir();
    plant(controlFile(dir, "budget-state.json"), jsonLine({ ...STATE, timezone: "Mars/Olympus" }));
    const read = readBudgetState(dir);
    expect(read.state === "present" && "timezone" in read.record).toBe(false);
  });

  test("assertRunnable: a run refuses with budget_exceeded even with ignorePause; start and the REPL pass", () => {
    const dir = tempDir();
    writeBudgetState(dir, STATE as never);
    const clock = spyOn(Date, "now").mockReturnValue(before);
    try {
      const run = assertRunnable(dir, { mode: "run", ignorePause: true });
      expect(run).toEqual({
        ok: false,
        exitName: "budget_exceeded",
        reason: "budget",
        periodId: STATE.periodId,
        renewsAt: STATE.renewsAt,
      });
      expect(assertRunnable(dir, { mode: "start" })).toEqual({ ok: true });
      expect(assertRunnable(dir, { mode: "interactive" })).toEqual({ ok: true });
    } finally {
      clock.mockRestore();
    }
  });
});

describe("a reserve made inside a call still in progress", () => {
  const DEF: BudgetPeriodDef = { every: "month", usdMicros: 1_000 };
  const NOW = at("2026-11-17T08:00:00Z");

  test("never waits on that call's reservation, and closes no intake", async () => {
    const dir = tempDir();
    const live = probeOf(new Set([1]));
    const port = openBudgetLedger(dir, DEF, { now: () => NOW, pid: 1, host: "h", probe: live });
    expect(await port.reserve({ id: "A", usdMicros: 1_000 })).toEqual({ admit: true });
    // Without naming A the same reserve waits on it.
    const plain = await port.reserve({ id: "c0", usdMicros: 1 });
    expect(plain.admit === false && plain.on).toBe("others");
    expect(await port.reserve({ id: "c", usdMicros: 1, ancestors: ["A"] })).toEqual({
      admit: false,
      on: "spent",
      inFlight: true,
    });
    expect(existsSync(join(dir, ".crewhaus/run/control/budget-state.json"))).toBe(false);
  });

  test("a reservation this port holds open is in progress past its lease; another process reads it as held", async () => {
    const dir = tempDir();
    const live = probeOf(new Set([1, 2]));
    let clock = NOW;
    const mine = openBudgetLedger(dir, DEF, {
      now: () => clock,
      pid: 1,
      host: "h",
      probe: live,
      leaseMs: 60_000,
    });
    expect(await mine.reserve({ id: "A", usdMicros: 1_000 })).toEqual({ admit: true });
    clock = NOW + 120_000;
    const own = await mine.reserve({ id: "B", usdMicros: 1 });
    expect(own.admit === false && own.on).toBe("others");
    const theirs = openBudgetLedger(dir, DEF, { now: () => clock, pid: 2, host: "h", probe: live });
    expect(await theirs.reserve({ id: "C", usdMicros: 1 })).toEqual({
      admit: false,
      on: "spent",
      held: true,
    });
  });
});

describe("holders carry their start time", () => {
  const DEF: BudgetPeriodDef = { every: "month", usdMicros: 1_000 };
  const NOW = at("2026-11-17T08:00:00Z");
  const segment = (dir: string): string =>
    join(dir, ".crewhaus/run/control/budget/month-2026-11-01/000001.jsonl");

  test("a ledger opened with no probe records this process's start time", async () => {
    const dir = tempDir();
    await openBudgetLedger(dir, DEF, { now: () => NOW }).reserve({ id: "r", usdMicros: 1 });
    const line = JSON.parse(readFileSync(segment(dir), "utf8").trim()) as {
      holder?: { pid?: number; startedAt?: number };
    };
    expect(line.holder?.pid).toBe(process.pid);
    expect(typeof line.holder?.startedAt).toBe("number");
    const own = Date.now() - process.uptime() * 1000;
    expect(Math.abs((line.holder?.startedAt ?? 0) - own)).toBeLessThan(2_000);
  });

  test("a holder on this pid with another start time is another process: past its lease it no longer counts", async () => {
    const dir = tempDir();
    // Planted as if by an earlier process that had this pid.
    await openBudgetLedger(dir, DEF, {
      now: () => NOW,
      probe: { isAlive: () => true, startTimeMs: () => 1 },
      leaseMs: 1,
    }).reserve({ id: "old", usdMicros: 1_000 });
    const line = JSON.parse(readFileSync(segment(dir), "utf8").trim()) as {
      holder?: { pid?: number; host?: string; startedAt?: number };
    };
    expect(line.holder).toEqual({ pid: process.pid, startedAt: 1, host: hostname() });
    const later = NOW + 60_000;
    expect(
      await openBudgetLedger(dir, DEF, { now: () => later }).reserve({ id: "mine", usdMicros: 1 }),
    ).toEqual({
      admit: true,
    });
    // A probe that cannot tell start times keeps it held.
    const dir2 = tempDir();
    await openBudgetLedger(dir2, DEF, {
      now: () => NOW,
      probe: { isAlive: () => true, startTimeMs: () => 1 },
      leaseMs: 1,
    }).reserve({ id: "old", usdMicros: 1_000 });
    expect(
      await openBudgetLedger(dir2, DEF, { now: () => later, probe: defaultLeaseProbe }).reserve({
        id: "mine",
        usdMicros: 1,
      }),
    ).toEqual({ admit: false, on: "spent", held: true });
  });

  test("the system probe knows this process's own start time", () => {
    const own = systemLeaseProbe.startTimeMs(process.pid);
    expect(own).toBeDefined();
    expect(Math.abs((own ?? 0) - (Date.now() - process.uptime() * 1000))).toBeLessThan(2_000);
    expect(systemLeaseProbe.startTimeMs(0)).toBeUndefined();
  });

  test.if(process.platform !== "win32")(
    "another process's start time: read on Linux, could not tell elsewhere",
    async () => {
      const spawnedAt = Date.now();
      const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 10_000)"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const started = systemLeaseProbe.startTimeMs(child.pid);
        if (process.platform === "linux") {
          expect(started).toBeDefined();
          expect(Math.abs((started ?? 0) - spawnedAt)).toBeLessThan(2_000);
        } else {
          // It starts no program to ask, so another process's start is "could not tell".
          expect(started).toBeUndefined();
        }
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );
});

describe("a swapped period directory is left whole", () => {
  test("the sweep stops when the directory it checked is replaced, and removes nothing outside", async () => {
    const dir = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "000001.jsonl"), "precious\n");
    const def: BudgetPeriodDef = { every: "day", usdMicros: 100 };
    await openBudgetLedger(dir, def, { now: () => at("2026-11-01T12:00:00Z") }).settle({
      id: "a",
      usdMicros: 1,
    });
    sweepBudgetPeriods(dir, def, at("2026-11-03T12:00:00Z"));
    const stops: BudgetSweepStop[] = [];
    _setBudgetSweepSeamsForTest({
      beforeRemove: (period) => {
        renameSync(period, `${period}.moved`);
        symlinkSync(outside, period);
      },
      onStop: (reason) => {
        stops.push(reason);
      },
    });
    try {
      expect(sweepBudgetPeriods(dir, def, at("2026-11-04T12:00:00Z")).removed).toEqual([]);
    } finally {
      _setBudgetSweepSeamsForTest(undefined);
    }
    expect(stops).toEqual(["chain-changed"]);
    expect(readFileSync(join(outside, "000001.jsonl"), "utf8")).toBe("precious\n");
  });
});
