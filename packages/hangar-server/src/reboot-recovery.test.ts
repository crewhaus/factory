/**
 * Boot after the machine started. The installed service starts again only what a person
 * last started and nobody stopped since; Home in a window restarts nothing. Both leave
 * `service/recovery.json`. Commands accepted before the boot: the service runs a daemon
 * start, a window leaves it for a person.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { append, controlPaths, foldStates } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { buildDigest } from "@crewhaus/harness-supervisor";
import { makeFixtureHarness } from "./fixture";
import { RECOVERY_FILE } from "./reboot-recovery";
import { type BootOptions, type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
/** The machine booted an hour before NOW: every pid and receipt below predates it. */
const BOOTED = NOW - 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A harness whose daemon a person started: its build active, `autostart`, `desired: running`. */
function startedHarness(
  dir: string,
  name: string,
  options: {
    readonly autostart?: boolean;
    readonly desired?: "running" | "stopped";
    readonly disabled?: boolean;
  } = {},
): string {
  makeFixtureHarness(dir, { specName: name, target: "channel", bundle: { entry: "daemon.ts" } });
  const taken = buildDigest(dir, { entry: "dist/daemon.ts" });
  if ("unreadable" in taken) throw new Error(taken.unreadable);
  const record = {
    id: `dep_01${name.padEnd(24, "0").slice(0, 24)}`,
    artifact: {
      digest: taken.digest,
      specHash: `sha256:${"0".repeat(64)}`,
      compiledWith: "0.9.0",
      shape: "channel",
      entry: "dist/daemon.ts",
      bootInputs: [],
    },
  };
  const file = join(dir, controlPaths(dir).deploymentsFile);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${JSON.stringify({ ...record, state: "prepared" })}\n${JSON.stringify({
      ...record,
      state: "active",
      activatedAt: iso(BOOTED - 86_400_000),
      autostart: options.autostart ?? true,
      gates: "not-run",
    })}\n`,
  );
  put(
    dir,
    controlPaths(dir).operatorFile,
    `${JSON.stringify({
      v: 1,
      rev: 1,
      desired: options.desired ?? "running",
      ...(options.disabled === true
        ? { deployment: { disabled: true, since: iso(BOOTED - 1000), by: "prn_a", cmd: "cmd_x" } }
        : {}),
    })}\n`,
  );
  return dir;
}

/** Boot a Home over a fleet registered before it starts. */
function bootOver(
  mode: "foreground" | "resident",
  plant: (harnessesRoot: string) => Record<string, string>,
  extra: BootOptions = {},
): { t: TestServer; ids: Record<string, string> } {
  const ids: Record<string, string> = {};
  const t = bootTestServer({
    now: () => NOW,
    hostBootedAt: () => BOOTED,
    ...(mode === "resident" ? { mode: "resident" as const } : {}),
    ...extra,
    prepare: ({ workspace }) => {
      const dirs = plant(join(workspace, "harnesses"));
      const registry = openHangarRegistry({
        root: join(workspace, "registry"),
        env: { CREWHAUS_WATCHME_ROOT: join(workspace, "watchme") },
        now: () => NOW,
        onWarn: () => undefined,
      });
      for (const [name, dir] of Object.entries(dirs)) ids[name] = registry.upsert({ dir }).id;
    },
  });
  servers.push(t);
  return { t, ids };
}

function plantFleet(root: string): Record<string, string> {
  const dirs = {
    restarts: startedHarness(join(root, "restarts"), "restarts"),
    stopped: startedHarness(join(root, "stopped"), "stopped", { desired: "stopped" }),
    disabled: startedHarness(join(root, "disabled"), "disabled", { disabled: true }),
    looping: startedHarness(join(root, "looping"), "looping"),
    terminal: startedHarness(join(root, "terminal"), "terminal"),
    manual: startedHarness(join(root, "manual"), "manual", { autostart: false }),
  };
  put(
    dirs.looping,
    ".crewhaus/run/supervision.json",
    `${JSON.stringify({ v: 1, restarts: [1, 2, 3, 4, 5].map((n) => NOW - n * 1000) })}\n`,
  );
  put(
    dirs.terminal,
    ".crewhaus/run/runs.jsonl",
    `${JSON.stringify({
      runId: "run_00000000000000a1",
      kind: "daemon",
      argv: ["bun"],
      startedAt: iso(BOOTED - 600_000),
      endedAt: iso(BOOTED - 500_000),
      exitCode: 31,
      logFile: "logs/run_00000000000000a1.log",
    })}\n`,
  );
  return dirs;
}

const reportOf = (t: TestServer) =>
  JSON.parse(readFileSync(join(t.hangarRoot, RECOVERY_FILE), "utf8")) as Record<string, unknown>;

describe("reboot recovery", () => {
  test("the service restarts only the harness a person last started, and says why not for the rest", async () => {
    const { t, ids } = bootOver("resident", plantFleet);
    const ready = await t.server.ready;
    expect(t.ops?.children).toHaveLength(1);
    expect(t.ops?.children[0]?.request.cwd).toContain("restarts");
    const report = reportOf(t);
    expect(report["mode"]).toBe("resident");
    expect(report["v"]).toBe(1);
    expect(report["hostBootedAt"]).toBe(iso(BOOTED));
    expect((report["restarted"] as Array<{ harness: string }>).map((r) => r.harness)).toEqual([
      ids["restarts"],
    ]);
    const skipped = new Map(
      (report["skipped"] as Array<{ harness: string; reason: string }>).map((r) => [
        r.harness,
        r.reason,
      ]),
    );
    expect(skipped.get(ids["stopped"] as string)).toBe("not-desired");
    expect(skipped.get(ids["disabled"] as string)).toBe("disabled");
    expect(skipped.get(ids["looping"] as string)).toBe("crash-loop");
    expect(skipped.get(ids["terminal"] as string)).toBe("terminal-exit");
    expect(skipped.get(ids["manual"] as string)).toBe("not-autostart");
    expect(report["failed"]).toEqual([]);
    // `ready` resolves with the report itself.
    expect(ready).toEqual(report as never);
    // Harness ids, never a path.
    expect(JSON.stringify(report)).not.toContain(t.harnessesRoot);
    // The activity feed says what came back.
    const activity = await t.api(`/api/activity?since=${BOOTED}`);
    const recovered = (
      activity.body["items"] as Array<{ kind: string; harnessId: string; label: string }>
    ).filter((item) => item.kind === "recovery");
    expect(recovered.map((item) => [item.harnessId, item.label])).toEqual([
      [ids["restarts"], "restarted after the machine started"],
    ]);
  });

  test("Home in a window over the same fleet restarts nothing, and still writes the report", async () => {
    const { t } = bootOver("foreground", plantFleet);
    await t.server.ready;
    expect(t.ops?.children ?? []).toHaveLength(0);
    const report = reportOf(t);
    expect(report["mode"]).toBe("foreground");
    expect(report["restarted"]).toEqual([]);
    expect(report["skipped"]).toEqual([]);
  });
});

describe("commands accepted before the machine started", () => {
  const plantStart = (dir: string, id: string) => {
    const answer = append(commandsLedgerOf(dir), {
      id,
      v: 1,
      kind: "controls.start",
      target: "home/harness/hrn_00000000000000ff",
      actor: `local:#${"a".repeat(64)}`,
      via: "cli",
      fingerprint: "f".repeat(64),
      state: "accepted",
      acceptedAt: iso(BOOTED - 120_000),
      executor: {
        pid: 2_147_483_000,
        startedAt: iso(BOOTED - 600_000),
        host: hostname(),
        head: "cli",
      },
      effects: [],
      retry: { retryable: true, safety: "reconcile-first" },
    });
    if (!answer.ok) throw new Error(answer.reason);
  };
  const plantJob = (dir: string, id: string) => {
    const answer = append(commandsLedgerOf(dir), {
      id,
      v: 1,
      kind: "legacy.evalLaunch",
      target: "home/harness/hrn_00000000000000ff",
      actor: `local:#${"a".repeat(64)}`,
      via: "home",
      fingerprint: "f".repeat(64),
      state: "accepted",
      acceptedAt: iso(BOOTED - 120_000),
      executor: {
        pid: 2_147_483_000,
        startedAt: iso(BOOTED - 600_000),
        host: hostname(),
        head: "server",
      },
      effects: [{ kind: "job", status: "unknown" }],
      retry: { retryable: true, safety: "reconcile-first" },
    });
    if (!answer.ok) throw new Error(answer.reason);
  };
  const rowsOf = (dir: string, id: string) => {
    const fold = foldStates(commandsLedgerOf(dir));
    return fold.ok ? fold.objects.get(id)?.record : undefined;
  };

  test("the service runs a daemon start asked for before the boot, stamped as the service", async () => {
    const start = mintId("cmd", { now: BOOTED - 120_000 });
    const job = mintId("cmd", { now: BOOTED - 110_000 });
    let dir = "";
    const { t } = bootOver("resident", (root) => {
      dir = startedHarness(join(root, "asked"), "asked", { desired: "stopped" });
      plantStart(dir, start);
      plantJob(dir, job);
      return { asked: dir };
    });
    await t.server.ready;
    expect(t.ops?.children).toHaveLength(1);
    const settled = rowsOf(dir, start);
    expect(settled?.["state"]).toBe("succeeded");
    expect((settled?.["executor"] as { head: string }).head).toBe("resident");
    // A job that never reached the queue is settled as Home in a window settles it.
    expect([
      rowsOf(dir, job)?.["state"],
      (rowsOf(dir, job)?.["outcome"] as { message: string })?.message,
    ]).toEqual(["unknown", "interrupted, needs a decision"]);
    // The start it made is live: reboot recovery leaves the harness to it.
    const skipped = reportOf(t)["skipped"] as Array<{ reason: string }>;
    expect(skipped.map((r) => r.reason)).toEqual(["live"]);
  });

  test("Home in a window leaves it for a person, and still does after a tick", async () => {
    const start = mintId("cmd", { now: BOOTED - 120_000 });
    const job = mintId("cmd", { now: BOOTED - 110_000 });
    let dir = "";
    const { t } = bootOver("foreground", (root) => {
      dir = startedHarness(join(root, "asked"), "asked", { desired: "stopped" });
      plantStart(dir, start);
      plantJob(dir, job);
      return { asked: dir };
    });
    await t.server.ready;
    const expected = [
      "unknown",
      { code: "interrupted", message: "not started: the machine restarted" },
    ];
    expect([rowsOf(dir, start)?.["state"], rowsOf(dir, start)?.["outcome"]]).toEqual(expected);
    await t.server.scheduler.tick();
    expect([rowsOf(dir, start)?.["state"], rowsOf(dir, start)?.["outcome"]]).toEqual(expected);
    expect(t.ops?.children ?? []).toHaveLength(0);
    expect(rowsOf(dir, job)?.["state"]).toBe("unknown");
  });
});
