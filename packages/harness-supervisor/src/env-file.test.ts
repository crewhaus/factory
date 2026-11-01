/**
 * The manager's two env reads, against the spawn they predict: the merged
 * env must be the record `buildSpawnPlan` hands the child, precedence and
 * stamps included, or preflight checks an environment the daemon never sees.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergedSpawnEnv, readHarnessEnvFiles } from "./env-file";
import { buildSpawnPlan } from "./spawn-contracts";

const scratch: string[] = [];
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

function harness(envLines: readonly string[], localLines?: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "env-file-"));
  scratch.push(root);
  const dir = join(root, "h");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "crewhaus.yaml"), "name: envfile\ntarget: channel\n");
  writeFileSync(join(dir, "dist", "daemon.ts"), "// bundle\n");
  writeFileSync(join(dir, ".env"), `${envLines.join("\n")}\n`);
  if (localLines !== undefined)
    writeFileSync(join(dir, ".env.local"), `${localLines.join("\n")}\n`);
  return dir;
}

describe("mergedSpawnEnv", () => {
  test("an exported variable WINS over the harness .env, as the spawn resolves it", () => {
    const dir = harness(["SHARED=from-env-file", "ONLY_FILE=file-value"]);
    const processEnv = { SHARED: "from-process", ONLY_PROCESS: "process-value" };
    const merged = mergedSpawnEnv(processEnv, dir);
    expect(merged.env["SHARED"]).toBe("from-process");
    expect(merged.env["ONLY_FILE"]).toBe("file-value");
    expect(merged.env["ONLY_PROCESS"]).toBe("process-value");
    // The stamps the spawn adds are visible to preflight too.
    expect(merged.env["CREWHAUS_TRACE"]).toBe("json");
    expect(merged.env["CREWHAUS_COST_TRACKING"]).toBe("1");
    expect(merged.envFiles).toEqual([".env"]);
  });

  test("equals the plan's own env, key for key", () => {
    const dir = harness(["SHARED=from-env-file", "ONLY_FILE=file-value"]);
    const processEnv = { SHARED: "from-process", ONLY_PROCESS: "process-value" };
    const plan = buildSpawnPlan({ harnessDir: dir, target: "channel", processEnv });
    expect(mergedSpawnEnv(processEnv, dir).env).toEqual(plan.env);
  });
});

describe("readHarnessEnvFiles", () => {
  test("folds .env then .env.local, later winning, and names the files it read", () => {
    const dir = harness(["A=env", "B=env"], ["B=local"]);
    const chain = readHarnessEnvFiles(dir);
    expect(chain.vars).toEqual({ A: "env", B: "local" });
    expect(chain.files).toEqual([".env", ".env.local"]);
  });

  test("includes a declared shared file, and reports one that is missing", () => {
    const dir = harness(["LOCAL=yes"]);
    writeFileSync(join(dir, "..", "fleet.env"), "FLEET=shared\n");
    mkdirSync(join(dir, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(dir, ".crewhaus", "settings.json"),
      JSON.stringify({ manager: { envFiles: ["../fleet.env", "../absent.env"] } }),
    );
    const chain = readHarnessEnvFiles(dir);
    expect(chain.vars).toEqual({ FLEET: "shared", LOCAL: "yes" });
    expect(chain.files).toEqual(["../fleet.env", ".env"]);
    expect(chain.refs.map((ref) => `${ref.declaredAs}:${ref.scope}:${ref.present}`)).toEqual([
      "../fleet.env:shared:true",
      "../absent.env:shared:false",
      ".env:harness:true",
    ]);
  });
});
