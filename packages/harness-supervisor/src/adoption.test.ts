import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptRunning, verifyRunfile } from "./adoption";
import { argvFingerprint } from "./process-ops";
import {
  appendRunLedger,
  ensureRunDir,
  readRunLedger,
  readRunfile,
  runEventsPath,
  runLogPath,
  writeRunfile,
} from "./runfiles";
import { createEnvScrubber } from "./scrub";
import { createFakeProcessOps } from "./testkit";
import { createLogPump, replayRunEvents } from "./trace-pump";
import { type DaemonRunfile, RUNFILE_VERSION } from "./types";

const roots: string[] = [];
function tempHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-adopt-"));
  roots.push(dir);
  ensureRunDir(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = "run_0123456789abcdef";
const ARGV = ["bun", "/h/dist/daemon.ts"];
const START = 1_700_000_000_000;

function seedRunning(dir: string, over: Partial<DaemonRunfile> = {}): DaemonRunfile {
  const runfile: DaemonRunfile = {
    v: RUNFILE_VERSION,
    pid: 4242,
    pidStartTimeMs: START,
    argvFingerprint: argvFingerprint(dir, ARGV),
    entry: "daemon.ts",
    bundleDir: join(dir, "dist"),
    runId: RUN_ID,
    startedAt: "2026-08-04T00:00:00.000Z",
    managerVersion: "0.5.0",
    ...over,
  };
  writeRunfile(dir, runfile);
  appendRunLedger(dir, {
    runId: runfile.runId,
    kind: "daemon",
    argv: ARGV,
    startedAt: runfile.startedAt,
    logFile: `logs/${runfile.runId}.log`,
  });
  return runfile;
}

describe("verifyRunfile", () => {
  test("live when the pid, the start time, and the command line all agree", () => {
    const ops = createFakeProcessOps();
    ops.register(4242, START, ARGV.join(" "));
    const dir = tempHarness();
    const verdict = verifyRunfile(seedRunning(dir), ops, { expectedArgv: ARGV });
    expect(verdict.live).toBe(true);
    expect(verdict.verified).toBe(true);
  });

  test("no runfile is not live", () => {
    expect(verifyRunfile(undefined, createFakeProcessOps()).reason).toBe("no-runfile");
  });

  test("a dead pid is not live", () => {
    const dir = tempHarness();
    const verdict = verifyRunfile(seedRunning(dir), createFakeProcessOps());
    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe("pid-dead");
  });

  test("PID REUSE is rejected by the start-time mismatch", () => {
    const ops = createFakeProcessOps();
    // Same pid, but the process started long after the runfile was written.
    ops.register(4242, START + 60_000, "some-other-program");
    const dir = tempHarness();
    const verdict = verifyRunfile(seedRunning(dir), ops);
    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe("start-time-mismatch");
    expect(verdict.observedStartTimeMs).toBe(START + 60_000);
  });

  test("a start time inside the tolerance still matches (ps reports seconds)", () => {
    const ops = createFakeProcessOps();
    ops.register(4242, START + 999, ARGV.join(" "));
    const dir = tempHarness();
    expect(verifyRunfile(seedRunning(dir), ops).live).toBe(true);
  });

  test("a recycled pid that survives the start-time check fails the argv check", () => {
    const ops = createFakeProcessOps();
    ops.register(4242, START, "python /usr/bin/unrelated");
    const dir = tempHarness();
    const verdict = verifyRunfile(seedRunning(dir), ops, { expectedArgv: ARGV });
    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe("argv-mismatch");
    expect(verdict.observedCommandLine).toContain("unrelated");
  });

  test("a runfile for a DIFFERENT plan reads as stale when a fingerprint is supplied", () => {
    const ops = createFakeProcessOps();
    ops.register(4242, START, ARGV.join(" "));
    const dir = tempHarness();
    const verdict = verifyRunfile(seedRunning(dir), ops, {
      expectedFingerprint: argvFingerprint(dir, ["bun", "other.ts"]),
    });
    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe("plan-mismatch");
  });

  test("an unreadable start time errs toward LIVE but reports itself unverified", () => {
    const ops = createFakeProcessOps();
    const dir = tempHarness();
    const runfile = seedRunning(dir);
    // Alive, but the platform will not report a start time or command line.
    const blindOps = {
      ...ops,
      startTimeMs: () => undefined,
      commandLine: () => undefined,
      isAlive: () => true,
    };
    const verdict = verifyRunfile(runfile, blindOps, { expectedArgv: ARGV });
    expect(verdict.live).toBe(true);
    expect(verdict.verified).toBe(false);
  });

  test("a restored backup fails the start-time check harmlessly", () => {
    const ops = createFakeProcessOps();
    ops.register(4242, Date.now(), ARGV.join(" "));
    const dir = tempHarness();
    // The backup carries a start time from another machine/boot.
    const verdict = verifyRunfile(seedRunning(dir, { pidStartTimeMs: 1 }), ops);
    expect(verdict.live).toBe(false);
    expect(verdict.reason).toBe("start-time-mismatch");
  });
});

describe("adoptRunning", () => {
  test("no runfile → nothing to adopt", () => {
    expect(adoptRunning(tempHarness(), { ops: createFakeProcessOps() }).status).toBe("none");
  });

  test("a stale runfile is cleared, the run is closed, and the tail is attached", () => {
    const dir = tempHarness();
    const runfile = seedRunning(dir);
    writeFileSync(runLogPath(dir, runfile.runId), "boot\ncrash: out of memory\n");
    const result = adoptRunning(dir, { ops: createFakeProcessOps() });
    expect(result.status).toBe("lost");
    if (result.status !== "lost") throw new Error("unreachable");
    expect(result.reason).toBe("pid-dead");
    expect(result.tail).toEqual(["boot", "crash: out of memory"]);
    // The ghost runfile must not block the next start.
    expect(readRunfile(dir)).toBeUndefined();
    expect(readRunLedger(dir)[0]?.failureClass).toBe("interrupted");
  });

  test("the lost tail is scrubbed", () => {
    const dir = tempHarness();
    const runfile = seedRunning(dir);
    const secret = ["sk", "fixture", "5555444433332222"].join("-");
    writeFileSync(runLogPath(dir, runfile.runId), `boom with ${secret}\n`);
    const result = adoptRunning(dir, {
      ops: createFakeProcessOps(),
      scrub: createEnvScrubber({ ANTHROPIC_API_KEY: secret }),
    });
    if (result.status !== "lost") throw new Error("expected lost");
    expect(result.tail.join("\n")).not.toContain(secret);
  });

  test("clearStale:false leaves the evidence in place for an inspector", () => {
    const dir = tempHarness();
    seedRunning(dir);
    const result = adoptRunning(dir, { ops: createFakeProcessOps(), clearStale: false });
    expect(result.status).toBe("lost");
    expect(readRunfile(dir)).toBeDefined();
  });

  test("the ledger's argv is used for the command-line check without caller help", () => {
    const ops = createFakeProcessOps();
    ops.register(4242, START, "python /usr/bin/unrelated");
    const dir = tempHarness();
    seedRunning(dir);
    const result = adoptRunning(dir, { ops });
    expect(result.status).toBe("lost");
    if (result.status !== "lost") throw new Error("unreachable");
    expect(result.reason).toBe("argv-mismatch");
  });

  test("a live daemon is adopted with a pump positioned at the cursor", () => {
    const ops = createFakeProcessOps();
    ops.register(4242, START, ARGV.join(" "));
    const dir = tempHarness();
    seedRunning(dir);
    writeFileSync(runLogPath(dir, RUN_ID), "hello\n");
    const result = adoptRunning(dir, { ops });
    expect(result.status).toBe("adopted");
    if (result.status !== "adopted") throw new Error("unreachable");
    expect(result.pump.pumpOnce().prose).toBe("hello\n");
  });

  test("MANAGER RESTART: adoption resumes the log with byte-exact continuity", () => {
    const ops = createFakeProcessOps();
    ops.register(4242, START, ARGV.join(" "));
    const dir = tempHarness();
    seedRunning(dir);
    const logFile = runLogPath(dir, RUN_ID);
    const event = (turn: number): string =>
      JSON.stringify({ kind: "turn_end", runId: RUN_ID, turn });

    // Manager #1 pumps the first stretch.
    writeFileSync(logFile, `start\n${event(1)}\n`);
    const firstPump = createLogPump({
      logFile,
      eventsFile: runEventsPath(dir, RUN_ID),
      cursorFile: join(dir, ".crewhaus", "run", "logs", `${RUN_ID}.cursor`),
    });
    const firstOut = firstPump.pumpOnce();
    // …and dies after persisting an event but before writing its cursor.
    appendFileSync(runEventsPath(dir, RUN_ID), `${event(99)}\n`);

    // The daemon keeps writing while no manager is watching.
    appendFileSync(logFile, `middle\n${event(2)}\nend\n`);

    // Manager #2 adopts.
    const result = adoptRunning(dir, { ops });
    if (result.status !== "adopted") throw new Error("expected adopted");
    const secondOut = result.pump.pumpOnce();

    expect(firstOut.prose + secondOut.prose).toBe("start\n\nmiddle\n\nend\n");
    expect([...firstOut.events, ...secondOut.events].map((e) => e["turn"])).toEqual([1, 2]);
    // Nothing duplicated, nothing lost, and the crash-written 99 is gone.
    expect(replayRunEvents(runEventsPath(dir, RUN_ID)).map((e) => e["turn"])).toEqual([1, 2]);
  });
});
