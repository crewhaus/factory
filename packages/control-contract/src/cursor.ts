/**
 * The cursor codec: a stream or page position as an opaque string an SSE `id:`
 * and `Last-Event-ID` carry. It only encodes and checks the shape; finding the
 * positions, and reporting a gap or a reset, belongs to whoever reads the files.
 *
 * Canonical JSON as lowercase Crockford base32, whose alphabet cannot form the
 * shapes Hangar's masker rewrites. Decoding re-encodes and compares, so one
 * position has exactly one string.
 */
import { decodeBase32, encodeBase32 } from "./base32.js";
import { canonicalJson } from "./canonical-json.js";
import { deepFreeze } from "./util.js";

export const CURSOR_MAX_LENGTH = 2048;

/** A closed list: a source id is never a path or a person. */
export const CURSOR_SOURCES = deepFreeze([
  "rows",
  "trace",
  "session",
  "runs",
  "commands",
  "deployments",
  "decisions",
  "approvals",
] as const);

export type CursorSource = (typeof CURSOR_SOURCES)[number];

export type CursorPosition = {
  readonly seg: number;
  readonly off: number;
  /** The first 8 hex of a hash of the bytes before `off`; empty only at offset 0. */
  readonly tail: string;
};

export type CursorSources = Readonly<Partial<Record<CursorSource, readonly CursorPosition[]>>>;

export type VectorCursor = {
  readonly v: 1;
  readonly kind: "vector";
  readonly sources: CursorSources;
};

export type FleetCursor = {
  readonly v: 1;
  readonly kind: "fleet";
  readonly epoch: number;
  readonly seq: number;
};

export type PageCursor = {
  readonly v: 1;
  readonly kind: "page";
  readonly sources: CursorSources;
  readonly direction: "older";
};

export type Cursor = VectorCursor | FleetCursor | PageCursor;

export type CursorDecodeFailure = "malformed" | "too-long" | "unsupported-version" | "invalid";

export type CursorDecodeResult =
  | { readonly ok: true; readonly cursor: Cursor }
  | { readonly ok: false; readonly reason: CursorDecodeFailure };

const TAIL_RE = /^[0-9a-f]{8}$/;
const MAX_POSITIONS = 2;

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is CursorPosition {
  if (!isPlainObject(value) || !hasExactKeys(value, ["seg", "off", "tail"])) return false;
  const { seg, off, tail } = value;
  if (!isCount(seg) || !isCount(off) || typeof tail !== "string") return false;
  return TAIL_RE.test(tail) || (tail === "" && off === 0);
}

function isPositionList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_POSITIONS) return false;
  if (!value.every(isPosition)) return false;
  const [first, second] = value as CursorPosition[];
  return second === undefined || (first as CursorPosition).seg < second.seg;
}

function isSources(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0) return false;
  return keys.every(
    (key) => (CURSOR_SOURCES as readonly string[]).includes(key) && isPositionList(value[key]),
  );
}

function isCursorShape(value: Record<string, unknown>): boolean {
  switch (value["kind"]) {
    case "vector":
      return hasExactKeys(value, ["v", "kind", "sources"]) && isSources(value["sources"]);
    case "fleet":
      return (
        hasExactKeys(value, ["v", "kind", "epoch", "seq"]) &&
        isCount(value["epoch"]) &&
        isCount(value["seq"])
      );
    case "page":
      return (
        hasExactKeys(value, ["v", "kind", "sources", "direction"]) &&
        value["direction"] === "older" &&
        isSources(value["sources"])
      );
    default:
      return false;
  }
}

/** Encode a position. One this codec would refuse to decode throws. */
export function encodeCursor(cursor: Cursor): string {
  if (!isPlainObject(cursor) || cursor.v !== 1 || !isCursorShape(cursor)) {
    throw new TypeError("control-contract: not a cursor");
  }
  const text = encodeBase32(new TextEncoder().encode(canonicalJson(cursor)));
  if (text.length > CURSOR_MAX_LENGTH) {
    throw new RangeError(`control-contract: a cursor is at most ${CURSOR_MAX_LENGTH} characters`);
  }
  return text;
}

const FAIL = (reason: CursorDecodeFailure): CursorDecodeResult => ({ ok: false, reason });

/** Decode a cursor, or say why it cannot be used. It never throws. */
export function decodeCursor(text: unknown): CursorDecodeResult {
  if (typeof text !== "string" || text.length === 0) return FAIL("malformed");
  if (text.length > CURSOR_MAX_LENGTH) return FAIL("too-long");
  const bytes = decodeBase32(text);
  if (bytes === null) return FAIL("malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return FAIL("malformed");
  }
  if (!isPlainObject(parsed)) return FAIL("invalid");
  if (typeof parsed["v"] === "number" && parsed["v"] !== 1) return FAIL("unsupported-version");
  if (parsed["v"] !== 1 || !isCursorShape(parsed)) return FAIL("invalid");
  const canonical = encodeBase32(new TextEncoder().encode(canonicalJson(parsed)));
  if (canonical !== text) return FAIL("invalid");
  return { ok: true, cursor: parsed as Cursor };
}

/** Whether this string is a usable cursor. */
export function isCursor(text: unknown): boolean {
  return decodeCursor(text).ok;
}
