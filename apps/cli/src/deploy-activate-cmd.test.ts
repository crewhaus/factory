/**
 * `crewhaus deploy activate|list`, and the protected-environment gate on `deploy canary`.
 * Activation is a receipted command in the harness's own ledger; a refused gate exits 55
 * with a rejected receipt; a canary into a protected environment without a quorum moves
 * nothing and registers nothing.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  casAppend,
  deploymentsLedger,
  foldStates,
  readDeployments,
  readHarnessIdentity,
} from "@crewhaus/control-records";
import { commandsLedgerOf } from "@crewhaus/control-service";
import { buildDigest } from "@crewhaus/harness-supervisor";
import { deployActivate, deployList } from "./deploy-activate-cmd";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function harness(): { dir: string; env: Record<string, string> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deploy-activate-")));
  roots.push(root);
  const dir = join(root, "harness");
  put(dir, "crewhaus.yaml", "name: demo\ntarget: channel\n");
  put(dir, "dist/daemon.ts", "// bundle\n");
  return {
    dir,
    env: {
      CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
      CREWHAUS_HANGAR_ROOT: join(root, "hangar"),
      CREWHAUS_NO_REGISTRY: "1",
    },
  };
}

async function prepare(dir: string, id: string, specHash = `sha256:${"d".repeat(64)}`) {
  const taken = buildDigest(dir, { entry: "dist/daemon.ts" });
  if ("unreadable" in taken) throw new Error(taken.unreadable);
  await casAppend(deploymentsLedger(dir), id, null, {
    id,
    state: "prepared",
    artifact: { digest: taken.digest, specHash, entry: "dist/daemon.ts" },
  });
}

function receipts(dir: string): Record<string, unknown>[] {
  const fold = foldStates(commandsLedgerOf(dir));
  return fold.ok ? [...fold.objects.values()].map((o) => o.record as Record<string, unknown>) : [];
}

const DEP_A = "dep_01m76e6f05hp514w9j4v3qymka";
const DEP_B = "dep_01m76e6f05hp514w9j4v3qymkb";

describe("crewhaus deploy activate", () => {
  test("activates the newest prepared build through one receipt naming it", async () => {
    const { dir, env } = harness();
    await prepare(dir, DEP_A);
    await prepare(dir, DEP_B);
    const result = await deployActivate([], { cwd: dir, env });
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toContain(`activated ${DEP_B}`);
    const read = readDeployments(dir);
    expect(read.state === "present" && read.active?.["id"]).toBe(DEP_B);
    const identity = readHarnessIdentity(dir);
    if (identity.state !== "present") throw new Error("no harness.json");
    const [receipt] = receipts(dir);
    expect(receipt?.["kind"]).toBe("deployments.activate");
    expect(receipt?.["state"]).toBe("succeeded");
    expect(receipt?.["target"]).toBe(`${identity.identity.id}/deployment/${DEP_B}`);
    expect(read.state === "present" && read.active?.["cmd"]).toBe(receipt?.["id"]);
  });

  test("a refused gate exits 55 with a rejected receipt, and nothing moves", async () => {
    const { dir, env } = harness();
    await prepare(dir, DEP_A);
    put(
      dir,
      ".crewhaus/environments.json",
      JSON.stringify({ environments: { prod: { requireApproval: true } } }),
    );
    const result = await deployActivate([DEP_A, "--environment", "prod"], { cwd: dir, env });
    expect(result.exitCode).toBe(55);
    expect(result.lines.join("\n")).toContain("protected environment");
    expect(receipts(dir).map((r) => r["state"])).toEqual(["rejected"]);
    const read = readDeployments(dir);
    expect(read.state === "present" && read.active).toBeUndefined();
  });

  test("an activation that names no environment takes the active build's protected one", async () => {
    const { dir, env } = harness();
    await prepare(dir, DEP_A);
    put(
      dir,
      ".crewhaus/environments.json",
      JSON.stringify({ environments: { prod: { requireApproval: true } } }),
    );
    put(
      dir,
      ".crewhaus/approvals/demo__prod.json",
      JSON.stringify([{ approver: "a", ts: "t", specHash: `sha256:${"d".repeat(64)}` }]),
    );
    const intoProd = await deployActivate([DEP_A, "--environment", "prod"], { cwd: dir, env });
    expect(intoProd.exitCode).toBe(0);
    await prepare(dir, DEP_B, `sha256:${"e".repeat(64)}`);
    const unnamed = await deployActivate([DEP_B], { cwd: dir, env });
    expect(unnamed.exitCode).toBe(55);
    expect(unnamed.lines.join("\n")).toContain("protected environment");
    const intoStaging = await deployActivate([DEP_B, "--environment", "staging"], {
      cwd: dir,
      env,
    });
    expect(intoStaging.exitCode).toBe(55);
    const read = readDeployments(dir);
    expect(read.state === "present" && read.active?.["id"]).toBe(DEP_A);
    expect(read.state === "present" && read.active?.["environment"]).toBe("prod");
  });

  test("nothing prepared: says so and writes nothing", async () => {
    const { dir, env } = harness();
    const result = await deployActivate([], { cwd: dir, env });
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(dir, ".crewhaus"))).toBe(false);
  });

  test("an unknown flag is refused", async () => {
    const { dir, env } = harness();
    await expect(deployActivate(["--bogus"], { cwd: dir, env })).rejects.toThrow("unknown flag");
  });
});

describe("crewhaus deploy list", () => {
  test("lists newest first, as text and as JSON, and writes nothing", async () => {
    const { dir, env } = harness();
    expect(deployList([], { cwd: dir, env }).lines[0]).toContain("No deployments here yet");
    await prepare(dir, DEP_A);
    await prepare(dir, DEP_B);
    const text = deployList([], { cwd: dir, env });
    expect(text.lines[1]).toContain(DEP_B);
    expect(text.lines[2]).toContain(DEP_A);
    const json = JSON.parse(deployList(["--json"], { cwd: dir, env }).lines.join("\n")) as {
      records: Array<{ id: string }>;
    };
    expect(json.records.map((r) => r.id)).toEqual([DEP_B, DEP_A]);
    expect(existsSync(join(dir, ".crewhaus", "run", "control", "harness.json"))).toBe(false);
  });
});

describe("crewhaus deploy canary into a protected environment", () => {
  test("refuses before anything is registered", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "deploy-canary-gate-")));
    roots.push(root);
    put(
      root,
      "spec.yaml",
      "name: canary-demo\ntarget: cli\nagent:\n  model: anthropic/claude-sonnet-4\n  instructions: hi\n",
    );
    put(
      root,
      ".crewhaus/environments.json",
      JSON.stringify({ environments: { prod: { requireApproval: true } } }),
    );
    const proc = Bun.spawn(
      [
        process.execPath,
        "--no-install",
        CLI_PATH,
        "deploy",
        "canary",
        "spec.yaml",
        "v2",
        "--from",
        "v1",
        "--dataset",
        "missing.jsonl",
        "--graders",
        "missing.yaml",
      ],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          CREWHAUS_REGISTRY_ROOT: join(root, "registry"),
          CREWHAUS_NO_REGISTRY: "1",
        },
      },
    );
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited).not.toBe(0);
    expect(`${out}${err}`).toContain('to protected env "prod" is blocked');
    expect(existsSync(join(root, ".crewhaus", "specs"))).toBe(false);
  }, 60_000);
});
