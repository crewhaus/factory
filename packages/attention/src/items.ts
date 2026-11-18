/**
 * Building one item: its id from its key, its band from its kind, its revision from its
 * evidence, and the few words every surface shares (a shell-safe command, a class order).
 */
import {
  type AttentionChoice,
  type AttentionEvidence,
  type AttentionFreshness,
  type AttentionItem,
  type AttentionKind,
  type AttentionSourceKind,
  type AttentionText,
  type DecisionClass,
  attentionBandOf,
} from "@crewhaus/control-contract";
import { type RevisionPart, attRefOf, evidenceRevOf } from "./ids";
import type { Drafted } from "./types";

/** Optional item fields, passed through when present. */
type ItemExtras = Partial<
  Pick<
    AttentionItem,
    | "harness"
    | "harnesses"
    | "recommendation"
    | "deadline"
    | "ifUnanswered"
    | "resolution"
    | "cause"
    | "binding"
    | "asks"
    | "previous"
    | "body"
    | "bodyWithheld"
  >
>;

export type ItemSpec = ItemExtras & {
  readonly scope: string;
  readonly kind: AttentionKind;
  readonly key: string;
  readonly source: { readonly kind: AttentionSourceKind; readonly id: string };
  readonly title: AttentionText;
  readonly whyNow: AttentionText;
  /** Newest first; at most 50 are kept. */
  readonly runs: readonly string[];
  readonly count: number;
  readonly evidence: readonly AttentionEvidence[];
  readonly revision: readonly RevisionPart[];
  readonly choices: readonly AttentionChoice[];
  readonly requiredClass: DecisionClass;
  readonly state: AttentionItem["state"];
  readonly since: string;
  readonly latestAt: number;
  readonly freshness: AttentionFreshness;
};

/** At most this many runs are named on an item; `count` says how many there are. */
export const AFFECTED_RUNS_MAX = 50;

/** One item, with the time its newest evidence was seen. */
export function draftItem(spec: ItemSpec): Drafted {
  const band = attentionBandOf(spec.kind);
  if (band === undefined) throw new TypeError(`attention: "${spec.kind}" is not a kind`);
  const pick = <K extends keyof ItemExtras>(name: K) =>
    spec[name] === undefined ? {} : { [name]: spec[name] };
  const item: AttentionItem = {
    ref: attRefOf(spec.scope, spec.kind, spec.key),
    kind: spec.kind,
    band,
    ...pick("harness"),
    ...pick("harnesses"),
    source: spec.source,
    title: spec.title,
    whyNow: spec.whyNow,
    affected: { runs: spec.runs.slice(0, AFFECTED_RUNS_MAX), count: spec.count },
    evidence: spec.evidence.slice(0, AFFECTED_RUNS_MAX),
    choices: spec.choices,
    ...pick("recommendation"),
    ...pick("deadline"),
    ...pick("ifUnanswered"),
    requiredClass: spec.requiredClass,
    state: spec.state,
    ...pick("resolution"),
    ...pick("cause"),
    ...pick("binding"),
    evidenceRev: evidenceRevOf(spec.revision),
    since: spec.since,
    ...pick("asks"),
    ...pick("previous"),
    ...pick("body"),
    ...pick("bodyWithheld"),
    freshness: spec.freshness,
  };
  return { item, latestAt: spec.latestAt };
}

const CLASS_RANK: Readonly<Record<DecisionClass, number>> = {
  operator: 0,
  maintainer: 1,
  owner: 2,
};

/** The higher of two classes: who may decide all of several requests. */
export function higherClass(a: DecisionClass, b: DecisionClass): DecisionClass {
  return CLASS_RANK[b] > CLASS_RANK[a] ? b : a;
}

/** A class as recorded, `operator` when absent or not one. */
export function classOf(value: unknown): DecisionClass {
  return value === "maintainer" || value === "owner" ? value : "operator";
}

/** One word for a POSIX shell: as it is when it needs no quoting, else single-quoted. */
export function shellWord(text: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A time in ms, or `undefined` for one that does not parse. */
export function msOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The ISO form of a time in ms. */
export function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** The command that shows any item in full. */
export function showTwin(ref: string): string {
  return `crewhaus inbox show ${ref.slice(ref.lastIndexOf("/") + 1)}`;
}
