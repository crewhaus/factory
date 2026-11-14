/**
 * Home's jobs and the operator record: a harness its operator disabled runs no job that
 * serves or runs its spec, and, once adopted, no job at all, because every job of an
 * adopted harness runs that harness's own `crewhaus`. Each refusal answers 409 `disabled`
 * with the verb that allows it again, and nothing is queued or spawned.
 *
 * The server drives the real queue over a job runner that records what it is handed, so
 * "queued nothing" is that record staying empty.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHangarRegistry } from "@crewhaus/harness-registry";
import type { JobRecord } from "@crewhaus/harness-supervisor";
import { makeFixtureHarness } from "./fixture";
import { jobRunsSpec } from "./process";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-04T00:00:00.000Z");

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

/** A job runner that parks forever and records each job it is handed. */
function parkingRunner(seen: JobRecord[]): (job: JobRecord) => Promise<{ exitCode?: number }> {
  return (job) => {
    seen.push(job);
    return new Promise<{ exitCode?: number }>(() => {});
  };
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", post({ dir }));
  return (body["entry"] as { id: string }).id;
}

/** A `cli` harness, the shape `crewhaus serve --mcp` projects. */
function cliHarness(t: TestServer, name: string): string {
  const dir = makeFixtureHarness(join(t.harnessesRoot, name), {
    specName: `${name}-harness`,
    target: "cli",
  });
  // The files an eval job is offered with.
  mkdirSync(join(dir, "eval"), { recursive: true });
  writeFileSync(join(dir, "eval", "dataset.jsonl"), `${JSON.stringify({ input: "hi" })}\n`);
  writeFileSync(join(dir, "eval", "graders.yaml"), "graders: []\n");
  return dir;
}

function disable(dir: string): void {
  const control = join(dir, ".crewhaus", "run", "control");
  mkdirSync(control, { recursive: true });
  writeFileSync(
    join(control, "operator.json"),
    `${JSON.stringify({
      v: 1,
      rev: 2,
      intake: null,
      deployment: { disabled: true, since: new Date(NOW).toISOString(), by: "prn_a" },
      desired: "running",
    })}\n`,
  );
}

function expectDisabled(res: { status: number; body: Record<string, unknown> }): void {
  expect(res.status).toBe(409);
  expect(res.body).toMatchObject({ ok: false, reason: "disabled", verb: "crewhaus daemon enable" });
  expect(String(res.body["message"])).toContain("Disabled by its operator");
}

describe("a disabled harness runs no Home job that serves or runs its spec", () => {
  test("the MCP projection's start and the dev loop's start are refused 409 disabled, and nothing is queued", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const dir = cliHarness(t, "job-off-serve");
      const id = await register(t, dir);
      disable(dir);
      expectDisabled(await t.api(`/api/h/${id}/mcp-servers/start`, post({})));
      expectDisabled(await t.api(`/api/h/${id}/dev/start`, post({})));
      expect(seen).toEqual([]);
      expect(t.ops?.children.length ?? 0).toBe(0);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("an eval and a dream run are refused 409 disabled, and nothing is queued; a doctor still runs", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const dir = cliHarness(t, "job-off-eval");
      const id = await register(t, dir);
      disable(dir);
      expectDisabled(await t.api(`/api/h/${id}/jobs`, post({ kind: "eval" })));
      expectDisabled(await t.api(`/api/h/${id}/jobs`, post({ kind: "dream-run" })));
      expect(seen).toEqual([]);
      // A job that runs no spec, under Home's own crewhaus, is not this check's to refuse.
      const doctor = await t.api(`/api/h/${id}/jobs`, post({ kind: "doctor" }));
      expect(doctor.status).toBe(202);
      expect(seen.map((job) => job.kind)).toEqual(["doctor"]);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("every job of a disabled adopted harness is refused 409 disabled, as it runs the harness's own crewhaus", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const dir = cliHarness(t, "job-off-adopted");
      const id = await register(t, dir);
      const registry = openHangarRegistry({ root: t.registryRoot, env: {} });
      expect(registry.adopt(id, "prn_test")).toBeDefined();
      disable(dir);
      for (const kind of ["doctor", "compile", "eval"]) {
        expectDisabled(await t.api(`/api/h/${id}/jobs`, post({ kind })));
      }
      expectDisabled(await t.api(`/api/h/${id}/mcp-servers/start`, post({})));
      expect(seen).toEqual([]);
      expect(t.ops?.children.length ?? 0).toBe(0);
    } finally {
      await t.stop();
    }
  }, 20_000);

  test("an enabled harness's jobs are queued", async () => {
    const seen: JobRecord[] = [];
    const t = bootTestServer({ now: () => NOW, runJob: parkingRunner(seen) });
    try {
      const dir = cliHarness(t, "job-on");
      const id = await register(t, dir);
      expect((await t.api(`/api/h/${id}/jobs`, post({ kind: "eval" }))).status).toBe(202);
      expect(seen.map((job) => job.argv[0])).toEqual(["eval"]);
      // Queued behind the parked eval, so it is not handed to the runner yet.
      const served = await t.api(`/api/h/${id}/mcp-servers/start`, post({}));
      expect(served.body["started"]).toBe(true);
      expect((served.body["argv"] as string[])[0]).toBe("serve");
    } finally {
      await t.stop();
    }
  }, 20_000);
});

describe("jobRunsSpec", () => {
  test("names the verbs that run or serve a spec, and no read verb", () => {
    const runs = [
      ["serve", "--mcp", "crewhaus.yaml"],
      ["dev", "crewhaus.yaml"],
      ["run", "crewhaus.yaml", "--prompt", "x"],
      ["optimize", "crewhaus.yaml"],
      ["eval", "crewhaus.yaml"],
      ["eval", "suite", "suite.yaml"],
      ["eval", "sentinel", "crewhaus.yaml"],
      ["flywheel", "run", "crewhaus.yaml"],
      ["dream", "run", "crewhaus.yaml"],
      ["dream", "crewhaus.yaml"],
    ];
    for (const argv of runs) expect([argv, jobRunsSpec(argv)]).toEqual([argv, true]);
    const reads = [
      ["doctor"],
      ["compile", "crewhaus.yaml"],
      ["eval", "coverage"],
      ["eval", "history"],
      ["flywheel", "status"],
      ["dream", "status"],
      ["distill"],
    ];
    for (const argv of reads) expect([argv, jobRunsSpec(argv)]).toEqual([argv, false]);
  });
});
