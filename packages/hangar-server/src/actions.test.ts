/**
 * The baseline re-pin face: eval-report's refusals reach the operator as a
 * rejection with its reason, never as a 500 "internal error"; a pin that
 * changes a protected criterion is made only by a caller the authorizer allows,
 * and names them.
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
import { type PinBaselineAuthorizer, pinBaseline } from "./actions";

const ROOTS: string[] = [];
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = "run_0123456789abcdef";
const allowed: PinBaselineAuthorizer = () => ({ allow: true });

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
    const result = pinBaseline({
      harnessDir: dir,
      runId: RUN_ID,
      nowIso: "2026-09-26T00:00:00Z",
      authorize: allowed,
    });
    expect(result.outcome).toBe("rejected");
    expect(result.outcome === "rejected" ? result.reason : "").toContain("symbolic link");
    expect(readFileSync(join(dir, "shared", "baselines.json"), "utf8")).toBe("{}\n");
    expect(readlinkSync(link)).toBe(join(dir, "shared", "baselines.json"));
  });

  test("a plain harness still pins", () => {
    const dir = harness();
    const result = pinBaseline({
      harnessDir: dir,
      runId: RUN_ID,
      nowIso: "2026-09-26T00:00:00Z",
      authorize: allowed,
    });
    expect(result.outcome === "ok" ? result.baseline.runId : result.reason).toBe(RUN_ID);
  });
});

describe("pinBaseline over a changed protected criterion", () => {
  const OLD = "run_00000000000000e1";
  const NEW = "run_00000000000000e2";

  /** A harness whose pinned run was measured with protected criterion `dates` at `d1`. */
  function guarded(nextDigest = "d2"): { readonly dir: string; readonly pins: string } {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "hangar-actions-guarded-")));
    ROOTS.push(dir);
    const evalsDir = join(dir, ".crewhaus", "evals");
    mkdirSync(evalsDir, { recursive: true });
    const row = (runId: string, digest: string) => ({
      runId,
      specName: "guarded",
      specHash: "h",
      datasetName: "smoke",
      datasetHash: "d",
      passRate: 1,
      meanScore: 1,
      sampleCount: 1,
      protectedCriteria: [{ id: "dates", digest }],
      ts: "2026-11-01T00:00:00.000Z",
      outDir: join(evalsDir, runId),
    });
    const old = row(OLD, "d1");
    writeFileSync(
      join(evalsDir, "index.jsonl"),
      `${JSON.stringify(old)}\n${JSON.stringify(row(NEW, nextDigest))}\n`,
    );
    const { passRate: _p, meanScore: _m, sampleCount: _n, specHash: _h, ...pin } = old;
    const pins = JSON.stringify({ "guarded::smoke": pin });
    writeFileSync(join(evalsDir, "baselines.json"), pins);
    return { dir, pins };
  }
  const pinsOf = (dir: string) =>
    readFileSync(join(dir, ".crewhaus", "evals", "baselines.json"), "utf8");
  const pin = (dir: string, authorize: PinBaselineAuthorizer, confirmName?: string) =>
    pinBaseline({
      harnessDir: dir,
      runId: NEW,
      nowIso: "2026-11-02T00:00:00Z",
      authorize,
      ...(confirmName !== undefined ? { confirmName } : {}),
    });

  test("a caller the authorizer refuses is forbidden, with or without the typed name, and nothing is written", () => {
    const { dir, pins } = guarded();
    for (const confirmName of [undefined, "guarded"]) {
      const result = pin(dir, () => ({ allow: false }), confirmName);
      expect(result.outcome).toBe("forbidden");
      expect(result.outcome === "forbidden" ? result.reason : "").toContain(
        "security edit permission",
      );
      expect(pinsOf(dir)).toBe(pins);
    }
  });

  test("an allowed caller confirms with the spec's name, and the pin names them", () => {
    const { dir, pins } = guarded();
    const owner: PinBaselineAuthorizer = () => ({ allow: true, principal: "prn_owner" });
    const asked = pin(dir, owner);
    expect(asked.outcome).toBe("needs_owner");
    expect(asked.outcome === "needs_owner" ? asked.confirmName : "").toBe("guarded");
    expect(pinsOf(dir)).toBe(pins);
    const wrong = pin(dir, owner, "other");
    expect(wrong.outcome).toBe("needs_owner");
    expect(pinsOf(dir)).toBe(pins);
    const done = pin(dir, owner, "guarded");
    expect(done.outcome).toBe("ok");
    expect(done.outcome === "ok" ? done.baseline.rebaselined : undefined).toEqual({
      from: OLD,
      reason: "manual",
      cmd: "hangar",
      protectedChange: true,
      by: "prn_owner",
    });
  });

  test("a pin that changes no protected criterion never asks the authorizer", () => {
    const { dir } = guarded("d1");
    let asked = 0;
    const result = pin(dir, () => {
      asked += 1;
      return { allow: false };
    });
    expect(result.outcome === "ok" ? result.baseline.runId : result.outcome).toBe(NEW);
    expect(asked).toBe(0);
  });

  test("a later row of the pinned run that records another protected digest is the owner's too", () => {
    const { dir, pins } = guarded();
    const evalsDir = join(dir, ".crewhaus", "evals");
    // The pinned run, recorded again with a moved digest: its newest row is the one pinned.
    const index = readFileSync(join(evalsDir, "index.jsonl"), "utf8");
    const pinned = JSON.parse(index.split("\n")[0] as string) as Record<string, unknown>;
    writeFileSync(
      join(evalsDir, "index.jsonl"),
      `${index}${JSON.stringify({ ...pinned, protectedCriteria: [{ id: "dates", digest: "d3" }] })}\n`,
    );
    let asked = 0;
    for (const confirmName of [undefined, "guarded"]) {
      const result = pinBaseline({
        harnessDir: dir,
        runId: OLD,
        nowIso: "2026-11-02T00:00:00Z",
        authorize: () => {
          asked += 1;
          return { allow: false };
        },
        ...(confirmName !== undefined ? { confirmName } : {}),
      });
      expect(result.outcome).toBe("forbidden");
      expect(pinsOf(dir)).toBe(pins);
    }
    expect(asked).toBe(2);
  });
});
