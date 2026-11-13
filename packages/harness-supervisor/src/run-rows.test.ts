/**
 * The supervisor's run rows: a one-shot job's root run is queued before its
 * spawn and handed to the child, and the child's exit closes the root and
 * interrupts the runs it left open. Every row is checked against the control
 * contract's `run` schema, and the ledger's fold shows no anomaly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANONICAL_RUN_ID_RE,
  type CursorPosition,
  EXECUTION_RUN_ID_RE,
  mintRunId,
} from "@crewhaus/control-contract";
import { run as runSchema } from "@crewhaus/control-contract/schemas";
import { append, foldStates, readPage } from "@crewhaus/control-records";
import type { ProcessOps, SpawnRequest } from "./process-ops";
import { RUN_LEDGER_DIR, runLedgerFor } from "./run-rows";
import { writeRunfile } from "./runfiles";
import { buildSpawnPlan } from "./spawn-contracts";
import { type HarnessSupervisor, type StartResult, createHarnessSupervisor } from "./supervisor";
import { type FakeProcessOps, createFakeClock, createFakeProcessOps } from "./testkit";
import { RUNFILE_VERSION } from "./types";

type Row = Record<string, unknown>;

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHarness(target: string, env = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "chsup-rows-"));
  roots.push(dir);
  writeFileSync(join(dir, "crewhaus.yaml"), `name: demo\ntarget: ${target}\n`);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", target === "channel" ? "daemon.ts" : "agent.ts"), "// bundle\n");
  if (env !== "") writeFileSync(join(dir, ".env"), env);
  return dir;
}

/** Every row in the harness's run ledger, oldest first, each schema-checked; the fold has no anomaly. */
function rowsAt(dir: string): Row[] {
  const ledger = runLedgerFor(dir);
  const rows: Row[] = [];
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, { limit: 500, ...(before !== undefined ? { before } : {}) });
    expect(page.gaps).toEqual([]);
    for (const item of page.items) rows.push({ ...item.record });
    if (page.next === undefined) break;
    before = page.next;
  }
  rows.reverse();
  for (const row of rows) {
    const parsed = runSchema.safeParse(row);
    expect(parsed.success ? "valid" : JSON.stringify(parsed.error.issues)).toBe("valid");
  }
  const fold = foldStates(ledger);
  if (!fold.ok) throw new Error(fold.reason);
  expect(fold.anomalies).toEqual([]);
  return rows;
}

const statesOf = (rows: readonly Row[], id: string): unknown[] =>
  rows.filter((r) => r["id"] === id).map((r) => r["state"]);

type Harness = {
  readonly dir: string;
  readonly ops: FakeProcessOps;
  readonly supervisor: HarnessSupervisor;
  readonly spawned: SpawnRequest[];
  readonly warnings: string[];
};

function setup(
  target: string,
  options: {
    readonly env?: string;
    /** Called inside the fake spawn, before the child exists. */
    readonly onSpawn?: (request: SpawnRequest) => void;
  } = {},
): Harness {
  const dir = tempHarness(target, options.env ?? "");
  const clock = createFakeClock();
  const ops = createFakeProcessOps({ now: clock.now });
  const spawned: SpawnRequest[] = [];
  const wrapped: ProcessOps = {
    ...ops,
    spawn: (request) => {
      spawned.push(request);
      options.onSpawn?.(request);
      return ops.spawn(request);
    },
  };
  let seq = 0;
  const warnings: string[] = [];
  const supervisor = createHarnessSupervisor({
    harnessDir: dir,
    target,
    ops: wrapped,
    clock,
    plan: () =>
      buildSpawnPlan({
        harnessDir: dir,
        target,
        processEnv: {},
        ...(target === "channel" ? { ports: { port: 3000, controlPort: 3001 } } : {}),
      }),
    managerVersion: "0.9.0-test",
    newRunId: () => `run_${String(++seq).padStart(16, "0")}`,
    warn: (line) => warnings.push(line),
  });
  return { dir, ops, supervisor, spawned, warnings };
}

/** Resolve on the supervisor's next exit event: by then the close is in flight. */
function nextExit(supervisor: HarnessSupervisor): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = supervisor.subscribe((event) => {
      if (event.type === "exit") {
        off();
        resolve();
      }
    });
  });
}

/** Start a job and answer its root and execution ids. */
async function startJob(h: Harness): Promise<{ root: string; execution: string }> {
  const result: StartResult = await h.supervisor.start();
  if (!result.ok) throw new Error(`start refused: ${result.reason}`);
  if (result.root === undefined) throw new Error("no root run");
  return { root: result.root, execution: result.runId };
}

/** End the current child with `code` and wait until its rows are written. */
async function exitWith(h: Harness, code: number): Promise<void> {
  const exited = nextExit(h.supervisor);
  h.ops.last()?.exit(code);
  await exited;
  await h.supervisor.idle();
}

/** A row a child's runtime would write, planted in the ledger. */
function plant(dir: string, row: Row): void {
  const written = append(runLedgerFor(dir), {
    at: new Date().toISOString(),
    trigger: { kind: "cli" },
    ...row,
  });
  expect(written.ok).toBe(true);
}

describe("a job's root run", () => {
  test("queued and preparing exist before the spawn, and the child is handed both ids", async () => {
    let seenAtSpawn: Row[] = [];
    let dir = "";
    const h = setup("workflow", {
      onSpawn: () => {
        seenAtSpawn = rowsAt(dir);
      },
    });
    dir = h.dir;
    const { root, execution } = await startJob(h);
    expect(root).toMatch(CANONICAL_RUN_ID_RE);
    expect(execution).toMatch(EXECUTION_RUN_ID_RE);
    expect(seenAtSpawn.map((r) => [r["id"], r["state"], r["execution"]])).toEqual([
      [root, "queued", execution],
      [root, "preparing", execution],
    ]);
    expect(seenAtSpawn[0]?.["trigger"]).toEqual({ kind: "cli" });
    const env = h.spawned[0]?.env ?? {};
    expect(env["CREWHAUS_RUN_ID"]).toBe(root);
    expect(env["CREWHAUS_EXECUTION_ID"]).toBe(execution);
  });

  test("a daemon is handed its execution id only, and gets no root", async () => {
    const h = setup("channel");
    const result = await h.supervisor.start();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("root" in result).toBe(false);
    const env = h.spawned[0]?.env ?? {};
    expect(env["CREWHAUS_EXECUTION_ID"]).toBe(result.runId);
    expect(env["CREWHAUS_RUN_ID"]).toBeUndefined();
    expect(rowsAt(h.dir)).toEqual([]);
  });

  test("an operator's CREWHAUS_RUN_ID is passed through untouched, with no root", async () => {
    const h = setup("workflow", { env: "CREWHAUS_RUN_ID=nightly-backfill\n" });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("root" in result).toBe(false);
    const env = h.spawned[0]?.env ?? {};
    expect(env["CREWHAUS_RUN_ID"]).toBe("nightly-backfill");
    expect(env["CREWHAUS_EXECUTION_ID"]).toBe(result.runId);
    expect(rowsAt(h.dir)).toEqual([]);
  });

  test("CREWHAUS_RUN_LEDGER=0: no rows and no stamps, before or after the exit", async () => {
    const h = setup("workflow", { env: "CREWHAUS_RUN_LEDGER=0\n" });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(true);
    const env = h.spawned[0]?.env ?? {};
    expect(env["CREWHAUS_RUN_ID"]).toBeUndefined();
    expect(env["CREWHAUS_EXECUTION_ID"]).toBeUndefined();
    await exitWith(h, 0);
    expect(rowsAt(h.dir)).toEqual([]);
  });
});

describe("the exit closes the root", () => {
  test("exit 0 with the root still preparing: running, then succeeded", async () => {
    const h = setup("workflow");
    const { root } = await startJob(h);
    await exitWith(h, 0);
    expect(statesOf(rowsAt(h.dir), root)).toEqual(["queued", "preparing", "running", "succeeded"]);
  });

  test("exit 0 with the root running: succeeded", async () => {
    const h = setup("workflow");
    const { root, execution } = await startJob(h);
    plant(h.dir, { id: root, state: "running", execution });
    await exitWith(h, 0);
    expect(statesOf(rowsAt(h.dir), root)).toEqual(["queued", "preparing", "running", "succeeded"]);
  });

  test("exit 36 parks the root: waiting-for-approval", async () => {
    const h = setup("workflow");
    const { root } = await startJob(h);
    await exitWith(h, 36);
    expect(statesOf(rowsAt(h.dir), root)).toEqual([
      "queued",
      "preparing",
      "running",
      "waiting-for-approval",
    ]);
  });

  test("exit 33 fails the root with the budget class, straight from preparing", async () => {
    const h = setup("workflow");
    const { root } = await startJob(h);
    await exitWith(h, 33);
    const rows = rowsAt(h.dir).filter((r) => r["id"] === root);
    expect(rows.map((r) => r["state"])).toEqual(["queued", "preparing", "failed"]);
    expect(rows[2]?.["failureClass"]).toBe("crewhaus_budget");
  });

  test("exit 41 fails the root with input_blocked, and the job is not restarted", async () => {
    const h = setup("workflow");
    const { root } = await startJob(h);
    await exitWith(h, 41);
    const rows = rowsAt(h.dir).filter((r) => r["id"] === root);
    expect(rows.map((r) => r["state"])).toEqual(["queued", "preparing", "failed"]);
    expect(rows[2]?.["failureClass"]).toBe("input_blocked");
  });

  test("an operator stop cancels the root", async () => {
    const h = setup("workflow");
    const { root } = await startJob(h);
    await h.supervisor.stop();
    await h.supervisor.idle();
    expect(statesOf(rowsAt(h.dir), root)).toEqual(["queued", "preparing", "cancelled"]);
  });

  test("a spawn that throws fails the root with class spawn", async () => {
    const h = setup("workflow", {
      onSpawn: () => {
        throw new Error("EMFILE: too many open files");
      },
    });
    const result = await h.supervisor.start();
    expect(result.ok).toBe(false);
    await h.supervisor.idle();
    const rows = rowsAt(h.dir);
    const root = rows[0]?.["id"] as string;
    expect(root).toMatch(CANONICAL_RUN_ID_RE);
    const ended = rows.filter((r) => r["id"] === root);
    expect(ended.map((r) => r["state"])).toEqual(["queued", "preparing", "failed"]);
    expect(ended[2]?.["failureClass"]).toBe("spawn");
  });

  test("a root already ended is left alone", async () => {
    const h = setup("workflow");
    const { root, execution } = await startJob(h);
    plant(h.dir, { id: root, state: "cancelled", execution });
    await exitWith(h, 0);
    expect(statesOf(rowsAt(h.dir), root)).toEqual(["queued", "preparing", "cancelled"]);
    expect(h.warnings).toEqual([]);
  });
});

describe("the sweep", () => {
  test("runs of the execution left preparing or running are interrupted; a parked run and another execution's are not", async () => {
    const h = setup("workflow");
    const { root, execution } = await startJob(h);
    const other = "run_ffffffffffffffff";
    const [running, preparing, parked, elsewhere] = [
      mintRunId(),
      mintRunId(),
      mintRunId(),
      mintRunId(),
    ];
    plant(h.dir, { id: running, state: "running", execution, parent: root });
    plant(h.dir, { id: preparing, state: "queued", execution });
    plant(h.dir, { id: preparing, state: "preparing", execution });
    plant(h.dir, { id: parked, state: "running", execution });
    plant(h.dir, {
      id: parked,
      state: "waiting-for-approval",
      execution,
      decision: "appr_0123456789abcdef",
    });
    plant(h.dir, { id: elsewhere, state: "running", execution: other });
    await exitWith(h, 0);
    const rows = rowsAt(h.dir);
    for (const id of [running, preparing]) {
      const last = rows.filter((r) => r["id"] === id).at(-1);
      expect(last).toMatchObject({ state: "interrupted", by: "sys:reconcile", execution });
    }
    expect(statesOf(rows, parked)).toEqual(["running", "waiting-for-approval"]);
    expect(statesOf(rows, elsewhere)).toEqual(["running"]);
    expect(statesOf(rows, root).at(-1)).toBe("succeeded");
  });

  test("exit 36 after a park inside a sub-agent: the loop's run stays parked and the root waits", async () => {
    const h = setup("workflow");
    const { root, execution } = await startJob(h);
    const loopRun = mintRunId();
    // The rows a top-level loop writes when a sub-agent beneath it parks: its
    // park row names no execution, and may name no decision.
    plant(h.dir, { id: loopRun, state: "running", execution, parent: root });
    plant(h.dir, { id: loopRun, state: "waiting-for-approval" });
    await exitWith(h, 36);
    const rows = rowsAt(h.dir);
    expect(statesOf(rows, loopRun)).toEqual(["running", "waiting-for-approval"]);
    expect(statesOf(rows, root).at(-1)).toBe("waiting-for-approval");
  });

  test("a daemon the last manager left, found dead at adoption, has its open runs interrupted", async () => {
    const h = setup("channel");
    const execution = "run_00000000000000aa";
    writeRunfile(h.dir, {
      v: RUNFILE_VERSION,
      pid: 9_999,
      pidStartTimeMs: 1,
      argvFingerprint: "gone",
      entry: "daemon.ts",
      bundleDir: join(h.dir, "dist"),
      runId: execution,
      startedAt: new Date(0).toISOString(),
      managerVersion: "0.8.0",
    });
    const open = mintRunId();
    const parked = mintRunId();
    plant(h.dir, { id: open, state: "running", execution, trigger: { kind: "channel" } });
    plant(h.dir, { id: parked, state: "running", execution });
    plant(h.dir, {
      id: parked,
      state: "waiting-for-approval",
      execution,
      decision: "appr_0123456789abcdef",
    });
    expect(await h.supervisor.adopt()).toBe("lost");
    await h.supervisor.idle();
    const rows = rowsAt(h.dir);
    expect(rows.filter((r) => r["id"] === open).at(-1)).toMatchObject({
      state: "interrupted",
      by: "sys:reconcile",
      trigger: { kind: "channel" },
    });
    expect(statesOf(rows, parked)).toEqual(["running", "waiting-for-approval"]);
  });

  test("an exit with no run ledger creates none", async () => {
    const h = setup("channel");
    await h.supervisor.start();
    // A terminal exit: no restart is scheduled, so the supervisor goes idle.
    await exitWith(h, 20);
    expect(rowsAt(h.dir)).toEqual([]);
    expect(existsSync(join(h.dir, RUN_LEDGER_DIR))).toBe(false);
    expect(existsSync(join(h.dir, ".crewhaus", "run", "control"))).toBe(false);
  });
});
