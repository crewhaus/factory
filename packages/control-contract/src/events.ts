/** The control-plane event envelope and its versioned taxonomy, closed per build. */
import { MODULES, type ModuleField } from "./areas/index.js";
import type { EventFamilyDecl, EventSensitivity } from "./areas/types.js";
import { deepFreeze } from "./util.js";

export type { EventSensitivity } from "./areas/types.js";

export const EVENT_TAXONOMY_VERSION = 1;

type EventFamilyRow = ModuleField<"eventFamilies"> extends readonly (infer Row)[] ? Row : never;

export type EventType = EventFamilyRow extends { readonly types: readonly (infer Row)[] }
  ? Row extends { readonly type: infer T }
    ? T
    : never
  : never;

const FAMILIES: readonly EventFamilyDecl[] = MODULES.flatMap((module) => module.eventFamilies);

/** Every event type, with its family and its sensitivity. */
export const EVENT_TAXONOMY: Readonly<
  Record<EventType, { readonly family: string; readonly sensitivity: EventSensitivity }>
> = deepFreeze(
  Object.fromEntries(
    FAMILIES.flatMap((family) =>
      family.types.map((row) => [
        row.type,
        { family: family.family, sensitivity: row.sensitivity },
      ]),
    ),
  ) as Record<EventType, { family: string; sensitivity: EventSensitivity }>,
);

export const EVENT_TYPES: readonly EventType[] = deepFreeze(
  Object.keys(EVENT_TAXONOMY) as EventType[],
);

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && Object.hasOwn(EVENT_TAXONOMY, value);
}

export type EventEnvelope = {
  readonly v: 1;
  /** The cursor this event can be resumed after. */
  readonly id: string;
  readonly type: EventType;
  readonly at: string;
  readonly ingestedAt: string;
  readonly harness?: string;
  readonly run?: string;
  readonly work?: string;
  readonly decision?: string;
  readonly command?: string;
  readonly deployment?: string;
  readonly parent?: string;
  readonly actor?: string;
  readonly revision?: {
    readonly object: string;
    readonly rev: number;
  };
  readonly sensitivity: EventSensitivity;
  /** Small and already masked. */
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly payloadRef?: {
    readonly href: string;
    readonly bytes: number;
    readonly truncated: boolean;
  };
};

/** One SSE frame: `id:`, `event:`, `data:`. */
export type EventFrame = {
  readonly id: string;
  readonly event: EventType;
  readonly data: EventEnvelope;
};
