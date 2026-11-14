/**
 * Reboot recovery's verdict, one reason at a time, and the start it leads to: the
 * automatic path, which runs only the active build and never records what a person wants.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { argvFingerprint } from "./process-ops";
import { rebootVerdict } from "./reboot";
import { appendRunLedger, writeRunfile, writeSupervisionRecord } from "./runfiles";
import { buildSpawnPlan } from "./spawn-contracts";
import { type SupervisorOptions, createHarnessSupervisor } from "./supervisor";
import { activateBuildForTest, createFakeClock, createFakeProcessOps } from "./testkit";
import { RUNFILE_VERSION } from "./types";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const OPERATOR = join(".crewhaus", "run", "control", "operator.json");

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function operator(dir: string, body: Record<string, unknown> = {}): void {
  put(dir, OPERATOR, `${JSON.stringify({ v: 1, rev: 1, desired: "running", ...body })}\n`);
}

/** A harness a person last started: active, autostart, desired running. */
function startedByAPerson(): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-reboot-"));
  roots.push(dir);
  put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n");
  put(dir, "dist/daemon.ts", "// sleeps\n");
  activateBuildForTest(dir, "dist/daemon.ts");
  operator(dir);
  return dir;
}

const verdict = (dir: string, ops = createFakeProcessOps({ now: () => NOW })) =>
  rebootVerdict(dir, { ops, now: NOW });

describe("rebootVerdict", () => {
  test("a harness a person last started comes back", () => {
    expect(verdict(startedByAPerson())).toEqual({ restart: true });
  });

  test("live: a daemon already runs on its runfile", () => {
    const dir = startedByAPerson();
    const ops = createFakeProcessOps({ now: () => NOW });
    const argv = ["bun", join(dir, "dist", "daemon.ts")];
    ops.register(4242, NOW - 1000, argv.join(" "));
    writeRunfile(dir, {
      v: RUNFILE_VERSION,
      pid: 4242,
      pidStartTimeMs: NOW - 1000,
      argvFingerprint: argvFingerprint(dir, argv),
      entry: "daemon.ts",
      bundleDir: join(dir, "dist"),
      runId: "run_0123456789abcdef",
      startedAt: new Date(NOW - 1000).toISOString(),
      managerVersion: "0.9.0",
    });
    expect(verdict(dir, ops)).toEqual({ restart: false, reason: "live" });
  });

  test("no-active: nothing was ever activated", () => {
    const dir = mkdtempSync(join(tmpdir(), "chsup-reboot-"));
    roots.push(dir);
    operator(dir);
    expect(verdict(dir)).toEqual({ restart: false, reason: "no-active" });
  });

  test("not-autostart: the activation said not to start on its own", () => {
    const dir = startedByAPerson();
    put(
      dir,
      ".crewhaus/run/control/deployments.jsonl",
      `${JSON.stringify({ id: "dep_01testtesttesttesttesttesx", state: "prepared", artifact: { digest: "x", entry: "dist/daemon.ts" } })}\n${JSON.stringify({ id: "dep_01testtesttesttesttesttesx", state: "active", activatedAt: "2026-11-02T00:00:00.000Z", autostart: false, artifact: { digest: "x", entry: "dist/daemon.ts" } })}\n`,
    );
    expect(verdict(dir)).toEqual({ restart: false, reason: "not-autostart" });
  });

  test("not-desired: a person's last word was stop, or there is none", () => {
    const stopped = startedByAPerson();
    operator(stopped, { desired: "stopped" });
    expect(verdict(stopped)).toEqual({ restart: false, reason: "not-desired" });
    const never = startedByAPerson();
    rmSync(join(never, OPERATOR));
    expect(verdict(never)).toEqual({ restart: false, reason: "not-desired" });
  });

  test("disabled: its operator disabled it", () => {
    const dir = startedByAPerson();
    operator(dir, {
      deployment: { disabled: true, since: "2026-11-13T00:00:00.000Z", by: "prn_a", cmd: "c" },
    });
    expect(verdict(dir)).toEqual({ restart: false, reason: "disabled" });
  });

  test("crash-loop: the kept restart window is full", () => {
    const dir = startedByAPerson();
    writeSupervisionRecord(dir, [NOW - 5000, NOW - 4000, NOW - 3000, NOW - 2000, NOW - 1000]);
    expect(verdict(dir)).toEqual({ restart: false, reason: "crash-loop" });
    // Restarts that left the window no longer count.
    writeSupervisionRecord(dir, [NOW - 3_600_000, NOW - 1000]);
    expect(verdict(dir)).toEqual({ restart: true });
  });

  test("terminal-exit: the newest run ended with an exit no restart fixes", () => {
    const dir = startedByAPerson();
    appendRunLedger(dir, {
      runId: "run_0000000000000001",
      kind: "daemon",
      argv: ["bun"],
      startedAt: "2026-11-01T00:00:00.000Z",
      endedAt: "2026-11-01T00:01:00.000Z",
      exitCode: 31,
      logFile: "logs/run_0000000000000001.log",
    });
    expect(verdict(dir)).toEqual({ restart: false, reason: "terminal-exit" });
    // A later run that ended in a crash is the newest: it may come back.
    appendRunLedger(dir, {
      runId: "run_0000000000000002",
      kind: "daemon",
      argv: ["bun"],
      startedAt: "2026-11-02T00:00:00.000Z",
      endedAt: "2026-11-02T00:01:00.000Z",
      exitCode: 1,
      logFile: "logs/run_0000000000000002.log",
    });
    expect(verdict(dir)).toEqual({ restart: true });
  });

  test("unreadable: records that cannot be read", () => {
    const deployments = startedByAPerson();
    rmSync(join(deployments, ".crewhaus/run/control/deployments.jsonl"));
    mkdirSync(join(deployments, ".crewhaus/run/control/deployments.jsonl"));
    expect(verdict(deployments)).toEqual({ restart: false, reason: "unreadable" });
    const record = startedByAPerson();
    put(record, OPERATOR, "{not json");
    expect(verdict(record)).toEqual({ restart: false, reason: "unreadable" });
    const window = startedByAPerson();
    put(window, ".crewhaus/run/supervision.json", "{not json");
    expect(verdict(window)).toEqual({ restart: false, reason: "unreadable" });
  });
});

describe("startAfterReboot", () => {
  function supervise(dir: string) {
    const clock = createFakeClock(NOW);
    const ops = createFakeProcessOps({ now: clock.now });
    const recorded: string[] = [];
    const recordDesired: SupervisorOptions["recordDesired"] = async (desired) => {
      recorded.push(desired);
      return { ok: true };
    };
    const supervisor = createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops,
      clock,
      plan: () =>
        buildSpawnPlan({
          harnessDir: dir,
          target: "channel",
          processEnv: {},
          ports: { port: 3000, controlPort: 3001 },
        }),
      managerVersion: "0.9.0-test",
      recordDesired,
    });
    return { supervisor, ops, recorded };
  }

  test("starts the active build, records nothing a person wants, and counts in the window", async () => {
    const dir = startedByAPerson();
    const h = supervise(dir);
    const started = await h.supervisor.startAfterReboot();
    expect(started.ok).toBe(true);
    expect(h.ops.children).toHaveLength(1);
    expect(h.recorded).toEqual([]);
    expect(h.supervisor.snapshot().restartsInWindow).toBe(1);
    h.supervisor.close();
  });

  test("refuses a build that is not the active one, and spawns nothing", async () => {
    const dir = startedByAPerson();
    put(dir, "dist/daemon.ts", "// edited since it was activated\n");
    const h = supervise(dir);
    const started = await h.supervisor.startAfterReboot();
    expect(started).toMatchObject({ ok: false, reason: "build-not-active" });
    expect(h.ops.children).toHaveLength(0);
    expect(h.recorded).toEqual([]);
    h.supervisor.close();
  });
});
