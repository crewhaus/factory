import { afterAll, describe, expect, test } from "bun:test";
import { mintId } from "@crewhaus/control-contract";
import { AREA_RUNTIMES, compositionProblems } from "./areas";
import { CORE_RUNTIME } from "./core-runtime";
import { commandsLedgerOf } from "./ledgers";
import {
  IDENTITY,
  park,
  plantProjection,
  plantReceipt,
  removeTempDirs,
  rig,
  rowsOf,
  setUpOwner,
} from "./test-helpers";

afterAll(removeTempDirs);

const HRN = "hrn_00000000000000c1";
const CMD = "cmd_01m76e6f05hp514w9j4v3qymkt";

function lastRow(harness: string, id = CMD): Record<string, unknown> | undefined {
  return rowsOf(commandsLedgerOf(harness))
    .filter((row) => row["id"] === id)
    .at(-1);
}

async function governedByLocalOwner() {
  const r = rig();
  const owner = await setUpOwner(r.hangarRoot, IDENTITY);
  // The rig's Hangar root is a real path already: the projection names it as written.
  plantProjection(r.harness, owner, [], { accessRoot: r.hangarRoot });
  return { ...r, owner };
}

describe("a CLI decision is a receipted command", () => {
  test("one decisions.resolve receipt, whose actor is the linked member", async () => {
    const r = await governedByLocalOwner();
    const p = await park(r.harness, "Write", { path: "a.md" });
    const answer = await r.service.commands.submit(
      {
        kind: "decisions.resolve",
        target: `${HRN}/decision/${p.id}`,
        ledger: { harness: r.harness },
        via: "cli",
      },
      async () => {
        const resolved = await r.service.decisions.resolve({
          harnessDir: r.harness,
          ref: p.id,
          choice: "grant",
          actor: { kind: "local", identity: IDENTITY },
          via: "cli",
        });
        return { settle: { state: "succeeded" }, value: resolved };
      },
    );
    if (!answer.ok || answer.replayed) throw new Error("not accepted");
    expect(answer.receipt.kind).toBe("decisions.resolve");
    expect(answer.receipt.actor).toBe(r.owner);
    expect(answer.receipt.state).toBe("succeeded");
    expect(answer.value?.record?.decidedByPrincipal).toBe(r.owner);
    const receipts = rowsOf(commandsLedgerOf(r.harness)).filter(
      (row) => row["state"] === "accepted",
    );
    expect(receipts).toHaveLength(1);
  });
});

describe("recovery observes what a receipt names, and never decides again", () => {
  test("the same member's claim settles it succeeded", async () => {
    const r = await governedByLocalOwner();
    const p = await park(r.harness, "Write", { path: "a.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: { kind: "principal", principal: r.owner },
      via: "cli",
    });
    plantReceipt(commandsLedgerOf(r.harness), {
      id: CMD,
      kind: "decisions.resolve",
      target: `${HRN}/decision/${p.id}`,
      actor: r.owner,
    });
    await r.service.commands.recover({ harness: r.harness });
    expect(lastRow(r.harness)?.["state"]).toBe("succeeded");
    // No supervisor is asked for: the decision kinds act on records alone.
    expect(r.supervisor.calls).toEqual([]);
  });

  test("another member's claim settles it as already decided", async () => {
    const r = await governedByLocalOwner();
    const other = mintId("prn");
    plantProjection(r.harness, r.owner, [{ principal: other, decide: "operator" }]);
    const p = await park(r.harness, "Write", { path: "a.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "deny",
      actor: { kind: "principal", principal: other },
      via: "home",
    });
    plantReceipt(commandsLedgerOf(r.harness), {
      id: CMD,
      kind: "decisions.resolve",
      target: `${HRN}/decision/${p.id}`,
      actor: r.owner,
    });
    await r.service.commands.recover({ harness: r.harness });
    const row = lastRow(r.harness);
    // Recovery runs an idempotent kind's executor from `running`, where a refusal is a failure.
    expect(row?.["state"]).toBe("failed");
    expect((row?.["outcome"] as { code?: string } | undefined)?.code).toBe("already_decided");
  });

  test("no claim, a digest actor, or a target that names only the harness: a person decides", async () => {
    const r = await governedByLocalOwner();
    const p = await park(r.harness, "Write", { path: "a.md" });
    const cases = [
      { target: `${HRN}/decision/${p.id}`, actor: r.owner },
      { target: `${HRN}/decision/${p.id}`, actor: `local:#${"a".repeat(64)}` },
      { target: `home/harness/${HRN}`, actor: r.owner },
    ];
    for (const [index, receipt] of cases.entries()) {
      const id = mintId("cmd");
      plantReceipt(commandsLedgerOf(r.harness), { id, kind: "decisions.resolve", ...receipt });
      await r.service.commands.recover({ harness: r.harness });
      const row = lastRow(r.harness, id);
      expect([index, row?.["state"]]).toEqual([index, "unknown"]);
      expect((row?.["outcome"] as { message?: string } | undefined)?.message).toBe(
        "interrupted, needs a decision",
      );
    }
  });

  test("a supersede is reconciled from its claim, and a rule from the row that carries the receipt", async () => {
    const r = await governedByLocalOwner();
    const p = await park(r.harness, "Write", { path: "notes/a.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: p.id,
      choice: "grant",
      actor: { kind: "principal", principal: r.owner },
      via: "cli",
      always: true,
    });
    await r.service.decisions.supersede({
      harnessDir: r.harness,
      ref: p.id,
      reason: "decided-in-error",
      actor: { kind: "principal", principal: r.owner },
      via: "cli",
    });
    plantReceipt(commandsLedgerOf(r.harness), {
      id: CMD,
      kind: "decisions.supersede",
      target: `${HRN}/decision/${p.id}`,
      actor: r.owner,
      retry: { retryable: true, safety: "reconcile-first" },
    });
    const q = await park(r.harness, "Write", { path: "notes/b.md" });
    const RULE_CMD = mintId("cmd");
    await r.service.decisions.resolve(
      {
        harnessDir: r.harness,
        ref: q.id,
        choice: "grant",
        actor: { kind: "principal", principal: r.owner },
        via: "cli",
        always: true,
      },
      { ruleCommand: (run) => run(RULE_CMD) },
    );
    plantReceipt(commandsLedgerOf(r.harness), {
      id: RULE_CMD,
      kind: "rules.create",
      target: `home/cmd/${RULE_CMD}`,
      actor: r.owner,
      retry: { retryable: true, safety: "reconcile-first" },
    });
    const counts = await r.service.commands.recover({ harness: r.harness });
    expect(counts.reconciled).toBe(2);
    expect(lastRow(r.harness)?.["state"]).toBe("succeeded");
    expect(lastRow(r.harness, RULE_CMD)?.["state"]).toBe("succeeded");
  });

  test("the composition stays sound", () => {
    expect(compositionProblems(AREA_RUNTIMES)).toEqual([]);
    expect(compositionProblems([CORE_RUNTIME])).toEqual([]);
  });
});
