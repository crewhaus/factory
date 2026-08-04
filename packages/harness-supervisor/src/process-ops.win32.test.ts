/**
 * HM-188 — the Windows adapter, executed on Windows.
 *
 * `createWindowsProcessOps` shipped with the process layer, but its output
 * PARSERS are all that the rest of the suite proves: they are unit-tested
 * against captured strings, which says nothing about whether PowerShell is
 * reachable from a spawned child, whether `Get-Process` answers for a pid we
 * just created, or whether `taskkill` actually ends it. Those are the three
 * facts liveness is made of (`pid + OS start-time + argv`), and a WRONG
 * liveness verdict is the failure with real consequences: it is what lets a
 * restart spawn a second copy of a channel daemon — double message
 * processing and double provider spend.
 *
 * So this file spawns ONE real child on Windows and asks the real adapter
 * about it, mirroring `spawn-integration.test.ts` (which pins the POSIX
 * adapter and skips here for the same reason this one skips there). Every
 * test carries an explicit timeout; the fixture is a tiny script, never a
 * harness. It is the suite the `windows-supervision` CI job exists to run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRunfile } from "./adoption";
import { argvFingerprint, argvMatchesCommandLine, createWindowsProcessOps } from "./process-ops";
import { ensureRunDir, runLogPath } from "./runfiles";
import { RUNFILE_VERSION } from "./types";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const BUN = process.execPath;
const TIMEOUT_MS = 60_000;

const roots: string[] = [];
const strays: number[] = [];

function tempHarness(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-win-"));
  roots.push(dir);
  ensureRunDir(dir);
  return dir;
}

afterEach(() => {
  const ops = createWindowsProcessOps();
  // Belt and braces: a test that failed mid-way must not leave a sleeper
  // behind on a shared runner.
  for (const pid of strays.splice(0)) ops.forceKill(pid);
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(process.platform !== "win32")("windows adapter, on windows", () => {
  test(
    "a real child is alive, dated, and identified — and its death is seen",
    async () => {
      const dir = tempHarness();
      const ops = createWindowsProcessOps();
      const argv = [BUN, join(FIXTURES, "long-sleeper.ts")];
      const logPath = join(dir, ".crewhaus", "run", "logs", "win.log");
      const child = ops.spawn({
        argv,
        cwd: dir,
        env: {
          PATH: process.env["PATH"] ?? "",
          // A spawn on Windows inherits nothing it is not given: PATHEXT and
          // SystemRoot are what let the child resolve programs at all.
          PATHEXT: process.env["PATHEXT"] ?? "",
          SystemRoot: process.env["SystemRoot"] ?? "",
        },
        stdio: { mode: "file", path: logPath },
        detached: true,
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error("no pid");
      strays.push(pid);

      // 1. The fd-redirected log really is written by the CHILD.
      await waitFor(
        () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("fixture: pid"),
        20_000,
        "the child's log output",
      );

      // 2. Liveness: Get-Process must answer for a pid we just created. If
      //    this is false the supervisor believes a live daemon is dead, and
      //    a restart runs a second one.
      await waitFor(() => ops.isAlive(pid), 20_000, "Get-Process to see the child");
      expect(ops.isAlive(pid)).toBe(true);

      // 3. Start time: parsed from PowerShell's round-trip format, and
      //    plausibly now (the child was spawned inside this test).
      const startTimeMs = ops.startTimeMs(pid);
      expect(startTimeMs).toBeDefined();
      expect(Math.abs((startTimeMs as number) - Date.now())).toBeLessThan(5 * 60_000);

      // 4. Command line: WMI reports it, and it still contains our argv in
      //    order (the check that survives a recycled pid).
      const commandLine = ops.commandLine(pid);
      expect(commandLine).toBeDefined();
      expect(argvMatchesCommandLine(commandLine as string, argv)).toBe(true);

      // 5. All three together: the runfile verifies LIVE and VERIFIED — no
      //    "probe unavailable, err toward live" fallback on this platform.
      const runfile = {
        v: RUNFILE_VERSION,
        pid,
        pidStartTimeMs: startTimeMs as number,
        argvFingerprint: argvFingerprint(dir, argv),
        entry: "long-sleeper.ts",
        bundleDir: FIXTURES,
        runId: "run_0123456789abcdef",
        startedAt: new Date().toISOString(),
        managerVersion: "0.5.0-test",
      };
      const verdict = verifyRunfile(runfile, ops, { expectedArgv: argv });
      expect(verdict.live).toBe(true);
      expect(verdict.verified).toBe(true);

      // 6. The two ways a recycled pid is caught still catch it here.
      expect(verifyRunfile({ ...runfile, pidStartTimeMs: 1 }, ops).reason).toBe(
        "start-time-mismatch",
      );
      expect(
        verifyRunfile(runfile, ops, { expectedArgv: [BUN, "C:\\nowhere\\other.ts"] }).reason,
      ).toBe("argv-mismatch");

      // 7. Death: taskkill /F ends the tree, and every probe agrees.
      ops.forceKill(pid);
      await child.exited;
      await waitFor(() => !ops.isAlive(pid), 20_000, "the child to die");
      expect(ops.startTimeMs(pid)).toBeUndefined();
      expect(verifyRunfile(runfile, ops).reason).toBe("pid-dead");
    },
    TIMEOUT_MS,
  );

  test(
    "probes of a pid that never existed are undefined, not a guess",
    () => {
      const ops = createWindowsProcessOps();
      // A pid far outside the plausible range: every probe must say "gone"
      // rather than throw or invent a value.
      const gone = 0x7ff0_0000;
      expect(ops.isAlive(gone)).toBe(false);
      expect(ops.startTimeMs(gone)).toBeUndefined();
      expect(ops.commandLine(gone)).toBeUndefined();
      // terminate/forceKill on a dead pid are no-ops, never throws.
      expect(() => ops.terminate(gone)).not.toThrow();
      expect(() => ops.forceKill(gone)).not.toThrow();
    },
    TIMEOUT_MS,
  );

  test(
    "the graceful path is best-effort on Windows, and the log survives it",
    async () => {
      // `taskkill` WITHOUT /F posts a close request, which a console child
      // is free to ignore — which is exactly why the signal-free control.v1
      // drain endpoint is the graceful path on this platform and taskkill /F
      // is the escalation behind it. The contract asserted here is the
      // honest one: terminate() never throws and never corrupts the run log;
      // it is not promised to end a console process.
      const dir = tempHarness();
      const ops = createWindowsProcessOps();
      const logPath = runLogPath(dir, "run_00000000000000ff");
      const child = ops.spawn({
        argv: [BUN, join(FIXTURES, "long-sleeper.ts")],
        cwd: dir,
        env: {
          PATH: process.env["PATH"] ?? "",
          PATHEXT: process.env["PATHEXT"] ?? "",
          SystemRoot: process.env["SystemRoot"] ?? "",
        },
        stdio: { mode: "file", path: logPath },
        detached: true,
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error("no pid");
      strays.push(pid);
      await waitFor(
        () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("fixture: pid"),
        20_000,
        "the child's log output",
      );
      expect(() => ops.terminate(pid)).not.toThrow();
      ops.forceKill(pid);
      await child.exited;
      await waitFor(() => !ops.isAlive(pid), 20_000, "the child to die");
      expect(readFileSync(logPath, "utf8")).toContain(`fixture: pid ${pid}`);
    },
    TIMEOUT_MS,
  );
});
