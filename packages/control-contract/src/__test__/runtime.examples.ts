/** One minimal valid value per runtime schema, built from the real minters. */
import { encodeCursor, mintId } from "../index.js";
import { RECEIPT } from "./schema-examples.js";

const AT = "2026-11-07T00:00:00.000Z";
const WI = mintId("wi");
const CURSOR = encodeCursor({ v: 1, kind: "fleet", epoch: 1, seq: 2 });

const ITEM = {
  id: WI,
  state: "open",
  status: "up-next",
  statusWord: "Up next",
  title: "Update the date parser",
  kind: "fix",
  rev: 1,
  createdAt: AT,
  updatedAt: AT,
  runs: [],
} as const;

/** A feature's case for itself: a reported problem, and what happens if nothing is done. */
export const ASSESSMENT = {
  problem: "Exports are copied by hand.",
  evidence: [
    {
      label: "reported",
      kind: "user-report",
      ref: "thredz-task:t1",
      note: "Three people asked for it.",
      ingestedAt: AT,
    },
  ],
  counterEvidence: [{ label: "hypothesis", kind: "inferred", note: "Few may need it." }],
  doNothing: "People keep copying rows by hand.",
  cost: 1,
} as const;

const EMPTY_SECTION = {
  empty: { reason: "no-data", remedy: "Nothing here yet.", verb: null },
} as const;

export const EXAMPLES = {
  workAdoptRequest: { source: "continuity-goal:goal-0001" },
  workAnswer: { receipt: RECEIPT, item: ITEM },
  workAssessment: ASSESSMENT,
  workCreateRequest: { title: "Add CSV export", kind: "feature", assessment: ASSESSMENT },
  workCreateSpec: { title: "Fix the import", kind: "fix" },
  workDeclineRequest: { reason: "not-now" },
  workEvidence: ASSESSMENT.evidence[0],
  workFeed: {
    freshness: "direct-fold",
    at: AT,
    sections: {
      needsYou: EMPTY_SECTION,
      workingNow: EMPTY_SECTION,
      upNext: { items: [{ kind: "item", id: WI, label: ITEM.title, item: ITEM }] },
      proposed: EMPTY_SECTION,
      scheduled: EMPTY_SECTION,
      delivered: EMPTY_SECTION,
      goals: EMPTY_SECTION,
      fromThredz: {
        empty: {
          reason: "unsupported",
          remedy: "Connect Thredz to see its tasks here.",
          verb: "crewhaus services setup",
        },
      },
    },
    anomalies: 0,
    tools: true,
  },
  workItem: ITEM,
  workItemDetail: { item: ITEM, history: [{ at: AT, event: "opened", by: "sys:runtime" }] },
  workList: { items: [ITEM], snapshotAt: CURSOR },
  workRankRequest: { below: mintId("wi"), scope: "similar" },
  workUpdateRequest: { expect: 1, note: "Moved up after the outage." },
};
