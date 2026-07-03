/**
 * Section 28 — `canary-controller` tests:
 *  - T3 simulated-traffic test (1000 requests across canary at 10%/50%/100%)
 *    with auto-rollback on injected regression
 *  - T7 24-hour stability fixture (no traffic-bucket drift)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditRecord, openAuditLog } from "@crewhaus/audit-log";
import { createDeploymentController } from "@crewhaus/deployment-controller";
import { createFileBackedRegistry } from "@crewhaus/spec-registry";
import {
  CanaryError,
  PASSING_GATE,
  type RegressionGate,
  createCanaryController,
  makeRegressionGate,
} from "./index";

let tmpRoot = "";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "canary-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function readAudit(rootDir: string): Promise<AuditRecord[]> {
  const log = await openAuditLog({ rootDir });
  const out: AuditRecord[] = [];
  for await (const r of log.read()) out.push(r);
  return out;
}

describe("canary-controller — T3 traffic routing", () => {
  test("0% traffic: every request goes to fromVersion", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    const config = { name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: 0 };
    let canary = 0;
    for (let i = 0; i < 1000; i++) {
      const decision = ctrl.route(config, `req-${i}`);
      if (decision.isCanary) canary++;
      expect(decision.version).toBe(decision.isCanary ? "v2" : "v1");
    }
    expect(canary).toBe(0);
  });

  test("100% traffic: every request goes to toVersion", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    const config = { name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: 100 };
    let stable = 0;
    for (let i = 0; i < 1000; i++) {
      const decision = ctrl.route(config, `req-${i}`);
      if (!decision.isCanary) stable++;
    }
    expect(stable).toBe(0);
  });

  test("50% traffic distributes within ±10% over 1000 requests", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    const config = { name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: 50 };
    let canary = 0;
    for (let i = 0; i < 1000; i++) {
      if (ctrl.route(config, `req-${i}`).isCanary) canary++;
    }
    expect(canary).toBeGreaterThan(400);
    expect(canary).toBeLessThan(600);
  });

  test("hash routing is stable per requestId", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    const config = { name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: 50 };
    const a1 = ctrl.route(config, "user-1234");
    const a2 = ctrl.route(config, "user-1234");
    expect(a1.bucket).toBe(a2.bucket);
    expect(a1.isCanary).toBe(a2.isCanary);
  });

  test("invalid trafficPercent throws", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    expect(() =>
      ctrl.route({ name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: 150 }, "r"),
    ).toThrow(CanaryError);
  });

  test("negative trafficPercent throws", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    expect(() =>
      ctrl.route({ name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: -1 }, "r"),
    ).toThrow(CanaryError);
  });

  test("NaN trafficPercent throws instead of silently routing all traffic to control", async () => {
    // Regression: `NaN < 0` and `NaN > 100` are both false, so without an
    // explicit finiteness check a NaN percentage slips past validation and
    // every request silently falls back to fromVersion (isCanary always false).
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    expect(() =>
      ctrl.route(
        { name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: Number.NaN },
        "r",
      ),
    ).toThrow(CanaryError);
    expect(() =>
      ctrl.route(
        { name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: Number.NaN },
        "r",
      ),
    ).toThrow(/trafficPercent must be in 0\.\.100/);
  });

  test("Infinity trafficPercent throws", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    expect(() =>
      ctrl.route(
        { name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: Number.POSITIVE_INFINITY },
        "r",
      ),
    ).toThrow(CanaryError);
  });
});

describe("canary-controller — eval gate", () => {
  test("pass: promote re-pins env to toVersion + audit-logs", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v1");
    const audit = await openAuditLog({ rootDir: join(tmpRoot, "audit") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({
      registry: reg,
      deploymentController: deploy,
      auditLog: audit,
    });
    const result = await ctrl.evaluate(
      { name: "hello", fromVersion: "v1", toVersion: "v2", trafficPercent: 50 },
      { intervalMs: 0, gate: PASSING_GATE },
    );
    expect(result.verdict).toBe("pass");
    expect(result.action).toBe("promote");
    expect(await reg.aliasFor("hello", "prod")).toBe("v2");
    const records = await readAudit(join(tmpRoot, "audit"));
    expect(records.length).toBe(1);
    expect((records[0]?.payload as { action: string }).action).toBe("promote");
  });

  test("fail: rollback re-pins env to fromVersion + audit-logs reason", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v2"); // canary already deployed
    const audit = await openAuditLog({ rootDir: join(tmpRoot, "audit") });
    const deploy = createDeploymentController({ registry: reg });
    const failingGate: RegressionGate = async () => ({
      verdict: "fail",
      reason: "pass-rate dropped from 0.95 to 0.62",
    });
    const ctrl = createCanaryController({
      registry: reg,
      deploymentController: deploy,
      auditLog: audit,
    });
    const result = await ctrl.evaluate(
      { name: "hello", fromVersion: "v1", toVersion: "v2", trafficPercent: 50 },
      { intervalMs: 0, gate: failingGate },
    );
    expect(result.verdict).toBe("fail");
    expect(result.action).toBe("rollback");
    expect(result.reason).toContain("pass-rate dropped");
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
    const records = await readAudit(join(tmpRoot, "audit"));
    expect((records[0]?.payload as { reason: string }).reason).toContain("pass-rate dropped");
  });

  test("tenant-scoped canary updates only the tenant overlay", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v1");
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    await ctrl.evaluate(
      {
        name: "hello",
        fromVersion: "v1",
        toVersion: "v2",
        trafficPercent: 50,
        tenantId: "tenant-a",
      },
      { intervalMs: 0, gate: PASSING_GATE },
    );
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
    expect(await reg.aliasForTenant("tenant-a", "hello", "prod")).toBe("v2");
  });
});

describe("canary-controller — makeRegressionGate (item 29)", () => {
  test("passes the evaluator verdict straight through on pass", async () => {
    const gate = makeRegressionGate(async () => ({ verdict: "pass", reason: "flat" }));
    const result = await gate({ fromVersion: "v1", toVersion: "v2" });
    expect(result.verdict).toBe("pass");
    expect(result.reason).toBe("flat");
  });

  test("passes the evaluator verdict straight through on fail", async () => {
    const gate = makeRegressionGate(async () => ({ verdict: "fail", reason: "pass-rate dropped" }));
    const result = await gate({ fromVersion: "v1", toVersion: "v2" });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toBe("pass-rate dropped");
  });

  test("a throwing evaluator becomes a fail verdict (never a silent promote)", async () => {
    const gate = makeRegressionGate(async () => {
      throw new Error("provider 429");
    });
    const result = await gate({ fromVersion: "v1", toVersion: "v2" });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("eval gate errored");
    expect(result.reason).toContain("provider 429");
  });

  test("wired into evaluate(): a throwing eval auto-rolls-back to fromVersion", async () => {
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    await reg.put("hello", "v1", "x");
    await reg.put("hello", "v2", "y");
    await reg.pin("hello", "prod", "v2"); // candidate already live
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    const gate = makeRegressionGate(async () => {
      throw new Error("eval blew up");
    });
    const result = await ctrl.evaluate(
      { name: "hello", fromVersion: "v1", toVersion: "v2", trafficPercent: 100 },
      { intervalMs: 0, gate },
    );
    expect(result.verdict).toBe("fail");
    expect(result.action).toBe("rollback");
    expect(await reg.aliasFor("hello", "prod")).toBe("v1");
  });
});

describe("canary-controller — T7 stability fixture", () => {
  test("hash routing has no drift across simulated 24-hour cycle", async () => {
    // Take 1000 fixed requestIds, route 100 times each, assert decisions are stable.
    const reg = createFileBackedRegistry({ rootDir: join(tmpRoot, "specs") });
    const deploy = createDeploymentController({ registry: reg });
    const ctrl = createCanaryController({ registry: reg, deploymentController: deploy });
    const config = { name: "x", fromVersion: "v1", toVersion: "v2", trafficPercent: 25 };
    const requestIds = Array.from({ length: 100 }, (_, i) => `req-${i}`);
    for (const id of requestIds) {
      const decisions = new Set<boolean>();
      for (let t = 0; t < 100; t++) {
        decisions.add(ctrl.route(config, id).isCanary);
      }
      expect(decisions.size).toBe(1);
    }
  });
});
