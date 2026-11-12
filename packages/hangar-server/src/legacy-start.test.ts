/**
 * Home's Start of a harness with no deployment record, whose start compiles first
 * (`manager.autoCompile`): the build that start compiled is recorded and activated, so the
 * harness runs and is recorded at that start.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { casAppend, deploymentsLedger, readDeployments } from "@crewhaus/control-records";
import { admitExplicitStart } from "@crewhaus/control-service";
import {
  type PrepareOutcome,
  type PrepareRunner,
  buildDigest,
  buildSpawnPlan,
  createHarnessSupervisor,
} from "@crewhaus/harness-supervisor";
import { createTestClock, createTestProcessOps } from "./testkit";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const ACTOR = `local:#${"a".repeat(64)}`;

function harness(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hangar-legacy-start-")));
  roots.push(dir);
  put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n");
  put(dir, ".crewhaus/settings.json", JSON.stringify({ manager: { autoCompile: true } }));
  return dir;
}

let seq = 0;
/** A start's compile, as `crewhaus compile -o dist` leaves it: the bundle, then a prepared row. */
function compilingPrepare(dir: string): () => PrepareRunner {
  return () => ({
    configured: { compile: true, compileMode: "auto", hooks: [] },
    prepare: async (): Promise<PrepareOutcome> => {
      put(dir, "dist/daemon.ts", "// compiled at this start\n");
      const taken = buildDigest(dir, { entry: "dist/daemon.ts" });
      if ("unreadable" in taken) throw new Error(taken.unreadable);
      seq += 1;
      const id = `dep_01${String(seq).padStart(24, "0")}`;
      await casAppend(deploymentsLedger(dir), id, null, {
        id,
        state: "prepared",
        artifact: { digest: taken.digest, entry: "dist/daemon.ts", bootInputs: [] },
      });
      return { ok: true, replan: true, notes: ["bundle: compiled"] };
    },
    preSpawn: async (): Promise<PrepareOutcome> => ({ ok: true, replan: false, notes: [] }),
  });
}

function homeSupervisor(dir: string) {
  const clock = createTestClock(Date.parse("2026-11-12T00:00:00.000Z"));
  const ops = createTestProcessOps(clock.now);
  const supervisor = createHarnessSupervisor({
    harnessDir: dir,
    target: "channel",
    ops,
    clock,
    plan: () =>
      buildSpawnPlan({ harnessDir: dir, target: "channel", processEnv: {}, ports: { port: 3000 } }),
    prepare: compilingPrepare(dir),
    // Bound the way Home binds its Start.
    admit: async ({ harnessDir, target, entry, ledgerAbsent }) =>
      admitExplicitStart(harnessDir, target, {
        head: "home",
        actor: ACTOR,
        entry,
        ledgerAbsent,
        now: clock.now,
      }),
  });
  return { ops, supervisor };
}

describe("Home's Start of a harness with no deployment record", () => {
  test("autoCompile compiles it, and the start records, activates and runs that build", async () => {
    const dir = harness();
    put(dir, "dist/daemon.ts", "// a stale bundle from before the spec's last edit\n");
    const { ops, supervisor } = homeSupervisor(dir);
    const result = await supervisor.start();
    expect(result).toMatchObject({ ok: true });
    expect(ops.children).toHaveLength(1);
    const read = readDeployments(dir);
    if (read.state !== "present") throw new Error("absent");
    expect(read.active?.["autostart"]).toBe(false);
    expect(read.active?.["gates"]).toBe("not-run");
    expect(ops.last()?.request.env["CREWHAUS_DEPLOYMENT_ID"]).toBe(read.active?.["id"] as string);
    supervisor.close();
  });

  test("a harness that already had a prepared build nobody activated is refused", async () => {
    const dir = harness();
    put(dir, "dist/daemon.ts", "// compiled earlier\n");
    const taken = buildDigest(dir, { entry: "dist/daemon.ts" });
    if ("unreadable" in taken) throw new Error(taken.unreadable);
    await casAppend(deploymentsLedger(dir), "dep_01aaaaaaaaaaaaaaaaaaaaaaaa", null, {
      id: "dep_01aaaaaaaaaaaaaaaaaaaaaaaa",
      state: "prepared",
      artifact: { digest: taken.digest, entry: "dist/daemon.ts", bootInputs: [] },
    });
    const { ops, supervisor } = homeSupervisor(dir);
    const result = await supervisor.start();
    expect(result).toMatchObject({ ok: false, reason: "build-not-active" });
    expect(!result.ok && "message" in result && result.message).toContain("Activate this build");
    expect(ops.children).toHaveLength(0);
    supervisor.close();
  });
});
