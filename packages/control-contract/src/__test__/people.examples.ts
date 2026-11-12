/** One minimal valid value per people schema, built from the real minters. */
import { encodeCursor, mintId } from "../index.js";

const AT = "2026-11-07T00:00:00.000Z";
const PSN = mintId("psn");
const PCL = mintId("pcl");
const PRN = mintId("prn");
const CURSOR = encodeCursor({ v: 1, kind: "fleet", epoch: 1, seq: 2 });

const ROW = {
  person: PSN,
  kind: "personal",
  label: "Sam",
  role: "owner",
  state: "active",
  rev: 1,
} as const;

const CLAIM = {
  id: PCL,
  rev: 1,
  person: PSN,
  type: "preference",
  area: "communication",
  value: "Prefers short daily updates.",
  source: { kind: "self" },
  acquisition: "stated",
  confidence: "high",
  sensitivity: "ordinary",
  state: "active",
  purposes: ["communication"],
  createdBy: { actor: PRN, via: "cli" },
  createdAt: AT,
  at: AT,
} as const;

const ACTIVITY = { at: AT, actor: PRN, event: "claim.created", counts: { notes: 1 } } as const;

export const EXAMPLES = {
  claimCreateRequest: { area: "communication", value: "Prefers short daily updates." },
  claimReviewRequest: { verdict: "keep" },
  claimReviseRequest: { expect: 1, value: "Prefers a weekly summary." },
  erasurePlan: {
    person: PSN,
    counts: { notes: 1, revisions: 1, rejected: 0, exports: 0 },
    residue: [{ code: "backups-unknown" }],
    nonce: "1.ab",
    expiresAt: AT,
  },
  erasureRunRequest: { nonce: "1.ab", confirm: "Sam" },
  exportPreview: {
    format: "crewhaus.people.v1",
    counts: { notes: 1, rejected: 0, masked: 0, leftOut: 0 },
    sha256: "0".repeat(64),
    bytes: 10,
  },
  exportRequest: {},
  peopleSetupRequest: { custody: "keychain" },
  peopleVaultState: { state: "not-set-up" },
  personActivityList: { items: [ACTIVITY], snapshotAt: CURSOR },
  personActivityRow: ACTIVITY,
  personClaim: CLAIM,
  personClaimList: { items: [CLAIM], snapshotAt: CURSOR },
  personCreateRequest: { kind: "personal", label: "Sam" },
  personList: { items: [ROW], snapshotAt: CURSOR },
  personRow: ROW,
  personUpdateRequest: { expect: 1 },
  personView: { ...ROW, owner: PRN, offLimits: [], viewers: [] },
};
