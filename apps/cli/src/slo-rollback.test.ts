import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditLog } from "@crewhaus/audit-log";
import { specRevision } from "@crewhaus/ir/policy";
import type { SloMitigationEvent } from "@crewhaus/runtime-core";
import type { RegistryAdapter } from "@crewhaus/spec-registry";
import { makeSloRollback } from "./slo-rollback";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crewhaus-slo-rollback-"));
  mkdirSync(join(root, ".crewhaus", "spec-registry"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const V1_TEXT = "name: bot\ntarget: cli\n# v1\n";

function fakeRegistry(pins: Record<string, string>): RegistryAdapter {
  const texts: Record<string, string> = { v1: V1_TEXT, v2: "name: bot\ntarget: cli\n# v2\n" };
  return {
    aliasFor: async (_name: string, env: string) => pins[env],
    list: async () => Object.keys(texts),
    get: async (_name: string, version: string) => texts[version] as string,
  } as unknown as RegistryAdapter;
}

function fakeAudit(): { audit: AuditLog; kinds: string[]; payloads: unknown[] } {
  const kinds: string[] = [];
  const payloads: unknown[] = [];
  const audit = {
    append: async (input: { kind: string; payload: unknown }) => {
      kinds.push(input.kind);
      payloads.push(input.payload);
    },
  } as unknown as AuditLog;
  return { audit, kinds, payloads };
}

const history = [
  {
    kind: "deployment_action",
    ts: 1,
    payload: { action: "promote", name: "bot", toEnv: "prod", fromVersion: "v0", toVersion: "v1" },
  },
  {
    kind: "deployment_action",
    ts: 2,
    payload: { action: "promote", name: "bot", toEnv: "prod", fromVersion: "v1", toVersion: "v2" },
  },
];

const event = {
  sessionId: "s",
  rung: "rollback",
  breach: { detail: "p95 over target" },
  windowMs: 1000,
} as unknown as SloMitigationEvent;

function protectProd(approvals: unknown[]): void {
  mkdirSync(join(root, ".crewhaus", "approvals"), { recursive: true });
  writeFileSync(
    join(root, ".crewhaus", "environments.json"),
    JSON.stringify({ environments: { prod: { requireApproval: true } } }),
  );
  writeFileSync(join(root, ".crewhaus", "approvals", "bot__prod.json"), JSON.stringify(approvals));
}

describe("SLO rollback", () => {
  test("a protected prod without a quorum moves no pin, records the decision and names the verb", async () => {
    protectProd([]);
    const { audit, kinds } = fakeAudit();
    const lines: string[] = [];
    const moved: string[] = [];
    await makeSloRollback({
      cwd: root,
      name: "bot",
      audit,
      readAuditRecords: () => history,
      write: (line) => lines.push(line),
      openRegistry: async () => fakeRegistry({ prod: "v2" }),
      rollbackPin: async (_r, _a, _n, _e, version) => {
        moved.push(version);
      },
    })(event);
    expect(moved).toEqual([]);
    expect(kinds).toEqual(["governance_approval"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("crewhaus deploy rollback bot prod v1 --require-approval");
  });

  test("a protected prod whose quorum names the restored content rolls back", async () => {
    protectProd([{ approver: "alice", ts: "t", specHash: specRevision(V1_TEXT) }]);
    const { audit, kinds, payloads } = fakeAudit();
    const moved: string[] = [];
    await makeSloRollback({
      cwd: root,
      name: "bot",
      audit,
      readAuditRecords: () => history,
      write: () => undefined,
      openRegistry: async () => fakeRegistry({ prod: "v2" }),
      rollbackPin: async (_r, _a, _n, _e, version) => {
        moved.push(version);
      },
    })(event);
    expect(moved).toEqual(["v1"]);
    expect(kinds).toEqual(["governance_approval"]);
    expect((payloads[0] as { satisfied: boolean }).satisfied).toBe(true);
  });

  test("a prod that takes no quorum rolls back with no governance record", async () => {
    const { audit, kinds } = fakeAudit();
    const moved: string[] = [];
    await makeSloRollback({
      cwd: root,
      name: "bot",
      audit,
      readAuditRecords: () => history,
      write: () => undefined,
      openRegistry: async () => fakeRegistry({ prod: "v2" }),
      rollbackPin: async (_r, _a, _n, _e, version) => {
        moved.push(version);
      },
    })(event);
    expect(moved).toEqual(["v1"]);
    expect(kinds).toEqual([]);
  });
});
