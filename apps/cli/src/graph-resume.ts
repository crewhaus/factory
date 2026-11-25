/**
 * `crewhaus runs resume <grun_…> --decision <decision>`: settle a compiled graph run's
 * pause. The run says in its own record that it waits and where; its build is started
 * with the decision through the same supervisor `crewhaus runs create` uses, and the
 * build's own engine checks the decision before the paused node reads it, and takes the
 * one resume of that pause.
 *
 * Refused before anything starts: a run that is not waiting, one that was already decided,
 * a harness with no build or one too old, a harness that takes no new work, and a command
 * an agent's tool started. A refusal writes nothing.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ROOT_DIR,
  type GraphRunMeta,
  createCheckpointStore,
  resumeClaimName,
} from "@crewhaus/checkpoint-store";
import { EXIT_FOR_ERROR, type ErrorCode, mintRunId } from "@crewhaus/control-contract";
import { append, runsLedger } from "@crewhaus/control-records";
import {
  type ControlService,
  type RunHome,
  intakeRefusal,
  outcomeOf,
  runBundleRefusal,
  runRefOf,
  withdrawQueued,
} from "@crewhaus/control-service";
import type { StartResult } from "@crewhaus/harness-supervisor";
import { AGENT_TOOL_ENV } from "./approvals-cmd";
import type { ResolvedHarness } from "./daemon-cmd";
import { printable } from "./printable";

/** A decision's most bytes: it is one argument of the build's command line. */
export const GRAPH_DECISION_MAX_BYTES = 4 * 1024;

/** What a command an agent's tool started is told. */
export const GRAPH_RESUME_AGENT_REFUSAL =
  "This command was started by an agent's tool; a person decides a paused run.";

type Out = { readonly lines: readonly string[]; readonly exitCode: number };

export type GraphResumeDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly resolve: (raw: string | undefined) => ResolvedHarness;
  readonly control: () => ControlService;
  readonly home: (dir: string) => RunHome;
  /** The harness's id, made when it has none. */
  readonly harnessId: (dir: string) => string;
  readonly now: () => number;
};

/** Whether a command was started by an agent's tool, which decides nothing. */
export function fromAgentTool(env: Readonly<Record<string, string | undefined>>): boolean {
  const marker = env[AGENT_TOOL_ENV];
  return marker !== undefined && marker !== "";
}

/**
 * Why a decision is not one, or `undefined`: the build reads it as one argument, so it has
 * some text, starts with no dash and is short.
 */
export function graphDecisionProblem(decision: string | undefined): string | undefined {
  if (decision === undefined || decision.trim() === "") {
    return "name the decision with --decision (approve or reject, or words the next step reads)";
  }
  if (decision.startsWith("-")) return "a decision does not start with a dash";
  if (decision.includes("\u0000") || Buffer.byteLength(decision, "utf8") > GRAPH_DECISION_MAX_BYTES)
    return "a decision is text of at most 4 KiB";
  return undefined;
}

type Waiting =
  | { readonly state: "waiting"; readonly ckpt: string }
  | { readonly state: "decided" | "not-waiting" | "unknown" | "unreadable" };

/** Whether a graph run waits for a decision, from its own record. Creates nothing. */
export async function graphRunWaiting(harnessDir: string, grun: string): Promise<Waiting> {
  const rootDir = join(harnessDir, DEFAULT_ROOT_DIR);
  // The store makes its folder when it opens: one that is not there holds no run.
  if (!existsSync(join(rootDir, grun, "_meta.json"))) return { state: "unknown" };
  let meta: GraphRunMeta | undefined;
  try {
    meta = await createCheckpointStore({ rootDir }).meta(grun);
  } catch {
    return { state: "unreadable" };
  }
  const taken = (ckpt: string | undefined): boolean => {
    if (ckpt === undefined) return false;
    try {
      return existsSync(join(rootDir, grun, resumeClaimName(ckpt)));
    } catch {
      return false;
    }
  };
  const ckpt = meta?.pendingHitl?.checkpointId;
  if (ckpt === undefined) return { state: taken(meta?.head) ? "decided" : "not-waiting" };
  return taken(ckpt) ? { state: "decided" } : { state: "waiting", ckpt };
}

export type GraphResumeRequest = {
  readonly grun: string;
  readonly decision: string | undefined;
  readonly harness: string | undefined;
};

export type GraphResumeAnswer =
  | { readonly ok: true; readonly runId: string; readonly receipt: string }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly message: string;
      readonly verb?: string;
      readonly receipt?: string;
    };

/** Start the build that settles one pause, or why it was not started. */
export async function startGraphResume(
  request: GraphResumeRequest,
  deps: GraphResumeDeps,
): Promise<GraphResumeAnswer> {
  const { grun, decision } = request;
  const refuse = (code: ErrorCode, message: string, verb?: string): GraphResumeAnswer => ({
    ok: false,
    code,
    message,
    ...(verb !== undefined ? { verb } : {}),
  });
  if (fromAgentTool(deps.env)) return refuse("forbidden", GRAPH_RESUME_AGENT_REFUSAL);
  const problem = graphDecisionProblem(decision);
  if (decision === undefined || problem !== undefined) {
    return refuse("invalid", problem ?? "name the decision with --decision");
  }
  const harness = deps.resolve(request.harness);
  if (harness.target !== "graph") {
    return refuse("unsupported", `${harness.dir} is a ${harness.target} harness, not a graph`);
  }
  const refused = intakeRefusal(harness.dir) ?? runBundleRefusal(harness.dir, "graph");
  if (refused !== undefined) return refuse(refused.code, refused.message, refused.verb);
  const waiting = await graphRunWaiting(harness.dir, grun);
  switch (waiting.state) {
    case "waiting":
      break;
    case "decided":
      return refuse("already_decided", `${grun} was already decided; it is resumed once`);
    case "not-waiting":
      return refuse("conflict", `${grun} is not waiting for a decision`);
    case "unreadable":
      return refuse("unavailable", `the record of ${grun} could not be read`);
    default:
      return refuse("not_found", `no graph run ${grun} in ${harness.dir}`);
  }
  const startRunJob = deps.home(harness.dir).startRunJob;
  if (startRunJob === undefined) return refuse("unavailable", "nothing here can start it");
  const id = deps.harnessId(harness.dir);
  const runId = mintRunId();
  const answer = await deps.control().commands.submit<{ readonly problem?: string }>(
    {
      kind: "graphs.resume",
      target: `home/harness/${id}`,
      ledger: { harness: harness.dir },
      via: "cli",
      body: { grun, decision },
    },
    async (receipt) => {
      const notStarted = (message: string, code: "unavailable" | "disabled" = "unavailable") => ({
        settle: { state: "failed" as const, outcome: outcomeOf(code) },
        value: { problem: message },
      });
      const queued = append(runsLedger(harness.dir), {
        id: runId,
        state: "queued",
        at: new Date(deps.now()).toISOString(),
        trigger: { kind: "api" },
        by: receipt.actor,
        cmd: receipt.id,
      });
      if (!queued.ok) return notStarted(`its run could not be recorded (${queued.code})`);
      let started: StartResult;
      try {
        started = await startRunJob(harness.dir, { runId, graphResume: { grun, decision } });
      } catch (err) {
        started = { ok: false, reason: "plan-failed", stage: "spawn", error: err as Error };
      }
      if (!started.ok) {
        withdrawQueued(harness.dir, runId, receipt);
        return notStarted(
          "error" in started ? started.error.message : started.reason,
          started.reason === "disabled" ? "disabled" : "unavailable",
        );
      }
      return {
        settle: {
          state: "succeeded",
          effects: [{ kind: "run", ref: runRefOf(id, runId), status: "done" }],
        },
        value: {},
      };
    },
  );
  if (!answer.ok) return refuse(answer.refusal.code, answer.refusal.message);
  const receipt = answer.receipt.id;
  if (answer.replayed || answer.value === undefined) {
    return { ok: false, code: "conflict", message: "this was already submitted", receipt };
  }
  const { problem: notStarted } = answer.value;
  return notStarted === undefined
    ? { ok: true, runId, receipt }
    : {
        ok: false,
        code: "unavailable",
        message: `${grun} was not resumed: ${notStarted}`,
        receipt,
      };
}

export async function runGraphResume(
  request: GraphResumeRequest,
  deps: GraphResumeDeps,
): Promise<Out> {
  const answer = await startGraphResume(request, deps);
  const lines = answer.ok
    ? [`${request.grun} resumes as run ${answer.runId}`, `  receipt ${answer.receipt}`]
    : [
        `runs resume: ${answer.message}`,
        ...(answer.verb !== undefined ? [`  try: ${answer.verb}`] : []),
        ...(answer.receipt !== undefined ? [`  receipt ${answer.receipt}`] : []),
      ];
  return {
    lines: lines.map(printable),
    exitCode: answer.ok ? 0 : (EXIT_FOR_ERROR[answer.code] ?? 1),
  };
}
