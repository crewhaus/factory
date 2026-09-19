/**
 * Every tool this package registers, exercised through its own `execute`.
 *
 * Two things are checked for all of them, because they are the contract the
 * runtime relies on: the safety flags are what the tool contract expects for a
 * pure-compute tool, and the declared schema actually rejects bad input. After
 * that, each tool gets the behaviour tests that matter for it — including the
 * package's defining property, that nothing reads the clock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type HostZoneReading, _resetHostSeams, _setHostZone } from "./host";
import {
  DATETIME_TOOLS,
  businessDays,
  cronDescribe,
  cronNext,
  dateAdd,
  dateConvertTimezone,
  dateDiff,
  dateFormat,
  dateParse,
  dateRange,
  dayOfYear,
  durationFormat,
  durationParse,
  isLeapYear,
  localTime,
  quarterOf,
  recurrenceExpand,
  timestampConvert,
  weekOfYear,
} from "./index";

/** Tools return compact JSON; parse it so assertions read as data. */
// biome-ignore lint/suspicious/noExplicitAny: assertions read the parsed JSON shape directly.
async function run(tool: (typeof DATETIME_TOOLS)[number], input: unknown): Promise<any> {
  const out = await tool.execute(input);
  if (typeof out !== "string") throw new Error("expected a string result");
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

async function text(tool: (typeof DATETIME_TOOLS)[number], input: unknown): Promise<string> {
  return String(await tool.execute(input));
}

describe("package-wide contract", () => {
  test("every tool is exported in DATETIME_TOOLS", () => {
    expect(DATETIME_TOOLS.length).toBe(18);
  });

  test("names are unique", () => {
    const names = DATETIME_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("every tool is PascalCase", () => {
    for (const t of DATETIME_TOOLS) expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });

  test("every tool is read-only, non-destructive and internal — this package touches nothing", () => {
    for (const t of DATETIME_TOOLS) {
      expect({ name: t.name, readOnly: t.readOnly }).toEqual({ name: t.name, readOnly: true });
      expect({ name: t.name, destructive: t.destructive }).toEqual({
        name: t.name,
        destructive: false,
      });
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, sandbox: t.requiresSandbox }).toEqual({
        name: t.name,
        sandbox: false,
      });
    }
  });

  test("no tool declares an io capability, because none crosses a boundary", () => {
    for (const t of DATETIME_TOOLS) {
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
    }
  });

  test("every tool is concurrency-safe, since all are pure", () => {
    for (const t of DATETIME_TOOLS) {
      expect({ name: t.name, safe: t.concurrencySafe }).toEqual({ name: t.name, safe: true });
    }
  });

  test("every description says what it is for, not just what it is", () => {
    for (const t of DATETIME_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description).toContain("Use ");
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of DATETIME_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });

  test("an unrepresentable instant is a readable message, never a thrown RangeError", async () => {
    // The grammar accepts six-digit years, so "999999-01-01" is schema-valid
    // input that lands past what a date can hold. Every zone lookup below it
    // goes through Intl, which throws a bare "date value is not finite" —
    // useless to a caller and, through the executor, an error envelope rather
    // than an answer. Each of these has to come back as prose instead.
    const far = "999999-01-01";
    const calls: Record<string, unknown> = {
      BusinessDays: { mode: "count", start: far, end: far },
      CronNext: { expression: "@daily", after: far, timeZone: "Asia/Tokyo" },
      DateAdd: { instant: far },
      DateConvertTimezone: { instant: far, toTimeZone: "Asia/Tokyo" },
      DateDiff: { from: far, to: "2026-01-01" },
      DateFormat: { instant: far, timeZone: "Asia/Tokyo" },
      DateParse: { text: far, assumeTimeZone: "Asia/Tokyo" },
      DateRange: { start: far, end: far },
      DayOfYear: { date: far },
      IsLeapYear: { date: far },
      LocalTime: { instant: far, timeZone: "Asia/Tokyo" },
      QuarterOf: { date: far },
      RecurrenceExpand: { rule: "FREQ=DAILY", start: far },
      TimestampConvert: { value: 8.64e15 + 1, from: "millis" },
      WeekOfYear: { date: far },
    };
    for (const [name, input] of Object.entries(calls)) {
      const tool = DATETIME_TOOLS.find((t) => t.name === name);
      if (tool === undefined) throw new Error(`no tool named ${name}`);
      const out = await tool.execute(input);
      expect({ name, type: typeof out }).toEqual({ name, type: "string" });
      expect({ name, says: /range/.test(String(out)) }).toEqual({ name, says: true });
    }
  });

  test("an amount inside the schema that overflows the calendar is reported too", async () => {
    // years: 1_000_000 is inside the declared bounds and still walks off the
    // end of what a date can represent.
    for (const amounts of [{ years: 1_000_000 }, { years: -1_000_000 }]) {
      const out = await dateAdd.execute({
        instant: "2026-01-01",
        ...amounts,
        timeZone: "America/New_York",
      });
      expect({ amounts, says: /representable range/.test(String(out)) }).toEqual({
        amounts,
        says: true,
      });
    }
    // A fifth of that still lands inside the range and answers normally, so the
    // guard is about what a date can hold and not about refusing big numbers.
    const far = await run(dateAdd, { instant: "2026-01-01", years: 200_000 });
    expect(far.year).toBe(202_026);
  });

  test("the source reaches outside for nothing — no clock, no randomness, no I/O", async () => {
    // The package's whole premise. A reference time is always an input, and the
    // README promises no filesystem, no network and no randomness either, so
    // every one of those is asserted on the source rather than left to review.
    // A future addition that reaches outside has to edit this list on purpose.
    const files = [
      "index.ts",
      "lib/civil.ts",
      "lib/parse.ts",
      "lib/format.ts",
      "lib/arithmetic.ts",
      "lib/duration.ts",
      "lib/cron.ts",
      "lib/recurrence.ts",
    ];
    const banned: { what: string; pattern: RegExp }[] = [
      { what: "Date.now()", pattern: /Date\.now\s*\(/ },
      { what: "new Date() with no argument", pattern: /new Date\s*\(\s*\)/ },
      { what: "performance.now()", pattern: /performance\s*\.\s*now\s*\(/ },
      { what: "Math.random()", pattern: /Math\s*\.\s*random\s*\(/ },
      { what: "crypto", pattern: /\bcrypto\s*\./ },
      { what: "process.env or another process read", pattern: /\bprocess\s*\./ },
      { what: "fetch()", pattern: /(^|[^.\w])fetch\s*\(/m },
      { what: "a node: or fs import", pattern: /from\s*["'](?:node:|fs|path|child_process)/ },
      { what: "require()", pattern: /(^|[^.\w])require\s*\(/m },
      { what: "Bun.file or another host read", pattern: /\bBun\s*\./ },
    ];
    for (const file of files) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      // Strip block and line comments so prose about `Date.now()` — of which
      // this package has plenty — cannot trip or satisfy the check.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const { what, pattern } of banned) {
        expect({ file, reaches: what, hit: pattern.test(code) }).toEqual({
          file,
          reaches: what,
          hit: false,
        });
      }
    }
  });

  test("the host seam is the only file that reads the environment, and it reads two names", async () => {
    // `host.ts` is the deliberate exception to the test above: `LocalTime`
    // answers for the operator's zone, and that is a fact about the machine.
    // The exception is kept to one file and two variable names here, so it
    // cannot quietly widen into a clock, a home directory or a config read.
    const source = await Bun.file(new URL("host.ts", import.meta.url)).text();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const reads = [
      ...code.matchAll(/\bprocess\s*\.\s*(\w+)\s*(?:\.\s*(\w+)|\[\s*"(\w+)"\s*\])?/g),
    ].map((m) => `${m[1]}.${m[2] ?? m[3] ?? "*"}`);
    // A scanner that matched nothing would pass this vacuously; assert it hit.
    expect(reads.length).toBeGreaterThan(0);
    expect([...new Set(reads)].sort()).toEqual(["env.NODE_ENV", "env.TZ"]);

    for (const { what, pattern } of [
      { what: "Date.now()", pattern: /Date\.now\s*\(/ },
      { what: "new Date() with no argument", pattern: /new Date\s*\(\s*\)/ },
      { what: "Math.random()", pattern: /Math\s*\.\s*random\s*\(/ },
      { what: "fetch()", pattern: /(^|[^.\w])fetch\s*\(/m },
      { what: "a node: or fs import", pattern: /from\s*["'](?:node:|fs|path|child_process)/ },
      { what: "Bun.file or another host read", pattern: /\bBun\s*\./ },
    ]) {
      expect({ reaches: what, hit: pattern.test(code) }).toEqual({ reaches: what, hit: false });
    }
  });

  test("nothing under lib/ imports the host seam — the pure core stays pure", async () => {
    const libFiles = [
      "lib/civil.ts",
      "lib/parse.ts",
      "lib/format.ts",
      "lib/arithmetic.ts",
      "lib/duration.ts",
      "lib/cron.ts",
      "lib/recurrence.ts",
    ];
    let scanned = 0;
    for (const file of libFiles) {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      scanned += 1;
      expect({ file, importsHost: /from\s*["']\.\.\/host["']/.test(source) }).toEqual({
        file,
        importsHost: false,
      });
    }
    expect(scanned).toBe(libFiles.length);
  });
});

describe("DateParse", () => {
  test("an ISO instant comes back normalized with its components", async () => {
    const out = await run(dateParse, { text: "2026-09-17T14:30:00Z" });
    expect(out.ok).toBe(true);
    expect(out.utc).toBe("2026-09-17T14:30:00Z");
    expect(out.weekday).toBe("Thursday");
    expect(out.dayOfYear).toBe(260);
    expect(out.isoWeek).toBe(38);
  });

  test("an ambiguous numeric date is refused with both readings", async () => {
    const out = await run(dateParse, { text: "03/04/2026" });
    expect(out.ok).toBe(false);
    expect(out.ambiguous.interpretations).toHaveLength(2);
    expect(out.supportedFormats.length).toBeGreaterThan(4);
  });

  test("dateOrder settles it", async () => {
    const out = await run(dateParse, { text: "03/04/2026", dateOrder: "DMY" });
    expect(out.utc).toBe("2026-04-03T00:00:00Z");
  });

  test("assumeTimeZone anchors a bare date", async () => {
    const out = await run(dateParse, { text: "2026-06-15", assumeTimeZone: "Asia/Tokyo" });
    expect(out.utc).toBe("2026-06-14T15:00:00Z");
    expect(out.hadOffset).toBe(false);
  });

  test("an unknown timezone is a readable message, not a throw", async () => {
    expect(await text(dateParse, { text: "2026-01-01", assumeTimeZone: "Mars/Olympus" })).toContain(
      "not an IANA timezone",
    );
  });

  test("the schema rejects an empty string and a non-string", () => {
    expect(dateParse.inputSchema.safeParse({ text: "" }).success).toBe(false);
    expect(dateParse.inputSchema.safeParse({ text: 20260917 }).success).toBe(false);
  });
});

describe("DateFormat", () => {
  test("a pattern renders in the requested zone", async () => {
    expect(
      await text(dateFormat, {
        instant: "2026-09-17T14:30:00Z",
        pattern: "dddd, D MMMM YYYY [at] HH:mm Z",
        timeZone: "America/New_York",
      }),
    ).toBe("Thursday, 17 September 2026 at 10:30 -04:00");
  });

  test("presets are available by name", async () => {
    expect(await text(dateFormat, { instant: "2026-09-17T14:30:00Z", preset: "isoDate" })).toBe(
      "2026-09-17",
    );
    expect(await text(dateFormat, { instant: "2026-09-17T14:30:00Z", preset: "filename" })).toBe(
      "2026-09-17_14-30-00",
    );
  });

  test("with no pattern it falls back to ISO", async () => {
    expect(await text(dateFormat, { instant: "2026-09-17T14:30:00Z" })).toBe(
      "2026-09-17T14:30:00Z",
    );
  });

  test("listTokens returns the reference instead of a date", async () => {
    const out = await run(dateFormat, { instant: "2026-01-01", listTokens: true });
    expect(out.tokens.length).toBeGreaterThan(20);
    expect(out.presets.isoDate).toBe("YYYY-MM-DD");
  });

  test("an unreadable instant is reported, not thrown", async () => {
    expect(await text(dateFormat, { instant: "yesterday" })).toContain("could not read instant");
  });

  test("the schema rejects an unknown preset", () => {
    expect(
      dateFormat.inputSchema.safeParse({ instant: "2026-01-01", preset: "klingon" }).success,
    ).toBe(false);
  });
});

describe("DateConvertTimezone", () => {
  test("an instant moves between zones with the offsets that applied", async () => {
    const out = await run(dateConvertTimezone, {
      instant: "2026-01-15T12:00:00Z",
      toTimeZone: "Asia/Kolkata",
    });
    expect(out.to.local).toBe("2026-01-15T17:30:00+05:30");
    expect(out.to.offsetMinutes).toBe(330);
    expect(out.differenceHours).toBe(5.5);
  });

  test("the offset is the historic one, not today's", async () => {
    const winter = await run(dateConvertTimezone, {
      instant: "2026-01-15T12:00:00Z",
      toTimeZone: "America/New_York",
    });
    const summer = await run(dateConvertTimezone, {
      instant: "2026-07-15T12:00:00Z",
      toTimeZone: "America/New_York",
    });
    expect(winter.to.offsetMinutes).toBe(-300);
    expect(summer.to.offsetMinutes).toBe(-240);
  });

  test("fromTimeZone is used when the instant carries no offset", async () => {
    const out = await run(dateConvertTimezone, {
      instant: "2026-01-15T12:00:00",
      fromTimeZone: "Europe/Berlin",
      toTimeZone: "UTC",
    });
    expect(out.utc).toBe("2026-01-15T11:00:00Z");
  });

  test("an invalid target zone is reported", async () => {
    expect(
      await text(dateConvertTimezone, { instant: "2026-01-01", toTimeZone: "Middle/Earth" }),
    ).toContain("not an IANA timezone");
  });

  test("the schema requires a target zone", () => {
    expect(dateConvertTimezone.inputSchema.safeParse({ instant: "2026-01-01" }).success).toBe(
      false,
    );
  });
});

describe("DateAdd", () => {
  test("month-end clamping happens and is reported", async () => {
    const out = await run(dateAdd, { instant: "2026-01-31", months: 1 });
    expect(out.utc).toBe("2026-02-28T00:00:00Z");
    expect(out.notes.join(" ")).toContain("clamped");
  });

  test("negative amounts subtract", async () => {
    const out = await run(dateAdd, { instant: "2026-03-15", days: -20 });
    expect(out.utc).toBe("2026-02-23T00:00:00Z");
  });

  test("mixed units combine, calendar part first", async () => {
    const out = await run(dateAdd, { instant: "2026-01-01T00:00:00Z", months: 2, hours: 36 });
    expect(out.utc).toBe("2026-03-02T12:00:00Z");
  });

  test("a calendar day in a DST zone keeps the wall-clock time", async () => {
    const out = await run(dateAdd, {
      instant: "2026-03-07T09:00:00-05:00",
      days: 1,
      timeZone: "America/New_York",
    });
    expect(out.hour).toBe(9);
    expect(out.elapsedMilliseconds).toBe(23 * 3_600_000);
  });

  test("no amounts leaves the instant alone", async () => {
    const out = await run(dateAdd, { instant: "2026-01-01T00:00:00Z" });
    expect(out.utc).toBe("2026-01-01T00:00:00Z");
    expect(out.note).toContain("unchanged");
  });

  test("the schema rejects a fractional amount", () => {
    expect(dateAdd.inputSchema.safeParse({ instant: "2026-01-01", days: 1.5 }).success).toBe(false);
  });
});

describe("DateDiff", () => {
  test("the headline number comes back in the requested unit", async () => {
    const out = await run(dateDiff, { from: "2026-01-01", to: "2027-03-15", unit: "months" });
    expect(out.value).toBe(14);
    expect(out.breakdown).toEqual({
      years: 1,
      months: 2,
      days: 14,
      hours: 0,
      minutes: 0,
      seconds: 0,
      milliseconds: 0,
    });
  });

  test("a backwards difference is negative unless absolute is set", async () => {
    const backwards = await run(dateDiff, { from: "2026-03-01", to: "2026-01-01" });
    expect(backwards.value).toBe(-59);
    expect(backwards.direction).toBe("to is earlier");
    const absolute = await run(dateDiff, { from: "2026-03-01", to: "2026-01-01", absolute: true });
    expect(absolute.value).toBe(59);
    expect(absolute.totalSeconds).toBeGreaterThan(0);
  });

  test("elapsed days and calendar days differ, which is the point of the flag", async () => {
    const elapsed = await run(dateDiff, {
      from: "2026-01-01T23:00:00Z",
      to: "2026-01-02T01:00:00Z",
    });
    const calendar = await run(dateDiff, {
      from: "2026-01-01T23:00:00Z",
      to: "2026-01-02T01:00:00Z",
      calendar: true,
    });
    expect(elapsed.value).toBe(0);
    expect(calendar.value).toBe(1);
  });

  test("identical instants report zero and 'same'", async () => {
    const out = await run(dateDiff, { from: "2026-01-01", to: "2026-01-01" });
    expect(out.value).toBe(0);
    expect(out.direction).toBe("same");
  });

  test("an unreadable endpoint says which one", async () => {
    expect(await text(dateDiff, { from: "2026-01-01", to: "whenever" })).toContain(
      "could not read 'to'",
    );
  });

  test("the schema rejects an unknown unit", () => {
    expect(
      dateDiff.inputSchema.safeParse({ from: "2026-01-01", to: "2026-01-02", unit: "fortnights" })
        .success,
    ).toBe(false);
  });
});

describe("DurationParse", () => {
  test("shorthand becomes milliseconds", async () => {
    const out = await run(durationParse, { text: "2h30m" });
    expect(out.totalMilliseconds).toBe(9_000_000);
    expect(out.totalHours).toBe(2.5);
    expect(out.iso).toBe("PT2H30M");
  });

  test("ISO durations with years are parsed but flagged inexact", async () => {
    const out = await run(durationParse, { text: "P1Y2M3D" });
    expect(out.exact).toBe(false);
    expect(out.components.years).toBe(1);
    expect(out.notes.join(" ")).toContain("no fixed length");
  });

  test("clock form is recognized", async () => {
    const out = await run(durationParse, { text: "01:30:15" });
    expect(out.format).toBe("clock");
    expect(out.totalSeconds).toBe(5415);
  });

  test("an unknown unit comes back as a message with the accepted forms", async () => {
    const out = await run(durationParse, { text: "2 fortnights" });
    expect(out.ok).toBe(false);
    expect(out.accepts.length).toBe(3);
  });

  test("the schema rejects an empty string", () => {
    expect(durationParse.inputSchema.safeParse({ text: "" }).success).toBe(false);
  });
});

describe("DurationFormat", () => {
  test("seconds render as human text", async () => {
    expect(await text(durationFormat, { seconds: 5415, style: "long" })).toBe("1 hour 30 minutes");
    expect(await text(durationFormat, { seconds: 5415, style: "short" })).toBe("1h 30m");
  });

  test("a duration string can be re-rendered in another style", async () => {
    expect(await text(durationFormat, { duration: "2h30m", style: "iso" })).toBe("PT2H30M");
    expect(await text(durationFormat, { duration: "PT2H30M", style: "clock" })).toBe("02:30:00");
  });

  test("maxUnits trims the tail", async () => {
    expect(await text(durationFormat, { milliseconds: 90_061_000, maxUnits: 2 })).toBe("1d 1h");
    expect(await text(durationFormat, { milliseconds: 90_061_000, maxUnits: 4 })).toBe(
      "1d 1h 1m 1s",
    );
  });

  test("a duration with months is refused rather than approximated", async () => {
    expect(await text(durationFormat, { duration: "P1M" })).toContain("no fixed length");
  });

  test("an absurd magnitude is refused", async () => {
    expect(await text(durationFormat, { seconds: 1e12 })).toContain("1000 years");
  });

  test("the schema requires one of the three inputs", () => {
    expect(durationFormat.inputSchema.safeParse({ style: "short" }).success).toBe(false);
    expect(durationFormat.inputSchema.safeParse({ seconds: 60 }).success).toBe(true);
  });
});

describe("BusinessDays", () => {
  test("a working week counts five, inclusive of both ends", async () => {
    const out = await run(businessDays, { mode: "count", start: "2026-09-14", end: "2026-09-18" });
    expect(out.businessDays).toBe(5);
    expect(out.endInclusive).toBe(true);
  });

  test("holidays are excluded and counted", async () => {
    const out = await run(businessDays, {
      mode: "count",
      start: "2026-12-24",
      end: "2026-12-28",
      holidays: ["2026-12-25"],
    });
    expect(out.businessDays).toBe(2);
    expect(out.holidaysInRange).toBe(1);
  });

  test("a different weekend definition changes the answer", async () => {
    const out = await run(businessDays, {
      mode: "count",
      start: "2026-09-13",
      end: "2026-09-17",
      weekend: "fri-sat",
    });
    expect(out.businessDays).toBe(5);
    expect(out.weekend).toEqual([5, 6]);
  });

  test("adding one business day to a Friday lands on Monday", async () => {
    const out = await run(businessDays, { mode: "add", start: "2026-09-18", days: 1 });
    expect(out.result).toBe("2026-09-21");
    expect(out.weekday).toBe("Monday");
    expect(out.nonBusinessDaysSkipped).toBe(2);
  });

  test("a negative count walks back", async () => {
    const out = await run(businessDays, { mode: "add", start: "2026-09-21", days: -1 });
    expect(out.result).toBe("2026-09-18");
  });

  test("the missing companion field is reported per mode", async () => {
    expect(await text(businessDays, { mode: "count", start: "2026-01-01" })).toContain(
      "needs an 'end'",
    );
    expect(await text(businessDays, { mode: "add", start: "2026-01-01" })).toContain(
      "needs a 'days'",
    );
  });

  test("an unreadable holiday names itself", async () => {
    expect(
      await text(businessDays, {
        mode: "count",
        start: "2026-01-01",
        end: "2026-01-31",
        holidays: ["Boxing Day"],
      }),
    ).toContain("Boxing Day");
  });

  test("a seven-day weekend is refused", async () => {
    expect(
      await text(businessDays, {
        mode: "count",
        start: "2026-01-01",
        end: "2026-01-31",
        weekend: [0, 1, 2, 3, 4, 5, 6],
      }),
    ).toContain("no business days");
  });

  test("the schema rejects an unknown mode and an out-of-range weekday", () => {
    expect(businessDays.inputSchema.safeParse({ mode: "guess", start: "x" }).success).toBe(false);
    expect(
      businessDays.inputSchema.safeParse({ mode: "count", start: "x", weekend: [9] }).success,
    ).toBe(false);
  });
});

describe("DateRange", () => {
  test("a daily range lists dates", async () => {
    const out = await run(dateRange, { start: "2026-09-01", end: "2026-09-05" });
    expect(out.items).toEqual([
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
    ]);
  });

  test("monthly steps anchor on the start rather than drifting", async () => {
    const out = await run(dateRange, {
      start: "2026-01-31",
      end: "2026-04-30",
      stepUnit: "months",
    });
    expect(out.items).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  test("the cap truncates and says how to raise it", async () => {
    const out = await run(dateRange, { start: "2026-01-01", end: "2030-01-01", max: 3 });
    expect(out.count).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.note).toContain("cap of 3");
  });

  test("hourly steps in local format carry the offset", async () => {
    const out = await run(dateRange, {
      start: "2026-06-15T00:00:00Z",
      end: "2026-06-15T02:00:00Z",
      stepUnit: "hours",
      format: "local",
      timeZone: "America/New_York",
    });
    expect(out.items[0]).toBe("2026-06-14T20:00:00-04:00");
    expect(out.count).toBe(3);
  });

  test("a backwards range needs a negative step", async () => {
    expect(await text(dateRange, { start: "2026-01-05", end: "2026-01-01" })).toContain("negative");
  });

  test("the schema caps max", () => {
    expect(dateRange.inputSchema.safeParse({ start: "a", end: "b", max: 100_000 }).success).toBe(
      false,
    );
  });
});

describe("CronNext", () => {
  test("firings come from the reference time the caller supplied", async () => {
    const out = await run(cronNext, {
      expression: "*/15 9-17 * * 1-5",
      after: "2026-09-17T14:31:00Z",
      count: 3,
    });
    expect(out.firings.map((f: { utc: string }) => f.utc)).toEqual([
      "2026-09-17T14:45:00Z",
      "2026-09-17T15:00:00Z",
      "2026-09-17T15:15:00Z",
    ]);
  });

  test("the schedule runs on the zone's wall clock", async () => {
    const out = await run(cronNext, {
      expression: "0 9 * * *",
      after: "2026-07-01T00:00:00Z",
      count: 1,
      timeZone: "Europe/Berlin",
    });
    expect(out.firings[0].utc).toBe("2026-07-01T07:00:00Z");
    expect(out.firings[0].local).toBe("2026-07-01T09:00:00+02:00");
  });

  test("a DST gap skips the firing and reports it", async () => {
    const out = await run(cronNext, {
      expression: "30 2 * * *",
      after: "2026-03-06T00:00:00Z",
      count: 3,
      timeZone: "America/New_York",
    });
    expect(out.skippedForDst).toEqual(["2026-03-08T02:30"]);
  });

  test("an impossible schedule exhausts the horizon rather than hanging", async () => {
    const out = await run(cronNext, { expression: "0 0 30 2 *", after: "2026-01-01T00:00:00Z" });
    expect(out.firings).toEqual([]);
    expect(out.exhausted).toBe(true);
  });

  test("a bad expression comes back as a structured error", async () => {
    const out = await run(cronNext, { expression: "0 0 * *", after: "2026-01-01" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("expected 5");
  });

  test("the schema caps count and requires a reference time", () => {
    expect(cronNext.inputSchema.safeParse({ expression: "* * * * *" }).success).toBe(false);
    expect(
      cronNext.inputSchema.safeParse({ expression: "* * * * *", after: "x", count: 500 }).success,
    ).toBe(false);
  });
});

describe("CronDescribe", () => {
  test("a weekday business-hours schedule reads as English", async () => {
    const out = await run(cronDescribe, { expression: "*/15 9-17 * * 1-5" });
    expect(out.description).toContain("Every 15 minutes");
    expect(out.description).toContain("Monday through Friday");
  });

  test("the expanded field sets come back by default", async () => {
    const out = await run(cronDescribe, { expression: "0 0,12 * * *" });
    expect(out.fields.hours).toEqual([0, 12]);
    expect(out.fields.daysOfMonth).toBe("every");
  });

  test("includeFields false drops them", async () => {
    const out = await run(cronDescribe, { expression: "@daily", includeFields: false });
    expect(out.fields).toBeUndefined();
    expect(out.description).toBe("At 00:00, every day");
  });

  test("the day-of-month/day-of-week OR trap gets a warning", async () => {
    const out = await run(cronDescribe, { expression: "0 0 1 * MON" });
    expect(out.warning).toContain("EITHER");
  });

  test("an unsupported dialect extension is refused by name", async () => {
    const out = await run(cronDescribe, { expression: "0 0 L * *" });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("standard cron only");
  });

  test("the schema requires a non-empty expression", () => {
    expect(cronDescribe.inputSchema.safeParse({ expression: "" }).success).toBe(false);
  });
});

describe("RecurrenceExpand", () => {
  test("a fortnightly two-day rule expands from the start", async () => {
    const out = await run(recurrenceExpand, {
      rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4",
      start: "2026-09-14T09:00:00Z",
    });
    expect(out.occurrences).toEqual([
      "2026-09-14T09:00:00Z",
      "2026-09-16T09:00:00Z",
      "2026-09-28T09:00:00Z",
      "2026-09-30T09:00:00Z",
    ]);
  });

  test("a monthly rule on the 31st skips short months, per RFC 5545", async () => {
    const out = await run(recurrenceExpand, {
      rule: "FREQ=MONTHLY;COUNT=3",
      start: "2026-01-31T09:00:00Z",
      format: "date",
    });
    expect(out.occurrences).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    expect(out.skippedInvalidDates.length).toBe(2);
  });

  test("UNTIL bounds the series", async () => {
    const out = await run(recurrenceExpand, {
      rule: "FREQ=DAILY;UNTIL=20260103",
      start: "2026-01-01T09:00:00Z",
      format: "date",
    });
    expect(out.occurrences).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"]);
  });

  test("an unsupported part is refused by name, with the supported set", async () => {
    const out = await run(recurrenceExpand, {
      rule: "FREQ=MONTHLY;BYSETPOS=-1",
      start: "2026-01-01",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("BYSETPOS");
    expect(out.supported).toContain("BYDAY");
  });

  test("the limit truncates an unbounded rule", async () => {
    const out = await run(recurrenceExpand, { rule: "FREQ=DAILY", start: "2026-01-01", limit: 3 });
    expect(out.count).toBe(3);
    expect(out.truncated).toBe(true);
  });

  test("the schema caps the limit", () => {
    expect(
      recurrenceExpand.inputSchema.safeParse({ rule: "FREQ=DAILY", start: "x", limit: 99_999 })
        .success,
    ).toBe(false);
  });
});

describe("WeekOfYear", () => {
  test("ISO week and week-year can disagree with the calendar year", async () => {
    const out = await run(weekOfYear, { date: "2027-01-01" });
    expect(out.isoWeek).toBe(53);
    expect(out.isoWeekYear).toBe(2026);
    expect(out.isoLabel).toBe("2026-W53");
  });

  test("the week's bounds come back", async () => {
    const out = await run(weekOfYear, { date: "2026-09-17" });
    expect(out.weekStart).toBe("2026-09-14");
    expect(out.weekEnd).toBe("2026-09-20");
    expect(out.isoWeekday).toBe(4);
  });

  test("the simple scheme is shown alongside, and differs", async () => {
    const out = await run(weekOfYear, { date: "2021-01-01" });
    expect(out.isoWeek).toBe(53);
    expect(out.simpleWeek).toBe(1);
  });

  test("weekStartsOn changes only the simple scheme", async () => {
    const sunday = await run(weekOfYear, { date: "2026-09-17", weekStartsOn: 0 });
    expect(sunday.isoWeek).toBe(38);
    expect(sunday.simpleWeekStartsOn).toBe("Sunday");
  });

  test("an unreadable date is reported", async () => {
    expect(await text(weekOfYear, { date: "week 38" })).toContain("could not read 'date'");
  });

  test("the schema rejects an out-of-range weekStartsOn", () => {
    expect(weekOfYear.inputSchema.safeParse({ date: "2026-01-01", weekStartsOn: 7 }).success).toBe(
      false,
    );
  });
});

describe("DayOfYear", () => {
  test("a date gives its ordinal", async () => {
    const out = await run(dayOfYear, { date: "2026-09-17" });
    expect(out.dayOfYear).toBe(260);
    expect(out.daysRemaining).toBe(105);
    expect(out.ordinalDate).toBe("2026-260");
  });

  test("an ordinal gives back the date", async () => {
    const out = await run(dayOfYear, { year: 2026, ordinal: 260 });
    expect(out.date).toBe("2026-09-17");
  });

  test("a leap year has a 366th day and a common year does not", async () => {
    expect((await run(dayOfYear, { year: 2024, ordinal: 366 })).date).toBe("2024-12-31");
    expect(await text(dayOfYear, { year: 2026, ordinal: 366 })).toContain("does not exist");
  });

  test("the schema demands a date, or a year and an ordinal together", () => {
    expect(dayOfYear.inputSchema.safeParse({}).success).toBe(false);
    expect(dayOfYear.inputSchema.safeParse({ year: 2026 }).success).toBe(false);
    expect(dayOfYear.inputSchema.safeParse({ year: 2026, ordinal: 1 }).success).toBe(true);
    expect(dayOfYear.inputSchema.safeParse({ year: 2026, ordinal: 400 }).success).toBe(false);
  });
});

describe("IsLeapYear", () => {
  test("the century exceptions are right", async () => {
    expect((await run(isLeapYear, { year: 1900 })).isLeapYear).toBe(false);
    expect((await run(isLeapYear, { year: 2000 })).isLeapYear).toBe(true);
    expect((await run(isLeapYear, { year: 2024 })).isLeapYear).toBe(true);
  });

  test("the nearest leap years either side come back", async () => {
    const out = await run(isLeapYear, { year: 1900 });
    expect(out.nextLeapYear).toBe(1904);
    expect(out.previousLeapYear).toBe(1896);
    expect(out.daysInFebruary).toBe(28);
  });

  test("a date works as well as a year", async () => {
    const out = await run(isLeapYear, { date: "2024-06-15" });
    expect(out.year).toBe(2024);
    expect(out.daysInYear).toBe(366);
  });

  test("the schema demands a year or a date", () => {
    expect(isLeapYear.inputSchema.safeParse({}).success).toBe(false);
    expect(isLeapYear.inputSchema.safeParse({ year: 2026 }).success).toBe(true);
    expect(isLeapYear.inputSchema.safeParse({ year: 0 }).success).toBe(false);
  });
});

describe("QuarterOf", () => {
  test("calendar quarters with their bounds", async () => {
    const out = await run(quarterOf, { date: "2026-11-15" });
    expect(out.quarter).toBe(4);
    expect(out.label).toBe("2026-Q4");
    expect(out.quarterStart).toBe("2026-10-01");
    expect(out.quarterEnd).toBe("2026-12-31");
    expect(out.dayOfQuarter).toBe(46);
  });

  test("a fiscal year shifts the quarter and relabels it", async () => {
    const out = await run(quarterOf, { date: "2026-03-15", fiscalYearStartMonth: 2 });
    expect(out.quarter).toBe(1);
    expect(out.label).toBe("FY2027-Q1");
    expect(out.quarterStart).toBe("2026-02-01");
    expect(out.months).toEqual(["February", "March", "April"]);
  });

  test("a quarter spanning a year boundary still has contiguous bounds", async () => {
    const out = await run(quarterOf, { date: "2026-01-15", fiscalYearStartMonth: 11 });
    expect(out.quarterStart).toBe("2025-11-01");
    expect(out.quarterEnd).toBe("2026-01-31");
  });

  test("an unreadable date is reported", async () => {
    expect(await text(quarterOf, { date: "Q4" })).toContain("could not read 'date'");
  });

  test("the schema rejects a month outside 1-12", () => {
    expect(
      quarterOf.inputSchema.safeParse({ date: "2026-01-01", fiscalYearStartMonth: 13 }).success,
    ).toBe(false);
  });
});

describe("TimestampConvert", () => {
  test("seconds and milliseconds are told apart by magnitude", async () => {
    const seconds = await run(timestampConvert, { value: 1_789_655_400 });
    const millis = await run(timestampConvert, { value: 1_789_655_400_000 });
    expect(seconds.detectedUnit).toBe("seconds");
    expect(millis.detectedUnit).toBe("millis");
    expect(seconds.iso).toBe(millis.iso);
  });

  test("an explicit unit overrides the guess", async () => {
    const out = await run(timestampConvert, { value: 1_789_655_400, from: "millis" });
    expect(out.detectedUnit).toBe("millis");
    expect(out.iso).toBe("1970-01-21T17:07:35.400Z");
  });

  test("a date string converts the other way", async () => {
    const out = await run(timestampConvert, { value: "2026-09-17T14:30:00Z" });
    expect(out.seconds).toBe(1_789_655_400);
    expect(out.detectedUnit).toBe("iso");
  });

  test("a local rendering is included for the requested zone", async () => {
    const out = await run(timestampConvert, {
      value: 1_789_655_400,
      timeZone: "Asia/Kolkata",
    });
    expect(out.local).toBe("2026-09-17T20:00:00+05:30");
  });

  test("micros and nanos lose sub-millisecond precision, and say so", async () => {
    const out = await run(timestampConvert, { value: 1_789_655_400_123_456, from: "micros" });
    expect(out.iso).toBe("2026-09-17T14:30:00.123Z");
    expect(out.notes.join(" ")).toContain("precision dropped");
  });

  test("an out-of-range number and a non-date string are refused", async () => {
    expect(await text(timestampConvert, { value: 1e18, from: "millis" })).toContain("outside");
    expect(await text(timestampConvert, { value: "sometime", from: "iso" })).toContain(
      "could not read",
    );
  });

  test("the schema rejects a boolean and an unknown unit", () => {
    expect(timestampConvert.inputSchema.safeParse({ value: true }).success).toBe(false);
    expect(timestampConvert.inputSchema.safeParse({ value: 1, from: "fortnights" }).success).toBe(
      false,
    );
  });
});

describe("LocalTime", () => {
  // Not one test here learns anything about the machine it runs on. The zone
  // is either injected or passed, because the alternative is a suite that
  // takes one branch on the author's laptop (America/Los_Angeles) and another
  // on CI (UTC) — which is the bug this tool exists to make visible.
  afterEach(() => {
    _resetHostSeams();
  });

  const fixture = (timeZone: string, source: "env" | "system"): HostZoneReading => ({
    ok: true,
    timeZone,
    source,
    detail: `test fixture: ${source}`,
  });

  test("with nothing injected and no zone passed it refuses, and names the gate", async () => {
    // The hostile default: under `bun test` the un-injected read does not fall
    // through to the real machine. A forgotten seam fails identically on every
    // box instead of passing here and branching differently on CI.
    const out = await run(localTime, { instant: "2026-06-15T12:00:00Z" });
    expect(out.ok).toBe(false);
    expect(out.zoneSource).toBe("none");
    expect(out.reason).toContain("NODE_ENV=test");
    expect(out.remedy).toContain("timeZone");
    // And emphatically not a quiet UTC answer with the right shape.
    expect(out.at).toBeUndefined();
  });

  test("the zone and where it came from travel with the answer", async () => {
    _setHostZone({
      ok: true,
      timeZone: "Europe/Berlin",
      source: "env",
      detail: "the TZ environment variable, set to Europe/Berlin",
      tzEnv: "Europe/Berlin",
    });
    const out = await run(localTime, { instant: "2026-06-15T12:00:00Z" });
    expect(out.ok).toBe(true);
    expect({ zone: out.zone.timeZone, source: out.zone.source, tz: out.zone.tzEnv }).toEqual({
      zone: "Europe/Berlin",
      source: "env",
      tz: "Europe/Berlin",
    });
    expect(out.at.local).toBe("2026-06-15T14:00:00+02:00");
  });

  test("a TZ the runtime threw away is reported as the system zone, with the thrown-away value named", async () => {
    // Recorded on bun 1.3.14: TZ="EST5EDT,M3.2.0,M11.1.0" is legal POSIX, is
    // not an IANA id, and is silently replaced by the system zone. The
    // operator who set it gets someone else's timezone back and cannot tell
    // from the timestamps — so the answer has to say it.
    _setHostZone({
      ok: true,
      timeZone: "America/Los_Angeles",
      source: "system",
      detail:
        'the system zone (America/Los_Angeles); TZ is set to "EST5EDT,M3.2.0,M11.1.0", which is not an IANA zone this runtime knows, so the runtime ignored it',
      tzEnv: "EST5EDT,M3.2.0,M11.1.0",
    });
    const out = await run(localTime, { instant: "2026-06-15T12:00:00Z" });
    expect(out.zone.source).toBe("system");
    expect(out.zone.tzEnv).toBe("EST5EDT,M3.2.0,M11.1.0");
    expect(out.zone.detail).toContain("ignored it");
  });

  test("a caller-supplied zone wins and the host is not consulted at all", async () => {
    // The injected host would fail loudly if it were read; the answer is fine,
    // which is the proof that the override path never touches it.
    _setHostZone({ ok: false, source: "system", reason: "the host must not be read on this path" });
    const out = await run(localTime, {
      instant: "2026-06-15T12:00:00Z",
      timeZone: "Asia/Tokyo",
    });
    expect(out.ok).toBe(true);
    expect({ zone: out.zone.timeZone, source: out.zone.source }).toEqual({
      zone: "Asia/Tokyo",
      source: "override",
    });
  });

  test("an unreadable host zone names the reason — unreadable is not UTC", async () => {
    _setHostZone({
      ok: false,
      source: "system",
      reason: "this runtime's Intl did not resolve a default timezone",
    });
    const out = await run(localTime, { instant: "2026-06-15T12:00:00Z" });
    expect(out.ok).toBe(false);
    expect(out.zoneSource).toBe("system");
    expect(out.reason).toContain("did not resolve");
  });

  test("a host zone this runtime cannot format with is refused, not thrown", async () => {
    // An injected seam can hand back anything, so the zone that is about to be
    // used is validated here rather than trusted from wherever it came.
    _setHostZone(fixture("Mars/Olympus", "env"));
    const out = await run(localTime, { instant: "2026-06-15T12:00:00Z" });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain("not an IANA timezone");
  });

  test("midnight reads as hour 0 — the ICU 'hour 24' trap has no way in", async () => {
    // `Intl` with hour12:false renders midnight as "24" on some ICU builds
    // (durable-execution/src/schedule.ts carries the same note). Every clock
    // field here comes from the package's own formatter over an already-parsed
    // wall clock, so the trap cannot reach the output.
    const out = await run(localTime, {
      instant: "2026-06-15T04:00:00Z",
      timeZone: "America/New_York",
    });
    expect(out.at.hour).toBe(0);
    expect(out.clock).toContain("at 00:00");
  });

  test("clocks-forward is measured against the year's lowest offset, both hemispheres", async () => {
    const july = await run(localTime, {
      instant: "2026-07-15T12:00:00Z",
      timeZone: "America/New_York",
    });
    expect(july.clocksForward.aboveLowestByMinutes).toBe(60);
    expect(july.clocksForward.reading).toContain("clocks are forward");

    const january = await run(localTime, {
      instant: "2026-01-15T12:00:00Z",
      timeZone: "America/New_York",
    });
    expect(january.clocksForward.aboveLowestByMinutes).toBe(0);
    expect(january.clocksForward.reading).toContain("not forward");

    // Sydney in January is the case a January-versus-July shortcut gets
    // backwards: it is on its raised offset while New York is not.
    const sydney = await run(localTime, {
      instant: "2026-01-15T12:00:00Z",
      timeZone: "Australia/Sydney",
    });
    expect(sydney.clocksForward.aboveLowestByMinutes).toBe(60);
  });

  test("a zone with no seasonal change says so, and says how far it looked", async () => {
    const out = await run(localTime, {
      instant: "2026-03-07T12:00:00Z",
      timeZone: "Asia/Tokyo",
    });
    expect(out.clocksForward.zoneChangesOffsetInWindow).toBe(false);
    expect(out.nextOffsetChange.found).toBe(false);
    expect(out.nextOffsetChange.searchedDays).toBe(400);
    expect(out.nextOffsetChange.note).toContain("400 days");
  });

  test("the next clock change is reported to the minute, with both local readings", async () => {
    const out = await run(localTime, {
      instant: "2026-03-07T12:00:00Z",
      timeZone: "America/New_York",
    });
    expect(out.nextOffsetChange).toEqual({
      found: true,
      utc: "2026-03-08T07:00:00Z",
      localBefore: "2026-03-08T01:59:59.999-05:00",
      localAfter: "2026-03-08T03:00:00-04:00",
      fromOffsetMinutes: -300,
      toOffsetMinutes: -240,
      shiftMinutes: 60,
      direction: "forward",
      minutesAway: 1140,
    });
  });

  test("before-open, open, after-close and a non-working day are four answers, not two", async () => {
    const at = async (instant: string): Promise<string> =>
      (await run(localTime, { instant, timeZone: "Europe/Berlin" })).schedule.phase;
    expect(await at("2026-09-16T08:00:00")).toBe("before-open");
    expect(await at("2026-09-16T12:00:00")).toBe("open");
    expect(await at("2026-09-16T18:00:00")).toBe("after-close");
    expect(await at("2026-09-19T12:00:00")).toBe("non-working-day");
  });

  test("inside the window it says when it closes, not when it next opens", async () => {
    const out = await run(localTime, {
      instant: "2026-09-16T12:00:00",
      timeZone: "Europe/Berlin",
    });
    expect(out.schedule.closesAt.local).toBe("2026-09-16T17:00:00+02:00");
    expect(out.schedule.closesAt.minutesFromHere).toBe(300);
    expect(out.schedule.nextOpen).toBeUndefined();
  });

  test("after close on a Friday the next window opens on Monday", async () => {
    const out = await run(localTime, {
      instant: "2026-09-18T18:00:00",
      timeZone: "Europe/Berlin",
    });
    expect(out.schedule.nextOpen.local).toBe("2026-09-21T09:00:00+02:00");
    expect(out.schedule.nextOpen.minutesFromHere).toBe(3780);
  });

  test("a holiday on Monday moves the next window to Tuesday", async () => {
    const out = await run(localTime, {
      instant: "2026-09-18T18:00:00",
      timeZone: "Europe/Berlin",
      holidays: ["2026-09-21"],
    });
    expect(out.schedule.holidaysConsidered).toBe(1);
    expect(out.schedule.nextOpen.local).toBe("2026-09-22T09:00:00+02:00");
  });

  test("a weekend of 'none' makes Saturday a working day", async () => {
    const out = await run(localTime, {
      instant: "2026-09-19T12:00:00",
      timeZone: "Europe/Berlin",
      weekend: "none",
    });
    expect({ working: out.schedule.isWorkingDay, phase: out.schedule.phase }).toEqual({
      working: true,
      phase: "open",
    });
  });

  test("a window that opens inside a spring-forward gap says so rather than shifting quietly", async () => {
    // Havana springs forward at midnight, so 00:00 on 8 March 2026 is a wall
    // clock that does not exist. A shift starting at midnight there has to be
    // told, not silently moved to 01:00.
    const out = await run(localTime, {
      instant: "2026-03-07T20:00:00",
      timeZone: "America/Havana",
      businessHours: { start: "00:00", end: "08:00" },
      weekend: "none",
    });
    expect(out.schedule.phase).toBe("after-close");
    expect(out.schedule.nextOpen.wallClockResolution).toBe("nonexistent");
    expect(out.schedule.nextOpen.resolutionNote).toContain("sprang forward");
    expect(out.schedule.nextOpen.local).toBe("2026-03-08T01:00:00-04:00");
  });

  test("a working window past the end of the calendar is a reason, not a fabricated date", async () => {
    // 275760-09-13 is the last instant a date can hold. The next working
    // window after it is two days later, which nothing can represent — and
    // `isoFromEpochMs` is pure arithmetic, so it would have rendered that
    // without complaint. Found by walking the boundary, not by review.
    const out = await run(localTime, { instant: "275760-09-13T00:00:00Z", timeZone: "UTC" });
    expect(out.ok).toBe(true);
    expect(out.schedule.nextOpen.determined).toBe(false);
    expect(out.schedule.nextOpen.reason).toContain("representable range");
    expect(out.schedule.nextOpen.local).toBeUndefined();
  });

  test("an overnight window is refused by name, not wrapped around midnight", async () => {
    const out = await text(localTime, {
      instant: "2026-09-16T12:00:00",
      timeZone: "Europe/Berlin",
      businessHours: { start: "22:00", end: "06:00" },
    });
    expect(out).toContain("overnight window is not supported");
  });

  test("a business hour that is not HH:MM names the field and the spelling wanted", async () => {
    for (const bad of [
      { start: "9am", end: "17:00" },
      { start: "09:00", end: "24:00" },
    ]) {
      const out = await text(localTime, {
        instant: "2026-09-16T12:00:00",
        timeZone: "Europe/Berlin",
        businessHours: bad,
      });
      expect({ bad, says: /must be written HH:MM/.test(out) }).toEqual({ bad, says: true });
    }
  });

  test("every weekday marked as weekend is refused rather than searched forever", async () => {
    expect(
      await text(localTime, {
        instant: "2026-09-16T12:00:00",
        timeZone: "Europe/Berlin",
        weekend: [0, 1, 2, 3, 4, 5, 6],
      }),
    ).toContain("no working window");
  });

  test("the cron block runs on the operator's clock across a DST boundary", async () => {
    const out = await run(localTime, {
      instant: "2026-03-07T12:00:00Z",
      timeZone: "America/New_York",
      cron: "0 9 * * *",
      cronCount: 2,
    });
    expect(out.cron.firings.map((f: { local: string }) => f.local)).toEqual([
      "2026-03-07T09:00:00-05:00",
      "2026-03-08T09:00:00-04:00",
    ]);
    // 23 hours apart in real time, because the clocks moved between them.
    expect(out.cron.firings[1].minutesAway - out.cron.firings[0].minutesAway).toBe(23 * 60);
  });

  test("a bad cron expression is a readable result, not an exception", async () => {
    const out = await run(localTime, {
      instant: "2026-03-07T12:00:00Z",
      timeZone: "America/New_York",
      cron: "not a cron",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("cron:");
  });

  test("the same instant elsewhere carries the difference and whether the date has turned", async () => {
    const out = await run(localTime, {
      instant: "2026-03-07T20:30:00Z",
      timeZone: "America/New_York",
      compareTimeZones: ["Asia/Tokyo", "Europe/Berlin"],
    });
    expect(out.elsewhere[0]).toEqual({
      timeZone: "Asia/Tokyo",
      local: "2026-03-08T05:30:00+09:00",
      offset: "+09:00",
      offsetMinutes: 540,
      abbreviation: "GMT+9",
      differenceMinutes: 840,
      differenceHours: 14,
      sameCalendarDay: false,
    });
    expect(out.elsewhere[1].sameCalendarDay).toBe(true);
  });

  test("an unknown zone in compareTimeZones is named, not skipped", async () => {
    expect(
      await text(localTime, {
        instant: "2026-03-07T20:30:00Z",
        timeZone: "America/New_York",
        compareTimeZones: ["Asia/Tokyo", "Mars/Olympus"],
      }),
    ).toContain("not an IANA timezone");
  });

  test("the schema rejects a missing instant, too many zones and a zero cron count", () => {
    expect(localTime.inputSchema.safeParse({}).success).toBe(false);
    expect(localTime.inputSchema.safeParse({ instant: "" }).success).toBe(false);
    expect(
      localTime.inputSchema.safeParse({
        instant: "2026-01-01",
        compareTimeZones: Array.from({ length: 13 }, () => "UTC"),
      }).success,
    ).toBe(false);
    expect(localTime.inputSchema.safeParse({ instant: "2026-01-01", cronCount: 0 }).success).toBe(
      false,
    );
  });

  // ── the answers a fall-back repeat used to get wrong ──────────────────────
  // New York falls back on 2026-11-01 at 06:00Z: 02:00 EDT becomes 01:00 EST,
  // so every wall clock from 01:00 to 01:59 happens twice. `resolveWallClock`
  // returns the earlier of the two by the package's rule, which is right for
  // reading a timestamp and wrong for "when does the window open/close" — at
  // 01:30 EST, the second pass, the earlier instant has already gone by.

  test("a window closing inside a fall-back repeat closes ahead of here, not behind it", async () => {
    const out = await run(localTime, {
      // 06:30Z is 01:30 EST — the SECOND pass of that clock.
      instant: "2026-11-01T06:30:00Z",
      timeZone: "America/New_York",
      weekend: "none",
      businessHours: { start: "01:00", end: "01:45" },
    });
    expect(out.schedule.phase).toBe("open");
    expect(out.schedule.closesAt.utc).toBe("2026-11-01T06:45:00Z");
    expect(out.schedule.closesAt.minutesFromHere).toBe(15);
    expect(out.schedule.closesAt.wallClockResolution).toBe("ambiguous");
    expect(out.schedule.closesAt.resolutionNote).toContain("second one is used");
  });

  test("a window opening inside a fall-back repeat opens ahead of here too", async () => {
    const out = await run(localTime, {
      // 06:05Z is 01:05 EST, five minutes into the repeated hour's second pass.
      instant: "2026-11-01T06:05:00Z",
      timeZone: "America/New_York",
      weekend: "none",
      businessHours: { start: "01:30", end: "23:00" },
    });
    expect(out.schedule.phase).toBe("before-open");
    expect(out.schedule.nextOpen.utc).toBe("2026-11-01T06:30:00Z");
    expect(out.schedule.nextOpen.minutesFromHere).toBe(25);
  });

  test("the first pass of a repeated hour still takes the first instant", async () => {
    // The fix must not reach cases it was not for: at 01:30 EDT — the first
    // pass — the 01:45 close is the EDT one, fifteen minutes away, and the
    // note still says the earlier instant was used.
    const out = await run(localTime, {
      instant: "2026-11-01T05:30:00Z",
      timeZone: "America/New_York",
      weekend: "none",
      businessHours: { start: "01:00", end: "01:45" },
    });
    expect(out.schedule.closesAt.utc).toBe("2026-11-01T05:45:00Z");
    expect(out.schedule.closesAt.minutesFromHere).toBe(15);
    expect(out.schedule.closesAt.resolutionNote).toContain("earlier instant is used");
  });

  test("no working window this tool reports is ever already in the past", async () => {
    // The property behind the two tests above, stated once across the whole
    // of a fall-back morning rather than at the two instants that happened
    // to break. Each call probes a year of offsets through Intl, so the
    // budget is generous: CI is a loaded two-core box, and the cost here is
    // 60 tool calls, not a stopwatch reading.
    for (const zone of ["America/New_York", "America/Havana", "Australia/Lord_Howe"]) {
      for (let minutes = 0; minutes <= 285; minutes += 15) {
        const instant = new Date(Date.UTC(2026, 10, 1, 4, 0) + minutes * 60_000).toISOString();
        const out = await run(localTime, {
          instant,
          timeZone: zone,
          weekend: "none",
          businessHours: { start: "00:30", end: "23:30" },
        });
        const window = out.schedule.closesAt ?? out.schedule.nextOpen;
        if (window.determined === false) continue;
        expect({ zone, instant, ahead: window.minutesFromHere >= 0 }).toEqual({
          zone,
          instant,
          ahead: true,
        });
      }
    }
  }, 30_000);

  // ── a morning that is not a working morning ───────────────────────────────

  test("a Saturday morning opens on Monday, not at nine o'clock that Saturday", async () => {
    // Before the window's start hour on a day that is not worked at all: the
    // "today, at opening time" shortcut only applies when today is a working
    // day, and nothing else in this file was early enough in the day to tell.
    const out = await run(localTime, {
      instant: "2026-09-19T08:00:00",
      timeZone: "Europe/Berlin",
    });
    expect(out.schedule.phase).toBe("non-working-day");
    expect(out.schedule.nextOpen.local).toBe("2026-09-21T09:00:00+02:00");
  });

  test("a holiday morning opens on the next working day, not later the same morning", async () => {
    const out = await run(localTime, {
      instant: "2026-09-21T08:00:00",
      timeZone: "Europe/Berlin",
      holidays: ["2026-09-21"],
    });
    expect(out.schedule.nextOpen.local).toBe("2026-09-22T09:00:00+02:00");
  });

  test("the window is closed at its closing minute, not still open", async () => {
    const phase = async (instant: string): Promise<string> =>
      (await run(localTime, { instant, timeZone: "Europe/Berlin" })).schedule.phase;
    expect(await phase("2026-09-16T16:59:00")).toBe("open");
    expect(await phase("2026-09-16T17:00:00")).toBe("after-close");
    // And the opening minute is inside it, so the two boundaries are not the
    // same rule written twice.
    expect(await phase("2026-09-16T08:59:00")).toBe("before-open");
    expect(await phase("2026-09-16T09:00:00")).toBe("open");
  });

  test("a window that starts and ends at the same minute is refused, not silently empty", async () => {
    // Zero minutes long is not a working window; accepting it would make
    // `phase` unable to return "open" while nothing said why.
    const out = await text(localTime, {
      instant: "2026-09-16T12:00:00",
      timeZone: "Europe/Berlin",
      businessHours: { start: "09:00", end: "09:00" },
    });
    expect(out).toContain("must be later in the day");
  });

  test("the default window says it is the default, and a supplied one says that", async () => {
    const byDefault = await run(localTime, {
      instant: "2026-09-16T12:00:00",
      timeZone: "Europe/Berlin",
    });
    expect(byDefault.schedule.businessHours).toEqual({
      start: "09:00",
      end: "17:00",
      source: "default 09:00-17:00",
    });
    const supplied = await run(localTime, {
      instant: "2026-09-16T12:00:00",
      timeZone: "Europe/Berlin",
      businessHours: { start: "08:30", end: "16:30" },
    });
    expect(supplied.schedule.businessHours).toEqual({
      start: "08:30",
      end: "16:30",
      source: "caller-supplied",
    });
  });

  test("a holiday is the calendar date in the answering zone, as it is for BusinessDays", async () => {
    // 01:00 on Monday in Berlin is still Sunday in UTC. Reading the holiday
    // list in the wrong zone would move this one off the Monday it names and
    // leave Monday worked — and would quietly disagree with BusinessDays,
    // which the README promises it cannot.
    const holiday = "2026-09-21T01:00:00+02:00";
    const out = await run(localTime, {
      instant: "2026-09-18T18:00:00",
      timeZone: "Europe/Berlin",
      holidays: [holiday],
    });
    expect(out.schedule.nextOpen.local).toBe("2026-09-22T09:00:00+02:00");
    const viaBusinessDays = await run(businessDays, {
      mode: "add",
      start: "2026-09-18",
      days: 1,
      holidays: [holiday],
      timeZone: "Europe/Berlin",
    });
    expect(viaBusinessDays.result).toBe("2026-09-22");
  });

  test("holidaysConsidered counts what BusinessDays counts under that name", async () => {
    // Same field name in two tools documented to share a calendar. One of them
    // counting entries while the other counted distinct days is exactly how a
    // shared rule becomes two rules.
    const input = {
      holidays: ["2026-09-21", "2026-09-21T10:00:00", "2026-12-25"],
      timeZone: "Europe/Berlin",
    };
    const here = await run(localTime, { instant: "2026-09-18T18:00:00", ...input });
    const there = await run(businessDays, {
      mode: "count",
      start: "2026-09-18",
      end: "2026-12-31",
      ...input,
    });
    expect(here.schedule.holidaysConsidered).toBe(there.holidaysConsidered);
    expect(here.schedule.holidaysConsidered).toBe(3);
  });

  // ── what the clocks-forward reading may and may not claim ─────────────────

  test("a fall-back is reported as a step back, with a negative shift", async () => {
    // The spring-forward case is covered above; without this one the direction
    // and the sign of the shift could both be constants and nothing would say.
    const out = await run(localTime, {
      instant: "2026-10-30T12:00:00Z",
      timeZone: "America/New_York",
    });
    expect({
      direction: out.nextOffsetChange.direction,
      shift: out.nextOffsetChange.shiftMinutes,
      utc: out.nextOffsetChange.utc,
    }).toEqual({ direction: "back", shift: -60, utc: "2026-11-01T06:00:00Z" });
  });

  test("a zone that moved its offset for good is not called a clock change", async () => {
    // Volgograd had no DST at all in 2020: it sat on UTC+4 and dropped to
    // UTC+3 on 27 December and stayed. "Higher than the lowest offset seen"
    // is true and "the clocks are forward" is not, so the reading has to
    // separate a zone that came back from one that did not.
    const out = await run(localTime, {
      instant: "2020-11-01T12:00:00Z",
      timeZone: "Europe/Volgograd",
    });
    expect(out.clocksForward.offsetChangesInWindow).toBe(1);
    expect(out.clocksForward.wentBackDown).toBe(false);
    expect(out.clocksForward.reading).toContain("redefining its offset");
    expect(out.clocksForward.reading).not.toContain("the clocks are forward");
    // New York in July is the case that may say it.
    const newYork = await run(localTime, {
      instant: "2026-07-15T12:00:00Z",
      timeZone: "America/New_York",
    });
    expect({
      changes: newYork.clocksForward.offsetChangesInWindow,
      back: newYork.clocksForward.wentBackDown,
    }).toEqual({ changes: 2, back: true });
    expect(newYork.clocksForward.reading).toContain("the clocks are forward");
  });

  test("a window the calendar cut short says so beside the reading", async () => {
    // At the last representable instant there is no forward half to probe, so
    // "no seasonal clock change near this date" rests on half the evidence it
    // claims. The claim stays; the shortfall is printed with it.
    const out = await run(localTime, {
      instant: "275760-09-13T00:00:00Z",
      timeZone: "America/New_York",
    });
    expect(out.clocksForward.determined).toBe(true);
    expect(out.clocksForward.window.truncated).toBe(true);
    expect(out.clocksForward.window.truncationNote).toContain("cut this window short");
    // An ordinary date says nothing of the sort.
    const ordinary = await run(localTime, {
      instant: "2026-07-15T12:00:00Z",
      timeZone: "America/New_York",
    });
    expect(ordinary.clocksForward.window.truncated).toBeUndefined();
  });

  test("a cron that can never fire says why, as CronNext does", async () => {
    // `exhausted: true` beside an empty firings list is a search that ran out,
    // not a schedule that never fires, and the two need telling apart.
    const out = await run(localTime, {
      instant: "2026-03-07T12:00:00Z",
      timeZone: "America/New_York",
      cron: "0 0 30 2 *",
    });
    expect(out.cron.firings).toEqual([]);
    expect(out.cron.exhausted).toBe(true);
    expect(out.cron.note).toContain("can never fire");
    const viaCronNext = await run(cronNext, {
      expression: "0 0 30 2 *",
      after: "2026-03-07T12:00:00Z",
      timeZone: "America/New_York",
    });
    expect(out.cron.note).toBe(viaCronNext.note);
  });
});
