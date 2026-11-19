/**
 * A worker that crashes after its effect landed somewhere outside, before it recorded it:
 * recovery asks the outside world, through the kind's reconciler, and never runs the
 * effect blind.
 *
 * The outside world here is a fake code host (an in-memory map of head branch to pull
 * request) and the command is a test stand-in: a declared command kind that is not safe to
 * repeat and that no shipped runtime serves, run by a test area runtime composed with the
 * shipped ones. A real code host's own case belongs to the area that serves it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { AREA_MODULES, COMMAND_KINDS } from "@crewhaus/control-contract";
import { AREA_RUNTIMES, compositionProblems } from "./areas";
import type { AreaRuntime, Reconciliation } from "./executor";
import { commandsLedgerOf } from "./ledgers";
import { NEEDS_DECISION } from "./refusal";
import { NOW, plantReceipt, removeTempDirs, rig, rowsOf } from "./test-helpers";

afterAll(removeTempDirs);

const CMD = "cmd_01m76e6f05hp514w9j4v3qymfc";
const iso = (ms: number): string => new Date(ms).toISOString();

/** A declared kind that is not safe to repeat and that no shipped runtime serves. */
function borrowedKind(): { readonly area: string; readonly kind: string } {
  const served = new Set(
    AREA_RUNTIMES.flatMap((runtime) => [
      ...Object.keys(runtime.executors ?? {}),
      ...Object.keys(runtime.reconcilers ?? {}),
    ]),
  );
  const kinds = COMMAND_KINDS as Readonly<Record<string, { readonly idempotent: boolean }>>;
  // An area's own kinds first: the core's are the core's.
  for (const module of [...AREA_MODULES].sort(
    (a, b) => Number(a.area === "core") - Number(b.area === "core"),
  )) {
    const kind = module.commandKinds
      .map((k) => k.id as string)
      .find((id) => !served.has(id) && kinds[id]?.idempotent === false);
    if (kind !== undefined) return { area: module.area, kind };
  }
  throw new Error("no module has a kind that is not safe to repeat and that no runtime serves");
}

/** A code host that knows pull requests by head branch, and can be out of reach. */
function fakeCodehost() {
  const prs = new Map<string, number>();
  const host = {
    reachable: true,
    created: 0,
    open(head: string): number {
      host.created += 1;
      const number = prs.size + 1;
      prs.set(head, number);
      return number;
    },
    find(head: string): number | undefined {
      if (!host.reachable) throw new Error("the code host cannot be reached");
      return prs.get(head);
    },
    prs,
  };
  return host;
}

const headOf = (cmd: string) => `crewhaus/${cmd}`;

function composed() {
  const { area, kind } = borrowedKind();
  const codehost = fakeCodehost();
  let executed = 0;
  const runtime: AreaRuntime = {
    area,
    executors: {
      [kind]: async ({ receipt }) => {
        executed += 1;
        codehost.open(headOf(receipt.id));
        return { state: "succeeded" };
      },
    },
    reconcilers: {
      [kind]: (receipt): Reconciliation => {
        try {
          return codehost.find(headOf(receipt.id)) !== undefined ? "done" : "not-done";
        } catch {
          return "unknown";
        }
      },
    },
    // It acts on the code host alone, never a daemon.
    unsupervised: [kind],
  };
  const areas = [...AREA_RUNTIMES, runtime];
  return { kind, codehost, areas, executions: () => executed };
}

/** The receipt a worker left when it died: its executor's pid is gone. */
function died(harness: string, kind: string, state: "accepted" | "running"): void {
  plantReceipt(commandsLedgerOf(harness), {
    id: CMD,
    kind,
    state,
    acceptedAt: iso(NOW - 60_000),
    retry: { retryable: true, safety: "reconcile-first" },
  });
}

const lastRow = (harness: string) =>
  rowsOf(commandsLedgerOf(harness))
    .filter((row) => row["id"] === CMD)
    .at(-1);

describe("a worker that dies after its pull request was opened, before it recorded it", () => {
  test("the stand-in kind is declared, not safe to repeat, and composes with the shipped runtimes", () => {
    const { kind, areas } = composed();
    expect((COMMAND_KINDS as Record<string, { idempotent: boolean }>)[kind]?.idempotent).toBe(
      false,
    );
    expect(compositionProblems(areas)).toEqual([]);
  });

  test("[FC-6] the code host has it: succeeded, and no second pull request", async () => {
    const { kind, codehost, areas, executions } = composed();
    const r = rig({ pid: 1000, areas });
    // What the worker did before it died: the pull request is open.
    codehost.open(headOf(CMD));
    died(r.harness, kind, "running");
    expect(await r.service.commands.recover({ harness: r.harness })).toMatchObject({
      reconciled: 1,
    });
    expect(lastRow(r.harness)?.["state"]).toBe("succeeded");
    expect(codehost.prs.size).toBe(1);
    expect(codehost.created).toBe(1);
    expect(executions()).toBe(0);
    // A second recovery changes nothing.
    const rows = rowsOf(commandsLedgerOf(r.harness)).length;
    await r.service.commands.recover({ harness: r.harness });
    expect(rowsOf(commandsLedgerOf(r.harness))).toHaveLength(rows);
    expect(codehost.created).toBe(1);
  });

  test("[FC-6] the code host does not have it: failed, never run again blind", async () => {
    const { kind, codehost, areas, executions } = composed();
    const r = rig({ pid: 1000, areas });
    died(r.harness, kind, "running");
    await r.service.commands.recover({ harness: r.harness });
    expect(lastRow(r.harness)?.["state"]).toBe("failed");
    expect(codehost.created).toBe(0);
    expect(executions()).toBe(0);
  });

  test("[FC-6] the code host cannot be reached: unknown, needs a decision, and nothing is opened", async () => {
    const { kind, codehost, areas, executions } = composed();
    const r = rig({ pid: 1000, areas });
    codehost.reachable = false;
    died(r.harness, kind, "running");
    expect(await r.service.commands.recover({ harness: r.harness })).toMatchObject({
      unknown: 1,
    });
    expect(lastRow(r.harness)?.["state"]).toBe("unknown");
    expect(lastRow(r.harness)?.["outcome"]).toEqual(NEEDS_DECISION);
    expect(codehost.created).toBe(0);
    expect(executions()).toBe(0);
  });

  test("accepted and never started: the reconciler finds nothing, so it runs once, and once only", async () => {
    const { kind, codehost, areas, executions } = composed();
    const r = rig({ pid: 1000, areas });
    died(r.harness, kind, "accepted");
    await r.service.commands.recover({ harness: r.harness });
    expect(lastRow(r.harness)?.["state"]).toBe("succeeded");
    expect(executions()).toBe(1);
    expect(codehost.prs.size).toBe(1);
    await r.service.commands.recover({ harness: r.harness });
    expect(executions()).toBe(1);
    expect(codehost.created).toBe(1);
  });
});
