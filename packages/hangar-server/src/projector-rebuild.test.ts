/**
 * Home's read models are rebuilt from records: every composed projection, written by the
 * projector, answers the same as one written again after `cache/index/` is deleted; no
 * read writes one; a fresh projection costs a read no ledger segment; and a pass with
 * nothing new writes nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Dirent, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mintRunId } from "@crewhaus/control-contract";
import { _setIoTapForTest, append, runsLedger } from "@crewhaus/control-records";
import { projectOnce, readProjection } from "@crewhaus/control-service";
import { type V1Home, v1Home } from "./__test__/v1-home";
import { HOME_AREAS, projectionsOf } from "./v1/areas";

let home: V1Home;
const harnesses: Array<{ id: string; dir: string }> = [];
const PROJECTIONS = projectionsOf(HOME_AREAS).map((row) => row.projection);

beforeAll(async () => {
  home = await v1Home();
  for (let i = 0; i < 20; i++) {
    const h = await home.harness(`fleet-${String(i).padStart(2, "0")}`);
    const run = mintRunId();
    append(runsLedger(h.dir), { id: run, state: "queued", at: new Date().toISOString() });
    append(runsLedger(h.dir), { id: run, state: "running", at: new Date().toISOString() });
    harnesses.push(h);
  }
}, 60_000);

afterAll(async () => {
  _setIoTapForTest(undefined);
  await home?.t.stop();
});

function treeBytes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.set(path, readFileSync(path, "latin1"));
    }
  };
  walk(dir);
  return out;
}

const index = () => join(home.t.hangarRoot, "cache", "index");
const project = () =>
  projectOnce({
    hangarRoot: home.t.hangarRoot,
    harnesses,
    projections: PROJECTIONS,
    now: Date.now(),
  });

/** Every answer a read model feeds, with the time it was asked left out. */
async function answers() {
  const strip = (body: Record<string, unknown>) => {
    const { asOf: _asOf, ...rest } = body;
    const items = (rest["items"] as Record<string, unknown>[] | undefined)?.map((item) => {
      const { asOf: _at, ...kept } = item;
      return kept;
    });
    return items === undefined ? rest : { ...rest, items };
  };
  const list = await home.call("GET", "/api/v1/harnesses?limit=50");
  const one = await home.call("GET", `/api/v1/harnesses/${harnesses[0]?.id}`);
  const runs = await home.call("GET", `/api/v1/harnesses/${harnesses[0]?.id}/runs`);
  return { list: strip(list.body), one: strip(one.body), runs: strip(runs.body) };
}

/** Each projection of each harness, without when it was written. */
function saved() {
  const out: Record<string, unknown> = {};
  for (const h of harnesses) {
    for (const projection of PROJECTIONS) {
      const read = readProjection(home.t.hangarRoot, h.id, projection.name);
      out[`${h.id}/${projection.name}`] =
        read.state === "present" ? { cursor: read.file.cursor, state: read.file.state } : read;
    }
  }
  return out;
}

describe("the read models", () => {
  test("no read creates cache/index, or changes a harness's records", async () => {
    rmSync(join(home.t.hangarRoot, "cache"), { recursive: true, force: true });
    // Sign-in keeps its own usage record per request; everything else stays as it was.
    const tree = () => {
      const all = treeBytes(home.t.hangarRoot);
      for (const path of [...all.keys()]) {
        if (path.startsWith(join(home.t.hangarRoot, "access"))) all.delete(path);
      }
      for (const h of harnesses) for (const [path, bytes] of treeBytes(h.dir)) all.set(path, bytes);
      return all;
    };
    const before = tree();
    await answers();
    expect(existsSync(index())).toBe(false);
    expect(tree()).toEqual(before);
  });

  test("every composed projection rebuilt from records answers the same, apart from when", async () => {
    expect(PROJECTIONS.map((p) => p.name).sort()).toEqual(["attention", "overview", "runs"]);
    await project();
    const first = { answers: await answers(), saved: saved() };
    expect((first.answers.list["items"] as Record<string, unknown>[])[0]?.["freshness"]).toBe(
      "projection",
    );
    rmSync(index(), { recursive: true, force: true });
    await project();
    const again = { answers: await answers(), saved: saved() };
    expect(again).toEqual(first);
    for (const value of Object.values(first.saved)) {
      expect((value as { state?: unknown }).state).toBeDefined();
    }
  });

  test("a fresh projection costs harnesses.list no ledger segment; with none it reads a bounded number", async () => {
    await project();
    const opened: string[] = [];
    _setIoTapForTest({ open: (given) => opened.push(given) });
    try {
      const fresh = await home.call("GET", "/api/v1/harnesses?limit=50");
      const listed = (fresh.body["items"] as unknown[]).length;
      expect(listed).toBeGreaterThanOrEqual(20);
      // Parked tool approvals are counted from the approvals file at read time, once per
      // row, as on every other surface; no ledger segment is opened.
      const isApprovals = (given: string): boolean => given.endsWith("approvals.jsonl");
      expect(opened.filter((given) => given.endsWith(".jsonl") && !isApprovals(given))).toEqual([]);
      expect(opened.filter(isApprovals)).toHaveLength(listed);
      opened.length = 0;
      rmSync(index(), { recursive: true, force: true });
      const folded = await home.call("GET", "/api/v1/harnesses?limit=50");
      const items = folded.body["items"] as Record<string, unknown>[];
      expect(items.every((item) => item["freshness"] === "direct-fold")).toBe(true);
      const segments = opened.filter((given) => given.endsWith(".jsonl"));
      expect(segments.length).toBeGreaterThan(0);
      // At most each of the overview's four sources' files and the inbox's own four (its
      // two ledgers, the approvals file and the review queue), once per harness, and the
      // approvals file once more for its count.
      expect(segments.length).toBeLessThanOrEqual(items.length * 9);
    } finally {
      _setIoTapForTest(undefined);
    }
  });

  test("an unchanged second pass writes no projection and appends no fleet line", async () => {
    await project();
    const before = treeBytes(index());
    const report = await project();
    expect(report).toMatchObject({ written: [], appended: 0, failed: [] });
    expect(treeBytes(index())).toEqual(before);
  });

  test("Home's tick runs the projector", async () => {
    rmSync(index(), { recursive: true, force: true });
    const report = await home.t.server.scheduler.tick();
    expect(report.ran).toContain("projector");
    expect(existsSync(join(index(), harnesses[0]?.id as string, "overview.json"))).toBe(true);
  });
});
