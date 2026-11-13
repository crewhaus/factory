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
  approvalsShow: { argv: ["approvals", "show", "{appr}", "--dir", "{dir}"] },
  approvalsChoice: { argv: ["approvals", "{choice}", "{appr}", "--dir", "{dir}"] },
  approvalsSupersede: {
    argv: ["approvals", "supersede", "{appr}", "--reason", "{supersedeReason}", "--dir", "{dir}"],
  },
  approvalsRules: { argv: ["approvals", "rules", "--dir", "{dir}"] },
  approvalsRevoke: { argv: ["approvals", "revoke", "{rule}", "--dir", "{dir}"] },
  deployActivate: { argv: ["deploy", "activate", "{dep}", "--harness", "{hrn}"] },
  deployList: { argv: ["deploy", "list", "--harness", "{hrn}"] },
} as const;

export const NO_VERB = "The CLI has no command for this.";
export const API_ONLY = "Only API clients call this; the CLI needs no sign-in on its own machine.";
export const NO_RUNS_VERB = "`crewhaus runs` only resumes a session.";
export const STREAM_ONLY = "This is a live stream for API clients; the CLI has no command for it.";
