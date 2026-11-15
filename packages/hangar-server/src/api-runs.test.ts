/**
 * The process layer's API runs, on Home's fake process seam: a start is admitted against
 * the caps in the same tick it is asked for, one harness's starts prepare and spawn one at
 * a time, and a run the layer already holds is never started twice. Nothing is spawned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mintRunId } from "@crewhaus/control-contract";
import { append, controlPaths, runsLedger } from "@crewhaus/control-records";
import { type HangarHarnessEntry, openHangarRegistry } from "@crewhaus/harness-registry";
import { makeFixtureHarness } from "./fixture";
import type { ProcessLayer } from "./process";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.stop();
});

type Child = NonNullable<TestServer["ops"]>["children"][number];

/** A Home whose own process layer the test drives directly. */
function layered(limits: { perHarness?: number; perHome?: number }): {
  readonly t: TestServer;
  readonly layer: () => ProcessLayer;
} {
  let captured: ProcessLayer | undefined;
  const t = bootTestServer({
    apiRunLimits: limits,
    wrapProcessLayer: (layer) => {
      captured = layer;
      return layer;
    },
  });
  servers.push(t);
  return {
    t,
    layer: () => {
      if (captured === undefined) throw new Error("no process layer");
      return captured;
    },
  };
}

/** A registered cli harness with its own `crewhaus`, and its `preSpawn` hook when given. */
async function harness(
  t: TestServer,
  name: string,
  preSpawn?: readonly string[],
): Promise<HangarHarnessEntry> {
  const dir = makeFixtureHarness(join(t.harnessesRoot, name), { specName: name });
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "crewhaus"), 0o755);
  if (preSpawn !== undefined) {
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { hooks: { preSpawn } } }),
    );
  }
  const res = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  const id = (res.body["entry"] as { id: string }).id;
  const entry = openHangarRegistry({
    root: t.registryRoot,
    env: { CREWHAUS_WATCHME_ROOT: join(t.workspace, "watchme") },
    now: Date.now,
    onWarn: () => {},
  }).get(id);
  if (entry === undefined) throw new Error(`no registry entry for ${id}`);
  return entry;
}

/** A run the API queued on a harness, as the run adapter leaves one before its start. */
function queued(entry: HangarHarnessEntry): { readonly runId: string; readonly inputFile: string } {
  const runId = mintRunId();
  const inputs = join(entry.dir, controlPaths(entry.dir).inputsDir);
  mkdirSync(inputs, { recursive: true });
  const inputFile = join(inputs, `${runId}.json`);
  writeFileSync(inputFile, JSON.stringify({ v: 1, run: runId, input: "x" }), { mode: 0o600 });
  append(runsLedger(entry.dir), {
    id: runId,
    state: "queued",
    at: new Date().toISOString(),
    trigger: { kind: "api" },
    by: "sys:reconcile",
  });
  return { runId, inputFile };
}

const isHook = (child: Child) => child.request.argv[0] === "/usr/bin/false";
const isJob = (child: Child) => child.request.argv[1] === "run";

/** Wait, over a bounded count of ticks, until `count()` reaches `want`. */
async function until(count: () => number, want: number): Promise<void> {
  for (let tick = 0; tick < 5000 && count() < want; tick += 1) await Bun.sleep(0);
  expect(count()).toBe(want);
}

describe("API runs on the process layer", () => {
  test("two starts on one harness asked in one tick: past a cap of one, the second is refused busy and spawns nothing", async () => {
    const { t, layer } = layered({ perHarness: 1 });
    const entry = await harness(t, "race");
    const [a, b] = [queued(entry), queued(entry)];
    const start = layer().startApiRun;
    if (start === undefined) throw new Error("no startApiRun");
    const [first, second] = await Promise.all([start(entry, a), start(entry, b)]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, reason: "plan-failed", stage: "spawn" });
    expect("error" in second ? second.error.message : "").toBe(
      "This harness is already running as many API runs as Home allows at once. Try again shortly.",
    );
    expect((t.ops?.children ?? []).filter(isJob)).toHaveLength(1);
    expect(layer().apiRunCapacity?.(entry)).toMatchObject({ ok: false, scope: "harness" });
  });

  test("one harness's starts prepare one at a time: the second hook runs only once the first exits", async () => {
    const { t, layer } = layered({ perHarness: 2 });
    const entry = await harness(t, "serial", ["/usr/bin/false"]);
    const start = layer().startApiRun;
    if (start === undefined) throw new Error("no startApiRun");
    const hooks = () => (t.ops?.children ?? []).filter(isHook);
    const first = start(entry, queued(entry));
    const second = start(entry, queued(entry));
    await until(() => hooks().length, 1);
    // A bounded number of ticks more: the second start is still waiting its turn.
    for (let tick = 0; tick < 50; tick += 1) await Bun.sleep(0);
    expect(hooks()).toHaveLength(1);
    hooks()[0]?.exit(1);
    expect(await first).toMatchObject({ ok: false, reason: "prepare-refused" });
    await until(() => hooks().length, 2);
    hooks()[1]?.exit(1);
    expect(await second).toMatchObject({ ok: false, reason: "prepare-refused" });
    expect((t.ops?.children ?? []).filter(isJob)).toEqual([]);
    // Both refused: neither holds a place under the cap.
    expect(layer().apiRunCapacity?.(entry)).toEqual({ ok: true });
  });

  test("a run the layer already holds is not started again: no hook, no job", async () => {
    const { t, layer } = layered({});
    const entry = await harness(t, "held", ["/usr/bin/false"]);
    const start = layer().startApiRun;
    if (start === undefined) throw new Error("no startApiRun");
    const run = queued(entry);
    const hooks = () => (t.ops?.children ?? []).filter(isHook);
    const first = start(entry, run);
    await until(() => hooks().length, 1);
    hooks()[0]?.exit(0);
    expect((await first).ok).toBe(true);
    const spawned = t.ops?.children.length ?? 0;
    const asked = start(entry, run);
    // A bounded number of ticks: long enough for a hook to be spawned, were one run.
    for (let tick = 0; tick < 50; tick += 1) await Bun.sleep(0);
    expect(t.ops?.children.length).toBe(spawned);
    const again = await asked;
    expect(again).toMatchObject({ ok: false, reason: "plan-failed", stage: "spawn" });
    expect("error" in again ? again.error.message : "").toBe(
      "This run is already starting or running.",
    );
    expect(t.ops?.children.length).toBe(spawned);
  });
});
