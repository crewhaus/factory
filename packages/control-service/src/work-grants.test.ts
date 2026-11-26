/**
 * Who spends a work item's grant: the run that asked, the run that continues it, or a
 * new run a person started for the item. Each run is queued through the job adapter with
 * the door its command came through, which its queued row's trigger carries; its context
 * takes that trigger as the supervisor's root does, and the runtime's own binding and
 * spend read it. A run a service queued, or one whose trigger names no door, is refused
 * `run-mismatch` and leaves the grant unspent.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ReceiptVia, type Trigger, mintId, mintRunId } from "@crewhaus/control-contract";
import { append, runsLedger } from "@crewhaus/control-records";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import {
  type PendingApproval,
  allowSingleOwner,
  createPendingApprovalStore,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { openWorkStore } from "@crewhaus/tool-work/work-items";
// runtime-core's package entry exports neither; these are the modules the loop parks and spends through.
import { bindingFor, consumeHeld } from "../../runtime-core/src/decision-binding";
import { _resetRunLedgerForTest } from "../../runtime-core/src/run-ledger";
import { runAdapterFor } from "./runs";
import { NOW, type Rig, removeTempDirs, rig, rowsOf } from "./test-helpers";

const HRN = "hrn_0123456789abcdef";
const SESSION = "sess_00000000000000aa";
const PLACES = [{ path: "/work/out.txt", at: ["/work/out.txt"] }];
const roots: string[] = [];

afterEach(() => {
  _resetRunLedgerForTest();
  removeTempDirs();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function openItem(r: Rig): Promise<string> {
  const written = await openWorkStore(r.harness, { now: () => NOW }).create(
    { title: "Fix the date parser", kind: "fix" },
    { by: mintId("prn"), via: "home", role: "person" },
  );
  if (!written.ok) throw new Error(written.message);
  return written.item.id;
}

/** Queue a run for the item through the job adapter, through `via`: its queued row. */
async function queued(r: Rig, wi: string, via: ReceiptVia): Promise<Record<string, unknown>> {
  const runId = mintRunId();
  const plan = await runAdapterFor("cli").createRun({
    harnessDir: r.harness,
    harness: HRN,
    target: "cli",
    runId,
    input: "Go.",
    work: wi,
    home: {
      startRunJob: async () => ({ ok: true, runId: "run_0000000000000001", pid: 77 }),
      now: () => NOW,
    },
  });
  if (!plan.ok) throw new Error(plan.refusal.message);
  const answer = await r.service.commands.submit(
    { kind: "runs.create", target: `${HRN}/run/${runId}`, ledger: { harness: r.harness }, via },
    plan.effect,
  );
  if (!answer.ok) throw new Error(answer.refusal.message);
  const row = rowsOf(runsLedger(r.harness)).find(
    (line) => line["id"] === runId && line["state"] === "queued",
  );
  if (row === undefined) throw new Error("no queued row");
  return row;
}

/** The context a run's loop works in: the queued row's trigger, as its verified root carries it. */
function contextOf(row: Record<string, unknown>, wi: string, continues?: string): RunContext {
  return createRunContext({
    runId: row["id"] as string,
    sessionId: SESSION,
    workItem: wi,
    resumeScope: `work:${wi}`,
    trigger: row["trigger"] as Trigger,
    ...(continues !== undefined ? { continues } : {}),
  });
}

/** Park a call in `ctx` and grant it, as a person would. */
async function grantedIn(
  store: ReturnType<typeof createPendingApprovalStore>,
  ctx: RunContext,
): Promise<PendingApproval> {
  const binding = await bindingFor({
    runContext: ctx,
    sessionId: SESSION,
    tool: {},
    operativeInput: { path: "/work/out.txt" },
  });
  const input = { path: "/work/out.txt" };
  const record: PendingApproval = {
    id: generateApprovalId(),
    toolName: "Write",
    inputHash: hashApprovalInput("Write", input),
    input,
    runId: ctx.runId,
    sessionId: SESSION,
    surface: "single-turn",
    createdAt: new Date().toISOString(),
    places: PLACES,
    binding: binding as never,
  };
  await store.persist(record);
  const decided = await store.decide(
    record.id,
    { choice: "grant", actor: {} },
    { authorize: allowSingleOwner },
  );
  expect(decided.outcome).toBe("decided");
  return decided.record as PendingApproval;
}

function spend(
  store: ReturnType<typeof createPendingApprovalStore>,
  grant: PendingApproval,
  ctx: RunContext,
  harnessRoot: string,
) {
  return consumeHeld({
    store,
    grant,
    runContext: ctx,
    sessionId: SESSION,
    tool: {},
    operativeInput: { path: "/work/out.txt" },
    places: PLACES,
    harnessRoot,
    reask: false,
  });
}

describe("a work item's grant is spent by the run that asked, its continuation or a run a person started", () => {
  test("R1 from Home parks and is granted; a service's run and a run with no door are refused; a person's run spends it", async () => {
    const r = rig();
    const wi = await openItem(r);
    const root = mkdtempSync(join(tmpdir(), "work-grants-"));
    roots.push(root);
    const store = createPendingApprovalStore({ rootDir: root });

    const r1 = await queued(r, wi, "home");
    expect(r1["trigger"]).toMatchObject({ kind: "api", workItem: wi, via: "home" });
    const ctx1 = contextOf(r1, wi);
    const grant = await grantedIn(store, ctx1);
    // The binding records who started the run that asked.
    expect(grant.binding).toMatchObject({ runId: r1["id"], starter: "person" });

    const r2 = await queued(r, wi, "sdk");
    expect(r2["trigger"]).toMatchObject({ via: "sdk" });
    const byService = await spend(store, grant, contextOf(r2, wi), r.harness);
    expect(byService).toMatchObject({ outcome: "refused", reason: "run-mismatch" });

    // A run for the item whose trigger names no door: not a person's.
    const r5 = mintRunId();
    append(runsLedger(r.harness), {
      id: r5,
      state: "queued",
      at: new Date(NOW).toISOString(),
      trigger: { kind: "api", workItem: wi },
      workItem: wi,
    });
    const noDoor = await spend(
      store,
      grant,
      contextOf({ id: r5, trigger: { kind: "api", workItem: wi } }, wi),
      r.harness,
    );
    expect(noDoor).toMatchObject({ outcome: "refused", reason: "run-mismatch" });
    const stillHeld = (await store.list()).find((a) => a.id === grant.id);
    expect(stillHeld?.consumedAt).toBeUndefined();

    const r3 = await queued(r, wi, "cli");
    expect(await spend(store, grant, contextOf(r3, wi), r.harness)).toEqual({
      outcome: "consumed",
    });
  }, 20_000); // four receipted commands and three spends under the approvals lock

  test("the run that asked and its continuation spend it, whoever started them", async () => {
    const r = rig();
    const wi = await openItem(r);
    const root = mkdtempSync(join(tmpdir(), "work-grants-"));
    roots.push(root);
    const store = createPendingApprovalStore({ rootDir: root });
    // A service's run may spend its own grant, and its continuation may too.
    const r1 = await queued(r, wi, "sdk");
    const ctx1 = contextOf(r1, wi);
    const first = await grantedIn(store, ctx1);
    expect(first.binding).toMatchObject({ starter: "service" });
    expect(await spend(store, first, ctx1, r.harness)).toEqual({ outcome: "consumed" });
    const second = await grantedIn(store, ctx1);
    const resumed = contextOf({ id: mintRunId(), trigger: r1["trigger"] }, wi, r1["id"] as string);
    expect(await spend(store, second, resumed, r.harness)).toEqual({ outcome: "consumed" });
  }, 20_000); // receipted commands and spends under the approvals lock
});
