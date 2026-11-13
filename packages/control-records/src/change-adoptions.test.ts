/**
 * Change-adoption decisions beside standing-rule requests in one decisions ledger:
 * each reader reads its own kind, passes over the other known kind without an
 * anomaly, and still reports a row of a kind it does not know.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mintId } from "@crewhaus/control-contract";
import { casAppend } from "./ledger";
import {
  PROPOSAL_TTL_MS,
  changeAdoptionOf,
  changeAdoptionState,
  decisionsLedger,
  readChangeAdoptions,
  readProposals,
} from "./standing-rules";
import { removeTempDirs, snapshotTree, tempDir } from "./test-helpers";

afterAll(removeTempDirs);

const T0 = Date.parse("2026-11-12T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const PRN = mintId("prn");
const DIGEST = "c".repeat(64);

const request = () => ({
  kind: "standing-rule-proposal",
  createdAt: iso(T0),
  expiresAt: iso(T0 + PROPOSAL_TTL_MS),
  requiredClass: "owner",
  derivedFrom: "appr_0123456789abcdef",
  proposedBy: PRN,
  terms: { ruleKind: "allow", tool: "Write", pattern: "Write(a)", expiresAt: iso(T0 + 1) },
  state: "pending",
});

const adoption = () => ({
  kind: "change-adoption",
  createdAt: iso(T0),
  expiresAt: iso(T0 + PROPOSAL_TTL_MS),
  requiredClass: "maintainer",
  subject: {
    chg: mintId("chg"),
    patchDigest: DIGEST,
    baseRevision: `sha256:${"d".repeat(64)}`,
    evidenceDigest: DIGEST,
  },
  bindingDigest: DIGEST,
  proposedBy: PRN,
  state: "pending",
});

describe("one decisions ledger, two kinds", () => {
  test("readProposals returns the request only, with no anomaly for the adoption row", async () => {
    const root = tempDir();
    const req = mintId("dec");
    const adopt = mintId("dec");
    await casAppend(decisionsLedger(root), req, null, request());
    await casAppend(decisionsLedger(root), adopt, null, adoption());
    const proposals = readProposals(root);
    if (proposals.state !== "present") throw new Error(proposals.state);
    expect(proposals.rows.map((r) => r.id)).toEqual([req]);
    expect(proposals.anomalies).toEqual([]);
    const adoptions = readChangeAdoptions(root);
    if (adoptions.state !== "present") throw new Error(adoptions.state);
    expect(adoptions.rows.map((r) => r.id)).toEqual([adopt]);
    expect(adoptions.anomalies).toEqual([]);
  });

  test("a row of an unknown kind is still an anomaly to both readers", async () => {
    const root = tempDir();
    const odd = mintId("dec");
    await casAppend(decisionsLedger(root), odd, null, { kind: "something-else", state: "pending" });
    for (const read of [readProposals(root), readChangeAdoptions(root)]) {
      if (read.state !== "present") throw new Error(read.state);
      expect(read.rows).toEqual([]);
      expect(read.anomalies).toHaveLength(1);
      expect(read.anomalies[0]).toStartWith(`${odd}: the row is not a`);
    }
  });

  test("a change-adoption row that is malformed is the adoption reader's anomaly", async () => {
    const root = tempDir();
    const bad = mintId("dec");
    await casAppend(decisionsLedger(root), bad, null, { ...adoption(), requiredClass: "operator" });
    const read = readChangeAdoptions(root);
    if (read.state !== "present") throw new Error(read.state);
    expect(read.rows).toEqual([]);
    expect(read.anomalies).toEqual([`${bad}: the row is not a change-adoption decision`]);
    expect(changeAdoptionOf({ id: bad, ...adoption(), subject: {} })).toBeUndefined();
  });

  test("a pending or granted decision past its end reads expired, and the read writes nothing", async () => {
    const root = tempDir();
    const id = mintId("dec");
    await casAppend(decisionsLedger(root), id, null, adoption());
    const before = snapshotTree(root);
    const read = readChangeAdoptions(root);
    if (read.state !== "present") throw new Error(read.state);
    const row = read.rows[0];
    if (row === undefined) throw new Error("no row");
    expect(changeAdoptionState(row, T0 + PROPOSAL_TTL_MS)).toBe("pending");
    expect(changeAdoptionState(row, T0 + PROPOSAL_TTL_MS + 1)).toBe("expired");
    expect(changeAdoptionState({ ...row, state: "granted" }, T0 + PROPOSAL_TTL_MS + 1)).toBe(
      "expired",
    );
    expect(changeAdoptionState({ ...row, state: "consumed" }, T0 + PROPOSAL_TTL_MS + 1)).toBe(
      "consumed",
    );
    expect(snapshotTree(root)).toEqual(before);
  });
});
