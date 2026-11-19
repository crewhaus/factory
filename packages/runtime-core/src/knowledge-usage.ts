/**
 * Which knowledge a run used, and where it was kept.
 *
 * Three records, all ids and never text:
 *
 * - **`knowledge_read`** (the session log): one line per tool call that
 *   reported the knowledge items it returned (`ToolExecuteContext.recordReads`:
 *   Recall's facts, the wiki read tools' articles, Retrieve's documents), on
 *   the call's span, after its post-tool check. At most
 *   {@link KNOWLEDGE_READ_CAP} refs; `more` counts the rest.
 * - **the usage log** (`.crewhaus/run/knowledge/usage/NNNNNN.jsonl`, under the
 *   root the loop's control records live in): one content-free line per item
 *   the first time a run uses it by a route (`recall`, `tool`, `tail`,
 *   `retrieve`). The item is a keyed digest of where it lives
 *   ({@link KNOWLEDGE_ITEM_LABEL}), because an id such as a wiki slug can name
 *   a person.
 * - **the continuity tail's refs**: the focus, active plan and open goals the
 *   `<current_plan>` block rendered, recorded as usage and on the plan
 *   block of each `context_manifest`.
 *
 * Every record follows the run records' switch: written only when the loop
 * records (`recordsRun`), so `CREWHAUS_RUN_STAMPS=0` writes none. A ref whose
 * id is outside the run-record grammar is never written. Every write is best
 * effort: a failure warns once per loop and the run goes on.
 *
 * Text the runtime re-reads from earlier work is screened here too: the plan
 * tail is classified by line, by adjacent pair and as a whole at TrustOrigin
 * `"memory"` before the model reads it again ({@link readContinuityTail}).
 */
import { join } from "node:path";
import { append, harnessLedger, keyedDigest } from "@crewhaus/control-records";
import type {
  KnowledgeReadPayload,
  KnowledgeReadRef,
  KnowledgeReadStatus,
  RecalledItemStatus,
} from "@crewhaus/event-log";
import type { RunContext } from "@crewhaus/run-context";
import type { ToolReadRef } from "@crewhaus/tool-catalog";
import { screenRememberedLines } from "./project-memory";
import {
  type RecallNote,
  type RecalledRef,
  type RecordEvent,
  type RequestRegions,
  recordableRef,
} from "./run-records";

type Logger = RunContext["logger"];

/** The label of a usage line's item digest. The usage fold computes the same: a pin. */
export const KNOWLEDGE_ITEM_LABEL = "knowledge-item";

/** Where the usage log's segments live, relative to the loop's control-records root. */
export const KNOWLEDGE_USAGE_DIR = join(".crewhaus", "run", "knowledge", "usage");

/** The most refs one `knowledge_read` line lists; `more` counts the rest. */
export const KNOWLEDGE_READ_CAP = 64;

/** How a run came to use an item. */
export type KnowledgeVia = "recall" | "tool" | "tail" | "retrieve";

/** One usage line: an item one run used, by keyed digest, and what became of it. */
export type KnowledgeUsageLine = {
  readonly v: 1;
  readonly at: string;
  readonly run: string;
  readonly session: string;
  readonly execution?: string;
  /** The first 32 hex of the item's keyed digest ({@link knowledgeItemDigest}). */
  readonly item: string;
  readonly store: RecalledRef["store"];
  readonly backend: RecalledRef["backend"];
  readonly version?: number | string;
  readonly via: KnowledgeVia;
  readonly tool?: string;
  readonly toolUseId?: string;
  readonly status: RecalledItemStatus;
};

/**
 * An item's id in the usage log: the first 32 hex of
 * `keyedDigest(key, KNOWLEDGE_ITEM_LABEL, [store, backend, spec, partition, localId])`,
 * an absent `spec` or `partition` as `""`. The version is not part of it.
 */
export async function knowledgeItemDigest(key: CryptoKey, ref: RecalledRef): Promise<string> {
  const digest = await keyedDigest(key, KNOWLEDGE_ITEM_LABEL, [
    ref.store,
    ref.backend,
    ref.spec ?? "",
    ref.partition ?? "",
    ref.localId,
  ]);
  return digest.slice(0, 32);
}

// ---------------------------------------------------------------------------
// One tool call's reads
// ---------------------------------------------------------------------------

/** One reported item, checked against the ref grammar. */
type CollectedRead = { readonly ref: RecalledRef; readonly withheld: boolean };

/** The per-call collector the loop hands a tool as `recordReads`. */
export type ReadCollector = {
  readonly recordReads: (refs: ReadonlyArray<ToolReadRef>) => void;
  /** The refs reported so far, within the cap, and how many were past it. */
  collected(): { readonly reads: readonly CollectedRead[]; readonly more: number };
};

/**
 * A collector for one call: keeps each reported ref that fits the run-record
 * grammar (dropping the rest), once, up to {@link KNOWLEDGE_READ_CAP}, and
 * counts the fitting refs past the cap. Never throws to the tool.
 */
export function createReadCollector(): ReadCollector {
  const reads: CollectedRead[] = [];
  const seen = new Set<string>();
  let more = 0;
  return {
    recordReads(refs) {
      try {
        for (const raw of refs) {
          const ref = recordableRef(raw as RecalledRef);
          if (ref === null) continue;
          const withheld = (raw as { withheld?: unknown }).withheld === true;
          const key = `${JSON.stringify(ref)}\u0000${withheld}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (reads.length >= KNOWLEDGE_READ_CAP) {
            more += 1;
            continue;
          }
          reads.push({ ref, withheld });
        }
      } catch {
        // A malformed report records nothing; the tool's call goes on.
      }
    },
    collected: () => ({ reads: [...reads], more }),
  };
}

// ---------------------------------------------------------------------------
// The continuity tail, screened and by reference
// ---------------------------------------------------------------------------

/** One read of the continuity tail: its screened text, what it rendered, and the screen's outcome. */
export type ContinuityTailRead = {
  readonly text: string | null;
  readonly refs: readonly RecalledRef[];
  /** `redacted` when the screen withheld a line, `warned` when it flagged one, else `included`. */
  readonly status: KnowledgeReadStatus;
};

/**
 * Load the `<current_plan>` text, screen it at TrustOrigin `"memory"` by line,
 * by adjacent pair and as a whole ({@link screenRememberedLines}: what the
 * classifier redacts becomes its notice, every other line is unchanged), and
 * read the refs of what it rendered. The text is
 * model-authored working state from earlier turns and sessions, so it is
 * screened as remembered memory before the model reads it again. It is not
 * tagged into the run's lineage. A load or a classifier failure rejects, so
 * the caller keeps the text it had; a failed ref read gives no refs.
 */
export async function readContinuityTail(
  load: () => Promise<string | null>,
  tailRefs: (() => Promise<readonly RecalledRef[]>) | undefined,
  logger: Logger,
): Promise<ContinuityTailRead> {
  const loaded = await load();
  if (loaded === null) return { text: null, refs: [], status: "included" };
  const screened = await screenRememberedLines(loaded);
  if (screened.redacted > 0) {
    logger.warn("plan tail line withheld (prompt injection detected)", {
      lines: screened.redacted,
      rules: screened.rules,
    });
  }
  let refs: readonly RecalledRef[] = [];
  if (tailRefs !== undefined) {
    try {
      refs = await tailRefs();
    } catch (err) {
      logger.warn("continuity tail refs could not be read", { error: (err as Error).name });
    }
  }
  return {
    text: screened.text,
    refs,
    status: screened.redacted > 0 ? "redacted" : screened.warned > 0 ? "warned" : "included",
  };
}

/**
 * The request's continuity tail as the run records name it: the plan block
 * carries the refs of what it rendered, every other block only its text. The
 * request's own blocks never carry refs.
 */
export function tailRegions(
  tail: ReadonlyArray<{ readonly text: string }>,
  refs: readonly RecalledRef[] | undefined,
): RequestRegions["tail"] {
  return tail.map((b) =>
    refs !== undefined && refs.length > 0 && b.text.startsWith("<current_plan>")
      ? { text: b.text, refs }
      : { text: b.text },
  );
}

// ---------------------------------------------------------------------------
// The loop's recorder
// ---------------------------------------------------------------------------

/** One item used, and what became of it on the way to the model. */
type KnowledgeUse = {
  readonly ref: RecalledRef;
  readonly via: KnowledgeVia;
  readonly status: RecalledItemStatus;
};

/** The knowledge usage recorder one loop holds. */
export type KnowledgeUsage = {
  /** A collector for one tool call, or `undefined` when this loop records nothing. */
  collector(): ReadCollector | undefined;
  /** An auto-recall ran: one usage line per item with a ref, at its own status. */
  noteRecall(note: RecallNote): Promise<void>;
  /** The continuity tail was (re)loaded: one usage line per item it rendered. */
  noteTail(read: ContinuityTailRead): Promise<void>;
  /**
   * A tool call returned, its output past the post-tool check: the
   * `knowledge_read` line on the call's span and one usage line per item.
   * Nothing for an error result, a call whose output the loop does not
   * classify (`Task`), or a call that reported nothing.
   */
  noteToolRead(call: {
    readonly tool: string;
    readonly toolUseId: string;
    readonly span: string;
    readonly collector: ReadCollector | undefined;
    readonly status: KnowledgeReadStatus;
    readonly isError: boolean;
    readonly classified: boolean;
  }): Promise<void>;
};

/** First uses per run: `(item, version, via)` keys a run has written. */
const usedByRun = new WeakMap<RunContext, Set<string>>();

/**
 * The loop's recorder. `records` is whether the loop writes run records
 * (`recordsRun`); `usageRoot` is where its control records live, or
 * `undefined` where it writes none of its own (a run with no ledger, or one
 * inside a tenant context), which keeps the `knowledge_read` lines and writes
 * no usage line. `digestKey` is the loop's one key resolution, shared with
 * its manifest recorder; without a key no usage line is written, and that is
 * logged once.
 */
export function createKnowledgeUsage(args: {
  readonly runContext: RunContext;
  readonly records: boolean;
  readonly write: RecordEvent;
  readonly usageRoot: string | undefined;
  readonly digestKey: () => Promise<CryptoKey | undefined>;
  readonly sessionId: string;
  readonly execution: () => string | undefined;
}): KnowledgeUsage {
  const { runContext } = args;
  const logger = runContext.logger;
  let warnedNoKey = false;
  let warnedWrite = false;
  const usageLedger =
    args.usageRoot !== undefined
      ? harnessLedger(args.usageRoot, { dir: KNOWLEDGE_USAGE_DIR })
      : undefined;

  const writeUsage = async (
    uses: readonly KnowledgeUse[],
    call?: {
      readonly tool: string;
      readonly toolUseId: string;
    },
  ): Promise<void> => {
    if (!args.records || usageLedger === undefined || uses.length === 0) return;
    try {
      const key = await args.digestKey();
      if (key === undefined) {
        if (!warnedNoKey) {
          warnedNoKey = true;
          logger.warn("knowledge usage was not recorded: the harness digest key could not be used");
        }
        return;
      }
      let used = usedByRun.get(runContext);
      if (used === undefined) {
        used = new Set();
        usedByRun.set(runContext, used);
      }
      const execution = args.execution();
      for (const use of uses) {
        const item = await knowledgeItemDigest(key, use.ref);
        const first = `${item}\u0000${use.ref.version ?? ""}\u0000${use.via}`;
        if (used.has(first)) continue;
        used.add(first);
        const line: KnowledgeUsageLine = {
          v: 1,
          at: new Date().toISOString(),
          run: runContext.runId,
          session: args.sessionId,
          ...(execution !== undefined ? { execution } : {}),
          item,
          store: use.ref.store,
          backend: use.ref.backend,
          ...(use.ref.version !== undefined ? { version: use.ref.version } : {}),
          via: use.via,
          ...(call !== undefined ? { tool: call.tool, toolUseId: call.toolUseId } : {}),
          status: use.status,
        };
        const written = append(usageLedger, line);
        if (!written.ok && !warnedWrite) {
          warnedWrite = true;
          logger.warn("knowledge usage could not be written; the run goes on without it", {
            code: written.code,
          });
        }
      }
    } catch (err) {
      if (!warnedWrite) {
        warnedWrite = true;
        logger.warn("knowledge usage could not be written; the run goes on without it", {
          code: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  };

  return {
    collector: () => (args.records ? createReadCollector() : undefined),
    async noteRecall(note) {
      const uses: KnowledgeUse[] = [];
      note.items.forEach((item, i) => {
        const ref = recordableRef(item.ref);
        if (ref === null) return;
        uses.push({ ref, via: "recall", status: note.outcomes[i]?.status ?? "included" });
      });
      await writeUsage(uses);
    },
    async noteTail(read) {
      const uses: KnowledgeUse[] = [];
      for (const raw of read.refs) {
        const ref = recordableRef(raw);
        if (ref !== null) uses.push({ ref, via: "tail", status: read.status });
      }
      await writeUsage(uses);
    },
    async noteToolRead(call) {
      if (!args.records || call.collector === undefined) return;
      if (call.isError || !call.classified) return;
      const { reads, more } = call.collector.collected();
      if (reads.length === 0) return;
      const refs: KnowledgeReadRef[] = reads.map((r) => r.ref);
      const payload: KnowledgeReadPayload = {
        v: 1,
        run: runContext.runId,
        toolUseId: call.toolUseId,
        tool: call.tool,
        refs,
        ...(more > 0 ? { more } : {}),
        status: call.status,
      };
      await args.write("knowledge_read", payload, call.span);
      await writeUsage(
        reads.map((r) => ({
          ref: r.ref,
          via: r.ref.store === "document" ? "retrieve" : "tool",
          status: r.withheld ? "redacted" : call.status,
        })),
        { tool: call.tool, toolUseId: call.toolUseId },
      );
    },
  };
}
