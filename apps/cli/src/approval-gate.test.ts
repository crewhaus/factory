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
  prReferencesVersion,
  readApprovals,
  rollupConclusion,
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

// ---------------------------------------------------------------------------
// F3(a) — fail-closed PR-check rollup verdict.
// ---------------------------------------------------------------------------
describe("rollupConclusion — fail-closed (F3a)", () => {
  test("empty rollup → none (no checks, no witness)", () => {
    expect(rollupConclusion([])).toBe("none");
  });

  test("all explicit SUCCESS → success", () => {
    expect(rollupConclusion([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("success");
  });

  test("a SKIPPED check → NOT a witness (none), not success", () => {
    expect(rollupConclusion([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }])).toBe("none");
  });

  test("a NEUTRAL check → NOT a witness (none)", () => {
    expect(rollupConclusion([{ conclusion: "NEUTRAL" }])).toBe("none");
  });

  test("TIMED_OUT / ACTION_REQUIRED / STALE → failure (fail-closed)", () => {
    expect(rollupConclusion([{ conclusion: "SUCCESS" }, { conclusion: "TIMED_OUT" }])).toBe(
      "failure",
    );
    expect(rollupConclusion([{ conclusion: "ACTION_REQUIRED" }])).toBe("failure");
    expect(rollupConclusion([{ conclusion: "STALE" }])).toBe("failure");
  });

  test("an unknown conclusion → NOT success (none)", () => {
    expect(rollupConclusion([{ conclusion: "MYSTERY_STATE" }])).toBe("none");
  });

  test("a check with neither state nor conclusion → pending (ambiguous, not success)", () => {
    expect(rollupConclusion([{ conclusion: "SUCCESS" }, {}])).toBe("pending");
  });

  test("a running check → pending", () => {
    expect(rollupConclusion([{ state: "IN_PROGRESS" }, { conclusion: "SUCCESS" }])).toBe("pending");
  });

  test("a SKIPPED-only rollup does NOT witness a promotion (decideApproval)", () => {
    // The real-world regression: a green-looking PR whose only check was skipped
    // must not clear the gate.
    const decision = decideApproval({
      specName: "bot",
      toEnv: "prod",
      toVersion: "v2",
      policy: { requireApproval: true, minApprovals: 1 },
      approvals: [],
      prCheck: { conclusion: rollupConclusion([{ conclusion: "SKIPPED" }]) },
    });
    expect(decision.satisfied).toBe(false);
    expect(decision.prWitness).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F3(b) — bind the PR witness to the exact version.
// ---------------------------------------------------------------------------
describe("prReferencesVersion — version binding (F3b)", () => {
  test("matches the version in a propose/ head ref", () => {
    expect(
      prReferencesVersion({ headRefName: "propose/bot-v2-abcd1234-2026-07-02T00-00-00" }, "v2"),
    ).toBe(true);
  });

  test("does NOT match a different version (v2 head does not witness v3)", () => {
    expect(
      prReferencesVersion({ headRefName: "propose/bot-v2-abcd1234-2026-07-02T00-00-00" }, "v3"),
    ).toBe(false);
  });

  test("does NOT let v1 witness v10 (bounded token, not substring)", () => {
    expect(prReferencesVersion({ headRefName: "propose/bot-v10-abcd1234-stamp" }, "v1")).toBe(
      false,
    );
    expect(prReferencesVersion({ headRefName: "propose/bot-v10-abcd1234-stamp" }, "v10")).toBe(
      true,
    );
  });

  test("matches a version referenced in the title or body", () => {
    expect(prReferencesVersion({ title: "Propose bot v2 for review" }, "v2")).toBe(true);
    expect(prReferencesVersion({ body: "This promotes to version v2 today" }, "v2")).toBe(true);
  });

  test("a trailing dot after the version is treated as ambiguous (v2. could be v2.1) — no match", () => {
    // Conservative for a security gate: never let `v2` witness when it might be
    // a truncation of `v2.1`. The head-ref binding (bounded by `-`) is exact.
    expect(prReferencesVersion({ body: "promotes to v2." }, "v2")).toBe(false);
  });

  test("no version reference anywhere → false", () => {
    expect(prReferencesVersion({ headRefName: "propose/bot-nope", title: "x" }, "v2")).toBe(false);
  });

  test("a green PR for a DIFFERENT version does not witness (integration of a+b)", () => {
    // A green rollup, but the PR is for v2 while we promote v3 → no witness.
    const prForV2 = {
      headRefName: "propose/bot-v2-hash-stamp",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    };
    const matches = prReferencesVersion(prForV2, "v3");
    expect(matches).toBe(false);
    // The green PR for the EXACT version does witness.
    expect(prReferencesVersion(prForV2, "v2")).toBe(true);
    expect(rollupConclusion(prForV2.statusCheckRollup)).toBe("success");
  });
});
