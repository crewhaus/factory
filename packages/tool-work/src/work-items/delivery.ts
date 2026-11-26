/**
 * What an item's delivery records say, for a reader: where the publish attempts and the pull
 * request outcomes live, and a fold of each that takes no lock and writes nothing. The
 * engine that writes them is `../workspace`; this half is what the status table needs, so a
 * reader of work items never loads the engine.
 *
 * - Publish attempts: `.crewhaus/run/control/work/publish/NNNNNN.jsonl`, `id` `<wi>:<n>`,
 *   on the `work-publish` machine.
 * - Outcomes: `.crewhaus/run/control/work/outcomes/NNNNNN.jsonl`, `id` the item, on the
 *   `work-pr` machine.
 * - Workspaces: `.crewhaus/run/control/work/workspaces/NNNNNN.jsonl`, `id` the item, on the
 *   `workspace` machine.
 *
 * Every line is content-free: ids, SHAs, codes, counts and times.
 */
import { join } from "node:path";
import {
  type CursorPosition,
  WORK_PR_LOG_KEYS,
  WORK_PUBLISH_LOG_KEYS,
  type WorkPrReview,
  type WorkPrState,
  type WorkPublishCode,
  type WorkPublishState,
  type WorkPublishVerdict,
  type WorkPublishWhy,
  type WorkspaceEvent,
  type WorkspaceState,
  canTransition,
  isId,
} from "@crewhaus/control-contract";
import { type Ledger, harnessLedger, readPage } from "@crewhaus/control-records";
import { workDirOf } from "./records";
import type { WorkStateFacts } from "./state";

export function workspacesLedger(harnessDir: string): Ledger {
  return harnessLedger(
    harnessDir,
    { dir: join(workDirOf(harnessDir), "workspaces") },
    { machine: "workspace" },
  );
}

export function publishLedger(harnessDir: string): Ledger {
  return harnessLedger(
    harnessDir,
    { dir: join(workDirOf(harnessDir), "publish") },
    { machine: "work-publish" },
  );
}

export function outcomesLedger(harnessDir: string): Ledger {
  return harnessLedger(
    harnessDir,
    { dir: join(workDirOf(harnessDir), "outcomes") },
    { machine: "work-pr" },
  );
}

/** One workspace line. Keys are `WORKSPACE_LOG_KEYS`. */
export type WorkspaceLine = {
  readonly v: 1;
  readonly at: string;
  readonly id: string;
  readonly state: WorkspaceState;
  readonly event: WorkspaceEvent;
  readonly by: string;
  readonly via: string;
  readonly run?: string;
  readonly binding: string;
  readonly branch: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  /** Each declared check's exit status, by its place in the binding's list. */
  readonly results?: readonly { readonly k: number; readonly exit: number }[];
  readonly wip?: boolean;
};

/** One publish attempt line. Keys are `WORK_PUBLISH_LOG_KEYS`; fields accumulate. */
export type PublishLine = {
  readonly v: 1;
  readonly at: string;
  readonly id: string;
  readonly wi: string;
  readonly attempt: number;
  readonly state: WorkPublishState;
  readonly by: string;
  readonly via: string;
  readonly cmd?: string;
  readonly run?: string;
  readonly branch?: string;
  readonly baseSha?: string;
  /** The branch commit whose tree every gate read. */
  readonly headSha?: string;
  /** The one commit pushed: that tree on the base, with the publish's own message. */
  readonly pushedSha?: string;
  readonly pr?: number;
  readonly code?: WorkPublishCode;
  /** The cause behind `code`, where the code alone does not say what to do. */
  readonly why?: WorkPublishWhy;
  /** A keyed digest of the file a refusal names; the name is in the check log. */
  readonly file?: string;
  readonly line?: number;
  readonly files?: number;
  readonly lines?: number;
  readonly verdict?: WorkPublishVerdict;
  /** The file that holds the acceptance check's reasons, beside the check logs. */
  readonly reasons?: string;
  readonly lineage?: "pass";
  readonly rebased?: true;
};

/** One outcome line. Keys are `WORK_PR_LOG_KEYS`. */
export type OutcomeLine = {
  readonly v: 1;
  readonly at: string;
  readonly id: string;
  readonly pr: number;
  readonly state: WorkPrState;
  readonly review?: WorkPrReview;
  readonly headSha?: string;
  readonly mergeSha?: string;
  readonly changed?: true;
  readonly reverted?: true;
  readonly delivery?: string;
  readonly by: string;
};

const PAGE = 1000;

/** A ledger's lines in file order. A line that cannot be read is skipped and counted. */
export function readLedgerLines(ledger: Ledger): {
  readonly lines: readonly Readonly<Record<string, unknown>>[];
  readonly gaps: number;
} {
  const newestFirst: Readonly<Record<string, unknown>>[] = [];
  let gaps = 0;
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, { limit: PAGE, ...(before !== undefined ? { before } : {}) });
    gaps += page.gaps.length;
    for (const item of page.items) newestFirst.push(item.record);
    if (page.next === undefined) break;
    before = page.next;
  }
  return { lines: newestFirst.reverse(), gaps };
}

function legal(
  machine: "workspace" | "work-publish" | "work-pr",
  from: string | undefined,
  to: unknown,
  entry: readonly string[],
): boolean {
  if (typeof to !== "string") return false;
  return from === undefined ? entry.includes(to) : canTransition(machine, from, to);
}

/** A folded publish attempt: its newest legal line. */
export type FoldedAttempt = PublishLine;

/** Every attempt of every item, oldest first per item. A line the machine refuses is skipped. */
export function readAttempts(harnessDir: string): ReadonlyMap<string, readonly FoldedAttempt[]> {
  const byId = new Map<string, FoldedAttempt>();
  for (const raw of readLedgerLines(publishLedger(harnessDir)).lines) {
    const line = raw as unknown as PublishLine;
    if (
      typeof line.id !== "string" ||
      !isId("wi", line.wi) ||
      !Number.isSafeInteger(line.attempt) ||
      line.id !== `${line.wi}:${line.attempt}`
    ) {
      continue;
    }
    const current = byId.get(line.id);
    if (!legal("work-publish", current?.state, line.state, ["started"])) continue;
    byId.set(line.id, { ...current, ...line });
  }
  const out = new Map<string, FoldedAttempt[]>();
  for (const attempt of byId.values()) {
    const list = out.get(attempt.wi) ?? [];
    list.push(attempt);
    out.set(attempt.wi, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.attempt - b.attempt);
  return out;
}

/** Every item's pull request, as the tracker last recorded it. */
export function readOutcomes(harnessDir: string): ReadonlyMap<string, OutcomeLine> {
  const out = new Map<string, OutcomeLine>();
  for (const raw of readLedgerLines(outcomesLedger(harnessDir)).lines) {
    const line = raw as unknown as OutcomeLine;
    if (!isId("wi", line.id) || !Number.isSafeInteger(line.pr)) continue;
    const current = out.get(line.id);
    // A new pull request for the item starts over.
    const from = current !== undefined && current.pr === line.pr ? current.state : undefined;
    if (!legal("work-pr", from, line.state, ["open", "merged", "closed"])) continue;
    out.set(line.id, line);
  }
  return out;
}

/** An item's workspace: its newest line, and the results recorded for each head SHA. */
export type FoldedWorkspace = {
  readonly id: string;
  readonly state: WorkspaceState;
  readonly binding: string;
  readonly branch: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly wip?: boolean;
  readonly at: string;
  /** The newest recorded results per head SHA. */
  readonly results: ReadonlyMap<string, readonly { readonly k: number; readonly exit: number }[]>;
};

export function readWorkspaces(harnessDir: string): ReadonlyMap<string, FoldedWorkspace> {
  const out = new Map<string, FoldedWorkspace>();
  for (const raw of readLedgerLines(workspacesLedger(harnessDir)).lines) {
    const line = raw as unknown as WorkspaceLine;
    if (!isId("wi", line.id)) continue;
    const current = out.get(line.id);
    if (!legal("workspace", current?.state, line.state, ["open"])) continue;
    const results = new Map(current?.results ?? []);
    if (line.event === "checked" && line.headSha !== undefined && Array.isArray(line.results)) {
      results.set(line.headSha, line.results);
    }
    const { baseSha, headSha, wip } = { ...current, ...line };
    out.set(line.id, {
      id: line.id,
      state: line.state,
      binding: line.binding,
      branch: line.branch,
      ...(baseSha !== undefined ? { baseSha } : {}),
      ...(headSha !== undefined ? { headSha } : {}),
      ...(wip !== undefined ? { wip } : {}),
      at: line.at,
      results,
    });
  }
  return out;
}

/** The delivery facts the status table reads, per item. */
export type DeliveryFacts = Pick<WorkStateFacts, "pr" | "publish">;

/**
 * Each item's newest publish attempt and pull request. An attempt that opened a pull request
 * the tracker has not looked at yet reads as open: the host said so when it answered.
 */
export function readDeliveryFacts(harnessDir: string): ReadonlyMap<string, DeliveryFacts> {
  const out = new Map<string, DeliveryFacts>();
  let attempts: ReadonlyMap<string, readonly FoldedAttempt[]>;
  let outcomes: ReadonlyMap<string, OutcomeLine>;
  try {
    attempts = readAttempts(harnessDir);
    outcomes = readOutcomes(harnessDir);
  } catch {
    return out;
  }
  for (const [wi, list] of attempts) {
    const newest = list.at(-1);
    if (newest === undefined) continue;
    const opened = [...list].reverse().find((a) => a.state === "done" && a.pr !== undefined);
    const outcome = outcomes.get(wi);
    const known = outcome !== undefined && (opened === undefined || outcome.pr === opened.pr);
    const pr: DeliveryFacts["pr"] | undefined = known
      ? {
          state: outcome.state === "reverted" ? "merged" : outcome.state,
          ...(outcome.review !== undefined
            ? {
                review:
                  outcome.review === "changes-requested" ? "changes_requested" : outcome.review,
              }
            : {}),
          ...(outcome.reverted === true || outcome.state === "reverted" ? { reverted: true } : {}),
        }
      : opened !== undefined
        ? { state: "open" }
        : undefined;
    out.set(wi, { publish: newest.state, ...(pr !== undefined ? { pr } : {}) });
  }
  return out;
}

const PUBLISH_KEYS: ReadonlySet<string> = new Set(WORK_PUBLISH_LOG_KEYS);
const PR_KEYS: ReadonlySet<string> = new Set(WORK_PR_LOG_KEYS);

/** The keys of a delivery line outside its closed set: a writer's bug, caught before the append. */
export function strayDeliveryKeys(
  kind: "publish" | "outcome",
  line: Readonly<Record<string, unknown>>,
): readonly string[] {
  const keys = kind === "publish" ? PUBLISH_KEYS : PR_KEYS;
  return Object.keys(line).filter((key) => !keys.has(key));
}
