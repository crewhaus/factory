/**
 * The evidence index the gate verifies against — and, through the same
 * function, the one `ProvabilityPreflight` checks a draft against, so the
 * model sees exactly what the gate will see (design §5.2, §7).
 *
 * Two sources, merged into one record per call:
 *
 *   - the session EVENT LOG (children included, via `@crewhaus/tool-proof`'s
 *     `sessionEvidence`): it records every `tool_use` input and `tool_result`
 *     output verbatim, and compaction cannot evict from it, so `scope:
 *     session` keeps grounding a claim on a page fetched twenty turns and two
 *     compactions ago;
 *   - the in-memory TRANSCRIPT the runtime hands the verifier
 *     (`evidenceFromMessages`): it carries a block-content result in full
 *     where the log holds runtime-core's one-line summary of it, and it is
 *     the only source for a run with no session log. A preflight runs
 *     mid-turn with no transcript to hand and reads the log alone, which
 *     already holds every call the turn has finished.
 *
 * `scope: turn` keeps only the CURRENT turn's calls. The log records no turn
 * number on a call, so the turn is read off the conversation itself, the same
 * way in both sources: everything after the last REAL user message. A
 * runtime-injected user message — a retry nudge, a cascade correction, a
 * continue prompt (`turn.isSynthetic` on the transcript, `synthetic: true` in
 * the log) — does not start a turn, so evidence the first attempt gathered
 * still counts on the retry the gate itself triggered; nor does the
 * tool-result carrier the runtime sends as a user message. A sub-agent
 * started inside the turn counts whole (its calls ran for this turn).
 */
import {
  type EvidenceIndex,
  type EvidenceMessage,
  type EvidenceRecord,
  buildEvidenceIndex,
  evidenceFromMessages,
} from "@crewhaus/provability";
import { sessionEvidence } from "@crewhaus/tool-proof";

export type GateEvidenceInput<M extends EvidenceMessage = EvidenceMessage> = {
  readonly scope: "session" | "turn";
  /** The run's session; absent ⇒ the transcript is the only source. */
  readonly sessionId?: string;
  /** Where session `.jsonl` logs live (resolved; undefined ⇒ event-log's default). */
  readonly sessionRootDir?: string;
  /** Workspace root path-shaped inputs are measured from. */
  readonly workspaceRoot: string;
  /**
   * Where the runtime spilled results too long for the log — the active
   * tenant's `toolResultRoot` inside a tenant scope; absent ⇒
   * `<workspace>/.crewhaus/tool-results` — so a spilled page is graded whole,
   * not on its preview.
   */
  readonly toolResultsRoot?: string;
  /** The transcript as of turn completion (the gate); absent for a preflight. */
  readonly messages?: ReadonlyArray<M>;
  /** The runtime's synthetic-message test (`EvaluationTurn.isSynthetic`). */
  readonly isSynthetic?: (message: M) => boolean;
  /** Told when a session log could not be read to its end. */
  readonly onUnreadable?: (info: { readonly sessionId: string; readonly message: string }) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Does `message` start a turn: a user message the human sent — not one the
 * runtime injected, and not the carrier of a batch of tool results? (The
 * transcript twin of tool-proof's `startsTurn`, which reads the log.)
 */
export function startsTurnMessage<M extends EvidenceMessage>(
  message: M,
  isSynthetic?: (message: M) => boolean,
): boolean {
  if (message.role !== "user") return false;
  try {
    if (isSynthetic?.(message) === true) return false;
  } catch {
    // A membership test that throws cannot say the message is synthetic.
  }
  const content = message.content;
  if (typeof content === "string" || content.length === 0) return true;
  return !content.every((block) => isRecord(block) && block["type"] === "tool_result");
}

/** The messages of the current turn: from the last real user message on (all of them when there is none). */
export function currentTurnMessages<M extends EvidenceMessage>(
  messages: ReadonlyArray<M>,
  isSynthetic?: (message: M) => boolean,
): ReadonlyArray<M> {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as M;
    if (startsTurnMessage(message, isSynthetic)) return messages.slice(i);
  }
  return messages;
}

/**
 * The index for one verification (or one preflight): the log's records
 * first — the log wins where the two disagree, except over its own summary
 * of block content — then the transcript's, each scoped as the config says.
 */
export async function gateEvidence<M extends EvidenceMessage>(
  input: GateEvidenceInput<M>,
): Promise<EvidenceIndex> {
  const records: EvidenceRecord[] = [];
  if (input.sessionId !== undefined) {
    const fromLog = await sessionEvidence({
      scope: input.scope,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      ...(input.toolResultsRoot !== undefined ? { toolResultsRoot: input.toolResultsRoot } : {}),
      ...(input.sessionRootDir !== undefined ? { rootDir: input.sessionRootDir } : {}),
      ...(input.onUnreadable !== undefined ? { onUnreadable: input.onUnreadable } : {}),
    });
    records.push(...fromLog.index.all());
  }
  if (input.messages !== undefined && input.messages.length > 0) {
    const scoped =
      input.scope === "turn"
        ? currentTurnMessages(input.messages, input.isSynthetic)
        : input.messages;
    records.push(
      ...evidenceFromMessages(scoped, {
        workspaceRoot: input.workspaceRoot,
        ...(input.toolResultsRoot !== undefined ? { toolResultsRoot: input.toolResultsRoot } : {}),
      }),
    );
  }
  return buildEvidenceIndex(records);
}
