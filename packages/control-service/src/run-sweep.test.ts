/**
 * The core's run sweep: a chat message a channel daemon accepted, whose process died
 * before its turn started, is closed by recovery as not processed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mintRunId } from "@crewhaus/control-contract";
import { append, appendPreparingRun, foldStates, runsLedger } from "@crewhaus/control-records";
import { AREA_RUNTIMES, compositionProblems } from "./areas";
import { CORE_RUNTIME, channelRunSweep } from "./core-runtime";
import { BOOTED, HOST, NOW, fakeProbe, removeTempDirs, rig, rowsOf } from "./test-helpers";

afterAll(removeTempDirs);

const iso = (ms: number): string => new Date(ms).toISOString();
const CHANNEL = { kind: "channel", via: "slack" };

/** A message accepted by a daemon `pid` that started at `startedAt`. */
function accepted(
  harness: string,
  pid: number,
  startedAt: number,
  trigger: Record<string, unknown> = CHANNEL,
): string {
  const id = mintRunId();
  const answer = appendPreparingRun(runsLedger(harness), {
    id,
    at: iso(NOW - 60_000),
    trigger,
    holder: { pid, host: HOST, startedAt: iso(startedAt) },
  });
  if (!answer.ok) throw new Error(answer.reason);
  return id;
}

function stateOf(harness: string, id: string): unknown {
  return rowsOf(runsLedger(harness))
    .filter((row) => row["id"] === id)
    .at(-1)?.["state"];
}

describe("recovery closes a channel message whose turn never started", () => {
  test("a dead holder's preparing run is interrupted, not processed, by sys:reconcile", async () => {
    const r = rig({ pid: 1000 });
    // pid 77 is gone: the fake probe answers dead for a pid it does not know.
    const id = accepted(r.harness, 77, BOOTED + 1_000);
    const counts = await r.service.commands.recover({ harness: r.harness });
    expect(counts).toEqual({ redispatched: 0, reconciled: 0, unknown: 0, runsInterrupted: 1 });
    const last = rowsOf(runsLedger(r.harness))
      .filter((row) => row["id"] === id)
      .at(-1);
    expect(last).toMatchObject({
      id,
      state: "interrupted",
      reason: "not-processed",
      by: "sys:reconcile",
      trigger: CHANNEL,
    });
    const fold = foldStates(runsLedger(r.harness));
    if (!fold.ok) throw new Error(fold.reason);
    expect(fold.anomalies).toEqual([]);
    // A second recovery writes nothing and names no sweep.
    const before = rowsOf(runsLedger(r.harness)).length;
    expect(await r.service.commands.recover({ harness: r.harness })).toEqual({
      redispatched: 0,
      reconciled: 0,
      unknown: 0,
    });
    expect(rowsOf(runsLedger(r.harness))).toHaveLength(before);
  });

  test("a holder that started before the machine booted is interrupted, whatever its pid answers", async () => {
    const probe = fakeProbe({ 1000: { alive: true }, 55: { alive: true } });
    const r = rig({ pid: 1000, probe });
    const id = accepted(r.harness, 55, BOOTED - 60_000);
    expect((await r.service.commands.recover("all")).runsInterrupted).toBe(1);
    expect(stateOf(r.harness, id)).toBe("interrupted");
  });

  test("a live holder, an unprovable one, a run that is not a channel's and a started run are left", async () => {
    const probe = fakeProbe({
      1000: { alive: true },
      61: { alive: true, start: BOOTED + 5_000 },
      62: { alive: undefined },
    });
    const r = rig({ pid: 1000, probe });
    const live = accepted(r.harness, 61, BOOTED + 5_000);
    const unprovable = accepted(r.harness, 62, BOOTED + 5_000);
    const notChannel = accepted(r.harness, 77, BOOTED + 1_000, { kind: "cli" });
    const started = accepted(r.harness, 77, BOOTED + 1_000);
    append(runsLedger(r.harness), {
      id: started,
      state: "running",
      at: iso(NOW - 30_000),
      trigger: CHANNEL,
    });
    const before = rowsOf(runsLedger(r.harness)).length;
    expect(await r.service.commands.recover({ harness: r.harness })).toEqual({
      redispatched: 0,
      reconciled: 0,
      unknown: 0,
    });
    expect(rowsOf(runsLedger(r.harness))).toHaveLength(before);
    expect(stateOf(r.harness, live)).toBe("preparing");
    expect(stateOf(r.harness, unprovable)).toBe("preparing");
    expect(stateOf(r.harness, notChannel)).toBe("preparing");
    expect(stateOf(r.harness, started)).toBe("running");
  });

  test("a harness with no run ledger answers nothing and creates nothing", async () => {
    const r = rig({ pid: 1000 });
    expect(
      await channelRunSweep(r.harness, {
        probe: fakeProbe(),
        host: HOST,
        hostBootedAt: BOOTED,
        now: NOW,
      }),
    ).toBe(0);
    expect(rowsOf(runsLedger(r.harness))).toEqual([]);
  });

  test("the sweep is the core's, and the composition still has no problem (a control)", () => {
    expect(CORE_RUNTIME.runSweeps).toEqual([channelRunSweep]);
    expect(compositionProblems(AREA_RUNTIMES)).toEqual([]);
  });
});
