/**
 * The pure core. Every function is tested directly, because a bug in
 * `daysFromCivil` or the cron field expander reads better as a failing unit
 * than as a failing tool call.
 *
 * Dates here are written as literals on purpose. A test that computes its own
 * expected value with the function under test proves nothing.
 */
import { describe, expect, test } from "bun:test";
import {
  addBusinessDays,
  addCalendarDays,
  addCalendarMonths,
  addToInstant,
  breakdownBetween,
  compareWallClocks,
  countBusinessDays,
  diffCalendarDays,
  diffCalendarMonths,
  expandRange,
  isBusinessDay,
} from "./lib/arithmetic";
import {
  civilFromDays,
  civilFromEpochMsUTC,
  dateFromDayOfYear,
  dayOfYear,
  daysFromCivil,
  daysInMonth,
  daysInYear,
  epochMsFromCivilUTC,
  formatOffset,
  isLeapYear,
  isValidTimeZone,
  isoDateFromEpochMs,
  isoFromEpochMs,
  isoWeek,
  pad,
  quarterOfMonth,
  resolveWallClock,
  simpleWeek,
  wallClockInZone,
  weekdayFromEpochDay,
  zoneOffsetMinutes,
} from "./lib/civil";
import { cronNext, describeCron, parseCron } from "./lib/cron";
import { decompose, formatDuration, parseDuration } from "./lib/duration";
import { NAMED_PATTERNS, formatWallClock } from "./lib/format";
import { parseDateString } from "./lib/parse";
import { expandRecurrence, parseRRule } from "./lib/recurrence";

const UTC = { assumeTimeZone: "UTC", twoDigitYearPivot: 68 };

/** A wall clock, written compactly so the tests stay readable. */
function wall(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) {
  return { year: y, month: mo, day: d, hour: h, minute: mi, second: s, millisecond: ms };
}

describe("civil: the day-count core", () => {
  test("the epoch itself is day zero", () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
  });

  test("known day counts either side of the epoch", () => {
    expect(daysFromCivil(1969, 12, 31)).toBe(-1);
    expect(daysFromCivil(2000, 1, 1)).toBe(10_957);
    expect(daysFromCivil(2026, 9, 17)).toBe(20_713);
  });

  test("civilFromDays inverts daysFromCivil across four centuries", () => {
    for (let day = -200_000; day <= 200_000; day += 997) {
      const civil = civilFromDays(day);
      expect(daysFromCivil(civil.year, civil.month, civil.day)).toBe(day);
    }
  });

  test("absolute day counts around the era boundary, where a round trip proves nothing", () => {
    // A round-trip test passes happily while both directions are off by the
    // same constant, which is exactly what a mis-transliterated floor division
    // produces below year 1. These are computed by hand from 0001-01-01, which
    // is fixed by MIN_ISO_EPOCH_MS: year 0 is a leap year (366 days) and year
    // -1 is not (365), so the counts step -719162, -719528, -719893.
    expect(daysFromCivil(1, 1, 1)).toBe(-719_162);
    expect(daysFromCivil(0, 12, 31)).toBe(-719_163);
    expect(daysFromCivil(0, 3, 1)).toBe(-719_468);
    expect(daysFromCivil(0, 1, 1)).toBe(-719_528);
    expect(daysFromCivil(-1, 12, 31)).toBe(-719_529);
    expect(daysFromCivil(-1, 1, 1)).toBe(-719_893);
    expect(daysFromCivil(-400, 1, 1)).toBe(-865_625);
    expect(civilFromDays(-719_162)).toEqual({ year: 1, month: 1, day: 1 });
    expect(civilFromDays(-719_528)).toEqual({ year: 0, month: 1, day: 1 });
    expect(civilFromDays(-719_893)).toEqual({ year: -1, month: 1, day: 1 });
    expect(civilFromDays(-865_625)).toEqual({ year: -400, month: 1, day: 1 });
  });

  test("every day count in a wide span is one calendar day after the last", () => {
    // Catches a discontinuity at an era edge that sampled days would step over.
    let previous = civilFromDays(-800_000);
    for (let day = -799_999; day <= 800_000; day += 1) {
      const civil = civilFromDays(day);
      const rolled =
        civil.day === previous.day + 1 ||
        (civil.day === 1 && (civil.month === previous.month + 1 || civil.month === 1));
      if (!rolled) expect({ day, previous, civil }).toEqual({ day, previous, civil: previous });
      previous = civil;
    }
    expect(previous).toEqual(civilFromDays(800_000));
  });

  test("weekday of a known date", () => {
    // 1970-01-01 was a Thursday.
    expect(weekdayFromEpochDay(0)).toBe(4);
    expect(weekdayFromEpochDay(daysFromCivil(2026, 9, 17))).toBe(4);
    expect(weekdayFromEpochDay(daysFromCivil(2026, 9, 20))).toBe(0);
  });

  test("the Gregorian leap rule, including the century exceptions", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  test("daysInMonth follows the leap rule for February only", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
    expect(daysInYear(2024)).toBe(366);
  });

  test("dayOfYear and its inverse agree", () => {
    expect(dayOfYear(2026, 1, 1)).toBe(1);
    expect(dayOfYear(2026, 12, 31)).toBe(365);
    expect(dayOfYear(2024, 12, 31)).toBe(366);
    expect(dateFromDayOfYear(2026, 260)).toEqual({ year: 2026, month: 9, day: 17 });
  });

  test("ISO weeks put early January in the previous week-year", () => {
    expect(isoWeek(2021, 1, 1)).toEqual({ week: 53, weekYear: 2020 });
    expect(isoWeek(2026, 1, 1)).toEqual({ week: 1, weekYear: 2026 });
    expect(isoWeek(2027, 1, 1)).toEqual({ week: 53, weekYear: 2026 });
    expect(isoWeek(2026, 9, 17)).toEqual({ week: 38, weekYear: 2026 });
  });

  test("the simple scheme disagrees with ISO in January, which is the point", () => {
    expect(simpleWeek(2021, 1, 1, 1)).toBe(1);
    expect(isoWeek(2021, 1, 1).week).toBe(53);
  });

  test("quarters shift with the fiscal year start", () => {
    expect(quarterOfMonth(3, 1)).toBe(1);
    expect(quarterOfMonth(11, 1)).toBe(4);
    expect(quarterOfMonth(2, 2)).toBe(1);
    expect(quarterOfMonth(1, 2)).toBe(4);
  });

  test("epoch milliseconds round-trip through the civil split", () => {
    const ms = epochMsFromCivilUTC(wall(2026, 9, 17, 14, 30, 5, 250));
    expect(civilFromEpochMsUTC(ms)).toEqual(wall(2026, 9, 17, 14, 30, 5, 250));
  });

  test("negative instants split correctly, which floor division makes easy to get wrong", () => {
    const ms = epochMsFromCivilUTC(wall(1969, 12, 31, 23, 59, 59, 999));
    expect(ms).toBe(-1);
    expect(civilFromEpochMsUTC(-1)).toEqual(wall(1969, 12, 31, 23, 59, 59, 999));
  });

  test("pad keeps a sign outside the digits", () => {
    expect(pad(5, 2)).toBe("05");
    expect(pad(2026, 4)).toBe("2026");
    expect(pad(-44, 4)).toBe("-0044");
  });

  test("formatOffset renders Z only when asked", () => {
    expect(formatOffset(0, "z")).toBe("Z");
    expect(formatOffset(0, "extended")).toBe("+00:00");
    expect(formatOffset(-330, "extended")).toBe("-05:30");
    expect(formatOffset(330, "basic")).toBe("+0530");
  });

  test("ISO rendering includes milliseconds only when they are non-zero", () => {
    expect(isoFromEpochMs(0, 0)).toBe("1970-01-01T00:00:00Z");
    expect(isoFromEpochMs(1, 0)).toBe("1970-01-01T00:00:00.001Z");
    expect(isoFromEpochMs(0, -300)).toBe("1969-12-31T19:00:00-05:00");
    expect(isoDateFromEpochMs(0, 0)).toBe("1970-01-01");
  });
});

describe("civil: timezones", () => {
  test("known zones validate and invented ones do not", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  test("offsets reflect the rules in force at the instant, not today's", () => {
    const january = Date.UTC(2026, 0, 15, 12);
    const july = Date.UTC(2026, 6, 15, 12);
    expect(zoneOffsetMinutes(january, "America/New_York")).toBe(-300);
    expect(zoneOffsetMinutes(july, "America/New_York")).toBe(-240);
    expect(zoneOffsetMinutes(january, "UTC")).toBe(0);
  });

  test("a half-hour zone is handled", () => {
    expect(zoneOffsetMinutes(Date.UTC(2026, 0, 15), "Asia/Kolkata")).toBe(330);
  });

  test("the wall clock in a zone is the local reading", () => {
    const w = wallClockInZone(Date.UTC(2026, 0, 15, 12, 0, 0), "Asia/Tokyo");
    expect({ year: w.year, month: w.month, day: w.day, hour: w.hour }).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 21,
    });
  });

  test("an ordinary wall clock resolves uniquely", () => {
    const r = resolveWallClock(wall(2026, 6, 15, 12), "America/New_York");
    expect(r.resolution).toBe("unique");
    expect(isoFromEpochMs(r.epochMs, 0)).toBe("2026-06-15T16:00:00Z");
  });

  test("the hour that repeats at fall back is reported ambiguous", () => {
    const r = resolveWallClock(wall(2026, 11, 1, 1, 30), "America/New_York");
    expect(r.resolution).toBe("ambiguous");
    expect(r.candidates.length).toBe(2);
    // The earlier instant, still on daylight time, is the one chosen.
    expect(r.offsetMinutes).toBe(-240);
  });

  test("the hour skipped at spring forward is reported nonexistent", () => {
    const r = resolveWallClock(wall(2026, 3, 8, 2, 30), "America/New_York");
    expect(r.resolution).toBe("nonexistent");
    expect(r.candidates).toEqual([]);
    expect(isoFromEpochMs(r.epochMs, 0)).toBe("2026-03-08T07:30:00Z");
  });

  test("UTC takes the fast path and never reports a transition", () => {
    expect(resolveWallClock(wall(2026, 3, 8, 2, 30), "UTC").resolution).toBe("unique");
  });
});

describe("parse: the supported grammar", () => {
  const ok = (text: string, extra: Partial<typeof UTC> = {}) => {
    const r = parseDateString(text, { ...UTC, ...extra });
    if (!r.ok) throw new Error(`expected "${text}" to parse: ${r.error}`);
    return r;
  };

  test("ISO extended, with and without a time", () => {
    expect(ok("2026-09-17").iso).toBe("2026-09-17T00:00:00Z");
    expect(ok("2026-09-17T14:30:00Z").iso).toBe("2026-09-17T14:30:00Z");
    expect(ok("2026-09-17 14:30").iso).toBe("2026-09-17T14:30:00Z");
    expect(ok("2026-09-17T14:30:00.250Z").iso).toBe("2026-09-17T14:30:00.250Z");
  });

  test("every offset spelling means the same instant", () => {
    const expected = "2026-09-17T12:30:00Z";
    expect(ok("2026-09-17T14:30:00+02:00").iso).toBe(expected);
    expect(ok("2026-09-17T14:30:00+0200").iso).toBe(expected);
    expect(ok("2026-09-17T14:30:00+02").iso).toBe(expected);
  });

  test("ISO basic, ordinal and week forms", () => {
    expect(ok("20260917").iso).toBe("2026-09-17T00:00:00Z");
    expect(ok("20260917T143000Z").iso).toBe("2026-09-17T14:30:00Z");
    expect(ok("2026-260").iso).toBe("2026-09-17T00:00:00Z");
    expect(ok("2026-W38-4").iso).toBe("2026-09-17T00:00:00Z");
    expect(ok("2026-W38").iso).toBe("2026-09-14T00:00:00Z");
  });

  test("a week number that year does not have is refused, not rolled into the next", () => {
    // 2026 starts on a Thursday and so has 53 ISO weeks; 2025 and 2021 have 52.
    // Week 53 of a 52-week year used to come back as that year's successor's
    // week 1 with no complaint at all.
    expect(ok("2026-W53").iso).toBe("2026-12-28T00:00:00Z");
    expect(ok("2020-W53").iso).toBe("2020-12-28T00:00:00Z");
    for (const text of ["2025-W53", "2021-W53"]) {
      const r = parseDateString(text, UTC);
      expect({ text, ok: r.ok }).toEqual({ text, ok: false });
      if (r.ok) throw new Error("unreachable");
      expect(r.error).toContain("52 ISO weeks");
    }
  });

  test("month-name forms in either order, with a time attached", () => {
    expect(ok("17 Sep 2026").iso).toBe("2026-09-17T00:00:00Z");
    expect(ok("September 17, 2026").iso).toBe("2026-09-17T00:00:00Z");
    expect(ok("17 September 2026 14:30").iso).toBe("2026-09-17T14:30:00Z");
    expect(ok("Sept 17 2026").iso).toBe("2026-09-17T00:00:00Z");
  });

  test("RFC 2822, weekday prefix and all", () => {
    const r = ok("Thu, 17 Sep 2026 14:30:00 +0200");
    expect(r.iso).toBe("2026-09-17T12:30:00Z");
    expect(r.hadOffset).toBe(true);
  });

  test("GMT and UTC are read as a zero offset", () => {
    expect(ok("Thu, 17 Sep 2026 14:30:00 GMT").iso).toBe("2026-09-17T14:30:00Z");
  });

  test("12-hour times with a meridiem", () => {
    expect(ok("2026-09-17 12:00 AM").iso).toBe("2026-09-17T00:00:00Z");
    expect(ok("2026-09-17 12:00 PM").iso).toBe("2026-09-17T12:00:00Z");
    expect(ok("2026-09-17 1:05 pm").iso).toBe("2026-09-17T13:05:00Z");
  });

  test("24:00 rolls into the next day, as ISO 8601 says", () => {
    const r = ok("2026-09-17T24:00:00Z");
    expect(r.iso).toBe("2026-09-18T00:00:00Z");
    expect(r.notes.join(" ")).toContain("24:00");
  });

  test("a leap second is clamped and the clamp is reported", () => {
    const r = ok("2016-12-31T23:59:60Z");
    expect(r.iso).toBe("2016-12-31T23:59:59Z");
    expect(r.notes.join(" ")).toContain("leap second");
  });

  test("a year-first slash date is never ambiguous", () => {
    const r = ok("2026/09/17");
    expect(r.iso).toBe("2026-09-17T00:00:00Z");
    expect(r.format).toBe("ymd-slash");
  });

  test("an ambiguous numeric date is reported, not guessed", () => {
    const r = parseDateString("03/04/2026", UTC);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.ambiguous?.interpretations.map((i) => i.date)).toEqual(["2026-03-04", "2026-04-03"]);
  });

  test("dateOrder resolves the ambiguity both ways", () => {
    expect(ok("03/04/2026", { dateOrder: "MDY" }).iso).toBe("2026-03-04T00:00:00Z");
    expect(ok("03/04/2026", { dateOrder: "DMY" }).iso).toBe("2026-04-03T00:00:00Z");
  });

  test("a numeric date with only one valid reading is accepted, and says so", () => {
    const r = ok("17/09/2026");
    expect(r.iso).toBe("2026-09-17T00:00:00Z");
    expect(r.notes.join(" ")).toContain("DMY");
  });

  test("two-digit years use the pivot", () => {
    expect(ok("3-4-26", { dateOrder: "DMY" }).iso).toBe("2026-04-03T00:00:00Z");
    expect(ok("3-4-70", { dateOrder: "DMY" }).iso).toBe("1970-04-03T00:00:00Z");
    expect(ok("3-4-70", { dateOrder: "DMY", twoDigitYearPivot: 80 }).iso).toBe(
      "2070-04-03T00:00:00Z",
    );
  });

  test("impossible dates are rejected with the reason", () => {
    const r = parseDateString("2026-02-30", UTC);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("28 days");
  });

  test("a string that is not a date at all is rejected, not split apart", () => {
    const r = parseDateString("not-a-date", UTC);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("not-a-date");
  });

  test("empty input is rejected", () => {
    expect(parseDateString("   ", UTC).ok).toBe(false);
  });

  test("a bare date in a zone is anchored to that zone's midnight", () => {
    const r = parseDateString("2026-06-15", { ...UTC, assumeTimeZone: "America/New_York" });
    if (!r.ok) throw new Error("expected a parse");
    expect(r.iso).toBe("2026-06-15T04:00:00Z");
    expect(r.hadOffset).toBe(false);
  });

  test("a wall clock in a DST gap is reported rather than silently moved", () => {
    const r = parseDateString("2026-03-08T02:30:00", {
      ...UTC,
      assumeTimeZone: "America/New_York",
    });
    if (!r.ok) throw new Error("expected a parse");
    expect(r.wallClockResolution).toBe("nonexistent");
  });
});

describe("format: the token formatter", () => {
  const ctx = {
    wall: wall(2026, 9, 17, 14, 5, 9, 42),
    offsetMinutes: -240,
    epochMs: 1_789_655_400_000,
    abbreviation: "EDT",
    locale: "en-US",
  };

  test("date and time tokens, padded and unpadded", () => {
    expect(formatWallClock("YYYY-MM-DD HH:mm:ss.SSS", ctx)).toBe("2026-09-17 14:05:09.042");
    expect(formatWallClock("M/D/YY", ctx)).toBe("9/17/26");
    expect(formatWallClock("H:m:s", ctx)).toBe("14:5:9");
  });

  test("names, quarters, weeks and ordinals", () => {
    expect(formatWallClock("dddd D MMMM YYYY", ctx)).toBe("Thursday 17 September 2026");
    expect(formatWallClock("ddd MMM dd", ctx)).toBe("Thu Sep Th");
    expect(formatWallClock("[Q]Q [W]WW DDD GGGG", ctx)).toBe("Q3 W38 260 2026");
  });

  test("12-hour tokens and the meridiem", () => {
    expect(formatWallClock("hh:mm A", ctx)).toBe("02:05 PM");
    expect(formatWallClock("h a", { ...ctx, wall: wall(2026, 9, 17, 0, 0) })).toBe("12 am");
    expect(formatWallClock("h A", { ...ctx, wall: wall(2026, 9, 17, 12, 0) })).toBe("12 PM");
  });

  test("offset and abbreviation tokens", () => {
    expect(formatWallClock("Z ZZ zz", ctx)).toBe("-04:00 -0400 EDT");
  });

  test("square brackets pass text through untouched", () => {
    expect(formatWallClock("[Year:] YYYY [MM stays]", ctx)).toBe("Year: 2026 MM stays");
  });

  test("unrecognized characters are left alone", () => {
    expect(formatWallClock("YYYY/??/DD", ctx)).toBe("2026/??/17");
  });

  test("unix tokens come from the instant, not the wall clock", () => {
    expect(formatWallClock("X x", ctx)).toBe("1789655400 1789655400000");
  });

  test("every named preset renders without leaving a token behind", () => {
    for (const pattern of Object.values(NAMED_PATTERNS)) {
      const out = formatWallClock(pattern, ctx);
      expect(out).not.toContain("YYYY");
      expect(out.length).toBeGreaterThan(0);
    }
  });

  test("a non-English locale changes the names, not the numbers", () => {
    expect(formatWallClock("MM", { ...ctx, locale: "de-DE" })).toBe("09");
    expect(formatWallClock("MMMM", { ...ctx, locale: "de-DE" })).toBe("September");
  });
});

describe("arithmetic: calendar units", () => {
  test("adding months clamps to the end of a shorter month", () => {
    expect(addCalendarMonths(wall(2026, 1, 31), 1)).toEqual(wall(2026, 2, 28));
    expect(addCalendarMonths(wall(2024, 1, 31), 1)).toEqual(wall(2024, 2, 29));
    expect(addCalendarMonths(wall(2026, 3, 31), -1)).toEqual(wall(2026, 2, 28));
  });

  test("the clamp makes the operation non-reversible, which is documented", () => {
    const forward = addCalendarMonths(wall(2026, 1, 31), 1);
    expect(addCalendarMonths(forward, -1)).toEqual(wall(2026, 1, 28));
  });

  test("month addition crosses year boundaries in both directions", () => {
    expect(addCalendarMonths(wall(2026, 11, 15), 3)).toEqual(wall(2027, 2, 15));
    expect(addCalendarMonths(wall(2026, 2, 15), -3)).toEqual(wall(2025, 11, 15));
  });

  test("adding days leaves the time of day alone", () => {
    expect(addCalendarDays(wall(2026, 2, 28, 9, 30), 1)).toEqual(wall(2026, 3, 1, 9, 30));
  });

  test("a calendar day across spring forward keeps the wall-clock time", () => {
    const start = Date.UTC(2026, 2, 7, 14); // 09:00 EST
    const result = addToInstant(start, "America/New_York", { days: 1 });
    expect(wallClockInZone(result.epochMs, "America/New_York").hour).toBe(9);
    expect(result.epochMs - start).toBe(23 * 3_600_000);
  });

  test("24 hours across spring forward moves the wall clock instead", () => {
    const start = Date.UTC(2026, 2, 7, 14);
    const result = addToInstant(start, "America/New_York", { hours: 24 });
    expect(wallClockInZone(result.epochMs, "America/New_York").hour).toBe(10);
    expect(result.epochMs - start).toBe(24 * 3_600_000);
  });

  test("a clamp during addition is reported in the notes", () => {
    const result = addToInstant(Date.UTC(2026, 0, 31), "UTC", { months: 1 });
    expect(isoFromEpochMs(result.epochMs, 0)).toBe("2026-02-28T00:00:00Z");
    expect(result.notes.join(" ")).toContain("clamped");
  });

  test("mixed units apply the calendar part first", () => {
    const result = addToInstant(Date.UTC(2026, 0, 31, 12), "UTC", { months: 1, hours: 12 });
    expect(isoFromEpochMs(result.epochMs, 0)).toBe("2026-03-01T00:00:00Z");
  });
});

describe("arithmetic: differences", () => {
  test("whole calendar months truncate toward zero", () => {
    expect(diffCalendarMonths(wall(2026, 1, 1), wall(2026, 3, 1))).toBe(2);
    expect(diffCalendarMonths(wall(2026, 1, 1), wall(2026, 2, 28))).toBe(1);
    expect(diffCalendarMonths(wall(2026, 1, 15), wall(2026, 2, 14))).toBe(0);
    expect(diffCalendarMonths(wall(2026, 3, 1), wall(2026, 1, 1))).toBe(-2);
  });

  test("the diff is the inverse of the clamping add, including at a month end", () => {
    // Jan 31 + 1 month clamps to Feb 28, so Jan 31 -> Feb 28 is one whole month.
    expect(diffCalendarMonths(wall(2026, 1, 31), wall(2026, 2, 28))).toBe(1);
    expect(addCalendarMonths(wall(2026, 1, 31), 1)).toEqual(wall(2026, 2, 28));
    expect(diffCalendarMonths(wall(2026, 1, 31), wall(2026, 2, 27))).toBe(0);
  });

  test("calendar days count boundaries, ignoring the time of day", () => {
    expect(diffCalendarDays(wall(2026, 1, 1, 23, 59), wall(2026, 1, 2, 0, 1))).toBe(1);
    expect(diffCalendarDays(wall(2026, 1, 1, 0, 0), wall(2026, 1, 1, 23, 59))).toBe(0);
  });

  test("the breakdown decomposes largest unit first and is always non-negative", () => {
    expect(breakdownBetween(wall(2026, 1, 1), wall(2027, 3, 15, 4, 5, 6))).toEqual({
      years: 1,
      months: 2,
      days: 14,
      hours: 4,
      minutes: 5,
      seconds: 6,
      milliseconds: 0,
    });
    expect(breakdownBetween(wall(2027, 3, 15), wall(2026, 1, 1)).years).toBe(1);
  });

  test("comparing wall clocks orders them", () => {
    expect(compareWallClocks(wall(2026, 1, 1), wall(2026, 1, 2))).toBe(-1);
    expect(compareWallClocks(wall(2026, 1, 2), wall(2026, 1, 1))).toBe(1);
    expect(compareWallClocks(wall(2026, 1, 1), wall(2026, 1, 1))).toBe(0);
  });
});

describe("arithmetic: business days", () => {
  const weekend = new Set([0, 6]);
  const none = { weekend, holidays: new Set<number>() };
  const monday = daysFromCivil(2026, 9, 14);
  const friday = daysFromCivil(2026, 9, 18);
  const saturday = daysFromCivil(2026, 9, 19);

  test("weekends are not business days", () => {
    expect(isBusinessDay(monday, none)).toBe(true);
    expect(isBusinessDay(saturday, none)).toBe(false);
  });

  test("a holiday is not a business day", () => {
    expect(isBusinessDay(monday, { weekend, holidays: new Set([monday]) })).toBe(false);
  });

  test("counting is inclusive or half-open as asked", () => {
    expect(countBusinessDays(monday, friday, none, true)).toBe(5);
    expect(countBusinessDays(monday, friday, none, false)).toBe(4);
  });

  test("counting backwards gives a negative result", () => {
    expect(countBusinessDays(friday, monday, none, true)).toBe(-5);
  });

  test("holidays inside the range are excluded", () => {
    const withHoliday = { weekend, holidays: new Set([daysFromCivil(2026, 9, 16)]) };
    expect(countBusinessDays(monday, friday, withHoliday, true)).toBe(4);
  });

  test("an absurd span is refused rather than walked", () => {
    expect(() => countBusinessDays(0, 500_000, none, true)).toThrow(/limit/);
  });

  test("adding one business day to a Friday lands on Monday", () => {
    const result = addBusinessDays(friday, 1, none);
    expect(civilFromDays(result.epochDay)).toEqual({ year: 2026, month: 9, day: 21 });
    expect(result.skipped).toBe(2);
  });

  test("adding zero does not move, but does report the start", () => {
    expect(addBusinessDays(saturday, 0, none)).toEqual({
      epochDay: saturday,
      skipped: 0,
      startWasBusinessDay: false,
    });
  });

  test("a negative count walks backwards", () => {
    const result = addBusinessDays(daysFromCivil(2026, 9, 21), -1, none);
    expect(civilFromDays(result.epochDay)).toEqual({ year: 2026, month: 9, day: 18 });
  });

  test("a calendar with no working days is refused rather than looped on", () => {
    const allWeekend = { weekend: new Set([0, 1, 2, 3, 4, 5, 6]), holidays: new Set<number>() };
    expect(() => addBusinessDays(monday, 1, allWeekend)).toThrow(/without finishing/);
  });
});

describe("arithmetic: ranges", () => {
  const iso = (list: number[]) => list.map((ms) => isoDateFromEpochMs(ms, 0));

  test("a daily range includes both ends by default", () => {
    const r = expandRange(
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 0, 4),
      { unit: "days", amount: 1 },
      "UTC",
      100,
      true,
    );
    expect(iso(r.instants)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]);
    expect(r.truncated).toBe(false);
  });

  test("an exclusive end drops the last item", () => {
    const r = expandRange(
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 0, 4),
      { unit: "days", amount: 1 },
      "UTC",
      100,
      false,
    );
    expect(iso(r.instants)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  test("monthly steps anchor on the start, so the 31st comes back", () => {
    const r = expandRange(
      Date.UTC(2026, 0, 31),
      Date.UTC(2026, 4, 31),
      { unit: "months", amount: 1 },
      "UTC",
      100,
      true,
    );
    expect(iso(r.instants)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  test("the cap truncates and says so", () => {
    const r = expandRange(
      Date.UTC(2026, 0, 1),
      Date.UTC(2027, 0, 1),
      { unit: "days", amount: 1 },
      "UTC",
      3,
      true,
    );
    expect(r.instants.length).toBe(3);
    expect(r.truncated).toBe(true);
  });

  test("a backwards range needs a negative step, and vice versa", () => {
    expect(() =>
      expandRange(
        Date.UTC(2026, 0, 4),
        Date.UTC(2026, 0, 1),
        { unit: "days", amount: 1 },
        "UTC",
        10,
        true,
      ),
    ).toThrow(/negative/);
    expect(() =>
      expandRange(
        Date.UTC(2026, 0, 1),
        Date.UTC(2026, 0, 4),
        { unit: "days", amount: -1 },
        "UTC",
        10,
        true,
      ),
    ).toThrow(/positive/);
  });

  test("a zero step is refused", () => {
    expect(() => expandRange(0, 10, { unit: "days", amount: 0 }, "UTC", 10, true)).toThrow(
      /must not be zero/,
    );
  });
});

describe("duration: parsing", () => {
  const ok = (text: string) => {
    const r = parseDuration(text);
    if (!r.ok) throw new Error(`expected "${text}" to parse: ${r.error}`);
    return r;
  };

  test("ISO 8601 durations, with and without a time part", () => {
    expect(ok("PT2H30M").totalMilliseconds).toBe(9_000_000);
    expect(ok("P3D").totalMilliseconds).toBe(259_200_000);
    expect(ok("P2W").totalMilliseconds).toBe(1_209_600_000);
    expect(ok("PT0.5S").totalMilliseconds).toBe(500);
  });

  test("years and months parse but are marked inexact", () => {
    const r = ok("P1Y2M3D");
    expect(r.exact).toBe(false);
    expect(r.duration.years).toBe(1);
    expect(r.duration.months).toBe(2);
    expect(r.totalMilliseconds).toBe(259_200_000);
    expect(r.notes.join(" ")).toContain("no fixed length");
  });

  test("a fractional year is refused rather than approximated", () => {
    const r = parseDuration("P1.5Y");
    expect(r.ok).toBe(false);
  });

  test("human shorthand, spaced or not", () => {
    expect(ok("2h30m").totalMilliseconds).toBe(9_000_000);
    expect(ok("1d 4h").totalMilliseconds).toBe(100_800_000);
    expect(ok("90 minutes").totalMilliseconds).toBe(5_400_000);
    expect(ok("1 hour 30 min").totalMilliseconds).toBe(5_400_000);
  });

  test("bare m means minutes, mo means months", () => {
    expect(ok("5m").duration.minutes).toBe(5);
    expect(ok("5mo").duration.months).toBe(5);
  });

  test("a leading minus makes the whole duration negative", () => {
    const r = ok("-90m");
    expect(r.duration.negative).toBe(true);
    expect(r.totalMilliseconds).toBe(-5_400_000);
  });

  test("clock form", () => {
    expect(ok("01:30:15").totalMilliseconds).toBe(5_415_000);
    expect(ok("1:30").totalMilliseconds).toBe(5_400_000);
  });

  test("an unknown unit names itself in the error", () => {
    const r = parseDuration("2 fortnights");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("fortnights");
  });

  test("a repeated unit is refused", () => {
    expect(parseDuration("1h 2h").ok).toBe(false);
  });

  test("text the pairs did not consume is refused, not silently dropped", () => {
    // "5m!!!" must not quietly become a five-minute timeout, and "P-1D" must
    // not become a day: the P is not filler, it means this was meant as ISO.
    for (const input of ["5m!!!", "5m garbage", "about 5m or so", "P-1D"]) {
      const r = parseDuration(input);
      expect({ input, ok: r.ok }).toEqual({ input, ok: false });
    }
    const junk = parseDuration("5m!!!");
    if (junk.ok) throw new Error("unreachable");
    expect(junk.error).toContain("!!!");
  });

  test("whitespace, commas, a plus and the word 'and' are filler and are allowed", () => {
    expect(ok("1 hour, 30 minutes").totalMilliseconds).toBe(5_400_000);
    expect(ok("2 hours and 30 minutes").totalMilliseconds).toBe(9_000_000);
    expect(ok("+1h").totalMilliseconds).toBe(3_600_000);
  });

  test("empty and unparseable input are refused", () => {
    expect(parseDuration("").ok).toBe(false);
    expect(parseDuration("soon").ok).toBe(false);
  });
});

describe("duration: formatting", () => {
  test("decompose splits by fixed units from the largest requested", () => {
    expect(decompose(90_061_001, "days")).toEqual({
      weeks: 0,
      days: 1,
      hours: 1,
      minutes: 1,
      seconds: 1,
      milliseconds: 1,
    });
    expect(decompose(90_061_001, "hours").hours).toBe(25);
  });

  test("weeks are opt-in", () => {
    expect(decompose(1_209_600_000, "days").days).toBe(14);
    expect(decompose(1_209_600_000, "weeks").weeks).toBe(2);
  });

  test("short, long and compact styles", () => {
    expect(formatDuration(5_415_000, "short", "days", 2)).toBe("1h 30m");
    expect(formatDuration(5_415_000, "long", "days", 2)).toBe("1 hour 30 minutes");
    expect(formatDuration(5_415_000, "compact", "days", 3)).toBe("1h30m15s");
  });

  test("maxUnits truncates rather than rounding", () => {
    expect(formatDuration(90_061_000, "short", "days", 2)).toBe("1d 1h");
    expect(formatDuration(90_061_000, "short", "days", 4)).toBe("1d 1h 1m 1s");
  });

  test("the singular is used for one", () => {
    expect(formatDuration(3_600_000, "long", "days", 1)).toBe("1 hour");
    expect(formatDuration(7_200_000, "long", "days", 1)).toBe("2 hours");
  });

  test("clock style pads and only shows days when they are in scope", () => {
    expect(formatDuration(5_415_000, "clock", "hours", 3)).toBe("01:30:15");
    expect(formatDuration(90_061_000, "clock", "days", 3)).toBe("1:01:01:01");
  });

  test("ISO output round-trips through the parser", () => {
    for (const ms of [0, 1000, 5_415_000, 90_061_000, 1_209_600_000]) {
      const iso = formatDuration(ms, "iso", "days", 6);
      const back = parseDuration(iso);
      expect(back.ok).toBe(true);
      if (back.ok) expect(back.totalMilliseconds).toBe(ms);
    }
  });

  test("zero renders as zero, not as an empty string", () => {
    expect(formatDuration(0, "short", "days", 2)).toBe("0s");
    expect(formatDuration(0, "long", "days", 2)).toBe("0 seconds");
    expect(formatDuration(0, "iso", "days", 2)).toBe("PT0S");
  });

  test("a negative duration keeps its sign", () => {
    expect(formatDuration(-5_400_000, "short", "days", 2)).toBe("-1h 30m");
  });
});

describe("cron: parsing", () => {
  const fields = (expr: string) => {
    const r = parseCron(expr);
    if (!r.ok) throw new Error(`expected "${expr}" to parse: ${r.error}`);
    return r.fields;
  };

  test("a wildcard field expands to the whole range", () => {
    expect(fields("* * * * *").minutes.length).toBe(60);
    expect(fields("* * * * *").hours.length).toBe(24);
    expect(fields("* * * * *").domRestricted).toBe(false);
  });

  test("steps, ranges and lists", () => {
    expect(fields("*/15 * * * *").minutes).toEqual([0, 15, 30, 45]);
    expect(fields("0 9-17 * * *").hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(fields("0 0,6,12,18 * * *").hours).toEqual([0, 6, 12, 18]);
    expect(fields("0 9-17/4 * * *").hours).toEqual([9, 13, 17]);
  });

  test("a bare value with a step runs to the end of the field", () => {
    expect(fields("5/20 * * * *").minutes).toEqual([5, 25, 45]);
  });

  test("names work in both named fields, including in ranges", () => {
    expect(fields("0 0 * JAN-MAR *").months).toEqual([1, 2, 3]);
    expect(fields("0 0 * * MON,FRI").daysOfWeek).toEqual([1, 5]);
    expect(fields("0 0 * * mon-fri").daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  test("7 and 0 both mean Sunday and collapse to one value", () => {
    expect(fields("0 0 * * 0,7").daysOfWeek).toEqual([0]);
  });

  test("a wrapping range wraps", () => {
    expect(fields("0 0 * * FRI-MON").daysOfWeek).toEqual([0, 1, 5, 6]);
  });

  test("? behaves as * where it is allowed", () => {
    expect(fields("0 0 ? * MON").domRestricted).toBe(false);
    expect(parseCron("0 ? * * *").ok).toBe(false);
  });

  test("macros expand", () => {
    expect(fields("@daily").normalized).toBe("0 0 * * *");
    expect(fields("@weekly").daysOfWeek).toEqual([0]);
    expect(fields("@hourly").minutes).toEqual([0]);
  });

  test("the wrong number of fields is refused with a useful message", () => {
    const six = parseCron("0 0 0 * * *");
    expect(six.ok).toBe(false);
    if (six.ok) throw new Error("unreachable");
    expect(six.error).toContain("5-field form only");
    expect(parseCron("0 0").ok).toBe(false);
  });

  test("out-of-range values and junk are refused", () => {
    expect(parseCron("60 * * * *").ok).toBe(false);
    expect(parseCron("* 24 * * *").ok).toBe(false);
    expect(parseCron("banana * * * *").ok).toBe(false);
    expect(parseCron("*/0 * * * *").ok).toBe(false);
  });

  test("unsupported dialect extensions are named, not ignored", () => {
    const r = parseCron("0 0 L * *");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("standard cron only");
    expect(parseCron("@reboot").ok).toBe(false);
    expect(parseCron("@fortnightly").ok).toBe(false);
  });

  test("L, W, # and H are named in every field, not just day-of-month", () => {
    // Day-of-week has a name table, so these used to fall through to a generic
    // "not a number or a name" that told the author nothing about why.
    for (const expr of ["0 0 * * 5#2", "0 0 * * 5L", "0 0 15W * *", "0 0 LW * *"]) {
      const r = parseCron(expr);
      if (r.ok) throw new Error(`expected "${expr}" to be refused`);
      expect({ expr, quartz: r.error.includes("Quartz") }).toEqual({ expr, quartz: true });
    }
    for (const expr of ["H 0 * * *", "H/15 * * * *"]) {
      const r = parseCron(expr);
      if (r.ok) throw new Error(`expected "${expr}" to be refused`);
      expect({ expr, jenkins: r.error.includes("Jenkins") }).toEqual({ expr, jenkins: true });
    }
  });

  test("month and weekday names survive the dialect check, L and W and all", () => {
    // JUL contains an L and WED a W; the name table is consulted first.
    expect(fields("0 0 * JUL-SEP *").months).toEqual([7, 8, 9]);
    expect(fields("0 0 * * WED-FRI").daysOfWeek).toEqual([3, 4, 5]);
  });

  test("? has to be the whole field, so it cannot smuggle itself into a step", () => {
    // "?/5" in a minute field used to be accepted as "*/5" even though a bare
    // "?" there is refused, and "1,?" left domRestricted set on a field that
    // matches every day — which changes the day-of-month/day-of-week OR rule.
    expect(parseCron("?/5 * * * *").ok).toBe(false);
    expect(parseCron("0 0 * * ?/2").ok).toBe(false);
    const listed = parseCron("0 0 1,? * *");
    expect(listed.ok).toBe(false);
    if (listed.ok) throw new Error("unreachable");
    expect(listed.error).toContain("whole day-of-month field");
    expect(fields("0 0 ? * MON").domRestricted).toBe(false);
  });

  test("a reversed range wraps around the end of the field", () => {
    expect(fields("0 0 * * FRI-MON").daysOfWeek).toEqual([0, 1, 5, 6]);
    expect(fields("0 0 * NOV-FEB *").months).toEqual([1, 2, 11, 12]);
    expect(parseCron("0 0 * * FRI-MON/2").ok).toBe(false);
  });
});

describe("cron: next firing times", () => {
  const next = (expr: string, after: string, count = 3, zone = "UTC") => {
    const parsed = parseCron(expr);
    if (!parsed.ok) throw new Error(parsed.error);
    const start = parseDateString(after, UTC);
    if (!start.ok) throw new Error(start.error);
    return cronNext(parsed.fields, start.epochMs, zone, count);
  };

  test("the reference instant itself never fires — the search is exclusive", () => {
    const r = next("0 * * * *", "2026-09-17T14:00:00Z", 1);
    expect(isoFromEpochMs(r.firings[0]?.epochMs ?? 0, 0)).toBe("2026-09-17T15:00:00Z");
  });

  test("a quarter-hourly weekday schedule", () => {
    const r = next("*/15 9-17 * * 1-5", "2026-09-17T14:31:00Z", 3);
    expect(r.firings.map((f) => isoFromEpochMs(f.epochMs, 0))).toEqual([
      "2026-09-17T14:45:00Z",
      "2026-09-17T15:00:00Z",
      "2026-09-17T15:15:00Z",
    ]);
  });

  test("the schedule rolls over the end of a day and a month", () => {
    const r = next("0 0 1 * *", "2026-09-17T00:00:00Z", 3);
    expect(r.firings.map((f) => isoFromEpochMs(f.epochMs, 0))).toEqual([
      "2026-10-01T00:00:00Z",
      "2026-11-01T00:00:00Z",
      "2026-12-01T00:00:00Z",
    ]);
  });

  test("day-of-month and day-of-week are ORed when both are restricted", () => {
    const r = next("0 0 1 * MON", "2026-09-17T00:00:00Z", 4);
    expect(r.firings.map((f) => isoDateFromEpochMs(f.epochMs, 0))).toEqual([
      "2026-09-21",
      "2026-09-28",
      "2026-10-01",
      "2026-10-05",
    ]);
  });

  test("a schedule that can never fire exhausts the horizon instead of looping", () => {
    const r = next("0 0 30 2 *", "2026-01-01T00:00:00Z", 1);
    expect(r.firings).toEqual([]);
    expect(r.exhausted).toBe(true);
  });

  test("29 February fires only in leap years", () => {
    const r = next("0 0 29 2 *", "2026-01-01T00:00:00Z", 2);
    expect(r.firings.map((f) => isoDateFromEpochMs(f.epochMs, 0))).toEqual([
      "2028-02-29",
      "2032-02-29",
    ]);
  });

  test("a wall clock removed by spring forward is skipped and reported", () => {
    const r = next("30 2 * * *", "2026-03-06T00:00:00Z", 3, "America/New_York");
    expect(r.skippedForDst).toEqual(["2026-03-08T02:30"]);
    expect(r.firings.map((f) => isoFromEpochMs(f.epochMs, 0))).toEqual([
      "2026-03-06T07:30:00Z",
      "2026-03-07T07:30:00Z",
      "2026-03-09T06:30:00Z",
    ]);
  });

  test("a wall clock repeated by fall back fires once, at the first occurrence", () => {
    const r = next("30 1 * * *", "2026-10-31T00:00:00Z", 2, "America/New_York");
    const on = r.firings.map((f) => isoFromEpochMs(f.epochMs, 0));
    expect(on[0]).toBe("2026-10-31T05:30:00Z");
    expect(on[1]).toBe("2026-11-01T05:30:00Z");
    expect(r.firings[1]?.note).toContain("occurs twice");
  });

  test("firings are strictly increasing", () => {
    const r = next("*/7 * * * *", "2026-09-17T00:00:00Z", 20);
    for (let i = 1; i < r.firings.length; i += 1) {
      expect((r.firings[i]?.epochMs ?? 0) > (r.firings[i - 1]?.epochMs ?? 0)).toBe(true);
    }
  });
});

describe("cron: description", () => {
  const describe_ = (expr: string) => {
    const r = parseCron(expr);
    if (!r.ok) throw new Error(r.error);
    return describeCron(r.fields);
  };

  test("the trivial schedules", () => {
    expect(describe_("* * * * *")).toBe("Every minute, every day");
    expect(describe_("@daily")).toBe("At 00:00, every day");
    expect(describe_("@hourly")).toBe("At 0th minute past every hour, every day");
  });

  test("steps read as intervals", () => {
    expect(describe_("*/15 * * * *")).toContain("Every 15 minutes");
  });

  test("contiguous sets read as ranges", () => {
    const text = describe_("*/15 9-17 * * 1-5");
    expect(text).toContain("every hour from 09 through 17");
    expect(text).toContain("Monday through Friday");
  });

  test("months and days of the month are named", () => {
    const text = describe_("0 9 1,15 JAN-MAR *");
    expect(text).toContain("1st and 15th");
    expect(text).toContain("January, February and March");
  });

  test("the OR trap is called out when both day fields are restricted", () => {
    expect(describe_("0 0 1 * MON")).toContain("ORs day-of-month with day-of-week");
  });
});

describe("recurrence: parsing", () => {
  test("the supported parts parse", () => {
    const r = parseRRule("FREQ=WEEKLY;INTERVAL=2;COUNT=6;BYDAY=MO,WE");
    if (!r.ok) throw new Error(r.error);
    expect(r.parts).toEqual({ freq: "WEEKLY", interval: 2, count: 6, byDay: [1, 3] });
  });

  test("the RRULE: prefix is optional", () => {
    expect(parseRRule("RRULE:FREQ=DAILY").ok).toBe(true);
  });

  test("UNTIL accepts a plain date and a UTC date-time", () => {
    const withDate = parseRRule("FREQ=DAILY;UNTIL=20261231");
    const withTime = parseRRule("FREQ=DAILY;UNTIL=20261231T120000Z");
    expect(withDate.ok && withTime.ok).toBe(true);
    if (!withDate.ok || !withTime.ok) throw new Error("unreachable");
    // A date-only UNTIL covers the whole day.
    expect(withDate.parts.untilEpochMs).toBeGreaterThan(withTime.parts.untilEpochMs ?? 0);
  });

  test("unsupported parts are refused by name", () => {
    for (const part of ["BYMONTH=1", "BYMONTHDAY=15", "BYSETPOS=-1", "WKST=SU"]) {
      const r = parseRRule(`FREQ=MONTHLY;${part}`);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.error).toContain(part.split("=")[0] as string);
    }
  });

  test("positional BYDAY is refused rather than read as plain", () => {
    const r = parseRRule("FREQ=MONTHLY;BYDAY=2MO");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("positional");
  });

  test("BYDAY with YEARLY is refused, because it needs parts we do not have", () => {
    expect(parseRRule("FREQ=YEARLY;BYDAY=MO").ok).toBe(false);
  });

  test("sub-daily frequencies are refused with a pointer to DateRange", () => {
    const r = parseRRule("FREQ=HOURLY");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("DateRange");
  });

  test("COUNT and UNTIL together are refused, as RFC 5545 requires", () => {
    expect(parseRRule("FREQ=DAILY;COUNT=5;UNTIL=20261231").ok).toBe(false);
  });

  test("a date-time UNTIL without Z is refused, as RFC 5545 s3.3.10 requires", () => {
    // Reading a floating local time as UTC would move the end of the series by
    // the caller's offset and say nothing about it.
    const r = parseRRule("FREQ=DAILY;UNTIL=20261231T235959");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("Z");
    expect(parseRRule("FREQ=DAILY;UNTIL=20261231T235959Z").ok).toBe(true);
    expect(parseRRule("FREQ=DAILY;UNTIL=20261231").ok).toBe(true);
  });

  test("malformed input is refused", () => {
    expect(parseRRule("").ok).toBe(false);
    expect(parseRRule("FREQ=DAILY;NONSENSE").ok).toBe(false);
    expect(parseRRule("FREQ=DAILY;INTERVAL=0").ok).toBe(false);
    expect(parseRRule("FREQ=DAILY;UNTIL=soon").ok).toBe(false);
  });
});

describe("recurrence: expansion", () => {
  const expand = (rule: string, start: string, limit = 10, zone = "UTC") => {
    const parsed = parseRRule(rule);
    if (!parsed.ok) throw new Error(parsed.error);
    const from = parseDateString(start, UTC);
    if (!from.ok) throw new Error(from.error);
    const r = expandRecurrence(from.epochMs, zone, parsed.parts, limit);
    return { ...r, dates: r.instants.map((ms) => isoDateFromEpochMs(ms, 0)) };
  };

  test("the start is the first occurrence", () => {
    expect(expand("FREQ=DAILY;COUNT=3", "2026-01-01").dates).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  test("INTERVAL spaces the occurrences", () => {
    expect(expand("FREQ=DAILY;INTERVAL=3;COUNT=3", "2026-01-01").dates).toEqual([
      "2026-01-01",
      "2026-01-04",
      "2026-01-07",
    ]);
  });

  test("WEEKLY with BYDAY expands inside each included week", () => {
    expect(expand("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4", "2026-09-14").dates).toEqual([
      "2026-09-14",
      "2026-09-16",
      "2026-09-28",
      "2026-09-30",
    ]);
  });

  test("DAILY with BYDAY filters days rather than expanding them", () => {
    expect(expand("FREQ=DAILY;BYDAY=SA,SU;COUNT=4", "2026-09-14").dates).toEqual([
      "2026-09-19",
      "2026-09-20",
      "2026-09-26",
      "2026-09-27",
    ]);
  });

  test("MONTHLY keeps the day of month and skips months that lack it", () => {
    const r = expand("FREQ=MONTHLY;COUNT=5", "2026-01-31");
    expect(r.dates).toEqual(["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31", "2026-08-31"]);
    expect(r.skippedInvalidDates).toEqual(["2026-02-31", "2026-04-31", "2026-06-31"]);
  });

  test("MONTHLY with BYDAY gives every such weekday in the month", () => {
    expect(expand("FREQ=MONTHLY;BYDAY=MO;COUNT=5", "2026-09-01").dates).toEqual([
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
    ]);
  });

  test("YEARLY on 29 February skips non-leap years", () => {
    expect(expand("FREQ=YEARLY;COUNT=2", "2024-02-29").dates).toEqual(["2024-02-29", "2028-02-29"]);
  });

  test("UNTIL bounds the series inclusively", () => {
    expect(expand("FREQ=DAILY;UNTIL=20260103", "2026-01-01").dates).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  test("the limit truncates a rule with no COUNT or UNTIL", () => {
    const r = expand("FREQ=DAILY", "2026-01-01", 4);
    expect(r.instants.length).toBe(4);
    expect(r.truncated).toBe(true);
  });

  test("a series that simply ends at the limit is not reported as truncated", () => {
    // truncated must mean "there is more", not "the count happened to match".
    const exact = expand("FREQ=DAILY;UNTIL=20260103", "2026-01-01", 3);
    expect({ n: exact.instants.length, truncated: exact.truncated }).toEqual({
      n: 3,
      truncated: false,
    });
    const counted = expand("FREQ=DAILY;COUNT=3", "2026-01-01", 3);
    expect({ n: counted.instants.length, truncated: counted.truncated }).toEqual({
      n: 3,
      truncated: false,
    });
    const cut = expand("FREQ=DAILY;UNTIL=20260110", "2026-01-01", 3);
    expect({ n: cut.instants.length, truncated: cut.truncated }).toEqual({ n: 3, truncated: true });
  });

  test("the occurrence walked past the limit leaves no trace in the result", () => {
    // The expander looks one occurrence ahead to know whether to say truncated;
    // that lookahead must not add its skipped date to the reported list.
    const r = expand("FREQ=MONTHLY;COUNT=5", "2026-01-31");
    expect(r.skippedInvalidDates).toEqual(["2026-02-31", "2026-04-31", "2026-06-31"]);
    const limited = expand("FREQ=MONTHLY", "2026-01-31", 2);
    expect(limited.dates).toEqual(["2026-01-31", "2026-03-31"]);
    expect(limited.skippedInvalidDates).toEqual(["2026-02-31"]);
  });

  test("occurrences keep the start's time of day", () => {
    const parsed = parseRRule("FREQ=DAILY;COUNT=2");
    if (!parsed.ok) throw new Error(parsed.error);
    const start = parseDateString("2026-01-01T09:30:00Z", UTC);
    if (!start.ok) throw new Error(start.error);
    const r = expandRecurrence(start.epochMs, "UTC", parsed.parts, 10);
    expect(r.instants.map((ms) => isoFromEpochMs(ms, 0))).toEqual([
      "2026-01-01T09:30:00Z",
      "2026-01-02T09:30:00Z",
    ]);
  });

  test("a daily rule across spring forward keeps the local time", () => {
    const parsed = parseRRule("FREQ=DAILY;COUNT=3");
    if (!parsed.ok) throw new Error(parsed.error);
    const start = parseDateString("2026-03-07T09:00:00-05:00", UTC);
    if (!start.ok) throw new Error(start.error);
    const r = expandRecurrence(start.epochMs, "America/New_York", parsed.parts, 10);
    for (const ms of r.instants) {
      expect(wallClockInZone(ms, "America/New_York").hour).toBe(9);
    }
  });
});
