/**
 * The reconcile sweep: an `unknown` receipt is settled by what its reconciler observes,
 * a receipt recovery left unknown on purpose is left as recorded, and nothing is written
 * when nothing is settled.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mintId } from "@crewhaus/control-contract";
import { casAppend, deploymentsLedger } from "@crewhaus/control-records";
import { buildDigest } from "@crewhaus/harness-supervisor";
import { AREA_RUNTIMES, activationGates } from "./areas";
import { activateDeployment } from "./deployments";
import { commandsLedgerOf, workspaceCommandsLedger } from "./ledgers";
import {
  NEEDS_DECISION,
  NOT_STARTED_REBOOT,
  type Outcome,
  RECONCILED_NOT_DONE,
  SUPERSEDED,
} from "./refusal";
import { LIFECYCLE_FILE } from "./retire";
import {
  BOOTED,
  HOST,
  IDENTITY,
  NOW,
  fakeProbe,
  park,
  plantProjection,
  plantReceipt,
  removeTempDirs,
  rig,
  rowsOf,
  setUpOwner,
  tempDir,
  treeBytes,
} from "./test-helpers";
import { wireControl } from "./wire";

afterAll(removeTempDirs);

const HRN = "hrn_00000000000000c1";
const iso = (ms: number): string => new Date(ms).toISOString();

function lastRow(ledgerRows: Record<string, unknown>[], id: string) {
  return ledgerRows.filter((row) => row["id"] === id).at(-1);
}

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

let seq = 0;
async function prepared(dir: string): Promise<string> {
  put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n");
  put(dir, "dist/daemon.ts", "// bundle\n");
  seq += 1;
  const id = `dep_01${String(seq).padStart(24, "0")}`;
  const taken = buildDigest(dir, { entry: "dist/daemon.ts" });
  if ("unreadable" in taken) throw new Error(taken.unreadable);
  await casAppend(deploymentsLedger(dir), id, null, {
    id,
    state: "prepared",
    artifact: {
      digest: taken.digest,
      specHash: `sha256:${"b".repeat(64)}`,
      compiledWith: "0.9.0",
      shape: "channel",
      entry: "dist/daemon.ts",
      bootInputs: [],
    },
  });
  return id;
}

/** An `unknown` receipt, as recovery leaves one. */
function unknownReceipt(
  harness: string,
  fields: { id?: string; kind: string; target: string; actor?: string; outcome?: Outcome },
): string {
  const id = fields.id ?? mintId("cmd", { now: NOW - 60_000 });
  plantReceipt(commandsLedgerOf(harness), {
    id,
    kind: fields.kind,
    target: fields.target,
    ...(fields.actor !== undefined ? { actor: fields.actor } : {}),
    state: "unknown",
    outcome: fields.outcome ?? NEEDS_DECISION,
  });
  return id;
}

describe("an activation that names only the harness", () => {
  test("a deployment carrying the receipt's id: succeeded", async () => {
    const r = rig({ mode: "server" });
    const dep = await prepared(r.harness);
    const id = unknownReceipt(r.harness, {
      kind: "deployments.activate",
      target: `home/harness/${HRN}`,
    });
    await activateDeployment({
      harnessDir: r.harness,
      dep,
      actor: `local:#${"a".repeat(64)}`,
      cmd: id,
      gates: activationGates(AREA_RUNTIMES),
    });
    const counts = await r.service.commands.reconcile("all");
    expect(counts).toEqual({ succeeded: 1, failed: 0, left: 0 });
    const row = lastRow(rowsOf(commandsLedgerOf(r.harness)), id);
    expect(row?.["state"]).toBe("succeeded");
    expect(row?.["effects"]).toEqual([{ kind: "reconcile", status: "done" }]);
  });

  test("no deployment carries it: failed, with the reconciled outcome", async () => {
    const r = rig({ mode: "server" });
    await prepared(r.harness);
    const id = unknownReceipt(r.harness, {
      kind: "deployments.activate",
      target: `home/harness/${HRN}`,
    });
    await r.service.commands.reconcile("all");
    const row = lastRow(rowsOf(commandsLedgerOf(r.harness)), id);
    expect(row?.["state"]).toBe("failed");
    expect(row?.["outcome"]).toEqual(RECONCILED_NOT_DONE);
    expect(row?.["outcome"]).not.toEqual(NEEDS_DECISION);
  });

  test("deployments that cannot be read: left unknown, and nothing is written", async () => {
    const r = rig({ mode: "server" });
    unknownReceipt(r.harness, { kind: "deployments.activate", target: `home/harness/${HRN}` });
    mkdirSync(join(r.harness, ".crewhaus", "run", "control", "deployments.jsonl"), {
      recursive: true,
    });
    const before = treeBytes(r.harness);
    expect(await r.service.commands.reconcile("all")).toEqual({
      succeeded: 0,
      failed: 0,
      left: 1,
    });
    expect(treeBytes(r.harness)).toEqual(before);
  });

  test("a receipt that names the deployment is settled as before", async () => {
    const r = rig({ mode: "server" });
    const dep = await prepared(r.harness);
    const id = unknownReceipt(r.harness, {
      kind: "deployments.activate",
      target: `${HRN}/deployment/${dep}`,
    });
    // Still prepared: not done.
    await r.service.commands.reconcile("all");
    const row = lastRow(rowsOf(commandsLedgerOf(r.harness)), id);
    expect([row?.["state"], row?.["outcome"]]).toEqual(["failed", RECONCILED_NOT_DONE]);
  });
});

describe("a decision made and interrupted settles by what the approval records", () => {
  async function governed() {
    const r = rig({ mode: "server" });
    const owner = await setUpOwner(r.hangarRoot, IDENTITY);
    const other = mintId("prn");
    plantProjection(r.harness, owner, [{ principal: other, decide: "operator" }]);
    return { ...r, owner, other };
  }

  test("the receipt's own actor's claim: succeeded", async () => {
    const r = await governed();
    const p = await park(r.harness, "Write", { path: "a.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: { kind: "principal", principal: r.owner },
      via: "home",
    });
    const id = unknownReceipt(r.harness, {
      kind: "decisions.resolve",
      target: `${HRN}/decision/${p.id}`,
      actor: r.owner,
    });
    await r.service.commands.reconcile("all");
    expect(lastRow(rowsOf(commandsLedgerOf(r.harness)), id)?.["state"]).toBe("succeeded");
  });

  test("another member's claim: failed", async () => {
    const r = await governed();
    const p = await park(r.harness, "Write", { path: "a.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "deny",
      actor: { kind: "principal", principal: r.other },
      via: "home",
    });
    const id = unknownReceipt(r.harness, {
      kind: "decisions.resolve",
      target: `${HRN}/decision/${p.id}`,
      actor: r.owner,
    });
    await r.service.commands.reconcile("all");
    const row = lastRow(rowsOf(commandsLedgerOf(r.harness)), id);
    expect([row?.["state"], row?.["outcome"]]).toEqual(["failed", RECONCILED_NOT_DONE]);
  });
});

describe("a retire in Home's ledger, after its harness is archived", () => {
  test("reaches its reconciler with no directory, and the lifecycle line settles it", async () => {
    const hangarRoot = tempDir("control-service-home-");
    const service = wireControl(
      {
        hangarRoot,
        // The harness is archived: no live directory, and none to visit.
        harnessDirOf: () => undefined,
        harnessDirs: () => [],
        supervisorFor: () => undefined,
        drainRequest: () => async () => undefined,
        identity: IDENTITY,
        now: () => NOW,
        probe: fakeProbe(),
        hostBootedAt: () => BOOTED,
        host: HOST,
      },
      { mode: "server" },
    );
    const id = mintId("cmd", { now: NOW - 60_000 });
    plantReceipt(workspaceCommandsLedger(hangarRoot), {
      id,
      kind: "controls.retire",
      target: `home/harness/${HRN}`,
      state: "unknown",
      outcome: NEEDS_DECISION,
    });
    mkdirSync(join(hangarRoot, dirname(LIFECYCLE_FILE)), { recursive: true });
    appendFileSync(
      join(hangarRoot, LIFECYCLE_FILE),
      `${JSON.stringify({ type: "harness.retired", harness: HRN, cmd: id, at: iso(NOW) })}\n`,
    );
    expect(await service.commands.reconcile("all")).toEqual({ succeeded: 1, failed: 0, left: 0 });
    expect(lastRow(rowsOf(workspaceCommandsLedger(hangarRoot)), id)?.["state"]).toBe("succeeded");
  });
});

describe("left as recorded, writing nothing", () => {
  /** A live daemon that started after every receipt below: what a start reconciler calls done. */
  function liveDaemon(harness: string) {
    put(
      harness,
      ".crewhaus/run/daemon.json",
      JSON.stringify({ v: 1, pid: 50, pidStartTimeMs: NOW - 1000, argvFingerprint: "f" }),
    );
    return fakeProbe({
      1000: { alive: true, start: BOOTED + 1000 },
      50: { alive: true, start: NOW - 1000 },
    });
  }

  test("a kind with no reconciler", async () => {
    const r = rig({ mode: "server" });
    unknownReceipt(r.harness, { kind: "controls.stop", target: `home/harness/${HRN}` });
    const before = treeBytes(r.harness);
    expect(await r.service.commands.reconcile("all")).toEqual({
      succeeded: 0,
      failed: 0,
      left: 0,
    });
    expect(treeBytes(r.harness)).toEqual(before);
  });

  test("the setup the next two cases share: a start recovery could not settle is credited to the live daemon", async () => {
    const harness = tempDir("control-service-harness-");
    const r = rig({ mode: "server", harness, probe: liveDaemon(harness) });
    const id = unknownReceipt(harness, { kind: "controls.start", target: `home/harness/${HRN}` });
    await r.service.commands.reconcile("all");
    expect(lastRow(rowsOf(commandsLedgerOf(harness)), id)?.["state"]).toBe("succeeded");
  });

  for (const [name, outcome] of [
    ["superseded", SUPERSEDED],
    ["not started: the machine restarted", NOT_STARTED_REBOOT],
  ] as const) {
    test(`a start recovery left "${name}", even with a later live daemon`, async () => {
      const harness = tempDir("control-service-harness-");
      const r = rig({ mode: "server", harness, probe: liveDaemon(harness) });
      const id = unknownReceipt(harness, {
        kind: "controls.start",
        target: `home/harness/${HRN}`,
        outcome,
      });
      const before = treeBytes(harness);
      expect(await r.service.commands.reconcile("all")).toEqual({
        succeeded: 0,
        failed: 0,
        left: 0,
      });
      expect(treeBytes(harness)).toEqual(before);
      const row = lastRow(rowsOf(commandsLedgerOf(harness)), id);
      expect([row?.["state"], row?.["outcome"]]).toEqual(["unknown", outcome]);
    });
  }

  test("a start a later start on the same harness overtook", async () => {
    const harness = tempDir("control-service-harness-");
    const probe = liveDaemon(harness);
    const r = rig({ mode: "server", harness, probe });
    const older = unknownReceipt(harness, {
      id: mintId("cmd", { now: NOW - 120_000 }),
      kind: "controls.start",
      target: `home/harness/${HRN}`,
    });
    // The later start, accepted after the older one, then stopped: the operator asked since.
    plantReceipt(commandsLedgerOf(harness), {
      id: mintId("cmd", { now: NOW - 30_000 }),
      kind: "controls.stop",
      target: `home/harness/${HRN}`,
      acceptedAt: iso(NOW - 30_000),
      state: "succeeded",
    });
    const before = treeBytes(harness);
    await r.service.commands.reconcile("all");
    expect(treeBytes(harness)).toEqual(before);
    expect(lastRow(rowsOf(commandsLedgerOf(harness)), older)?.["state"]).toBe("unknown");
  });
});
