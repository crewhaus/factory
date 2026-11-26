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
  /** An attention item's ref, `home/attention/att_…`. */
  readonly attention?: string;
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

/**
 * Why a stream says something about itself, by its frame, closed. Each is the `reason` of
 * that frame's payload:
 *
 * - `stream.gap`: lines were `evicted` (retention dropped them), a line or a file was
 *   `unreadable` (reported and read past), or a frame was `withheld` (it is about people
 *   and the caller may not see it; the payload adds `hidden: ["people"]`). A gap's `id` is
 *   a cursor past what it stands for.
 * - `stream.reset`: the cursor no longer fits its records (`diverged`: a replaced or
 *   compacted file, a restored copy; the payload names `earliest` when there is one), or
 *   the fleet's change log was started again (`epoch`). The stream goes on from the start
 *   of what is retained.
 * - `stream.pause`: the stream ends at a cap of frames (`frame-cap`) or of time
 *   (`time-cap`), or because the run it follows moved to another execution
 *   (`execution`). It is never a terminal event: its payload's `resumeFrom` is the cursor
 *   to reconnect with, and the next frame after it is the one not yet sent.
 */
export const STREAM_REASONS = deepFreeze({
  "stream.gap": ["evicted", "unreadable", "withheld"],
  "stream.reset": ["diverged", "epoch"],
  "stream.pause": ["frame-cap", "time-cap", "execution"],
} as const);

export type StreamFrameType = keyof typeof STREAM_REASONS;

export type StreamReason<T extends StreamFrameType = StreamFrameType> =
  (typeof STREAM_REASONS)[T][number];

/** Whether `reason` is one a frame of this type gives. */
export function isStreamReason(type: string, reason: unknown): boolean {
  if (!Object.hasOwn(STREAM_REASONS, type)) return false;
  return (STREAM_REASONS[type as StreamFrameType] as readonly unknown[]).includes(reason);
}
