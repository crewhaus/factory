/**
 * The usage fold: which runs used an item, from the content-free lines the runtime appends,
 * the run ledger and the decision log. It shows what was in a run's context, not why a
 * decision was made.
 *
 * A line names its item by a keyed digest, so an item is joined by computing the digest its
 * ref gives under the harness's own key, and a harness without a readable key joins nothing.
 * What is not on record is said so: an item is `recorded: false`, a run is `not-recorded`
 * with the reason, and neither ever reads "used nothing". Reads only.
 */
import type {
  KnowledgeRunUsage,
  KnowledgeRunUse,
  KnowledgeUsage,
} from "@crewhaus/control-contract/knowledge";
import { knowledgeStoreOf } from "@crewhaus/control-contract/knowledge";
import {
  type RecordSource,
  controlPaths,
  harnessLedger,
  keyedDigest,
  readDigestKey,
  readRecordFile,
  retainedSegments,
  runsLedger,
  segmentRel,
} from "@crewhaus/control-records";
import { containedSessionRoot, readDecisionLog } from "@crewhaus/session-store";
import { isoOf } from "./adapters/types";
import type { FoldedItem, RecordRef } from "./model";

/** The label of a usage line's item digest: the runtime writes the same. A test holds it. */
export const KNOWLEDGE_ITEM_LABEL = "knowledge-item";

/** A segment rolls at 8 MiB and takes one line more; past this it is not one of ours. */
const SEGMENT_MAX_BYTES = 32 * 1024 * 1024;

const DIGEST_RE = /^[0-9a-f]{32}$/;
const VIAS: readonly unknown[] = ["recall", "tool", "tail", "retrieve"];
const STATUSES: readonly unknown[] = ["included", "warned", "redacted", "split-redacted"];

/** One use of one item. */
export type ItemUse = {
  readonly run: string;
  readonly at: string;
  readonly via: KnowledgeRunUse["via"];
  readonly status: KnowledgeRunUse["status"];
  readonly version?: number | string;
  readonly tool?: string;
};

/** An item's uses, newest first, and how many saw a version older than the current one. */
export type ItemUsage = KnowledgeUsage & {
  readonly uses: readonly ItemUse[];
  /** Runs that used it after it was corrected: they recorded a version before the current one. */
  readonly olderRuns: readonly string[];
};

/** A decision made in a run that used an item. */
export type RunDecision = {
  readonly decision: string;
  readonly run: string;
  readonly at: string;
  readonly tool: string;
};

/** The digest a usage line names an item by. */
export async function itemDigest(key: CryptoKey, ref: RecordRef): Promise<string> {
  const digest = await keyedDigest(key, KNOWLEDGE_ITEM_LABEL, [
    ref.store,
    ref.backend,
    ref.spec ?? "",
    ref.partition ?? "",
    ref.localId,
  ]);
  return digest.slice(0, 32);
}

type UsageLine = KnowledgeRunUse & { readonly run: string; readonly tool?: string };

/** Every line of a segmented log's retained segments, oldest first, and whether any is gone. */
function readLog(source: RecordSource): {
  readonly lines: readonly Record<string, unknown>[];
  readonly segments: number;
  readonly evicted: boolean;
} {
  const retained = retainedSegments(source);
  if (!retained.ok) return { lines: [], segments: 0, evicted: false };
  const lines: Record<string, unknown>[] = [];
  for (const seg of retained.segs) {
    const read = readRecordFile(source.root, segmentRel(source.records, seg), SEGMENT_MAX_BYTES);
    if (!read.ok) continue;
    for (const text of read.text.split("\n")) {
      if (text.trim() === "") continue;
      try {
        const value = JSON.parse(text) as unknown;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          lines.push(value as Record<string, unknown>);
        }
      } catch {
        // A torn line: the next append seals it.
      }
    }
  }
  return { lines, segments: retained.segs.length, evicted: retained.watermark > 0 };
}

function usageLine(raw: Record<string, unknown>): UsageLine | undefined {
  const { v, at, run, item, backend, version, via, status, tool } = raw;
  const store = knowledgeStoreOf(raw["store"]);
  const iso = isoOf(at);
  if (v !== 1 || iso === undefined || typeof run !== "string" || store === undefined) return;
  if (typeof item !== "string" || !DIGEST_RE.test(item)) return;
  if (backend !== "local" && backend !== "thredz") return;
  if (!VIAS.includes(via) || !STATUSES.includes(status)) return;
  return {
    at: iso,
    run,
    item,
    store,
    backend,
    via: via as KnowledgeRunUse["via"],
    status: status as KnowledgeRunUse["status"],
    ...(typeof version === "number" || typeof version === "string" ? { version } : {}),
    ...(typeof tool === "string" ? { tool } : {}),
  };
}

/** One harness's usage, folded once. */
export class UsageFold {
  /** Whether uses can be joined to items: there is a usage log, and the key that names its items. */
  readonly recorded: boolean;
  private readonly key: CryptoKey | undefined;
  private readonly hasLog: boolean;
  private readonly evicted: boolean;
  private readonly oldest: string | undefined;
  private readonly byItem: ReadonlyMap<string, readonly UsageLine[]>;
  private readonly byRun: ReadonlyMap<string, readonly UsageLine[]>;
  private readonly started: ReadonlyMap<string, string>;
  private readonly sessionRoot: string | undefined;

  private constructor(args: {
    readonly key: CryptoKey | undefined;
    readonly lines: readonly UsageLine[];
    readonly segments: number;
    readonly evicted: boolean;
    readonly started: ReadonlyMap<string, string>;
    readonly sessionRoot: string | undefined;
  }) {
    this.key = args.key;
    this.hasLog = args.segments > 0;
    this.recorded = args.key !== undefined && this.hasLog;
    this.evicted = args.evicted;
    // Several processes append, so the first line is not always the oldest.
    let oldest: string | undefined;
    for (const line of args.lines) if (oldest === undefined || line.at < oldest) oldest = line.at;
    this.oldest = oldest;
    this.started = args.started;
    this.sessionRoot = args.sessionRoot;
    const byItem = new Map<string, UsageLine[]>();
    const byRun = new Map<string, UsageLine[]>();
    const push = (map: Map<string, UsageLine[]>, at: string, line: UsageLine): void => {
      const list = map.get(at);
      if (list === undefined) map.set(at, [line]);
      else list.push(line);
    };
    for (const line of args.lines) {
      push(byItem, line.item, line);
      push(byRun, line.run, line);
    }
    this.byItem = byItem;
    this.byRun = byRun;
  }

  static async of(harnessDir: string): Promise<UsageFold> {
    const usage = readLog(
      harnessLedger(harnessDir, { dir: controlPaths(harnessDir).knowledgeUsageDir }),
    );
    const key = await readDigestKey(harnessDir);
    const started = new Map<string, string>();
    for (const row of readLog(runsLedger(harnessDir)).lines) {
      const { id, at } = row;
      const iso = isoOf(at);
      if (typeof id === "string" && iso !== undefined && !started.has(id)) started.set(id, iso);
    }
    return new UsageFold({
      key: key.state === "present" ? key.hmac : undefined,
      lines: usage.lines.flatMap((raw) => {
        const line = usageLine(raw);
        return line === undefined ? [] : [line];
      }),
      segments: usage.segments,
      evicted: usage.evicted,
      started,
      sessionRoot: containedSessionRoot(harnessDir, {}),
    });
  }

  /** How an item was used. A store no run records, or a customer's item, is not recorded. */
  async usageOf(folded: Pick<FoldedItem, "item" | "record">): Promise<ItemUsage> {
    const nothing = { runs: 0, uses: [], olderRuns: [] };
    if (folded.record === undefined || folded.item.scope.kind === "tenant") {
      return { ...nothing, recorded: false };
    }
    if (!this.recorded || this.key === undefined) return { ...nothing, recorded: false };
    const lines = this.byItem.get(await itemDigest(this.key, folded.record)) ?? [];
    const current = folded.item.version;
    const older = new Set<string>();
    for (const line of lines) {
      if (typeof current === "number" && typeof line.version === "number") {
        if (line.version < current) older.add(line.run);
      }
    }
    const uses = lines
      .map(({ run, at, via, status, version, tool }) => ({
        run,
        at,
        via,
        status,
        ...(version !== undefined ? { version } : {}),
        ...(tool !== undefined ? { tool } : {}),
      }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const last = uses[0]?.at;
    return {
      runs: new Set(uses.map((use) => use.run)).size,
      ...(last !== undefined ? { lastUsedAt: last } : {}),
      recorded: true,
      uses,
      olderRuns: [...older].sort(),
    };
  }

  /**
   * What one run used. `ids` names the items still known by their digests, so a use shows the
   * item it was.
   */
  runUsage(run: string, ids: ReadonlyMap<string, string> = new Map()): KnowledgeRunUsage {
    const lines = this.byRun.get(run);
    if (lines !== undefined) {
      return {
        state: "used",
        items: lines.map(({ run: _run, tool: _tool, ...use }) => {
          const id = ids.get(use.item);
          return { ...use, ...(id !== undefined ? { id } : {}) };
        }),
      };
    }
    if (!this.hasLog) return { state: "not-recorded", reason: "no-usage-log" };
    const started = this.started.get(run);
    const before =
      this.evicted && started !== undefined && (this.oldest === undefined || started < this.oldest);
    return { state: "not-recorded", reason: before ? "evicted" : "none-seen" };
  }

  /** The digest of every item given, so a run's uses can be named. */
  async digests(items: readonly FoldedItem[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (this.key === undefined) return out;
    for (const { item, record } of items) {
      if (record !== undefined) out.set(await itemDigest(this.key, record), item.id);
    }
    return out;
  }

  /** The decisions made in these runs, newest first. */
  decisionsIn(runs: readonly string[]): readonly RunDecision[] {
    const wanted = new Set(runs);
    if (wanted.size === 0 || this.sessionRoot === undefined) return [];
    return readDecisionLog(this.sessionRoot)
      .lines.map(({ line }) => line)
      .filter(
        (line) => line.event === "decide" && line.runId !== undefined && wanted.has(line.runId),
      )
      .map((line) => ({
        decision: line.decision,
        run: line.runId as string,
        at: line.at,
        tool: line.tool,
      }))
      .reverse();
  }
}

/** Fold one harness's usage. Reads only; a harness that recorded none answers that it did not. */
export async function foldUsage(harnessDir: string): Promise<UsageFold> {
  return UsageFold.of(harnessDir);
}
