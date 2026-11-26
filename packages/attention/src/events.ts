/**
 * An actions line as the event a harness's stream sends: the item's ref, who acted, and
 * closed codes. No text, no note, no name, and not the member an item was assigned to. Pure.
 */
import {
  ATTENTION_ACTION_EVENTS,
  ATTENTION_CHOICE_IDS,
  ATTENTION_ID_RE,
  ATTENTION_RESOLUTIONS,
  ATTENTION_STATES,
  type AttentionActionEvent,
  DEFER_REASONS,
  DISMISS_REASONS,
  EVENT_TAXONOMY,
  type EventSensitivity,
  type EventType,
  attentionRef,
  isStoredActor,
} from "@crewhaus/control-contract";
import { timeOf } from "./items";

export type AttentionEvent = {
  readonly type: EventType;
  readonly at: string;
  /** `home/attention/att_…`. */
  readonly attention: string;
  readonly actor: string;
  readonly sensitivity: EventSensitivity;
  readonly payload: Readonly<Record<string, string>>;
};

const listed = (list: readonly string[], value: unknown): value is string =>
  typeof value === "string" && list.includes(value);

/** One actions line's event, or `undefined` for a line that is not one. */
export function attentionEventOf(
  record: Readonly<Record<string, unknown>>,
): AttentionEvent | undefined {
  const { id, event, state, by, how, choice, reasonCode } = record;
  const at = timeOf(record["at"]);
  if (
    typeof id !== "string" ||
    !ATTENTION_ID_RE.test(id) ||
    !listed(ATTENTION_ACTION_EVENTS, event) ||
    !listed(ATTENTION_STATES, state) ||
    !isStoredActor(by) ||
    at === undefined
  ) {
    return undefined;
  }
  const type = `attention.${event as AttentionActionEvent}` as EventType;
  const until = timeOf(record["until"]);
  return {
    type,
    at,
    attention: attentionRef(id),
    actor: by as string,
    sensitivity: EVENT_TAXONOMY[type].sensitivity,
    payload: {
      state,
      ...(listed(ATTENTION_RESOLUTIONS, how) ? { how } : {}),
      ...(listed(ATTENTION_CHOICE_IDS, choice) ? { choice } : {}),
      ...(listed([...DEFER_REASONS, ...DISMISS_REASONS], reasonCode) ? { reasonCode } : {}),
      ...(until !== undefined ? { until } : {}),
    },
  };
}
