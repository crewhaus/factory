/**
 * A service credential decides tool approvals in Home only at the operator class, on a
 * harness with an approver list or without one: a request that needs a maintainer is
 * refused with the class it needs, and stays waiting.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccessSnapshot, openAccess } from "@crewhaus/access-control";
import {
  type PendingApproval,
  createPendingApprovalStore,
  foldReadOnly,
  generateApprovalId,
  hashApprovalInput,
} from "@crewhaus/session-store";
import { bearer, signInFromBootLink } from "./__test__/browser";
import { bootTestServer } from "./testkit";

async function park(rootDir: string, requiredClass?: "maintainer"): Promise<PendingApproval> {
  const input = { path: "notes/a.md" };
  const record: PendingApproval = {
    id: generateApprovalId(),
    toolName: "Write",
    inputHash: hashApprovalInput("Write", input),
    input,
    runId: "run_1",
    sessionId: "sess_00000000deadbeef",
    surface: "single-turn",
    createdAt: new Date().toISOString(),
    ...(requiredClass !== undefined ? { requiredClass } : {}),
  };
  await createPendingApprovalStore({ rootDir }).persist(record);
  return record;
}

describe("Home's approval grant with a service credential", () => {
  test("a service never decides above operator, with or without an approver list", async () => {
    const t = bootTestServer();
    try {
      await signInFromBootLink(t.fetchRaw, t.server.bootPath as string);
      const dir = join(t.harnessesRoot, "serviced");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "crewhaus.yaml"), "name: serviced\ntarget: cli\n");
      const reg = await t.api("/api/harnesses", {
        method: "POST",
        body: JSON.stringify({ dir }),
      });
      const id = (reg.body["entry"] as { id: string }).id;
      const read = loadAccessSnapshot(t.hangarRoot);
      if (read.state !== "present") throw new Error("no access records");
      const minted = await openAccess(t.hangarRoot).mintServiceToken(
        { principal: read.snapshot.owner as string },
        { service: "deployer", permissions: ["h.decision.resolve"], harnesses: [id] },
      );
      if (!minted.ok) throw new Error(minted.reason);
      // A grant to a service alone does not govern the harness: it has no approver list.
      expect(existsSync(join(dir, ".crewhaus", "run", "control", "approvers.json"))).toBe(false);
      const root = join(dir, ".crewhaus", "sessions");
      const grant = (appr: string) =>
        t.fetchRaw(`/api/h/${id}/approvals/${appr}/grant`, {
          method: "POST",
          headers: { ...bearer(minted.result.secret), "content-type": "application/json" },
          body: "{}",
        });

      const maintainer = await park(root, "maintainer");
      const refused = await grant(maintainer.id);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("Needs a maintainer.");
      const waiting = foldReadOnly(root).records.find((r) => r.id === maintainer.id);
      expect(waiting).toBeDefined();
      expect(waiting?.decision).toBeUndefined();

      // The same credential decides an operator-class request: the refusal is the class.
      const operator = await park(root);
      const decided = await grant(operator.id);
      expect(decided.status).toBe(200);
      expect(foldReadOnly(root).records.find((r) => r.id === operator.id)?.decision).toBe("grant");
    } finally {
      await t.stop();
    }
  }, 30_000);
});
