/**
 * The runtime area's workspace half: a steward's work delivered as a pull request from an
 * isolated checkout (#516, #514, #513, module brief 333). Static data, like every area
 * module: the `workspace`, `work-publish` and `work-pr` machines, the `work.publish`
 * command kind, the `workspaces.*` reads, and the closed vocabularies their records use.
 *
 * The engine, the records and the tracker live in `@crewhaus/tool-work/workspace`; this
 * module holds only what the operations, the schemas and the twins need.
 *
 * Every machine lists each state's self-transition on purpose: a line that records a
 * check, a refresh or a review without moving the state is a legal row, never an anomaly.
 */
import type { CommandReceipt } from "../commands.js";
import { READ } from "../operations/shared.js";
import { deepFreeze } from "../util.js";
import type { AreaModule } from "./types.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** A workspace's states: a worktree is open for the item, or closed (removed, branch kept). */
export const WORKSPACE_STATES = deepFreeze(["open", "closed"] as const);
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

/** What a workspace line records. */
export const WORKSPACE_EVENTS = deepFreeze(["opened", "refreshed", "checked", "closed"] as const);
export type WorkspaceEvent = (typeof WORKSPACE_EVENTS)[number];

/** A publish attempt's states. */
export const WORK_PUBLISH_STATES = deepFreeze([
  "started",
  "pushed",
  "done",
  "failed",
  "unknown",
  "not-done",
] as const);
export type WorkPublishState = (typeof WORK_PUBLISH_STATES)[number];

/**
 * A pull request's states, as the tracker last saw it: `reverted` is a merged one whose
 * merge a later commit on its base reverted.
 */
export const WORK_PR_STATES = deepFreeze(["open", "merged", "closed", "reverted"] as const);
export type WorkPrState = (typeof WORK_PR_STATES)[number];

/** Where a pull request's reviews stand. */
export const WORK_PR_REVIEWS = deepFreeze(["approved", "changes-requested"] as const);
export type WorkPrReview = (typeof WORK_PR_REVIEWS)[number];

/** Why a publish did not happen. Closed: a client branches on these. */
export const WORK_PUBLISH_CODES = deepFreeze([
  "nothing_to_publish",
  "checks_failed",
  "conflicts_with_base",
  "egress_blocked",
  "credential_unavailable",
  "not_accepted",
  "already_publishing",
  "unsupported_host",
  "gate_failed",
  "over_limits",
] as const);
export type WorkPublishCode = (typeof WORK_PUBLISH_CODES)[number];

/**
 * A verdict's parts: the declared checks, and the acceptance check. `not-run` says a
 * required part gave no answer (the checks had no sandbox to run in, or an earlier part
 * refused the change first): only `pass` passes.
 */
export const WORK_CHECK_VERDICTS = deepFreeze(["pass", "fail", "skipped", "not-run"] as const);
export const WORK_ACCEPTANCE_VERDICTS = deepFreeze([
  "pass",
  "fail",
  "not-required",
  "not-run",
] as const);

/** What a publish needs before it opens a pull request: `pull_requests.require`. */
export const WORK_PUBLISH_REQUIREMENTS = deepFreeze(["checks", "acceptance"] as const);

/** The closed key set of a workspace line. */
export const WORKSPACE_LOG_KEYS = deepFreeze([
  "v",
  "at",
  "id",
  "state",
  "event",
  "by",
  "via",
  "run",
  "binding",
  "branch",
  "baseSha",
  "headSha",
  "results",
  "wip",
  "claim",
  "repaired",
] as const);

/** The closed key set of a publish attempt line. */
export const WORK_PUBLISH_LOG_KEYS = deepFreeze([
  "v",
  "at",
  "id",
  "wi",
  "attempt",
  "state",
  "by",
  "via",
  "cmd",
  "run",
  "branch",
  "baseSha",
  "headSha",
  "pr",
  "code",
  "file",
  "line",
  "files",
  "lines",
  "verdict",
  "reasons",
  "lineage",
  "rebased",
  "claim",
  "repaired",
] as const);

/** The closed key set of a pull request outcome line. */
export const WORK_PR_LOG_KEYS = deepFreeze([
  "v",
  "at",
  "id",
  "pr",
  "state",
  "review",
  "headSha",
  "mergeSha",
  "changed",
  "reverted",
  "delivery",
  "by",
  "claim",
  "repaired",
] as const);

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** A publish's verdict: the declared checks and the acceptance check, for one head SHA. */
export type WorkPublishVerdict = {
  readonly checks: (typeof WORK_CHECK_VERDICTS)[number];
  readonly acceptance: (typeof WORK_ACCEPTANCE_VERDICTS)[number];
  readonly sha: string;
};

/** One publish attempt, as a reader sees it. */
export type WorkPublishView = {
  readonly id: string;
  readonly attempt: number;
  readonly state: WorkPublishState;
  readonly at: string;
  readonly branch?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly pr?: number;
  readonly code?: WorkPublishCode;
  readonly files?: number;
  readonly lines?: number;
  readonly verdict?: WorkPublishVerdict;
  readonly rebased?: true;
};

/** A pull request, as the tracker last saw it. */
export type WorkPrView = {
  readonly pr: number;
  readonly state: WorkPrState;
  readonly at: string;
  readonly review?: WorkPrReview;
  /** Merged after a maintainer changed it. */
  readonly changed?: true;
  readonly reverted?: true;
};

/** One declared check's last result, for the head SHA it ran on. */
export type WorkspaceCheckView = {
  readonly name: string;
  readonly exit: number;
  readonly passed: boolean;
};

/** One item's workspace in a list. */
export type WorkspaceSummaryView = {
  readonly work: string;
  readonly binding: string;
  readonly branch: string;
  readonly state: WorkspaceState;
  readonly baseSha?: string;
  readonly publish?: WorkPublishState;
  readonly pr?: number;
  readonly prState?: WorkPrState;
  /** The pull request, as the tracker last saw it. */
  readonly outcome?: WorkPrView;
};

/** One item's workspace in full. Check logs and the judge's reasons need content access. */
export type WorkspaceView = WorkspaceSummaryView & {
  readonly headSha?: string;
  readonly wip?: boolean;
  readonly checks?: readonly WorkspaceCheckView[];
  readonly attempts: readonly WorkPublishView[];
  /** The acceptance check's reasons for the newest attempt, for a reader with content access. */
  readonly reasons?: string;
  /** Each check's log, for a reader with content access, newest attempt's head only. */
  readonly logs?: readonly { readonly name: string; readonly text: string }[];
  readonly hidden?: readonly "content"[];
};

export type WorkspaceAnswer = { readonly workspace: WorkspaceView };

/** `work.publish`'s answer: its receipt, the attempt it made, and why one was refused. */
export type WorkPublishAnswer = {
  readonly receipt: CommandReceipt;
  readonly attempt?: WorkPublishView;
  readonly problem?: string;
};

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const TWINS = {
  publish: { argv: ["work", "publish", "{wi}", "--harness", "{hrn}"] },
  list: { argv: ["workspace", "list", "--harness", "{hrn}"] },
  show: { argv: ["workspace", "show", "{wi}", "--harness", "{hrn}"] },
} as const;

const ITEM = "/api/v1/work/{ref}";
const WORK_REF = { kind: "work", param: "ref" } as const;

/** The workspace half of the runtime area's module, spread into `RUNTIME_MODULE`. */
export const WORKSPACE_OPERATIONS = [
  {
    receipt: "harness",
    // An external effect: every caller names its attempt, so a retry is the same attempt.
    idempotency: "required",
    id: "work.publish",
    method: "POST",
    path: `${ITEM}/publish`,
    permission: "h.run.submit",
    request: "emptyRequest",
    response: "workPublishAnswer",
    cliTwin: TWINS.publish,
    qualifiers: [],
    ref: WORK_REF,
  },
  {
    ...READ,
    id: "workspaces.list",
    method: "GET",
    path: "/api/v1/harnesses/{h}/workspaces",
    permission: "h.read",
    request: "listQuery",
    response: "workspaceList",
    cliTwin: TWINS.list,
    qualifiers: [],
  },
  {
    ...READ,
    id: "workspaces.get",
    method: "GET",
    path: `${ITEM}/workspace`,
    permission: "h.read",
    request: "noBody",
    response: "workspaceAnswer",
    cliTwin: TWINS.show,
    qualifiers: ["content-fields"],
    ref: WORK_REF,
  },
] as const;

const ALL_OPERATOR = <const S extends readonly string[]>(states: S) =>
  Object.fromEntries(states.map((s) => [s, "operator"])) as Record<S[number], "operator">;

export const WORKSPACE_MACHINES = {
  workspace: {
    states: [...WORKSPACE_STATES],
    entry: ["open"],
    terminal: [],
    transitions: { open: ["open", "closed"], closed: ["closed", "open"] },
    recoveryOwner: ALL_OPERATOR(WORKSPACE_STATES),
  },
  "work-publish": {
    states: [...WORK_PUBLISH_STATES],
    entry: ["started"],
    terminal: ["done", "failed", "not-done"],
    transitions: {
      started: ["started", "pushed", "failed", "unknown"],
      pushed: ["pushed", "done", "failed", "unknown"],
      unknown: ["unknown", "done", "not-done"],
      done: [],
      failed: [],
      "not-done": [],
    },
    recoveryOwner: ALL_OPERATOR(WORK_PUBLISH_STATES),
  },
  "work-pr": {
    states: [...WORK_PR_STATES],
    // The tracker's first look can find a pull request open, merged or closed.
    entry: ["open", "merged", "closed"],
    // A merged pull request is reverted at most once; the tracker records it and stops.
    terminal: ["reverted"],
    transitions: {
      open: ["open", "merged", "closed"],
      closed: ["closed", "open"],
      merged: ["merged", "reverted"],
      reverted: [],
    },
    recoveryOwner: ALL_OPERATOR(WORK_PR_STATES),
  },
} as const;

export const WORKSPACE_COMMAND_KINDS = [
  {
    id: "work.publish",
    permission: "h.run.submit",
    // A second push and a second pull request request are not safe to repeat blindly:
    // the reconciler looks the pull request up first.
    idempotent: false,
    effect: "external",
    cliTwin: TWINS.publish,
  },
] as const satisfies AreaModule["commandKinds"];

export const WORKSPACE_EVENT_FAMILIES = [
  {
    family: "work.publish",
    // Payloads are ids, SHAs, codes and counts only.
    types: [
      { type: "work.publish.started", sensitivity: "internal" },
      { type: "work.publish.pushed", sensitivity: "internal" },
      { type: "work.publish.done", sensitivity: "internal" },
      { type: "work.publish.failed", sensitivity: "internal" },
      { type: "work.publish.unknown", sensitivity: "internal" },
    ],
  },
  {
    family: "work.outcome",
    types: [{ type: "work.outcome", sensitivity: "internal" }],
  },
  {
    family: "workspace",
    types: [
      { type: "workspace.opened", sensitivity: "internal" },
      { type: "workspace.closed", sensitivity: "internal" },
    ],
  },
] as const satisfies AreaModule["eventFamilies"];

export const WORKSPACE_CAPABILITY_KEYS = ["work.workspaces"] as const;

export const WORKSPACE_REASON_CODES = { publish: [...WORK_PUBLISH_CODES] } as const;

/** Check logs and the managed clones: never served by the raw file browser. */
export const WORKSPACE_RAW_EXCLUSIONS = [
  ".crewhaus/run/control/work/checks/",
  ".crewhaus/workspaces/",
] as const;
