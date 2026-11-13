/**
 * `schedule:` (#514): the object form compiles to the bytes it always did.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY, corpusFileDigests } from "./__fixtures__/delta-090/regenerate";
import { lower } from "./index";
import { SCHEDULE_OBJECT_CORPUS } from "./schedule-corpus";

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
