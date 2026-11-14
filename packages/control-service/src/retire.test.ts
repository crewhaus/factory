import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type CommandReceipt, mintId, mintRunId } from "@crewhaus/control-contract";
import {
  append,
  foldStates,
  publishClaim,
  readOperatorRecord,
  readStandingRules,
  runsLedger,
} from "@crewhaus/control-records";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import { createPendingApprovalStore } from "@crewhaus/session-store";
import { AREA_RUNTIMES, retireRevokers } from "./areas";
import type { RetireRevoker } from "./executor";
import { LIFECYCLE_FILE, reconcileRetire, retireSteps } from "./retire";
import { createStandingRule } from "./rules";
import { NOW, fakeProbe, park, removeTempDirs, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const ACTOR = `local:#${"a".repeat(64)}`;

function retireReceipt(): CommandReceipt {
  const id = mintId("cmd", { now: NOW });
  return {
    id,
    v: 1,
    kind: "controls.retire",
    target: `home/cmd/${id}`,
    actor: ACTOR,
    via: "cli",
    fingerprint: "f".repeat(64),
    state: "accepted",
    acceptedAt: new Date(NOW).toISOString(),
    executor: { pid: 1, startedAt: new Date(NOW).toISOString(), host: "h", head: "cli" },
    effects: [],
    retry: { retryable: true, safety: "reconcile-first" },
  } as CommandReceipt;
}

function queue(harness: string): string {
  const id = mintRunId();
  const written = append(runsLedger(harness), {
    id,
    state: "queued",
    at: new Date(NOW).toISOString(),
    trigger: "api",
    tenant: "acme",
  });
  if (!written.ok) throw new Error(written.reason);
  return id;
}

function setUp(extra: { readonly revokers?: readonly RetireRevoker[] } = {}) {
  const hangarRoot = tempDir("control-service-home-");
  const harness = tempDir("control-service-harness-");
  const registry = openHangarRegistry({
    root: join(tempDir("control-service-registry-"), "registry"),
    env: {},
  });
  const row = registry.upsert({ dir: harness, specName: "concierge", target: "channel" });
  const receipt = retireReceipt();
  const steps = retireSteps({
    harnessDir: harness,
    harnessId: row.id,
    hangarRoot,
    receipt,
    stop: false,
    now: () => NOW,
    probe: fakeProbe(),
    registry,
    holder: { pid: 1, host: "h" },
    ...(extra.revokers !== undefined ? { revokers: extra.revokers } : {}),
  });
  return { hangarRoot, harness, registry, row, receipt, steps };
}

describe("retire's own steps", () => {
  test("disable, queued runs, approvals, standing rules, the lifecycle line and the registry row", async () => {
    const s = setUp();
    const queued = queue(s.harness);
    const parked = await park(s.harness, "Write", { path: "out.txt" });
    const rule = await createStandingRule({
      harnessDir: s.harness,
      tool: "Write",
      pattern: "Write(out.txt)",
      createdBy: ACTOR,
      reason: "approval",
      expiresAt: new Date(NOW + 86_400_000).toISOString(),
      now: NOW,
    } as never);
    expect(rule.ok).toBe(true);

    expect(await s.steps.stopAndDisable()).toMatchObject({ ok: true });
    const operator = readOperatorRecord.refresh(s.harness);
    expect(operator).toMatchObject({
      state: "present",
      record: { deployment: { disabled: true, by: ACTOR, cmd: s.receipt.id } },
    });

    expect(await s.steps.cancelQueuedRuns()).toMatchObject({ ok: true });
    const runs = foldStates(runsLedger(s.harness));
    if (!runs.ok) throw new Error(runs.reason);
    expect(runs.objects.get(queued)?.state).toBe("cancelled");
    expect(existsSync(join(s.harness, ".crewhaus", "run", "control", "claims"))).toBe(true);

    expect(await s.steps.expireDecisions()).toMatchObject({ ok: true });
    const store = createPendingApprovalStore({ rootDir: join(s.harness, ".crewhaus", "sessions") });
    expect(
      (
        await store.decide(parked.id, { choice: "grant", actor: {} }, {
          authorize: () => ({ ok: true }),
        } as never)
      ).outcome,
    ).toBe("expired");
    const logDir = join(s.harness, ".crewhaus", "sessions", "approvals.d", "decisions");
    const decisionLog = readdirSync(logDir)
      .map((name) => readFileSync(join(logDir, name), "utf8"))
      .join("");
    expect(decisionLog).toContain('"reason":"retired"');

    expect(await s.steps.revokeStandingRules()).toMatchObject({ ok: true });
    const rules = readStandingRules(s.harness);
    expect(rules.state === "present" ? rules.rows.map((r) => r.state) : []).toEqual(["revoked"]);

    expect(await s.steps.revokeConnections()).toMatchObject({ ok: true });
    expect(await s.steps.recordLifecycle()).toMatchObject({ ok: true });
    const lines = readFileSync(join(s.hangarRoot, LIFECYCLE_FILE), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      {
        type: "harness.retired",
        harness: s.row.id,
        at: new Date(NOW).toISOString(),
        by: ACTOR,
        cmd: s.receipt.id,
      },
    ]);
    expect(await s.steps.archiveRegistryRow()).toMatchObject({ ok: true });
    expect(s.registry.get(s.row.id)?.archived).toEqual({
      at: new Date(NOW).toISOString(),
      by: ACTOR,
      cmd: s.receipt.id,
    });

    expect(s.steps.effects().map((e) => [e.kind, e.status])).toEqual([
      ["retire.disable", "done"],
      ["retire.runs", "done"],
      ["retire.approvals", "done"],
      ["retire.rules", "done"],
      ["retire.connections", "skipped"],
      ["retire.lifecycle", "done"],
      ["retire.registry", "done"],
    ]);

    const ctx = { harnessDir: s.harness, probe: fakeProbe(), now: () => NOW };
    expect(await reconcileRetire(s.receipt, { ...ctx, hangarRoot: s.hangarRoot })).toBe("done");
    expect(await reconcileRetire(retireReceipt(), { ...ctx, hangarRoot: s.hangarRoot })).toBe(
      "unknown",
    );
    expect(await reconcileRetire(s.receipt, ctx)).toBe("unknown");
  });

  test("a queued run whose claim another process holds is left queued, and the step fails", async () => {
    const s = setUp();
    const queued = queue(s.harness);
    const held = publishClaim(runsLedger(s.harness), `run/${queued}`, { pid: 99, host: "h" });
    expect(held.ok).toBe(true);
    const outcome = await s.steps.cancelQueuedRuns();
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("already running");
    const runs = foldStates(runsLedger(s.harness));
    if (!runs.ok) throw new Error(runs.reason);
    expect(runs.objects.get(queued)?.state).toBe("queued");
    expect(s.steps.effects()).toEqual([
      { kind: "retire.runs", status: "failed", observed: "0 cancelled", note: "already running" },
    ]);
  });

  test("with --stop the head's stop runs first; a stop that fails disables nothing", async () => {
    const s = setUp();
    const calls: string[] = [];
    const stopping = retireSteps({
      harnessDir: s.harness,
      hangarRoot: s.hangarRoot,
      receipt: s.receipt,
      stop: true,
      stopDaemon: async () => {
        calls.push(readOperatorRecord.refresh(s.harness).state);
        return { ok: false, detail: "not adopted" };
      },
      now: () => NOW,
    });
    expect(await stopping.stopAndDisable()).toEqual({
      step: "stopAndDisable",
      ok: false,
      detail: "not adopted",
    });
    expect(calls).toEqual(["absent"]);
    expect(readOperatorRecord.refresh(s.harness)).toEqual({ state: "absent" });
  });

  test("after the archive took its state, the harness is disabled where it lives again", async () => {
    const s = setUp();
    expect(await s.steps.stopAndDisable()).toMatchObject({ ok: true });
    // The archive moves `.crewhaus`, operator record and all.
    rmSync(join(s.harness, ".crewhaus"), { recursive: true, force: true });
    expect(readOperatorRecord.refresh(s.harness)).toEqual({ state: "absent" });
    expect(await s.steps.keepDisabled()).toMatchObject({ step: "keepDisabled", ok: true });
    expect(readOperatorRecord.refresh(s.harness)).toMatchObject({
      state: "present",
      record: {
        rev: 1,
        desired: "stopped",
        deployment: { disabled: true, by: ACTOR, cmd: s.receipt.id },
      },
    });
    expect(s.steps.effects().map((e) => [e.kind, e.status, e.observed])).toEqual([
      ["retire.disable", "done", "rev 1"],
      ["retire.keep-disabled", "done", "rev 1"],
    ]);
  });

  test("a live record that can't be read is left alone, and the step says so", async () => {
    const s = setUp();
    mkdirSync(join(s.harness, ".crewhaus", "run", "control", "operator.json"), {
      recursive: true,
    });
    const outcome = await s.steps.keepDisabled();
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("crewhaus daemon disable");
    expect(s.steps.effects()).toEqual([{ kind: "retire.keep-disabled", status: "failed" }]);
  });

  test("with the shipped revokers, a harness that has nothing to end still says to revoke its connections", async () => {
    const s = setUp({ revokers: retireRevokers(AREA_RUNTIMES) });
    expect(retireRevokers(AREA_RUNTIMES).length).toBeGreaterThan(0);
    const outcome = await s.steps.revokeConnections();
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.detail).toBe(
      "none are registered here; revoke this harness's channel and service credentials where they were issued",
    );
    expect(s.steps.effects().map((e) => [e.kind, e.status])).toEqual([
      ["retire.connections", "skipped"],
    ]);
  });

  test("a revoker that ends something keeps the connections guidance unless it ends connections", async () => {
    const ending: RetireRevoker = {
      name: "rules",
      plan: async () => [],
      revoke: async () => [{ kind: "retire.rules-extra", status: "done", observed: "1 revoked" }],
    };
    const s = setUp({ revokers: [ending] });
    const outcome = await s.steps.revokeConnections();
    expect(outcome.detail).toContain(
      "revoke this harness's channel and service credentials where they were issued",
    );
    expect(s.steps.effects().map((e) => [e.kind, e.status])).toEqual([
      ["retire.rules-extra", "done"],
      ["retire.connections", "skipped"],
    ]);
    const t = setUp({ revokers: [{ ...ending, connections: true }] });
    expect((await t.steps.revokeConnections()).detail).toBe("1 revoker(s) ran");
  });

  test("an unregistered harness's row is skipped", async () => {
    const s = setUp();
    const other = retireSteps({
      harnessDir: tempDir(),
      hangarRoot: s.hangarRoot,
      receipt: s.receipt,
      stop: false,
      now: () => NOW,
      registry: s.registry,
    });
    expect(await other.archiveRegistryRow()).toMatchObject({ ok: true });
    expect(other.effects()).toEqual([
      { kind: "retire.registry", status: "skipped", note: "not registered" },
    ]);
  });
});
