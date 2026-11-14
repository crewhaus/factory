/** Column groups the core's operation rows repeat. Data only. */

/** A read: no receipt, no idempotency. */
export const READ = { receipt: "none", idempotency: "none" } as const;

/** A command against one harness, answered with its receipt. */
export const HARNESS_COMMAND = {
  receipt: "harness",
  idempotency: "accepted",
  response: "commandAccepted",
} as const;

/** A command against the workspace, answered with its receipt. */
export const WORKSPACE_COMMAND = { receipt: "workspace", idempotency: "accepted" } as const;

export const NOT_A_COMMAND = "authentication, not a command";

/** The real commands the core's rows point at. */
export const TWINS = {
  harnessList: { argv: ["harness", "list"] },
  harnessShow: { argv: ["harness", "show", "{hrn}"] },
  daemonDrain: { argv: ["daemon", "drain", "{hrn}"] },
  daemonStop: { argv: ["daemon", "stop", "{hrn}"] },
  daemonStart: { argv: ["daemon", "start", "{hrn}"] },
  daemonRestart: { argv: ["daemon", "restart", "{hrn}"] },
  daemonPause: { argv: ["daemon", "pause", "{hrn}"] },
  daemonResume: { argv: ["daemon", "resume", "{hrn}"] },
  daemonDisable: { argv: ["daemon", "disable", "{hrn}"] },
  daemonEnable: { argv: ["daemon", "enable", "{hrn}"] },
  approvalsShow: { argv: ["approvals", "show", "{appr}", "--dir", "{dir}"] },
  approvalsChoice: { argv: ["approvals", "{choice}", "{appr}", "--dir", "{dir}"] },
  approvalsSupersede: {
    argv: ["approvals", "supersede", "{appr}", "--reason", "{supersedeReason}", "--dir", "{dir}"],
  },
  approvalsDefer: {
    argv: [
      "approvals",
      "defer",
      "{appr}",
      "--until",
      "{until}",
      "--reason",
      "{deferReason}",
      "--dir",
      "{dir}",
    ],
  },
  approvalsRules: { argv: ["approvals", "rules", "--dir", "{dir}"] },
  approvalsRevoke: { argv: ["approvals", "revoke", "{rule}", "--dir", "{dir}"] },
  deployActivate: { argv: ["deploy", "activate", "{dep}", "--harness", "{hrn}"] },
  deployList: { argv: ["deploy", "list", "--harness", "{hrn}"] },
  accessMembers: { argv: ["access", "members"] },
  accessTokens: { argv: ["access", "tokens"] },
  accessRevokeGrant: { argv: ["access", "revoke", "{grt}"] },
  accessRevokeInvite: { argv: ["access", "revoke", "{inv}"] },
  accessRevokeToken: { argv: ["access", "revoke", "{crd}"] },
  accessUnlink: { argv: ["access", "unlink", "{lnk}"] },
  commandsShow: { argv: ["commands", "show", "{cmd}"] },
  commandsList: { argv: ["commands", "list", "--harness", "{hrn}"] },
  runsList: { argv: ["runs", "list", "--harness", "{hrn}"] },
  runsShow: { argv: ["runs", "show", "{run}", "--harness", "{hrn}"] },
  runsCancel: { argv: ["runs", "cancel", "{run}", "--harness", "{hrn}"] },
} as const;

export const NO_VERB = "The CLI has no command for this.";
export const API_ONLY = "Only API clients call this; the CLI needs no sign-in on its own machine.";
/** Why starting a run through the API has no twin: the CLI reads its input from a file. */
export const RUNS_CREATE_VERB =
  "`crewhaus runs create <harness> --input-file <path>` starts a run from a file on Home's computer.";
/** Why a run's result has no twin of its own. */
export const RUNS_RESULT_VERB = "`crewhaus runs show <run>` shows how a run ended.";
/** Why resuming a run through the API has no twin: the CLI resumes it by its id alone. */
export const RUNS_RESUME_VERB = "`crewhaus runs resume <run>` resumes a run parked on a decision.";

/** Why a free-text request field never reaches a model, by the field's job. */
export const NOT_MODEL_BOUND = {
  name: { none: true, reason: "Compared with the harness's name; no model reads it." },
  nonce: {
    none: true,
    reason: "Matched against the nonce a dry run handed back; no model reads it.",
  },
  revision: { none: true, reason: "Compared with the decision's revision; no model reads it." },
  note: { none: true, reason: "Kept for people; no model reads it." },
  matched: { none: true, reason: "Matched against tool calls; no model reads it." },
  subject: { none: true, reason: "Names who the work serves; no model reads it." },
  signIn: { none: true, reason: "Checked by sign-in; no model reads it." },
  label: { none: true, reason: "Shown to people; no model reads it." },
} as const;
/** Why a device sign-in step has no twin: `crewhaus login` runs both steps itself. */
export const DEVICE_SIGN_IN =
  "`crewhaus login --server <url>` starts this sign-in and finishes it.";
/** Why approving a device has no twin: a code is a secret, and a twin is shown on screen. */
export const DEVICE_APPROVE =
  "The owner can run `crewhaus access approve <code>` on Home's computer.";
export const STREAM_ONLY = "This is a live stream for API clients; the CLI has no command for it.";
