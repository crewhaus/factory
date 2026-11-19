/**
 * The work fold: every line of the work log, in file order, through the `work` machine.
 * A line the machine refuses (or an event that does not fit where the item is: a second
 * `opened`, a line for an item never opened) stays on disk, is skipped and is counted as an
 * anomaly. A line repeated by a claim's repair counts once. Reads take no lock and write
 * nothing; a read with a cap reports that it was cut short, and the write path folds
 * whole.
 */
import {
  type CorrectionScope,
  type CursorPosition,
  MACHINES,
  type WorkBasis,
  type WorkCloseOutcome,
  type WorkKind,
  type WorkSourceKind,
  type WorkState,
  canTransition,
} from "@crewhaus/control-contract";
import { readPage } from "@crewhaus/control-records";
import { type WorkLogLine, type WorkVia, workLedger } from "./records";

/** One ranking correction, as a `ranked` line recorded it. */
export type WorkCorrection = {
  readonly wi: string;
  readonly below: string;
  readonly scope: CorrectionScope;
  readonly by: string;
  readonly at: string;
  /** File order: a later correction is newer. */
  readonly seq: number;
};

/** One item, as the log says it is now. */
export type FoldedWorkItem = {
  readonly id: string;
  readonly state: WorkState;
  readonly rev: number;
  readonly kind: WorkKind;
  readonly basis?: WorkBasis;
  readonly priority?: number;
  readonly parent?: string;
  readonly sourceKind?: WorkSourceKind;
  readonly sourceDigest?: string;
  readonly outcome?: WorkCloseOutcome;
  readonly reasonCode?: string;
  readonly supersededBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Who opened it, and through which door. */
  readonly openedBy: string;
  readonly openedVia: WorkVia;
  /** The runs linked to it, oldest first. */
  readonly runs: readonly string[];
  /** Every line the fold applied to it, oldest first. */
  readonly history: readonly WorkLogLine[];
};

export type WorkFold = {
  readonly ok: true;
  readonly items: ReadonlyMap<string, FoldedWorkItem>;
  readonly corrections: readonly WorkCorrection[];
  readonly anomalies: number;
  /** Lines read, gaps included. */
  readonly lines: number;
  /** Lines that could not be read. */
  readonly gaps: number;
  /** A capped read stopped before the oldest line. */
  readonly truncated: boolean;
};

export type WorkFoldFailure = { readonly ok: false; readonly reason: string };

const PAGE = 1000;

/** The log's lines in file order, newest `cap` lines at most; `cap` absent reads them all. */
export function readWorkLines(
  harnessDir: string,
  cap?: number,
): {
  readonly lines: readonly Readonly<Record<string, unknown>>[];
  readonly gaps: number;
  readonly truncated: boolean;
} {
  const ledger = workLedger(harnessDir);
  const newestFirst: Readonly<Record<string, unknown>>[] = [];
  let gaps = 0;
  let before: CursorPosition | undefined;
  for (;;) {
    const page = readPage(ledger, { limit: PAGE, ...(before !== undefined ? { before } : {}) });
    gaps += page.gaps.length;
    for (const item of page.items) {
      if (cap !== undefined && newestFirst.length >= cap) {
        return { lines: newestFirst.reverse(), gaps, truncated: true };
      }
      newestFirst.push(item.record);
    }
    if (page.next === undefined) break;
    before = page.next;
  }
  return { lines: newestFirst.reverse(), gaps, truncated: false };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Which events may start an item, and which need one. */
const OPENING = "opened";

/** Fold lines (file order) through the machine. Pure. */
export function foldWorkLines(lines: readonly Readonly<Record<string, unknown>>[]): {
  readonly items: Map<string, FoldedWorkItem>;
  readonly corrections: WorkCorrection[];
  readonly anomalies: number;
} {
  const items = new Map<string, FoldedWorkItem>();
  const corrections: WorkCorrection[] = [];
  const facts = new Set<string>();
  let anomalies = 0;
  let seq = 0;
  for (const raw of lines) {
    const claim = raw["claim"];
    const id = str(raw["id"]);
    if (typeof claim === "string") {
      const fact = JSON.stringify([claim, id ?? null]);
      if (facts.has(fact)) continue;
      facts.add(fact);
    }
    if (id === undefined) continue;
    const line = raw as unknown as WorkLogLine;
    const to = str(raw["state"]);
    const at = str(raw["at"]) ?? "";
    const current = items.get(id);
    const legal =
      to !== undefined &&
      (current === undefined
        ? line.event === OPENING &&
          (MACHINES.work.entry as readonly string[]).includes(to) &&
          num(raw["rev"]) !== undefined &&
          str(raw["kind"]) !== undefined
        : line.event !== OPENING && canTransition("work", current.state, to));
    if (!legal) {
      anomalies += 1;
      continue;
    }
    seq += 1;
    if (current === undefined) {
      items.set(id, {
        id,
        state: to as WorkState,
        rev: num(raw["rev"]) as number,
        kind: raw["kind"] as WorkKind,
        ...(str(raw["basis"]) !== undefined ? { basis: raw["basis"] as WorkBasis } : {}),
        ...(num(raw["priority"]) !== undefined ? { priority: raw["priority"] as number } : {}),
        ...(str(raw["parent"]) !== undefined ? { parent: raw["parent"] as string } : {}),
        ...(str(raw["sourceKind"]) !== undefined
          ? { sourceKind: raw["sourceKind"] as WorkSourceKind }
          : {}),
        ...(str(raw["sourceDigest"]) !== undefined
          ? { sourceDigest: raw["sourceDigest"] as string }
          : {}),
        createdAt: at,
        updatedAt: at,
        openedBy: str(raw["by"]) ?? "",
        openedVia: (str(raw["via"]) ?? "system") as WorkVia,
        runs: [],
        history: [line],
      });
      continue;
    }
    const next: Record<string, unknown> = {
      ...current,
      state: to,
      updatedAt: at,
      history: [...current.history, line],
    };
    const rev = num(raw["rev"]);
    if (rev !== undefined && rev > current.rev) next["rev"] = rev;
    for (const key of ["kind", "basis", "parent"] as const) {
      if (str(raw[key]) !== undefined) next[key] = raw[key];
    }
    if (num(raw["priority"]) !== undefined) next["priority"] = raw["priority"];
    switch (line.event) {
      case "linked": {
        const run = str(raw["run"]);
        if (run !== undefined && !current.runs.includes(run)) next["runs"] = [...current.runs, run];
        break;
      }
      case "ranked": {
        const below = str(raw["below"]);
        const scope = str(raw["scope"]);
        if (below !== undefined && (scope === "item" || scope === "similar" || scope === "all")) {
          corrections.push({ wi: id, below, scope, by: line.by, at, seq });
        }
        break;
      }
      case "declined":
      case "closed": {
        next["outcome"] = raw["outcome"];
        if (str(raw["reasonCode"]) !== undefined) next["reasonCode"] = raw["reasonCode"];
        else Reflect.deleteProperty(next, "reasonCode");
        if (str(raw["supersededBy"]) !== undefined) next["supersededBy"] = raw["supersededBy"];
        else Reflect.deleteProperty(next, "supersededBy");
        break;
      }
      case "accepted":
      case "reopened": {
        Reflect.deleteProperty(next, "outcome");
        Reflect.deleteProperty(next, "reasonCode");
        Reflect.deleteProperty(next, "supersededBy");
        break;
      }
      default:
        break;
    }
    items.set(id, next as FoldedWorkItem);
  }
  return { items, corrections, anomalies };
}

/** The whole log folded: what a write decides on. */
export function foldWork(harnessDir: string, cap?: number): WorkFold | WorkFoldFailure {
  let read: ReturnType<typeof readWorkLines>;
  try {
    read = readWorkLines(harnessDir, cap);
  } catch (err) {
    return { ok: false, reason: `the work log could not be read: ${(err as Error).message}` };
  }
  const folded = foldWorkLines(read.lines);
  return {
    ok: true,
    items: folded.items,
    corrections: folded.corrections,
    anomalies: folded.anomalies,
    lines: read.lines.length + read.gaps,
    gaps: read.gaps,
    truncated: read.truncated,
  };
}
