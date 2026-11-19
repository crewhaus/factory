/**
 * Where work items live, and the two record shapes: the content-free log line and the
 * immutable content revision.
 *
 * - The log: `.crewhaus/run/control/work/NNNNNN.jsonl`, on the harness's shared control
 *   lock and claims, folded through the `work` machine. A line holds ids, keyed digests,
 *   states, codes, numbers and times, its keys from `WORK_LOG_KEYS`: never a title, a goal,
 *   a URL or issue text.
 * - Content: `.crewhaus/run/control/work/items/<wi>/<rev>.json`, one file per revision,
 *   created exclusively (`0600`) and never rewritten, so what was asked is always
 *   recoverable. Each text field records the origin it came through (`fieldOrigins`).
 * - Source claims: `claims/work-source/<keyed digest>.json`, whose record is the item's
 *   `opened` line, so one source is one item however often it is proposed or adopted.
 *
 * Every path is built from `controlPaths(h).controlDir` and every file is opened contained
 * in the harness directory.
 */
import { join } from "node:path";
import type { TrustOrigin } from "@crewhaus/boundary-classifier";
import {
  WORK_LOG_KEYS,
  type WorkAssessment,
  type WorkBasis,
  type WorkCloseOutcome,
  type WorkDeliveryKind,
  type WorkEvent,
  type WorkKind,
  type WorkSourceKind,
  type WorkState,
} from "@crewhaus/control-contract";
import { type Ledger, controlPaths, harnessLedger } from "@crewhaus/control-records";

/** The log's directory, relative to the harness. */
export function workDirOf(harnessDir: string): string {
  return join(controlPaths(harnessDir).controlDir, "work");
}

/** One item's content directory, relative to the harness. */
export function itemDirOf(harnessDir: string, wi: string): string {
  return join(workDirOf(harnessDir), "items", wi);
}

/** One content revision's file, relative to the harness. */
export function revisionRelOf(harnessDir: string, wi: string, rev: number): string {
  return join(itemDirOf(harnessDir, wi), `${rev}.json`);
}

/** The work log of the harness at `harnessDir`, on the `work` machine. */
export function workLedger(harnessDir: string): Ledger {
  return harnessLedger(harnessDir, { dir: workDirOf(harnessDir) }, { machine: "work" });
}

/** The claim kind a source claim is taken under. */
export const WORK_SOURCE_CLAIM_KIND = "work-source";

/** Which door a write came through, as a log line records it. */
export type WorkVia = "home" | "cli" | "sdk" | "slack" | "tool" | "system";

/**
 * Who writes: a person (Home, the CLI, Slack), a service principal (an SDK caller), the
 * harness itself through its tools, or the system (the accept policy, a reconcile).
 */
export type WorkActorRole = "person" | "service" | "harness" | "system";

export type WorkActor = {
  /** A stored actor: `prn_…`, `local:#<digest>` or `sys:…`, never a raw `local:`. */
  readonly by: string;
  readonly via: WorkVia;
  readonly role: WorkActorRole;
  /** The run a tool call ran in. */
  readonly run?: string;
  /** The receipt the write runs under. */
  readonly cmd?: string;
};

/** The origin a role's text arrives through, when a tool reads it back. */
export function originOfRole(role: WorkActorRole): TrustOrigin {
  return role === "person" || role === "service" ? "api" : "memory";
}

/** One work log line. Keys are `WORK_LOG_KEYS`; every value is an id, a code or a number. */
export type WorkLogLine = {
  readonly v: 1;
  readonly at: string;
  readonly id: string;
  readonly state: WorkState;
  readonly event: WorkEvent;
  readonly by: string;
  readonly via: WorkVia;
  readonly cmd?: string;
  readonly run?: string;
  readonly rev?: number;
  readonly kind?: WorkKind;
  readonly basis?: WorkBasis;
  readonly sourceKind?: WorkSourceKind;
  readonly sourceDigest?: string;
  readonly parent?: string;
  readonly priority?: number;
  readonly outcome?: WorkCloseOutcome;
  readonly reasonCode?: string;
  readonly supersededBy?: string;
  readonly rule?: string;
  readonly below?: string;
  readonly scope?: string;
  readonly delivered?: { readonly kind: WorkDeliveryKind };
  readonly claim?: string;
  readonly repaired?: true;
};

const KEYS: ReadonlySet<string> = new Set(WORK_LOG_KEYS);

/** The keys of a line outside the closed set: a writer's bug, caught before the append. */
export function strayKeys(line: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(line).filter((key) => !KEYS.has(key));
}

/** A note on an item, with the origin its text came through. */
export type WorkNote = {
  readonly by: string;
  readonly at: string;
  readonly text: string;
  readonly origin: TrustOrigin;
};

/** What a run delivered, with the origin its reference came through. */
export type WorkDelivery = {
  readonly kind: WorkDeliveryKind;
  readonly ref: string;
  readonly at: string;
  readonly origin: TrustOrigin;
};

/** Where an item came from. `ref` and `url` are text, kept here and never in the log. */
export type WorkSource = {
  readonly kind: WorkSourceKind;
  readonly ref?: string;
  readonly url?: string;
};

/** The text fields a revision records an origin for. */
export type WorkTextField = "title" | "goal" | "acceptance" | "assessment" | "source" | "excerpt";

/** One immutable content revision. */
export type WorkRevision = {
  readonly v: 1;
  readonly wi: string;
  readonly rev: number;
  readonly at: string;
  readonly by: string;
  readonly title: string;
  readonly goal?: string;
  readonly acceptance?: readonly string[];
  readonly kind: WorkKind;
  readonly basis?: WorkBasis;
  readonly parent?: string;
  readonly source?: WorkSource;
  readonly assessment?: WorkAssessment;
  readonly notes?: readonly WorkNote[];
  readonly delivered?: readonly WorkDelivery[];
  /** The origin each text field was written through. */
  readonly fieldOrigins: Readonly<Partial<Record<WorkTextField, TrustOrigin>>>;
  /** At most 4 KiB of the source's own words, when it was adopted. */
  readonly sourceExcerpt?: string;
};

/** The largest revision file a reader takes in. */
export const REVISION_MAX_BYTES = 512 * 1024;
/** The largest source excerpt a revision keeps. */
export const SOURCE_EXCERPT_MAX = 4096;
