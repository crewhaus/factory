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
