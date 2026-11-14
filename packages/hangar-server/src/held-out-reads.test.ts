/**
 * Home's reads are inspection, never consumption: every GET of the data and eval
 * areas over a harness whose dataset has a holdout, and a counted held-out read,
 * leaves every `*.uses.jsonl` byte-identical. The dataset views count each split's
 * reads, and return the holdout's size and provenance, never a row or an id.
 */
import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HELD_OUT_USES_READ_CAP,
  createFileBackedRegistry,
  heldOutUsesPath,
  recordHeldOutUse,
} from "@crewhaus/dataset-registry";
import { makeFixtureHarness } from "./fixture";
import { ROUTE_TABLE } from "./route-table";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

function usesFiles(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (file.endsWith(".uses.jsonl")) out.set(join(name, file), readFileSync(join(dir, file)));
    }
  }
  return out;
}

test("every data and eval GET leaves the use ledgers as they were", async () => {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  const dir = makeFixtureHarness(join(t.harnessesRoot, "held"), { specName: "held" });
  const root = join(dir, ".crewhaus", "datasets");
  const reg = createFileBackedRegistry({ rootDir: root });
  await reg.put({
    name: "core",
    version: "v1",
    splits: {
      train: [{ id: "a", input: "a", metadata: { source: "human_authored" } }],
      dev: [{ id: "b", input: "b" }],
      test: [{ id: "t", input: "t" }],
      holdout: [{ id: "held-out-row", input: "h", metadata: { source: "human_authored" } }],
    },
  });
  recordHeldOutUse({
    rootDir: root,
    name: "core",
    version: "v1",
    split: "test",
    purpose: "eval",
    via: "cli",
  });
  recordHeldOutUse({
    rootDir: root,
    name: "core",
    version: "v1",
    split: "holdout",
    purpose: "promotion",
    via: "cli",
  });
  const { body } = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  const id = (body["entry"] as { id: string }).id;
  const before = usesFiles(root);
  expect(before.size).toBe(1);

  const params: Record<string, string> = {
    id,
    runId: "run_0000000000000001",
    sampleId: "a",
    cell: "c",
    optRunId: "opt_1",
    name: "core",
  };
  const rows = ROUTE_TABLE.filter(
    (r) => r.method === "GET" && /^\/api\/h\/:id\/(data|evals)(\/|$)/.test(r.path),
  );
  let walked = 0;
  for (const row of rows) {
    const path = row.path.replace(/:([A-Za-z]+)/g, (_m, key: string) => params[key] ?? key);
    await t.api(path);
    walked++;
  }
  expect(walked).toBe(rows.length);
  expect(walked).toBeGreaterThanOrEqual(20);
  const after = usesFiles(root);
  expect([...after.keys()]).toEqual([...before.keys()]);
  for (const [file, bytes] of before) expect(after.get(file)?.equals(bytes)).toBe(true);

  // The registry views count the reads per split, and name no holdout row.
  const list = await t.api(`/api/h/${id}/data/datasets`);
  const core = (list.body["datasets"] as Array<Record<string, unknown>>).find(
    (r) => r["name"] === "core",
  );
  expect(core?.["splits"]).toEqual({ train: 1, dev: 1, test: 1, holdout: 1 });
  expect(core?.["testSplitBurn"]).toBe(1);
  const detail = await t.api(`/api/h/${id}/data/datasets/core`);
  const version = (
    detail.body["versions"] as Array<{ burn: { count: number; holdout: number } }>
  )[0];
  expect(version?.burn).toMatchObject({ count: 1, holdout: 1 });
  expect(JSON.stringify(list.body)).not.toContain("held-out-row");
  expect(JSON.stringify(detail.body)).not.toContain("held-out-row");
});

test("a use ledger that could not be read whole answers its counts as unknown, with a note", async () => {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  const dir = makeFixtureHarness(join(t.harnessesRoot, "long"), { specName: "long" });
  const root = join(dir, ".crewhaus", "datasets");
  const reg = createFileBackedRegistry({ rootDir: root });
  await reg.put({
    name: "core",
    version: "v1",
    splits: {
      train: [{ id: "a", input: "a" }],
      dev: [{ id: "b", input: "b" }],
      test: [{ id: "t", input: "t" }],
    },
  });
  const line = `${JSON.stringify({ v: 1, at: "2026-08-01T00:00:00Z", split: "test", purpose: "eval", via: "cli" })}\n`;
  appendFileSync(heldOutUsesPath(root, "core", "v1"), line.repeat(HELD_OUT_USES_READ_CAP + 1));
  const { body } = await t.api("/api/harnesses", { method: "POST", body: JSON.stringify({ dir }) });
  const id = (body["entry"] as { id: string }).id;

  const list = await t.api(`/api/h/${id}/data/datasets`);
  const core = (list.body["datasets"] as Array<Record<string, unknown>>).find(
    (r) => r["name"] === "core",
  );
  expect(core).toBeDefined();
  expect(core?.["testSplitBurn"]).toBeNull();
  const detail = await t.api(`/api/h/${id}/data/datasets/core`);
  const version = (detail.body["versions"] as Array<{ burn: Record<string, unknown> }>)[0];
  expect(version?.burn["count"]).toBeNull();
  expect(version?.burn["holdout"]).toBeNull();
  expect(version?.burn["note"]).toBe(
    "the use ledger could not be read whole; the count is unknown",
  );
}, 20_000); // writes ten thousand ledger lines and boots a server

test("a use ledger linked to a file outside the harness answers its counts as unknown", async () => {
  const t = bootTestServer({ now: () => NOW });
  servers.push(t);
  const dir = makeFixtureHarness(join(t.harnessesRoot, "linked"), { specName: "linked" });
  const root = join(dir, ".crewhaus", "datasets");
  const reg = createFileBackedRegistry({ rootDir: root });
  await reg.put({
    name: "core",
    version: "v1",
    splits: {
      train: [{ id: "a", input: "a" }],
      dev: [{ id: "b", input: "b" }],
      test: [{ id: "t", input: "t" }],
    },
  });
  const outside = mkdtempSync(join(tmpdir(), "held-out-ledger-"));
  try {
    const target = join(outside, "v1.uses.jsonl");
    const line = `${JSON.stringify({ v: 1, at: "2026-08-01T00:00:00Z", split: "test", purpose: "eval", via: "cli" })}\n`;
    writeFileSync(target, line);
    symlinkSync(target, heldOutUsesPath(root, "core", "v1"));
    const { body } = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    const id = (body["entry"] as { id: string }).id;

    const list = await t.api(`/api/h/${id}/data/datasets`);
    const core = (list.body["datasets"] as Array<Record<string, unknown>>).find(
      (r) => r["name"] === "core",
    );
    expect(core).toBeDefined();
    expect(core?.["testSplitBurn"]).toBeNull();
    const detail = await t.api(`/api/h/${id}/data/datasets/core`);
    const version = (detail.body["versions"] as Array<{ burn: Record<string, unknown> }>)[0];
    expect(version?.burn["count"]).toBeNull();
    expect(version?.burn["holdout"]).toBeNull();
    expect(version?.burn["note"]).toBe(
      "the use ledger could not be read whole; the count is unknown",
    );
    expect(readFileSync(target, "utf8")).toBe(line);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
