/** One minimal valid value per attention schema, with ids from the real minters. */
import { attIdFromDigest, attentionRef, encodeCursor } from "../index.js";

const AT = "2026-11-07T00:00:00.000Z";
const HRN = "hrn_0123456789abcdef";
const ATT = attIdFromDigest(new Uint8Array(32).fill(7));
const CURSOR = encodeCursor({ v: 1, kind: "fleet", epoch: 1, seq: 2 });

const ITEM = {
  ref: attentionRef(ATT),
  kind: "permission",
  band: "decide",
  harness: HRN,
  source: { kind: "approval", id: "appr_0123456789abcdef" },
  title: { template: "permission.ask", params: { tool: "Bash" } },
  whyNow: { template: "why.waiting", params: { runs: 1 } },
  affected: { runs: [], count: 1 },
  evidence: [],
  choices: [{ id: "deny", needs: "operator", cliTwin: null, nullReason: "Decide it in Home." }],
  requiredClass: "operator",
  state: "open",
  evidenceRev: "0123456789abcdef",
  since: AT,
  freshness: { asOf: AT, mode: "direct-fold" },
};

export const EXAMPLES = {
  attentionItem: ITEM,
  attentionList: { items: [ITEM], snapshotAt: CURSOR, unreachable: [HRN] },
  attentionListQuery: { kind: "permission", state: "open", limit: 10 },
  attentionMetrics: {
    since: AT,
    asOf: AT,
    harnesses: 1,
    open: [{ kind: "permission", open: 1, p50Ms: 1000, p90Ms: 1000 }],
    resolution: [],
    resolutionByVia: [{ decidedVia: "home", resolved: 1, p50Ms: null, p90Ms: null }],
    fallbacks: 0,
    reasks: 0,
  },
  attentionMetricsQuery: { since: "30d" },
};
