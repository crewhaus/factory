/**
 * `schedule:` (#514): the object form compiles to the bytes it always did, and
 * the list form lowers to `scheduleLanes`, sorted by name, with no control-plane
 * id in anything it compiles to.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY, corpusFileDigests } from "./__fixtures__/delta-090/regenerate";
import { lower } from "./index";
import { SCHEDULE_LANES_CORPUS, SCHEDULE_OBJECT_CORPUS } from "./schedule-corpus";
import { CONTROL_PLANE_ID_RE, compiledExits, exitHits } from "./sentinel";

function digestsOf(name: string): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/delta-090/${name}`, import.meta.url), "utf8"),
  ) as Record<string, Record<string, string>>;
}

describe("the object form", () => {
  const pinned = digestsOf("schedule-object.digests.json");

  test("the digest file covers exactly the six specs", () => {
    expect(Object.keys(pinned).sort()).toEqual(Object.keys(SCHEDULE_OBJECT_CORPUS).sort());
    expect(Object.keys(pinned).length).toBe(6);
  });

  for (const [name, yaml] of Object.entries(SCHEDULE_OBJECT_CORPUS)) {
    test(`${name}: every file matches its digest`, () => {
      expect(
        corpusFileDigests(yaml),
        "the object form's compiled bytes moved: the list form reached a spec that does not use it",
      ).toEqual(pinned[name] as Record<string, string>);
    });

    test(`${name}: lowers to schedule and no scheduleLanes key`, () => {
      const ir = lower(parseSpec(yaml), { today: CORPUS_TODAY }) as unknown as Record<
        string,
        unknown
      >;
      expect(ir["schedule"]).toBeDefined();
      expect("scheduleLanes" in ir).toBe(false);
    });
  }
});

describe("the list form", () => {
  const present = digestsOf("schedule-lanes.present.digests.json");

  test("the present golden covers exactly the three shapes", () => {
    expect(Object.keys(present).sort()).toEqual(["batch-lanes", "channel-lanes", "managed-lanes"]);
    expect(Object.keys(SCHEDULE_LANES_CORPUS).sort()).toEqual(Object.keys(present).sort());
  });

  for (const [name, yaml] of Object.entries(SCHEDULE_LANES_CORPUS)) {
    test(`${name}: lowers to scheduleLanes sorted by name, and no schedule key`, () => {
      const ir = lower(parseSpec(yaml), { today: CORPUS_TODAY }) as unknown as Record<
        string,
        unknown
      >;
      expect("schedule" in ir).toBe(false);
      expect(ir["scheduleLanes"]).toEqual([
        { name: "discovery", kind: "interval", everyMs: 7_200_000 },
        {
          name: "weekly-report",
          kind: "cron",
          cron: "0 17 * * 5",
          timezone: "Europe/Berlin",
          jitterMs: 60_000,
          instructions: 'Write the "weekly" report: `totals` for ${x}\nthen stop.',
        },
      ]);
    });

    test(`${name}: --emit-ir writes each lane's keys in order`, () => {
      const emitIr = compiledExits(yaml).find((e) => e.exit === "emit-ir")?.text ?? "";
      const lanes = (JSON.parse(emitIr) as { scheduleLanes: Array<Record<string, unknown>> })
        .scheduleLanes;
      expect(lanes.map((lane) => Object.keys(lane))).toEqual([
        ["name", "kind", "everyMs"],
        ["name", "kind", "cron", "timezone", "jitterMs", "instructions"],
      ]);
      // The serialized text, not just the parsed object: discovery comes first.
      const discovery = emitIr.indexOf('"name": "discovery"');
      const weekly = emitIr.indexOf('"name": "weekly-report"');
      expect(discovery).toBeGreaterThan(-1);
      expect(weekly).toBeGreaterThan(discovery);
    });

    test(`${name}: every file matches the present golden`, () => {
      expect(corpusFileDigests(yaml)).toEqual(present[name] as Record<string, string>);
    });

    test(`${name}: no control-plane id reaches any compile exit`, () => {
      expect(exitHits(yaml, CONTROL_PLANE_ID_RE).map((e) => e.exit)).toEqual([]);
    });
  }

  test("the lane order in the spec does not change the IR", () => {
    const yaml = SCHEDULE_LANES_CORPUS["channel-lanes"] as string;
    const [head, lanes] = yaml.split("schedule:\n") as [string, string];
    const items = lanes.split(/(?=^ {2}- )/m);
    const swapped = `${head}schedule:\n${[...items].reverse().join("")}`;
    expect(swapped).not.toBe(yaml);
    const a = lower(parseSpec(yaml), { today: CORPUS_TODAY }) as unknown as Record<string, unknown>;
    const b = lower(parseSpec(swapped), { today: CORPUS_TODAY }) as unknown as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(b["scheduleLanes"])).toBe(JSON.stringify(a["scheduleLanes"]));
  });
});
