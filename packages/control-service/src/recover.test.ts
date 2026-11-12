import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandReceipt } from "@crewhaus/control-contract";
import { publishClaim } from "@crewhaus/control-records";
import { createMemoryJobStore } from "@crewhaus/harness-supervisor";
import { CORE_RUNTIME, reconcileDaemonStart } from "./core-runtime";
import { type AreaRuntime, type Reconciliation, executorDead, withOwnStartTime } from "./executor";
import { commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import {
  BOOTED,
  HOST,
  NOW,
  fakeProbe,
  plantReceipt,
  removeTempDirs,
  rig,
  rowsOf,
  tempDir,
} from "./test-helpers";

afterAll(removeTempDirs);

const CMD = "cmd_01m76e6f05hp514w9j4v3qymkt";
const iso = (ms: number): string => new Date(ms).toISOString();

function stateOf(harness: string, id = CMD): string | undefined {
  const rows = rowsOf(commandsLedgerOf(harness)).filter((row) => row["id"] === id);
  return rows.at(-1)?.["state"] as string | undefined;
}

function lastRow(harness: string, id = CMD): Record<string, unknown> | undefined {
  return rowsOf(commandsLedgerOf(harness))
    .filter((row) => row["id"] === id)
    .at(-1);
}

/** The core's executors with a reconciler that answers what the test says. */
function answering(answer: Reconciliation): AreaRuntime {
  const reconcile = (): Reconciliation => answer;
  return {
    ...CORE_RUNTIME,
    reconcilers: { "controls.start": reconcile, "controls.restart": reconcile },
  };
}

describe("a crash between persist and execute", () => {
  test("an accepted stop whose process died runs once, and a second recovery runs nothing", async () => {
    const r = rig({ pid: 1000 });
    plantReceipt(commandsLedgerOf(r.harness), { id: CMD });
    const first = await r.service.commands.recover({ harness: r.harness });
    expect(first).toEqual({ redispatched: 1, reconciled: 0, unknown: 0 });
    expect(r.supervisor.calls.filter((call) => call === "stop")).toHaveLength(1);
    expect(stateOf(r.harness)).toBe("succeeded");
    expect(rowsOf(commandsLedgerOf(r.harness)).map((row) => row["state"])).toEqual([
      "accepted",
      "running",
      "succeeded",
    ]);
    const again = await r.service.commands.recover({ harness: r.harness });
    expect(again).toEqual({ redispatched: 0, reconciled: 0, unknown: 0 });
    expect(r.supervisor.calls.filter((call) => call === "stop")).toHaveLength(1);
  });
});

describe("whose process is alive", () => {
  const ownedBy = (executor: Record<string, unknown>) => ({
    id: CMD,
    executor: { pid: 999, host: HOST, head: "cli", ...executor },
  });

  test("a live executor is skipped: nothing runs and nothing is written", async () => {
    const probe = fakeProbe({ 1000: { alive: true }, 999: { alive: true, start: BOOTED + 500 } });
    const r = rig({ pid: 1000, probe });
    plantReceipt(commandsLedgerOf(r.harness), ownedBy({ startedAt: iso(BOOTED + 500) }));
    expect(await r.service.commands.recover({ harness: r.harness })).toEqual({
      redispatched: 0,
      reconciled: 0,
      unknown: 0,
    });
    expect(r.supervisor.calls).toEqual([]);
    expect(stateOf(r.harness)).toBe("accepted");
  });

  test("the same pid with a start time 3 seconds off is another process: the receipt is recovered", async () => {
    const probe = fakeProbe({ 1000: { alive: true }, 999: { alive: true, start: BOOTED + 3500 } });
    const r = rig({ pid: 1000, probe });
    plantReceipt(commandsLedgerOf(r.harness), ownedBy({ startedAt: iso(BOOTED + 500) }));
    await r.service.commands.recover({ harness: r.harness });
    expect(r.supervisor.calls).toContain("stop");
    expect(stateOf(r.harness)).toBe("succeeded");
  });

  test("an unconfirmed stamp with a live pid is judged by its pid alone: skipped", async () => {
    const probe = fakeProbe({ 1000: { alive: true }, 999: { alive: true, start: BOOTED + 9000 } });
    const r = rig({ pid: 1000, probe });
    plantReceipt(
      commandsLedgerOf(r.harness),
      ownedBy({ startedAt: iso(BOOTED + 500), probed: false }),
    );
    await r.service.commands.recover({ harness: r.harness });
    expect(r.supervisor.calls).toEqual([]);
    expect(stateOf(r.harness)).toBe("accepted");
  });

  test("an executor that started before the machine booted is dead, whatever its pid answers", async () => {
    const probe = fakeProbe({ 1000: { alive: true }, 999: { alive: true, start: BOOTED - 5000 } });
    const r = rig({ pid: 1000, probe });
    plantReceipt(commandsLedgerOf(r.harness), ownedBy({ startedAt: iso(BOOTED - 5000) }));
    await r.service.commands.recover({ harness: r.harness });
    expect(r.supervisor.calls).toContain("stop");
  });
});

describe("a daemon start", () => {
  test("accepted before the machine booted: unknown, never started", async () => {
    const r = rig({ pid: 1000 });
    plantReceipt(commandsLedgerOf(r.harness), {
      id: CMD,
      kind: "controls.start",
      acceptedAt: iso(BOOTED - 60_000),
      executor: { pid: 999, startedAt: iso(BOOTED - 120_000), host: HOST, head: "cli" },
      retry: { retryable: true, safety: "reconcile-first" },
    });
    expect(await r.service.commands.recover({ harness: r.harness })).toEqual({
      redispatched: 0,
      reconciled: 0,
      unknown: 1,
    });
    expect(r.supervisor.calls).toEqual([]);
    const row = lastRow(r.harness);
    expect(row?.["state"]).toBe("unknown");
    expect(row?.["outcome"]).toEqual({
      code: "interrupted",
      message: "not started: the machine restarted",
    });
  });

  const acceptedStart = (harness: string, state = "accepted") =>
    plantReceipt(commandsLedgerOf(harness), {
      id: CMD,
      kind: "controls.start",
      state: state as CommandReceipt["state"],
      retry: { retryable: true, safety: "reconcile-first" },
    });

  test("accepted after boot, process dead, the reconciler saw it start: succeeded, start never called", async () => {
    const r = rig({ pid: 1000, areas: [answering("done")] });
    acceptedStart(r.harness);
    expect(await r.service.commands.recover({ harness: r.harness })).toMatchObject({
      reconciled: 1,
    });
    expect(r.supervisor.calls).toEqual([]);
    expect(stateOf(r.harness)).toBe("succeeded");
  });

  test("accepted after boot, the reconciler saw no daemon: start is called once", async () => {
    const r = rig({ pid: 1000, areas: [answering("not-done")] });
    acceptedStart(r.harness);
    expect(await r.service.commands.recover({ harness: r.harness })).toMatchObject({
      redispatched: 1,
    });
    expect(r.supervisor.calls.filter((call) => call === "start")).toHaveLength(1);
    expect(stateOf(r.harness)).toBe("succeeded");
  });

  test("accepted after boot, the reconciler cannot tell: unknown, needs a decision", async () => {
    const r = rig({ pid: 1000, areas: [answering("unknown")] });
    acceptedStart(r.harness);
    expect(await r.service.commands.recover({ harness: r.harness })).toMatchObject({ unknown: 1 });
    expect(r.supervisor.calls).toEqual([]);
    expect(lastRow(r.harness)?.["outcome"]).toEqual({
      code: "interrupted",
      message: "interrupted, needs a decision",
    });
  });

  for (const [answer, state] of [
    ["done", "succeeded"],
    ["not-done", "failed"],
    ["unknown", "unknown"],
  ] as const) {
    test(`running and not safe to repeat: the reconciler's ${answer} makes it ${state}`, async () => {
      const r = rig({ pid: 1000, areas: [answering(answer)] });
      acceptedStart(r.harness, "running");
      await r.service.commands.recover({ harness: r.harness });
      expect(r.supervisor.calls).toEqual([]);
      expect(stateOf(r.harness)).toBe(state);
    });
  }
});

describe("running and safe to repeat", () => {
  test("two recoverers race: one claim winner, one run again", async () => {
    const probe = fakeProbe({ 1000: { alive: true }, 2000: { alive: true } });
    const a = rig({ pid: 1000, probe });
    const b = rig({ pid: 2000, probe, harness: a.harness, hangarRoot: a.hangarRoot });
    plantReceipt(commandsLedgerOf(a.harness), { id: CMD, state: "running" });
    const [one, two] = await Promise.all([
      a.service.commands.recover({ harness: a.harness }),
      b.service.commands.recover({ harness: a.harness }),
    ]);
    expect((one?.redispatched ?? 0) + (two?.redispatched ?? 0)).toBe(1);
    const stops = [...a.supervisor.calls, ...b.supervisor.calls].filter((call) => call === "stop");
    expect(stops).toHaveLength(1);
    expect(stateOf(a.harness)).toBe("succeeded");
  });

  test("a claim left by a recoverer that died too: unknown, and nothing runs again", async () => {
    const r = rig({ pid: 1000 });
    const ledger = commandsLedgerOf(r.harness);
    plantReceipt(ledger, { id: CMD, state: "running" });
    const claimed = publishClaim(ledger, `recover/${CMD}`, {
      id: CMD,
      executor: { pid: 998, startedAt: iso(BOOTED + 10), host: HOST, head: "server" },
    });
    expect(claimed.ok).toBe(true);
    expect(await r.service.commands.recover({ harness: r.harness })).toMatchObject({ unknown: 1 });
    expect(r.supervisor.calls).toEqual([]);
    expect(stateOf(r.harness)).toBe("unknown");
  });
});

describe("left alone", () => {
  test("a receipt already unknown is the reconcile sweep's", async () => {
    const r = rig({ pid: 1000 });
    plantReceipt(commandsLedgerOf(r.harness), { id: CMD, state: "unknown" });
    const before = rowsOf(commandsLedgerOf(r.harness)).length;
    expect(before).toBe(2);
    expect(stateOf(r.harness)).toBe("unknown");
    await r.service.commands.recover({ harness: r.harness });
    expect(rowsOf(commandsLedgerOf(r.harness))).toHaveLength(before);
    expect(r.supervisor.calls).toEqual([]);
  });

  test("a job's receipt is the job queue's, in direct mode", async () => {
    const r = rig({ pid: 1000 });
    plantReceipt(commandsLedgerOf(r.harness), {
      id: CMD,
      kind: "legacy.submitJob",
      effects: [{ kind: "job", status: "unknown" }],
    });
    expect(await r.service.commands.recover({ harness: r.harness })).toEqual({
      redispatched: 0,
      reconciled: 0,
      unknown: 0,
    });
    expect(stateOf(r.harness)).toBe("accepted");
  });

  test("a legacy kind has no executor: unknown, needs a decision", async () => {
    const r = rig({ pid: 1000 });
    plantReceipt(commandsLedgerOf(r.harness), { id: CMD, kind: "legacy.setPin" });
    expect(await r.service.commands.recover({ harness: r.harness })).toMatchObject({ unknown: 1 });
    expect(stateOf(r.harness)).toBe("unknown");
  });
});

describe("Home's recovery", () => {
  test("covers every registered harness and Home's ledger, and settles a job that never reached the queue", async () => {
    const other = tempDir("control-service-harness-");
    const r = rig({ pid: 1000, mode: "server" });
    const r2 = rig({
      pid: 1000,
      mode: "server",
      hangarRoot: r.hangarRoot,
      harness: r.harness,
      harnessDirs: () => [r.harness, other],
    });
    const store = createMemoryJobStore();
    r2.service.jobs.wrapStore(store);
    store.append({
      jobId: "job_1",
      harnessDir: r.harness,
      kind: "eval",
      argv: ["eval"],
      mutating: true,
      state: "pending",
      enqueuedAt: iso(NOW),
      commandId: "cmd_01m76e6f05hp514w9j4v3qymkv",
    });
    const job = {
      kind: "legacy.evalLaunch",
      effects: [{ kind: "job", status: "unknown" as const }],
    };
    plantReceipt(commandsLedgerOf(r.harness), { id: CMD, ...job });
    plantReceipt(commandsLedgerOf(r.harness), { id: "cmd_01m76e6f05hp514w9j4v3qymkv", ...job });
    plantReceipt(commandsLedgerOf(other), { id: "cmd_01m76e6f05hp514w9j4v3qymkw" });
    plantReceipt(workspaceCommandsLedger(r.hangarRoot), {
      id: "cmd_01m76e6f05hp514w9j4v3qymkx",
      kind: "legacy.scan",
    });
    const counts = await r2.service.commands.recover("all");
    expect(counts).toEqual({ redispatched: 1, reconciled: 0, unknown: 2 });
    expect(stateOf(r.harness, CMD)).toBe("unknown");
    expect(stateOf(r.harness, "cmd_01m76e6f05hp514w9j4v3qymkv")).toBe("accepted");
    expect(stateOf(other, "cmd_01m76e6f05hp514w9j4v3qymkw")).toBe("succeeded");
    const home = rowsOf(workspaceCommandsLedger(r.hangarRoot));
    expect(home.at(-1)?.["state"]).toBe("unknown");
  });

  test("a harness with no control tree is read and nothing is created", async () => {
    const empty = tempDir("control-service-empty-");
    const r = rig({ pid: 1000, mode: "server", harnessDirs: () => [empty] });
    expect(await r.service.commands.recover("all")).toEqual({
      redispatched: 0,
      reconciled: 0,
      unknown: 0,
    });
    expect((await import("node:fs")).readdirSync(empty)).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("the daemon-start reconciler", () => {
  const ACCEPTED = NOW - 10_000;
  const receipt = { acceptedAt: iso(ACCEPTED) } as CommandReceipt;

  function withRunfile(pid: number, startMs: number): string {
    const dir = tempDir("control-service-runfile-");
    mkdirSync(join(dir, ".crewhaus", "run"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "run", "daemon.json"),
      JSON.stringify({ v: 1, pid, pidStartTimeMs: startMs, argvFingerprint: "f" }),
    );
    return dir;
  }

  const check = (dir: string, probe: ReturnType<typeof fakeProbe>) =>
    reconcileDaemonStart(receipt, { harnessDir: dir, probe, now: () => NOW });

  test("a live daemon that started after acceptance is done", () => {
    const dir = withRunfile(50, ACCEPTED + 100);
    expect(check(dir, fakeProbe({ 50: { alive: true, start: ACCEPTED + 100 } }))).toBe("done");
  });

  test("no runfile, a gone pid, or a recycled one is not done", () => {
    expect(check(tempDir(), fakeProbe())).toBe("not-done");
    const dir = withRunfile(50, ACCEPTED + 100);
    expect(check(dir, fakeProbe())).toBe("not-done");
    expect(check(dir, fakeProbe({ 50: { alive: true, start: ACCEPTED + 9000 } }))).toBe("not-done");
  });

  test("an unanswered probe, or a daemon older than the command, is unknown", () => {
    const dir = withRunfile(50, ACCEPTED + 100);
    expect(check(dir, fakeProbe({ 50: { alive: undefined } }))).toBe("unknown");
    expect(check(dir, fakeProbe({ 50: { alive: true } }))).toBe("unknown");
    const older = withRunfile(51, ACCEPTED - 60_000);
    expect(check(older, fakeProbe({ 51: { alive: true, start: ACCEPTED - 60_000 } }))).toBe(
      "unknown",
    );
  });
});

describe("a head's own start time", () => {
  test("comes from its own clock, and every other pid from the probe", () => {
    const probe = fakeProbe({ 50: { alive: true, start: 1234 } });
    const own = withOwnStartTime(probe, 77);
    const started = own.startTimeMs(77) as number;
    expect(Math.abs(started - (Date.now() - process.uptime() * 1000))).toBeLessThan(1000);
    expect(own.startTimeMs(50)).toBe(1234);
    expect(own.isAlive(50)).toBe(true);
    expect(own.isAlive(77)).toBe(false);
  });

  test("a stamp taken from it is judged alive later by a probe that reads the pid a second off", () => {
    const own = withOwnStartTime(fakeProbe(), 77);
    const stamp = {
      pid: 77,
      startedAt: new Date(own.startTimeMs(77) as number).toISOString(),
      host: HOST,
      head: "cli",
    };
    const later = fakeProbe({ 77: { alive: true, start: (own.startTimeMs(77) as number) - 1000 } });
    expect(executorDead(stamp, later, HOST, BOOTED)).toBe(false);
  });
});
