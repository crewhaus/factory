/**
 * Where change records live, and the one way a change moves.
 *
 * Lifecycle rows are content-free and live in `.crewhaus/run/control/changes.jsonl`,
 * on control-contract's `change` machine, through control-records' compare-and-set:
 * every transition is `casAppend(ledger, chg, from, next)`, so two writers never both
 * move a change. A row holds ids, digests, closed codes, a stored actor and times;
 * never a diff, a prompt, a case or an answer. Each row is the whole record, so the
 * fold's current row is the change.
 *
 * Content (the proposed file, the patch, the rendered changelog and PR body, the
 * evidence and the check's runs) lives under `.crewhaus/proposals/<chg>/`, a directory
 * created `0700` with files created `0600`, each exclusively, contained to the harness.
 * Older proposal bundles there (`<spec>-<version>-<hash8>-<stamp>`) list as legacy
 * proposals with no lifecycle.
 */
import { closeSync, readdirSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CHANGE_KINDS,
  CHANGE_REASONS,
  CHANGE_SOURCES,
  CHANGE_STATES,
  CHANGE_SURFACES,
  type ChangeKind,
  type ChangeReason,
  type ChangeSource,
  type ChangeState,
  type ChangeSurface,
  isId,
  isStoredActor,
  mintId,
} from "@crewhaus/control-contract";
import {
  type CasAnswer,
  type Ledger,
  type LedgerRecord,
  casAppend,
  controlPaths,
  foldStates,
  harnessLedger,
} from "@crewhaus/control-records";
import { createExclusive, ensureDirContained, openForReadSync } from "@crewhaus/tool-safety/fs";

/** Where a change's content lives, relative to the harness directory. */
export const PROPOSALS_RELDIR = join(".crewhaus", "proposals");

/** The largest content file a change keeps (a spec is read whole under 4 MiB). */
export const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

/** The change ledger of a harness, on the `change` machine. */
export function changesLedger(harnessDir: string): Ledger {
  return harnessLedger(
    harnessDir,
    { file: join(controlPaths(harnessDir).controlDir, "changes.jsonl") },
    { machine: "change" },
  );
}

/** What a change was measured against when it was made. */
export type ChangeBase = {
  /** The revision of the file the change edits (`sha256:` and 64 hex). */
  readonly revision: string;
  /** The spec's revision when the change was made. */
  readonly specHash?: string;
  readonly gradersHash?: string;
  readonly criteria?: ReadonlyArray<{ readonly id: string; readonly digest: string }>;
  readonly dataset?: { readonly name: string; readonly version: string };
  readonly deployment?: string;
};

export type ChangeTouches = {
  readonly surfaces: ReadonlyArray<ChangeSurface>;
  /** A protected bar, a `*.protected` key or a protected criterion moves. */
  readonly protected: boolean;
  /** The spec's `intent:` changes. */
  readonly intent: boolean;
  /** A security surface, or a raise of spending. */
  readonly security: boolean;
};

export type CheckComparison = "pass" | "fail" | "not_comparable";
export type HoldoutVerdict = "pass" | "fail" | "absent";

export type ChangeVerdict = {
  readonly comparison: CheckComparison;
  readonly holdout: HoldoutVerdict;
  readonly regressions: number;
  readonly recoveries: number;
};

export type ChangeAdoption = {
  /** The spec's revision once the change is applied. */
  readonly specHash: string;
  readonly gradersHash?: string;
  /** The revision of the file the change wrote. */
  readonly revision: string;
  readonly specVersion?: string;
};

export type ChangeRollbackTarget = {
  readonly specHash: string;
  readonly revision: string;
  readonly specVersion?: string;
  readonly deployment?: string;
};

/** One lifecycle row: the change as it now stands. */
export type ChangeRow = {
  readonly v: 1;
  /** The change's id, `chg_…`. */
  readonly id: string;
  readonly state: ChangeState;
  readonly at: string;
  readonly kind: ChangeKind;
  readonly source: ChangeSource;
  readonly base: ChangeBase;
  /** A keyed digest of the patch. */
  readonly patchDigest: string;
  /** Where the content is, relative to the harness: `.crewhaus/proposals/<chg>`. */
  readonly contentRef: string;
  readonly touches: ChangeTouches;
  readonly verdict?: ChangeVerdict;
  /** A keyed digest of the check's evidence. */
  readonly evidenceDigest?: string;
  /** Where the evidence is, relative to the harness. */
  readonly evidenceRef?: string;
  /** How the check isolated the candidate: `regrade-only`, `recorded-tools` or `live`. */
  readonly isolation?: string;
  /** Who confirmed a live check, as a stored actor. */
  readonly liveBy?: string;
  readonly decision?: string;
  readonly requiredClass?: "maintainer" | "owner";
  /** Who made this row's move, as a stored actor (`prn_…`, `local:#…` or `sys:…`). */
  readonly actor?: string;
  /** The receipt of the command that made this row's move. */
  readonly cmd?: string;
  /** The surface that made this row's move. */
  readonly via?: string;
  readonly adoption?: ChangeAdoption;
  /** The deployment whose build carries the adopted change. */
  readonly activation?: string;
  /** When the watch after activation ends (ISO). */
  readonly until?: string;
  /** Hours the watch lasts once activated. */
  readonly watchHours?: number;
  readonly rollbackTarget?: ChangeRollbackTarget;
  readonly reason?: ChangeReason;
};

export type ChangesRead =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: string }
  | {
      readonly state: "present";
      readonly rows: ReadonlyArray<ChangeRow>;
      /** What the fold could not use, one sentence each: never a value from a row. */
      readonly anomalies: ReadonlyArray<string>;
    };

const BOOKKEEPING = new Set(["claim", "gen", "repaired"]);
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isRevision = (v: unknown): v is string =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v);
const isDigest = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const optional = (v: unknown, check: (x: unknown) => boolean): boolean =>
  v === undefined || check(v);
const plain = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** A ledger row as a change row, or `undefined` when it is not one. */
export function changeRowOf(row: LedgerRecord): ChangeRow | undefined {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!BOOKKEEPING.has(k)) r[k] = v;
  const base = plain(r["base"]);
  const touches = plain(r["touches"]);
  const ok =
    r["v"] === 1 &&
    isId("chg", r["id"]) &&
    (CHANGE_STATES as readonly unknown[]).includes(r["state"]) &&
    isTime(r["at"]) &&
    (CHANGE_KINDS as readonly unknown[]).includes(r["kind"]) &&
    (CHANGE_SOURCES as readonly unknown[]).includes(r["source"]) &&
    base !== undefined &&
    isRevision(base["revision"]) &&
    isDigest(r["patchDigest"]) &&
    typeof r["contentRef"] === "string" &&
    touches !== undefined &&
    Array.isArray(touches["surfaces"]) &&
    (touches["surfaces"] as unknown[]).every((s) =>
      (CHANGE_SURFACES as readonly unknown[]).includes(s),
    ) &&
    typeof touches["protected"] === "boolean" &&
    typeof touches["intent"] === "boolean" &&
    typeof touches["security"] === "boolean" &&
    optional(r["decision"], (v) => isId("dec", v)) &&
    optional(r["requiredClass"], (v) => v === "maintainer" || v === "owner") &&
    optional(r["actor"], isStoredActor) &&
    optional(r["cmd"], (v) => isId("cmd", v)) &&
    optional(r["evidenceDigest"], isDigest) &&
    optional(r["activation"], (v) => isId("dep", v)) &&
    optional(r["until"], isTime) &&
    optional(r["reason"], (v) => (CHANGE_REASONS as readonly unknown[]).includes(v));
  return ok ? (r as ChangeRow) : undefined;
}

/**
 * Every change of a harness, as its latest row says: a tolerant fold that takes no lock
 * and writes nothing. A row that is not a change, and a row whose move the machine does
 * not allow, are reported in `anomalies`, never dropped silently.
 */
export function readChanges(harnessDir: string): ChangesRead {
  const fold = foldStates(changesLedger(harnessDir));
  if (!fold.ok) {
    return fold.code === "not-found"
      ? { state: "absent" }
      : { state: "unreadable", reason: fold.reason };
  }
  if (fold.records === 0 && fold.gaps.length === 0) return { state: "absent" };
  const rows: ChangeRow[] = [];
  const anomalies: string[] = [];
  for (const object of fold.objects.values()) {
    const row = changeRowOf(object.record);
    if (row === undefined) anomalies.push(`${object.id}: the row is not a change`);
    else rows.push(row);
  }
  for (const anomaly of fold.anomalies) {
    anomalies.push(
      `${anomaly.id}: a row moving ${anomaly.from ?? "nothing"} to ${anomaly.to ?? "nothing"} is not a move the change machine allows`,
    );
  }
  if (fold.gaps.length > 0) anomalies.push(`${fold.gaps.length} line(s) cannot be read`);
  return { state: "present", rows, anomalies };
}

/** One change by id, or `undefined`. */
export function readChange(harnessDir: string, chg: string): ChangeRow | undefined {
  const read = readChanges(harnessDir);
  return read.state === "present" ? read.rows.find((r) => r.id === chg) : undefined;
}

export type MoveAnswer =
  | { readonly ok: true; readonly row: ChangeRow }
  | {
      readonly ok: false;
      readonly code: "stale" | "illegal" | "unavailable";
      readonly reason: string;
      readonly current?: ChangeRow;
    };

/**
 * Move a change from `from` (`null`: it does not exist yet) to the state `next` names,
 * through the ledger's compare-and-set. Stale, illegal and unwritable moves are answers.
 */
export async function moveChange(
  harnessDir: string,
  from: ChangeState | null,
  next: ChangeRow,
): Promise<MoveAnswer> {
  let answer: CasAnswer;
  try {
    answer = await casAppend(
      changesLedger(harnessDir),
      next.id,
      from,
      next as unknown as LedgerRecord,
    );
  } catch (err) {
    return {
      ok: false,
      code: "unavailable",
      reason: `the change record could not be written: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!answer.ok) {
    return {
      ok: false,
      code: "unavailable",
      reason: `the change record could not be written: ${answer.reason}`,
    };
  }
  if (answer.applied) return { ok: true, row: next };
  const current = answer.current === null ? undefined : changeRowOf(answer.current);
  if (answer.illegal === true) {
    return {
      ok: false,
      code: "illegal",
      reason: `a change ${from ?? "that does not exist"} cannot become ${next.state}`,
      ...(current !== undefined ? { current } : {}),
    };
  }
  return {
    ok: false,
    code: "stale",
    reason:
      current === undefined
        ? `${next.id} is not ${from ?? "new"}`
        : `${next.id} is ${current.state}, not ${from ?? "new"}`,
    ...(current !== undefined ? { current } : {}),
  };
}

/** A fresh change id. */
export function mintChangeId(now?: number): string {
  return mintId("chg", now !== undefined ? { now } : {});
}

/** The content directory of a change, relative to the harness. */
export function contentRefOf(chg: string): string {
  if (!isId("chg", chg)) throw new Error(`"${chg}" is not a change id`);
  return join(PROPOSALS_RELDIR, chg);
}

/** The file names a change's content may hold. */
export const CONTENT_FILES = [
  "base.yaml",
  "proposed.yaml",
  "graders.yaml",
  "cases.jsonl",
  "patch.json",
  "CHANGELOG-entry.md",
  "PR-body.md",
  "evidence.json",
] as const;

export type ContentFile = (typeof CONTENT_FILES)[number];

export type WriteContentAnswer =
  | { readonly ok: true; readonly contentRef: string }
  | { readonly ok: false; readonly reason: string };

function writeExclusive(
  harnessDir: string,
  rel: string,
  text: string,
  createParents = false,
): string | undefined {
  if (createParents) {
    const dir = ensureDirContained(harnessDir, dirname(rel), { mode: 0o700, symlinks: "refuse" });
    if (!dir.ok) return dir.reason;
  }
  const created = createExclusive(harnessDir, rel, { mode: 0o600 });
  if (!created.ok) return created.reason;
  try {
    writeSync(created.fd, text);
  } finally {
    closeSync(created.fd);
  }
  return undefined;
}

/**
 * Create a change's content directory (`0700`) and write each file in it exclusively
 * (`0600`), contained to the harness and never through a link. A directory that already
 * exists is refused: a change id names one change.
 */
export function writeChangeContent(
  harnessDir: string,
  chg: string,
  files: Partial<Readonly<Record<ContentFile, string>>>,
): WriteContentAnswer {
  const contentRef = contentRefOf(chg);
  const parent = ensureDirContained(harnessDir, PROPOSALS_RELDIR, { mode: 0o700 });
  if (!parent.ok) return { ok: false, reason: parent.reason };
  const dir = ensureDirContained(harnessDir, contentRef, { mode: 0o700, symlinks: "refuse" });
  if (!dir.ok) return { ok: false, reason: dir.reason };
  if (!dir.created.some((created) => created === dir.real)) {
    return { ok: false, reason: `${contentRef} already exists; a change id names one change` };
  }
  for (const [name, text] of Object.entries(files)) {
    if (text === undefined) continue;
    const failed = writeExclusive(harnessDir, join(contentRef, name), text);
    if (failed !== undefined) return { ok: false, reason: failed };
  }
  return { ok: true, contentRef };
}

/**
 * Add one file to an existing change's content, exclusively: never replaced. `name` is
 * a content file or a path under the change's `runs/` directory.
 */
export function addChangeContent(
  harnessDir: string,
  chg: string,
  name: ContentFile | string,
  text: string,
): WriteContentAnswer {
  const contentRef = contentRefOf(chg);
  const parts = name.split(/[\\/]/);
  const allowed =
    (CONTENT_FILES as readonly string[]).includes(name) ||
    (parts[0] === "runs" &&
      parts.length >= 2 &&
      parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p) && p !== ".."));
  if (!allowed) return { ok: false, reason: `"${name}" is not a change content file` };
  const failed = writeExclusive(harnessDir, join(contentRef, name), text, true);
  return failed === undefined ? { ok: true, contentRef } : { ok: false, reason: failed };
}

/** Read one content file whole, contained to the harness; `undefined` when it is absent. */
export function readChangeContent(
  harnessDir: string,
  chg: string,
  name: ContentFile,
): string | undefined {
  const read = openForReadSync(harnessDir, join(contentRefOf(chg), name), {
    maxBytes: MAX_CONTENT_BYTES,
    followLeafSymlink: false,
  });
  if (!read.ok || read.truncated) return undefined;
  return read.text;
}

const LEGACY_RE = /^[A-Za-z0-9._-]+-[^/]+-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/;

/** The legacy proposal bundles beside the change directories: listed, with no lifecycle. */
export function listLegacyProposals(harnessDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(harnessDir, PROPOSALS_RELDIR));
  } catch {
    return [];
  }
  return names.filter((name) => !isId("chg", name) && LEGACY_RE.test(name)).sort();
}
