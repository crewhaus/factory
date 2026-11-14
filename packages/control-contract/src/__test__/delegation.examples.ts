/** One minimal valid value per delegation schema, built from the real minters. */
import { encodeCursor, mintId } from "../index.js";
import { RECEIPT } from "./schema-examples.js";

const AT = "2026-11-07T00:00:00.000Z";
const RULE = mintId("rule");
const DEC = mintId("dec");
const CURSOR = encodeCursor({ v: 1, kind: "fleet", epoch: 1, seq: 2 });
const DIGEST = "a".repeat(64);

const VIEW = {
  id: RULE,
  action: "merge",
  state: "active",
  revision: 1,
  label: "Merges its own pull requests",
  endsAt: AT,
  uses: 0,
} as const;

export const EXAMPLES = {
  delegationAnswer: { receipt: RECEIPT },
  delegationDetail: { rule: VIEW, terms: { days: 14 }, revisions: [], log: [] },
  delegationEnableRequest: { action: "merge", consequencesDigest: DIGEST, confirm: "support" },
  delegationList: {
    items: [VIEW],
    snapshotAt: CURSOR,
    ceiling: { present: true, maxDays: 30 },
    offers: [],
    proposals: [],
    note: "Rules are applied while Home is running.",
  },
  delegationPage: {
    action: "merge",
    title: "Let support merge its own pull requests",
    sections: [
      { id: "does", heading: "What it will do on its own", lines: ["Merge pull requests."] },
    ],
    text: "Let support merge its own pull requests\n",
    confirmName: "support",
    verb: "crewhaus delegations enable merge --harness hrn_0123456789abcdef",
  },
  delegationPauseRequest: {},
  delegationPreviewRequest: { action: "merge" },
  delegationProposeRequest: { action: "merge", terms: { days: 7 } },
  delegationResumeRequest: { expect: 1, consequencesDigest: DIGEST, confirm: "support" },
  delegationRevokeRequest: {},
  delegationRuleView: { ...VIEW, lastAction: { at: AT, decision: DEC } },
  delegationUpdateRequest: { expect: 1, consequencesDigest: DIGEST, confirm: "support" },
};
