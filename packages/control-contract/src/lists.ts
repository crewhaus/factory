/** The list envelope: a cut-short or empty list says why. */
import { deepFreeze } from "./util.js";

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 500;

export const EMPTY_REASONS = deepFreeze([
  "no-data",
  "no-access",
  "unsupported",
  "filtered",
  "not-indexed",
  "unreachable",
  "expired",
  // The harness's active agreement does not allow it, so nothing can fill the list yet.
  "not-allowed",
] as const);

export type EmptyReason = (typeof EMPTY_REASONS)[number];

export type ListTruncated = {
  readonly reason: string;
  /** A real CLI command that reads the rest. Absent when there is none. */
  readonly verb?: string;
};

export type ListEmpty = {
  readonly reason: EmptyReason;
  readonly remedy?: string;
};

export type ListEnvelope<T> = {
  readonly items: readonly T[];
  /** The cursor of the next page, older for runs, commands and decisions. */
  readonly next?: string;
  /** The position this page was computed at: subscribe from it, with no gap or repeat. */
  readonly snapshotAt: string;
  readonly truncated?: ListTruncated;
  readonly empty?: ListEmpty;
};

export type ListQuery = {
  readonly limit?: number;
  readonly cursor?: string;
};

export type StreamQuery = {
  readonly after?: string;
};
