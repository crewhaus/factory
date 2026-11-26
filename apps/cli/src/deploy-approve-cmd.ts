/**
 * `crewhaus deploy approve <spec> --env <env>`: one person's answer to a protected
 * environment's approval (#517, #513). The answer is for one version and its content: it
 * is recorded once per person, under a receipt in the harness's own ledger, and an
 * approval is also added to `.crewhaus/approvals/`, the file every release's gate reads.
 * Nothing is moved: once enough people approved, the move is run again.
 *
 * Refused before anything is written: a version nobody has, one an environment does not
 * protect, a person who may not approve here, and a command an agent's tool started.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LocalIdentity } from "@crewhaus/access-control";
import {
  type DeployQuorumSubject,
  ENVIRONMENT_NAME_RE,
  EXIT_FOR_ERROR,
  EXIT_FOR_REJECTED_RECEIPT,
  type ErrorCode,
  SPEC_NAME_RE,
  SPEC_REVISION_RE,
  SPEC_VERSION_RE,
  isId,
} from "@crewhaus/control-contract";
import { deployQuorumState, readDeployQuorums, readDeployments } from "@crewhaus/control-records";
import {
  type ControlService,
  type Settlement,
  currentLocalIdentity,
  outcomeOf,
} from "@crewhaus/control-service";
import {
  candidateSpecHash,
  loadEnvironmentsConfig,
  policyForEnv,
} from "@crewhaus/deployment-controller/approval-gate";
import {
  type QuorumVoteAnswer,
  openQuorumDecision,
  quorumVoterProblem,
  recordQuorumVote,
} from "@crewhaus/deployment-controller/quorum";
import type { ParsedArgs } from "@crewhaus/infra-utils";
import { resolveHarnessDir } from "./deploy-activate-cmd";
import { fromAgentTool } from "./graph-resume";
import { jsonSafe, printable } from "./printable";
import { qualityControl, withQualityReceipt } from "./quality-receipts";

export type DeployApproveOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly now?: () => number;
  readonly identity?: LocalIdentity;
  readonly control?: ControlService;
};

export type DeployApproveResult = { readonly lines: readonly string[]; readonly exitCode: number };

export const DEPLOY_APPROVE_USAGE: readonly string[] = [
  "usage:",
  "  crewhaus deploy approve <spec> --env <env> [--version <v>] [--deny]",
  "       [--harness <hrn|dir>] [--json]   answer a protected environment's approval.",
  "                                        Without --version, the one that is waiting.",
  "                                        <v> is a registered version or a dep_ build.",
];

/** What a command an agent's tool started is told. */
export const DEPLOY_APPROVE_AGENT_REFUSAL =
  "This command was started by an agent's tool; a person approves a deployment.";

const fail = (code: ErrorCode, message: string, more: readonly string[] = []) => ({
  lines: [`deploy approve: ${message}`, ...more],
  exitCode: EXIT_FOR_ERROR[code] ?? 1,
});

const flag = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
};

/** The versions of this spec waiting for this environment's approval, newest first. */
function waiting(
  dir: string,
  spec: string,
  environment: string,
  now: number,
): { readonly subjects: readonly DeployQuorumSubject[] } | { readonly unreadable: string } {
  const read = readDeployQuorums(dir);
  if (read.state === "unreadable") return { unreadable: read.reason };
  if (read.state === "absent") return { subjects: [] };
  return {
    subjects: read.rows
      .filter((row) => deployQuorumState(row, now) === "pending")
      .filter((row) => row.subject.spec === spec && row.subject.environment === environment)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((row) => row.subject),
  };
}

/**
 * The content a version holds: a build's, as its record says; a registered version's, from
 * its text; else what a move that is waiting was refused for. `undefined` when nothing says.
 */
async function contentOf(
  dir: string,
  spec: string,
  version: string,
  subjects: readonly DeployQuorumSubject[],
): Promise<string | undefined> {
  if (isId("dep", version)) {
    const read = readDeployments(dir);
    const record =
      read.state === "present" ? read.records.find((r) => r["id"] === version) : undefined;
    const hash = (record?.["artifact"] as { specHash?: unknown } | undefined)?.specHash;
    return typeof hash === "string" && SPEC_REVISION_RE.test(hash) ? hash : undefined;
  }
  const rootDir = join(dir, ".crewhaus", "specs");
  // The registry makes its folder when it opens: one that is not there holds no version.
  if (existsSync(join(rootDir, spec))) {
    try {
      const { createFileBackedRegistry } = await import("@crewhaus/spec-registry");
      return await candidateSpecHash(createFileBackedRegistry({ rootDir }), spec, version);
    } catch {
      // Not registered yet (a ramp asks before it registers): what is waiting names it.
    }
  }
  return subjects.find((s) => s.version === version)?.specHash;
}

/** The command that moves an approved version where it was approved for. */
function moveLine(subject: DeployQuorumSubject): string {
  return isId("dep", subject.version)
    ? `crewhaus deploy activate ${subject.version} --environment ${subject.environment}`
    : `crewhaus spec pin ${subject.spec} ${subject.environment} ${subject.version}`;
}

/** Why a vote was not recorded, with the code it exits by. */
function refusalOf(
  answer: Exclude<QuorumVoteAnswer, { outcome: "recorded" }>,
): readonly [ErrorCode, string] {
  switch (answer.outcome) {
    case "forbidden":
      return ["forbidden", answer.reason];
    case "unavailable":
      return ["unavailable", answer.reason];
    case "not-found":
      return ["not_found", "nothing is waiting for approval any more"];
    case "expired":
      return ["precondition_failed", "the approval has expired; run the move again to ask anew"];
    case "already-voted":
      return ["already_decided", "you already answered this"];
    default:
      return ["already_decided", `it was already settled (${answer.row.state})`];
  }
}

export async function deployApprove(
  args: ParsedArgs,
  options: DeployApproveOptions = {},
): Promise<DeployApproveResult> {
  const out = await approve(args, options);
  return { ...out, lines: out.lines.map(args.flags["json"] === true ? jsonSafe : printable) };
}

async function approve(
  args: ParsedArgs,
  options: DeployApproveOptions,
): Promise<DeployApproveResult> {
  if (args.flags["help"] === true) return { lines: DEPLOY_APPROVE_USAGE, exitCode: 0 };
  const env = options.env ?? process.env;
  if (fromAgentTool(env)) {
    return { lines: [DEPLOY_APPROVE_AGENT_REFUSAL], exitCode: EXIT_FOR_ERROR.forbidden };
  }
  const spec = args.positional[0];
  if (typeof spec !== "string" || !SPEC_NAME_RE.test(spec)) {
    return fail("invalid", "name the spec, as it is registered");
  }
  if (args.positional.length > 1) return fail("invalid", `unexpected "${args.positional[1]}"`);
  const environment = flag(args, "env");
  if (environment === undefined || !ENVIRONMENT_NAME_RE.test(environment)) {
    return fail("invalid", "name the environment with --env");
  }
  const named = flag(args, "version");
  if (named !== undefined && !SPEC_VERSION_RE.test(named)) {
    return fail("invalid", "--version is a registered version, or a dep_ build");
  }
  const now = (options.now ?? Date.now)();
  const { dir } = resolveHarnessDir(flag(args, "harness"), options);
  const asked = waiting(dir, spec, environment, now);
  if ("unreadable" in asked) {
    return fail("unavailable", `what is waiting could not be read: ${asked.unreadable}`);
  }
  const versions = [...new Set(asked.subjects.map((s) => s.version))];
  if (named === undefined && versions.length !== 1) {
    return versions.length === 0
      ? fail(
          "not_found",
          `nothing of ${spec} is waiting for ${environment}; name a version with --version`,
        )
      : fail(
          "invalid",
          `several versions are waiting (${versions.join(", ")}); name one with --version`,
        );
  }
  const version = named ?? (versions[0] as string);
  let isProtected: boolean;
  try {
    isProtected = policyForEnv(loadEnvironmentsConfig(dir), environment).requireApproval;
  } catch (err) {
    return fail("unavailable", err instanceof Error ? err.message : String(err));
  }
  if (!isProtected && !versions.includes(version)) {
    return fail("conflict", `${environment} is not a protected environment; it needs no approval`);
  }
  const specHash = await contentOf(dir, spec, version, asked.subjects);
  if (specHash === undefined) return fail("not_found", `no version ${version} of ${spec} here`);
  const subject: DeployQuorumSubject = { spec, environment, version, specHash };
  const choice = args.flags["deny"] === true ? "deny" : "approve";

  const identity = options.identity ?? currentLocalIdentity();
  const control = options.control ?? qualityControl(options);
  const actor = { kind: "local", identity } as const;
  const who = control.decisions.principalOf(actor, dir);
  // Read before anything is written. An unlinked person's digest is theirs alone, so the
  // answer is the same whichever it is.
  const voter = who.principal ?? `local:#${"0".repeat(64)}`;
  const problem = quorumVoterProblem(
    dir,
    { principal: voter, ...(who.service === true ? { service: true } : {}) },
    now,
  );
  if (problem !== undefined) return fail("forbidden", problem);

  const display = env["CREWHAUS_USER"] || identity.username || "cli";
  type Value =
    | { readonly vote: QuorumVoteAnswer }
    | { readonly vote?: undefined; readonly reason: string };
  const done = await withQualityReceipt<Value>(
    {
      harnessDir: dir,
      kind: "deployments.approve",
      body: { ...subject, choice },
      control,
      env,
      ...(options.now !== undefined ? { now: options.now } : {}),
    },
    async () => {
      const rejected = (code: ErrorCode): Settlement => ({
        state: "rejected",
        outcome: outcomeOf(code),
      });
      const opened = await openQuorumDecision(dir, subject, { now });
      if (!opened.ok) {
        return { settle: rejected("unavailable"), value: { reason: opened.reason } };
      }
      const vote = await recordQuorumVote(dir, opened.row.id, {
        principal: await control.decisions.storedActorOf(dir, actor),
        display,
        choice,
        now,
      });
      return {
        settle: vote.outcome === "recorded" ? { state: "succeeded" } : rejected(refusalOf(vote)[0]),
        value: { vote },
      };
    },
  );
  if (!done.ok) return { lines: [`deploy approve: ${done.reason}`], exitCode: done.exitCode };
  const receipt = `  receipt ${done.receipt.id}`;
  if (done.value === undefined) {
    return { lines: ["deploy approve: already submitted"], exitCode: EXIT_FOR_REJECTED_RECEIPT };
  }
  const { vote } = done.value;
  if (vote === undefined) return fail("unavailable", done.value.reason, [receipt]);
  if (vote.outcome !== "recorded") {
    const [code, message] = refusalOf(vote);
    return fail(code, message, [receipt]);
  }
  const { state } = vote.row;
  const approvals = `${vote.counted.length} of ${vote.required}`;
  if (args.flags["json"] === true) {
    return {
      lines: [
        JSON.stringify(
          {
            decision: vote.row.id,
            subject,
            choice,
            state,
            approvals: vote.counted.length,
            required: vote.required,
            receipt: done.receipt.id,
          },
          null,
          2,
        ),
      ],
      exitCode: 0,
    };
  }
  const what = `${spec} ${version} for ${environment}`;
  if (state === "denied") return { lines: [`Refused: ${what}.`, receipt], exitCode: 0 };
  return {
    lines:
      state === "granted"
        ? [
            `Approved: ${what}. It has its approvals (${approvals}).`,
            `  next: ${moveLine(subject)}`,
            receipt,
          ]
        : [`Approved: ${what}. ${approvals} approvals are recorded.`, receipt],
    exitCode: 0,
  };
}
