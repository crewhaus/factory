import { describe, expect, test } from "bun:test";
import {
  CURSOR_MAX_LENGTH,
  CURSOR_SOURCES,
  type Cursor,
  canonicalJson,
  decodeCursor,
  encodeBase32,
  encodeCursor,
} from "./index.js";

const TAIL = "0a1b2c3d";
const VECTOR: Cursor = {
  v: 1,
  kind: "vector",
  sources: {
    rows: [{ seg: 1, off: 40, tail: TAIL }],
    trace: [
      { seg: 2, off: 0, tail: "" },
      { seg: 3, off: 7, tail: TAIL },
    ],
  },
};
const FLEET: Cursor = { v: 1, kind: "fleet", epoch: 3, seq: 99 };
const PAGE: Cursor = {
  v: 1,
  kind: "page",
  sources: { runs: [{ seg: 0, off: 0, tail: "" }] },
  direction: "older",
};

/** Encode any value the way the codec does, valid or not. */
function raw(value: unknown): string {
  return encodeBase32(new TextEncoder().encode(canonicalJson(value)));
}

function reason(value: unknown): string {
  const result = decodeCursor(value);
  return result.ok ? "ok" : result.reason;
}

describe("round trips", () => {
  for (const [kind, cursor] of [
    ["vector", VECTOR],
    ["fleet", FLEET],
    ["page", PAGE],
  ] as const) {
    test(`${kind} is canonical`, () => {
      const text = encodeCursor(cursor);
      expect(decodeCursor(text)).toEqual({ ok: true, cursor });
      const decoded = decodeCursor(text);
      expect(decoded.ok && encodeCursor(decoded.cursor)).toBe(text);
      expect(text).toMatch(/^[0-9a-hjkmnp-tv-z]+$/);
    });
  }

  test("key order does not change the string", () => {
    const reordered = {
      seq: 99,
      epoch: 3,
      kind: "fleet",
      v: 1,
    } as unknown as Cursor;
    expect(encodeCursor(reordered)).toBe(encodeCursor(FLEET));
  });

  test("the largest legal cursor still fits", () => {
    const position = (seg: number) => ({ seg, off: Number.MAX_SAFE_INTEGER, tail: TAIL });
    const sources = Object.fromEntries(
      CURSOR_SOURCES.map((source) => [
        source,
        [position(Number.MAX_SAFE_INTEGER - 1), position(Number.MAX_SAFE_INTEGER)],
      ]),
    );
    const largest: Cursor = { v: 1, kind: "page", sources, direction: "older" };
    expect(CURSOR_SOURCES).toHaveLength(8);
    const text = encodeCursor(largest);
    expect(text.length).toBeGreaterThan(1800);
    expect(text.length).toBeLessThanOrEqual(CURSOR_MAX_LENGTH);
    expect(decodeCursor(text).ok).toBe(true);
  });
});

describe("refusals name the reason", () => {
  const text = encodeCursor(VECTOR);

  test("malformed", () => {
    expect(reason("")).toBe("malformed");
    expect(reason(7)).toBe("malformed");
    expect(reason(null)).toBe("malformed");
    expect(reason("not base32!")).toBe("malformed");
    expect(reason(text.toUpperCase())).toBe("malformed");
    expect(reason(raw("x").slice(0, 2))).toBe("malformed");
  });

  test("tampering: a character outside the alphabet, or broken JSON", () => {
    expect(reason(`u${text.slice(1)}`)).toBe("malformed");
    expect(reason(`z${text.slice(1)}`)).toBe("malformed");
  });

  test("truncation", () => {
    expect(reason(text.slice(0, text.length - 8))).toBe("malformed");
    expect(reason(text.slice(0, 5))).toBe("malformed");
  });

  test("stray padding bits", () => {
    // Change the unused low bits of the last character, keeping the same bytes.
    const short = encodeCursor(FLEET);
    const lastBits = (short.length * 5) % 8;
    if (lastBits === 0) throw new Error("this sample has no padding bits to tamper with");
    const last = short.charAt(short.length - 1);
    const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
    const tampered = short.slice(0, -1) + alphabet.charAt(alphabet.indexOf(last) + 1);
    expect(reason(tampered)).toBe("malformed");
  });

  test("too long, before anything is decoded", () => {
    expect(reason("0".repeat(CURSOR_MAX_LENGTH + 1))).toBe("too-long");
    expect(reason("!".repeat(CURSOR_MAX_LENGTH + 1))).toBe("too-long");
  });

  test("an unsupported version", () => {
    expect(reason(raw({ v: 2, kind: "fleet", epoch: 1, seq: 1 }))).toBe("unsupported-version");
    expect(reason(raw({ v: 0, kind: "mystery" }))).toBe("unsupported-version");
  });

  const position = { seg: 1, off: 8, tail: TAIL };
  const vector = (positions: unknown) => ({ v: 1, kind: "vector", sources: { rows: positions } });

  const invalid: readonly (readonly [string, unknown])[] = [
    ["not an object", [1]],
    ["no version", { kind: "fleet", epoch: 1, seq: 1 }],
    ["a string version", { v: "1", kind: "fleet", epoch: 1, seq: 1 }],
    ["an unknown kind", { v: 1, kind: "other" }],
    ["an unknown key at the root", { v: 1, kind: "fleet", epoch: 1, seq: 1, extra: 1 }],
    ["an unknown source", { v: 1, kind: "vector", sources: { "/etc/passwd": [position] } }],
    ["a person as a source", { v: 1, kind: "vector", sources: { sam: [position] } }],
    ["no sources", { v: 1, kind: "vector", sources: {} }],
    ["no positions", vector([])],
    ["three positions", vector([position, { ...position, seg: 2 }, { ...position, seg: 3 }])],
    ["descending segments", vector([{ ...position, seg: 2 }, position])],
    ["equal segments", vector([position, position])],
    ["a negative offset", vector([{ ...position, off: -1 }])],
    ["a fractional offset", vector([{ ...position, off: 1.5 }])],
    ["an unsafe offset", vector([{ ...position, off: 2 ** 53 }])],
    ["a string segment", vector([{ ...position, seg: "1" }])],
    ["a short tail", vector([{ ...position, tail: "abc" }])],
    ["an uppercase tail", vector([{ ...position, tail: "ABCDEF01" }])],
    ["an empty tail past offset 0", vector([{ ...position, tail: "" }])],
    ["an unknown position key", vector([{ ...position, extra: 1 }])],
    ["a missing position key", vector([{ seg: 1, off: 0 }])],
    ["a page with another direction", { v: 1, kind: "page", sources: {}, direction: "newer" }],
    [
      "a page going nowhere",
      { v: 1, kind: "page", sources: { rows: [position] }, direction: "newer" },
    ],
    ["a page with no direction", { v: 1, kind: "page", sources: { rows: [position] } }],
    ["a fleet with a bad epoch", { v: 1, kind: "fleet", epoch: -1, seq: 1 }],
    ["a fleet with a bad sequence", { v: 1, kind: "fleet", epoch: 1, seq: "1" }],
  ];
  for (const [name, value] of invalid) {
    test(`invalid: ${name}`, () => {
      expect(reason(raw(value))).toBe("invalid");
    });
  }

  test("invalid: a string that is not canonical", () => {
    const loose = encodeBase32(
      new TextEncoder().encode('{"seq":1,"epoch":1,"kind":"fleet","v":1}'),
    );
    expect(reason(loose)).toBe("invalid");
  });

  test("encoding what could not decode throws", () => {
    expect(() => encodeCursor({ v: 2 } as never)).toThrow("not a cursor");
    expect(() => encodeCursor(vector([]) as never)).toThrow("not a cursor");
  });
});
