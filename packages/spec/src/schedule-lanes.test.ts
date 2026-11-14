/**
 * `schedule:` (#514): the list form of named lanes parses where the object form
 * does, its limits hold, lane names are unique, and the object form keeps
 * reporting exactly what it reported before the list form existed.
 */
import { describe, expect, test } from "bun:test";
import { DELTA_090_ISSUES } from "./blocks/delta-090";
import { intentIssues } from "./blocks/intent";
import { scheduleIssues } from "./blocks/schedule";
import { parseSpec, parseSpecIssues, specJsonSchema } from "./index";

const CHANNEL =
  "name: a\ntarget: channel\nagent: {model: claude-opus-4-7, instructions: Help.}\nchannels:\n  slack: {botToken: $T, signingSecret: $S}\nrouting: {sessionKey: thread}\n";
const SHAPES: Readonly<Record<string, string>> = {
  channel: CHANNEL,
  managed:
    "name: a\ntarget: managed\nagent: {model: claude-opus-4-7, instructions: Help.}\ntenants:\n  - {id: t, budget: {maxInputTokens: 1, maxOutputTokens: 1}}\n",
  batch:
    "name: a\ntarget: batch\nagent: {model: claude-opus-4-7, instructions: Help.}\nqueue: {adapter: in-memory}\nconcurrency: 1\n",
};
const CLI = "name: a\ntarget: cli\nagent: {model: claude-opus-4-7, instructions: Help.}\n";

const TWO_LANES = `schedule:
  - name: discovery
    kind: interval
    every: 2h
  - name: weekly-report
    kind: cron
    cron: "0 17 * * 5"
    timezone: Europe/Berlin
    jitter: 1m
    instructions: Write the weekly report.
`;

/** A list of `n` interval lanes named l0, l1, …. */
const lanes = (names: readonly string[]): string =>
  `schedule:\n${names.map((name) => `  - {name: "${name}", kind: interval, every: 1h}\n`).join("")}`;

describe("the list form", () => {
  for (const [shape, yaml] of Object.entries(SHAPES)) {
    test(`parses on ${shape}, each lane keeping its own fields`, () => {
      const spec = parseSpec(`${yaml}${TWO_LANES}`);
      expect("schedule" in spec && Array.isArray(spec.schedule)).toBe(true);
      const schedule = (spec as { schedule?: unknown }).schedule as ReadonlyArray<
        Record<string, unknown>
      >;
      expect(schedule.map((lane) => lane["name"])).toEqual(["discovery", "weekly-report"]);
      expect(schedule[1]).toEqual({
        name: "weekly-report",
        kind: "cron",
        cron: "0 17 * * 5",
        timezone: "Europe/Berlin",
        jitter: "1m",
        instructions: "Write the weekly report.",
      });
    });
  }

  test("is refused on a shape without schedule:", () => {
    const [first] = parseSpecIssues(`${CLI}${TWO_LANES}`);
    expect(first?.path).toEqual([]);
    expect(first?.message).toContain("schedule");
  });

  test("a repeated lane name is refused at the second one, naming it", () => {
    const [first, ...rest] = parseSpecIssues(`${CHANNEL}${lanes(["discovery", "discovery"])}`);
    expect(rest).toEqual([]);
    expect(first?.path).toEqual(["schedule", 1, "name"]);
    expect(first?.message).toContain('"discovery"');
    expect(first?.message).toContain("must be unique");
  });

  test("one to eight lanes", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `l${i}`);
    expect(parseSpecIssues(`${CHANNEL}${lanes(eight)}`)).toEqual([]);
    const [nine] = parseSpecIssues(`${CHANNEL}${lanes([...eight, "l8"])}`);
    expect(nine?.path).toEqual(["schedule"]);
    expect(nine?.message).toBe("schedule as a list takes at most 8 lanes");
    const [zero] = parseSpecIssues(`${CHANNEL}schedule: []\n`);
    expect(zero?.path).toEqual(["schedule"]);
    expect(zero?.message).toBe("schedule as a list needs at least one lane");
  });

  const badNames: ReadonlyArray<readonly [string, string]> = [
    ["an uppercase letter", "Nightly"],
    ["a control-plane id", "prn_0123456789abcdef"],
    ["33 characters", `a${"b".repeat(32)}`],
    ["a leading digit", "1st"],
  ];
  for (const [label, name] of badNames) {
    test(`a lane name with ${label} is refused, naming the rule`, () => {
      const [first] = parseSpecIssues(`${CHANNEL}${lanes([name])}`);
      expect(first?.path).toEqual(["schedule", 0, "name"]);
      expect(first?.message).toContain("lowercase letter");
    });
  }

  test("a 32-character name is a lane name", () => {
    expect(parseSpecIssues(`${CHANNEL}${lanes([`a${"b".repeat(31)}`])}`)).toEqual([]);
  });

  test("a lane without a name is refused at its name", () => {
    const [first] = parseSpecIssues(`${CHANNEL}schedule:\n  - {kind: interval, every: 1h}\n`);
    expect(first?.path).toEqual(["schedule", 0, "name"]);
  });

  test("the uniqueness check runs after intent's, and only once", () => {
    expect(DELTA_090_ISSUES.indexOf(intentIssues)).toBe(0);
    expect(DELTA_090_ISSUES.indexOf(scheduleIssues)).toBe(1);
    expect(DELTA_090_ISSUES.filter((check) => check === scheduleIssues).length).toBe(1);
  });

  test("the JSON Schema describes both forms on channel, managed and batch", () => {
    const root = specJsonSchema() as Record<string, unknown>;
    // zod-to-json-schema writes a repeated schema once and `$ref`s it after.
    const resolve = (node: unknown): Record<string, unknown> | undefined => {
      const ref = (node as { $ref?: unknown } | undefined)?.$ref;
      if (typeof ref !== "string") return node as Record<string, unknown> | undefined;
      let at: unknown = root;
      for (const part of ref.replace(/^#\//, "").split("/")) {
        at = (at as Record<string, unknown> | undefined)?.[part];
      }
      return resolve(at);
    };
    const definitions = root["definitions"] as Record<string, unknown>;
    for (const shape of ["channel", "managed", "batch"]) {
      const schedule = resolve(
        (definitions[shape] as { properties: Record<string, unknown> }).properties["schedule"],
      ) as { anyOf?: unknown[] } | undefined;
      const forms = schedule?.anyOf ?? [];
      expect(forms.length).toBe(2);
      const [objectForm, listForm] = forms as Array<Record<string, unknown>>;
      expect(Array.isArray(objectForm?.["anyOf"])).toBe(true);
      expect(listForm?.["type"]).toBe("array");
      expect(listForm?.["minItems"]).toBe(1);
      expect(listForm?.["maxItems"]).toBe(8);
    }
  });
});

describe("the object form's errors", () => {
  // Captured from the parser before the list form existed: an object is still
  // checked by the object union alone, so its first issue keeps its path and words.
  const cases: ReadonlyArray<readonly [string, string, ReadonlyArray<string | number>, string]> = [
    [
      "no kind",
      "schedule:\n  every: 6h\n",
      ["schedule", "kind"],
      "Invalid discriminator value. Expected 'cron' | 'interval'",
    ],
    [
      "a bad cron",
      'schedule:\n  kind: cron\n  cron: "every day"\n',
      ["schedule", "cron"],
      'schedule.cron must be a 5- or 6-field cron expression, e.g. "0 */6 * * *"',
    ],
    [
      "an unknown key",
      "schedule:\n  kind: interval\n  every: 6h\n  catch_up: true\n",
      ["schedule"],
      "Unrecognized key(s) in object: 'catch_up'",
    ],
  ];
  for (const [label, block, path, message] of cases) {
    test(`${label}: the first issue's path and message are unchanged`, () => {
      const [first] = parseSpecIssues(`${CHANNEL}${block}`);
      expect(first?.path).toEqual([...path]);
      expect(first?.message).toBe(message);
    });
  }
});
