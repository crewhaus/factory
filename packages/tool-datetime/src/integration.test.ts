/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the runtime
 * cannot actually use, which is why this file exists separately.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { _allowRealHost, _resetHostSeams, _setHostZone, readHostZone, realHostZone } from "./host";
import { DATETIME_TOOLS } from "./index";
import { isValidTimeZone } from "./lib/civil";

let catalog: ToolCatalog;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of DATETIME_TOOLS) catalog.register(tool);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(DATETIME_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of DATETIME_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("DateParse"),
      { text: "2026-09-17T14:30:00Z" },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2026-09-17T14:30:00Z");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(lookup("DateParse"), { text: 42 }, { toolUseId: "t2" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("DateParse");
  });

  test("a missing required field is rejected", async () => {
    const result = await executeTool(
      lookup("DateDiff"),
      { from: "2026-01-01" },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
  });

  test("a refine-level constraint is enforced by the runtime too", async () => {
    const result = await executeTool(
      lookup("DurationFormat"),
      { style: "short" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
  });

  test("permission patterns gate the call", async () => {
    const denied = await executeTool(
      lookup("IsLeapYear"),
      { year: 2026 },
      { toolUseId: "t5", allowedPatterns: ["Read"] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not permitted");
  });

  test("an explicit allow lets it through", async () => {
    const allowed = await executeTool(
      lookup("IsLeapYear"),
      { year: 2026 },
      { toolUseId: "t6", allowedPatterns: ["IsLeapYear"] },
    );
    expect(allowed.isError).toBe(false);
  });

  test("every tool survives a schema-valid call — none throws out of execute", async () => {
    const calls: Record<string, unknown> = {
      BusinessDays: { mode: "count", start: "2026-09-14", end: "2026-09-18" },
      CronDescribe: { expression: "0 9 * * 1-5" },
      CronNext: { expression: "0 9 * * 1-5", after: "2026-09-17T00:00:00Z" },
      DateAdd: { instant: "2026-01-31", months: 1 },
      DateConvertTimezone: { instant: "2026-01-15T12:00:00Z", toTimeZone: "Asia/Tokyo" },
      DateDiff: { from: "2026-01-01", to: "2026-03-01" },
      DateFormat: { instant: "2026-09-17T14:30:00Z", preset: "isoDate" },
      DateParse: { text: "2026-09-17" },
      DateRange: { start: "2026-09-01", end: "2026-09-05" },
      DayOfYear: { date: "2026-09-17" },
      DurationFormat: { seconds: 5415 },
      DurationParse: { text: "2h30m" },
      IsLeapYear: { year: 2026 },
      LocalTime: { instant: "2026-09-17T14:30:00Z", timeZone: "Europe/Berlin" },
      QuarterOf: { date: "2026-11-15" },
      RecurrenceExpand: { rule: "FREQ=DAILY;COUNT=3", start: "2026-01-01T09:00:00Z" },
      TimestampConvert: { value: 1_789_655_400 },
      WeekOfYear: { date: "2026-09-17" },
    };
    // Every registered tool must appear above; a new tool without a call here
    // would otherwise go unexercised.
    expect(Object.keys(calls).sort()).toEqual(DATETIME_TOOLS.map((t) => t.name).sort());
    for (const tool of DATETIME_TOOLS) {
      const result = await executeTool(tool, calls[tool.name], { toolUseId: `x-${tool.name}` });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
      expect({ name: tool.name, empty: result.content === "" }).toEqual({
        name: tool.name,
        empty: false,
      });
    }
  });

  test("results are deterministic — the same call twice gives the same bytes", async () => {
    const args = { expression: "*/15 9-17 * * 1-5", after: "2026-09-17T14:31:00Z", count: 4 };
    const a = await executeTool(lookup("CronNext"), args, { toolUseId: "d1" });
    const b = await executeTool(lookup("CronNext"), args, { toolUseId: "d2" });
    expect(a.content).toBe(b.content);
  });

  test("no result depends on when it ran — every tool is called twice with a gap", async () => {
    // The package's premise, checked end to end: identical bytes across calls
    // separated in real time, for every tool that could plausibly want a clock.
    const clockCurious: Record<string, unknown> = {
      BusinessDays: { mode: "add", start: "2026-09-18", days: 3 },
      CronNext: { expression: "@daily", after: "2026-09-17T14:31:00Z" },
      DateAdd: { instant: "2026-01-31", months: 1 },
      DateDiff: { from: "2026-01-01", to: "2026-03-01" },
      DateRange: { start: "2026-09-01", end: "2026-09-05" },
      LocalTime: { instant: "2026-09-17T14:30:00Z", timeZone: "Europe/Berlin" },
      RecurrenceExpand: { rule: "FREQ=WEEKLY;COUNT=5", start: "2026-01-01T09:00:00Z" },
      TimestampConvert: { value: "2026-09-17T14:30:00Z" },
    };
    const first = new Map<string, string>();
    for (const [name, args] of Object.entries(clockCurious)) {
      first.set(name, (await executeTool(lookup(name), args, { toolUseId: `a-${name}` })).content);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (const [name, args] of Object.entries(clockCurious)) {
      const again = await executeTool(lookup(name), args, { toolUseId: `b-${name}` });
      expect({ name, same: again.content === first.get(name) }).toEqual({ name, same: true });
    }
  });

  test("a caller mistake comes back as a readable result, not an error envelope", async () => {
    // Bad data is the caller's problem to read, so it is a normal result; a bad
    // *shape* is the schema's problem and is an error. Both are checked here.
    const badData = await executeTool(
      lookup("CronNext"),
      { expression: "not a cron", after: "2026-01-01" },
      { toolUseId: "e1" },
    );
    expect(badData.isError).toBe(false);
    expect(badData.content).toContain("error");

    const badShape = await executeTool(
      lookup("CronNext"),
      { expression: "* * * * *", after: "2026-01-01", count: -1 },
      { toolUseId: "e2" },
    );
    expect(badShape.isError).toBe(true);
  });

  test("the tools compose: parse, add, then format the result", async () => {
    const parsed = await executeTool(
      lookup("DateParse"),
      { text: "31 January 2026" },
      { toolUseId: "c1" },
    );
    const { utc } = JSON.parse(parsed.content) as { utc: string };
    const added = await executeTool(
      lookup("DateAdd"),
      { instant: utc, months: 1 },
      { toolUseId: "c2" },
    );
    const moved = (JSON.parse(added.content) as { utc: string }).utc;
    const formatted = await executeTool(
      lookup("DateFormat"),
      { instant: moved, pattern: "D MMMM YYYY" },
      { toolUseId: "c3" },
    );
    expect(formatted.content).toBe("28 February 2026");
  });
});

/**
 * The one place in this package allowed near the real machine.
 *
 * `LocalTime` answers for the operator's zone, so somebody has to check that
 * the un-injected path really does read the host — otherwise the hostile
 * default in `host.ts` would be indistinguishable from a package that refuses
 * everywhere. Every assertion below holds for any zone any box could be set
 * to: nothing here asserts a particular timezone, because the author's laptop
 * and CI are not in the same one.
 */
describe("the host zone seam, against the real machine", () => {
  afterEach(() => {
    _resetHostSeams();
  });

  test("the un-injected read is gated off under bun test, and names the gate", () => {
    const reading = readHostZone();
    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error("unreachable");
    expect({ source: reading.source, says: /NODE_ENV=test/.test(reading.reason) }).toEqual({
      source: "none",
      says: true,
    });
  });

  test("with the gate opened it reads the machine, and says which source it used", () => {
    try {
      _allowRealHost(true);
      const reading = readHostZone();
      if (!reading.ok) {
        // A runtime with no tzdata is a legitimate answer here, but it has to
        // arrive as a reason rather than as a zone nobody checked.
        expect(reading.reason.length).toBeGreaterThan(20);
        return;
      }
      expect(["env", "system"]).toContain(reading.source);
      expect(isValidTimeZone(reading.timeZone)).toBe(true);
      expect(reading.detail.length).toBeGreaterThan(10);
    } finally {
      _allowRealHost(false);
    }
  });

  test("an injected zone wins over the machine even with the gate open", () => {
    try {
      _allowRealHost(true);
      _setHostZone({ ok: true, timeZone: "Pacific/Chatham", source: "env", detail: "fixture" });
      const reading = readHostZone();
      expect(reading.ok && reading.timeZone).toBe("Pacific/Chatham");
    } finally {
      _allowRealHost(false);
      _setHostZone(undefined);
    }
  });

  test("TZ is believed when it names a zone, and named when it does not", () => {
    // The only test that touches the environment. It sets TZ itself and puts
    // it back, and asserts nothing about what the box underneath is set to —
    // the properties below hold for every possible system zone.
    const before = process.env["TZ"];
    try {
      process.env["TZ"] = "Asia/Kolkata";
      const believed = realHostZone();
      expect(believed.ok && { zone: believed.timeZone, source: believed.source }).toEqual({
        zone: "Asia/Kolkata",
        source: "env",
      });

      // Legal POSIX, not an IANA identifier: the runtime discards it silently
      // and uses the system zone. The discarded value has to survive into the
      // answer, because the operator who set it cannot tell from the clock.
      process.env["TZ"] = "EST5EDT,M3.2.0,M11.1.0";
      const ignored = realHostZone();
      if (!ignored.ok) {
        expect(ignored.tzEnv).toBe("EST5EDT,M3.2.0,M11.1.0");
        return;
      }
      expect({
        source: ignored.source,
        tz: ignored.tzEnv,
        usable: isValidTimeZone(ignored.timeZone),
        kept: ignored.timeZone === "EST5EDT,M3.2.0,M11.1.0",
      }).toEqual({
        source: "system",
        tz: "EST5EDT,M3.2.0,M11.1.0",
        usable: true,
        kept: false,
      });
      expect(ignored.detail).toContain("ignored it");
    } finally {
      // `Reflect.deleteProperty`, not `delete` (biome's noDelete) and
      // emphatically not `= undefined`, which writes the literal string
      // "undefined" into TZ and leaves every later test in this process
      // holding a timezone the runtime will silently discard.
      if (before === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env["TZ"] = before;
    }
  });

  test("an empty TZ is not a zone — it falls through to the system one", () => {
    const before = process.env["TZ"];
    try {
      process.env["TZ"] = "   ";
      const reading = realHostZone();
      if (!reading.ok) {
        expect(reading.source).toBe("system");
        return;
      }
      expect(reading.source).toBe("system");
      expect(reading.tzEnv).toBeUndefined();
    } finally {
      // `Reflect.deleteProperty`, not `delete` (biome's noDelete) and
      // emphatically not `= undefined`, which writes the literal string
      // "undefined" into TZ and leaves every later test in this process
      // holding a timezone the runtime will silently discard.
      if (before === undefined) Reflect.deleteProperty(process.env, "TZ");
      else process.env["TZ"] = before;
    }
  });

  test("LocalTime through the runtime reports the zone it actually used", async () => {
    const catalogTool = catalog.get("LocalTime");
    if (!catalogTool) throw new Error("expected LocalTime to be registered");
    try {
      _allowRealHost(true);
      const result = await executeTool(
        catalogTool,
        { instant: "2026-09-17T14:30:00Z" },
        { toolUseId: "host-1" },
      );
      expect(result.isError).toBe(false);
      const body = JSON.parse(result.content) as {
        ok: boolean;
        zone?: { timeZone: string; source: string };
        reason?: string;
      };
      if (!body.ok) {
        expect(typeof body.reason).toBe("string");
        return;
      }
      if (body.zone === undefined) throw new Error("expected a zone block");
      expect(["env", "system"]).toContain(body.zone.source);
      expect(isValidTimeZone(body.zone.timeZone)).toBe(true);
    } finally {
      _allowRealHost(false);
    }
  });
});
