/**
 * The protected-environment gate on the two tools that move a pin. Each test builds a
 * throwaway workspace and chdir's into it (the containment root is `process.cwd()`), and
 * asserts what is on disk after the call, with the refusal's code and reason.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { specRevision } from "@crewhaus/ir/policy";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { deployRollback, specPin } from "./index";
import { MANIFEST_FILENAME } from "./lib/registry";

const originalCwd = process.cwd();
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "crewhaus-tool-deploy-gate-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

async function call(tool: RegisteredTool, input: unknown): Promise<Json> {
  return JSON.parse(String(await tool.execute(input as never))) as Json;
}

const manifestPath = (): string => path.join(tmp, ".crewhaus/specs/demo", MANIFEST_FILENAME);

function onDisk(): { versions: string[]; pins: Record<string, string> } {
  if (!existsSync(manifestPath())) return { versions: [], pins: {} };
  return JSON.parse(readFileSync(manifestPath(), "utf8")) as {
    versions: string[];
    pins: Record<string, string>;
  };
}

function protect(env: string): void {
  mkdirSync(path.join(tmp, ".crewhaus"), { recursive: true });
  writeFileSync(
    path.join(tmp, ".crewhaus/environments.json"),
    JSON.stringify({ environments: { [env]: { requireApproval: true } } }),
  );
}

function approve(env: string, records: unknown[]): void {
  mkdirSync(path.join(tmp, ".crewhaus/approvals"), { recursive: true });
  writeFileSync(path.join(tmp, `.crewhaus/approvals/demo__${env}.json`), JSON.stringify(records));
}

const A = "name: demo\ntarget: cli\n# a\n";
const B = "name: demo\ntarget: cli\n# b\n";

test("SpecPin into a protected environment without a quorum refuses and registers nothing", async () => {
  protect("prod");
  approve("prod", [{ approver: "alice", ts: "t" }]);
  writeFileSync(path.join(tmp, "spec.yaml"), A);
  const r = await call(specPin, { name: "demo", specFile: "spec.yaml", env: "prod" });
  expect(r["status"]).toBe("refused");
  expect(r["code"]).toBe("approval-required");
  expect(String(r["reason"])).toContain("crewhaus deploy promote --require-approval");
  expect(String(r["reason"])).toContain("ignored for naming no specHash");
  expect(onDisk()).toEqual({ versions: [], pins: {} });
});

test("SpecPin with an approval that names the file's content pins it", async () => {
  protect("prod");
  approve("prod", [{ approver: "alice", ts: "t", specHash: specRevision(A) }]);
  writeFileSync(path.join(tmp, "spec.yaml"), A);
  const r = await call(specPin, { name: "demo", specFile: "spec.yaml", env: "prod" });
  expect(r["code"]).toBeUndefined();
  expect(onDisk().pins).toEqual({ prod: "v1" });
});

test("SpecPin's dry run reports the gate and changes nothing", async () => {
  protect("prod");
  writeFileSync(path.join(tmp, "spec.yaml"), A);
  const r = await call(specPin, { name: "demo", specFile: "spec.yaml", env: "prod", dryRun: true });
  expect(r["status"]).toBe("preview");
  expect(r["approvalGate"]).toMatchObject({ protected: true, satisfied: false, required: 1 });
  expect(existsSync(manifestPath())).toBe(false);
});

test("SpecPin into an environment that is not protected reports no gate", async () => {
  writeFileSync(path.join(tmp, "spec.yaml"), A);
  const r = await call(specPin, { name: "demo", specFile: "spec.yaml", env: "dev", dryRun: true });
  expect(r["approvalGate"]).toEqual({ protected: false });
});

async function seedTwoVersions(): Promise<void> {
  writeFileSync(path.join(tmp, "spec.yaml"), A);
  await call(specPin, { name: "demo", specFile: "spec.yaml", env: "prod", repin: true });
  writeFileSync(path.join(tmp, "spec.yaml"), B);
  await call(specPin, { name: "demo", specFile: "spec.yaml", env: "prod", repin: true });
  expect(onDisk().pins).toEqual({ prod: "v2" });
}

test("DeployRollback of a protected environment without a quorum refuses and moves no pin", async () => {
  await seedTwoVersions();
  protect("prod");
  // An approval for the version being left, not the one being restored, is not this content.
  approve("prod", [{ approver: "alice", ts: "t", version: "v1", specHash: specRevision(B) }]);
  const r = await call(deployRollback, {
    name: "demo",
    env: "prod",
    toVersion: "v1",
    dryRun: false,
  });
  expect(r["code"]).toBe("approval-required");
  expect(onDisk().pins).toEqual({ prod: "v2" });
});

test("DeployRollback with a quorum bound to the target's content rolls back", async () => {
  await seedTwoVersions();
  protect("prod");
  approve("prod", [{ approver: "alice", ts: "t", version: "v1", specHash: specRevision(A) }]);
  const r = await call(deployRollback, {
    name: "demo",
    env: "prod",
    toVersion: "v1",
    dryRun: false,
  });
  expect(r["status"]).toBe("rolled-back");
  expect(onDisk().pins).toEqual({ prod: "v1" });
});

test("DeployRollback's dry run reports the gate", async () => {
  await seedTwoVersions();
  protect("prod");
  const r = await call(deployRollback, { name: "demo", env: "prod", toVersion: "v1" });
  expect(r["status"]).toBe("preview");
  expect(r["approvalGate"]).toMatchObject({ protected: true, satisfied: false });
  expect(onDisk().pins).toEqual({ prod: "v2" });
});
