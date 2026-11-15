import { z } from "zod";
import type { Spec } from "../index";
import type { SpecAddIssue } from "./delta-090";

/**
 * `schedule:` takes one of two forms (#514). The object form is one cron or
 * interval wake, armed as the control lane `schedule`. The list form is one to
 * eight named lanes, each the object form plus a `name`, each armed as its own
 * control lane `schedule:<name>` and resumed in its own scope (#513).
 *
 * A lane name is a dispatch key and part of a lane id, so it follows the lane
 * grammar: a lowercase letter, then lowercase letters, digits and `-`, at most
 * 32 characters. `_` is outside it, so a name can never carry a control-plane
 * id.
 */
const LANE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

const laneName = z
  .string()
  .regex(
    LANE_NAME_RE,
    "schedule[].name must start with a lowercase letter and use only a-z, 0-9 and -, at most 32 characters",
  );

/** The most lanes one harness declares. */
export const MAX_SCHEDULE_LANES = 8;

/**
 * A union of the object form and the list form that checks a value against one
 * of them only: an array against the list, anything else against the object
 * union. A plain union would answer a bad object with one generic union error;
 * this keeps every object-form issue, path and message as the object union
 * alone reports it. It is still a `ZodUnion`, so the JSON Schema describes both
 * forms (`anyOf`).
 */
class FormDispatchUnion<T extends readonly [z.ZodTypeAny, z.ZodTypeAny]> extends z.ZodUnion<T> {
  override _parse(input: z.ParseInput): z.ParseReturnType<this["_output"]> {
    const [objectForm, listForm] = this._def.options;
    return (Array.isArray(input.data) ? listForm : objectForm)._parse(input);
  }
}

type OptionalString = z.ZodOptional<z.ZodString>;

/** The object schemas `index.ts` declares for the two kinds. */
export type ScheduleCronObject = z.ZodObject<
  {
    kind: z.ZodLiteral<"cron">;
    cron: z.ZodString;
    timezone: OptionalString;
    jitter: OptionalString;
    instructions: OptionalString;
  },
  "strict"
>;
export type ScheduleIntervalObject = z.ZodObject<
  {
    kind: z.ZodLiteral<"interval">;
    every: z.ZodString;
    jitter: OptionalString;
    instructions: OptionalString;
  },
  "strict"
>;

type Named<O extends z.AnyZodObject> = z.ZodObject<
  z.objectUtil.extendShape<O["shape"], { name: z.ZodString }>,
  "strict"
>;

type ObjectForm = z.ZodDiscriminatedUnion<"kind", [ScheduleCronObject, ScheduleIntervalObject]>;
type ListForm = z.ZodArray<
  z.ZodDiscriminatedUnion<"kind", [Named<ScheduleCronObject>, Named<ScheduleIntervalObject>]>
>;

/** The `schedule:` schema: absent, the object form, or the list form. */
export type ScheduleBlock = z.ZodOptional<z.ZodUnion<[ObjectForm, ListForm]>>;

/**
 * The `schedule:` schema, built from the two object schemas `index.ts` already
 * declares, so this file needs no value import from it.
 */
export function scheduleBlockFrom(
  cron: ScheduleCronObject,
  interval: ScheduleIntervalObject,
): ScheduleBlock {
  const objectForm: ObjectForm = z.discriminatedUnion("kind", [cron, interval]);
  const listForm: ListForm = z
    .array(
      z.discriminatedUnion("kind", [
        cron.extend({ name: laneName }),
        interval.extend({ name: laneName }),
      ]),
    )
    .min(1, "schedule as a list needs at least one lane")
    .max(MAX_SCHEDULE_LANES, `schedule as a list takes at most ${MAX_SCHEDULE_LANES} lanes`);
  const union: z.ZodUnion<[ObjectForm, ListForm]> = new FormDispatchUnion({
    options: [objectForm, listForm],
    typeName: z.ZodFirstPartyTypeKind.ZodUnion,
  });
  return union.optional();
}

/**
 * The list form's one cross-field rule: lane names are unique, because each
 * names its own control lane and its own resume scope.
 */
export function scheduleIssues(data: Spec, custom: SpecAddIssue): void {
  if (!("schedule" in data) || !Array.isArray(data.schedule)) return;
  const seen = new Set<string>();
  data.schedule.forEach((lane, i) => {
    if (seen.has(lane.name)) {
      custom(
        ["schedule", i, "name"],
        `schedule[${i}].name "${lane.name}" is already used by another lane: lane names must be unique.`,
      );
    }
    seen.add(lane.name);
  });
}

/**
 * One cron field as the schedule runtime reads it (durable-execution's
 * `parseField`): `"*"` for any value, otherwise the values it names. `*`, `?`,
 * a field holding `L`, `W` or `#`, an unparsable number and a field whose
 * every value is out of range all mean any value.
 */
function cronField(field: string, min: number, max: number): "*" | ReadonlySet<number> {
  const trimmed = field.trim();
  if (trimmed === "*" || trimmed === "?") return "*";
  if (/[LW#]/i.test(trimmed)) return "*";
  const out = new Set<number>();
  for (const part of trimmed.split(",")) {
    const slash = part.indexOf("/");
    const rangeText = slash >= 0 ? part.slice(0, slash) : part;
    const step = slash >= 0 ? Math.max(1, Number.parseInt(part.slice(slash + 1), 10) || 1) : 1;
    let lo: number;
    let hi: number;
    if (rangeText === "*" || rangeText === "?" || rangeText === "") {
      lo = min;
      hi = max;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      lo = Number.parseInt(a ?? "", 10);
      hi = Number.parseInt(b ?? "", 10);
    } else {
      lo = Number.parseInt(rangeText, 10);
      hi = slash >= 0 ? max : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return "*";
    // Walk only the values inside [min, max], as the runtime does.
    let v = lo;
    if (v < min) {
      v = Number.isFinite(step) ? v + Math.ceil((min - v) / step) * step : Number.POSITIVE_INFINITY;
    }
    for (const end = Math.min(hi, max); v <= end; v += step) out.add(v);
  }
  return out.size === 0 ? "*" : out;
}

/** Days in each month, February counted as 29. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Why `cron` can never come round, or `undefined` when its days do. Only a
 * restricted day-of-month with an open day-of-week can miss: when both are
 * restricted the runtime fires on either, which comes round every week.
 */
function cronNeverFires(cron: string): string | undefined {
  const fields = cron.trim().split(/\s+/);
  const [, , , domR, monR, dowR] = fields.length >= 6 ? fields : ["0", ...fields];
  const dom = cronField(domR ?? "*", 1, 31);
  const dow = cronField(dowR ?? "*", 0, 7);
  if (dom === "*" || dow !== "*") return undefined;
  const mon = cronField(monR ?? "*", 1, 12);
  const pairs: Array<readonly [number, number]> = [];
  for (let m = 1; m <= 12; m++) {
    if (mon !== "*" && !mon.has(m)) continue;
    for (const d of dom) if (d <= (MONTH_DAYS[m - 1] ?? 0)) pairs.push([m, d]);
  }
  if (pairs.length === 0) return "can never fire: none of its months has that day.";
  if (pairs.every(([m, d]) => m === 2 && d === 29)) {
    return "fires only on 29 February, which can be more than a year away; add another day or month.";
  }
  return undefined;
}

/** True when this runtime's `Intl` knows `timezone`. */
function knownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * A cron schedule's `timezone` is one the runtime knows, and its `cron` names
 * a day that comes round: a day its months have, and not only 29 February.
 * Checked for the object form and for every cron lane, in declared order, a
 * lane's time zone before its cron. Each issue names the lane and the field.
 */
export function scheduleWakeIssues(data: Spec, custom: SpecAddIssue): void {
  if (!("schedule" in data) || data.schedule === undefined) return;
  const check = (
    wake: { readonly kind: string; readonly cron?: string; readonly timezone?: string },
    at: (string | number)[],
    label: string,
  ): void => {
    if (wake.kind !== "cron" || wake.cron === undefined) return;
    if (wake.timezone !== undefined && !knownTimeZone(wake.timezone)) {
      custom(
        [...at, "timezone"],
        `${label}timezone ${JSON.stringify(wake.timezone)} is not a time zone this runtime knows; use an IANA name such as "Europe/Berlin".`,
      );
    }
    const never = cronNeverFires(wake.cron);
    if (never !== undefined) {
      custom([...at, "cron"], `${label}cron ${JSON.stringify(wake.cron)} ${never}`);
    }
  };
  if (Array.isArray(data.schedule)) {
    data.schedule.forEach((lane, i) => {
      check(lane, ["schedule", i], `schedule[${i}] (${JSON.stringify(lane.name)}): `);
    });
  } else {
    check(data.schedule, ["schedule"], "schedule.");
  }
}
