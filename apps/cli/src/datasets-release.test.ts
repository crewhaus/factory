import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileBackedRegistry } from "@crewhaus/dataset-registry";
import type { RunIndexEntry } from "@crewhaus/eval-report";
import { recordRelease } from "./datasets-release";

const TMP_ROOTS: string[] = [];
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

const entry = (overrides: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId: "run_a",
  specName: "shop",
  specHash: "h",
  datasetName: "smoke@1.0.0#test",
  datasetHash: "d",
  passRate: 1,
  meanScore: 1,
  sampleCount: 2,
  ts: "2026-11-01T00:00:00.000Z",
  outDir: "/gone",
  ...overrides,
});

/** A registered dataset version, written by the real registry. */
async function registry(): Promise<{ rootDir: string; path: string }> {
  const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-release-"));
  TMP_ROOTS.push(rootDir);
  const put = createFileBackedRegistry({ rootDir });
  await put.put(
    { name: "smoke", version: "1.0.0", splits: { train: [], dev: [], test: [] } },
    { force: true },
  );
  return { rootDir, path: join(rootDir, "smoke", "1.0.0.json") };
}

const releases = (path: string): unknown[] =>
  (JSON.parse(readFileSync(path, "utf8")) as { releases?: unknown[] }).releases ?? [];

describe("recordRelease", () => {
  test("a clean run appends one release", async () => {
    const { rootDir, path } = await registry();
    const outcome = recordRelease({ entry: entry(), rootDir, name: "smoke", version: "1.0.0" });
    expect(outcome.ok).toBe(true);
    expect(releases(path)).toEqual([
      { version: "1.0.0", runId: "run_a", ts: entry().ts, passRate: 1 },
    ]);
  });

  test("a budget-aborted run is refused, and nothing is appended", async () => {
    const { rootDir, path } = await registry();
    const outcome = recordRelease({
      entry: entry({ partial: true }),
      rootDir,
      name: "smoke",
      version: "1.0.0",
    });
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("partial (budget-aborted)");
    expect(releases(path)).toEqual([]);
  });

  test("a run in which every case errored is refused, and nothing is appended", async () => {
    const { rootDir, path } = await registry();
    const outcome = recordRelease({
      entry: entry({ errorCount: 2, measuredCount: 0 }),
      rootDir,
      name: "smoke",
      version: "1.0.0",
    });
    expect(outcome).toMatchObject({ ok: false });
    if (!outcome.ok) expect(outcome.reason).toContain("every case errored");
    expect(releases(path)).toEqual([]);
  });
});

test("the CLI records a release only through this", () => {
  const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  expect(source.split("recordRelease(").length - 1).toBe(1);
  expect(source.split("appendReleaseEntry(").length - 1).toBe(0);
});
