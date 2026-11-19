/**
 * Which evidence the owner's accept policy counts as observed: only what the runtime can
 * check in this harness's own records. A label is the writer's say-so, so an `observed`
 * entry counts only when its `ref` names one of:
 *
 * - a run of this harness (`run_…`, or `run:run_…`) that its runs ledger records;
 * - a session of this harness (`session:<id>`) whose log is in its session directory;
 * - a work item of this harness (`wi_…`) that a person or the system adopted from a
 *   Thredz task or a GitHub issue.
 *
 * A ref to the proposing run, to the run it continues or belongs to, or to one of those
 * runs' own sessions never counts: a run citing itself is the label again. Reads only:
 * the runs ledger is scanned raw and the session directory is checked contained.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  CANONICAL_RUN_ID_RE,
  type CursorPosition,
  type WorkAssessment,
  isId,
} from "@crewhaus/control-contract";
import { readPage, runsLedger } from "@crewhaus/control-records";
import { resolveContained } from "@crewhaus/tool-safety/fs";
import { isHypothesis } from "./assessment";
import type { WorkFold } from "./fold";

/** The source kinds an adopted item counts as checked evidence for. */
const VERIFIED_SOURCE_KINDS: ReadonlySet<string> = new Set(["thredz-task", "github-issue"]);

/** The doors a person's or the system's adoption comes through. */
const ADOPTED_BY: ReadonlySet<string> = new Set(["home", "cli", "slack", "system"]);

/** A session id as a session log file names it. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const PAGE = 1000;

/** What the runs ledger says about each run: its sessions, and the runs it belongs to. */
type RunFacts = {
  readonly sessions: Set<string>;
  readonly related: Set<string>;
};

function readRuns(harnessDir: string): ReadonlyMap<string, RunFacts> {
  const out = new Map<string, RunFacts>();
  const ledger = runsLedger(harnessDir);
  let before: CursorPosition | undefined;
  try {
    for (;;) {
      const page = readPage(ledger, {
        limit: PAGE,
        ...(before !== undefined ? { before } : {}),
      });
      for (const { record } of page.items) {
        const id = record["id"];
        if (typeof id !== "string" || !CANONICAL_RUN_ID_RE.test(id)) continue;
        let facts = out.get(id);
        if (facts === undefined) {
          facts = { sessions: new Set(), related: new Set() };
          out.set(id, facts);
        }
        const session = record["session"];
        if (typeof session === "string") facts.sessions.add(session);
        for (const key of ["continues", "parent"] as const) {
          const other = record[key];
          if (typeof other === "string") facts.related.add(other);
        }
      }
      if (page.next === undefined) break;
      before = page.next;
    }
  } catch {
    return out;
  }
  return out;
}

/** The runs and sessions a proposal by `run` may not cite: its own and those it belongs to. */
function selfOf(
  run: string | undefined,
  runs: ReadonlyMap<string, RunFacts>,
): {
  readonly runs: ReadonlySet<string>;
  readonly sessions: ReadonlySet<string>;
} {
  const selfRuns = new Set<string>();
  const sessions = new Set<string>();
  if (run === undefined) return { runs: selfRuns, sessions };
  const queue = [run];
  while (queue.length > 0) {
    const next = queue.pop() as string;
    if (selfRuns.has(next)) continue;
    selfRuns.add(next);
    const facts = runs.get(next);
    if (facts === undefined) continue;
    for (const s of facts.sessions) sessions.add(s);
    for (const r of facts.related) queue.push(r);
  }
  return { runs: selfRuns, sessions };
}

function sessionLogExists(harnessDir: string, id: string): boolean {
  if (!SESSION_ID_RE.test(id)) return false;
  const at = resolveContained(harnessDir, join(".crewhaus", "sessions", `${id}.jsonl`), {
    followLeaf: false,
  });
  if (!at.ok) return false;
  try {
    return lstatSync(at.real).isFile();
  } catch {
    return false;
  }
}

export type EvidenceContext = {
  readonly harnessDir: string;
  /** The run proposing, when a run proposes. */
  readonly run?: string;
  /** The work log, folded whole, for a `wi_…` ref. */
  readonly fold?: WorkFold;
};

/**
 * Whether any `observed` evidence names something this harness's records hold, other
 * than the proposing run itself: the one thing that lets a feature or a speculative
 * proposal be accepted by the owner's policy.
 */
export function verifiedObservedEvidence(
  assessment: WorkAssessment | undefined,
  ctx: EvidenceContext,
): boolean {
  const observed = (assessment?.evidence ?? []).filter(
    (e) => e.label === "observed" && !isHypothesis(e) && typeof e.ref === "string",
  );
  if (observed.length === 0) return false;
  let runs: ReadonlyMap<string, RunFacts> | undefined;
  const runsOf = (): ReadonlyMap<string, RunFacts> => {
    runs ??= readRuns(ctx.harnessDir);
    return runs;
  };
  for (const e of observed) {
    const ref = (e.ref as string).trim();
    const runRef = ref.startsWith("run:") ? ref.slice(4) : ref;
    if (CANONICAL_RUN_ID_RE.test(runRef)) {
      const all = runsOf();
      if (all.has(runRef) && !selfOf(ctx.run, all).runs.has(runRef)) return true;
      continue;
    }
    if (ref.startsWith("session:")) {
      const id = ref.slice("session:".length);
      if (selfOf(ctx.run, runsOf()).sessions.has(id)) continue;
      if (sessionLogExists(ctx.harnessDir, id)) return true;
      continue;
    }
    if (isId("wi", ref) && ctx.fold !== undefined) {
      const item = ctx.fold.items.get(ref);
      if (
        item !== undefined &&
        item.sourceKind !== undefined &&
        VERIFIED_SOURCE_KINDS.has(item.sourceKind) &&
        ADOPTED_BY.has(item.openedVia)
      ) {
        return true;
      }
    }
  }
  return false;
}
