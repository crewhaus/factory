/**
 * The measuring instrument of an eval run, and the one rule for when two runs
 * were measured differently.
 *
 * Scores are comparable only when both runs graded with the same instrument:
 * the graders config (`gradersHash`), the judge (`judgeModel`), the judge
 * calibration (`calibrationDigest`), the plugin graders' code
 * (`pluginsDigest`) and, on a routed lineage, the arm snapshot and pool policy
 * (`armsDigest`, `policyVersion`). The dataset is not here: a changed dataset
 * breaks a trend, and the gate checks the cases themselves. `specHash`,
 * `cliVersion` and the sample count are notes, never an instrument change: the
 * spec is what is being measured.
 *
 * | field             | both present, differ | present on one side only                         |
 * |-------------------|----------------------|--------------------------------------------------|
 * | gradersHash       | change               | unverified                                       |
 * | judgeModel        | change               | change (absent means no pinned judge)            |
 * | calibrationDigest | change               | change between two summaries; unverified when either side is a row or a pin |
 * | pluginsDigest     | change               | change between two summaries when the absent side's `cliVersion` is 0.9.0 or later; unverified otherwise |
 * | armsDigest        | change               | unverified on a routed lineage; nothing on an unrouted one |
 * | policyVersion     | change               | unverified on a routed lineage; nothing on an unrouted one |
 *
 * A row or a pin carries no `cliVersion`, and a row written before the digest
 * columns existed has none even when its run applied a calibration, so on a
 * row a one-side digest cannot be told from an old record: it is unverified.
 * Unverified is reported, never failed on.
 */
import type { EvalRunSummary } from "@crewhaus/eval-runner";
import {
  type BaselineEntry,
  type RunIndexEntry,
  calibrationDigestOf,
  routingColumnsFromSummary,
} from "./history";

/** The fields that identify the measuring instrument, not the thing measured. */
export const INSTRUMENT_FIELDS = [
  "gradersHash",
  "judgeModel",
  "calibrationDigest",
  "pluginsDigest",
  "armsDigest",
  "policyVersion",
] as const;

export type InstrumentField = (typeof INSTRUMENT_FIELDS)[number];

/** A run's instrument, as far as what it was read from records it. */
export type Instrument = Readonly<Partial<Record<InstrumentField, string>>> & {
  /** A run summary carries `cliVersion` and the calibration it applied; a row or a pin does not. */
  readonly source: "summary" | "row";
  /** The run routed a pool (an arm, or a routing other than static). */
  readonly routed: boolean;
  readonly cliVersion?: string;
};

export type InstrumentChange = {
  readonly field: InstrumentField;
  readonly from?: string;
  readonly to?: string;
  /** Present on one side only, where absence is not evidence: reported, never failed on. */
  readonly unverified?: true;
};

/** What {@link instrumentOf} reads: an index row, a pin or a run summary. */
export type InstrumentSource = RunIndexEntry | BaselineEntry | EvalRunSummary;

function isSummary(x: InstrumentSource): x is EvalRunSummary {
  return (
    typeof (x as EvalRunSummary).config === "object" && Array.isArray((x as EvalRunSummary).samples)
  );
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** The instrument a row, a pin or a run summary records. */
export function instrumentOf(x: InstrumentSource): Instrument {
  if (isSummary(x)) {
    const routing = routingColumnsFromSummary(x);
    const fields: Partial<Record<InstrumentField, string>> = {
      gradersHash: text(x.config.gradersHash),
      judgeModel: text(x.config.judgeModel),
      calibrationDigest: calibrationDigestOf(x),
      pluginsDigest: text(x.config.pluginsDigest),
      armsDigest: text(routing.armsDigest),
      policyVersion: text(routing.policyVersion),
    };
    return {
      ...defined(fields),
      source: "summary",
      routed: routing.routing !== undefined,
      ...(text(x.config.cliVersion) !== undefined ? { cliVersion: x.config.cliVersion } : {}),
    };
  }
  const fields: Partial<Record<InstrumentField, string>> = {};
  for (const field of INSTRUMENT_FIELDS) fields[field] = text(x[field]);
  return {
    ...defined(fields),
    source: "row",
    routed: x.armId !== undefined || (x.routing !== undefined && x.routing !== "static"),
  };
}

function defined(
  fields: Partial<Record<InstrumentField, string>>,
): Partial<Record<InstrumentField, string>> {
  const out: Partial<Record<InstrumentField, string>> = {};
  for (const field of INSTRUMENT_FIELDS) {
    const v = fields[field];
    if (v !== undefined) out[field] = v;
  }
  return out;
}

/** Whether a `cliVersion` is 0.9.0 or later. A missing or unreadable one is not. */
function recordsPluginsDigest(cliVersion: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cliVersion ?? "");
  if (m === null) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 0 || minor >= 9;
}

/**
 * How `run`'s instrument differs from `base`'s, field by field, by the table
 * in the module doc. An empty list means nothing recorded differs.
 */
export function instrumentChanges(
  base: InstrumentSource | Instrument,
  run: InstrumentSource | Instrument,
): InstrumentChange[] {
  const a = isInstrument(base) ? base : instrumentOf(base);
  const b = isInstrument(run) ? run : instrumentOf(run);
  const fromRow = a.source === "row" || b.source === "row";
  const routed = a.routed || b.routed;
  const changes: InstrumentChange[] = [];
  for (const field of INSTRUMENT_FIELDS) {
    const from = a[field];
    const to = b[field];
    if (from === undefined && to === undefined) continue;
    const sides = {
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    };
    if (from !== undefined && to !== undefined) {
      if (from !== to) changes.push({ field, ...sides });
      continue;
    }
    const absent = from === undefined ? a : b;
    let unverified: boolean | undefined;
    switch (field) {
      case "judgeModel":
        unverified = false;
        break;
      case "calibrationDigest":
        unverified = fromRow;
        break;
      case "pluginsDigest":
        unverified = fromRow || !recordsPluginsDigest(absent.cliVersion);
        break;
      case "gradersHash":
        unverified = true;
        break;
      case "armsDigest":
      case "policyVersion":
        unverified = routed ? true : undefined;
        break;
    }
    if (unverified === undefined) continue;
    changes.push(unverified ? { field, ...sides, unverified: true } : { field, ...sides });
  }
  return changes;
}

function isInstrument(x: InstrumentSource | Instrument): x is Instrument {
  return (x as Instrument).source === "summary" || (x as Instrument).source === "row";
}

/** One change as a line: `gradersHash: a → b`, with `(none)` for an absent side. */
export function formatInstrumentChange(change: InstrumentChange): string {
  return `${change.field}: ${change.from ?? "(none)"} → ${change.to ?? "(none)"}${
    change.unverified === true ? " (recorded on one side only)" : ""
  }`;
}
