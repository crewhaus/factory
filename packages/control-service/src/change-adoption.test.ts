/**
 * Change-adoption decisions through the decision service: a member whose class reaches
 * the decision's class decides it, a service credential never does, the first decision
 * wins, and a standing-rule request keeps its owner-only path.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mintId } from "@crewhaus/control-contract";
import {
  type ChangeAdoptionRow,
  type LedgerRecord,
  casAppend,
  decisionsLedger,
  readChangeAdoptions,
  readProposals,
} from "@crewhaus/control-records";
import type { DecisionActor } from "./decisions";
import { NOW, plantProjection, removeTempDirs, rig } from "./test-helpers";

afterAll(removeTempDirs);

const as = (principal: string, extra: Partial<{ service: true }> = {}) =>
  ({ kind: "principal", principal, ...extra }) as DecisionActor;

function governed() {
  const r = rig();
  const owner = mintId("prn");
  const operator = mintId("prn");
  const maintainer = mintId("prn");
  plantProjection(r.harness, owner, [
    { principal: operator, decide: "operator" },
    { principal: maintainer, decide: "maintainer" },
  ]);
  return { ...r, owner, operator, maintainer };
}

const DIGEST = "a".repeat(64);

async function openAdoption(
  harness: string,
  requiredClass: "maintainer" | "owner",
): Promise<ChangeAdoptionRow> {
  const row: ChangeAdoptionRow = {
    id: mintId("dec", { now: NOW }),
    kind: "change-adoption",
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
    requiredClass,
    subject: {
      chg: mintId("chg", { now: NOW }),
      patchDigest: DIGEST,
      baseRevision: `sha256:${"b".repeat(64)}`,
      evidenceDigest: DIGEST,
    },
    bindingDigest: DIGEST,
    proposedBy: "sys:reconcile",
    state: "pending",
  };
  const cas = await casAppend(
    decisionsLedger(harness),
    row.id,
    null,
    row as unknown as LedgerRecord,
  );
  expect(cas.ok && cas.applied).toBe(true);
  return row;
}

describe("a change-adoption decision", () => {
  test("a maintainer grants a maintainer-class decision; a grant applies nothing else", async () => {
    const r = governed();
    const dec = await openAdoption(r.harness, "maintainer");
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: dec.id,
      choice: "grant",
      actor: as(r.maintainer),
      via: "cli",
    });
    expect(answer.outcome).toBe("decided");
    expect(answer.adoption?.state).toBe("granted");
    expect(answer.adoption?.decidedByPrincipal).toBe(r.maintainer);
    const read = readChangeAdoptions(r.harness);
    expect(read.state === "present" && read.rows[0]?.state).toBe("granted");
  });

  test("an operator is refused, with the class it needs", async () => {
    const r = governed();
    const dec = await openAdoption(r.harness, "maintainer");
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: dec.id,
      choice: "grant",
      actor: as(r.operator),
      via: "cli",
    });
    expect(answer.outcome).toBe("forbidden");
    expect(answer.reason).toBe("Needs a maintainer.");
  });

  test("a maintainer is refused an owner-class decision, and the owner decides it", async () => {
    const r = governed();
    const dec = await openAdoption(r.harness, "owner");
    const refused = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: dec.id,
      choice: "grant",
      actor: as(r.maintainer),
      via: "cli",
    });
    expect(refused.outcome).toBe("forbidden");
    const decided = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: dec.id,
      choice: "deny",
      actor: as(r.owner),
      via: "home",
    });
    expect(decided.outcome).toBe("decided");
    expect(decided.adoption?.state).toBe("denied");
  });

  test("a service credential is refused even at the owner's class", async () => {
    const r = governed();
    const dec = await openAdoption(r.harness, "maintainer");
    const answer = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: dec.id,
      choice: "grant",
      actor: as(r.owner, { service: true }),
      via: "home",
    });
    expect(answer.outcome).toBe("forbidden");
    expect(answer.reason).toContain("a person does");
  });

  test("the second decision is already-decided, and the first stands", async () => {
    const r = governed();
    const dec = await openAdoption(r.harness, "maintainer");
    await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: dec.id,
      choice: "grant",
      actor: as(r.maintainer),
      via: "cli",
    });
    const again = await r.service.decisions.resolve({
      harnessDir: r.harness,
      ref: dec.id,
      choice: "deny",
      actor: as(r.owner),
      via: "cli",
    });
    expect(again.outcome).toBe("already-decided");
    expect(again.adoption?.state).toBe("granted");
  });

  test("the requests reader passes over a change-adoption row with no anomaly", async () => {
    const r = governed();
    await openAdoption(r.harness, "maintainer");
    const proposals = readProposals(r.harness);
    expect(proposals.state).toBe("present");
    if (proposals.state === "present") {
      expect(proposals.rows).toEqual([]);
      expect(proposals.anomalies).toEqual([]);
    }
  });
});
