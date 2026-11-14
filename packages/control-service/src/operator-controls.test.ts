import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandReceipt } from "@crewhaus/control-contract";
import { readOperatorRecord } from "@crewhaus/control-records";
import { settleStart, settleStop } from "./core-runtime";
import { commandsLedgerOf } from "./ledgers";
import {
  type OperatorControlKind,
  type OperatorReload,
  applyOperatorControl,
  operatorControlLine,
  reconcileOperatorControl,
} from "./operator-controls";
import { outcomeOf } from "./refusal";
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

const iso = (ms: number): string => new Date(ms).toISOString();
const OPERATOR = join(".crewhaus", "run", "control", "operator.json");

function onDisk(harness: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(harness, OPERATOR), "utf8"));
}

/** Run one control through the service, as `crewhaus daemon <verb>` does. */
async function control(
  r: ReturnType<typeof rig>,
  kind: OperatorControlKind,
  extra: { readonly quiet?: boolean; readonly reload?: OperatorReload } = {},
) {
  const answer = await r.service.commands.submit(
    {
      kind,
      ledger: { harness: r.harness },
      via: "cli",
      ...(extra.quiet === true ? { body: { quiet: true } } : {}),
    },
    async (receipt) => {
      const done = await applyOperatorControl(
        { receipt, harnessDir: r.harness, now: () => r.clock.now },
        { kind, ...extra },
      );
      return { settle: done.settle, value: done };
    },
  );
  if (!answer.ok || answer.replayed) throw new Error("not run");
  return { receipt: answer.receipt, value: answer.value };
}

/** A runfile for a live daemon on `controlPort`. */
function runfile(harness: string, controlPort?: number): void {
  const dir = join(harness, ".crewhaus", "run");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "daemon.json"),
    JSON.stringify({
      v: 1,
      pid: 4242,
      pidStartTimeMs: BOOTED + 10,
      argvFingerprint: "f",
      ...(controlPort !== undefined ? { controlPort } : {}),
      entry: "dist/daemon.ts",
      bundleDir: "dist",
      runId: "run_x",
      startedAt: iso(BOOTED + 10),
      managerVersion: "0.9.0",
    }),
  );
}

describe("the four controls write the operator record", () => {
  test("pause, quiet pause, resume, disable and enable: exact blocks, the receipt's actor and id", async () => {
    const r = rig();
    const at = iso(NOW);
    const pause = await control(r, "controls.pause");
    expect(pause.receipt.state).toBe("succeeded");
    expect(pause.receipt.effects[0]).toEqual({
      kind: "operator",
      status: "done",
      observed: "rev 1",
    });
    expect(onDisk(r.harness)).toEqual({
      v: 1,
      rev: 1,
      intake: { paused: true, since: at, by: pause.receipt.actor, cmd: pause.receipt.id },
      deployment: null,
      desired: "stopped",
    });
    expect(pause.receipt.actor.startsWith("local:#")).toBe(true);

    const quiet = await control(r, "controls.pause", { quiet: true });
    expect(onDisk(r.harness)["intake"]).toEqual({
      paused: true,
      since: at,
      by: quiet.receipt.actor,
      cmd: quiet.receipt.id,
      notice: null,
    });

    const resume = await control(r, "controls.resume");
    expect(onDisk(r.harness)["intake"]).toEqual({
      paused: false,
      since: at,
      by: resume.receipt.actor,
      cmd: resume.receipt.id,
    });
    expect(resume.receipt.effects[0]?.observed).toBe("rev 3");

    const disable = await control(r, "controls.disable");
    expect(onDisk(r.harness)["deployment"]).toEqual({
      disabled: true,
      since: at,
      by: disable.receipt.actor,
      cmd: disable.receipt.id,
    });
    const enable = await control(r, "controls.enable");
    expect(onDisk(r.harness)).toMatchObject({
      rev: 5,
      deployment: { disabled: false, cmd: enable.receipt.id },
      intake: { paused: false, cmd: resume.receipt.id },
    });
    expect(enable.receipt.state).toBe("succeeded");
  });

  test("a record that cannot be read is not written: failed, unavailable, and the reason only in the line", async () => {
    const r = rig();
    mkdirSync(join(r.harness, ".crewhaus", "run", "control"), { recursive: true });
    writeFileSync(join(r.harness, OPERATOR), "{ torn");
    const { receipt, value } = await control(r, "controls.disable");
    expect(receipt.state).toBe("failed");
    expect(receipt.outcome).toEqual(outcomeOf("unavailable"));
    expect(JSON.stringify(receipt)).not.toContain("can't be read");
    expect(value?.line).toContain("can't be read");
    expect(readFileSync(join(r.harness, OPERATOR), "utf8")).toBe("{ torn");
  });

  test("run by recovery: a pause already written is not written again; one not written gets the standard notice", async () => {
    const r = rig();
    const done = await control(r, "controls.pause", { quiet: true });
    const before = readFileSync(join(r.harness, OPERATOR), "utf8");
    const again = await applyOperatorControl(
      { receipt: done.receipt, harnessDir: r.harness, now: () => NOW },
      { kind: "controls.pause", recovered: true },
    );
    expect(again.settle.state).toBe("succeeded");
    expect(readFileSync(join(r.harness, OPERATOR), "utf8")).toBe(before);

    const fresh = tempDir();
    const receipt = { ...done.receipt, id: "cmd_01m76e6f05hp514w9j4v3qymkq" } as CommandReceipt;
    const recovered = await applyOperatorControl(
      { receipt, harnessDir: fresh, now: () => NOW },
      { kind: "controls.pause", quiet: true, recovered: true },
    );
    expect(recovered.settle.effects?.[0]).toEqual({
      kind: "operator",
      status: "done",
      observed: "rev 1",
      note: "recovered: written with the standard notice",
    });
    const intake = onDisk(fresh)["intake"] as Record<string, unknown>;
    expect(intake["cmd"]).toBe(receipt.id);
    expect("notice" in intake).toBe(false);
  });
});

describe("what the daemon made of it", () => {
  const ctxFor = (harness: string, receipt: CommandReceipt) => ({
    receipt,
    harnessDir: harness,
    now: () => NOW,
    probe: fakeProbe({ 4242: { alive: true, start: BOOTED + 10 } }),
  });
  const receiptFor = async (r: ReturnType<typeof rig>) =>
    (await control(r, "controls.resume")).receipt;

  test("no runfile: skipped, applies when it starts", async () => {
    const r = rig();
    const receipt = await receiptFor(r);
    const answer = await applyOperatorControl(ctxFor(r.harness, receipt), {
      kind: "controls.pause",
      reload: async () => {
        throw new Error("never called");
      },
    });
    expect(answer.settle.effects?.[1]).toEqual({
      kind: "daemon",
      status: "skipped",
      note: "applies when it starts",
    });
    expect(answer.line).toBe("Recorded; the daemon isn't running and applies it when it starts");
  });

  test("a recorded daemon that is gone counts as not running", async () => {
    const r = rig();
    runfile(r.harness, 5555);
    const receipt = await receiptFor(r);
    const answer = await applyOperatorControl(
      { ...ctxFor(r.harness, receipt), probe: fakeProbe() },
      { kind: "controls.pause" },
    );
    expect(answer.daemon).toBe("not-running");
  });

  test("200 with this rev confirms; the record is written before the call", async () => {
    const r = rig();
    runfile(r.harness, 5555);
    const receipt = await receiptFor(r);
    const seen: Array<{ port: number | undefined; rev: unknown }> = [];
    const answer = await applyOperatorControl(ctxFor(r.harness, receipt), {
      kind: "controls.disable",
      reload: async (target) => {
        seen.push({ port: target.controlPort, rev: onDisk(r.harness)["rev"] });
        return { ok: true, body: { operator: { rev: 2 } } };
      },
    });
    expect(seen).toEqual([{ port: 5555, rev: 2 }]);
    expect(answer.settle.effects?.[1]).toEqual({
      kind: "daemon",
      status: "done",
      observed: "confirmed",
    });
    expect(answer.line).toBe("Disabled; the daemon confirmed");
  });

  test("200 with a lower rev, a throw, a refusal and no port are unknown: applies within a second", async () => {
    const r = rig();
    runfile(r.harness, 5555);
    const receipt = await receiptFor(r);
    const answers: OperatorReload[] = [
      async () => ({ ok: true, body: { operator: { rev: 1 } } }),
      async () => {
        throw new Error("timed out");
      },
      async () => ({ ok: false, code: "unreachable" }),
    ];
    for (const reload of answers) {
      const answer = await applyOperatorControl(ctxFor(r.harness, receipt), {
        kind: "controls.pause",
        reload,
      });
      expect(answer.settle.state).toBe("succeeded");
      expect(answer.settle.effects?.[1]).toEqual({
        kind: "daemon",
        status: "unknown",
        note: "applies within a second",
      });
      expect(answer.line).toBe("Paused new work; the daemon applies it within a second");
    }
    runfile(r.harness);
    const noPort = await applyOperatorControl(ctxFor(r.harness, receipt), {
      kind: "controls.pause",
      reload: async () => ({ ok: true, body: { operator: { rev: 99 } } }),
    });
    expect(noPort.daemon).toBe("within-a-second");
  });

  test("404 is a build without the route: recorded, not enforced", async () => {
    const r = rig();
    runfile(r.harness, 5555);
    const receipt = await receiptFor(r);
    const answer = await applyOperatorControl(ctxFor(r.harness, receipt), {
      kind: "controls.pause",
      reload: async () => ({ ok: false, code: "unsupported_by_bundle" }),
    });
    expect(answer.settle.effects?.[1]).toEqual({
      kind: "daemon",
      status: "skipped",
      note: "recorded, not enforced: rebuild to apply it",
    });
    expect(answer.line).toBe(
      "Recorded, not enforced: this build predates pause. Recompile to apply it.",
    );
    expect(operatorControlLine("controls.enable", "not-enforced")).toContain("predates disable");
  });
});

describe("reconciling a control", () => {
  test("done when its block names the receipt, not-done for another, unknown when unreadable", async () => {
    const r = rig();
    const pause = await control(r, "controls.pause");
    const ctx = { harnessDir: r.harness, probe: fakeProbe(), now: () => NOW };
    expect(await reconcileOperatorControl(pause.receipt, ctx)).toBe("done");
    // The disable block does not name a pause.
    expect(
      await reconcileOperatorControl({ ...pause.receipt, kind: "controls.disable" }, ctx),
    ).toBe("not-done");
    const resume = await control(r, "controls.resume");
    expect(await reconcileOperatorControl(pause.receipt, ctx)).toBe("not-done");
    expect(await reconcileOperatorControl(resume.receipt, ctx)).toBe("done");
    expect(await reconcileOperatorControl(pause.receipt, { ...ctx, harnessDir: tempDir() })).toBe(
      "not-done",
    );
    writeFileSync(join(r.harness, OPERATOR), "[]");
    readOperatorRecord.refresh(r.harness);
    expect(await reconcileOperatorControl(resume.receipt, ctx)).toBe("unknown");
  });
});

describe("recovery families", () => {
  const PAUSE = "cmd_01m76e6f05hp514w9j4v3qymka";
  const LATER = "cmd_01m76e6f05hp514w9j4v3qymkb";

  test("a dead pause followed by a resume is not run again, and the record is unchanged", async () => {
    const r = rig({ pid: 1000 });
    const ledger = commandsLedgerOf(r.harness);
    plantReceipt(ledger, { id: PAUSE, kind: "controls.pause", acceptedAt: iso(NOW - 3_600_000) });
    plantReceipt(ledger, {
      id: LATER,
      kind: "controls.resume",
      state: "succeeded",
      acceptedAt: iso(NOW - 60_000),
      executor: { pid: 1000, startedAt: iso(BOOTED + 1000), host: HOST, head: "cli" },
    });
    expect(await r.service.commands.recover({ harness: r.harness })).toEqual({
      redispatched: 0,
      reconciled: 0,
      unknown: 1,
    });
    expect(readOperatorRecord.refresh(r.harness)).toEqual({ state: "absent" });
    const last = rowsOf(ledger)
      .filter((row) => row["id"] === PAUSE)
      .at(-1);
    expect(last?.["outcome"]).toEqual({
      code: "interrupted",
      message: "superseded by a later command",
    });
  });

  test("a dead stop followed by a pause still runs: the families are independent", async () => {
    const r = rig({ pid: 1000 });
    const ledger = commandsLedgerOf(r.harness);
    plantReceipt(ledger, { id: PAUSE, kind: "controls.stop", acceptedAt: iso(NOW - 3_600_000) });
    plantReceipt(ledger, {
      id: LATER,
      kind: "controls.pause",
      state: "succeeded",
      acceptedAt: iso(NOW - 60_000),
      executor: { pid: 1000, startedAt: iso(BOOTED + 1000), host: HOST, head: "cli" },
    });
    expect(await r.service.commands.recover({ harness: r.harness })).toEqual({
      redispatched: 1,
      reconciled: 0,
      unknown: 0,
    });
    expect(r.supervisor.calls).toContain("stop");
  });

  test("a dead pause with nothing after it is run again, with the standard notice", async () => {
    const r = rig({ pid: 1000 });
    plantReceipt(commandsLedgerOf(r.harness), {
      id: PAUSE,
      kind: "controls.pause",
      acceptedAt: iso(NOW - 60_000),
    });
    expect(await r.service.commands.recover({ harness: r.harness })).toEqual({
      redispatched: 1,
      reconciled: 0,
      unknown: 0,
    });
    // Dispatched with no supervisor: the operator controls act on records alone.
    expect(r.supervisor.calls).toEqual([]);
    expect(onDisk(r.harness)["intake"]).toMatchObject({ paused: true, cmd: PAUSE });
  });
});

describe("settling a start and a stop", () => {
  test("a disabled harness's start is rejected disabled; a kept restart keeps running, still disabled", () => {
    expect(
      settleStart({
        ok: false,
        reason: "disabled",
        exitName: "disabled",
        cause: "disabled",
        message: "Disabled",
      }),
    ).toEqual({ state: "rejected", outcome: outcomeOf("disabled") });
    expect(
      settleStart({
        ok: false,
        reason: "disabled",
        exitName: "disabled",
        cause: "disabled",
        message: "Disabled",
        kept: true,
      }),
    ).toEqual({
      state: "rejected",
      effects: [{ kind: "daemon", status: "skipped", note: "kept running" }],
      outcome: outcomeOf("disabled"),
    });
  });

  test("what the operator asked for is one more effect, done or failed", () => {
    expect(settleStart({ ok: true, runId: "run_x", pid: 1, desired: "recorded" })).toEqual({
      state: "succeeded",
      effects: [
        { kind: "daemon", status: "done", observed: "started" },
        { kind: "operator", status: "done", observed: "desired running" },
      ],
    });
    expect(settleStop({ stopped: true, forced: false, desired: "not-recorded" }).effects).toEqual([
      { kind: "daemon", status: "done", observed: "stopped" },
      { kind: "operator", status: "failed", observed: "desired stopped" },
    ]);
    expect(settleStop({ stopped: false, forced: false, desired: "recorded" }).effects).toEqual([
      { kind: "daemon", status: "skipped", note: "not running" },
      { kind: "operator", status: "done", observed: "desired stopped" },
    ]);
    expect(settleStart({ ok: true, runId: "run_x", pid: 1 }).effects).toHaveLength(1);
  });
});
