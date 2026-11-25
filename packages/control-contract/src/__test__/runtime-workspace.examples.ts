/** One minimal valid value per schema of the runtime area's workspace half. */
import { mintId } from "../index.js";
import { CURSOR, RECEIPT } from "./schema-examples.js";

const AT = "2026-11-19T00:00:00.000Z";
const WI = mintId("wi");
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const ATTEMPT = {
  id: `${WI}:1`,
  attempt: 1,
  state: "done",
  at: AT,
  branch: "crewhaus/01jabcdefg-fix-the-import",
  baseSha: BASE,
  headSha: HEAD,
  pr: 12,
  files: 2,
  lines: 30,
  verdict: { checks: "pass", acceptance: "pass", sha: HEAD },
} as const;

const PR = { pr: 12, state: "open", at: AT, review: "approved" } as const;

const SUMMARY = {
  work: WI,
  binding: "app",
  branch: ATTEMPT.branch,
  state: "open",
  baseSha: BASE,
  publish: "done",
  pr: 12,
  prState: "open",
  outcome: PR,
} as const;

const WORKSPACE = {
  ...SUMMARY,
  headSha: HEAD,
  checks: [{ name: "bun test", exit: 0, passed: true }],
  attempts: [ATTEMPT],
} as const;

export const EXAMPLES = {
  workPrView: PR,
  workPublishAnswer: { receipt: RECEIPT, attempt: ATTEMPT },
  workPublishVerdict: ATTEMPT.verdict,
  workPublishView: ATTEMPT,
  workspaceAnswer: { workspace: WORKSPACE },
  workspaceCheckView: WORKSPACE.checks[0],
  workspaceList: { items: [SUMMARY], snapshotAt: CURSOR },
  workspaceSummary: SUMMARY,
  workspaceView: WORKSPACE,
};
