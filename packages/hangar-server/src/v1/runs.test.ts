/**
 * Runs through Home's versioned API, on fixture harnesses with Home's own fake process
 * seam (nothing is spawned): starting a run on a cli, crew, managed, channel and pipeline
 * harness, what the operator record and an old build refuse before anything is written, a
 * service's idempotency key, the subject permission, reading a run and its result, the
 * runs a service credential started answering to that credential alone, cancelling and
 * resuming, the operator prep every start runs, and how many API runs Home holds at once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { openAccess } from "@crewhaus/access-control";
import { IDEMPOTENT_REPLAYED_HEADER, mintId, mintRunId } from "@crewhaus/control-contract";
import { append, controlPaths, foldStates, readPage, runsLedger } from "@crewhaus/control-records";
import { reconcileRunCreate } from "@crewhaus/control-service";
import {
  createPendingApprovalStore,
  foldReadOnly,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { type V1Home, v1Home } from "../__test__/v1-home";

let home: V1Home;

beforeAll(async () => {
  home = await v1Home();
}, 60_000);

afterAll(async () => {
  await home?.t.stop();
});

const errorOf = (body: Record<string, unknown>) => body["error"] as Record<string, unknown>;

/** Every row of a harness's run ledger, oldest first. */
function rowsOf(dir: string): Record<string, unknown>[] {
  return readPage(runsLedger(dir), { limit: 1000 })
    .items.map((item) => ({ ...item.record }))
    .reverse();
}

/** A harness with its own `crewhaus` on hand, so a cli job plans without one on PATH. */
async function cliHarness(name: string) {
  const h = await home.harness(name);
  const bin = join(h.dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "crewhaus"), 0o755);
  return h;
}

/** A compiled bundle stamped by `compiledWith`. */
function stamp(dir: string, entry: string, compiledWith: string): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", entry), "// bundle\n");
  writeFileSync(
    join(dir, "dist", "package.json"),
    JSON.stringify({ name: "crewhaus-compiled-bundle", crewhaus: { specHash: "x", compiledWith } }),
  );
}

const spawnedSince = (before: number) => (home.t.ops?.children ?? []).slice(before);

/** A harness's `preSpawn` hook, which a start runs before its job (an empty object: none). */
function hookOf(dir: string, preSpawn?: readonly string[]): void {
  mkdirSync(join(dir, ".crewhaus"), { recursive: true });
  writeFileSync(
    join(dir, ".crewhaus", "settings.json"),
    JSON.stringify(preSpawn === undefined ? {} : { manager: { hooks: { preSpawn } } }),
  );
}

type Child = NonNullable<V1Home["t"]["ops"]>["children"][number];

/** The first child spawned on `on` since `from` that `matches`, waited for over a bounded count of ticks. */
async function childWhere(
  on: V1Home,
  from: number,
  matches: (child: Child) => boolean,
): Promise<Child> {
  for (let tick = 0; tick < 5000; tick += 1) {
    const found = (on.t.ops?.children ?? []).slice(from).find(matches);
    if (found !== undefined) return found;
    await Bun.sleep(0);
  }
  throw new Error("no such child was spawned");
}

const isHook = (child: Child) => child.request.argv[0] === "/usr/bin/false";
const isJob = (child: Child) => child.request.argv[1] === "run";

/** The files saved under a harness's run inputs. */
function inputsIn(dir: string): string[] {
  const inputs = join(dir, controlPaths(dir).inputsDir);
  return existsSync(inputs) ? readdirSync(inputs).sort() : [];
}

/**
 * An API run parked as the runtime leaves one: the root's rows, its top-level loop's own
 * run (`parent` the root) that parked, the root closed parked, its input file, and the
 * request bound to the loop run. `queued` sets fields of the root's queued row.
 */
async function parkedRun(dir: string, queued: Record<string, unknown> = { by: "sys:reconcile" }) {
  const runId = mintRunId();
  const child = mintRunId();
  const at = new Date().toISOString();
  const ledger = runsLedger(dir);
  const execution = "run_00000000000000aa";
  const row = (id: string, state: string, more: Record<string, unknown> = {}) =>
    append(ledger, { id, state, at, trigger: { kind: "api" }, ...more });
  row(runId, "queued", queued);
  row(runId, "preparing", { execution });
  row(runId, "running", { execution });
  row(child, "running", {
    parent: runId,
    session: "sess_00000000000000cc",
    resumeScope: `run:${runId}`,
    execution,
  });
  row(child, "waiting-for-approval");
  row(runId, "waiting-for-approval", { execution });
  const inputs = join(dir, controlPaths(dir).inputsDir);
  mkdirSync(inputs, { recursive: true });
  writeFileSync(join(inputs, `${runId}.json`), JSON.stringify({ v: 1, run: runId, input: "x" }), {
    mode: 0o600,
  });
  const approval = generateApprovalId();
  const store = createPendingApprovalStore({ rootDir: join(dir, ".crewhaus", "sessions") });
  await store.persist({
    id: approval,
    toolName: "Bash",
    inputHash: hashApprovalInput("Bash", { command: "ls" }),
    runId: child,
    sessionId: "sess_00000000000000cc",
    surface: "single-turn",
    createdAt: at,
    binding: { runId: child, resumeScope: `run:${runId}` },
  } as Parameters<typeof store.persist>[0]);
  return { runId, child, approval, store };
}

/** A parked API run whose decision is made: only a start stands between it and running again. */
async function decidedRun(dir: string, queued?: Record<string, unknown>) {
  const parked = await parkedRun(dir, queued);
  await parked.store.resolve(parked.approval, "grant", "owner");
  return parked;
}

const newestState = (dir: string, runId: string) => {
  const fold = foldStates(runsLedger(dir));
  return fold.ok ? fold.objects.get(runId)?.state : "unreadable";
};

describe("starting a run", () => {
  test("a cli run: 202, a 0600 record with the subject, a queued row naming who and the receipt, and a closed-vocabulary spawn", async () => {
    const h = await cliHarness("cli-start");
    // Naming who a run serves is its own permission.
    const minted = await openAccess(home.t.hangarRoot).mintServiceToken(
      { principal: home.owner },
      {
        service: "asserter",
        permissions: ["h.run.submit"],
        harnesses: [h.id],
        subjectAssert: true,
      },
    );
    if (!minted.ok) throw new Error(minted.reason);
    const svc = { secret: minted.result.secret };
    const before = home.t.ops?.children.length ?? 0;
    const input = ["Summarise", "the", "quarterly", "report."].join(" ");
    const res = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input, subject: "customer-7" },
      secret: svc.secret,
      headers: { "Idempotency-Key": "cli-1" },
    });
    expect(res.status).toBe(202);
    const run = res.body["run"] as Record<string, unknown>;
    const receipt = res.body["receipt"] as Record<string, unknown>;
    const runId = String(run["id"]);
    expect(run).toMatchObject({ state: "queued", trigger: { kind: "api" }, harness: h.id });
    const file = join(h.dir, controlPaths(h.dir).inputsDir, `${runId}.json`);
    // Windows reports 0666 for any writable file, so 0600 is a POSIX claim; owner
    // read+write is what remains assertable there.
    if (process.platform === "win32") expect(statSync(file).mode & 0o600).toBe(0o600);
    else expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      v: 1,
      run: runId,
      input,
      subject: "customer-7",
    });
    const queued = rowsOf(h.dir).find((row) => row["id"] === runId && row["state"] === "queued");
    expect(queued?.["cmd"]).toBe(receipt["id"]);
    expect(queued?.["by"]).toBe(receipt["actor"]);
    const [child] = spawnedSince(before);
    expect(child?.request.argv).toEqual([
      join(h.dir, "node_modules", ".bin", "crewhaus"),
      "run",
      join(h.dir, "crewhaus.yaml"),
      "--input-file",
      file,
    ]);
    expect(child?.request.env["CREWHAUS_INPUT_ORIGIN"]).toBe("api");
    expect(child?.request.env["CREWHAUS_RUN_ID"]).toBe(runId);
    expect(JSON.stringify(child?.request.argv)).not.toContain("quarterly");
    expect(JSON.stringify(child?.request.env)).not.toContain("quarterly");
    expect(JSON.stringify(rowsOf(h.dir))).not.toContain("customer-7");
  });

  test("a crew run reads a text file on stdin; one stamped 0.8.2 is refused with `crewhaus compile`", async () => {
    const h = await home.harness("crew-start", { target: "crew" });
    stamp(h.dir, "daemon.ts", "0.8.2");
    const old = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "Brief." },
    });
    expect(old.status).toBe(501);
    expect(errorOf(old.body)).toMatchObject({ code: "unsupported", verb: "crewhaus compile" });
    expect(rowsOf(h.dir)).toEqual([]);
    stamp(h.dir, "daemon.ts", "0.9.0");
    const before = home.t.ops?.children.length ?? 0;
    const res = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "Brief." },
    });
    expect(res.status).toBe(202);
    const runId = String((res.body["run"] as Record<string, unknown>)["id"]);
    const [child] = spawnedSince(before);
    expect(child?.request.stdinFile).toBe(
      join(h.dir, controlPaths(h.dir).inputsDir, `${runId}.txt`),
    );
  });

  test("a channel or pipeline harness: 501 unsupported_by_shape, and no receipt", async () => {
    for (const target of ["channel", "pipeline"]) {
      const h = await home.harness(`${target}-start`, { target });
      const res = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
        body: { input: "x" },
      });
      expect(`${target} ${res.status}`).toBe(`${target} 501`);
      expect(errorOf(res.body)["reason"]).toBe("unsupported_by_shape");
      const commands = await home.call("GET", `/api/v1/harnesses/${h.id}/commands`);
      expect(commands.body["items"]).toEqual([]);
    }
  });

  test("a managed harness with no daemon: reject is 503 and writes nothing; queue records it for tenant home, settled by its reconciler", async () => {
    const h = await home.harness("managed-start", { target: "managed" });
    stamp(h.dir, "daemon.ts", "0.9.0");
    const rejected = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x" },
    });
    expect(rejected.status).toBe(503);
    expect(errorOf(rejected.body)).toMatchObject({
      code: "unavailable",
      reason: "executor_offline",
    });
    expect(rowsOf(h.dir)).toEqual([]);
    const queued = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x", admission: "queue" },
    });
    expect(queued.status).toBe(202);
    const receipt = queued.body["receipt"] as Record<string, unknown>;
    const runId = String((queued.body["run"] as Record<string, unknown>)["id"]);
    expect(rowsOf(h.dir)).toEqual([
      expect.objectContaining({ id: runId, state: "queued", tenant: "home", cmd: receipt["id"] }),
    ]);
    expect(existsSync(join(h.dir, controlPaths(h.dir).inputsDir, `${runId}.json`))).toBe(true);
    const seen = await reconcileRunCreate(receipt as never, {
      harnessDir: h.dir,
      probe: { isAlive: () => true, startTimeMs: () => undefined },
      now: Date.now,
    });
    expect(seen).toBe("done");
  });

  test("a managed harness stamped 0.8.2 with no daemon: queue is 501 with `crewhaus compile`, and nothing is written", async () => {
    const h = await home.harness("managed-old", { target: "managed" });
    stamp(h.dir, "daemon.ts", "0.8.2");
    const res = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x", admission: "queue" },
    });
    expect(res.status).toBe(501);
    expect(errorOf(res.body)).toMatchObject({ code: "unsupported", verb: "crewhaus compile" });
    expect(rowsOf(h.dir)).toEqual([]);
    expect(existsSync(join(h.dir, controlPaths(h.dir).inputsDir))).toBe(false);
    const commands = await home.call("GET", `/api/v1/harnesses/${h.id}/commands`);
    expect(commands.body["items"]).toEqual([]);
    const caps = await home.call("GET", `/api/v1/harnesses/${h.id}/capabilities`);
    expect(caps.status).toBe(200);
    expect(JSON.stringify(caps.body)).toContain("crewhaus compile");
  });

  test("paused and disabled are 503 before anything is written; work is 501", async () => {
    const h = await cliHarness("paused-start");
    await home.call("POST", `/api/v1/harnesses/${h.id}/controls/pause`, { body: {} });
    const paused = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x" },
    });
    expect(paused.status).toBe(503);
    expect(errorOf(paused.body)["code"]).toBe("paused");
    await home.call("POST", `/api/v1/harnesses/${h.id}/controls/resume`, { body: {} });
    await home.call("POST", `/api/v1/harnesses/${h.id}/controls/disable`, { body: {} });
    const disabled = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x" },
    });
    expect(disabled.status).toBe(503);
    expect(errorOf(disabled.body)["code"]).toBe("disabled");
    await home.call("POST", `/api/v1/harnesses/${h.id}/controls/enable`, { body: {} });
    const work = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x", work: `${h.id}/work/wi_01m76e6f05hp514w9j4v3qymka` },
    });
    expect(work.status).toBe(501);
    expect(rowsOf(h.dir)).toEqual([]);
  });
});

describe("a service starting runs", () => {
  test("no Idempotency-Key is 400; the same key twice is one run, answered as a replay", async () => {
    const h = await cliHarness("service-start");
    const svc = await home.service("starter", [h.id], { permissions: ["h.run.submit"] });
    const none = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x" },
      secret: svc.secret,
    });
    expect(none.status).toBe(400);
    expect(errorOf(none.body)["reason"]).toBe("idempotency_required");
    const send = () =>
      home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
        body: { input: "x" },
        secret: svc.secret,
        headers: { "Idempotency-Key": "order-1" },
      });
    const first = await send();
    expect(first.status).toBe(202);
    const second = await send();
    expect(second.status).toBe(202);
    expect(second.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    const id = (res: typeof first) =>
      (res.body["run"] as Record<string, unknown> | undefined)?.["id"];
    expect(id(second)).toBe(id(first));
    expect(rowsOf(h.dir).filter((row) => row["state"] === "queued")).toHaveLength(1);
    // Paused now, a retry is still told the run it started, not refused.
    await home.call("POST", `/api/v1/harnesses/${h.id}/controls/pause`, { body: {} });
    const paused = await send();
    expect(paused.status).toBe(202);
    expect(paused.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect(id(paused)).toBe(id(first));
    // A fresh key is refused as paused.
    const fresh = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x" },
      secret: svc.secret,
      headers: { "Idempotency-Key": "order-2" },
    });
    expect(fresh.status).toBe(503);
    expect(errorOf(fresh.body)["code"]).toBe("paused");
    await home.call("POST", `/api/v1/harnesses/${h.id}/controls/resume`, { body: {} });
  });

  test("a cancel retried after it succeeded is answered with its receipt, not run_ended", async () => {
    const h = await cliHarness("service-cancel-retry");
    const elsewhere = await home.harness("service-cancel-elsewhere");
    // It cancels the run it started, whatever else it holds.
    const svc = await home.service("canceller", [elsewhere.id], { permissions: ["h.run.submit"] });
    const runId = mintRunId();
    append(runsLedger(h.dir), {
      id: runId,
      state: "queued",
      at: new Date().toISOString(),
      trigger: { kind: "api" },
      by: svc.principal,
      byCredential: svc.credential,
    });
    const cancel = () =>
      home.call("POST", `/api/v1/runs/${runId}/cancel`, {
        body: {},
        secret: svc.secret,
        headers: { "Idempotency-Key": "cancel-1" },
      });
    const first = await cancel();
    expect(first.status).toBe(200);
    const again = await cancel();
    expect(again.status).toBe(200);
    expect(again.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe("true");
    expect((again.body["receipt"] as Record<string, unknown>)["id"]).toBe(
      (first.body["receipt"] as Record<string, unknown>)["id"],
    );
  });

  test("a subject without h.subject.assert is 403", async () => {
    const h = await cliHarness("subject-start");
    const svc = await home.service("no-subject", [h.id], { permissions: ["h.run.submit"] });
    const res = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x", subject: "customer-7" },
      secret: svc.secret,
      headers: { "Idempotency-Key": "s-1" },
    });
    expect(res.status).toBe(403);
    expect(errorOf(res.body)["needs"]).toBe("h.subject.assert");
  });

  test("a service reads, lists and cancels the runs it started, even where it reads nothing else", async () => {
    const h = await cliHarness("own-runs");
    const elsewhere = await home.harness("own-runs-elsewhere");
    // Its token covers another harness only: what it may do here is what it started.
    const svc = await home.service("own", [elsewhere.id], { permissions: ["h.run.submit"] });
    const ledger = runsLedger(h.dir);
    const [mineId, theirsId, unnamedId] = [mintRunId(), mintRunId(), mintRunId()];
    const at = new Date().toISOString();
    append(ledger, {
      id: mineId,
      state: "queued",
      at,
      trigger: { kind: "api" },
      by: svc.principal,
      byCredential: svc.credential,
    });
    // Its own principal, but no credential named: nothing grants it.
    append(ledger, {
      id: unnamedId,
      state: "queued",
      at,
      trigger: { kind: "api" },
      by: svc.principal,
    });
    append(ledger, {
      id: theirsId,
      state: "queued",
      at,
      trigger: { kind: "api" },
      by: "sys:reconcile",
    });
    const listed = await home.call("GET", `/api/v1/harnesses/${h.id}/runs`, { secret: svc.secret });
    expect(listed.status).toBe(200);
    expect((listed.body["items"] as { id: string }[]).map((r) => r.id)).toEqual([mineId]);
    expect((await home.call("GET", `/api/v1/runs/${mineId}`, { secret: svc.secret })).status).toBe(
      200,
    );
    expect(
      (await home.call("GET", `/api/v1/runs/${theirsId}`, { secret: svc.secret })).status,
    ).toBe(403);
    expect(
      (await home.call("GET", `/api/v1/runs/${unnamedId}`, { secret: svc.secret })).status,
    ).toBe(403);
    const cancel = await home.call("POST", `/api/v1/runs/${mineId}/cancel`, {
      body: {},
      secret: svc.secret,
    });
    expect(cancel.status).toBe(200);
    const all = await home.call("GET", `/api/v1/harnesses/${h.id}/runs`);
    expect((all.body["items"] as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [mineId, theirsId, unnamedId].sort(),
    );
  });

  test("a service that started no run on a harness it may not read is refused its runs as for a harness this Home does not have", async () => {
    const h = await home.harness("not-mine");
    const elsewhere = await home.harness("not-mine-elsewhere");
    const svc = await home.service("stranger", [elsewhere.id], { permissions: ["h.run.submit"] });
    append(runsLedger(h.dir), {
      id: mintRunId(),
      state: "queued",
      at: new Date().toISOString(),
      trigger: { kind: "api" },
      by: "sys:reconcile",
    });
    const registered = await home.call("GET", `/api/v1/harnesses/${h.id}/runs`, {
      secret: svc.secret,
    });
    const absent = await home.call("GET", "/api/v1/harnesses/no-such-harness/runs", {
      secret: svc.secret,
    });
    expect(registered.status).toBe(403);
    expect(absent.status).toBe(registered.status);
    const shape = (res: typeof registered) => {
      const { code, reason } = errorOf(res.body);
      return { code, reason };
    };
    expect(shape(registered)).toEqual(shape(absent));
  });
});

describe("reading a run and its result", () => {
  function plant(dir: string, row: Record<string, unknown>): void {
    const written = append(runsLedger(dir), {
      at: new Date().toISOString(),
      trigger: { kind: "api" },
      ...row,
    });
    if (!written.ok) throw new Error(written.reason);
  }

  test("get is the folded run; result is its state, how it ended and an absolute inspection link", async () => {
    const h = await home.harness("read-runs");
    const runId = mintRunId();
    plant(h.dir, { id: runId, state: "running", session: "sess_00000000000000aa" });
    plant(h.dir, { id: runId, state: "succeeded" });
    const got = await home.call("GET", `/api/v1/runs/${runId}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: runId, state: "succeeded", harness: h.id });
    const result = await home.call("GET", `/api/v1/runs/${runId}/result`);
    expect(result.body).toMatchObject({
      run: runId,
      state: "succeeded",
      sensitivity: "internal",
      outputRef: `${h.id}/session/sess_00000000000000aa`,
      inspectionUrl: `${home.t.server.url}/#/i/${h.id}/run/${runId}`,
    });
    expect("cost" in result.body).toBe(false);
    const hinted = await home.call("GET", `/api/v1/runs/${runId}?harness=${h.id}`);
    expect(hinted.status).toBe(200);
    expect((await home.call("GET", `/api/v1/runs/${mintRunId()}`)).status).toBe(404);
  });

  test("a run whose records name a person's records hides its content", async () => {
    const h = await home.harness("people-runs");
    const runId = mintRunId();
    plant(h.dir, { id: runId, state: "running", session: "sess_00000000000000bb" });
    plant(h.dir, {
      id: runId,
      state: "succeeded",
      peopleProjection: [`home/person/${mintId("psn")}`],
    });
    const result = await home.call("GET", `/api/v1/runs/${runId}/result`);
    expect(result.body).toMatchObject({ sensitivity: "people", hidden: ["people"] });
    expect("outputRef" in result.body).toBe(false);
  });
});

describe("cancelling and resuming", () => {
  test("a pending park is 409 to resume; once decided it is started again under the same run", async () => {
    const h = await cliHarness("resume-run");
    const { runId, approval, store } = await parkedRun(h.dir);
    const pending = await home.call("POST", `/api/v1/runs/${runId}/resume`, { body: {} });
    expect(pending.status).toBe(409);
    expect(errorOf(pending.body)["reason"]).toBe("decision_pending");
    await store.resolve(approval, "grant", "owner");
    const before = home.t.ops?.children.length ?? 0;
    const resumed = await home.call("POST", `/api/v1/runs/${runId}/resume`, { body: {} });
    expect(resumed.status).toBe(200);
    const [child] = spawnedSince(before);
    expect(child?.request.env["CREWHAUS_RUN_ID"]).toBe(runId);
    const fold = foldStates(runsLedger(h.dir));
    expect(fold.ok ? fold.objects.get(runId)?.state : "").toBe("preparing");
  });

  test("cancelling a parked run withdraws what it waits on; an ended one is 409", async () => {
    const h = await cliHarness("cancel-run");
    const { runId, child, approval } = await parkedRun(h.dir);
    const cancelled = await home.call("POST", `/api/v1/runs/${runId}/cancel`, { body: {} });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body["receipt"] as Record<string, unknown>)["state"]).toBe("succeeded");
    const record = foldReadOnly(join(h.dir, ".crewhaus", "sessions")).records.find(
      (r) => r.id === approval,
    );
    expect(record?.supersededBy).toBe(runId);
    const fold = foldStates(runsLedger(h.dir));
    expect(fold.ok ? fold.objects.get(child)?.state : "").toBe("cancelled");
    const again = await home.call("POST", `/api/v1/runs/${runId}/cancel`, { body: {} });
    expect(again.status).toBe(409);
    expect(errorOf(again.body)["reason"]).toBe("run_ended");
  });
});

describe("a run answers to the credential that started it", () => {
  /** The four run operations a service may be refused, each with its own key. */
  const fourCalls = (runId: string, harness: string, secret: string) => [
    () => home.call("GET", `/api/v1/runs/${runId}`, { secret }),
    () => home.call("GET", `/api/v1/harnesses/${harness}/runs`, { secret }),
    () =>
      home.call("POST", `/api/v1/runs/${runId}/cancel`, {
        body: {},
        secret,
        headers: { "Idempotency-Key": `cancel-${mintRunId()}` },
      }),
    () =>
      home.call("POST", `/api/v1/runs/${runId}/resume`, {
        body: {},
        secret,
        headers: { "Idempotency-Key": `resume-${mintRunId()}` },
      }),
  ];

  test("a second token of the same service is refused the run its first token started, and nothing is written or spawned", async () => {
    const h = await cliHarness("cred-owner");
    const elsewhere = await home.harness("cred-owner-elsewhere");
    const first = await home.service("owner-svc", [h.id], { permissions: ["h.run.submit"] });
    const created = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x" },
      secret: first.secret,
      headers: { "Idempotency-Key": "cred-owner-1" },
    });
    expect(created.status).toBe(202);
    const served = created.body["run"] as Record<string, unknown>;
    const runId = String(served["id"]);
    expect("byCredential" in served).toBe(false);
    const queued = rowsOf(h.dir).find((row) => row["id"] === runId && row["state"] === "queued");
    expect(queued).toMatchObject({ by: first.principal, byCredential: first.credential });
    const got = await home.call("GET", `/api/v1/runs/${runId}`, { secret: first.secret });
    expect(got.status).toBe(200);
    expect("byCredential" in got.body).toBe(false);
    const listed = await home.call("GET", `/api/v1/harnesses/${h.id}/runs`, {
      secret: first.secret,
    });
    expect((listed.body["items"] as { id: string }[]).map((r) => r.id)).toEqual([runId]);
    expect(JSON.stringify(listed.body)).not.toContain("byCredential");

    const second = await home.service("owner-svc", [elsewhere.id]);
    expect(second.principal).toBe(first.principal);
    expect(second.credential).not.toBe(first.credential);
    const rows = rowsOf(h.dir).length;
    const before = home.t.ops?.children.length ?? 0;
    const statuses: number[] = [];
    for (const call of fourCalls(runId, h.id, second.secret)) statuses.push((await call()).status);
    expect(statuses).toEqual([403, 403, 403, 403]);
    expect(rowsOf(h.dir)).toHaveLength(rows);
    expect(spawnedSince(before)).toEqual([]);
    expect(newestState(h.dir, runId)).toBe("preparing");
  });

  test("once the starting token is revoked, no token of the service acts on its run", async () => {
    const h = await cliHarness("cred-revoked");
    const elsewhere = await home.harness("cred-revoked-elsewhere");
    const first = await home.service("revoked-svc", [h.id], { permissions: ["h.run.submit"] });
    const created = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x" },
      secret: first.secret,
      headers: { "Idempotency-Key": "cred-revoked-1" },
    });
    expect(created.status).toBe(202);
    const runId = String((created.body["run"] as Record<string, unknown>)["id"]);
    const second = await home.service("revoked-svc", [elsewhere.id]);
    const revoked = await openAccess(home.t.hangarRoot).revoke(
      { principal: home.owner },
      first.credential,
    );
    expect(revoked.ok).toBe(true);
    const third = await home.service("revoked-svc", [elsewhere.id], {
      permissions: ["h.run.submit"],
    });
    expect(third.principal).toBe(first.principal);
    const before = home.t.ops?.children.length ?? 0;
    for (const token of [second, third]) {
      const statuses: number[] = [];
      for (const call of fourCalls(runId, h.id, token.secret)) {
        statuses.push((await call()).status);
      }
      expect(statuses).toEqual([403, 403, 403, 403]);
    }
    // The revoked secret is refused at authentication.
    const statuses: number[] = [];
    for (const call of fourCalls(runId, h.id, first.secret)) statuses.push((await call()).status);
    expect(statuses).toEqual([401, 401, 401, 401]);
    expect(spawnedSince(before)).toEqual([]);
  });

  test("the starting credential reads, lists and cancels its run, but resumes it only while it may submit runs there", async () => {
    const h = await cliHarness("cred-no-submit");
    const elsewhere = await home.harness("cred-no-submit-elsewhere");
    const token = await home.service("no-submit-svc", [elsewhere.id]);
    const queued = { by: token.principal, byCredential: token.credential };
    const toResume = await decidedRun(h.dir, queued);
    const toCancel = await parkedRun(h.dir, queued);
    const got = await home.call("GET", `/api/v1/runs/${toResume.runId}`, { secret: token.secret });
    expect(got.status).toBe(200);
    const listed = await home.call("GET", `/api/v1/harnesses/${h.id}/runs`, {
      secret: token.secret,
    });
    expect(listed.status).toBe(200);
    expect((listed.body["items"] as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [toResume.runId, toCancel.runId].sort(),
    );
    const before = home.t.ops?.children.length ?? 0;
    const resumed = await home.call("POST", `/api/v1/runs/${toResume.runId}/resume`, {
      body: {},
      secret: token.secret,
      headers: { "Idempotency-Key": "no-submit-resume" },
    });
    expect(resumed.status).toBe(403);
    expect(errorOf(resumed.body)["needs"]).toBe("h.run.submit");
    expect(spawnedSince(before)).toEqual([]);
    expect(newestState(h.dir, toResume.runId)).toBe("waiting-for-approval");
    const cancelled = await home.call("POST", `/api/v1/runs/${toCancel.runId}/cancel`, {
      body: {},
      secret: token.secret,
      headers: { "Idempotency-Key": "no-submit-cancel" },
    });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body["receipt"] as Record<string, unknown>)["state"]).toBe("succeeded");
  });
});

describe("every API start runs the harness's operator prep", () => {
  test("a create whose preSpawn hook refuses runs only the hook, fails its receipt, and withdraws the run and its input", async () => {
    const h = await cliHarness("prep-create");
    hookOf(h.dir, ["/usr/bin/false"]);
    const before = home.t.ops?.children.length ?? 0;
    const pending = home.call("POST", `/api/v1/harnesses/${h.id}/runs`, { body: { input: "x" } });
    const hook = await childWhere(home, before, isHook);
    hook.exit(1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(errorOf(res.body)["reason"]).toBe("not_started");
    const spawned = spawnedSince(before);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.request.argv).toEqual(["/usr/bin/false"]);
    const commands = await home.call("GET", `/api/v1/harnesses/${h.id}/commands`);
    expect((commands.body["items"] as Record<string, unknown>[]).map((c) => c["state"])).toEqual([
      "failed",
    ]);
    const runId = String(rowsOf(h.dir).find((row) => row["state"] === "queued")?.["id"]);
    expect(rowsOf(h.dir).at(-1)).toMatchObject({
      id: runId,
      state: "cancelled",
      reason: "not-started",
    });
    expect(inputsIn(h.dir)).toEqual([]);
    // With no hook, the next create starts its job.
    hookOf(h.dir);
    const next = home.t.ops?.children.length ?? 0;
    const started = await home.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
      body: { input: "x" },
    });
    expect(started.status).toBe(202);
    expect(spawnedSince(next).filter(isJob)).toHaveLength(1);
  });

  test("a resume whose preSpawn hook refuses runs only the hook, fails its receipt, and leaves the run parked", async () => {
    const h = await cliHarness("prep-resume");
    hookOf(h.dir, ["/usr/bin/false"]);
    const { runId } = await decidedRun(h.dir);
    const before = home.t.ops?.children.length ?? 0;
    const pending = home.call("POST", `/api/v1/runs/${runId}/resume`, { body: {} });
    const hook = await childWhere(home, before, isHook);
    hook.exit(1);
    const res = await pending;
    expect((res.body["receipt"] as Record<string, unknown>)["state"]).toBe("failed");
    expect(spawnedSince(before)).toHaveLength(1);
    expect(spawnedSince(before)[0]?.request.argv).toEqual(["/usr/bin/false"]);
    expect(newestState(h.dir, runId)).toBe("waiting-for-approval");
    expect(inputsIn(h.dir)).toEqual([`${runId}.json`]);
  });
});

describe("Home holds a bounded number of API runs at once", () => {
  // Each test boots a Home of its own, so the shared one's live runs do not count.
  test("a harness's fourth live run, and a resume past the cap, are refused busy before anything is written; one exit makes room", async () => {
    const own = await v1Home();
    try {
      const make = async (name: string) => {
        const h = await own.harness(name);
        const bin = join(h.dir, "node_modules", ".bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, "crewhaus"), 0o755);
        return h;
      };
      const h = await make("cap-harness");
      const create = () =>
        own.call("POST", `/api/v1/harnesses/${h.id}/runs`, { body: { input: "x" } });
      for (let i = 0; i < 3; i += 1) expect((await create()).status).toBe(202);
      const parked = await decidedRun(h.dir);
      const receipts = async () =>
        ((await own.call("GET", `/api/v1/harnesses/${h.id}/commands`)).body["items"] as unknown[])
          .length;
      const rows = rowsOf(h.dir).length;
      const inputs = inputsIn(h.dir);
      const children = own.t.ops?.children.length ?? 0;
      const commands = await receipts();
      const busy = await create();
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("10");
      expect(errorOf(busy.body)).toMatchObject({
        code: "unavailable",
        reason: "busy",
        retryAfterMs: 10_000,
      });
      const resumed = await own.call("POST", `/api/v1/runs/${parked.runId}/resume`, { body: {} });
      expect(resumed.status).toBe(503);
      expect(errorOf(resumed.body)).toMatchObject({ code: "unavailable", reason: "busy" });
      expect(rowsOf(h.dir)).toHaveLength(rows);
      expect(inputsIn(h.dir)).toEqual(inputs);
      expect(own.t.ops?.children.length).toBe(children);
      expect(await receipts()).toBe(commands);
      // One job exits: its supervisor lets go of it, and the next create is taken.
      own.t.ops?.children.find(isJob)?.exit(0);
      let tries = 0;
      let next = await create();
      while (next.status === 503 && tries < 200) {
        tries += 1;
        await Bun.sleep(0);
        next = await create();
      }
      expect(next.status).toBe(202);
    } finally {
      await own.t.stop();
    }
  }, 30_000); // boots a Home of its own

  test("Home's own cap counts every harness's live runs", async () => {
    const own = await v1Home({ apiRunLimits: { perHome: 2 } });
    try {
      const statuses: number[] = [];
      for (const name of ["home-cap-1", "home-cap-2", "home-cap-3"]) {
        const h = await own.harness(name);
        const bin = join(h.dir, "node_modules", ".bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "crewhaus"), "#!/bin/sh\nexit 0\n");
        chmodSync(join(bin, "crewhaus"), 0o755);
        const res = await own.call("POST", `/api/v1/harnesses/${h.id}/runs`, {
          body: { input: "x" },
        });
        statuses.push(res.status);
        if (res.status === 503) {
          expect(errorOf(res.body)).toMatchObject({ reason: "busy" });
          expect(String(errorOf(res.body)["message"])).toStartWith("Home is already running");
          expect(inputsIn(h.dir)).toEqual([]);
        }
      }
      expect(statuses).toEqual([202, 202, 503]);
    } finally {
      await own.t.stop();
    }
  }, 30_000); // boots a Home of its own

  test("two resumes of one parked run at once start one job", async () => {
    const h = await cliHarness("double-resume");
    const { runId } = await decidedRun(h.dir);
    const before = home.t.ops?.children.length ?? 0;
    const answers = await Promise.all([
      home.call("POST", `/api/v1/runs/${runId}/resume`, { body: {} }),
      home.call("POST", `/api/v1/runs/${runId}/resume`, { body: {} }),
    ]);
    expect(spawnedSince(before).filter(isJob)).toHaveLength(1);
    const states = answers
      .map((answer) => (answer.body["receipt"] as Record<string, unknown> | undefined)?.["state"])
      .sort();
    expect(states).toEqual(["failed", "succeeded"]);
  });
});
