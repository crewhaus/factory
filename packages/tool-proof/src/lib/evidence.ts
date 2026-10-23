/**
 * The evidence index the proof tools read when nobody injects one: the
 * run's own session event log (design §5.2).
 *
 * The log is the gate's source too — it records every `tool_use` (full
 * input) and `tool_result` (full output) verbatim, children included, and
 * compaction cannot evict from it. A preflight runs mid-turn, after the
 * turn's earlier calls were logged (runtime-core appends `tool_use` before a
 * call runs and `tool_result` when it returns), so the draft is checked
 * against everything the run has read so far. The composition root injects
 * its own builder (the log merged with the in-memory transcript), which is
 * what makes the gate and the tools agree exactly; this default is for the
 * builtin instances.
 *
 * `scope: turn` (design §3) keeps only the current turn's calls. The log
 * records no turn number on a call, so the turn is read the way the gate
 * reads it from the transcript: everything after the last REAL user message
 * — not a runtime-injected one (`synthetic: true`: a retry nudge, a
 * recovery note) and not the tool-result carrier the runtime logs as a user
 * message. Sub-agents started in the turn count whole: their calls ran for
 * it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ROOT_DIR, openEventLog } from "@crewhaus/event-log";
import {
  type EvidenceIndex,
  type EvidenceRecord,
  buildEvidenceIndex,
  evidenceFromSessionLog,
} from "@crewhaus/provability";
import { clip } from "./check";

const SESSION_ID_REGEX = /^sess_[0-9a-f]{16}$/;
/** How many unreadable logs the note names; it counts the rest. */
const UNREADABLE_NAMED = 3;
/** How much of the first unreadable log's error the note quotes. */
const UNREADABLE_MESSAGE_CHARS = 200;
/** One less than the walk's own bound: a child started in the turn is already one level down. */
const CHILD_MAX_DEPTH = 7;

export type SessionEvidenceOptions = {
  /** The run's session; absent ⇒ an empty index (nothing reachable was read). */
  readonly sessionId?: string;
  /** Where session `.jsonl` logs live (default `.crewhaus/sessions`, cwd-relative, as the runtime writes them). */
  readonly rootDir?: string;
  /** Workspace root for path-shaped inputs (default `process.cwd()`). */
  readonly workspaceRoot?: string;
  /**
   * Where the runtime spilled results too long for the log (the tenant's
   * `toolResultRoot` inside a tenant scope; default `.crewhaus/tool-results`
   * under the workspace), so a spilled page is read whole.
   */
  readonly toolResultsRoot?: string;
  /** `session` (every call the run made) or `turn` (the current turn's). */
  readonly scope: "session" | "turn";
  /** Told when a log could not be read to its end (records before it are kept). */
  readonly onUnreadable?: (info: { readonly sessionId: string; readonly message: string }) => void;
};

/** The index, plus what a reader of the preflight should know about how it was built. */
export type SessionEvidence = {
  readonly index: EvidenceIndex;
  readonly notes: ReadonlyArray<string>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Is a logged `user_message` payload the user's own message — the start of a
 * turn? Runtime-injected messages carry `synthetic: true`, and the runtime
 * logs each batch of tool results as a user message whose content is only
 * `tool_result` blocks; neither starts a turn.
 */
export function startsTurn(payload: unknown): boolean {
  if (!isRecord(payload) || payload["synthetic"] === true) return false;
  const content = payload["content"];
  if (!Array.isArray(content)) return true;
  if (content.length === 0) return true;
  return !content.every((block) => isRecord(block) && block["type"] === "tool_result");
}

/**
 * The current turn of a session log: the ids of the calls made after the
 * last real user message, and the sub-agent sessions started after it.
 * Reading never creates the log directory; a missing log is an empty turn.
 * A log that cannot be read to its end keeps what was read before it.
 */
export async function currentTurn(opts: {
  readonly sessionId: string;
  readonly rootDir: string;
  readonly onUnreadable?: SessionEvidenceOptions["onUnreadable"];
}): Promise<{ readonly toolUseIds: ReadonlySet<string>; readonly children: readonly string[] }> {
  const toolUseIds = new Set<string>();
  let children: string[] = [];
  if (!existsSync(join(opts.rootDir, `${opts.sessionId}.jsonl`))) {
    return { toolUseIds, children };
  }
  const log = await openEventLog(opts.sessionId, { rootDir: opts.rootDir });
  try {
    for await (const event of log.read()) {
      const p = event.payload;
      if (event.kind === "user_message") {
        if (startsTurn(p)) {
          toolUseIds.clear();
          children = [];
        }
      } else if (event.kind === "tool_use" && isRecord(p) && typeof p["id"] === "string") {
        toolUseIds.add(p["id"]);
      } else if (event.kind === "sub_agent_start" && isRecord(p)) {
        const child = p["childSessionId"];
        if (
          typeof child === "string" &&
          SESSION_ID_REGEX.test(child) &&
          !children.includes(child)
        ) {
          children.push(child);
        }
      }
    }
  } catch (err) {
    opts.onUnreadable?.({
      sessionId: opts.sessionId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await log.close();
  }
  return { toolUseIds, children };
}

/**
 * One note for every log that could not be read to its end, however many
 * there were: a run whose sub-agents crashed mid-append can leave dozens of
 * torn logs, and a note per log would crowd the preflight's instructions out
 * of the report. Each log is still reported to `onUnreadable` on its own.
 */
function unreadableNote(unreadable: ReadonlyMap<string, string>): string[] {
  const ids = [...unreadable.keys()];
  const [first] = ids;
  if (first === undefined) return [];
  const why = clip(unreadable.get(first) ?? "", UNREADABLE_MESSAGE_CHARS);
  if (ids.length === 1) {
    return [
      `the session log ${first} could not be read to its end (${why}); only the calls before that point count`,
    ];
  }
  const named = ids.slice(0, UNREADABLE_NAMED);
  const rest = ids.length - named.length;
  return [
    `${ids.length} session logs could not be read to their end (${named.join(", ")}${
      rest > 0 ? `, and ${rest} more` : ""
    }; the first: ${why}); in each, only the calls before that point count`,
  ];
}

/** The evidence index over a session's log, scoped as the config says. */
export async function sessionEvidence(opts: SessionEvidenceOptions): Promise<SessionEvidence> {
  if (opts.sessionId === undefined || !SESSION_ID_REGEX.test(opts.sessionId)) {
    return {
      index: buildEvidenceIndex([]),
      notes: [
        "no session log is reachable from this call (it carries no run context), so no source counts as fetched and no tool result as run",
      ],
    };
  }
  const rootDir = opts.rootDir ?? DEFAULT_ROOT_DIR;
  // Each unreadable log once, with its first error: the parent log is read
  // twice under `scope: turn` (the turn, then its records).
  const unreadable = new Map<string, string>();
  const onUnreadable: NonNullable<SessionEvidenceOptions["onUnreadable"]> = (info) => {
    if (!unreadable.has(info.sessionId)) unreadable.set(info.sessionId, info.message);
    opts.onUnreadable?.(info);
  };
  const common = {
    rootDir,
    onUnreadable,
    ...(opts.workspaceRoot !== undefined ? { workspaceRoot: opts.workspaceRoot } : {}),
    ...(opts.toolResultsRoot !== undefined ? { toolResultsRoot: opts.toolResultsRoot } : {}),
  };
  if (opts.scope === "session") {
    const records = await evidenceFromSessionLog({ sessionId: opts.sessionId, ...common });
    return {
      index: buildEvidenceIndex(records, { sessionId: opts.sessionId }),
      notes: unreadableNote(unreadable),
    };
  }
  const turn = await currentTurn({ sessionId: opts.sessionId, rootDir, onUnreadable });
  const own = await evidenceFromSessionLog({
    sessionId: opts.sessionId,
    includeChildren: false,
    ...common,
  });
  const records: EvidenceRecord[] = own.filter((r) => turn.toolUseIds.has(r.toolUseId));
  for (const child of turn.children) {
    records.push(
      ...(await evidenceFromSessionLog({
        sessionId: child,
        maxDepth: CHILD_MAX_DEPTH,
        ...common,
      })),
    );
  }
  // The parent named, so a child's call never answers the parent's id.
  return {
    index: buildEvidenceIndex(records, { sessionId: opts.sessionId }),
    notes: unreadableNote(unreadable),
  };
}
