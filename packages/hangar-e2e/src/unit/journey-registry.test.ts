import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Journey, SHARDS, selectJourneys } from "../journeys/journey";
import { JOURNEYS } from "../journeys/registry";

const JOURNEY_DIR = join(import.meta.dir, "..", "journeys");
const onDisk = readdirSync(JOURNEY_DIR).filter((name) => name.endsWith(".journey.ts"));

describe("the registry", () => {
  test("every journey on disk is registered, and nothing else is", () => {
    // A guard over an empty directory would hold for anything.
    expect(onDisk.length).toBeGreaterThanOrEqual(10);
    const listed = JOURNEYS.map((journey) => `${journey.id}.journey.ts`);
    expect([...listed].sort()).toEqual([...onDisk].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  test("every journey says what it proves", () => {
    for (const journey of JOURNEYS) {
      expect({ id: journey.id, proves: journey.proves.length > 20 }).toEqual({
        id: journey.id,
        proves: true,
      });
    }
  });

  test.each(SHARDS)("shard %s has a journey", (shard) => {
    expect(JOURNEYS.filter((journey) => journey.shard === shard).length).toBeGreaterThan(0);
  });
});

describe("selectJourneys", () => {
  const stub = (id: string, shard: Journey["shard"]): Journey => ({
    id,
    shard,
    proves: "nothing",
    run: async () => {},
  });
  const journeys = [stub("a", "smoke"), stub("b", "axe")];

  test("unset means all of them", () => {
    expect(selectJourneys(journeys, undefined)).toEqual(journeys);
    expect(selectJourneys(journeys, "")).toEqual(journeys);
  });

  test("a shard selects its own", () => {
    expect(selectJourneys(journeys, "axe").map((journey) => journey.id)).toEqual(["b"]);
  });

  test("an unknown shard throws, so a typo in the workflow cannot pass by running nothing", () => {
    expect(() => selectJourneys(journeys, "smokes")).toThrow("smokes");
  });

  test("a shard that selects nothing throws", () => {
    expect(() => selectJourneys(journeys, "system")).toThrow("selects no journey");
  });
});
