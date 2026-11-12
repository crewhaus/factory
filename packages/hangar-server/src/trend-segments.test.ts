/**
 * Home's trends are cut where the measuring instrument changed: a series
 * carries its segments, and its delta (and the advisor's improvement line) is
 * the last segment's, over runs written by the real runner.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCorpusEval } from "./__test__/eval-corpus";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

async function harnessWithBreak(t: TestServer): Promise<string> {
  const dir = makeFixtureHarness(join(t.harnessesRoot, "seg"), { specName: "seg" });
  // Two runs graded with one graders config, then two with another.
  const runs: Array<[string, Record<string, "pass" | "fail">, string]> = [
    ["run_000000000000bb01", { s1: "fail", s2: "fail" }, "g1"],
    ["run_000000000000bb02", { s1: "pass", s2: "fail" }, "g1"],
    ["run_000000000000bb03", { s1: "pass", s2: "fail" }, "g2"],
    ["run_000000000000bb04", { s1: "pass", s2: "pass" }, "g2"],
  ];
  for (const [runId, behaviors, gradersHash] of runs) {
    await runCorpusEval(dir, behaviors, {
      runId,
      specName: "seg",
      datasetName: "smoke",
      opts: { gradersHash },
    });
  }
  const { body } = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (body["entry"] as { id: string }).id;
}

describe("trends cut where the instrument changed", () => {
  test("evalTrends: each series carries its segments and the cut, and its delta is the last segment's", async () => {
    const t = bootTestServer();
    servers.push(t);
    const id = await harnessWithBreak(t);
    const { status, body } = await t.api(`/api/h/${id}/evals/trends`);
    expect(status).toBe(200);
    const [series] = body["series"] as Array<{
      points: unknown[];
      segments: Array<{ runCount: number }>;
      boundaries: Array<{ toRunId: string; changed: Array<{ field: string }> }>;
      deltaPp: number | null;
    }>;
    expect(series?.points.length).toBe(4);
    expect(series?.segments.map((s) => s.runCount)).toEqual([2, 2]);
    expect(series?.boundaries).toHaveLength(1);
    expect(series?.boundaries[0]?.toRunId).toBe("run_000000000000bb03");
    expect(series?.boundaries[0]?.changed[0]?.field).toBe("gradersHash");
    // 50% → 100% since the change, never 0% → 100% across it.
    expect(series?.deltaPp).toBe(50);
  }, 20_000); // four runs through the real runner

  test("advisorTrend: folds the latest lineage over its last segment, and says since when", async () => {
    const t = bootTestServer();
    servers.push(t);
    const id = await harnessWithBreak(t);
    const { body } = await t.api(`/api/h/${id}/advisor/trend`);
    const evalSeries = body["evalSeries"] as Array<{ runId: string; passRate: number }>;
    expect(evalSeries.map((r) => r.runId)).toEqual([
      "run_000000000000bb03",
      "run_000000000000bb04",
    ]);
    expect(body["boundaries"]).toHaveLength(1);
    expect(body["lineage"]).toEqual({ id: "seg::smoke", label: "seg/smoke" });
    expect(String(body["summary"])).toBe(
      "pass rate is up 50.0 points since the checks last changed",
    );
  }, 20_000); // four runs through the real runner

  test("advisorTrend: with no cut the summary reads as it always did", async () => {
    const t = bootTestServer();
    servers.push(t);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "flat"), { specName: "flat" });
    await runCorpusEval(
      dir,
      { s1: "fail", s2: "fail" },
      { runId: "run_000000000000cc01", specName: "flat" },
    );
    await runCorpusEval(
      dir,
      { s1: "pass", s2: "fail" },
      { runId: "run_000000000000cc02", specName: "flat" },
    );
    const { body: reg } = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    const id = (reg["entry"] as { id: string }).id;
    const { body } = await t.api(`/api/h/${id}/advisor/trend`);
    expect(body["boundaries"]).toEqual([]);
    expect(String(body["summary"])).toBe(
      "pass rate is up 50.0 points since the first recorded run",
    );
  }, 20_000); // two runs through the real runner
});
