/**
 * The versioned API's lists: `?limit` (50 by default, at most 500) and `?cursor`, a page
 * cursor this list made. Every list answers `snapshotAt`, the position it was computed at,
 * says why it is empty (`empty`), and says when it was cut short (`truncated`): a gap or
 * an unreadable line is reported, never dropped.
 */
import {
  type CursorPosition,
  type CursorSource,
  type EMPTY_REASONS,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  decodeCursor,
  encodeCursor,
} from "@crewhaus/control-contract";
import { V1Error } from "./errors";

export type ListPaging = {
  readonly limit: number;
  /** Where to resume, from the cursor this list handed out. */
  readonly before?: CursorPosition;
};

/** `?limit` and `?cursor`, checked. A cursor from another list is refused. */
export function pagingOf(
  query: Readonly<Record<string, string>>,
  source: CursorSource,
): ListPaging {
  let limit = PAGE_LIMIT_DEFAULT;
  const raw = query["limit"];
  if (raw !== undefined) {
    const n = Number(raw);
    if (!/^[0-9]{1,4}$/.test(raw) || !Number.isInteger(n) || n < 1 || n > PAGE_LIMIT_MAX) {
      throw new V1Error({
        status: 400,
        code: "invalid",
        reason: "limit",
        message: `limit is a whole number from 1 to ${PAGE_LIMIT_MAX}.`,
      });
    }
    limit = n;
  }
  const cursor = query["cursor"];
  if (cursor === undefined) return { limit };
  const decoded = decodeCursor(cursor);
  const position =
    decoded.ok && decoded.cursor.kind === "page" ? decoded.cursor.sources[source]?.[0] : undefined;
  if (position === undefined) {
    throw new V1Error({
      status: 400,
      code: "invalid",
      reason: "cursor",
      message: "That cursor does not belong to this list. Start from the first page.",
    });
  }
  return { limit, before: position };
}

/** The cursor of the next page, for this list's source. */
export function nextCursor(source: CursorSource, position: CursorPosition): string {
  return encodeCursor({
    v: 1,
    kind: "page",
    sources: { [source]: [position] },
    direction: "older",
  });
}

/** The position a ledger list was computed at. */
export function snapshotCursor(source: CursorSource, positions: readonly CursorPosition[]): string {
  return encodeCursor({ v: 1, kind: "vector", sources: { [source]: positions } });
}

/** A fleet list is computed from records, not a stream: its position is the access epoch. */
export function fleetSnapshot(epoch: number): string {
  return encodeCursor({ v: 1, kind: "fleet", epoch, seq: 0 });
}

export type EmptyReason = (typeof EMPTY_REASONS)[number];

/** Why a list is empty, and what fills it. */
export function emptyOf(
  items: readonly unknown[],
  reason: EmptyReason,
  remedy?: string,
): { readonly empty?: { readonly reason: EmptyReason; readonly remedy?: string } } {
  if (items.length > 0) return {};
  return { empty: { reason, ...(remedy !== undefined ? { remedy } : {}) } };
}
