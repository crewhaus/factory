/**
 * The pure core. Every function here is tested directly, because a bug in
 * `isIpv6` or in the `oneOf` branch counter reads better as a failing unit
 * than as a failing tool call.
 */
import { describe, expect, test } from "bun:test";
import { ASSERT_OPS, checkRequired, isEmptyValue, runChecks } from "./lib/assert";
import { compareValues, firstDifference, groupByCanonical, matchesAnyPattern } from "./lib/compare";
import {
  FORMAT_NAMES,
  checkFormat,
  daysInMonth,
  isDate,
  isDateTime,
  isEmail,
  isFormatName,
  isHostname,
  isIpv4,
  isIpv6,
  isJsonPointer,
  isRegex,
  isTime,
  isUri,
  isUriReference,
  isUuid,
  matchingFormats,
} from "./lib/formats";
import { commonFormat, distinctCount, inferSchema } from "./lib/infer";
import { type Schema, checkSchemaShape, validateValue } from "./lib/jsonschema";
import {
  checkReferences,
  collectFieldValues,
  findDuplicates,
  validateRecords,
} from "./lib/records";
import { diffSchemas } from "./lib/schemadiff";
import { closestMatch, editDistance } from "./lib/suggest";
import { listDefinitions, renderFieldTable, summarizeSchema } from "./lib/summarize";
import {
  canonicalize,
  deepEqual,
  escapePointerToken,
  getPath,
  getPointer,
  isJsonValue,
  isPlainObject,
  joinPointer,
  matchesType,
  parseDottedPath,
  parsePointer,
  preview,
  typeOf,
  unescapePointerToken,
} from "./lib/value";

// ---------------------------------------------------------------------------

describe("value: typeOf and friends", () => {
  test("names every JSON type, with integer split out", () => {
    expect(typeOf(null)).toBe("null");
    expect(typeOf(true)).toBe("boolean");
    expect(typeOf(3)).toBe("integer");
    expect(typeOf(3.5)).toBe("number");
    expect(typeOf("x")).toBe("string");
    expect(typeOf([])).toBe("array");
    expect(typeOf({})).toBe("object");
  });

  test("an integer satisfies number but not the reverse", () => {
    expect(matchesType("integer", "number")).toBe(true);
    expect(matchesType("number", "integer")).toBe(false);
    expect(matchesType("string", "string")).toBe(true);
  });

  test("isPlainObject excludes null and arrays", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
  });

  test("isJsonValue rejects what JSON cannot carry", () => {
    expect(isJsonValue({ a: [1, "x", null, true] })).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue({ a: () => 1 })).toBe(false);
  });

  test("isJsonValue reports false for a cycle instead of hanging", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    expect(isJsonValue(cyclic)).toBe(false);
  });
});

describe("value: JSON Pointer", () => {
  test("escaping is reversible and handles both special characters", () => {
    expect(escapePointerToken("a/b~c")).toBe("a~1b~0c");
    expect(unescapePointerToken("a~1b~0c")).toBe("a/b~c");
  });

  test("the empty pointer is the whole document", () => {
    expect(parsePointer("")).toEqual([]);
    expect(parsePointer("#")).toEqual([]);
  });

  test("a pointer without a leading slash is rejected", () => {
    expect(() => parsePointer("a/b")).toThrow(/must start/);
  });

  test("joinPointer escapes the token it appends", () => {
    expect(joinPointer("", "a/b")).toBe("/a~1b");
    expect(joinPointer("/x", 2)).toBe("/x/2");
  });

  test("getPointer walks objects and arrays", () => {
    const value = { items: [{ id: "a" }, { id: "b" }] };
    expect(getPointer(value, "/items/1/id").value).toBe("b");
    expect(getPointer(value, "/items/9/id").found).toBe(false);
  });
});

describe("value: dotted paths", () => {
  test("accepts dots, bracket indices and quoted keys", () => {
    expect(parseDottedPath("a.b")).toEqual(["a", "b"]);
    expect(parseDottedPath("a[0].b")).toEqual(["a", "0", "b"]);
    expect(parseDottedPath("a.0.b")).toEqual(["a", "0", "b"]);
    expect(parseDottedPath('["odd.key"].b')).toEqual(["odd.key", "b"]);
  });

  test("an empty path means the value itself", () => {
    expect(parseDottedPath("")).toEqual([]);
    expect(parseDottedPath("$")).toEqual([]);
  });

  test("resolution reports where it ran out", () => {
    const resolution = getPath({ a: { b: 1 } }, "a.c.d");
    expect(resolution.found).toBe(false);
    expect(resolution.missingAt).toBe("a.c");
  });

  test("a present key holding undefined still counts as found", () => {
    expect(getPath({ a: undefined }, "a").found).toBe(true);
  });

  test("a negative or non-numeric array index does not resolve", () => {
    expect(getPath({ a: [1, 2] }, "a.x").found).toBe(false);
  });
});

describe("value: canonicalize and deepEqual", () => {
  test("key order does not change the canonical form", () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  test("array order does change it", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  test("non-JSON values are marked, not dropped", () => {
    expect(canonicalize({ a: undefined })).not.toBe(canonicalize({}));
    expect(canonicalize(Number.NaN)).toContain("NaN");
  });

  test("non-JSON values still canonicalize apart from each other", () => {
    // A shared marker would make every bigint one key, and every duplicate
    // check that reached one would report a collision that is not there.
    expect(canonicalize(1n)).not.toBe(canonicalize(2n));
    expect(canonicalize(Number.NaN)).not.toBe(canonicalize(Number.POSITIVE_INFINITY));
    expect(canonicalize(undefined)).not.toBe(canonicalize(null));
  });

  test("deepEqual ignores key order but not membership", () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  test("NaN is not equal to itself, following ===", () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(false);
  });

  test("preview collapses whitespace and caps length", () => {
    expect(preview({ a: "x" })).toBe('{"a":"x"}');
    expect(preview("y".repeat(200), 20).length).toBe(20);
    expect(preview(undefined)).toBe("undefined");
  });
});

// ---------------------------------------------------------------------------

describe("formats: hostname", () => {
  test("accepts a normal name and rejects the edges", () => {
    expect(isHostname("api.example.com").valid).toBe(true);
    expect(isHostname("localhost").valid).toBe(true);
    expect(isHostname("").valid).toBe(false);
    expect(isHostname("example.com.").valid).toBe(false);
    expect(isHostname("-bad.example.com").valid).toBe(false);
    expect(isHostname("under_score.com").valid).toBe(false);
  });

  test("a label over 63 characters is rejected with a reason", () => {
    const result = isHostname(`${"a".repeat(64)}.com`);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("63");
  });
});

describe("formats: ipv4 and ipv6", () => {
  test("ipv4 accepts the bounds and rejects leading zeros", () => {
    expect(isIpv4("0.0.0.0").valid).toBe(true);
    expect(isIpv4("255.255.255.255").valid).toBe(true);
    expect(isIpv4("256.1.1.1").valid).toBe(false);
    expect(isIpv4("01.2.3.4").valid).toBe(false);
    expect(isIpv4("1.2.3").valid).toBe(false);
  });

  test("ipv6 handles full form, compression and an IPv4 tail", () => {
    expect(isIpv6("2001:0db8:85a3:0000:0000:8a2e:0370:7334").valid).toBe(true);
    expect(isIpv6("2001:db8::8a2e:370:7334").valid).toBe(true);
    expect(isIpv6("::1").valid).toBe(true);
    expect(isIpv6("::").valid).toBe(true);
    expect(isIpv6("::ffff:192.0.2.1").valid).toBe(true);
  });

  test("ipv6 rejects two compressions, a zone id and a bad group", () => {
    expect(isIpv6("2001::db8::1").valid).toBe(false);
    expect(isIpv6("fe80::1%eth0").valid).toBe(false);
    expect(isIpv6("2001:db8:zzzz::1").valid).toBe(false);
    expect(isIpv6("1:2:3:4:5:6:7").valid).toBe(false);
  });

  test("ipv6 rejects a stray colon, which is not the same as a compression", () => {
    // `x.split("::")` sees ":::" as one compression followed by a lone colon,
    // and a trailing colon leaves an empty group. Both are malformed, and
    // both used to pass.
    expect(isIpv6(":::").valid).toBe(false);
    expect(isIpv6("1:::2").valid).toBe(false);
    expect(isIpv6("1:2:3:4:5:6:7:8:").valid).toBe(false);
    expect(isIpv6("2001:db8::1:").valid).toBe(false);
    expect(isIpv6(":1:2:3:4:5:6:7").valid).toBe(false);
    expect(isIpv6(":").valid).toBe(false);
  });

  test('ipv6 counts what "::" stands for, so it must cover a group', () => {
    // Seven groups written out leaves one for the compression; eight leaves
    // none, and RFC 4291 requires it to stand for at least one.
    expect(isIpv6("1:2:3:4:5:6:7::").valid).toBe(true);
    expect(isIpv6("1:2:3:4:5:6:7:8::").valid).toBe(false);
    expect(isIpv6("::1:2:3:4:5:6:7:8").valid).toBe(false);
    // A dotted quad stands for the last two groups: six written plus two.
    expect(isIpv6("1:2:3:4:5:6:1.2.3.4").valid).toBe(true);
    expect(isIpv6("1:2:3:4:5:6:7:1.2.3.4").valid).toBe(false);
    // The quad is only ever the last group, never the first.
    expect(isIpv6("1.2.3.4::1").valid).toBe(false);
    // ...and it is a real IPv4 address, leading-zero rule included.
    expect(isIpv6("::01.2.3.4").valid).toBe(false);
    expect(isIpv6("::1.2.3.4.5").valid).toBe(false);
  });
});

describe("formats: uuid, date and time", () => {
  test("uuid checks the shape, not the version", () => {
    expect(isUuid("00000000-0000-0000-0000-000000000000").valid).toBe(true);
    expect(isUuid("F81D4FAE-7DEC-11D0-A765-00A0C91E6BF6").valid).toBe(true);
    expect(isUuid("f81d4fae7dec11d0a76500a0c91e6bf6").valid).toBe(false);
    expect(isUuid("{f81d4fae-7dec-11d0-a765-00a0c91e6bf6}").valid).toBe(false);
  });

  test("daysInMonth follows the Gregorian leap rule", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2023, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });

  test("date validates the calendar, not just the shape", () => {
    expect(isDate("2024-02-29").valid).toBe(true);
    expect(isDate("2023-02-29").valid).toBe(false);
    expect(isDate("2023-13-01").valid).toBe(false);
    expect(isDate("2023-1-1").valid).toBe(false);
  });

  test("time requires an offset and allows a leap second", () => {
    expect(isTime("12:30:00Z").valid).toBe(true);
    expect(isTime("12:30:60Z").valid).toBe(true);
    expect(isTime("12:30:00.123+02:00").valid).toBe(true);
    expect(isTime("12:30:00").valid).toBe(false);
    expect(isTime("24:00:00Z").valid).toBe(false);
  });

  test("date-time requires the T separator", () => {
    expect(isDateTime("2024-01-02T03:04:05Z").valid).toBe(true);
    expect(isDateTime("2024-01-02 03:04:05Z").valid).toBe(false);
    expect(isDateTime("2024-02-30T00:00:00Z").reason).toContain("date part");
  });
});

describe("formats: email, uri and pointer", () => {
  test("email accepts the ordinary shapes", () => {
    expect(isEmail("a.b+tag@example.co.uk").valid).toBe(true);
    expect(isEmail("first_last@sub.example.com").valid).toBe(true);
  });

  test("email rejects the shapes this subset does not cover", () => {
    expect(isEmail("no-at-sign").valid).toBe(false);
    expect(isEmail("a@localhost").valid).toBe(false);
    expect(isEmail("a..b@example.com").valid).toBe(false);
    expect(isEmail(".a@example.com").valid).toBe(false);
    expect(isEmail('"quoted local"@example.com').valid).toBe(false);
    expect(isEmail("a@[192.0.2.1]").valid).toBe(false);
  });

  test("uri wants a scheme; uri-reference does not", () => {
    expect(isUri("https://example.com/a?b=1#c").valid).toBe(true);
    expect(isUri("mailto:a@example.com").valid).toBe(true);
    expect(isUri("/just/a/path").valid).toBe(false);
    expect(isUriReference("/just/a/path").valid).toBe(true);
    expect(isUri("https://example.com/a b").valid).toBe(false);
  });

  test("json-pointer and regex formats", () => {
    expect(isJsonPointer("").valid).toBe(true);
    expect(isJsonPointer("/a~0b/c").valid).toBe(true);
    expect(isJsonPointer("a/b").valid).toBe(false);
    expect(isJsonPointer("/a~2b").valid).toBe(false);
    expect(isRegex("^a+$").valid).toBe(true);
    expect(isRegex("(unclosed").valid).toBe(false);
  });

  test("checkFormat dispatches every declared name and isFormatName guards it", () => {
    for (const name of FORMAT_NAMES) {
      expect(typeof checkFormat("x", name).valid).toBe("boolean");
      expect(isFormatName(name)).toBe(true);
    }
    expect(isFormatName("idn-email")).toBe(false);
  });

  test("matchingFormats reports what a value does look like", () => {
    expect(matchingFormats("a@example.com")).toContain("email");
    expect(matchingFormats("2024-01-02")).toContain("date");
    expect(matchingFormats("anything at all")).toEqual([]);
  });

  test("matchingFormats puts the narrowest format first, not the declared one", () => {
    // A hostname label is letters, digits and hyphens, so a date, a UUID and
    // a dotted quad are all valid hostnames too. Whoever reads the first
    // entry must get the format that rules the most out.
    expect(matchingFormats("2024-01-02")).toEqual(["date", "hostname"]);
    expect(matchingFormats("550e8400-e29b-41d4-a716-446655440000")).toEqual(["uuid", "hostname"]);
    expect(matchingFormats("192.0.2.1")).toEqual(["ipv4", "hostname"]);
  });
});

// ---------------------------------------------------------------------------

describe("jsonschema: types and basics", () => {
  test("a matching value passes with no errors", () => {
    expect(validateValue({ a: 1 }, { type: "object" }).valid).toBe(true);
  });

  test("a wrong type is reported with the path and both types", () => {
    const result = validateValue({ a: "x" }, { properties: { a: { type: "number" } } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toBe("/a");
    expect(result.errors[0]?.keyword).toBe("type");
    expect(result.errors[0]?.message).toContain("expected number, found string");
  });

  test("an integer satisfies number, and a fraction does not satisfy integer", () => {
    expect(validateValue(3, { type: "number" }).valid).toBe(true);
    expect(validateValue(3, { type: "integer" }).valid).toBe(true);
    expect(validateValue(3.5, { type: "integer" }).valid).toBe(false);
  });

  test("a type array accepts any listed member", () => {
    const schema = { type: ["string", "null"] };
    expect(validateValue("x", schema).valid).toBe(true);
    expect(validateValue(null, schema).valid).toBe(true);
    expect(validateValue(1, schema).valid).toBe(false);
  });

  test("boolean schemas accept or reject everything", () => {
    expect(validateValue({ anything: 1 }, true).valid).toBe(true);
    expect(validateValue(1, false).valid).toBe(false);
    expect(validateValue({ a: 1 }, { properties: { a: false } }).errors[0]?.path).toBe("/a");
  });

  test("enum and const compare structurally", () => {
    expect(validateValue({ a: 1 }, { enum: [{ a: 1 }] }).valid).toBe(true);
    expect(validateValue("c", { enum: ["a", "b"] }).errors[0]?.keyword).toBe("enum");
    expect(validateValue(5, { const: 5 }).valid).toBe(true);
    expect(validateValue(5, { const: 6 }).errors[0]?.keyword).toBe("const");
  });
});

describe("jsonschema: numbers and strings", () => {
  test("inclusive and exclusive bounds", () => {
    expect(validateValue(1, { minimum: 1 }).valid).toBe(true);
    expect(validateValue(0, { minimum: 1 }).errors[0]?.keyword).toBe("minimum");
    expect(validateValue(1, { exclusiveMinimum: 1 }).errors[0]?.keyword).toBe("exclusiveMinimum");
    expect(validateValue(10, { maximum: 9 }).errors[0]?.keyword).toBe("maximum");
    expect(validateValue(9, { exclusiveMaximum: 9 }).errors[0]?.keyword).toBe("exclusiveMaximum");
  });

  test("multipleOf tolerates binary floating point", () => {
    expect(validateValue(0.3, { multipleOf: 0.1 }).valid).toBe(true);
    expect(validateValue(7.5, { multipleOf: 2.5 }).valid).toBe(true);
    expect(validateValue(7, { multipleOf: 2 }).valid).toBe(false);
  });

  test("multipleOf stays exact for integers past the float tolerance", () => {
    // 10^20 mod 7: 10 = 3 (mod 7) and 3^6 = 1 (mod 7), so 3^20 = 3^2 = 2.
    // Not a multiple — but 10^20/7 is above 2^53, where every double is
    // already an integer, so a nearest-integer test would have passed it.
    expect(validateValue(1e20, { multipleOf: 7 }).valid).toBe(false);
    // 10^20 mod 4 is 0, since 100 divides it.
    expect(validateValue(1e20, { multipleOf: 4 }).valid).toBe(true);
    expect(validateValue(1e20 + 1, { multipleOf: 4 }).valid).toBe(true);
  });

  test("length is counted in code points", () => {
    // One astral character is two UTF-16 units but one character.
    expect(validateValue("\u{1F600}", { minLength: 1, maxLength: 1 }).valid).toBe(true);
  });

  test("pattern is an unanchored match", () => {
    expect(validateValue("banana", { pattern: "a" }).valid).toBe(true);
    expect(validateValue("banana", { pattern: "^a" }).errors[0]?.keyword).toBe("pattern");
  });

  test("a broken pattern in the schema is reported, not thrown", () => {
    const result = validateValue("x", { pattern: "(" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("not a valid regular expression");
  });

  test("format is an annotation until assertFormat is set", () => {
    const schema = { type: "string", format: "email" };
    expect(validateValue("nope", schema).valid).toBe(true);
    expect(validateValue("nope", schema, { assertFormat: true }).errors[0]?.keyword).toBe("format");
    expect(validateValue("a@b.com", schema, { assertFormat: true }).valid).toBe(true);
  });

  test("a format this package does not implement is listed rather than enforced", () => {
    const result = validateValue("x", { format: "idn-hostname" }, { assertFormat: true });
    expect(result.valid).toBe(true);
    expect(result.unsupportedKeywords).toContain("format:idn-hostname");
  });
});

describe("jsonschema: arrays", () => {
  test("items applies to every element", () => {
    const result = validateValue([1, "x", 3], { items: { type: "number" } });
    expect(result.errors[0]?.path).toBe("/1");
  });

  test("tuple items apply by position, with additionalItems for the rest", () => {
    const schema = { items: [{ type: "string" }, { type: "number" }], additionalItems: false };
    expect(validateValue(["a", 1], schema).valid).toBe(true);
    expect(validateValue([1, 1], schema).errors[0]?.path).toBe("/0");
    expect(validateValue(["a", 1, "extra"], schema).errors[0]?.path).toBe("/2");
  });

  test("minItems, maxItems and uniqueItems", () => {
    expect(validateValue([1], { minItems: 2 }).errors[0]?.keyword).toBe("minItems");
    expect(validateValue([1, 2, 3], { maxItems: 2 }).errors[0]?.keyword).toBe("maxItems");
    expect(validateValue([{ a: 1 }, { a: 1 }], { uniqueItems: true }).errors[0]?.keyword).toBe(
      "uniqueItems",
    );
    expect(validateValue([{ a: 1 }, { a: 2 }], { uniqueItems: true }).valid).toBe(true);
  });

  test("uniqueItems ignores key order, as JSON equality does", () => {
    const result = validateValue(
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      { uniqueItems: true },
    );
    expect(result.valid).toBe(false);
  });

  test("contains needs one matching element", () => {
    expect(validateValue([1, "x"], { contains: { type: "string" } }).valid).toBe(true);
    expect(validateValue([1, 2], { contains: { type: "string" } }).errors[0]?.keyword).toBe(
      "contains",
    );
  });
});

describe("jsonschema: objects", () => {
  const schema = {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  };

  test("required names the missing property", () => {
    const result = validateValue({ b: "x" }, schema);
    expect(result.errors[0]?.keyword).toBe("required");
    expect(result.errors[0]?.message).toContain('"a"');
  });

  test("additionalProperties false rejects an extra key at its own path", () => {
    const result = validateValue({ a: 1, z: 2 }, schema);
    expect(result.errors[0]?.path).toBe("/z");
    expect(result.errors[0]?.keyword).toBe("additionalProperties");
  });

  test("additionalProperties as a schema validates the extras", () => {
    const open = { properties: { a: {} }, additionalProperties: { type: "string" } };
    expect(validateValue({ a: 1, extra: "ok" }, open).valid).toBe(true);
    expect(validateValue({ a: 1, extra: 2 }, open).errors[0]?.path).toBe("/extra");
  });

  test("patternProperties covers keys by regex", () => {
    const patterned = {
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: false,
    };
    expect(validateValue({ "x-a": "ok" }, patterned).valid).toBe(true);
    expect(validateValue({ "x-a": 1 }, patterned).errors[0]?.path).toBe("/x-a");
    expect(validateValue({ other: "v" }, patterned).errors[0]?.keyword).toBe(
      "additionalProperties",
    );
  });

  test("propertyNames constrains the keys themselves", () => {
    const result = validateValue({ BadKey: 1 }, { propertyNames: { pattern: "^[a-z]+$" } });
    expect(result.errors[0]?.keyword).toBe("propertyNames");
  });

  test("minProperties and maxProperties", () => {
    expect(validateValue({}, { minProperties: 1 }).errors[0]?.keyword).toBe("minProperties");
    expect(validateValue({ a: 1, b: 2 }, { maxProperties: 1 }).errors[0]?.keyword).toBe(
      "maxProperties",
    );
  });

  test("a nested failure carries the full pointer", () => {
    const nested = {
      properties: { user: { properties: { tags: { items: { type: "string" } } } } },
    };
    expect(validateValue({ user: { tags: ["a", 2] } }, nested).errors[0]?.path).toBe(
      "/user/tags/1",
    );
  });
});

describe("jsonschema: logic and references", () => {
  test("anyOf passes on one branch and explains when none match", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] };
    expect(validateValue("x", schema).valid).toBe(true);
    const failed = validateValue(true, schema);
    expect(failed.errors[0]?.keyword).toBe("anyOf");
    expect(failed.errors[0]?.message).toContain("[0]");
  });

  test("oneOf rejects both zero and two matches", () => {
    const schema = { oneOf: [{ type: "number" }, { type: "integer" }] };
    const two = validateValue(3, schema);
    expect(two.errors[0]?.message).toContain("matched 2 alternatives");
    expect(validateValue("x", schema).errors[0]?.message).toContain("matched none");
    expect(validateValue(3.5, { oneOf: [{ type: "number" }, { type: "string" }] }).valid).toBe(
      true,
    );
  });

  test("allOf applies every branch", () => {
    const schema = { allOf: [{ type: "string" }, { minLength: 3 }] };
    expect(validateValue("abc", schema).valid).toBe(true);
    expect(validateValue("ab", schema).errors[0]?.keyword).toBe("minLength");
  });

  test("not inverts a branch", () => {
    expect(validateValue("x", { not: { type: "number" } }).valid).toBe(true);
    expect(validateValue(1, { not: { type: "number" } }).errors[0]?.keyword).toBe("not");
  });

  test("if/then/else picks a branch by the condition", () => {
    const schema = {
      if: { properties: { kind: { const: "a" } }, required: ["kind"] },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword, not a thenable.
      then: { required: ["aField"] },
      else: { required: ["bField"] },
    };
    expect(validateValue({ kind: "a", aField: 1 }, schema).valid).toBe(true);
    expect(validateValue({ kind: "a" }, schema).errors[0]?.message).toContain("aField");
    expect(validateValue({ kind: "z" }, schema).errors[0]?.message).toContain("bField");
  });

  test("$ref resolves into $defs and definitions alike", () => {
    const withDefs = {
      properties: { a: { $ref: "#/$defs/leaf" } },
      $defs: { leaf: { type: "string" } },
    };
    expect(validateValue({ a: "x" }, withDefs).valid).toBe(true);
    expect(validateValue({ a: 1 }, withDefs).errors[0]?.path).toBe("/a");
    const legacy = {
      properties: { a: { $ref: "#/definitions/leaf" } },
      definitions: { leaf: { type: "string" } },
    };
    expect(validateValue({ a: 1 }, legacy).valid).toBe(false);
  });

  test("a recursive $ref terminates on a finite value", () => {
    const tree = {
      $ref: "#/$defs/node",
      $defs: {
        node: {
          type: "object",
          properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } },
        },
      },
    };
    expect(validateValue({ children: [{ children: [] }] }, tree).valid).toBe(true);
  });

  test("an unresolvable or remote $ref is an error, not a silent pass", () => {
    expect(validateValue(1, { $ref: "#/$defs/missing" }).errors[0]?.keyword).toBe("$ref");
    const remote = validateValue(1, { $ref: "https://example.com/s.json" });
    expect(remote.errors[0]?.message).toContain("only local $ref");
  });

  test("a self-referencing $ref at the same position is caught as a cycle", () => {
    const result = validateValue(1, { $ref: "#" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/cycle/);
  });
});

describe("jsonschema: honesty about what it enforces", () => {
  test("an unenforced constraint keyword is named in the result", () => {
    const result = validateValue(
      { a: 1 },
      { type: "object", dependencies: { a: ["b"] }, unevaluatedProperties: false },
    );
    expect(result.valid).toBe(true);
    expect(result.unsupportedKeywords).toEqual(["dependencies", "unevaluatedProperties"]);
  });

  test("annotations are not reported as unsupported", () => {
    const result = validateValue(1, { title: "T", description: "d", default: 0, $comment: "c" });
    expect(result.unsupportedKeywords).toEqual([]);
  });

  test("the draft-04 boolean exclusive form is flagged", () => {
    const result = validateValue(5, { minimum: 5, exclusiveMinimum: true });
    expect(result.unsupportedKeywords).toContain("exclusiveMinimum (boolean form)");
  });

  test("maxErrors caps the list and says so", () => {
    const schema = { properties: { a: { type: "string" }, b: { type: "string" } } };
    const result = validateValue({ a: 1, b: 2 }, schema, { maxErrors: 1 });
    expect(result.errors.length).toBe(1);
    expect(result.truncated).toBe(true);
  });
});

describe("jsonschema: Draft-07 known answers", () => {
  /**
   * One verdict per row, each read off the specification rather than off this
   * implementation. They are grouped here because a validator is only worth
   * the cases it gets right at the edges, and because a table makes it cheap
   * to add the next one.
   */
  const vectors: Array<[string, unknown, Schema, boolean]> = [
    // A whole-valued float IS an integer in Draft-07 — 1.0 and 1 are the
    // same JSON number.
    ["1.0 satisfies integer", 1.0, { type: "integer" }, true],
    ["1.5 does not", 1.5, { type: "integer" }, false],
    ["an integer satisfies number", 1, { type: "number" }, true],
    // enum compares by JSON value, so no cross-type coercion.
    ["enum [0] rejects false", false, { enum: [0] }, false],
    ["enum [false] rejects 0", 0, { enum: [false] }, false],
    ["const null matches null", null, { const: null }, true],
    ["const null rejects 0", 0, { const: null }, false],
    // uniqueItems is JSON equality: 1 and 1.0 are one number, 0 and false
    // are two values.
    ["uniqueItems sees 1 and 1.0 as equal", [1, 1.0], { uniqueItems: true }, false],
    ["uniqueItems sees 0 and false as different", [0, false], { uniqueItems: true }, true],
    [
      "uniqueItems ignores key order",
      [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
      { uniqueItems: true },
      false,
    ],
    // contains needs a matching item, and an empty array has none to offer.
    ["contains fails on an empty array", [], { contains: {} }, false],
    ["contains passes on one match", [1, "x"], { contains: { type: "string" } }, true],
    // additionalItems applies only to the tuple form.
    [
      "additionalItems false rejects the extra item",
      [1, 2],
      { items: [{ type: "integer" }], additionalItems: false },
      false,
    ],
    [
      "additionalItems false allows an exact-length tuple",
      [1],
      { items: [{ type: "integer" }], additionalItems: false },
      true,
    ],
    [
      "additionalItems is ignored when items is a single schema",
      [1, 2],
      { items: { type: "integer" }, additionalItems: false },
      true,
    ],
    // if with no then/else constrains nothing.
    ["a bare if constrains nothing", 1, { if: { type: "string" } }, true],
    ["else runs when if fails", 1, { if: { type: "string" }, else: { type: "integer" } }, true],
    ["and can reject", 1.5, { if: { type: "string" }, else: { type: "integer" } }, false],
    // $ref replaces its siblings entirely in Draft-07; the sibling `type`
    // here would reject the value if it were applied.
    [
      "$ref replaces its sibling keywords",
      "x",
      { $ref: "#/$defs/s", type: "integer", $defs: { s: { type: "string" } } },
      true,
    ],
    ["an unresolvable $ref is an error", 1, { $ref: "http://example.com/s" }, false],
    // pattern is an unanchored ECMA-262 match.
    ["pattern matches anywhere", "banana", { pattern: "a" }, true],
    ["an anchored pattern does not", "banana", { pattern: "^a$" }, false],
    // Lengths are code points, so two astral characters are two.
    ["length counts code points", "\u{1F600}\u{1F600}", { minLength: 2, maxLength: 2 }, true],
    ["propertyNames constrains the key", { ab: 1 }, { propertyNames: { maxLength: 1 } }, false],
    ["exclusiveMinimum excludes its own value", 1, { exclusiveMinimum: 1 }, false],
    ["oneOf wants exactly one", 1, { oneOf: [{ type: "integer" }, { type: "string" }] }, true],
    ["two matches is not one", 1, { oneOf: [{ type: "integer" }, { type: "number" }] }, false],
    ["not inverts", 1, { not: { type: "string" } }, true],
    ["a false schema rejects everything", 1, false, false],
    ["a true schema accepts everything", 1, true, true],
    // patternProperties counts as coverage, so additionalProperties never
    // sees a key a pattern already claimed.
    [
      "patternProperties covers a key for additionalProperties",
      { ab: 1 },
      { patternProperties: { "^a": { type: "integer" } }, additionalProperties: false },
      true,
    ],
    [
      "an uncovered key is still rejected",
      { bb: 1 },
      { patternProperties: { "^a": {} }, additionalProperties: false },
      false,
    ],
  ];

  for (const [name, value, schema, expected] of vectors) {
    test(name, () => {
      expect({ name, valid: validateValue(value, schema).valid }).toEqual({
        name,
        valid: expected,
      });
    });
  }

  test("additionalItems reports its own keyword, not the false schema's", () => {
    const result = validateValue([1, 2], { items: [{}], additionalItems: false });
    expect(result.errors[0]?.keyword).toBe("additionalItems");
    expect(result.errors[0]?.path).toBe("/1");
  });
});

describe("jsonschema: checkSchemaShape", () => {
  test("a well-formed schema has no problems", () => {
    expect(checkSchemaShape({ type: "object", properties: { a: { type: "string" } } })).toEqual([]);
    expect(checkSchemaShape(true)).toEqual([]);
  });

  test("a misspelled type is caught at its pointer", () => {
    const problems = checkSchemaShape({ properties: { a: { type: "sting" } } });
    expect(problems[0]).toContain("/properties/a/type");
  });

  test("enum and required must be arrays, and pattern must compile", () => {
    expect(checkSchemaShape({ enum: "a" }).length).toBe(1);
    expect(checkSchemaShape({ required: "a" }).length).toBe(1);
    expect(checkSchemaShape({ pattern: "(" }).length).toBe(1);
  });

  test("branches are checked too", () => {
    expect(checkSchemaShape({ anyOf: [{ type: "nope" }] }).length).toBe(1);
    expect(checkSchemaShape({ items: [{ type: "nope" }] }).length).toBe(1);
  });

  test("a definition is checked, because a $ref reaches it and nothing else would", () => {
    // A typo here is invisible from the root and rejects every value that
    // resolves the $ref — precisely the failure this check exists to catch.
    const problems = checkSchemaShape({
      $ref: "#/$defs/user",
      $defs: { user: { type: "sting" } },
    });
    expect(problems).toEqual(['/$defs/user/type: "sting" is not a JSON Schema type']);
    expect(checkSchemaShape({ definitions: { u: { enum: "a" } } })[0]).toContain(
      "/definitions/u/enum",
    );
  });

  test("every other subschema position is descended into as well", () => {
    for (const schema of [
      { not: { type: "nope" } },
      { contains: { type: "nope" } },
      { propertyNames: { type: "nope" } },
      { additionalProperties: { type: "nope" } },
      { additionalItems: { type: "nope" } },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the JSON Schema keyword, not a thenable.
      { if: { type: "nope" }, then: true },
      // biome-ignore lint/suspicious/noThenProperty: same — this is schema data.
      { then: { type: "nope" } },
      { else: { type: "nope" } },
      { patternProperties: { "^a": { type: "nope" } } },
    ]) {
      expect({ schema, problems: checkSchemaShape(schema).length }).toEqual({
        schema,
        problems: 1,
      });
    }
  });

  test("a patternProperties key that is not a regex is a schema problem", () => {
    expect(checkSchemaShape({ patternProperties: { "(": true } }).length).toBe(1);
  });

  test("required must hold property names, not just be an array", () => {
    expect(checkSchemaShape({ required: ["id"] })).toEqual([]);
    expect(checkSchemaShape({ required: [1] })[0]).toContain("/required/0");
  });

  test("boolean subschemas are legal everywhere and raise nothing", () => {
    expect(
      checkSchemaShape({
        properties: { a: true, b: false },
        additionalProperties: false,
        items: true,
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("compare: differences", () => {
  test("equal values produce nothing", () => {
    expect(compareValues({ a: [1, 2] }, { a: [1, 2] }).equal).toBe(true);
    expect(firstDifference({ a: 1 }, { a: 1 })).toBeNull();
  });

  test("a changed leaf is reported at its pointer", () => {
    const diff = firstDifference({ a: { b: 1 } }, { a: { b: 2 } });
    expect(diff?.path).toBe("/a/b");
    expect(diff?.kind).toBe("value");
  });

  test("missing and unexpected properties are distinguished", () => {
    const result = compareValues({ b: 1 }, { a: 1 });
    const kinds = result.differences.map((d) => d.kind).sort();
    expect(kinds).toEqual(["missing", "unexpected"]);
  });

  test("a type change is reported as such", () => {
    expect(firstDifference("1", 1)?.kind).toBe("type");
  });

  test("integer and number are the same type for comparison", () => {
    expect(compareValues(1, 1.0).equal).toBe(true);
  });

  test("array length is reported once, not per index", () => {
    const result = compareValues([1], [1, 2]);
    expect(result.differences[0]?.kind).toBe("length");
  });

  test("keys are walked in sorted order, so the first difference is stable", () => {
    const diff = firstDifference({ z: 1, a: 1 }, { z: 2, a: 2 });
    expect(diff?.path).toBe("/a");
  });
});

describe("compare: the three tolerances", () => {
  test("epsilon absorbs a float wobble", () => {
    expect(compareValues({ n: 1.0001 }, { n: 1 }, { epsilon: 0.001 }).equal).toBe(true);
    expect(compareValues({ n: 1.01 }, { n: 1 }, { epsilon: 0.001 }).equal).toBe(false);
  });

  test("ignorePaths skips a moving field and reports what it skipped", () => {
    const result = compareValues({ id: "x", n: 1 }, { id: "y", n: 1 }, { ignorePaths: ["/id"] });
    expect(result.equal).toBe(true);
    expect(result.ignored).toEqual(["/id"]);
  });

  test("a star segment matches any one segment", () => {
    const actual = {
      items: [
        { id: 1, v: "a" },
        { id: 2, v: "b" },
      ],
    };
    const expectedValue = {
      items: [
        { id: 9, v: "a" },
        { id: 8, v: "b" },
      ],
    };
    expect(compareValues(actual, expectedValue, { ignorePaths: ["/items/*/id"] }).equal).toBe(true);
  });

  test("a trailing double star matches everything below", () => {
    expect(
      compareValues({ meta: { a: 1, b: { c: 2 } } }, { meta: {} }, { ignorePaths: ["/meta/**"] })
        .equal,
    ).toBe(true);
  });

  test("an ignored path that is missing on one side is still ignored", () => {
    expect(compareValues({}, { id: 1 }, { ignorePaths: ["/id"] }).equal).toBe(true);
  });

  test("ignoreArrayOrder matches items as a multiset", () => {
    expect(compareValues([3, 1, 2], [1, 2, 3], { ignoreArrayOrder: true }).equal).toBe(true);
    expect(compareValues([3, 1, 2], [1, 2, 3]).equal).toBe(false);
  });

  test("ignoreArrayOrder reports leftovers on both sides", () => {
    const result = compareValues([1, 4], [1, 2], { ignoreArrayOrder: true });
    const kinds = result.differences.map((d) => d.kind).sort();
    expect(kinds).toEqual(["missing", "unexpected"]);
  });

  test("an array too long to match unordered falls back and says so", () => {
    const actual = Array.from({ length: 201 }, (_, i) => i);
    const result = compareValues(actual, actual, { ignoreArrayOrder: true });
    expect(result.orderedFallbacks).toEqual([""]);
  });

  test("subset mode allows extra properties but not wrong ones", () => {
    expect(compareValues({ a: 1, b: 2 }, { a: 1 }, { subset: true }).equal).toBe(true);
    expect(compareValues({ a: 2 }, { a: 1 }, { subset: true }).equal).toBe(false);
    expect(compareValues({ b: 2 }, { a: 1 }, { subset: true }).differences[0]?.kind).toBe(
      "missing",
    );
  });

  test("maxDifferences truncates", () => {
    const result = compareValues({ a: 1, b: 1, c: 1 }, { a: 2, b: 2, c: 2 }, { maxDifferences: 2 });
    expect(result.differences.length).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe("compare: helpers", () => {
  test("matchesAnyPattern honours exact, star and double-star patterns", () => {
    expect(matchesAnyPattern("/a/b", [["a", "b"]])).toBe(true);
    expect(matchesAnyPattern("/a/b", [["a", "*"]])).toBe(true);
    expect(matchesAnyPattern("/a/b/c", [["a", "*"]])).toBe(false);
    expect(matchesAnyPattern("/a/b/c", [["a", "**"]])).toBe(true);
  });

  test("groupByCanonical buckets by value, not identity", () => {
    const groups = groupByCanonical([{ a: 1 }, { a: 1 }, { a: 2 }], (item) => item);
    expect([...groups.values()].map((v) => v.length).sort()).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------

describe("assert: the operators", () => {
  const value = {
    status: "done",
    count: 5,
    items: [1, 2, 3],
    user: { email: "a@b.com", nickname: "" },
    flag: null,
  };

  test("equals and notEquals compare structurally", () => {
    const report = runChecks(value, [
      { path: "items", op: "equals", expected: [1, 2, 3] },
      { path: "count", op: "notEquals", expected: 6 },
    ]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(2);
  });

  test("contains works on strings, arrays and objects", () => {
    const report = runChecks(value, [
      { path: "status", op: "contains", expected: "on" },
      { path: "items", op: "contains", expected: 2 },
      { path: "user", op: "contains", expected: "email" },
      { path: "count", op: "contains", expected: 5 },
    ]);
    expect(report.results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(report.failures[0]?.reason).toContain("needs a string, array or object");
  });

  test("matches compiles the regex with flags and reports a bad one", () => {
    const report = runChecks(value, [
      { path: "status", op: "matches", expected: "^DONE$", flags: "i" },
      { path: "status", op: "matches", expected: "(" },
    ]);
    expect(report.results[0]?.ok).toBe(true);
    expect(report.results[1]?.reason).toContain("invalid regex");
  });

  test("numeric comparisons require numbers on both sides", () => {
    const report = runChecks(value, [
      { path: "count", op: "greaterThan", expected: 1 },
      { path: "count", op: "lessThanOrEqual", expected: 5 },
      { path: "status", op: "greaterThan", expected: 1 },
    ]);
    expect(report.results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(report.failures[0]?.reason).toContain("expected a number");
  });

  test("exists and notExists are the only ops an absent path can pass", () => {
    const report = runChecks(value, [
      { path: "nope", op: "notExists" },
      { path: "nope", op: "exists" },
      { path: "nope", op: "equals", expected: 1 },
    ]);
    expect(report.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(report.results[2]?.reason).toContain("does not resolve");
  });

  test("isEmpty treats null, empty string, array and object as empty", () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue("")).toBe(true);
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue({})).toBe(true);
    expect(isEmptyValue(0)).toBe(false);
    const report = runChecks(value, [
      { path: "user.nickname", op: "isEmpty" },
      { path: "items", op: "isNotEmpty" },
      { path: "flag", op: "isEmpty" },
    ]);
    expect(report.ok).toBe(true);
  });

  test("isType accepts a name or a list, with integer widening", () => {
    const report = runChecks(value, [
      { path: "count", op: "isType", expected: "number" },
      { path: "flag", op: "isType", expected: ["string", "null"] },
      { path: "status", op: "isType", expected: "number" },
    ]);
    expect(report.results.map((r) => r.ok)).toEqual([true, true, false]);
  });

  test("length ops work on strings, arrays and objects", () => {
    const report = runChecks(value, [
      { path: "items", op: "hasLength", expected: 3 },
      { path: "status", op: "minLength", expected: 4 },
      { path: "user", op: "maxLength", expected: 2 },
      { path: "count", op: "hasLength", expected: 1 },
    ]);
    expect(report.results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(report.failures[0]?.reason).toContain("has no length");
  });

  test("oneOf, notOneOf, startsWith, endsWith and hasFormat", () => {
    const report = runChecks(value, [
      { path: "status", op: "oneOf", expected: ["done", "failed"] },
      { path: "status", op: "notOneOf", expected: ["pending"] },
      { path: "status", op: "startsWith", expected: "do" },
      { path: "status", op: "endsWith", expected: "ne" },
      { path: "user.email", op: "hasFormat", expected: "email" },
      { path: "status", op: "hasFormat", expected: "email" },
    ]);
    expect(report.failed).toBe(1);
    expect(report.failures[0]?.reason).toContain("not a valid email");
  });

  test("every declared op is reachable, so none is dead", () => {
    const covered = new Set(ASSERT_OPS);
    expect(covered.size).toBe(ASSERT_OPS.length);
    for (const op of ASSERT_OPS) {
      const report = runChecks({ a: "x" }, [{ path: "a", op, expected: "x" }]);
      expect(report.results[0]?.op).toBe(op);
    }
  });

  test("an omitted path checks the value itself", () => {
    expect(runChecks("hello", [{ op: "startsWith", expected: "he" }]).ok).toBe(true);
  });

  test("a custom message replaces the generated reason", () => {
    const report = runChecks({ a: 1 }, [
      { path: "a", op: "equals", expected: 2, message: "the id did not survive the round trip" },
    ]);
    expect(report.failures[0]?.reason).toBe("the id did not survive the round trip");
  });

  test("a malformed path fails that check without throwing", () => {
    const report = runChecks({ a: 1 }, [{ path: "[[", op: "exists" }]);
    expect(report.failures[0]?.reason).toContain("bad path");
  });
});

describe("assert: checkRequired", () => {
  test("present and non-empty is the default bar", () => {
    const result = checkRequired(
      { a: 1, b: "", c: null, d: { e: 2 } },
      ["a", "b", "c", "d.e"],
      false,
    );
    expect(result.present).toEqual(["a", "d.e"]);
    expect(result.missing.map((m) => m.path)).toEqual(["b", "c"]);
    expect(result.ok).toBe(false);
  });

  test("allowEmpty accepts a present but empty value", () => {
    expect(checkRequired({ a: "" }, ["a"], true).ok).toBe(true);
  });

  test("an absent path says where it stopped resolving", () => {
    const result = checkRequired({ a: {} }, ["a.b.c"], false);
    expect(result.missing[0]?.reason).toContain("a.b");
  });
});

// ---------------------------------------------------------------------------

describe("infer", () => {
  test("a single object gives types and required", () => {
    const schema = inferSchema([{ id: 1, name: "x" }]);
    expect(schema["type"]).toBe("object");
    expect(schema["required"]).toEqual(["id", "name"]);
  });

  test("a property missing from one sample stops being required", () => {
    const schema = inferSchema([{ a: 1, b: 2 }, { a: 1 }]);
    expect(schema["required"]).toEqual(["a"]);
  });

  test("integer widens to number when a fraction appears", () => {
    const schema = inferSchema([{ a: 1 }, { a: 1.5 }]);
    expect((schema["properties"] as Record<string, { type: string }>)["a"]?.type).toBe("number");
  });

  test("a sometimes-null field gets a type array", () => {
    const schema = inferSchema([{ a: "x" }, { a: null }]);
    expect((schema["properties"] as Record<string, { type: string[] }>)["a"]?.type).toEqual([
      "null",
      "string",
    ]);
  });

  test("array items are merged across samples", () => {
    const schema = inferSchema([{ xs: [1, 2] }, { xs: [3] }]);
    const items = (schema["properties"] as Record<string, { items: { type: string } }>)["xs"]
      ?.items;
    expect(items?.type).toBe("integer");
  });

  test("an always-empty array gets no items claim", () => {
    const schema = inferSchema([{ xs: [] }]);
    const xs = (schema["properties"] as Record<string, Record<string, unknown>>)["xs"];
    expect(xs?.["type"]).toBe("array");
    expect(xs?.["items"]).toBeUndefined();
  });

  test("formats are detected only when every sample agrees", () => {
    const withFormat = inferSchema([{ e: "a@b.com" }, { e: "c@d.org" }]);
    expect(
      (withFormat["properties"] as Record<string, Record<string, unknown>>)["e"]?.["format"],
    ).toBe("email");
    const mixed = inferSchema([{ e: "a@b.com" }, { e: "not an email" }]);
    expect(
      (mixed["properties"] as Record<string, Record<string, unknown>>)["e"]?.["format"],
    ).toBeUndefined();
  });

  test("enums are opt-in", () => {
    const off = inferSchema([{ s: "a" }, { s: "b" }]);
    expect(
      (off["properties"] as Record<string, Record<string, unknown>>)["s"]?.["enum"],
    ).toBeUndefined();
    const on = inferSchema([{ s: "a" }, { s: "b" }], { detectEnums: true });
    expect((on["properties"] as Record<string, Record<string, unknown>>)["s"]?.["enum"]).toEqual([
      "a",
      "b",
    ]);
  });

  test("closed emits additionalProperties false", () => {
    expect(inferSchema([{ a: 1 }], { closed: true })["additionalProperties"]).toBe(false);
  });

  test("the result is stable across runs and property order follows first sight", () => {
    const samples = [
      { b: 1, a: 2 },
      { a: 3, b: 4 },
    ];
    expect(JSON.stringify(inferSchema(samples))).toBe(JSON.stringify(inferSchema(samples)));
    expect(Object.keys(inferSchema(samples)["properties"] as object)).toEqual(["b", "a"]);
  });

  test("an inferred schema validates the samples it came from", () => {
    const samples = [
      { id: 1, tags: ["a"], meta: { ok: true } },
      { id: 2, tags: [], meta: { ok: false } },
    ];
    const schema = inferSchema(samples);
    for (const sample of samples) expect(validateValue(sample, schema).valid).toBe(true);
  });

  test("no samples is a caller error", () => {
    expect(() => inferSchema([])).toThrow(/at least one/);
  });

  test("commonFormat and distinctCount", () => {
    expect(commonFormat(["a@b.com", "c@d.com"])).toBe("email");
    expect(commonFormat(["a@b.com", "xyz"])).toBeNull();
    expect(commonFormat([])).toBeNull();
    expect(distinctCount([{ a: 1 }, { a: 1 }, { a: 2 }])).toBe(2);
  });

  test("commonFormat picks the narrow format over the hostname it also matches", () => {
    expect(commonFormat(["2024-01-02", "2025-03-04"])).toBe("date");
    expect(commonFormat(["550e8400-e29b-41d4-a716-446655440000"])).toBe("uuid");
    expect(commonFormat(["192.0.2.1", "10.0.0.1"])).toBe("ipv4");
    expect(commonFormat(["api.example.com"])).toBe("hostname");
  });

  test("a format loose enough to fit anything is not inferred", () => {
    // "active" is a syntactically valid single-label hostname, and "/tmp/x"
    // is a valid JSON Pointer. Labelling either would be a claim about every
    // future value of the field that the samples do not support.
    expect(commonFormat(["active", "pending"])).toBeNull();
    expect(commonFormat(["/tmp/x", "/tmp/y"])).toBeNull();
    expect(commonFormat([""])).toBeNull();
    const inferred = inferSchema([{ status: "active" }, { status: "pending" }]);
    const status = (inferred["properties"] as Record<string, Record<string, unknown>>)["status"];
    expect(status).toEqual({ type: "string" });
  });

  test("a field with more distinct values than it tracks gets no format", () => {
    // Past MAX_TRACKED_STRINGS the node stops remembering, so agreement
    // among what it kept says nothing about what it dropped. The 201st value
    // here is not an email; the first 200 are.
    const samples = Array.from({ length: 200 }, (_, i) => ({ e: `user${i}@example.com` }));
    const tracked = inferSchema(samples);
    expect(
      (tracked["properties"] as Record<string, Record<string, unknown>>)["e"]?.["format"],
    ).toBe("email");
    const overflowed = inferSchema([...samples, { e: "not an email at all" }]);
    expect(
      (overflowed["properties"] as Record<string, Record<string, unknown>>)["e"]?.["format"],
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("records: validateRecords", () => {
  const schema = { type: "object", properties: { id: { type: "integer" } }, required: ["id"] };

  test("a clean batch passes with counts", () => {
    const report = validateRecords([{ id: 1 }, { id: 2 }], schema);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(2);
    expect(report.failures).toEqual([]);
  });

  test("failures carry the row index and the errors", () => {
    const report = validateRecords([{ id: 1 }, { id: "x" }], schema);
    expect(report.failed).toBe(1);
    expect(report.failures[0]?.row).toBe(1);
    expect(report.failures[0]?.errors[0]?.keyword).toBe("type");
  });

  test("topIssues ties break by code unit, not by the machine's locale", () => {
    // Two issues on one row each, so the tie-break decides the order. Under
    // the default `localeCompare` collation "B" sorts after "a"; by code
    // unit it sorts before, and only one of those is the same everywhere.
    const report = validateRecords([{ B: "x", a: 1 }], {
      type: "object",
      properties: { B: { type: "integer" }, a: { type: "string" } },
    });
    expect(report.topIssues.map((i) => i.path)).toEqual(["/B", "/a"]);
  });

  test("topIssues groups by what went wrong, worst first", () => {
    const report = validateRecords([{}, {}, { id: "x" }], schema);
    expect(report.topIssues[0]?.keyword).toBe("required");
    expect(report.topIssues[0]?.rows).toBe(2);
  });

  test("idField names the offending row for a person", () => {
    const report = validateRecords([{ id: "x", sku: "ABC" }], schema, { idField: "sku" });
    expect(report.failures[0]?.id).toBe('"ABC"');
  });

  test("maxFailedRows truncates the detail but not the count", () => {
    const rows = Array.from({ length: 10 }, () => ({}));
    const report = validateRecords(rows, schema, { maxFailedRows: 2 });
    expect(report.failed).toBe(10);
    expect(report.failures.length).toBe(2);
    expect(report.truncated).toBe(true);
  });

  test("an empty batch is vacuously ok", () => {
    expect(validateRecords([], schema).ok).toBe(true);
  });
});

describe("records: findDuplicates", () => {
  test("a unique key passes", () => {
    expect(findDuplicates([{ id: 1 }, { id: 2 }], ["id"]).ok).toBe(true);
  });

  test("duplicates are grouped with their row indices", () => {
    const report = findDuplicates([{ id: 1 }, { id: 2 }, { id: 1 }], ["id"]);
    expect(report.ok).toBe(false);
    expect(report.duplicates[0]?.rows).toEqual([0, 2]);
    expect(report.distinctKeys).toBe(2);
  });

  test("a composite key needs every field to match", () => {
    const rows = [
      { a: 1, b: 1 },
      { a: 1, b: 2 },
      { a: 1, b: 1 },
    ];
    expect(findDuplicates(rows, ["a", "b"]).duplicates[0]?.rows).toEqual([0, 2]);
    expect(findDuplicates(rows, ["a"]).duplicates[0]?.rows).toEqual([0, 1, 2]);
  });

  test("caseInsensitive folds string values only", () => {
    const rows = [{ e: "A@b.com" }, { e: "a@B.com" }];
    expect(findDuplicates(rows, ["e"]).ok).toBe(true);
    expect(findDuplicates(rows, ["e"], { caseInsensitive: true }).ok).toBe(false);
  });

  test("a row that cannot be keyed is reported rather than silently skipped", () => {
    const report = findDuplicates([{ id: 1 }, 42, { other: 1 }], ["id"]);
    expect(report.unkeyed.map((u) => u.row)).toEqual([1, 2]);
    expect(report.ok).toBe(false);
  });
});

describe("records: checkReferences", () => {
  const rows = [{ cid: 1 }, { cid: 2 }, { cid: 9 }];

  test("a dangling reference is reported with its row", () => {
    const report = checkReferences(rows, "cid", [1, 2]);
    expect(report.ok).toBe(false);
    expect(report.dangling[0]?.row).toBe(2);
  });

  test("every reference resolving is a pass", () => {
    expect(checkReferences(rows, "cid", [1, 2, 9]).ok).toBe(true);
  });

  test("a missing reference is a failure unless allowed", () => {
    const withGap = [{ cid: 1 }, {}];
    expect(checkReferences(withGap, "cid", [1]).ok).toBe(false);
    expect(checkReferences(withGap, "cid", [1], { allowMissing: true }).ok).toBe(true);
  });

  test("unreferenced allowed values are reported in their original form", () => {
    const report = checkReferences([{ cid: "a" }], "cid", ["a", "b"], { reportUnreferenced: true });
    expect(report.unreferenced).toEqual(['"b"']);
  });

  test("collectFieldValues builds the allowed set from a parent table", () => {
    const parents = [{ id: 1 }, { id: 2 }, { id: 1 }, { other: 3 }];
    expect(collectFieldValues(parents, "id")).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------

describe("schemadiff", () => {
  test("identical schemas produce no changes", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const result = diffSchemas(schema, { ...schema });
    expect(result.identical).toBe(true);
    expect(result.verdict).toBe("compatible");
  });

  test("identical means the same document, not just no change worth reporting", () => {
    // A description is an annotation, so nothing about validation changed and
    // the verdict is compatible. The documents are still not identical, and
    // claiming they are would be a different statement.
    const result = diffSchemas({ type: "string", title: "A" }, { type: "string", title: "B" });
    expect(result.identical).toBe(false);
    expect(result.verdict).toBe("compatible");
    expect(result.changes).toEqual([]);
  });

  test("a keyword this diff does not model is unknown, never silence", () => {
    // Each of these narrows what validates, and none is analysed here. The
    // failure mode being guarded against is the verdict reading "compatible"
    // because the change was invisible rather than because it was safe.
    for (const [before, after] of [
      [{ patternProperties: { "^a": { type: "string" } } }, { patternProperties: { "^a": {} } }],
      [{ contains: { const: 1 } }, { contains: { const: 2 } }],
      [{ propertyNames: { maxLength: 9 } }, { propertyNames: { maxLength: 3 } }],
      [{ dependencies: {} }, { dependencies: { a: ["b"] } }],
      [{}, { unevaluatedProperties: false }],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      const result = diffSchemas(before, after);
      expect({ before, verdict: result.verdict }).toEqual({ before, verdict: "unknown" });
      expect(result.backwardCompatible).toBe(false);
    }
  });

  test("an annotation change is not mistaken for an unmodelled constraint", () => {
    const result = diffSchemas(
      { type: "string", description: "before", $comment: "x" },
      { type: "string", description: "after" },
    );
    expect(result.changes).toEqual([]);
    expect(result.verdict).toBe("compatible");
  });

  test("an unmodelled change nested in a property is reported at its pointer", () => {
    const result = diffSchemas(
      { properties: { a: { contains: { const: 1 } } } },
      { properties: { a: { contains: { const: 2 } } } },
    );
    expect(result.changes[0]?.path).toBe("/properties/a/contains");
    expect(result.changes[0]?.compat).toBe("unknown");
  });

  test("an added optional property is compatible; a required one is not", () => {
    const before = { type: "object", properties: { a: { type: "string" } } };
    const optional = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
    };
    expect(diffSchemas(before, optional).backwardCompatible).toBe(true);
    const required = { ...optional, required: ["b"] };
    expect(diffSchemas(before, required).verdict).toBe("breaking");
  });

  test("dropping a requirement is compatible", () => {
    const before = { type: "object", properties: { a: {} }, required: ["a"] };
    const after = { type: "object", properties: { a: {} } };
    expect(diffSchemas(before, after).backwardCompatible).toBe(true);
  });

  test("a widened type is compatible and a narrowed one is breaking", () => {
    expect(diffSchemas({ type: "string" }, { type: ["string", "null"] }).verdict).toBe(
      "compatible",
    );
    expect(diffSchemas({ type: ["string", "null"] }, { type: "string" }).verdict).toBe("breaking");
    expect(diffSchemas({ type: "integer" }, { type: "number" }).verdict).toBe("compatible");
    expect(diffSchemas({ type: "number" }, { type: "integer" }).verdict).toBe("breaking");
  });

  test("enum values may be added but not removed", () => {
    expect(diffSchemas({ enum: ["a"] }, { enum: ["a", "b"] }).verdict).toBe("compatible");
    expect(diffSchemas({ enum: ["a", "b"] }, { enum: ["a"] }).verdict).toBe("breaking");
    expect(diffSchemas({}, { enum: ["a"] }).verdict).toBe("breaking");
  });

  test("bounds may only loosen", () => {
    expect(diffSchemas({ minimum: 1 }, { minimum: 0 }).verdict).toBe("compatible");
    expect(diffSchemas({ minimum: 1 }, { minimum: 2 }).verdict).toBe("breaking");
    expect(diffSchemas({ maxLength: 10 }, { maxLength: 5 }).verdict).toBe("breaking");
    expect(diffSchemas({ maxLength: 10 }, {}).verdict).toBe("compatible");
    expect(diffSchemas({}, { maxItems: 3 }).verdict).toBe("breaking");
  });

  test("closing additionalProperties is breaking, opening it is not", () => {
    expect(diffSchemas({}, { additionalProperties: false }).verdict).toBe("breaking");
    expect(diffSchemas({ additionalProperties: false }, {}).verdict).toBe("compatible");
  });

  test("removing a described property depends on additionalProperties", () => {
    const before = { properties: { a: {}, b: {} } };
    expect(diffSchemas(before, { properties: { a: {} } }).verdict).toBe("compatible");
    expect(
      diffSchemas(
        { ...before, additionalProperties: false },
        { properties: { a: {} }, additionalProperties: false },
      ).verdict,
    ).toBe("breaking");
  });

  test("a changed pattern is undecidable and is reported as such", () => {
    const result = diffSchemas({ pattern: "^a" }, { pattern: "^a|^b" });
    expect(result.verdict).toBe("unknown");
    expect(result.backwardCompatible).toBe(false);
    expect(result.changes[0]?.detail).toContain("not analyzed");
  });

  test("a changed composition is undecidable", () => {
    expect(
      diffSchemas({ anyOf: [{ type: "string" }] }, { anyOf: [{ type: "number" }] }).verdict,
    ).toBe("unknown");
  });

  test("nested property changes carry their pointer", () => {
    const result = diffSchemas(
      { properties: { user: { properties: { age: { type: "integer" } } } } },
      { properties: { user: { properties: { age: { type: "string" } } } } },
    );
    expect(result.changes[0]?.path).toBe("/properties/user/properties/age");
  });

  test("boolean schemas at either end", () => {
    expect(diffSchemas(true, false).verdict).toBe("breaking");
    expect(diffSchemas(false, true).verdict).toBe("compatible");
    expect(diffSchemas({ type: "string" }, true).verdict).toBe("compatible");
  });

  test("uniqueItems turning on is breaking", () => {
    expect(diffSchemas({ type: "array" }, { type: "array", uniqueItems: true }).verdict).toBe(
      "breaking",
    );
  });

  test("items are diffed through", () => {
    const result = diffSchemas(
      { type: "array", items: { type: "string" } },
      { type: "array", items: { type: "number" } },
    );
    expect(result.changes[0]?.path).toBe("/items");
    expect(result.verdict).toBe("breaking");
  });
});

// ---------------------------------------------------------------------------

describe("summarize", () => {
  const schema = {
    title: "Order",
    type: "object",
    properties: {
      id: { type: "string", description: "the order id" },
      total: { type: "number", minimum: 0 },
      lines: { type: "array", items: { type: "object", properties: { sku: { type: "string" } } } },
      customer: { $ref: "#/$defs/customer" },
    },
    required: ["id", "total"],
    $defs: { customer: { type: "object", properties: { email: { type: "string" } } } },
  };

  test("every field gets one row, with an array level marked", () => {
    const result = summarizeSchema(schema);
    const paths = result.rows.map((r) => r.path);
    expect(paths).toContain("total");
    expect(paths).toContain("lines[]");
    expect(paths).toContain("lines[].sku");
  });

  test("required is carried from the parent's required list", () => {
    const rows = summarizeSchema(schema).rows;
    expect(rows.find((r) => r.path === "id")?.required).toBe(true);
    expect(rows.find((r) => r.path === "lines")?.required).toBe(false);
  });

  test("constraints and descriptions are rendered", () => {
    const rows = summarizeSchema(schema).rows;
    expect(rows.find((r) => r.path === "total")?.constraints).toContain(">= 0");
    expect(rows.find((r) => r.path === "id")?.description).toBe("the order id");
  });

  test("a local $ref is followed", () => {
    expect(summarizeSchema(schema).rows.map((r) => r.path)).toContain("customer.email");
  });

  test("a recursive $ref is reported once, not expanded", () => {
    const recursive = {
      type: "object",
      properties: { child: { $ref: "#/$defs/node" } },
      $defs: { node: { type: "object", properties: { child: { $ref: "#/$defs/node" } } } },
    };
    const rows = summarizeSchema(recursive).rows;
    expect(rows.some((r) => r.type.includes("recursive"))).toBe(true);
  });

  test("an unresolvable $ref says so instead of vanishing", () => {
    const rows = summarizeSchema({ properties: { a: { $ref: "#/$defs/gone" } } }).rows;
    expect(rows[0]?.constraints).toBe("unresolved $ref");
  });

  test("the title and root type come back separately from the rows", () => {
    const result = summarizeSchema(schema);
    expect(result.title).toBe("Order");
    expect(result.rootType).toBe("object");
  });

  test("maxRows truncates and flags it", () => {
    const result = summarizeSchema(schema, { maxRows: 2 });
    expect(result.rows.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  test("the table is aligned and escapes pipes", () => {
    const table = renderFieldTable([
      { path: "a|b", type: "string", required: true, constraints: "", description: "" },
    ]);
    expect(table.split("\n").length).toBe(3);
    expect(table).toContain("a\\|b");
  });

  test("listDefinitions finds both containers", () => {
    expect(listDefinitions(schema)).toEqual(["/$defs/customer"]);
    expect(listDefinitions({ definitions: { a: {} } })).toEqual(["/definitions/a"]);
  });
});

// ---------------------------------------------------------------------------

describe("suggest", () => {
  test("edit distance counts the usual three edits", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
  });

  test("a transposition costs one edit, which is the point", () => {
    expect(editDistance("opne", "open")).toBe(1);
    expect(editDistance("ab", "ba")).toBe(1);
  });

  test("closestMatch finds a typo and refuses an unrelated word", () => {
    expect(closestMatch("completd", ["completed", "failed"])).toBe("completed");
    expect(closestMatch("opne", ["open", "closed"])).toBe("open");
    expect(closestMatch("banana", ["open", "closed"])).toBeNull();
    expect(closestMatch("OPEN", ["open"])).toBe("open");
  });

  test("ties go to the earliest candidate, so the suggestion is stable", () => {
    expect(closestMatch("ax", ["bx", "cx"])).toBe("bx");
  });
});
