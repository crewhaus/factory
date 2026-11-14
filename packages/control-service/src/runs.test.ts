/**
 * Runs through the control service: the adapter table, a run started on each kind of
 * shape, a cancel by the run's folded state (a parked job run that nothing holds is
 * cancelled with no daemon, and what it waited on is withdrawn), a queued cancel racing
 * the run's start, a resume, and the reconcilers. Every command goes through
 * `commands.submit` with the plan's effect, as the heads do. Nothing is spawned: the
 * job starter is a stub that records what it was asked to start.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type CapabilityDescriptor,
  type CommandReceipt,
  RUN_CONTROL_SHAPES,
  SHAPE_RUN_CONTROLS,
  mintId,
  mintRunId,
} from "@crewhaus/control-contract";
import {
  append,
  controlPaths,
  foldStates,
  publishClaim,
  readClaim,
  runsLedger,
} from "@crewhaus/control-records";
import type { ControlClient } from "@crewhaus/gateway-protocol/control-client";
import type { ApiRunInput, StartResult } from "@crewhaus/harness-supervisor";
import {
  type PendingApproval,
  createPendingApprovalStore,
  foldReadOnly,
} from "@crewhaus/session-store";
import {
  HOME_RUN_TENANT,
  RUN_ADAPTER_SHAPES,
  type RunHome,
  type RunPlan,
  reconcileRunCancel,
  reconcileRunCreate,
  runAdapterFor,
  runRefOf,
  versionAtLeast,
} from "./runs";
import { HOST, NOW, type Rig, fakeProbe, park, removeTempDirs, rig, rowsOf } from "./test-helpers";

afterEach(() => removeTempDirs());

const HRN = "hrn_0123456789abcdef";
const API = { kind: "api" } as const;

/** A job starter that records each start and answers `answer`. */
function starter(answer: StartResult = { ok: true, runId: "run_0000000000000001", pid: 77 }): {
  readonly home: RunHome;
  readonly starts: ApiRunInput[];
} {
  const starts: ApiRunInput[] = [];
  return {
    starts,
    home: {
      startRunJob: async (_dir, apiRun) => {
        starts.push(apiRun);
        return answer;
      },
      now: () => NOW,
    },
  };
}

/** Submit a planned run command as a head does: refused before acceptance, or its receipt. */
async function submit<T>(
  r: Rig,
  kind: "runs.create" | "runs.cancel" | "runs.resume",
  runId: string,
  plan: RunPlan<T>,
): Promise<{ receipt?: CommandReceipt; value?: T; refusal?: string }> {
  if (!plan.ok) return { refusal: `${plan.refusal.code} ${plan.refusal.reason}` };
  const answer = await r.service.commands.submit<T>(
    { kind, target: runRefOf(HRN, runId), ledger: { harness: r.harness }, via: "cli" },
    plan.effect,
  );
  if (!answer.ok) throw new Error(answer.refusal.message);
  return answer.replayed
    ? { receipt: answer.receipt }
    : { receipt: answer.receipt, ...(answer.value !== undefined ? { value: answer.value } : {}) };
}

const runRows = (harness: string, id: string) =>
  rowsOf(runsLedger(harness)).filter((row) => row["id"] === id);
const statesOf = (harness: string, id: string) => runRows(harness, id).map((row) => row["state"]);
const receiptsOf = (harness: string) =>
  rowsOf({ ...runsLedger(harness), records: { dir: ".crewhaus/run/control/commands" } } as never);

function plant(harness: string, row: Record<string, unknown>): void {
  const written = append(runsLedger(harness), {
    at: new Date(NOW).toISOString(),
    trigger: API,
    ...row,
  });
  if (!written.ok) throw new Error(written.reason);
}

function inputsOf(harness: string): string[] {
  const dir = join(harness, controlPaths(harness).inputsDir);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

const PARKED_SESSION = "sess_00000000000000aa";

/**
 * A job run the API started, parked on a decision as the runtime leaves one: the root's
 * rows, its top-level loop's own run (`parent` the root, `childOver` on its running row)
 * that parked, the root closed parked (`over` on that row), its input file, and the
 * pending request bound to the loop run.
 */
async function parkedRun(
  r: Rig,
  over: Record<string, unknown> = {},
  childOver: Record<string, unknown> = {},
) {
  const runId = mintRunId();
  const child = mintRunId();
  const execution = "run_00000000000000aa";
  plant(r.harness, { id: runId, state: "queued", by: "sys:reconcile", cmd: mintId("cmd") });
  plant(r.harness, { id: runId, state: "preparing", execution });
  plant(r.harness, { id: runId, state: "running", execution });
  plant(r.harness, {
    id: child,
    state: "running",
    parent: runId,
    session: PARKED_SESSION,
    resumeScope: `run:${runId}`,
    execution,
    ...childOver,
  });
  plant(r.harness, { id: child, state: "waiting-for-approval" });
  plant(r.harness, { id: runId, state: "waiting-for-approval", ...over });
  const dir = join(r.harness, controlPaths(r.harness).inputsDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.txt`), "Summarise the report.", { mode: 0o600 });
  const approval = await park(r.harness, "Bash", { command: "ls" }, {
    runId: child,
    sessionId: PARKED_SESSION,
    binding: { runId: child, resumeScope: `run:${runId}` },
  } as Partial<PendingApproval>);
  return { runId, child, approval };
}

const sessionRoot = (r: Rig) => join(r.harness, ".crewhaus", "sessions");
const approvalOf = (r: Rig, id: string) =>
  foldReadOnly(sessionRoot(r)).records.find((record) => record.id === id);

describe("the adapter table", () => {
  test("cli, crew, workflow and graph are jobs, managed is managed, every other shape names its own intake", () => {
    expect(RUN_ADAPTER_SHAPES).toEqual({
      cli: "job",
      workflow: "job",
      channel: "daemon",
      graph: "job",
      managed: "managed",
      pipeline: "daemon",
      crew: "job",
      research: "daemon",
      batch: "daemon",
      voice: "daemon",
      browser: "daemon",
    });
    for (const shape of RUN_CONTROL_SHAPES)
      expect(runAdapterFor(shape).shape).toBe(RUN_ADAPTER_SHAPES[shape]);
    expect(runAdapterFor("eval").shape).toBe("daemon");
  });

  test("each shape that starts a run reads its input: the table, the run-control cell and the compiled entry agree", () => {
    const fixtures = join(import.meta.dir, "..", "..", "compiler", "src", "__fixtures__");
    /** The compiled entry each compiled job shape runs, and the stdin-less builds. */
    const ENTRY: Readonly<Record<string, string>> = {
      workflow: "pre-continuity/workflow.agent.ts.txt",
      graph: "model-wiring/graph-nodes.agent.ts.txt",
      crew: "pre-continuity/crew.daemon.ts.txt",
      pipeline: "model-wiring/pipeline-pool.agent.ts.txt",
      research: "pre-continuity/research.agent.ts.txt",
    };
    /** Whether the entry reads stdin and hands it on as the run's input. */
    const readsStdinIntoSeed = (text: string): boolean =>
      /for await \(const chunk of process\.stdin\)/.test(text) &&
      (/seedMessages: \[\{ role: "user", content: stdinInput/.test(text) ||
        /__graph\.run\(\{ input: stdin \}/.test(text) ||
        /no input on stdin/.test(text));
    let trueCells = 0;
    let stdinLess = 0;
    for (const shape of RUN_CONTROL_SHAPES) {
      const cell = (SHAPE_RUN_CONTROLS[shape] as Record<string, CapabilityDescriptor>)[
        "runs.create"
      ];
      const adapter = RUN_ADAPTER_SHAPES[shape];
      const entry = ENTRY[shape];
      const reads =
        entry === undefined
          ? undefined
          : readsStdinIntoSeed(readFileSync(join(fixtures, entry), "utf8"));
      if (cell?.supported === true) {
        trueCells += 1;
        expect(`${shape} ${adapter}`).not.toBe(`${shape} daemon`);
        if (shape !== "cli" && shape !== "managed")
          expect(`${shape} ${reads}`).toBe(`${shape} true`);
      } else {
        expect(`${shape} ${adapter}`).toBe(`${shape} daemon`);
      }
      if (reads === false) {
        stdinLess += 1;
        expect(`${shape} ${cell?.supported}`).toBe(`${shape} false`);
      }
    }
    expect(trueCells).toBe(5);
    expect(stdinLess).toBe(2);
  });
});

describe("starting a run", () => {
  function stamp(harness: string, compiledWith: string, entry = "agent.ts"): void {
    mkdirSync(join(harness, "dist"), { recursive: true });
    writeFileSync(join(harness, "dist", entry), "// bundle\n");
    writeFileSync(
      join(harness, "dist", "package.json"),
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: "x", compiledWith },
      }),
    );
  }

  test("a cli run: a 0600 record with the subject, a queued row naming who and the receipt, and one job start", async () => {
    const r = rig();
    const s = starter();
    const runId = mintRunId();
    const plan = await runAdapterFor("cli").createRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "cli",
      runId,
      input: "Summarise the report.",
      subject: "app:home:ada",
      admission: "reject",
      home: s.home,
    });
    const done = await submit(r, "runs.create", runId, plan);
    expect(done.receipt?.state).toBe("succeeded");
    expect(done.receipt?.effects).toEqual([
      { kind: "run", ref: `${HRN}/run/${runId}`, status: "done" },
    ]);
    const file = join(r.harness, controlPaths(r.harness).inputsDir, `${runId}.json`);
    // Windows reports 0666 for any writable file, so 0600 is a POSIX claim; owner
    // read+write is what remains assertable there.
    if (process.platform === "win32") expect(statSync(file).mode & 0o600).toBe(0o600);
    else expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      v: 1,
      run: runId,
      input: "Summarise the report.",
      subject: "app:home:ada",
    });
    const [queued] = runRows(r.harness, runId);
    expect(queued).toMatchObject({ state: "queued", trigger: API, cmd: done.receipt?.id });
    expect(queued?.["by"]).toBe(done.receipt?.actor);
    expect(JSON.stringify(runRows(r.harness, runId))).not.toContain("ada");
    expect(s.starts).toEqual([{ runId, inputFile: file }]);
    expect(
      reconcileRunCreate(done.receipt as CommandReceipt, {
        harnessDir: r.harness,
        probe: fakeProbe(),
        now: () => NOW,
      }),
    ).toBe("done");
  });

  test("a workflow run reads a text file on stdin; a subject is refused, as is a build older than 0.9.0", async () => {
    const r = rig();
    const s = starter();
    const make = (over: Record<string, unknown> = {}) =>
      runAdapterFor("workflow").createRun({
        harnessDir: r.harness,
        harness: HRN,
        target: "workflow",
        runId: mintRunId(),
        input: "Begin.",
        admission: "reject",
        home: s.home,
        ...over,
      });
    stamp(r.harness, "0.8.2");
    const old = await make();
    expect(old.ok ? "" : `${old.refusal.reason} ${old.refusal.verb}`).toBe(
      "bundle_too_old crewhaus compile",
    );
    stamp(r.harness, "0.9.0");
    const subject = await make({ subject: "app:home:ada" });
    expect(subject.ok ? "" : subject.refusal.reason).toBe("subject_unsupported_by_shape");
    const runId = mintRunId();
    const done = await submit(r, "runs.create", runId, await make({ runId }));
    expect(done.receipt?.state).toBe("succeeded");
    const file = join(r.harness, controlPaths(r.harness).inputsDir, `${runId}.txt`);
    expect(readFileSync(file, "utf8")).toBe("Begin.");
    expect(s.starts).toEqual([{ runId, stdinFile: file }]);
    expect(receiptsOf(r.harness)).toHaveLength(2);
  });

  test("a start the supervisor refuses withdraws the queued run and its input", async () => {
    const r = rig();
    const s = starter({
      ok: false,
      reason: "plan-failed",
      stage: "plan",
      error: new Error("no crewhaus"),
    });
    const runId = mintRunId();
    const plan = await runAdapterFor("cli").createRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "cli",
      runId,
      input: "x",
      admission: "reject",
      home: s.home,
    });
    const done = await submit(r, "runs.create", runId, plan);
    expect(done.receipt?.state).toBe("failed");
    expect(statesOf(r.harness, runId)).toEqual(["queued", "cancelled"]);
    expect(inputsOf(r.harness)).toEqual([]);
  });

  test("the operator record: disabled and paused refuse before acceptance; on a job shape queue acts as reject", async () => {
    const r = rig();
    const s = starter();
    const dir = join(r.harness, ".crewhaus", "run", "control");
    mkdirSync(dir, { recursive: true });
    const write = (body: Record<string, unknown>) =>
      writeFileSync(
        join(dir, "operator.json"),
        `${JSON.stringify({ v: 1, rev: 1, desired: "running", ...body })}\n`,
      );
    const refreshing = await import("@crewhaus/control-records");
    const ask = async (admission: "reject" | "queue") => {
      refreshing.refreshOperatorRecord(r.harness);
      const plan = await runAdapterFor("cli").createRun({
        harnessDir: r.harness,
        harness: HRN,
        target: "cli",
        runId: mintRunId(),
        input: "x",
        admission,
        home: s.home,
      });
      return plan.ok ? "accepted" : `${plan.refusal.code}: ${plan.refusal.message}`;
    };
    write({ deployment: { disabled: true } });
    expect(await ask("reject")).toStartWith("disabled");
    write({ intake: { paused: true } });
    expect(await ask("reject")).toStartWith("paused");
    expect(await ask("queue")).toContain("keeps no queue for one-shot jobs");
    expect(s.starts).toEqual([]);
    expect(receiptsOf(r.harness)).toEqual([]);
  });

  test("a managed run with no daemon: reject is unavailable and writes nothing; queue records it under the tenant home with the receipt", async () => {
    const r = rig();
    const offline = {
      status: async () => ({
        ok: false,
        code: "unreachable",
        status: 0,
        reason: "down",
        retryable: false,
        expected: false,
      }),
    } as unknown as ControlClient;
    const home: RunHome = {
      controlClient: offline,
      controlTarget: (harnessDir) => ({ harnessDir }),
      now: () => NOW,
    };
    stamp(r.harness, "0.9.0", "daemon.ts");
    const ask = (admission: "reject" | "queue", runId = mintRunId()) =>
      runAdapterFor("managed").createRun({
        harnessDir: r.harness,
        harness: HRN,
        target: "managed",
        runId,
        input: "Summarise.",
        admission,
        home,
      });
    const rejected = await ask("reject");
    expect(rejected.ok ? "" : `${rejected.refusal.code} ${rejected.refusal.reason}`).toBe(
      "unavailable executor_offline",
    );
    expect(inputsOf(r.harness)).toEqual([]);
    const runId = mintRunId();
    const done = await submit(r, "runs.create", runId, await ask("queue", runId));
    expect(done.receipt?.state).toBe("succeeded");
    expect(runRows(r.harness, runId)).toEqual([
      expect.objectContaining({ state: "queued", tenant: HOME_RUN_TENANT, cmd: done.receipt?.id }),
    ]);
    expect(inputsOf(r.harness)).toEqual([`${runId}.json`]);
    expect(
      reconcileRunCreate(done.receipt as CommandReceipt, {
        harnessDir: r.harness,
        probe: fakeProbe(),
        now: () => NOW,
      }),
    ).toBe("done");
  });

  test("a managed build older than 0.9.0, or none, is refused before acceptance even when asked to queue: no row, no input, no receipt", async () => {
    const r = rig();
    const offline = {
      status: async () => ({ ok: false, code: "unreachable", status: 0, reason: "down" }),
    } as unknown as ControlClient;
    const ask = () =>
      runAdapterFor("managed").createRun({
        harnessDir: r.harness,
        harness: HRN,
        target: "managed",
        runId: mintRunId(),
        input: "Summarise.",
        admission: "queue",
        home: { controlClient: offline, controlTarget: (harnessDir) => ({ harnessDir }) },
      });
    const none = await ask();
    expect(none.ok ? "" : `${none.refusal.code} ${none.refusal.verb}`).toBe(
      "unsupported crewhaus compile",
    );
    stamp(r.harness, "0.8.2", "daemon.ts");
    const old = await ask();
    expect(old.ok ? "" : `${old.refusal.code} ${old.refusal.reason} ${old.refusal.verb}`).toBe(
      "unsupported bundle_too_old crewhaus compile",
    );
    expect(existsSync(join(r.harness, ".crewhaus", "run", "control", "runs"))).toBe(false);
    expect(inputsOf(r.harness)).toEqual([]);
    expect(receiptsOf(r.harness)).toEqual([]);
  });

  test("a shape that takes its work through its own intake is refused with its own words", async () => {
    for (const target of ["channel", "pipeline", "batch", "voice", "research", "browser"]) {
      const plan = await runAdapterFor(target).createRun({
        harnessDir: "/nowhere",
        harness: HRN,
        target,
        runId: mintRunId(),
        input: "x",
        admission: "reject",
        home: {},
      });
      expect(plan.ok ? "" : `${plan.refusal.code} ${plan.refusal.reason}`).toBe(
        "unsupported unsupported_by_shape",
      );
    }
  });

  test("versions compare by number", () => {
    expect(versionAtLeast("0.9.0", "0.9.0")).toBe(true);
    expect(versionAtLeast("0.10.0", "0.9.0")).toBe(true);
    expect(versionAtLeast("0.8.2", "0.9.0")).toBe(false);
    expect(versionAtLeast("garbage", "0.9.0")).toBe(false);
  });
});

describe("cancelling a parked job run with no daemon", () => {
  test("its request is withdrawn naming the run, its last row is cancelled, its input is gone, and nothing re-drives it", async () => {
    const r = rig();
    const { runId, child, approval } = await parkedRun(r);
    const plan = await runAdapterFor("workflow").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "workflow",
      runId,
      home: {},
    });
    const done = await submit(r, "runs.cancel", runId, plan);
    expect(done.receipt?.state).toBe("succeeded");
    // The loop run that parked is closed too, so neither id resumes.
    expect(statesOf(r.harness, child)).toEqual(["running", "waiting-for-approval", "cancelled"]);
    const withdrawn = approvalOf(r, approval.id);
    expect(withdrawn?.supersededBy).toBe(runId);
    expect(withdrawn?.supersededReason).toBe("run-cancelled");
    expect(statesOf(r.harness, runId).at(-1)).toBe("cancelled");
    expect(runRows(r.harness, runId).at(-1)?.["cmd"]).toBe(done.receipt?.id);
    expect(inputsOf(r.harness)).toEqual([]);
    expect(
      reconcileRunCancel(done.receipt as CommandReceipt, {
        harnessDir: r.harness,
        probe: fakeProbe(),
        now: () => NOW,
      }),
    ).toBe("done");
    // A grant decided afterwards decides nothing, and no resume starts the run again.
    const store = createPendingApprovalStore({ rootDir: sessionRoot(r) });
    expect(await store.resolve(approval.id, "grant", "sam")).toBeNull();
    const s = starter();
    const resumed = await runAdapterFor("workflow").resumeRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "workflow",
      runId,
      home: s.home,
    });
    expect(resumed.ok ? "" : resumed.refusal.reason).toBe("run_ended");
    expect(s.starts).toHaveLength(0);
  });

  test("the run it continues is withdrawn too", async () => {
    const r = rig();
    const earlier = mintRunId();
    const before = await park(r.harness, "Bash", { command: "pwd" }, { runId: earlier });
    const { runId } = await parkedRun(r, {}, { continues: earlier });
    const plan = await runAdapterFor("cli").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "cli",
      runId,
      home: {},
    });
    await submit(r, "runs.cancel", runId, plan);
    expect(approvalOf(r, before.id)?.supersededBy).toBe(runId);
  });

  test("the run's claim, held by this live process since its start, does not stop the withdrawal", async () => {
    const r = rig();
    const { runId, approval } = await parkedRun(r);
    expect(
      publishClaim(runsLedger(r.harness), `run/${runId}`, { pid: process.pid, host: HOST }).ok,
    ).toBe(true);
    const plan = await runAdapterFor("workflow").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "workflow",
      runId,
      home: {},
    });
    const done = await submit(r, "runs.cancel", runId, plan);
    expect(done.receipt?.state).toBe("succeeded");
    expect(approvalOf(r, approval.id)?.supersededBy).toBe(runId);
  });

  test("a run a resume holds again (preparing after the park) is not cancelled this way, and nothing is withdrawn", async () => {
    const r = rig();
    const { runId, approval } = await parkedRun(r);
    plant(r.harness, { id: runId, state: "preparing", execution: "run_00000000000000bb" });
    const plan = await runAdapterFor("workflow").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "workflow",
      runId,
      home: {},
    });
    expect(plan.ok ? "" : `${plan.refusal.code} ${plan.refusal.reason}`).toBe(
      "unavailable executor_offline",
    );
    expect(approvalOf(r, approval.id)?.supersededBy).toBeUndefined();
    expect(statesOf(r.harness, runId).at(-1)).toBe("preparing");
  });

  test("a run a resume takes between the plan and its effect: the receipt is rejected, and nothing is withdrawn or closed", async () => {
    const r = rig();
    const { runId, child, approval } = await parkedRun(r);
    const plan = await runAdapterFor("workflow").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "workflow",
      runId,
      home: {},
    });
    expect(plan.ok).toBe(true);
    // A resume holds the run again before the effect takes the ledger's lock.
    plant(r.harness, { id: runId, state: "preparing", execution: "run_00000000000000bb" });
    const done = await submit(r, "runs.cancel", runId, plan);
    expect(done.receipt?.state).toBe("rejected");
    expect(approvalOf(r, approval.id)?.supersededBy).toBeUndefined();
    expect(statesOf(r.harness, runId).at(-1)).toBe("preparing");
    expect(statesOf(r.harness, child).at(-1)).toBe("waiting-for-approval");
    expect(inputsOf(r.harness)).toEqual([`${runId}.txt`]);
  });

  test("a parked managed run (its row names a tenant) is refused before acceptance: no receipt, and its request stays pending", async () => {
    const r = rig();
    const { runId, approval } = await parkedRun(r, { tenant: "acme" });
    const plan = await runAdapterFor("managed").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "managed",
      runId,
      home: {},
    });
    expect(plan.ok ? "" : `${plan.refusal.code} ${plan.refusal.reason}`).toBe(
      "unsupported unsupported_by_shape",
    );
    expect(plan.ok ? "" : plan.refusal.remedy).toContain("crewhaus approvals deny");
    expect(receiptsOf(r.harness)).toEqual([]);
    expect(approvalOf(r, approval.id)?.supersededBy).toBeUndefined();
  });

  test("an ended run is refused as run_ended, and an unknown one as not found", async () => {
    const r = rig();
    const runId = mintRunId();
    plant(r.harness, { id: runId, state: "running" });
    plant(r.harness, { id: runId, state: "succeeded" });
    const ended = await runAdapterFor("cli").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "cli",
      runId,
      home: {},
    });
    expect(ended.ok ? "" : `${ended.refusal.code} ${ended.refusal.reason}`).toBe(
      "conflict run_ended",
    );
    const unknown = await runAdapterFor("cli").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "cli",
      runId: mintRunId(),
      home: {},
    });
    expect(unknown.ok ? "" : unknown.refusal.code).toBe("not_found");
  });
});

describe("cancelling a queued run races its start", () => {
  test("a claim already held: the receipt is rejected with outcome running, naming the run", async () => {
    const r = rig();
    const runId = mintRunId();
    plant(r.harness, { id: runId, state: "queued" });
    expect(
      publishClaim(runsLedger(r.harness), `run/${runId}`, { pid: 1, host: "elsewhere" }).ok,
    ).toBe(true);
    const plan = await runAdapterFor("cli").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "cli",
      runId,
      home: {},
    });
    const done = await submit(r, "runs.cancel", runId, plan);
    expect(done.receipt?.state).toBe("rejected");
    expect(done.receipt?.outcome).toMatchObject({ code: "running", run: runId });
    expect(statesOf(r.harness, runId)).toEqual(["queued"]);
  });

  test("an unheld claim: this cancel wins it, once, and the run is cancelled", async () => {
    const r = rig();
    const runId = mintRunId();
    plant(r.harness, { id: runId, state: "queued" });
    const plan = await runAdapterFor("cli").cancelRun({
      harnessDir: r.harness,
      harness: HRN,
      target: "cli",
      runId,
      home: {},
    });
    const done = await submit(r, "runs.cancel", runId, plan);
    expect(done.receipt?.state).toBe("succeeded");
    expect(statesOf(r.harness, runId)).toEqual(["queued", "cancelled"]);
    const claim = readClaim(runsLedger(r.harness), `run/${runId}`);
    expect(claim.ok && claim.content.record["pid"]).toBe(process.pid);
    const fold = foldStates(runsLedger(r.harness));
    expect(fold.ok ? fold.anomalies : fold).toEqual([]);
  });
});

describe("resuming a parked job run", () => {
  test("a decided park is started again under the same run, with the same input file; a pending one is 409", async () => {
    const r = rig();
    const { runId, approval } = await parkedRun(r);
    const s = starter();
    const ask = () =>
      runAdapterFor("workflow").resumeRun({
        harnessDir: r.harness,
        harness: HRN,
        target: "workflow",
        runId,
        home: s.home,
      });
    const pending = await ask();
    expect(pending.ok ? "" : `${pending.refusal.code} ${pending.refusal.reason}`).toBe(
      "conflict decision_pending",
    );
    const store = createPendingApprovalStore({ rootDir: sessionRoot(r) });
    expect(await store.resolve(approval.id, "grant", "sam")).not.toBeNull();
    const workflowStamp = join(r.harness, "dist");
    mkdirSync(workflowStamp, { recursive: true });
    writeFileSync(join(workflowStamp, "agent.ts"), "// bundle\n");
    writeFileSync(
      join(workflowStamp, "package.json"),
      JSON.stringify({
        name: "crewhaus-compiled-bundle",
        crewhaus: { specHash: "x", compiledWith: "0.9.0" },
      }),
    );
    const done = await submit(r, "runs.resume", runId, await ask());
    expect(done.receipt?.state).toBe("succeeded");
    expect(s.starts).toEqual([
      { runId, stdinFile: join(r.harness, controlPaths(r.harness).inputsDir, `${runId}.txt`) },
    ]);
  });

  test("a parked run the API did not start, or whose input is gone, is refused before acceptance and stays parked", async () => {
    const r = rig();
    const s = starter();
    const ask = (runId: string) =>
      runAdapterFor("workflow").resumeRun({
        harnessDir: r.harness,
        harness: HRN,
        target: "workflow",
        runId,
        home: s.home,
      });
    // A run a person started in a terminal: its trigger is not the API's, and it has no input file.
    const cliRun = mintRunId();
    plant(r.harness, { id: cliRun, state: "running", trigger: { kind: "cli" } });
    plant(r.harness, { id: cliRun, state: "waiting-for-approval", trigger: { kind: "cli" } });
    // An API run whose input file is not there any more.
    const { runId: gone } = await parkedRun(r);
    rmSync(join(r.harness, controlPaths(r.harness).inputsDir, `${gone}.txt`));
    for (const runId of [cliRun, gone]) {
      const plan = await ask(runId);
      expect(plan.ok ? "" : `${plan.refusal.code} ${plan.refusal.reason}`).toBe(
        "unsupported not_started_by_api",
      );
      expect(plan.ok ? "" : plan.refusal.verb).toBe(`crewhaus runs resume ${runId}`);
      expect(statesOf(r.harness, runId).at(-1)).toBe("waiting-for-approval");
    }
    expect(receiptsOf(r.harness)).toEqual([]);
    expect(s.starts).toHaveLength(0);
  });

  test("managed and daemon shapes do not resume through the API", async () => {
    for (const target of ["managed", "channel"]) {
      const plan = await runAdapterFor(target).resumeRun({
        harnessDir: "/nowhere",
        harness: HRN,
        target,
        runId: mintRunId(),
        home: {},
      });
      expect(plan.ok ? "" : plan.refusal.reason).toBe("unsupported_by_shape");
    }
  });
});
