/**
 * A deferral is a receipted command whose recovery observes the decision log: the
 * receipt's own actor's `defer` line settles it, a decision made since settles it as
 * already decided, and nothing found leaves it for a person.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mintId } from "@crewhaus/control-contract";
import { observeDefer } from "./decision-runtime";
import { commandsLedgerOf } from "./ledgers";
import {
  IDENTITY,
  NOW,
  park,
  plantProjection,
  plantReceipt,
  removeTempDirs,
  rig,
  rowsOf,
  setUpOwner,
} from "./test-helpers";

afterAll(removeTempDirs);

const HRN = "hrn_00000000000000d1";

async function governed() {
  const r = rig();
  const owner = await setUpOwner(r.hangarRoot, IDENTITY);
  plantProjection(r.harness, owner);
  return { ...r, owner };
}

function last(harness: string, id: string): Record<string, unknown> | undefined {
  return rowsOf(commandsLedgerOf(harness))
    .filter((row) => row["id"] === id)
    .at(-1);
}

describe("decisions.defer recovery", () => {
  test("the actor's own defer line settles it succeeded", async () => {
    const r = await governed();
    const p = await park(r.harness, "Write", { path: "a.md" });
    const id = mintId("cmd");
    plantReceipt(commandsLedgerOf(r.harness), {
      id,
      kind: "decisions.defer",
      target: `${HRN}/decision/${p.id}`,
      actor: r.owner,
      acceptedAt: new Date(NOW - 60_000).toISOString(),
    });
    const deferred = await r.service.decisions.defer({
      harnessDir: r.harness,
      ref: p.id,
      until: "2099-01-01T00:00:00Z",
      reason: "scheduled",
      actor: { kind: "principal", principal: r.owner },
      via: "cli",
    });
    expect(deferred.outcome).toBe("deferred");
    await r.service.commands.recover({ harness: r.harness });
    expect(last(r.harness, id)?.["state"]).toBe("succeeded");
    expect(r.supervisor.calls).toEqual([]);
  });

  test("a decision made since is another's; nothing at all needs a person", async () => {
    const r = await governed();
    const decided = await park(r.harness, "Write", { path: "b.md" });
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: decided.id,
      choice: "deny",
      actor: { kind: "principal", principal: r.owner },
      via: "home",
    });
    const receipt = {
      kind: "decisions.defer",
      target: `${HRN}/decision/${decided.id}`,
      actor: r.owner,
      acceptedAt: new Date(NOW - 60_000).toISOString(),
    } as const;
    expect(observeDefer({ ...receipt, id: mintId("cmd") } as never, r.harness)).toBe("other");

    const open = await park(r.harness, "Write", { path: "c.md" });
    expect(
      observeDefer(
        { ...receipt, id: mintId("cmd"), target: `${HRN}/decision/${open.id}` } as never,
        r.harness,
      ),
    ).toBe("unknown");
    // A request to the owner is never deferred: its receipt names nothing to observe.
    expect(
      observeDefer(
        { ...receipt, id: mintId("cmd"), target: `${HRN}/decision/${mintId("dec")}` } as never,
        r.harness,
      ),
    ).toBe("unknown");
  });

  test("another member's deferral is not this receipt's", async () => {
    const r = await governed();
    const other = mintId("prn");
    plantProjection(r.harness, r.owner, [{ principal: other, decide: "operator" }]);
    const p = await park(r.harness, "Write", { path: "d.md" });
    const acceptedAt = new Date(NOW - 60_000).toISOString();
    await r.service.decisions.defer({
      harnessDir: r.harness,
      ref: p.id,
      until: "2099-01-01T00:00:00Z",
      reason: "awaiting-someone",
      actor: { kind: "principal", principal: other },
      via: "home",
    });
    expect(
      observeDefer(
        {
          id: mintId("cmd"),
          kind: "decisions.defer",
          target: `${HRN}/decision/${p.id}`,
          actor: r.owner,
          acceptedAt,
        } as never,
        r.harness,
      ),
    ).toBe("unknown");
  });
});

describe("commands.list", () => {
  test("pages receipts newest first, each once at its current state, with no repeat", async () => {
    const r = rig();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const answer = await r.service.commands.submit(
        { kind: "controls.pause", ledger: { harness: r.harness }, via: "cli" },
        async () => ({ settle: { state: "succeeded" }, value: i }),
      );
      if (!answer.ok) throw new Error("refused");
      ids.push(answer.receipt.id);
    }
    const first = r.service.commands.list({ harness: r.harness }, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[4], ids[3]]);
    expect(first.items.every((item) => item.state === "succeeded")).toBe(true);
    expect(first.next).toBeDefined();
    // A command that lands between pages is not seen by an older page.
    await r.service.commands.submit(
      { kind: "controls.pause", ledger: { harness: r.harness }, via: "cli" },
      async () => ({ settle: { state: "succeeded" }, value: 9 }),
    );
    const second = r.service.commands.list(
      { harness: r.harness },
      { limit: 2, ...(first.next !== undefined ? { before: first.next } : {}) },
    );
    expect(second.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    const third = r.service.commands.list(
      { harness: r.harness },
      { limit: 2, ...(second.next !== undefined ? { before: second.next } : {}) },
    );
    expect(third.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(third.next).toBeUndefined();
    expect(first.snapshotAt.length).toBeGreaterThan(0);
  });

  test("an empty ledger answers no items and no next", () => {
    const r = rig();
    const page = r.service.commands.list({ harness: r.harness }, { limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.next).toBeUndefined();
  });
});
