/**
 * What `crewhaus inbox` does about an item (#517, #513): decide it, give it to someone,
 * put it off, set it aside, take it up again, or say something about it. Each is the act
 * Home carries out, through the same writers (`@crewhaus/attention/act`): planned by
 * reading only, and run under a receipt in the harness's own ledger, with Home open or
 * not. A refusal writes nothing. An item about several harnesses is acted on in each.
 *
 * A command started by an agent's tool does nothing here: a person decides.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { idOfItem } from "@crewhaus/attention";
import {
  type ActAnswer,
  type ActDeps,
  type ActPlan,
  type ActRefusal,
  type ActRequest,
  planAcknowledge,
  planAssign,
  planDefer,
  planDismiss,
  planMessage,
  planReopen,
  planResolve,
  planSnooze,
  planUnassign,
  planUndefer,
} from "@crewhaus/attention/act";
import {
  ATTENTION_MESSAGE_MAX_BYTES,
  ATTENTION_NOTE_MAX_BYTES,
  type AttentionItem,
  DEFER_REASONS,
  DISMISS_REASONS,
  type DeferReason,
  type DismissReason,
  EXIT_FOR_ERROR,
  type ErrorCode,
} from "@crewhaus/control-contract";
import { type ControlService, type DecisionActor, outcomeOf } from "@crewhaus/control-service";
import { adjudicateReviewEntry } from "@crewhaus/feedback-distill/adjudicate";
import { readHarnessEnvFiles } from "@crewhaus/harness-supervisor";
import { containedSessionRoot } from "@crewhaus/session-store";
import { type GraphResumeDeps, startGraphResume } from "./graph-resume";

/** Said where a harness's sessions folder lies outside it, so no rating is recorded there. */
const SESSIONS_OUTSIDE =
  "this harness's sessions folder is outside its folder, so the rating can't be recorded there";

/** What a command an agent's tool started is told. */
export const INBOX_AGENT_REFUSAL =
  "This command was started by an agent's tool; a person acts on the inbox.";

/** The verbs that act, each the operation it is and the receipt it writes. */
export const INBOX_ACTS = {
  decide: "attention.resolve",
  assign: "attention.assign",
  unassign: "attention.unassign",
  defer: "attention.defer",
  undefer: "attention.undefer",
  snooze: "attention.snooze",
  dismiss: "attention.dismiss",
  reopen: "attention.reopen",
  acknowledge: "attention.acknowledge",
  discuss: "attention.messages.add",
} as const;

export type InboxAct = keyof typeof INBOX_ACTS;

/** One harness an item is acted on in. */
export type ActHarness = {
  readonly id: string;
  readonly dir: string;
  readonly name: string;
  readonly groups: readonly string[];
};

/** What the person asked, read from the command line. */
export type ActAsk = {
  readonly act: InboxAct;
  readonly choice?: string;
  readonly to?: string;
  readonly until?: string;
  readonly reason?: string;
  readonly expect?: string;
  readonly note?: string;
  readonly text?: string;
};

export type ActContext = {
  readonly control: ControlService;
  readonly actor: DecisionActor;
  /** The name the approvals file shows for the person. */
  readonly display: string;
  readonly hangarRoot: string;
  readonly now: () => number;
  readonly graph: Omit<GraphResumeDeps, "control" | "now">;
};

/** What happened in one harness. */
export type ActOutcome =
  | {
      readonly ok: true;
      readonly harness: ActHarness;
      readonly answer: Extract<ActAnswer, { ok: true }>;
      readonly receipt: string;
    }
  | {
      readonly ok: false;
      readonly harness: ActHarness;
      readonly refusal: ActRefusal;
      readonly receipt?: string;
    };

/** A small text file a person named: a plain file, no link, whole and within its cap. */
export function readSmallFile(
  path: string,
  maxBytes: number,
  cwd: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string } {
  const at = isAbsolute(path) ? path : resolve(cwd, path);
  let fd: number | undefined;
  try {
    // Looked at before it is opened: opening a pipe would wait for its writer.
    if (!lstatSync(at).isFile()) return { ok: false, reason: `${path} is not a plain file` };
    fd = openSync(at, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { ok: false, reason: `${path} is not a plain file` };
    if (stats.size > maxBytes) {
      return { ok: false, reason: `${path} is larger than ${maxBytes / 1024} KiB` };
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength > maxBytes) {
      return { ok: false, reason: `${path} is larger than ${maxBytes / 1024} KiB` };
    }
    return { ok: true, text: bytes.toString("utf8") };
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return {
      ok: false,
      reason: `${path} could not be read${typeof code === "string" ? ` (${code})` : ""}`,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The bytes a verb's file may hold. */
export function fileCapOf(act: InboxAct): number {
  return act === "discuss" ? ATTENTION_MESSAGE_MAX_BYTES : ATTENTION_NOTE_MAX_BYTES;
}

/** What is missing from a verb's own words, before any item is read. */
export function askProblem(ask: ActAsk): string | undefined {
  switch (ask.act) {
    case "decide":
      return ask.choice === undefined
        ? "name the choice, one of those `crewhaus inbox show <att_…>` lists"
        : undefined;
    case "assign":
      return ask.to === undefined ? "name the member with --to prn_…" : undefined;
    case "defer":
      if (ask.until === undefined) return "say until when with --until";
      return (DEFER_REASONS as readonly string[]).includes(ask.reason ?? "")
        ? undefined
        : `--reason is one of ${DEFER_REASONS.join(", ")}`;
    case "snooze":
      return ask.until === undefined ? "say until when with --until" : undefined;
    case "dismiss":
      return (DISMISS_REASONS as readonly string[]).includes(ask.reason ?? "")
        ? undefined
        : `--reason is one of ${DISMISS_REASONS.join(", ")}`;
    case "discuss":
      return ask.text === undefined ? "name the message's file with --file" : undefined;
    default:
      return undefined;
  }
}

function planOf(ask: ActAsk, request: ActRequest, deps: ActDeps): ActPlan {
  const note = ask.note !== undefined ? { note: ask.note } : {};
  switch (ask.act) {
    case "decide":
      return planResolve({ ...request, choice: ask.choice ?? "", ...note }, deps);
    case "assign":
      return planAssign({ ...request, to: ask.to ?? "" }, deps);
    case "unassign":
      return planUnassign(request, deps);
    case "defer":
      return planDefer(
        { ...request, until: ask.until ?? "", reason: ask.reason as DeferReason },
        deps,
      );
    case "undefer":
      return planUndefer(request, deps);
    case "snooze":
      return planSnooze({ ...request, until: ask.until ?? "" }, deps);
    case "dismiss":
      return planDismiss({ ...request, reasonCode: ask.reason as DismissReason, ...note }, deps);
    case "reopen":
      return planReopen({ ...request, ...note }, deps);
    case "acknowledge":
      return planAcknowledge({ ...request, ...note }, deps);
    default:
      return planMessage({ ...request, text: ask.text ?? "" }, deps);
  }
}

/** What this terminal lends an act: its own review writer, and a graph run's build. */
function depsOf(context: ActContext, harness: ActHarness): ActDeps {
  return {
    decisions: context.control.decisions,
    now: context.now,
    displayOf: () => context.display,
    members: {
      hangarRoot: context.hangarRoot,
      harness: { id: harness.id, dir: harness.dir, groups: harness.groups },
    },
    reviewWriter: async (request) => {
      const answer = await adjudicateReviewEntry({
        harnessDir: request.dir,
        itemId: request.id,
        verdict: request.verdict,
        ...(request.note !== undefined ? { note: request.note } : {}),
        by: request.by,
        actor: { by: request.by, via: request.via },
        source: "cli",
        nowIso: request.nowIso,
        // The sessions folder Home reads too: the harness's own, when it lies inside it.
        sessionRoot: (dir) => {
          const root = containedSessionRoot(dir, readHarnessEnvFiles(dir).vars);
          return root !== undefined ? { root } : { note: SESSIONS_OUTSIDE };
        },
      });
      return answer.outcome === "rejected"
        ? { outcome: "rejected", reason: answer.reason }
        : { outcome: answer.outcome };
    },
    resumeGraph: async ({ dir, grun, decision }) => {
      const answer = await startGraphResume(
        { grun, decision, harness: dir },
        { ...context.graph, control: () => context.control, now: context.now },
      );
      return answer.ok
        ? { ok: true, detail: `It resumes as run ${answer.runId}.` }
        : {
            ok: false,
            code: answer.code,
            reason: "not_resumed",
            message: answer.message,
            ...(answer.verb !== undefined ? { verb: answer.verb } : {}),
          };
    },
  };
}

/** The harnesses an item is acted on in: every one it is about, or the one asked for. */
export function targetsOf(
  item: AttentionItem,
  harnesses: readonly ActHarness[],
  only: string | undefined,
): ActHarness[] {
  const about = new Set(item.harnesses ?? (item.harness !== undefined ? [item.harness] : []));
  return harnesses.filter((h) => about.has(h.id) && (only === undefined || h.id === only));
}

/** Harnesses this process has recovered: once per process per harness. */
const recovered = new Set<string>();

/** Carry one act out in one harness, under its own receipt. */
export async function actIn(
  ask: ActAsk,
  item: AttentionItem,
  harness: ActHarness,
  context: ActContext,
): Promise<ActOutcome> {
  const planned = planOf(
    ask,
    {
      dir: harness.dir,
      item,
      actor: context.actor,
      via: "cli",
      ...(ask.expect !== undefined ? { expect: ask.expect } : {}),
    },
    depsOf(context, harness),
  );
  if (!planned.ok) return { ok: false, harness, refusal: planned };
  if (!recovered.has(harness.dir)) {
    recovered.add(harness.dir);
    try {
      await context.control.commands.recover({ harness: harness.dir });
    } catch {
      // Recovery is the writer's courtesy to the last crash, never a gate on this verb.
    }
  }
  const submitted = await context.control.commands.submit<ActAnswer>(
    {
      kind: INBOX_ACTS[ask.act],
      target: `home/harness/${harness.id}`,
      ledger: { harness: harness.dir },
      via: "cli",
      body: { ...ask, item: idOfItem(item) },
    },
    async (receipt) => {
      const answer = await planned.run(receipt.id);
      return {
        settle: answer.ok
          ? { state: "succeeded" as const }
          : { state: "rejected" as const, outcome: outcomeOf(answer.code) },
        value: answer,
      };
    },
  );
  if (!submitted.ok) {
    return {
      ok: false,
      harness,
      refusal: {
        ok: false,
        code: submitted.refusal.code as ErrorCode,
        reason: "not_submitted",
        message: submitted.refusal.message,
      },
    };
  }
  const receipt = submitted.receipt.id;
  const answer = submitted.replayed ? undefined : submitted.value;
  if (answer === undefined) {
    return {
      ok: false,
      harness,
      refusal: {
        ok: false,
        code: "conflict",
        reason: "already_submitted",
        message: "This was already submitted.",
      },
      receipt,
    };
  }
  return answer.ok
    ? { ok: true, harness, answer, receipt }
    : { ok: false, harness, refusal: answer, receipt };
}

/** What an act did, in words. */
export function doneLine(ask: ActAsk, item: AttentionItem): string {
  const id = idOfItem(item);
  switch (ask.act) {
    case "decide":
      return `Recorded: ${ask.choice} on ${id}.`;
    case "assign":
      return `Gave ${id} to ${ask.to}.`;
    case "unassign":
      return `${id} is nobody's in particular now.`;
    case "defer":
      return `Put off ${id}.`;
    case "undefer":
      return `${id} is back in the inbox.`;
    case "snooze":
      return `Hid ${id} from you for now.`;
    case "dismiss":
      return `Set ${id} aside.`;
    case "reopen":
      return `Took ${id} up again.`;
    case "acknowledge":
      return `Acknowledged ${id}.`;
    default:
      return `Added your message to ${id}.`;
  }
}

/** The exit an act's outcomes give: 0 when every harness took it, else its first refusal's. */
export function exitOf(outcomes: readonly ActOutcome[]): number {
  const failed = outcomes.find((o) => !o.ok);
  return failed === undefined || failed.ok ? 0 : (EXIT_FOR_ERROR[failed.refusal.code] ?? 1);
}
