import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditLog, openAuditLog } from "@crewhaus/audit-log";
import { type PolicyRule, auditPolicyDecision, evaluatePolicy } from "./index";

let tmp: string;
let log: AuditLog;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "policy-engine-"));
  log = await openAuditLog({ rootDir: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("evaluatePolicy — defaults (audit mode)", () => {
  test("none side-effect → allow", () => {
    const r = evaluatePolicy({ toolName: "ReadImage", sideEffect: "none", input: {} });
    expect(r.decision).toBe("allow");
  });

  test("filesystem side-effect → audit-and-allow", () => {
    const r = evaluatePolicy({ toolName: "Read", sideEffect: "filesystem", input: {} });
    expect(r.decision).toBe("audit-and-allow");
  });

  test("network side-effect → audit-and-allow", () => {
    const r = evaluatePolicy({ toolName: "WebFetch", sideEffect: "network", input: {} });
    expect(r.decision).toBe("audit-and-allow");
  });

  test("messaging side-effect → audit-and-allow", () => {
    const r = evaluatePolicy({
      toolName: "SendMessage",
      sideEffect: "messaging",
      input: {},
    });
    expect(r.decision).toBe("audit-and-allow");
  });

  test("missing sideEffect defaults to external (fail-closed → audit-and-allow in audit mode)", () => {
    const r = evaluatePolicy({ toolName: "Mystery", input: {} });
    expect(r.decision).toBe("audit-and-allow");
    expect(r.reason).toMatch(/external/);
  });
});

describe("strict mode", () => {
  test("audit-and-allow demoted to deny", () => {
    const r = evaluatePolicy(
      { toolName: "WebFetch", sideEffect: "network", input: {} },
      { mode: "strict" },
    );
    expect(r.decision).toBe("deny");
  });

  test("none side-effect still allowed", () => {
    const r = evaluatePolicy(
      { toolName: "ReadImage", sideEffect: "none", input: {} },
      { mode: "strict" },
    );
    expect(r.decision).toBe("allow");
  });
});

describe("permissive mode", () => {
  test("explicit deny rule is upgraded to audit-and-allow", () => {
    const tenantPolicy: PolicyRule[] = [
      {
        toolPattern: "Bash",
        sideEffects: ["*"],
        action: "deny",
        reason: "no shell in this tenant",
      },
    ];
    const r = evaluatePolicy(
      { toolName: "Bash", sideEffect: "external", input: {} },
      { tenantPolicy, mode: "permissive" },
    );
    expect(r.decision).toBe("audit-and-allow");
  });
});

describe("tenant overrides win over defaults", () => {
  test("tenant deny wins over default audit-and-allow", () => {
    const tenantPolicy: PolicyRule[] = [
      {
        toolPattern: "*",
        sideEffects: ["network"],
        action: "deny",
        reason: "no egress in tenant-x",
      },
    ];
    const r = evaluatePolicy(
      { toolName: "WebFetch", sideEffect: "network", input: {} },
      { tenantPolicy },
    );
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/no egress/);
  });

  test("prefix glob matches", () => {
    const tenantPolicy: PolicyRule[] = [
      { toolPattern: "Web*", sideEffects: ["network"], action: "deny" },
    ];
    const r = evaluatePolicy(
      { toolName: "WebFetch", sideEffect: "network", input: {} },
      { tenantPolicy },
    );
    expect(r.decision).toBe("deny");
  });
});

describe("auditPolicyDecision", () => {
  test("audit-and-allow appends a policy_decision record", async () => {
    const r = await auditPolicyDecision(
      log,
      { toolName: "Read", sideEffect: "filesystem", input: {} },
      { decision: "audit-and-allow", reason: "fs" },
    );
    expect(r).toBeUndefined();
    const records: unknown[] = [];
    for await (const rec of log.read()) records.push(rec);
    expect(records.length).toBe(1);
  });

  test("allow does NOT append by default", async () => {
    await auditPolicyDecision(
      log,
      { toolName: "ReadImage", sideEffect: "none", input: {} },
      { decision: "allow" },
    );
    const records: unknown[] = [];
    for await (const rec of log.read()) records.push(rec);
    expect(records.length).toBe(0);
  });

  test("auditAll: true appends even allow decisions", async () => {
    await auditPolicyDecision(
      log,
      { toolName: "ReadImage", sideEffect: "none", input: {} },
      { decision: "allow" },
      { auditAll: true },
    );
    const records: unknown[] = [];
    for await (const rec of log.read()) records.push(rec);
    expect(records.length).toBe(1);
  });
});
