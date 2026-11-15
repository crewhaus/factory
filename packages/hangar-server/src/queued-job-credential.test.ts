/**
 * A job Home queues for a command starts only while the credential that submitted the
 * command still holds the permission: when a slot frees up for it, and when Home's restore
 * puts it back after a restart. A refused job never runs; it ends `cancelled`, and its
 * receipt `rejected` (`forbidden`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import { mintId } from "@crewhaus/control-contract";
import { type Ledger, append } from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import type { JobRecord, JobRunner } from "@crewhaus/harness-supervisor";
import { type V1Home, v1Home } from "./__test__/v1-home";
import { startHangarServer } from "./server";

const homes: V1Home[] = [];
afterEach(async () => {
  while (homes.length > 0) await (homes.pop() as V1Home).t.stop();
});

/** Every row a segmented ledger holds, in order. */
function rowsOf(ledger: Ledger): Record<string, unknown>[] {
  if (!("dir" in ledger.records)) throw new Error("segmented ledgers only");
  const dir = join(ledger.root, ledger.records.dir);
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((name) => /^\d{6}\.jsonl$/.test(name))
      .sort();
  } catch {
    return [];
  }
  return names.flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

/** A runner that counts its calls and holds each job until the test releases it. */
function heldRunner() {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const run: JobRunner = (job) => {
    started.push(job.jobId);
    return new Promise((resolve) => releases.set(job.jobId, () => resolve({ exitCode: 0 })));
  };
  return { run, started, release: (jobId: string) => releases.get(jobId)?.() };
}

/** The rows of Home's job ledger for one job, in order. */
function jobRows(hangarRoot: string, jobId: string): Record<string, unknown>[] {
  const path = join(hangarRoot, "jobs.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row["jobId"] === jobId);
}

/** Wait, a bounded number of turns, until `done` holds; answer whether it did. */
async function until(done: () => boolean, turns = 200): Promise<boolean> {
  for (let i = 0; i < turns; i += 1) {
    if (done()) return true;
    await Bun.sleep(25);
  }
  return done();
}

async function revoke(h: V1Home, credential: string): Promise<void> {
  const revoked = await openAccess(h.t.hangarRoot).revoke({ principal: h.owner }, credential);
  if (!revoked.ok) throw new Error(revoked.reason);
}

const receiptRows = (dir: string, credential: string) =>
  rowsOf(commandsLedgerOf(dir)).filter(
    (row) => row["kind"] === "legacy.submitJob" && row["credentialRef"] === credential,
  );

describe("a job queued for a service's command starts only while its credential holds", () => {
  async function queuedBehindOwner(revokeFirst: boolean) {
    const runner = heldRunner();
    const h = await v1Home({ runJob: runner.run });
    homes.push(h);
    const { id, dir } = await h.harness("queued-job");
    // A compile needs `h.deploy` beside the route's `h.job.run`.
    const svc = await h.service("portal", [id], { permissions: ["h.job.run", "h.deploy"] });
    // The owner's compile holds the harness, so the service's compile waits behind it.
    const owners = await h.call("POST", `/api/h/${id}/jobs`, { body: { kind: "compile" } });
    expect(owners.status).toBe(202);
    const ownerJob = (owners.body["job"] as JobRecord).jobId;
    const asService = await h.call("POST", `/api/h/${id}/jobs`, {
      body: { kind: "compile" },
      secret: svc.secret,
    });
    expect(asService.status).toBe(202);
    const serviceJob = (asService.body["job"] as JobRecord).jobId;
    expect(runner.started).toEqual([ownerJob]);
    if (revokeFirst) await revoke(h, svc.credential);
    runner.release(ownerJob);
    return { h, dir, runner, svc, serviceJob, ownerJob };
  }

  test("revoked while it waits: it never runs, ends cancelled, and its receipt is rejected", async () => {
    const { h, dir, runner, svc, serviceJob } = await queuedBehindOwner(true);
    const last = () => jobRows(h.t.hangarRoot, serviceJob).at(-1)?.["state"];
    expect(await until(() => last() === "cancelled")).toBe(true);
    await h.t.server.controlService.jobs.idle();
    expect(runner.started.filter((job) => job === serviceJob)).toEqual([]);
    const rows = receiptRows(dir, svc.credential);
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "rejected"]);
    expect((rows.at(-1)?.["outcome"] as { code?: string })?.code).toBe("forbidden");
  }, 20_000);

  test("still live when its turn comes: it runs", async () => {
    const { h, dir, runner, svc, serviceJob } = await queuedBehindOwner(false);
    expect(await until(() => runner.started.includes(serviceJob))).toBe(true);
    expect(runner.started.filter((job) => job === serviceJob)).toHaveLength(1);
    runner.release(serviceJob);
    const last = () => jobRows(h.t.hangarRoot, serviceJob).at(-1)?.["state"];
    expect(await until(() => last() === "done")).toBe(true);
    await h.t.server.controlService.jobs.idle();
    expect(receiptRows(dir, svc.credential).map((row) => row["state"])).toEqual([
      "accepted",
      "running",
      "succeeded",
    ]);
  }, 20_000);
});

describe("a member's queued job starts only while every permission its submit needed holds", () => {
  /** The member's maintainer grant on the whole Home becomes an operator's. */
  async function demote(h: V1Home, principal: string): Promise<void> {
    const read = loadAccessSnapshot(h.t.hangarRoot);
    if (read.state !== "present") throw new Error("no access records");
    const grant = read.snapshot.grants.find(
      (row) => row.principal === principal && row.state === "active",
    );
    if (grant === undefined) throw new Error("no grant");
    const access = openAccess(h.t.hangarRoot);
    const revoked = await access.revoke({ principal: h.owner }, grant.id);
    if (!revoked.ok) throw new Error(revoked.reason);
    const granted = await access.grant(
      { principal: h.owner },
      { member: principal, role: "operator", scope: "home" },
    );
    if (!granted.ok) throw new Error(granted.reason);
  }

  /** The rows of the first receipt of this kind the credential submitted (the queued one). */
  const commandRows = (dir: string, credential: string, kind: string) => {
    const rows = rowsOf(commandsLedgerOf(dir)).filter(
      (row) => row["kind"] === kind && row["credentialRef"] === credential,
    );
    const first = rows[0]?.["id"];
    expect(first).toBeDefined();
    return rows.filter((row) => row["id"] === first);
  };

  /** Answer the job a call queued. */
  const jobOf = (answer: { status: number; body: Record<string, unknown> }): string => {
    expect([200, 202]).toContain(answer.status);
    return (answer.body["job"] as JobRecord).jobId;
  };

  async function memberCompileBehindOwner(demoteFirst: boolean) {
    const runner = heldRunner();
    const h = await v1Home({ runJob: runner.run });
    homes.push(h);
    const { id, dir } = await h.harness("member-compile");
    const mia = await h.member("mia", "maintainer");
    const ownerJob = jobOf(
      await h.call("POST", `/api/h/${id}/jobs`, { body: { kind: "compile" } }),
    );
    const miaJob = jobOf(
      await h.call("POST", `/api/h/${id}/jobs`, { body: { kind: "compile" }, secret: mia.secret }),
    );
    expect(runner.started).toEqual([ownerJob]);
    if (demoteFirst) {
      await demote(h, mia.principal);
      // An operator may run jobs but not compile: asked now, a compile is refused.
      const asked = await h.call("POST", `/api/h/${id}/jobs`, {
        body: { kind: "compile" },
        secret: mia.secret,
      });
      expect(asked.status).toBe(403);
    }
    runner.release(ownerJob);
    return { h, dir, runner, mia, miaJob };
  }

  test("a maintainer's compile, demoted to operator while it waits, never runs", async () => {
    const { h, dir, runner, mia, miaJob } = await memberCompileBehindOwner(true);
    const last = () => jobRows(h.t.hangarRoot, miaJob).at(-1)?.["state"];
    expect(await until(() => last() === "cancelled")).toBe(true);
    await h.t.server.controlService.jobs.idle();
    expect(runner.started.filter((job) => job === miaJob)).toEqual([]);
    const rows = commandRows(dir, mia.credential, "legacy.submitJob");
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "rejected"]);
    expect((rows.at(-1)?.["outcome"] as { code?: string })?.code).toBe("forbidden");
  }, 20_000);

  test("the same compile runs while she is still a maintainer", async () => {
    const { runner, miaJob } = await memberCompileBehindOwner(false);
    expect(await until(() => runner.started.includes(miaJob))).toBe(true);
    expect(runner.started.filter((job) => job === miaJob)).toHaveLength(1);
    runner.release(miaJob);
  }, 20_000);

  test("a doctor run with fix, whose submitter lost the permission that writes credentials, never runs", async () => {
    const runner = heldRunner();
    const h = await v1Home({ runJob: runner.run });
    homes.push(h);
    const { id, dir } = await h.harness("member-doctor-fix");
    const mia = await h.member("mia", "maintainer");
    // The owner's three jobs fill every slot, so hers waits.
    const ownerJobs = [
      jobOf(await h.call("POST", `/api/h/${id}/jobs`, { body: { kind: "compile" } })),
      jobOf(await h.call("POST", `/api/h/${id}/doctor`, { body: {} })),
      jobOf(await h.call("POST", `/api/h/${id}/doctor`, { body: {} })),
    ];
    const miaJob = jobOf(
      await h.call("POST", `/api/h/${id}/doctor`, { body: { fix: true }, secret: mia.secret }),
    );
    expect(runner.started).toEqual(ownerJobs);
    await demote(h, mia.principal);
    const asked = await h.call("POST", `/api/h/${id}/doctor`, {
      body: { fix: true },
      secret: mia.secret,
    });
    expect(asked.status).toBe(403);
    runner.release(ownerJobs[1] as string);
    const last = () => jobRows(h.t.hangarRoot, miaJob).at(-1)?.["state"];
    expect(await until(() => last() === "cancelled")).toBe(true);
    await h.t.server.controlService.jobs.idle();
    expect(runner.started.filter((job) => job === miaJob)).toEqual([]);
    const rows = commandRows(dir, mia.credential, "legacy.doctorRun");
    expect(rows.map((row) => row["state"])).toEqual(["accepted", "rejected"]);
    expect((rows.at(-1)?.["outcome"] as { code?: string })?.code).toBe("forbidden");
  }, 20_000);
});

describe("a job Home's restore puts back is checked before it starts", () => {
  /** A pending doctor job and its accepted receipt, left by a Home whose process is gone. */
  function plantPendingJob(h: V1Home, dir: string, principal: string, credential: string) {
    const commandId = mintId("cmd");
    const at = new Date().toISOString();
    const appended = append(commandsLedgerOf(dir), {
      v: 1,
      id: commandId,
      kind: "legacy.submitJob",
      target: `home/harness/${h.harnessId}`,
      actor: principal,
      credentialRef: credential,
      via: "home",
      fingerprint: "f".repeat(64),
      state: "accepted",
      acceptedAt: at,
      executor: { pid: 2_147_483_000, startedAt: at, host: hostname(), head: "server" },
      effects: [{ kind: "job", status: "unknown" }],
      retry: { retryable: false, safety: "unsafe" },
    });
    if (!appended.ok) throw new Error(appended.reason);
    const jobId = `job_${"0".repeat(15)}1`;
    appendFileSync(
      join(h.t.hangarRoot, "jobs.jsonl"),
      `${JSON.stringify({
        jobId,
        harnessDir: dir,
        kind: "doctor",
        argv: ["doctor"],
        mutating: false,
        state: "pending",
        enqueuedAt: at,
        commandId,
        by: principal,
        needs: ["h.eval.run"],
      })}\n`,
    );
    return { commandId, jobId };
  }

  async function restartWith(revoked: boolean) {
    const base = await v1Home();
    homes.push(base);
    const { id, dir } = await base.harness("restored-job");
    const h = Object.assign(base, { harnessId: id });
    const svc = await h.service("portal", [id], { permissions: ["h.job.run", "h.eval.run"] });
    await h.t.server.stop();
    const planted = plantPendingJob(h, dir, svc.principal, svc.credential);
    if (revoked) await revoke(h, svc.credential);
    const marker = join(h.t.workspace, "job-ran.txt");
    const again = startHangarServer({
      port: 0,
      root: h.t.hangarRoot,
      registryRoot: h.t.registryRoot,
      env: { CREWHAUS_WATCHME_ROOT: join(h.t.workspace, "watchme") },
      onWarn: () => undefined,
      homeCrewhaus: [
        process.execPath,
        "-e",
        `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n")`,
      ],
    });
    return { h, dir, svc, planted, marker, again };
  }

  // Two Homes boot in each case, one after the other.
  test("revoked before the restart: the restored job never runs", async () => {
    const { h, dir, planted, marker, again } = await restartWith(true);
    try {
      await again.ready;
      const last = () => jobRows(h.t.hangarRoot, planted.jobId).at(-1)?.["state"];
      expect(await until(() => last() === "cancelled")).toBe(true);
      await again.controlService.jobs.idle();
      expect(existsSync(marker)).toBe(false);
      const rows = rowsOf(commandsLedgerOf(dir)).filter((row) => row["id"] === planted.commandId);
      expect(rows.map((row) => row["state"])).toEqual(["accepted", "rejected"]);
      expect((rows.at(-1)?.["outcome"] as { code?: string })?.code).toBe("forbidden");
    } finally {
      await again.stop();
    }
  }, 20_000);

  test("still live after the restart: the restored job runs once", async () => {
    const { h, planted, marker, again } = await restartWith(false);
    try {
      await again.ready;
      const last = () => jobRows(h.t.hangarRoot, planted.jobId).at(-1)?.["state"];
      expect(await until(() => last() === "done" || last() === "failed")).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("ran\n");
    } finally {
      await again.stop();
    }
  }, 20_000);
});
