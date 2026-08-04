/**
 * The few tests that spawn REAL processes.
 *
 * Everything else in this package runs against injected seams; these exist
 * because signals, process start times, fd-redirected stdout — and whether a
 * manager process actually EXITS — are exactly the things a fake cannot
 * prove. They spawn tiny fixture scripts, never a harness, and every one
 * carries an explicit timeout.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "@crewhaus/errors";
import { verifyRunfile } from "./adoption";
import { type ProcessOps, argvFingerprint, createPosixProcessOps } from "./process-ops";
import { ensureRunDir, readRunLedger, runLogPath } from "./runfiles";
import type { SpawnPlan } from "./spawn-contracts";
import { createHarnessSupervisor } from "./supervisor";
import { RUNFILE_VERSION } from "./types";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN = process.execPath;
const TIMEOUT_MS = 20_000;

const roots: string[] = [];
function tempHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-spawn-real-"));
  roots.push(dir);
  ensureRunDir(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixturePlan(
  dir: string,
  fixture: string,
  args: readonly string[] = [],
  over: Partial<SpawnPlan> = {},
): SpawnPlan {
  return {
    runClass: "daemon",
    kind: "daemon",
    argv: [BUN, join(FIXTURES, fixture), ...args],
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "", CREWHAUS_TRACE: "json", CREWHAUS_COST_TRACKING: "1" },
    envFiles: [],
    overrides: [],
    detached: true,
    stdio: "file",
    launchMode: "compiled",
    canResume: false,
    supervised: true,
    entry: fixture,
    bundleDir: FIXTURES,
    ports: {},
    ...over,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(process.platform === "win32")("real spawns", () => {
  test(
    "a real exit 31 is classified terminal and is never restarted",
    async () => {
      const dir = tempHarness();
      const ops = createPosixProcessOps();
      const supervisor = createHarnessSupervisor({
        harnessDir: dir,
        target: "channel",
        ops,
        plan: () => fixturePlan(dir, "exit-with.ts", [String(EXIT_CODES.billing)]),
        pumpIntervalMs: 50,
      });
      const started = await supervisor.start();
      expect(started.ok).toBe(true);
      await waitFor(() => supervisor.snapshot().state === "terminal", 10_000, "terminal state");
      expect(supervisor.snapshot().lastExit?.failureClass).toBe("billing");
      // Give a restart every chance to happen; it must not.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(supervisor.snapshot().state).toBe("terminal");
      expect(readRunLedger(dir)).toHaveLength(1);
      expect(readRunLedger(dir)[0]?.exitCode).toBe(EXIT_CODES.billing);
      supervisor.close();
    },
    TIMEOUT_MS,
  );

  test(
    "real interleaved stdout is split into events and prose, torn line included",
    async () => {
      const dir = tempHarness();
      const ops = createPosixProcessOps();
      const events: Array<Record<string, unknown>> = [];
      let prose = "";
      const supervisor = createHarnessSupervisor({
        harnessDir: dir,
        target: "workflow",
        ops,
        plan: () =>
          fixturePlan(dir, "emit-traces.ts", [], {
            runClass: "one-shot",
            kind: "job",
            supervised: false,
          }),
        pumpIntervalMs: 50,
      });
      supervisor.subscribe((event) => {
        if (event.type === "output") {
          prose += event.prose;
          events.push(...event.events);
        }
      });
      await supervisor.start();
      await waitFor(() => supervisor.snapshot().state === "stopped", 10_000, "the job to finish");
      await waitFor(() => events.length >= 3, 5_000, "all three events");

      const kinds = events.map((e) => e["kind"]);
      expect(kinds).toContain("run_start");
      expect(kinds).toContain("role_start"); // run-id-less crew kind
      expect(kinds).toContain("turn_end"); // the line torn across two writes
      // Prose survives, braces and all; no event JSON leaked into it.
      expect(prose).toContain("banner: starting up { not an event }");
      expect(prose).toContain("here is a brace { and a close } inline");
      expect(prose).not.toContain('"kind":"run_start"');
      supervisor.close();
    },
    TIMEOUT_MS,
  );

  test(
    "an ATTACHED run tees its pipes into the same durable log the pump reads",
    async () => {
      const dir = tempHarness();
      const ops = createPosixProcessOps();
      const events: Array<Record<string, unknown>> = [];
      const supervisor = createHarnessSupervisor({
        harnessDir: dir,
        target: "cli",
        ops,
        plan: () =>
          fixturePlan(dir, "emit-traces.ts", [], {
            runClass: "interactive",
            kind: "interactive",
            supervised: false,
            detached: false,
            stdio: "pipe",
          }),
        pumpIntervalMs: 50,
      });
      supervisor.subscribe((event) => {
        if (event.type === "output") events.push(...event.events);
      });
      await supervisor.start();
      const runId = supervisor.snapshot().runId as string;
      await waitFor(() => supervisor.snapshot().state === "stopped", 10_000, "the run to finish");
      await waitFor(() => events.length >= 3, 5_000, "the events");
      // The piped output landed in logs/<runId>.log, exactly where a
      // detached daemon's fd would have written it.
      const log = readFileSync(runLogPath(dir, runId), "utf8");
      expect(log).toContain("banner: starting up");
      expect(log).toContain('"kind":"run_start"');
      supervisor.close();
    },
    TIMEOUT_MS,
  );

  test(
    "a child that ignores SIGTERM is SIGKILLed after the grace and recorded forced",
    async () => {
      const dir = tempHarness();
      const ops = createPosixProcessOps();
      const supervisor = createHarnessSupervisor({
        harnessDir: dir,
        target: "channel",
        ops,
        plan: () => fixturePlan(dir, "ignore-sigterm.ts"),
        pumpIntervalMs: 50,
        stopGraceMs: 400,
      });
      await supervisor.start();
      const runId = supervisor.snapshot().runId as string;
      // Wait for the fixture to ANNOUNCE itself: its SIGTERM handler is
      // installed at that point, and signalling before then would just be
      // testing the default disposition.
      await waitFor(
        () => readFileSync(runLogPath(dir, runId), "utf8").includes("fixture: up"),
        5_000,
        "the fixture to install its handler",
      );
      const result = await supervisor.stop();
      expect(result.forced).toBe(true);
      await waitFor(() => readRunLedger(dir)[0]?.endedAt !== undefined, 5_000, "the ledger close");
      expect(readRunLedger(dir)[0]?.forced).toBe(true);
      supervisor.close();
    },
    TIMEOUT_MS,
  );

  test(
    "a real pid's start time and command line verify a runfile — and pid death invalidates it",
    async () => {
      const dir = tempHarness();
      const ops = createPosixProcessOps();
      const argv = [BUN, join(FIXTURES, "long-sleeper.ts")];
      const child = ops.spawn({
        argv,
        cwd: dir,
        env: { PATH: process.env["PATH"] ?? "" },
        stdio: { mode: "file", path: join(dir, ".crewhaus", "run", "logs", "real.log") },
        detached: true,
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error("no pid");
      try {
        await waitFor(() => ops.startTimeMs(pid) !== undefined, 5_000, "a readable start time");
        const startTimeMs = ops.startTimeMs(pid) as number;
        const runfile = {
          v: RUNFILE_VERSION,
          pid,
          pidStartTimeMs: startTimeMs,
          argvFingerprint: argvFingerprint(dir, argv),
          entry: "long-sleeper.ts",
          bundleDir: FIXTURES,
          runId: "run_0123456789abcdef",
          startedAt: new Date().toISOString(),
          managerVersion: "0.5.0-test",
        };
        expect(verifyRunfile(runfile, ops, { expectedArgv: argv }).live).toBe(true);
        // A start time from another launch is rejected — the pid-reuse guard.
        expect(
          verifyRunfile({ ...runfile, pidStartTimeMs: startTimeMs - 600_000 }, ops).reason,
        ).toBe("start-time-mismatch");
        // A different command on the same pid is rejected too.
        expect(
          verifyRunfile(runfile, ops, { expectedArgv: [BUN, "/nowhere/other.ts"] }).reason,
        ).toBe("argv-mismatch");

        ops.forceKill(pid);
        await child.exited;
        await waitFor(() => !ops.isAlive(pid), 5_000, "the fixture to die");
        expect(verifyRunfile(runfile, ops).reason).toBe("pid-dead");
      } finally {
        ops.forceKill(pid);
      }
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Manager shutdown — the one thing only a real process can prove
// ---------------------------------------------------------------------------

const MANAGER_TIMEOUT_MS = 60_000;

function statusLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

/**
 * A `ProcessOps` whose `ps` probe runs in the SAME timezone this process
 * parses in.
 *
 * `ps -o lstart=` formats the start time in the zone of the `ps` process and
 * prints no zone at all, so reader and printer must agree. Ordinarily they
 * do. Under `bun test` they do not: the runner pins its own interpreter to
 * UTC WITHOUT exporting `TZ`, so a `ps` it spawns prints local time which the
 * runner then reads as UTC — hours away from the same instant recorded by
 * the fixture, which is an ordinary self-consistent process. Every adoption
 * across that boundary then fails `start-time-mismatch`. Only the tests that
 * compare a start time against ANOTHER process's recording need this; a test
 * that only compares its own readings is wrong in both places and cancels
 * out.
 */
function zoneAlignedOps(): ProcessOps {
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return createPosixProcessOps({
    run: (cmd, args) => {
      const res = spawnSync(cmd, [...args], {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, TZ },
      });
      return res.status === 0 && typeof res.stdout === "string" ? res.stdout : undefined;
    },
  });
}

/** Await a promise, or throw with a useful label. Never leaves a timer
 *  behind — a leaked handle would keep THIS test process alive too. */
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

describe.skipIf(process.platform === "win32")("manager shutdown", () => {
  test(
    "the manager EXITS while children live: the daemon survives adoptable, the attached child is forced",
    async () => {
      const daemonDir = tempHarness();
      const attachedDir = tempHarness();
      const statusFile = join(daemonDir, "manager-status.log");
      const ops = zoneAlignedOps();

      // A miniature manager supervising one detached daemon and one ATTACHED
      // run whose pipes are what used to keep the real manager's event loop
      // open after `server.stop()`. The fixture calls `runManagerShutdown`
      // on SIGTERM and then RETURNS — it never calls `process.exit`, so a
      // shutdown that fails to reach the attached child leaves it alive and
      // this test times out. That is the bug, reproduced.
      const manager = Bun.spawn({
        cmd: [BUN, join(FIXTURES, "mini-manager.ts"), daemonDir, attachedDir, statusFile],
        stdout: "ignore",
        stderr: "pipe",
      });

      let daemonPid = 0;
      let attachedPid = 0;
      try {
        await waitFor(
          () => statusLines(statusFile).some((line) => line.startsWith("up ")),
          20_000,
          "the mini-manager to boot both children",
        );
        const up = statusLines(statusFile).find((line) => line.startsWith("up ")) as string;
        const [, daemonRaw, attachedRaw] = up.split(" ");
        daemonPid = Number(daemonRaw);
        attachedPid = Number(attachedRaw);
        expect(daemonPid).toBeGreaterThan(0);
        expect(attachedPid).toBeGreaterThan(0);
        expect(ops.isAlive(daemonPid)).toBe(true);
        expect(ops.isAlive(attachedPid)).toBe(true);

        manager.kill("SIGTERM");
        // THE assertion. Before M4 this never resolved: the manager released
        // its lock and its port and then lived on for hours.
        await within(manager.exited, 30_000, "the manager to exit");

        // The daemon SURVIVED — it is runfile-tracked and re-adoptable, so
        // taking it down with the console would be the worse failure.
        expect(ops.isAlive(daemonPid)).toBe(true);
        // The attached run did NOT survive: it ignores SIGTERM, so the
        // grace escalated to SIGKILL rather than orphaning it.
        await waitFor(() => !ops.isAlive(attachedPid), 10_000, "the attached child to die");
        await waitFor(
          () => readRunLedger(attachedDir)[0]?.endedAt !== undefined,
          10_000,
          "the attached run's ledger row to close",
        );
        expect(readRunLedger(attachedDir)[0]?.forced).toBe(true);
        expect(statusLines(statusFile)).toContain("down");

        // …and the next manager picks the daemon back up, resuming its log
        // from the persisted cursor rather than replaying the banner the
        // previous manager already delivered.
        const replayed: string[] = [];
        const next = createHarnessSupervisor({
          harnessDir: daemonDir,
          target: "channel",
          ops,
          plan: () => fixturePlan(daemonDir, "long-sleeper.ts"),
          pumpIntervalMs: 50,
        });
        next.subscribe((event) => {
          if (event.type === "output") replayed.push(event.prose);
        });
        expect(await next.adopt()).toBe("adopted");
        next.pumpNow();
        expect(next.snapshot().state).toBe("running");
        expect(next.snapshot().pid).toBe(daemonPid);
        expect(replayed.join("")).not.toContain("fixture: pid");
        next.close();
      } finally {
        manager.kill("SIGKILL");
        if (daemonPid > 0) ops.forceKill(daemonPid);
        if (attachedPid > 0) ops.forceKill(attachedPid);
      }
    },
    MANAGER_TIMEOUT_MS,
  );
});
