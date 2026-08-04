/**
 * The few tests that spawn REAL processes.
 *
 * Everything else in this package runs against injected seams; these four
 * exist because signals, process start times, and fd-redirected stdout are
 * exactly the things a fake cannot prove. They spawn tiny fixture scripts —
 * never a harness — and every one carries an explicit timeout.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES } from "@crewhaus/errors";
import { verifyRunfile } from "./adoption";
import { argvFingerprint, createPosixProcessOps } from "./process-ops";
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
