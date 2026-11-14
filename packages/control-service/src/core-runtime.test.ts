import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandReceipt } from "@crewhaus/control-contract";
import {
  type HarnessSupervisor,
  type ProcessOps,
  buildSpawnPlan,
  createHarnessSupervisor,
} from "@crewhaus/harness-supervisor";
import { CORE_RUNTIME, settleStart } from "./core-runtime";
import type { Executor } from "./executor";
import { outcomeOf } from "./refusal";
import { removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

describe("settleStart", () => {
  test("a restart refused before it stopped anything records the daemon as kept running", () => {
    const gate = {
      allowed: false,
      // Only `allowed` and the lists are read here.
      report: { ok: false } as never,
      refused: [],
      unforceable: [],
      acknowledged: [],
    };
    for (const result of [
      { ok: false, reason: "preflight-blocked", gate, kept: true },
      { ok: false, reason: "build-not-active", message: "not active", kept: true },
      { ok: false, reason: "plan-failed", stage: "plan", error: new Error("x"), kept: true },
    ] as const) {
      expect(settleStart(result)).toEqual({
        state: "rejected",
        effects: [{ kind: "daemon", status: "skipped", note: "kept running" }],
        outcome: outcomeOf("precondition_failed"),
      });
    }
  });

  test("a start's refusal records no daemon effect", () => {
    expect(settleStart({ ok: false, reason: "build-not-active", message: "not active" })).toEqual({
      state: "rejected",
      outcome: outcomeOf("precondition_failed"),
    });
    expect(
      settleStart({ ok: false, reason: "plan-failed", stage: "plan", error: new Error("x") }),
    ).toMatchObject({ state: "failed", effects: [{ kind: "daemon", status: "failed" }] });
  });
});

describe("a queued or recovered start or restart of a disabled harness", () => {
  type Child = { readonly pid: number; readonly signals: string[]; alive: boolean };

  /** Process ops that record every spawn and signal, and spawn nothing real. */
  function recordingOps(): ProcessOps & { readonly children: Child[] } {
    const children: Child[] = [];
    let next = 7_000;
    const exits = new Map<number, (v: { code: number | null; signal: string | null }) => void>();
    const child = (pid: number): Child | undefined => children.find((c) => c.pid === pid);
    const signal = (pid: number, name: string): void => {
      const c = child(pid);
      if (c === undefined) return;
      c.signals.push(name);
      c.alive = false;
      exits.get(pid)?.({ code: null, signal: name });
    };
    return {
      platform: "posix",
      children,
      spawn: () => {
        const pid = next++;
        children.push({ pid, signals: [], alive: true });
        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          exits.set(pid, resolve);
        });
        return { pid, exited, write: () => {}, closeStdin: () => {}, unref: () => {} };
      },
      isAlive: (pid) => child(pid)?.alive === true,
      startTimeMs: (pid) => (child(pid)?.alive === true ? 1 : undefined),
      commandLine: () => undefined,
      terminate: (pid) => signal(pid, "SIGTERM"),
      forceKill: (pid) => signal(pid, "SIGKILL"),
    };
  }

  function harness(): string {
    const dir = tempDir("core-runtime-disabled-");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "crewhaus.yaml"), "name: demo\ntarget: channel\n");
    writeFileSync(join(dir, "dist", "daemon.ts"), "// bundle\n");
    return dir;
  }

  function disable(dir: string): void {
    const control = join(dir, ".crewhaus", "run", "control");
    mkdirSync(control, { recursive: true });
    writeFileSync(
      join(control, "operator.json"),
      JSON.stringify({
        v: 1,
        rev: 1,
        intake: null,
        deployment: { disabled: true, since: "2026-11-13T00:00:00.000Z" },
        desired: "running",
      }),
    );
  }

  function supervised(dir: string, ops: ProcessOps) {
    return createHarnessSupervisor({
      harnessDir: dir,
      target: "channel",
      ops,
      plan: () =>
        buildSpawnPlan({
          harnessDir: dir,
          target: "channel",
          processEnv: {},
          ports: { controlPort: 0 },
        }),
      managerVersion: "0.9.0-test",
    });
  }

  const run = (kind: "controls.start" | "controls.restart", dir: string, supervisor: unknown) =>
    (CORE_RUNTIME.executors[kind] as Executor)({
      receipt: { kind } as unknown as CommandReceipt,
      harnessDir: dir,
      supervisor: supervisor as HarnessSupervisor,
      drainRequest: async () => {},
      now: () => Date.now(),
    });

  test("a start is refused disabled and spawns nothing", async () => {
    const dir = harness();
    disable(dir);
    const ops = recordingOps();
    const supervisor = supervised(dir, ops);
    try {
      expect(await run("controls.start", dir, supervisor)).toEqual({
        state: "rejected",
        outcome: outcomeOf("disabled"),
      });
      expect(ops.children).toHaveLength(0);
    } finally {
      supervisor.close();
    }
  });

  test("a restart is refused disabled, and the running daemon is kept and never signalled", async () => {
    const dir = harness();
    const ops = recordingOps();
    const supervisor = supervised(dir, ops);
    try {
      expect(await supervisor.start()).toMatchObject({ ok: true });
      disable(dir);
      expect(await run("controls.restart", dir, supervisor)).toEqual({
        state: "rejected",
        effects: [{ kind: "daemon", status: "skipped", note: "kept running" }],
        outcome: outcomeOf("disabled"),
      });
      expect(ops.children).toHaveLength(1);
      expect(ops.children[0]?.signals).toEqual([]);
    } finally {
      supervisor.close();
    }
  });
});
