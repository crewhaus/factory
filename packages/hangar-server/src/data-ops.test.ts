/**
 * The dataset registry's rules, each pinned by the failure it prevents:
 *
 *   - a stored-hash mismatch is TAMPERED, not "stale": the stored per-sample
 *     hashes are the version identity every gated run was keyed on;
 *   - provenance is a TAXONOMY (`metadata.source`), and an unlabelled sample
 *     is an audit finding, not a shrug;
 *   - `<spec>-ratings` / `<spec>-regressions` are auto-maintained and say so;
 *   - the held-out test split is locked, with a burn count from `releases[]`;
 *   - quarantine is EVIDENCE and surfaces with its provenance;
 *   - `audit` (registry integrity) and `lint` (canary contamination) are
 *     different questions and never share a button;
 *   - a growth verb previews before it writes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provenance, runMatchesVersion, splitSizes, verifyRecord } from "./data-ops";
import { makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

function boot(): TestServer {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  return (body["entry"] as { id: string }).id;
}

function writeJson(dir: string, relative: readonly string[], value: unknown): void {
  const path = join(dir, ...relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const sample = (id: string, source: string): Record<string, unknown> => ({
  id,
  input: `question ${id}`,
  expected_output: `answer ${id}`,
  metadata: { source },
});

/**
 * A registry with one intact version, one TAMPERED version (stored hashes no
 * longer describe the content), a released version carrying a burn, and an
 * auto-maintained ratings dataset.
 */
function dataHarness(t: TestServer): string {
  const dir = makeFixtureHarness(join(t.harnessesRoot, "data"), {
    specName: "data",
    evalIndex: [
      {
        runId: "run_000000000000cc01",
        specName: "data",
        specHash: "s",
        datasetName: "core@v1",
        datasetHash: "d",
        passRate: 1,
        meanScore: 1,
        sampleCount: 2,
        ts: iso(NOW - DAY),
        outDir: "/gone",
      },
      {
        runId: "run_000000000000cc02",
        specName: "data",
        specHash: "s",
        // The regression UNION of the same version — a naive equality join
        // would drop this run from the version's freshness column.
        datasetName: "core@v1+regressions@v3",
        datasetHash: "d",
        passRate: 1,
        meanScore: 1,
        sampleCount: 2,
        ts: iso(NOW - DAY),
        outDir: "/gone",
      },
    ],
    evalRuns: [
      {
        runId: "run_000000000000cc01",
        results: {
          results: [
            { sampleId: "a", pass: true },
            { sampleId: "b", pass: false },
          ],
        },
      },
      {
        runId: "run_000000000000cc02",
        results: {
          results: [
            { sampleId: "a", pass: true },
            { sampleId: "b", pass: true },
          ],
        },
      },
    ],
  });
  writeJson(dir, [".crewhaus", "datasets", "core", "v1.json"], {
    name: "core",
    version: "v1",
    splits: {
      train: [sample("a", "human")],
      dev: [sample("b", "mined")],
      test: [sample("c", "human")],
    },
    // Hashes deliberately WRONG: this is what a hand-edited record looks like.
    sampleHashes: { train: ["deadbeefdeadbeef"], dev: ["deadbeefdeadbeef"], test: ["deadbeef"] },
    createdAt: iso(NOW - 30 * DAY),
    releases: [
      { version: "v1", runId: "run_000000000000cc01", ts: iso(NOW - 5 * DAY), passRate: 0.9 },
    ],
  });
  writeJson(dir, [".crewhaus", "datasets", "data-ratings", "v1.json"], {
    name: "data-ratings",
    version: "v1",
    splits: { train: [sample("r1", "human")], dev: [] },
    sampleHashes: { train: [], dev: [] },
    createdAt: iso(NOW - DAY),
  });
  mkdirSync(join(dir, ".crewhaus", "datasets", "_quarantine"), { recursive: true });
  writeFileSync(
    join(dir, ".crewhaus", "datasets", "_quarantine", "data-hardcases.jsonl"),
    `${JSON.stringify({
      id: "q1",
      input: "a hard case",
      metadata: { source: "mined", reason: "tool loop detected" },
    })}\n`,
  );
  return dir;
}

describe("pure registry rules", () => {
  test("a hand-edited record verifies as TAMPERED, never as stale", () => {
    const record = {
      name: "x",
      version: "v1",
      splits: { train: [sample("a", "human")], dev: [] },
      sampleHashes: { train: ["not-the-real-hash"], dev: [] },
      createdAt: iso(NOW),
    };
    const verify = verifyRecord(record as never);
    expect(verify.ok).toBe(false);
    expect(verify.badge).toBe("tampered");
    expect(verify.mismatches).toBe(1);
  });

  test("provenance is a tally over the source taxonomy, unlabelled included", () => {
    const record = {
      name: "x",
      version: "v1",
      splits: {
        train: [sample("a", "human"), sample("b", "synthetic")],
        dev: [{ id: "c", input: "i" }],
      },
      sampleHashes: {},
      createdAt: iso(NOW),
    };
    expect(provenance(record as never)).toEqual({
      human: 1,
      synthetic: 1,
      "(unlabelled)": 1,
    });
    expect(splitSizes(record as never)).toEqual({ train: 2, dev: 1, test: null });
  });

  test("a version's runs include its split-pinned and regression-unioned names", () => {
    expect(runMatchesVersion("core", "v1", "core@v1")).toBe(true);
    expect(runMatchesVersion("core", "v1", "core@v1#dev")).toBe(true);
    expect(runMatchesVersion("core", "v1", "core@v1+regressions@v3")).toBe(true);
    expect(runMatchesVersion("core", "v1", "core@v2")).toBe(false);
  });
});

describe("the registry panel", () => {
  test("renders splits, provenance, the tampered badge and the burn count", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/data/datasets`);
    expect(status).toBe(200);
    const rows = body["datasets"] as Array<{
      name: string;
      verify: { ok: boolean; badge: string };
      splits: { train: number; dev: number; test: number | null };
      provenance: Record<string, number>;
      testSplitBurn: number;
      autoMaintained: string | null;
    }>;
    const core = rows.find((r) => r.name === "core") as (typeof rows)[number];
    expect(core.splits).toEqual({ train: 1, dev: 1, test: 1 });
    expect(core.provenance).toEqual({ human: 2, mined: 1 });
    expect(core.verify.badge).toBe("tampered");
    expect(core.testSplitBurn).toBe(1);
    expect(core.autoMaintained).toBeNull();
    // The auto-maintained pair says so, so the UI offers no hand edit the
    // next distill would overwrite.
    const ratings = rows.find((r) => r.name === "data-ratings") as (typeof rows)[number];
    expect(ratings.autoMaintained).toContain("distill");
    expect(String(body["note"])).toContain("TAMPERED");
  });

  test("the detail view states the test-split lock and its burn history", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const { body } = await t.api(`/api/h/${id}/data/datasets/core`);
    expect(body["name"]).toBe("core");
    const versions = body["versions"] as Array<{ version: string; burn: { count: number } }>;
    expect(versions[0]?.burn.count).toBe(1);
    const lock = body["testSplit"] as { locked: boolean; verb: string };
    expect(lock.locked).toBe(true);
    expect(lock.verb).toContain("release");
  });

  test("a dataset that is not registered answers a typed refusal, not an error", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/data/datasets/nope`);
    expect(status).toBe(200);
    expect(body["present"]).toBe(false);
    expect(body["versions"]).toEqual([]);
  });

  /**
   * The verifier's whole purpose is the HAND-WRITTEN record — and a
   * hand-written `<version>.json` is exactly the file that may carry no
   * `sampleHashes` (or no `splits`) at all. The guard covered the inner index
   * only, so the outer dereference threw and one such file 500'd the whole
   * registry panel, taking every well-formed dataset down with it.
   */
  test("a record written by hand, without sampleHashes, lists as tampered", async () => {
    const t = boot();
    const dir = dataHarness(t);
    writeJson(dir, [".crewhaus", "datasets", "byhand", "v1.json"], {
      name: "byhand",
      version: "v1",
      splits: { train: [sample("h1", "human")], dev: [] },
      createdAt: iso(NOW - DAY),
    });
    // A record with no `splits` either — the emptiest thing an operator can
    // leave behind that still parses as JSON.
    writeJson(dir, [".crewhaus", "datasets", "bare", "v1.json"], {
      name: "bare",
      version: "v1",
      createdAt: iso(NOW - DAY),
    });
    const id = await register(t, dir);

    const list = await t.api(`/api/h/${id}/data/datasets`);
    expect(list.status).toBe(200);
    const rows = list.body["datasets"] as Array<{
      name: string;
      verify: { ok: boolean; badge: string; mismatches: number } | null;
      splits: { train: number; dev: number; test: number | null } | null;
    }>;
    // The well-formed datasets are still there — the bad file did not take
    // the panel with it.
    expect(rows.find((r) => r.name === "core")).toBeDefined();
    const byhand = rows.find((r) => r.name === "byhand") as (typeof rows)[number];
    expect(byhand.verify?.badge).toBe("tampered");
    expect(byhand.verify?.mismatches).toBe(1);
    expect(byhand.splits).toEqual({ train: 1, dev: 0, test: null });
    const bare = rows.find((r) => r.name === "bare") as (typeof rows)[number];
    expect(bare.verify?.ok).toBe(true);
    expect(bare.splits).toEqual({ train: 0, dev: 0, test: null });

    const detail = await t.api(`/api/h/${id}/data/datasets/byhand`);
    expect(detail.status).toBe(200);
    expect(detail.body["name"]).toBe("byhand");
  });
});

describe("status + quarantine", () => {
  test("status joins runs through the union grammar and flags saturation", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const { body } = await t.api(`/api/h/${id}/data/status`);
    const rows = body["datasets"] as Array<{
      name: string;
      version: string;
      runCount: number;
      ageDays: number;
      saturation: { runsConsidered: number; alwaysPassing: string[] };
    }>;
    const core = rows.find((r) => r.name === "core") as (typeof rows)[number];
    // Both the exact run and the regression-unioned one join.
    expect(core.runCount).toBe(2);
    expect(core.ageDays).toBe(30);
    // `a` passed in both runs and no longer discriminates; `b` did not.
    expect(core.saturation.alwaysPassing).toEqual(["a"]);
  });

  test("quarantined samples surface WITH the provenance that explains them", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const { body } = await t.api(`/api/h/${id}/data/quarantine`);
    expect(body["present"]).toBe(true);
    const entries = body["entries"] as Array<{ id: string; source: string; reason: string }>;
    expect(entries.length).toBe(1);
    expect(entries[0]?.source).toBe("mined");
    expect(entries[0]?.reason).toBe("tool loop detected");
    expect(String(body["promoteVerb"])).toContain("--review");
  });

  test("a quarantined sample's free text is masked", async () => {
    const t = boot();
    const dir = dataHarness(t);
    // Built from parts so no realistic-shaped literal is ever committed.
    const leaked = ["xox", "b-", "1234567890", "-abcdefghij"].join("");
    writeFileSync(
      join(dir, ".crewhaus", "datasets", "_quarantine", "leak.jsonl"),
      `${JSON.stringify({ id: "q2", input: `token ${leaked} pasted by a user` })}\n`,
    );
    const id = await register(t, dir);
    const { body } = await t.api(`/api/h/${id}/data/quarantine`);
    const inputs = (body["entries"] as Array<{ input: string }>).map((e) => e.input).join(" ");
    expect(inputs).not.toContain(leaked);
    expect(inputs).toContain("***");
  });
});

describe("hygiene", () => {
  test("verify runs in process and names the tampered versions", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const { status, body } = await t.api(`/api/h/${id}/data/verify`, {
      method: "POST",
      body: JSON.stringify({ name: "core" }),
    });
    expect(status).toBe(200);
    expect(body["tampered"]).toEqual(["v1"]);
    expect(body["readOnly"]).toBe(true);
    expect(String(body["note"])).toContain("TAMPERED");
  });

  test("audit is registry integrity; lint is the contamination scan — different answers", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const audit = await t.api(`/api/h/${id}/data/audit`, { method: "POST", body: "{}" });
    const findings = audit.body["findings"] as Array<{ finding: string; level: string }>;
    expect(findings.some((f) => f.finding.includes("TAMPERED"))).toBe(true);
    expect(findings.some((f) => f.finding.includes("no held-out test split"))).toBe(true);
    expect(String(audit.body["scope"])).toContain("NOT the canary-contamination scan");

    const lint = await t.api(`/api/h/${id}/data/lint`, { method: "POST", body: "{}" });
    expect((lint.body["argv"] as string[])[1]).toBe("lint");
    expect(String(lint.body["note"])).toContain("canary contamination");
  });
});

describe("growth verbs", () => {
  test("mine previews by default and names the staging file, not the dataset", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const preview = await t.api(`/api/h/${id}/data/mine`, {
      method: "POST",
      body: JSON.stringify({ name: "core", dryRun: true }),
    });
    expect(preview.body["dryRun"]).toBe(true);
    expect(preview.body["job"]).toBeUndefined();
    const plan = preview.body["plan"] as { writes: string[]; reviewGate: string };
    expect(plan.writes[0]).toContain("_quarantine");
    expect(plan.reviewGate).toContain("_quarantine");

    const run = await t.api(`/api/h/${id}/data/mine`, {
      method: "POST",
      body: JSON.stringify({ name: "core", dryRun: false }),
    });
    expect(run.body["dryRun"]).toBe(false);
    expect(run.body["job"]).toBeDefined();
  });

  test("an omitted dryRun still means preview — it can never mean 'do it'", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const { body } = await t.api(`/api/h/${id}/data/synthesize`, {
      method: "POST",
      body: JSON.stringify({ name: "core" }),
    });
    expect(body["dryRun"]).toBe(true);
    expect(body["job"]).toBeUndefined();
  });

  test("refresh-goldens uses the verb's OWN preview and only writes under --apply", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const preview = await t.api(`/api/h/${id}/data/refresh-goldens`, {
      method: "POST",
      body: JSON.stringify({ name: "core", dryRun: true }),
    });
    expect((preview.body["plan"] as { argv: string[] }).argv).not.toContain("--apply");
    expect((preview.body["plan"] as { nativePreview: boolean }).nativePreview).toBe(true);

    const applied = await t.api(`/api/h/${id}/data/refresh-goldens`, {
      method: "POST",
      body: JSON.stringify({ name: "core", dryRun: false }),
    });
    expect((applied.body["plan"] as { argv: string[] }).argv).toContain("--apply");
  });

  test("a dataset name is validated before it can reach a command line", async () => {
    const t = boot();
    const id = await register(t, dataHarness(t));
    const { status } = await t.api(`/api/h/${id}/data/mine`, {
      method: "POST",
      body: JSON.stringify({ name: "core --review", dryRun: false }),
    });
    expect(status).toBe(400);
  });
});

describe("empty states", () => {
  test("a harness with no registry says so and names the verb", async () => {
    const t = boot();
    const id = await register(t, makeFixtureHarness(join(t.harnessesRoot, "bare"), {}));
    for (const path of ["data/datasets", "data/status", "data/quarantine"]) {
      const { status, body } = await t.api(`/api/h/${id}/${path}`);
      expect(`${path}:${status}`).toBe(`${path}:200`);
      expect(`${path}:${body["present"]}`).toBe(`${path}:false`);
      expect(`${path}:${typeof body["verb"]}`).toBe(`${path}:string`);
    }
  });
});
