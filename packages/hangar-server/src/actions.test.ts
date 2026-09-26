/**
 * The baseline re-pin face: eval-report's refusals reach the operator as a
 * rejection with its reason, never as a 500 "internal error".
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinBaseline } from "./actions";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = "run_0123456789abcdef";

function harness(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hangar-actions-")));
  ROOTS.push(dir);
  mkdirSync(join(dir, ".crewhaus", "evals"), { recursive: true });
  const run = {
    runId: RUN_ID,
    specName: "s",
    specHash: "h",
    datasetName: "d",
    datasetHash: "x",
    outDir: "/o",
    ts: "2026-01-01T00:00:00.000Z",
    passRate: 1,
    meanScore: 1,
    sampleCount: 1,
  };
  writeFileSync(join(dir, ".crewhaus", "evals", "index.jsonl"), `${JSON.stringify(run)}\n`);
  return dir;
}

describe("pinBaseline", () => {
  test("a linked baselines.json is a rejection that says why, and the link's target is untouched", () => {
    const dir = harness();
    mkdirSync(join(dir, "shared"));
    writeFileSync(join(dir, "shared", "baselines.json"), "{}\n");
    const link = join(dir, ".crewhaus", "evals", "baselines.json");
    symlinkSync(join(dir, "shared", "baselines.json"), link);
    const result = pinBaseline({ harnessDir: dir, runId: RUN_ID, nowIso: "2026-09-26T00:00:00Z" });
    expect(result.outcome).toBe("rejected");
    expect(result.outcome === "rejected" ? result.reason : "").toContain("symbolic link");
    expect(readFileSync(join(dir, "shared", "baselines.json"), "utf8")).toBe("{}\n");
    expect(readlinkSync(link)).toBe(join(dir, "shared", "baselines.json"));
  });

  test("a plain harness still pins", () => {
    const dir = harness();
    const result = pinBaseline({ harnessDir: dir, runId: RUN_ID, nowIso: "2026-09-26T00:00:00Z" });
    expect(result.outcome === "ok" ? result.baseline.runId : result.reason).toBe(RUN_ID);
  });
});
