/**
 * The home area through the API: each export answers its schema; the spec export is the
 * masked YAML, its first line saying so; an evaluation run's rows are the eval report's own
 * rows, read only from inside the harness's evals folder; a harness archive is written by
 * one job, at a path Home chose under its own folder, and nothing in the request reaches
 * that job's command line; the evalrun and session refs resolve; and each export asks for
 * the permission its row names.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { HOME_MODULE } from "@crewhaus/control-contract";
import { SCHEMAS } from "@crewhaus/control-contract/schemas";
import { buildExportRows, rowsToCsv, rowsToJsonl } from "@crewhaus/eval-report";
import type { JobRecord } from "@crewhaus/harness-supervisor";
import { exportHarnessArgv } from "@crewhaus/harness-supervisor/job-kinds";
import { type V1Home, v1Home } from "../__test__/v1-home";
import { HOME_AREAS, homeCompositionProblems } from "./areas";
import { SPEC_EXPORT_HEADER } from "./home";

type Schema = { safeParse(value: unknown): { success: boolean } };
const schemaOf = (id: string) => (SCHEMAS as unknown as Readonly<Record<string, Schema>>)[id];
const responseOf = (op: string) =>
  schemaOf(HOME_MODULE.operations.find((row) => row.id === op)?.response as string);

/** A value shaped like a provider key, built from parts. */
const PLANTED = ["sk", "proj", "q".repeat(32)].join("-");
const RUN = "run_00000000000000e1";

const SUMMARY = {
  runId: RUN,
  startedAt: "2026-11-18T00:00:00.000Z",
  endedAt: "2026-11-18T00:01:00.000Z",
  config: { specHash: "abc", datasetName: "smoke", model: "test/model" },
  samples: [
    {
      sampleId: "s1",
      startedAt: "2026-11-18T00:00:01.000Z",
      endedAt: "2026-11-18T00:00:02.000Z",
      latencyMs: 1000,
      grades: {
        overall: { passed: true, score: 1, rationale: "fine" },
        perGrader: [{ name: "exact", passed: true, score: 1, rationale: 'matched, "quoted"' }],
      },
    },
  ],
};

let home: V1Home;
let a: { id: string; dir: string };
const jobs: JobRecord[] = [];
let outside: string;

beforeAll(async () => {
  home = await v1Home({
    runJob: async (job) => {
      jobs.push(job);
      return await new Promise(() => {});
    },
  });
  a = await home.harness("exporter");
  appendFileSync(join(a.dir, "crewhaus.yaml"), `# provider\nOPENAI_API_KEY: ${PLANTED}\n`);
  mkdirSync(join(a.dir, ".crewhaus", "evals", RUN), { recursive: true });
  writeFileSync(join(a.dir, ".crewhaus", "evals", RUN, "results.json"), JSON.stringify(SUMMARY));
  // A run id whose folder is a link out of the harness.
  outside = mkdtempSync(join(tmpdir(), "home-export-outside-"));
  mkdirSync(join(outside, "run_00000000000000e2"), { recursive: true });
  writeFileSync(
    join(outside, "run_00000000000000e2", "results.json"),
    JSON.stringify({ ...SUMMARY, runId: "run_00000000000000e2" }),
  );
  symlinkSync(
    join(outside, "run_00000000000000e2"),
    join(a.dir, ".crewhaus", "evals", "run_00000000000000e2"),
  );
});

afterAll(async () => {
  await home?.t.stop();
  rmSync(outside, { recursive: true, force: true });
});

describe("the home area's composition", () => {
  test("Home's areas compose with no problem", () => {
    expect(homeCompositionProblems(HOME_AREAS)).toEqual([]);
  });
});

describe("exports.spec", () => {
  test("answers the masked spec, its first line saying what it is", async () => {
    const res = await home.call("GET", `/api/v1/harnesses/${a.id}/spec/export`);
    expect(res.status).toBe(200);
    expect(responseOf("exports.spec")?.safeParse(res.body).success).toBe(true);
    const text = String(res.body["text"]);
    expect(text.split("\n")[0]).toBe(SPEC_EXPORT_HEADER);
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain(PLANTED.slice(0, 16));
    expect(res.body["contentType"]).toBe("application/yaml");
    // The owner may read raw files there, so it is told where the file is.
    expect(String(res.body["note"])).toContain(join(a.dir, "crewhaus.yaml"));
  });

  test("names the real file only for a caller who may read raw files there", async () => {
    const service = await home.service("reader", [a.id], { contentRead: true });
    const res = await home.call("GET", `/api/v1/harnesses/${a.id}/spec/export`, {
      secret: service.secret,
    });
    expect(res.status).toBe(200);
    expect(res.body["note"]).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(a.dir);
  });
});

describe("exports.evalResults", () => {
  test("answers the eval report's own rows, as CSV and as JSONL", async () => {
    const rows = buildExportRows([{ summary: SUMMARY as never, specName: "exporter" }]);
    const csv = await home.call("GET", `/api/v1/harnesses/${a.id}/evalruns/${RUN}/export`);
    expect(csv.status).toBe(200);
    expect(responseOf("exports.evalResults")?.safeParse(csv.body).success).toBe(true);
    expect(csv.body["text"]).toBe(rowsToCsv(rows));
    expect(csv.body["rows"]).toBe(1);
    expect(csv.body["masked"]).toBe(true);
    const jsonl = await home.call(
      "GET",
      `/api/v1/harnesses/${a.id}/evalruns/${RUN}/export?format=jsonl`,
    );
    expect(jsonl.status).toBe(200);
    expect(jsonl.body["text"]).toBe(rowsToJsonl(rows));
    expect(jsonl.body["contentType"]).toBe("application/x-ndjson");
  });

  test("a format other than csv or jsonl is refused", async () => {
    const res = await home.call(
      "GET",
      `/api/v1/harnesses/${a.id}/evalruns/${RUN}/export?format=xlsx`,
    );
    expect(res.status).toBe(400);
  });

  test("a run that is not in the harness's evals folder, or links out of it, is not found", async () => {
    for (const run of ["run_00000000000000e3", "run_00000000000000e2"]) {
      const res = await home.call("GET", `/api/v1/harnesses/${a.id}/evalruns/${run}/export`);
      expect([run, res.status]).toEqual([run, 404]);
      expect(JSON.stringify(res.body)).not.toContain("matched");
    }
  });

  test("a caller who may not read the harness's content is refused", async () => {
    const service = await home.service("lister", [a.id]);
    const res = await home.call("GET", `/api/v1/harnesses/${a.id}/evalruns/${RUN}/export`, {
      secret: service.secret,
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain("h.read.content");
  });
});

describe("exports.harness and exports.list", () => {
  test("one job writes the archive at a path Home chose under its own folder", async () => {
    const res = await home.call("POST", `/api/v1/harnesses/${a.id}/exports`, {
      body: {},
      headers: { "Idempotency-Key": "export-one" },
    });
    expect([200, 202]).toContain(res.status);
    expect(responseOf("exports.harness")?.safeParse(res.body).success).toBe(true);
    const path = String(res.body["path"]);
    const folder = join(realpathSync(home.t.hangarRoot), "exports", a.id);
    const rel = relative(folder, realpathSync(join(path, "..")));
    expect(rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))).toBe(true);
    expect(path.endsWith(".tar.gz")).toBe(true);
    expect(String(res.body["command"])).toBe(
      `cd '${a.dir}' && crewhaus state backup --out '${path}'`,
    );
    // The receipt waits for the job; the job runs exactly the export's argv.
    const receipt = res.body["receipt"] as { id: string; state: string; kind: string };
    expect(receipt.kind).toBe("exports.harness");
    expect(receipt.state).toBe("accepted");
    const job = jobs.find((row) => row.commandId === receipt.id);
    expect(job?.argv).toEqual(exportHarnessArgv(path));
    expect(job?.kind).toBe("export-harness");
    expect(job?.harnessDir).toBe(a.dir);
    // The folder is readable only by its owner.
    if (process.platform !== "win32") {
      const { statSync } = await import("node:fs");
      expect(statSync(folder).mode & 0o777).toBe(0o700);
    }
    // The same key again names the same archive and starts nothing new.
    const before = jobs.length;
    const again = await home.call("POST", `/api/v1/harnesses/${a.id}/exports`, {
      body: {},
      headers: { "Idempotency-Key": "export-one" },
    });
    expect(again.body["path"]).toBe(path);
    expect(again.body["job"]).toBeNull();
    expect(jobs.length).toBe(before);
  });

  test("nothing in the request reaches the job's command line", async () => {
    const before = jobs.length;
    const res = await home.call("POST", `/api/v1/harnesses/${a.id}/exports`, {
      body: { out: "/tmp/elsewhere.tar.gz", argv: ["--force"] },
    });
    expect(res.status).toBe(400);
    expect(jobs.length).toBe(before);
    for (const job of jobs) {
      expect(job.argv.join(" ")).not.toContain("elsewhere");
      expect(job.argv).not.toContain("--force");
    }
  });

  test("lists the archives in Home's folder for the harness, opening none", async () => {
    const folder = join(home.t.hangarRoot, "exports", a.id);
    writeFileSync(join(folder, "01JTEST.tar.gz"), "archive bytes");
    const res = await home.call("GET", `/api/v1/harnesses/${a.id}/exports`);
    expect(res.status).toBe(200);
    expect(responseOf("exports.list")?.safeParse(res.body).success).toBe(true);
    const rows = res.body["exports"] as { name: string; bytes: number }[];
    expect(rows.find((row) => row.name === "01JTEST.tar.gz")?.bytes).toBe(13);
  });

  test("a maintainer may neither export a harness nor list its archives", async () => {
    const maintainer = await home.member("Mae", "maintainer", { scope: `harness:${a.id}` });
    const before = jobs.length;
    const post = await home.call("POST", `/api/v1/harnesses/${a.id}/exports`, {
      body: {},
      secret: maintainer.secret,
    });
    expect(post.status).toBe(403);
    expect(JSON.stringify(post.body)).toContain("h.files.raw");
    expect(jobs.length).toBe(before);
    const list = await home.call("GET", `/api/v1/harnesses/${a.id}/exports`, {
      secret: maintainer.secret,
    });
    expect(list.status).toBe(403);
  });
});

describe("the evalrun and session refs", () => {
  test("an evaluation run in the harness's evals folder resolves", async () => {
    const res = await home.call("GET", `/api/v1/refs/${a.id}/evalrun/${RUN}`);
    expect(res.status).toBe(200);
    expect(res.body["kind"]).toBe("evalrun");
    expect(res.body["href"]).toBe(`/#/i/${a.id}/evalrun/${RUN}`);
    const out = await home.call("GET", `/api/v1/refs/${a.id}/evalrun/run_00000000000000e2`);
    expect(out.status).toBe(404);
  });

  test("a session in the harness's own sessions folder resolves", async () => {
    const sess = "sess_00000000000000e9";
    const root = join(a.dir, ".crewhaus", "sessions");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${sess}.json`), JSON.stringify({ lastTurnIndex: 4 }));
    const res = await home.call("GET", `/api/v1/refs/${a.id}/session/${sess}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "session", rev: "4", summary: "A conversation" });
    const none = await home.call("GET", `/api/v1/refs/${a.id}/session/sess_00000000000000ea`);
    expect(none.status).toBe(404);
    expect(existsSync(join(root, "sess_00000000000000ea.json"))).toBe(false);
    expect(readFileSync(join(root, `${sess}.json`), "utf8")).toContain("lastTurnIndex");
  });
});

// ---------------------------------------------------------------------------
// Home's own reads: its status line, this period's spend, and who works on a harness
// ---------------------------------------------------------------------------

describe("Home's own reads", () => {
  const PERIOD = "budget:\n  usd: 5\n  period: {every: month, usd: 10}";
  let reads: V1Home;
  let spendA: { id: string; dir: string };
  let spendB: { id: string; dir: string };
  let unpriced: { id: string; dir: string };
  let opal: { principal: string; secret: string };

  beforeAll(async () => {
    const { append } = await import("@crewhaus/control-records");
    const { budgetLedger, periodOf } = await import("@crewhaus/control-records/budget");
    reads = await v1Home();
    spendA = await reads.harness("spend-a", { specExtra: PERIOD });
    spendB = await reads.harness("spend-b", { specExtra: PERIOD });
    unpriced = await reads.harness("spend-unpriced", { specExtra: PERIOD });
    const periodId = periodOf({ every: "month", usdMicros: 10_000_000 }, Date.now()).periodId;
    const at = new Date().toISOString();
    const settle = (dir: string, usdMicros: number | null, extra: Record<string, unknown> = {}) => {
      const written = append(budgetLedger(dir, periodId), {
        v: 1,
        at,
        op: "settle",
        id: `res_${Math.random().toString(16).slice(2, 10)}`,
        usdMicros,
        ...extra,
      });
      if (!written.ok) throw new Error(written.reason);
    };
    settle(spendA.dir, 2_000_000);
    settle(spendB.dir, 7_000_000);
    settle(unpriced.dir, null, { unpriced: true });
    opal = await reads.member("Opal", "operator", { scope: `harness:${spendA.id}` });
  }, 60_000);

  afterAll(async () => {
    await reads?.t.stop();
  });

  test("home.status answers every field the status line reads", async () => {
    const res = await reads.call("GET", "/api/v1/home/status");
    expect(res.status).toBe(200);
    expect(responseOf("home.status")?.safeParse(res.body).success).toBe(true);
    const host = res.body["host"] as Record<string, unknown>;
    expect(host["reachedBy"]).toBe("loopback");
    expect(host["loopback"]).toBe(true);
    expect(typeof host["name"]).toBe("string");
    expect(res.body["service"]).toEqual({ installed: "unknown" });
    const counts = res.body["counts"] as Record<string, number>;
    for (const field of ["harnesses", "needsYou", "working", "paused", "notResponding"]) {
      expect(`${field} ${typeof counts[field]}`).toBe(`${field} number`);
    }
    expect(counts["harnesses"]).toBe(3);
    expect(counts["waitingForBudget"]).toBe(0);
  });

  test("home.status counts only the harnesses the caller may read, and a harness waiting for budget", async () => {
    const { controlPaths } = await import("@crewhaus/control-records");
    const { periodOf } = await import("@crewhaus/control-records/budget");
    const periodId = periodOf({ every: "month", usdMicros: 10_000_000 }, Date.now()).periodId;
    const file = join(spendB.dir, controlPaths(spendB.dir).budgetStateFile);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({
        v: 1,
        periodId,
        exhaustedAt: new Date().toISOString(),
        renewsAt: new Date(Date.now() + 86_400_000).toISOString(),
      })}\n`,
    );
    try {
      const owner = await reads.call("GET", "/api/v1/home/status");
      expect((owner.body["counts"] as Record<string, number>)["waitingForBudget"]).toBe(1);
      const operator = await reads.call("GET", "/api/v1/home/status", { secret: opal.secret });
      expect(operator.status).toBe(200);
      const counts = operator.body["counts"] as Record<string, number>;
      expect(counts["harnesses"]).toBe(1);
      expect(counts["waitingForBudget"]).toBe(0);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("home.spend adds up only the harnesses the caller may read; unknown cost is never $0", async () => {
    const owner = await reads.call("GET", "/api/v1/spend");
    expect(owner.status).toBe(200);
    expect(responseOf("home.spend")?.safeParse(owner.body).success).toBe(true);
    const rows = owner.body["rows"] as Record<string, unknown>[];
    expect(rows.map((r) => r["harness"]).sort()).toEqual(
      [spendA.id, spendB.id, unpriced.id].sort(),
    );
    const unknownRow = rows.find((r) => r["harness"] === unpriced.id);
    expect(unknownRow?.["unknownCalls"]).toBe(1);
    expect(unknownRow?.["spentUsdMicros"]).toBe(0);
    const totals = owner.body["totals"] as Record<string, unknown>;
    expect(totals["spentUsdMicros"]).toBe(9_000_000);
    expect(totals["unknownCalls"]).toBe(1);
    expect(totals["lowerBound"]).toBe(true);
    for (const row of rows) {
      for (const field of ["harness", "name", "present", "note", "verb"]) {
        expect(`${field} ${field in row}`).toBe(`${field} true`);
      }
      expect(row["capUsdMicros"]).toBe(10_000_000);
      expect(typeof row["renewsAt"]).toBe("string");
    }
    // An operator on A only: B's spend changes no total.
    const operator = await reads.call("GET", "/api/v1/spend", { secret: opal.secret });
    expect(operator.status).toBe(200);
    expect((operator.body["rows"] as Record<string, unknown>[]).map((r) => r["harness"])).toEqual([
      spendA.id,
    ]);
    const mine = operator.body["totals"] as Record<string, unknown>;
    expect(mine["spentUsdMicros"]).toBe(2_000_000);
    expect(mine["harnesses"]).toBe(1);
    expect(mine["lowerBound"]).toBeUndefined();
  });

  test("home.harnessAccess names who may work on the harness, and asks for h.access.view", async () => {
    const res = await reads.call("GET", `/api/v1/harnesses/${spendA.id}/access`);
    expect(res.status).toBe(200);
    expect(responseOf("home.harnessAccess")?.safeParse(res.body).success).toBe(true);
    const members = res.body["members"] as Record<string, unknown>[];
    const named = members.find((m) => m["principal"] === opal.principal);
    expect(named?.["name"]).toBe("Opal");
    expect(named?.["grants"]).toEqual([{ role: "operator", scope: "harness" }]);
    expect(members.some((m) => m["principal"] === reads.owner)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("subjectRef");
    const other = await reads.call("GET", `/api/v1/harnesses/${spendB.id}/access`);
    expect(
      (other.body["members"] as Record<string, unknown>[]).some(
        (m) => m["principal"] === opal.principal,
      ),
    ).toBe(false);
    const refused = await reads.call("GET", `/api/v1/harnesses/${spendA.id}/access`, {
      secret: opal.secret,
    });
    expect(refused.status).toBe(403);
    expect((refused.body["error"] as Record<string, unknown>)["needs"]).toBe("h.access.view");
  });
});
