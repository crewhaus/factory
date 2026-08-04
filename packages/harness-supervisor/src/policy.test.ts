import { describe, expect, test } from "bun:test";
import { EXIT_CODES } from "@crewhaus/errors";
import {
  BACKOFF_CAP_MS,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  TERMINAL_EXIT_CODES,
  backoffDelayMs,
  classifyExit,
  createRestartWindow,
} from "./policy";
import { createFakeClock } from "./testkit";

describe("classifyExit", () => {
  test("our own stop reads as clean, whatever the child reported", () => {
    const c = classifyExit({
      exitCode: null,
      signal: "SIGTERM",
      operatorStop: true,
      longRunning: true,
    });
    expect(c.disposition).toBe("clean");
    expect(c.restartable).toBe(false);
    expect(c.title).toContain("operator");
  });

  test("exit 0 from a one-shot job is completion", () => {
    const c = classifyExit({ exitCode: 0, operatorStop: false, longRunning: false });
    expect(c.disposition).toBe("clean");
    expect(c.unexpectedClean).toBe(false);
    expect(c.restartable).toBe(false);
  });

  test("exit 0 from a daemon is 'exited cleanly (unexpected)' and restartable", () => {
    const c = classifyExit({ exitCode: 0, operatorStop: false, longRunning: true });
    expect(c.unexpectedClean).toBe(true);
    expect(c.title).toBe("exited cleanly (unexpected)");
    expect(c.restartable).toBe(true);
  });

  test("the unexpected-clean restart can be switched off", () => {
    const c = classifyExit({
      exitCode: 0,
      operatorStop: false,
      longRunning: true,
      restartUnexpectedCleanExit: false,
    });
    expect(c.restartable).toBe(false);
  });

  for (const [name, code] of [
    ["spec", EXIT_CODES.spec],
    ["config", EXIT_CODES.config],
    ["auth", EXIT_CODES.auth],
    ["billing", EXIT_CODES.billing],
    ["crewhaus budget", EXIT_CODES.crewhaus_budget],
  ] as const) {
    test(`exit ${code} (${name}) is terminal and NEVER restartable`, () => {
      const c = classifyExit({ exitCode: code, operatorStop: false, longRunning: true });
      expect(c.disposition).toBe("terminal");
      expect(c.restartable).toBe(false);
      expect(c.title.length).toBeGreaterThan(0);
    });
  }

  test("the terminal set is exactly 20/21/30/31/33", () => {
    expect([...TERMINAL_EXIT_CODES].sort((a, b) => a - b)).toEqual([20, 21, 30, 31, 33]);
  });

  test("billing (31) carries the billing failure class for the remediation card", () => {
    const c = classifyExit({
      exitCode: EXIT_CODES.billing,
      operatorStop: false,
      longRunning: true,
    });
    expect(c.failureClass).toBe("billing");
  });

  test("budget (33) is terminal because a restart would re-arm the spend", () => {
    const c = classifyExit({
      exitCode: EXIT_CODES.crewhaus_budget,
      operatorStop: false,
      longRunning: true,
    });
    expect(c.disposition).toBe("terminal");
    expect(c.restartable).toBe(false);
    expect(c.failureClass).toBe("crewhaus_budget");
  });

  test("exit 36 parks instead of failing", () => {
    const c = classifyExit({
      exitCode: EXIT_CODES.approval_pending,
      operatorStop: false,
      longRunning: true,
    });
    expect(c.disposition).toBe("parked");
    expect(c.restartable).toBe(false);
    expect(c.failureClass).toBe("approval_pending");
  });

  test("rate limit (32) and tool failure (40) crash and are restartable for daemons", () => {
    for (const code of [EXIT_CODES.rate_limit, EXIT_CODES.tool]) {
      const c = classifyExit({ exitCode: code, operatorStop: false, longRunning: true });
      expect(c.disposition).toBe("crash");
      expect(c.restartable).toBe(true);
    }
  });

  test("a one-shot job is never restarted, whatever it crashed with", () => {
    const c = classifyExit({ exitCode: EXIT_CODES.tool, operatorStop: false, longRunning: false });
    expect(c.disposition).toBe("crash");
    expect(c.restartable).toBe(false);
  });

  test("a signal death names the signal", () => {
    const c = classifyExit({
      exitCode: null,
      signal: "SIGSEGV",
      operatorStop: false,
      longRunning: true,
    });
    expect(c.disposition).toBe("crash");
    expect(c.title).toContain("SIGSEGV");
  });
});

describe("backoffDelayMs", () => {
  test("doubles from 500 ms and caps at 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelayMs(n))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(backoffDelayMs(50)).toBe(BACKOFF_CAP_MS);
  });
});

describe("createRestartWindow", () => {
  test("allows five restarts then reports exhaustion", () => {
    const clock = createFakeClock();
    const window = createRestartWindow(clock);
    for (let i = 0; i < MAX_RESTARTS_PER_WINDOW; i++) {
      expect(window.exhausted()).toBe(false);
      window.record();
      clock.advance(1_000);
    }
    expect(window.count()).toBe(MAX_RESTARTS_PER_WINDOW);
    expect(window.exhausted()).toBe(true);
  });

  test("the window ROLLS — old restarts fall out", () => {
    const clock = createFakeClock();
    const window = createRestartWindow(clock);
    for (let i = 0; i < MAX_RESTARTS_PER_WINDOW; i++) window.record();
    expect(window.exhausted()).toBe(true);
    clock.advance(RESTART_WINDOW_MS + 1);
    expect(window.count()).toBe(0);
    expect(window.exhausted()).toBe(false);
  });

  test("nextExpiryMs is when the oldest restart ages out", () => {
    const clock = createFakeClock(1_000);
    const window = createRestartWindow(clock);
    expect(window.nextExpiryMs()).toBeUndefined();
    window.record();
    expect(window.nextExpiryMs()).toBe(1_000 + RESTART_WINDOW_MS);
  });
});
