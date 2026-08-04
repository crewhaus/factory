/**
 * The pin on spawn-env precedence.
 *
 * M1's `mergedSpawnEnv` layered the harness `.env` chain ON TOP of the
 * manager's process env, while the actual spawn (`buildSpawnPlan`) layers it
 * UNDERNEATH. Preflight therefore evaluated an environment the daemon would
 * never see — "passed preflight, died on a missing key", inverted: passed on
 * a value that gets overwritten. These tests fail if the two ever diverge
 * again, in EITHER direction.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpawnPlan } from "@crewhaus/harness-supervisor";
import { mergedSpawnEnv } from "./env-file";
import { makeFixtureHarness } from "./fixture";

function harness(envLines: readonly string[]): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "hangar-envprec-"));
  const dir = makeFixtureHarness(join(root, "h"), { specName: "envprec", envLines });
  // A bundle so `buildSpawnPlan` can produce a plan for the comparison.
  writeFileSync(join(dir, "crewhaus.yaml"), "name: envprec\ntarget: channel\n");
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("spawn env precedence", () => {
  test("an exported variable WINS over the harness .env — the same way the spawn resolves it", () => {
    const { dir, cleanup } = harness(["SHARED=from-env-file", "ONLY_FILE=file-value"]);
    try {
      const processEnv = { SHARED: "from-process", ONLY_PROCESS: "process-value" };
      const merged = mergedSpawnEnv(processEnv, dir).env;

      expect(merged["SHARED"]).toBe("from-process");
      expect(merged["ONLY_FILE"]).toBe("file-value");
      expect(merged["ONLY_PROCESS"]).toBe("process-value");
    } finally {
      cleanup();
    }
  });

  test("mergedSpawnEnv equals the plan's own env for every key the chain and the process share", () => {
    const { dir, cleanup } = harness(["SHARED=from-env-file", "ONLY_FILE=file-value"]);
    try {
      const processEnv = { SHARED: "from-process", ONLY_PROCESS: "process-value" };
      const merged = mergedSpawnEnv(processEnv, dir).env;
      // The plan is the authority: preflight must predict THIS record.
      const planEnv = buildSpawnPlan({
        harnessDir: dir,
        target: "channel",
        processEnv,
        bundle: {
          bundleDir: join(dir, "dist"),
          entry: "daemon.ts",
          entryPath: join(dir, "dist", "daemon.ts"),
        },
      }).env;

      for (const key of ["SHARED", "ONLY_FILE", "ONLY_PROCESS"]) {
        expect(`${key}=${merged[key]}`).toBe(`${key}=${planEnv[key]}`);
      }
    } finally {
      cleanup();
    }
  });

  test("the trace + cost stamps the spawn adds are visible to preflight too", () => {
    const { dir, cleanup } = harness([]);
    try {
      const merged = mergedSpawnEnv({}, dir).env;
      // Not cosmetic: a preflight lint that keys on CREWHAUS_TRACE must see
      // what the daemon will see, not the manager's own unstamped env.
      expect(merged["CREWHAUS_TRACE"]).toBe("json");
      expect(merged["CREWHAUS_COST_TRACKING"]).toBe("1");
    } finally {
      cleanup();
    }
  });

  test("envFiles still report which chain files existed", () => {
    const { dir, cleanup } = harness(["A=1"]);
    try {
      expect(mergedSpawnEnv({}, dir).envFiles).toEqual([".env"]);
    } finally {
      cleanup();
    }
  });
});
