import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPROVALS_RELDIR,
  ApprovalGateError,
  type ApprovalRecord,
  ENVIRONMENTS_CONFIG_RELPATH,
  type EnvironmentPolicy,
  approvalsFileName,
  buildGovernancePayload,
  decideApproval,
  loadEnvironmentsConfig,
  policyForEnv,
  readApprovals,
} from "./approval-gate";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-approval-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeEnvConfig(obj: unknown): void {
  mkdirSync(join(root, ".crewhaus"), { recursive: true });
  writeFileSync(join(root, ENVIRONMENTS_CONFIG_RELPATH), JSON.stringify(obj));
}

function writeApprovals(specName: string, env: string, records: unknown): void {
  mkdirSync(join(root, APPROVALS_RELDIR), { recursive: true });
  writeFileSync(
    join(root, APPROVALS_RELDIR, approvalsFileName(specName, env)),
    JSON.stringify(records),
  );
}

describe("loadEnvironmentsConfig", () => {
  test("missing file → all-unprotected default", () => {
    const cfg = loadEnvironmentsConfig(root);
    expect(cfg.fromFile).toBe(false);
    expect(policyForEnv(cfg, "prod")).toEqual({ requireApproval: false, minApprovals: 1 });
  });

  test("reads a protected env with minApprovals", () => {
    writeEnvConfig({ environments: { prod: { requireApproval: true, minApprovals: 2 } } });
    const cfg = loadEnvironmentsConfig(root);
    expect(cfg.fromFile).toBe(true);
    expect(policyForEnv(cfg, "prod")).toEqual({ requireApproval: true, minApprovals: 2 });
  });

  test("defaults minApprovals to 1 when omitted", () => {
    writeEnvConfig({ environments: { prod: { requireApproval: true } } });
    expect(policyForEnv(loadEnvironmentsConfig(root), "prod").minApprovals).toBe(1);
  });

  test("throws on malformed JSON", () => {
    mkdirSync(join(root, ".crewhaus"), { recursive: true });
    writeFileSync(join(root, ENVIRONMENTS_CONFIG_RELPATH), "{not json");
    expect(() => loadEnvironmentsConfig(root)).toThrow(ApprovalGateError);
  });

  test("throws on a non-integer minApprovals", () => {
    writeEnvConfig({ environments: { prod: { requireApproval: true, minApprovals: 1.5 } } });
    expect(() => loadEnvironmentsConfig(root)).toThrow(ApprovalGateError);
  });
});

describe("readApprovals", () => {
  test("missing file → []", () => {
    expect(readApprovals(root, "concierge", "prod")).toEqual([]);
  });

  test("reads valid records, drops malformed ones", () => {
    writeApprovals("concierge", "prod", [
      { approver: "alice", ts: "2026-07-01T00:00:00Z" },
      { approver: "bob", ts: "2026-07-01T01:00:00Z", version: "v3" },
      { nope: true },
    ]);
    const recs = readApprovals(root, "concierge", "prod");
    expect(recs).toHaveLength(2);
    expect(recs[1]?.version).toBe("v3");
  });

  test("throws when the file is not an array", () => {
    writeApprovals("concierge", "prod", { approver: "alice" });
    expect(() => readApprovals(root, "concierge", "prod")).toThrow(ApprovalGateError);
  });
});

describe("decideApproval", () => {
  const policy = (min: number): EnvironmentPolicy => ({ requireApproval: true, minApprovals: min });
  const approvals = (...a: ApprovalRecord[]) => a;

  test("refuses with no witnesses", () => {
    const d = decideApproval({
      specName: "concierge",
      toEnv: "prod",
      toVersion: "v3",
      policy: policy(1),
      approvals: [],
    });
    expect(d.satisfied).toBe(false);
    expect(d.reason).toContain("quorum NOT met");
  });

  test("counts distinct approvers toward the quorum", () => {
    const d = decideApproval({
      specName: "c",
      toEnv: "prod",
      toVersion: "v3",
      policy: policy(2),
      approvals: approvals(
        { approver: "alice", ts: "t" },
        { approver: "alice", ts: "t2" }, // duplicate approver — counts once
        { approver: "bob", ts: "t3" },
      ),
    });
    expect(d.countedApprovers).toEqual(["alice", "bob"]);
    expect(d.satisfied).toBe(true);
  });

  test("ignores an approval pinned to a different version", () => {
    const d = decideApproval({
      specName: "c",
      toEnv: "prod",
      toVersion: "v3",
      policy: policy(1),
      approvals: approvals({ approver: "alice", ts: "t", version: "v2" }),
    });
    expect(d.satisfied).toBe(false);
  });

  test("a green PR check contributes one witness", () => {
    const d = decideApproval({
      specName: "c",
      toEnv: "prod",
      toVersion: "v3",
      policy: policy(1),
      approvals: [],
      prCheck: { conclusion: "success", prNumber: 42 },
    });
    expect(d.prWitness).toBe(true);
    expect(d.satisfied).toBe(true);
    expect(d.reason).toContain("#42");
  });

  test("PR witness ADDS to recorded approvals for a higher quorum", () => {
    const d = decideApproval({
      specName: "c",
      toEnv: "prod",
      toVersion: "v3",
      policy: policy(2),
      approvals: approvals({ approver: "alice", ts: "t" }),
      prCheck: { conclusion: "success", prNumber: 7 },
    });
    expect(d.satisfied).toBe(true);
  });

  test("a failing PR check is not a witness", () => {
    const d = decideApproval({
      specName: "c",
      toEnv: "prod",
      toVersion: "v3",
      policy: policy(1),
      approvals: [],
      prCheck: { conclusion: "failure" },
    });
    expect(d.prWitness).toBe(false);
    expect(d.satisfied).toBe(false);
    expect(d.reason).toContain("PR check: failure");
  });
});

describe("buildGovernancePayload", () => {
  test("records the decision for the audit chain", () => {
    const input = {
      specName: "concierge",
      toEnv: "prod",
      toVersion: "v3",
      policy: { requireApproval: true, minApprovals: 1 },
      approvals: [{ approver: "alice", ts: "t" }],
    };
    const decision = decideApproval(input);
    const payload = buildGovernancePayload(input, decision, {
      actor: "cli",
      now: () => 1234,
    });
    expect(payload.satisfied).toBe(true);
    expect(payload.countedApprovers).toEqual(["alice"]);
    expect(payload.actor).toBe("cli");
    expect(payload.ts).toBe(1234);
  });
});
