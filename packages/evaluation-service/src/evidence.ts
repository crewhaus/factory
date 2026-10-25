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
  type InputSchemaLookup,
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
  /**
   * The input schema each tool the run has declares — the gate's own
   * catalog, where the interpreter and the eval runner register their MCP
   * tools (`defaultCatalog` holds them only in a compiled harness). An MCP
   * call's origin is a field its schema declares, so a stray `url` beside a
   * file server's `paths` grounds nothing (provability `mcpOrigins`).
   * Absent ⇒ provability looks in `defaultCatalog`.
   */
  readonly inputSchemaOf?: InputSchemaLookup;
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
  return buildEvidenceIndex(await gateRecords(input), parentOf(input));
}

/**
 * What the gate's records of the turn carry as their turn under `scope:
 * turn` ({@link gateEvidenceScoped}): a label for "the turn being graded",
 * never a number the log recorded.
 */
const GRADED_TURN = 0;

/**
 * The evidence as the verifier takes it: the index, and under `scope: turn`
 * the turn it keeps (`VerifyOptions.turnNumbers`, which tool-proof's
 * preflight forwards the same way). Under `scope: session` it is
 * {@link gateEvidence}'s index alone.
 *
 * Under `scope: turn` the index holds the WHOLE session, the current turn's
 * calls marked as the graded turn and every earlier one unmarked, so the
 * verifier's restriction leaves grounding exactly where {@link gateEvidence}
 * leaves it — a page an earlier turn fetched grounds nothing — while its
 * self-written trace (`writtenBy`, `storedText`), which reads every call the
 * index holds, still sees a file the session wrote in an earlier turn. A
 * turn-only index hid that write, and the run's own text read back in the
 * next turn was served as an outside source (design §10; I9).
 */
export async function gateEvidenceScoped<M extends EvidenceMessage>(
  input: GateEvidenceInput<M>,
): Promise<{ readonly index: EvidenceIndex; readonly turnNumbers?: ReadonlySet<number> }> {
  if (input.scope !== "turn") return { index: await gateEvidence(input) };
  const inTurn = await gateRecords(input);
  const session = await gateRecords({ ...input, scope: "session" });
  const ofTurn = new Set(inTurn.map(callOf));
  // In the session's call order: the self-written trace reads a writer only
  // where it ran before the read.
  const records: EvidenceRecord[] = session.map(({ turnNumber: _logged, ...record }) =>
    ofTurn.has(callOf(record)) ? { ...record, turnNumber: GRADED_TURN } : record,
  );
  // A call of the turn the session walk did not reach still grounds as it would have.
  const ofSession = new Set(session.map(callOf));
  for (const record of inTurn) {
    if (!ofSession.has(callOf(record))) records.push({ ...record, turnNumber: GRADED_TURN });
  }
  return {
    index: buildEvidenceIndex(records, parentOf(input)),
    turnNumbers: new Set([GRADED_TURN]),
  };
}

/** One call's key: its session and its id. */
const callOf = (record: EvidenceRecord): string =>
  `${record.sessionId ?? ""}\u0000${record.toolUseId}`;

/** The parent session, named so a child's call never answers the parent's `tool:<id>`. */
const parentOf = (input: { readonly sessionId?: string }): { sessionId?: string } =>
  input.sessionId !== undefined ? { sessionId: input.sessionId } : {};

/** {@link gateEvidence}'s records, before they are indexed. */
async function gateRecords<M extends EvidenceMessage>(
  input: GateEvidenceInput<M>,
): Promise<EvidenceRecord[]> {
  const records: EvidenceRecord[] = [];
  if (input.sessionId !== undefined) {
    const fromLog = await sessionEvidence({
      scope: input.scope,
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      ...(input.toolResultsRoot !== undefined ? { toolResultsRoot: input.toolResultsRoot } : {}),
      ...(input.sessionRootDir !== undefined ? { rootDir: input.sessionRootDir } : {}),
      ...(input.onUnreadable !== undefined ? { onUnreadable: input.onUnreadable } : {}),
      ...(input.inputSchemaOf !== undefined ? { inputSchemaOf: input.inputSchemaOf } : {}),
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
        // The transcript is the parent's: its calls are the session's own.
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.inputSchemaOf !== undefined ? { inputSchemaOf: input.inputSchemaOf } : {}),
      }),
    );
  }
  // The parent is named (`parentOf`) when these are indexed, never inferred
  // from whichever record came first: a child's call logged ahead of the
  // parent's would otherwise answer the parent's `tool:<id>` (design §6.3,
  // as `resolveEvidence` reads ids).
  return records;
}
