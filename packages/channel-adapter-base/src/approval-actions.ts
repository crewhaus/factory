/**
 * A click on a channel daemon's approval card, decided by who clicked.
 *
 * The emitted gateway authenticates the request (its capped read, `verify()` and
 * `parseInteraction`) and hands the parsed click to {@link createApprovalActions}'s
 * `handle`, which:
 *
 *  1. names the clicker `slack:<team>:<user>` and looks them up in the harness's approver
 *     projection (`.crewhaus/run/control/approvers.json`). A click decides something only
 *     from a linked member: with no projection, or no link for the clicker, the answer
 *     (to the clicker alone) says how to link, with `crewhaus access link`, and nothing
 *     is decided. A projection that cannot be read decides nothing either.
 *  2. decides nothing on an Approve or Always allow for a request whose whole input does
 *     not fit the card (`fitsCard`): the answer says where to review it in full.
 *  3. decides through the one tool-approval step every surface uses,
 *     `resolveToolApproval` (`@crewhaus/control-service/approval-resolve`), on the
 *     store's own session root, as that member: it counts only when the member's class
 *     reaches the request's, Always allow from the owner makes a 30-day rule for exactly
 *     this call, and from anyone else it allows the call once and asks the owner. The
 *     record names the member (`decidedByPrincipal`) and shows `slack` as `decidedBy`;
 *     no record holds a Slack id.
 *  4. answers Slack `200 ok` as soon as the decision is recorded. The card update, the
 *     audit record, any answer to the clicker and, on a grant, the continued reply run
 *     afterwards, off the request path, each failure one stderr line.
 *
 * A decision made elsewhere (Home, `crewhaus approvals`, another daemon) on a card this
 * process posted is followed up in the card's thread ("Granted in Home"), and a grant
 * continues the waiting reply only on a card posted with buttons, when exactly one
 * adapter takes clicks; a grant on a text card waits for the next message in its
 * conversation. A watcher on the session root's decision log (`fs.watch`, with a
 * one-second check of the directory as a fallback, neither keeping the process alive)
 * reads each posted card's request again when the log changes. After a restart nothing is posted; the next message in that
 * conversation spends the grant. The card is not edited in place: the library never
 * sees its channel.
 */
import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { RECEIPT_VIA, type ReceiptVia, type Trigger } from "@crewhaus/control-contract";
import { type ApproverRead, readApproverProjection } from "@crewhaus/control-records";
import {
  type ResolveAnswer,
  resolveToolApproval,
} from "@crewhaus/control-service/approval-resolve";
import { runWithScope } from "@crewhaus/run-context";
import {
  type ApprovalAuditSink,
  type ApprovalReview,
  type ApprovalStore,
  type PendingApproval,
  approvalReview,
  forgetPosted,
  postedApprovalIds,
  postedInteractively,
  postedReply,
} from "./approvals";

/** The fields of a parsed approval click this module reads. */
export type ApprovalInteraction = {
  readonly kind: "approval_action";
  readonly approvalId: string;
  readonly decision: "grant" | "deny";
  readonly always?: boolean;
  readonly userId: string;
  readonly teamId?: string;
};

/** The adapter calls this module makes; Slack's `ChannelAdapter` satisfies it. */
export type ApprovalActionAdapter<I extends ApprovalInteraction = ApprovalInteraction> = {
  readonly id: string;
  /** Present on an adapter that takes clicks. */
  readonly parseInteraction?: unknown;
  ackApproval?(args: {
    interaction: I;
    decision: "grant" | "deny";
    by: string;
    toolName?: string;
    state?: string;
  }): Promise<void>;
  answerInteraction?(args: { interaction: I; text: string }): Promise<void>;
};

/** What tells this module the decision log changed: `fs.watch` and a stat check by default. */
export type DecisionWatch = {
  onChange(cb: () => void): void;
  close(): void;
};

export type ApprovalActionsConfig<
  I extends ApprovalInteraction,
  A extends ApprovalActionAdapter<I>,
> = {
  /** The channel-shaped view of the runtime's approvals store, with its `rootDir`. */
  readonly approvals: ApprovalStore;
  readonly adapters: ReadonlyMap<string, A>;
  readonly sessionRouter: { resumeApproval(approval: PendingApproval, adapter: A): Promise<void> };
  readonly auditSink?: ApprovalAuditSink;
  /** The harness whose approver projection says who may decide; default the working directory. */
  readonly harnessDir?: string;
  readonly now?: () => number;
  /** The decision-log watcher (tests inject one). */
  readonly watch?: DecisionWatch;
  /** The approver projection reader; the default caches for one second. */
  readonly approvers?: (harnessDir: string) => ApproverRead;
};

export type ApprovalActions<I extends ApprovalInteraction, A extends ApprovalActionAdapter<I>> = {
  /** Decide one parsed click; the answer is the platform's. */
  handle(interaction: I, adapter: A): Promise<Response>;
  /** Stop watching the decision log. */
  close(): void;
};

/** What the clicker is told when their Slack account is not linked to a member. */
export function linkAnswer(subject: string | undefined): string {
  return `Link your CrewHaus account to decide here. Ask the owner to run \`crewhaus access link ${subject ?? "slack:<team>:<user>"} --member <you>\`.`;
}

/** What the clicker is told when the store keeps no session root to decide on. */
export const NO_ROOT_ANSWER = "This daemon cannot check who may decide; use `crewhaus approvals`.";

/** What the clicker is told when the list of who may approve cannot be read. */
export const UNREADABLE_ANSWER =
  "This harness's list of who may approve cannot be read; rewrite it with `crewhaus access sync`.";

/** Where a decision was made, by the door it came through. */
export function whereDecided(via: string | undefined): string {
  if (via === "home") return "in Home";
  if (via === "cli") return "with `crewhaus approvals`";
  if (via === "slack") return "in Slack";
  return "elsewhere";
}

/** The request as it stands, in words: `Already granted in Home`. */
function currentState(record: PendingApproval | null | undefined, prefix: string): string {
  if (record === null || record === undefined) return "This request is not waiting for a decision.";
  const where = whereDecided(record.decidedVia);
  if (record.status === "grant") return `${prefix} granted ${where}.`;
  if (record.status === "deny") return `${prefix} denied ${where}.`;
  return "This request is not waiting for a decision.";
}

/** Where to review a request in full, in words. */
function reviewAnswer(review: ApprovalReview): string {
  return "url" in review
    ? `Review in Home before approving: ${review.url}`
    : `Review on ${review.host} before approving: \`${review.verb}\``;
}

/** The card's state line after this process decided. */
function decidedState(choice: "grant" | "deny", answer: ResolveAnswer): string {
  if (choice === "deny") return "Denied";
  if (answer.rule !== undefined) return "Approved, and allowed for 30 days";
  if (answer.proposal !== undefined) {
    return "Allowed once; the owner was asked to allow it from now on";
  }
  if (answer.ruleError !== undefined) return "Allowed once; no rule was made";
  return "Approved";
}

function invalidAnswer(reason: string | undefined): string {
  const words = (reason ?? "").replace(/^no standing rule can name this call: /, "");
  return `This call can't become a standing rule (${words}). Approve allows it once.`;
}

function isVia(value: string | undefined): value is ReceiptVia {
  return value !== undefined && (RECEIPT_VIA as readonly string[]).includes(value);
}

/** One stderr line for a step that failed off the request path. */
function report(step: string, err: unknown): void {
  process.stderr.write(`[gateway] approval ${step} error: ${(err as Error).message}\n`);
}

/**
 * A signature of the decision log's files (names, sizes, change times): it moves when a
 * decision is appended. `""` when the directory is absent or cannot be read.
 */
function logSignature(dir: string): string {
  try {
    return readdirSync(dir)
      .sort()
      .map((name) => {
        const st = statSync(join(dir, name));
        return `${name}:${st.size}:${st.mtimeMs}`;
      })
      .join("|");
  } catch {
    return "";
  }
}

/** `fs.watch` on the decision log, and a one-second check of it, neither keeping the process alive. */
function watchDecisionLog(dir: string): DecisionWatch {
  const listeners: Array<() => void> = [];
  const fire = (): void => {
    for (const listener of listeners) listener();
  };
  let watcher: FSWatcher | undefined;
  const tryWatch = (): void => {
    if (watcher !== undefined) return;
    try {
      watcher = watch(dir, () => fire());
      watcher.unref();
      watcher.on("error", () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
  };
  tryWatch();
  let last = "";
  const timer = setInterval(() => {
    if (postedApprovalIds().length === 0) return;
    tryWatch();
    const now = logSignature(dir);
    if (now !== last) {
      last = now;
      fire();
    }
  }, 1_000);
  timer.unref();
  return {
    onChange: (cb) => {
      listeners.push(cb);
    },
    close: () => {
      clearInterval(timer);
      watcher?.close();
      watcher = undefined;
    },
  };
}

const OK = (): Response => new Response("ok", { status: 200 });

/** How many ids a process remembers deciding, so the watcher does not follow them up. */
const DECIDED_KEPT = 1_024;

/**
 * The per-daemon approval clicks: create once per gateway. See the module docblock.
 */
export function createApprovalActions<
  I extends ApprovalInteraction,
  A extends ApprovalActionAdapter<I>,
>(config: ApprovalActionsConfig<I, A>): ApprovalActions<I, A> {
  const harnessDir = config.harnessDir ?? process.cwd();
  const approvers = config.approvers ?? readApproverProjection;
  const now = config.now ?? (() => Date.now());
  const root = config.approvals.rootDir;
  /** Ids a click in this process is deciding now, and the latest ids it decided. */
  const deciding = new Set<string>();
  const decidedHere = new Set<string>();
  const markDecided = (id: string): void => {
    decidedHere.add(id);
    for (const oldest of decidedHere) {
      if (decidedHere.size <= DECIDED_KEPT) break;
      decidedHere.delete(oldest);
    }
  };

  const answer = (adapter: A, interaction: I, text: string): void => {
    queueMicrotask(() => {
      adapter
        .answerInteraction?.({ interaction, text })
        ?.catch((err: unknown) => report("answer", err));
    });
  };

  const resume = (approval: PendingApproval, adapter: A, via: ReceiptVia | undefined): void => {
    const trigger: Trigger = { kind: "approval-resume", ...(via !== undefined ? { via } : {}) };
    runWithScope(
      { trigger, ...(approval.runId !== undefined ? { continues: approval.runId } : {}) },
      () => config.sessionRouter.resumeApproval(approval, adapter),
    ).catch((err) => report("resume", err));
  };

  /**
   * The one adapter a grant made elsewhere continues a reply through, when there is one.
   * A card with buttons came from the one adapter that posts them and takes clicks.
   */
  const soleClickAdapter = (): A | undefined => {
    const takers = [...config.adapters.values()].filter((a) => a.parseInteraction !== undefined);
    return takers.length === 1 ? takers[0] : undefined;
  };

  // A decision made elsewhere on a card this process posted: one follow-up in its thread,
  // and on a grant on a card with buttons the waiting reply continues through the adapter
  // that posted it. A text card's grant waits for the next message in its conversation.
  let sweeping: Promise<void> = Promise.resolve();
  const followUp = async (): Promise<void> => {
    const ids = postedApprovalIds().filter((id) => !deciding.has(id) && !decidedHere.has(id));
    if (ids.length === 0) return;
    let byId: ReadonlyMap<string, PendingApproval>;
    try {
      byId = new Map((await config.approvals.list()).map((a) => [a.id, a]));
    } catch (err) {
      report("follow-up", err);
      return;
    }
    for (const id of ids) {
      const record = byId.get(id);
      if (record === undefined || record.status === "pending") continue;
      if (deciding.has(id) || decidedHere.has(id)) continue;
      const send = postedReply(id);
      const interactive = postedInteractively(id);
      forgetPosted(id);
      const where = whereDecided(record.decidedVia);
      const line = record.status === "grant" ? `Granted ${where}` : `Denied ${where}`;
      if (send !== undefined) await send(line).catch((err) => report("follow-up", err));
      if (record.status !== "grant" || !interactive) continue;
      const adapter = soleClickAdapter();
      if (adapter !== undefined) {
        resume(record, adapter, isVia(record.decidedVia) ? record.decidedVia : undefined);
      }
    }
  };
  const watcher =
    root !== undefined
      ? (config.watch ?? watchDecisionLog(join(root, "approvals.d", "decisions")))
      : undefined;
  watcher?.onChange(() => {
    sweeping = sweeping.then(followUp, followUp);
  });

  return {
    async handle(interaction, adapter) {
      if (root === undefined) {
        answer(adapter, interaction, NO_ROOT_ANSWER);
        return OK();
      }
      // 1. Who clicked, by the projection's links.
      const subject =
        adapter.id === "slack" && interaction.teamId !== undefined
          ? `slack:${interaction.teamId}:${interaction.userId}`
          : undefined;
      let read: ApproverRead;
      try {
        read = approvers(harnessDir);
      } catch {
        read = { state: "unreadable", reason: "it could not be read" };
      }
      if (read.state === "unreadable") {
        answer(adapter, interaction, UNREADABLE_ANSWER);
        return OK();
      }
      const principal =
        subject !== undefined && read.state === "present"
          ? read.projection.links.find((link) => link.external === subject)?.principal
          : undefined;
      if (principal === undefined) {
        answer(adapter, interaction, linkAnswer(subject));
        return OK();
      }
      const id = interaction.approvalId;
      if (deciding.has(id)) {
        answer(adapter, interaction, "This request is being decided now.");
        return OK();
      }
      deciding.add(id);
      let outcome: ResolveAnswer;
      let before: PendingApproval | null;
      try {
        // 2. Approve only what the whole card shows.
        before = await config.approvals.get(id);
        if (
          before !== null &&
          before.status === "pending" &&
          interaction.decision === "grant" &&
          before.fitsCard !== true
        ) {
          answer(adapter, interaction, reviewAnswer(approvalReview(id, harnessDir, approvers)));
          return OK();
        }
        // 3. Decide, as the member, on the store's own root.
        outcome = await resolveToolApproval(
          {
            harnessDir,
            rootDir: root,
            ref: id,
            choice: interaction.decision,
            who: { principal },
            storeActor: { principal, display: "slack" },
            storedBy: async () => principal,
            via: "slack",
            ...(interaction.always === true ? { always: true } : {}),
          },
          { now, approvers },
        );
        if (outcome.outcome === "decided") {
          markDecided(id);
          forgetPosted(id);
        }
      } catch (err) {
        report("decision", err);
        answer(
          adapter,
          interaction,
          "This request could not be decided here; use `crewhaus approvals`.",
        );
        return OK();
      } finally {
        deciding.delete(id);
      }
      // 4. The decision is on record: answer now, and do the rest off the path.
      const decided = outcome;
      const by = principal;
      queueMicrotask(() => {
        afterDecision(decided, interaction, adapter, before, by).catch((err) =>
          report("follow-up", err),
        );
      });
      return OK();
    },
    close() {
      watcher?.close();
    },
  };

  async function afterDecision(
    outcome: ResolveAnswer,
    interaction: I,
    adapter: A,
    before: PendingApproval | null,
    principal: string,
  ): Promise<void> {
    const id = interaction.approvalId;
    switch (outcome.outcome) {
      case "decided": {
        const record = await config.approvals.get(id).catch((err) => {
          report("read", err);
          return null;
        });
        const toolName = record?.toolName ?? before?.toolName;
        // The card update waits on Slack; nothing after it does.
        adapter
          .ackApproval?.({
            interaction,
            decision: interaction.decision,
            by: "slack",
            ...(toolName !== undefined ? { toolName } : {}),
            state: decidedState(interaction.decision, outcome),
          })
          ?.catch((err: unknown) => report("ack", err));
        if (config.auditSink !== undefined) {
          const always = interaction.decision === "grant" && outcome.rule !== undefined;
          await config.auditSink
            .append({
              kind: "approval_resolved",
              payload: {
                schemaVersion: 1,
                approvalId: id,
                ...(toolName !== undefined ? { toolName } : {}),
                ...(record !== null
                  ? { surface: record.surface, sessionId: record.sessionId }
                  : {}),
                decision: interaction.decision,
                by: principal,
                ...(always ? { always: true } : {}),
                ...(record?.decidedAt !== undefined ? { decidedAt: record.decidedAt } : {}),
              },
            })
            .catch((err) => report("audit", err));
        }
        if (interaction.decision === "grant" && record !== null && record.status === "grant") {
          resume(record, adapter, "slack");
        }
        return;
      }
      case "forbidden":
        answer(adapter, interaction, outcome.reason ?? "You cannot decide this request.");
        return;
      case "already-decided":
      case "stale":
        answer(adapter, interaction, currentState(await currentOf(id), "Already"));
        return;
      case "expired":
        answer(adapter, interaction, "This request expired before it was decided.");
        return;
      case "invalid":
        answer(adapter, interaction, invalidAnswer(outcome.reason));
        return;
      case "not-found":
        answer(adapter, interaction, "unknown approval");
        return;
    }
  }

  /** The request as it now stands, in the channel's shape. */
  async function currentOf(id: string): Promise<PendingApproval | null> {
    try {
      return await config.approvals.get(id);
    } catch (err) {
      report("read", err);
      return null;
    }
  }
}
