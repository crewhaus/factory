/**
 * E50 — deterministic variant selection + per-version outcome accounting.
 *
 * Every filesystem assertion runs inside its own `mkdtemp` sandbox (no
 * cwd-relative writes leak into the package directory).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CanaryError,
  type ExperimentConfig,
  type ExperimentOutcomeRecord,
  appendExperimentOutcome,
  appendExperimentOutcomes,
  createCanaryController,
  dedupeExperimentOutcomes,
  experimentFileName,
  listExperiments,
  readExperimentAssignment,
  readExperimentOutcomes,
  removeExperimentAssignment,
  requestBucket,
  selectExperimentVariant,
  tallyExperimentOutcomes,
  validateExperimentConfig,
  writeExperimentAssignment,
} from "./index";

const AB: ExperimentConfig = {
  name: "checkout-agent",
  variants: [
    { version: "v1", weight: 70 },
    { version: "v2", weight: 30 },
  ],
};

describe("selectExperimentVariant — determinism", () => {
  test("the same request key always resolves to the same version", () => {
    for (const key of ["user-1", "user-2", "session:abc", "🙂-unicode"]) {
      const first = selectExperimentVariant(AB, key);
      for (let i = 0; i < 25; i += 1) {
        expect(selectExperimentVariant(AB, key)).toEqual(first);
      }
    }
  });

  test("selection agrees with the canary controller's own route() hash", () => {
    // The two-version canary at `trafficPercent: 30` and the experiment
    // [{v1,70},{v2,30}] must put every key on the same side — that is the
    // whole point of sharing `requestBucket`.
    const ctrl = createCanaryController({
      registry: {} as never,
      deploymentController: {} as never,
    });
    for (let i = 0; i < 200; i += 1) {
      const key = `req-${i}`;
      const routed = ctrl.route(
        { name: "n", fromVersion: "v1", toVersion: "v2", trafficPercent: 30 },
        key,
      );
      const selected = selectExperimentVariant(
        {
          name: "n",
          variants: [
            { version: "v2", weight: 30 },
            { version: "v1", weight: 70 },
          ],
        },
        key,
      );
      expect(selected.bucket).toBe(routed.bucket);
      expect(selected.version).toBe(routed.version);
    }
  });

  test("the salt re-shuffles the assignment (a rotation token works)", () => {
    const salted = { ...AB, salt: "rotation-2" };
    let moved = 0;
    for (let i = 0; i < 300; i += 1) {
      const key = `k-${i}`;
      if (selectExperimentVariant(AB, key).version !== selectExperimentVariant(salted, key).version)
        moved += 1;
    }
    expect(moved).toBeGreaterThan(0);
  });

  const THREE: ExperimentConfig = {
    name: "three",
    variants: [
      { version: "a", weight: 50 },
      { version: "b", weight: 30 },
      { version: "c", weight: 20 },
    ],
  };

  test("weights partition the 100-bucket space in declaration order", () => {
    // The DIRECT partition claim, not a marginal-frequency proxy: every key's
    // bucket must land in the cumulative window of the variant it selected,
    // walked in declaration order — a=[0,50), b=[50,80), c=[80,100). A broken
    // partition that folded c's window into b is caught HERE, per bucket.
    const seenBuckets = new Set<number>();
    for (let i = 0; i < 3_000; i += 1) {
      const key = `key-${i}`;
      const bucket = requestBucket(undefined, key);
      const selected = selectExperimentVariant(THREE, key);
      seenBuckets.add(bucket);
      expect(selected.bucket).toBe(bucket);
      const expected = bucket < 50 ? { version: "a", index: 0 } : null;
      const window =
        expected ?? (bucket < 80 ? { version: "b", index: 1 } : { version: "c", index: 2 });
      expect({ version: selected.version, index: selected.index }).toEqual(window);
    }
    // …and the assertion above actually covered the WHOLE bucket space.
    expect(seenBuckets.size).toBe(100);
  });

  test("marginal frequencies match every declared weight (all three bounded)", () => {
    const tally = new Map<string, number>();
    for (let i = 0; i < 20_000; i += 1) {
      const v = selectExperimentVariant(THREE, `key-${i}`).version;
      tally.set(v, (tally.get(v) ?? 0) + 1);
    }
    // Hash spread is not perfectly uniform at this n, but each variant must be
    // bounded on BOTH sides — a one-sided bound would let a variant that got
    // nothing (its share folded into a neighbour) pass.
    const share = (v: string) => (tally.get(v) ?? 0) / 20_000;
    expect(share("a")).toBeGreaterThan(0.44);
    expect(share("a")).toBeLessThan(0.56);
    expect(share("b")).toBeGreaterThan(0.26);
    expect(share("b")).toBeLessThan(0.34);
    expect(share("c")).toBeGreaterThan(0.16);
    expect(share("c")).toBeLessThan(0.24);
  });

  test("requestBucket is stable and inside 0..99", () => {
    for (let i = 0; i < 500; i += 1) {
      const b = requestBucket(undefined, `x-${i}`);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });
});

describe("validateExperimentConfig", () => {
  test("rejects fewer than two variants", () => {
    expect(() =>
      validateExperimentConfig({ name: "x", variants: [{ version: "v1", weight: 100 }] }),
    ).toThrow(CanaryError);
  });

  test("rejects weights that do not sum to 100", () => {
    expect(() =>
      validateExperimentConfig({
        name: "x",
        variants: [
          { version: "v1", weight: 50 },
          { version: "v2", weight: 40 },
        ],
      }),
    ).toThrow(/sum to exactly 100/);
  });

  test("rejects fractional weights (the bucket space is exactly 100 wide)", () => {
    expect(() =>
      validateExperimentConfig({
        name: "x",
        variants: [
          { version: "v1", weight: 50.5 },
          { version: "v2", weight: 49.5 },
        ],
      }),
    ).toThrow(/integer in 1\.\.100/);
  });

  test("rejects duplicate versions", () => {
    expect(() =>
      validateExperimentConfig({
        name: "x",
        variants: [
          { version: "v1", weight: 50 },
          { version: "v1", weight: 50 },
        ],
      }),
    ).toThrow(/more than once/);
  });
});

describe("experimentFileName", () => {
  test("sanitizes path separators and leading dots", () => {
    expect(experimentFileName("../../etc/passwd")).not.toContain("/");
    expect(experimentFileName("../../etc/passwd").startsWith("_")).toBe(true);
    expect(experimentFileName("checkout agent")).toBe("checkout_agent");
  });

  test("refuses a name with nothing safe left", () => {
    expect(() => experimentFileName("///")).toThrow(CanaryError);
  });
});

describe("outcome ledger + tally", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crewhaus-experiment-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("appends and reads back per-version outcomes", () => {
    appendExperimentOutcomes(
      [
        { ts: "2026-01-01T00:00:00.000Z", experiment: "e", version: "v1", outcome: "success" },
        {
          ts: "2026-01-01T00:00:01.000Z",
          experiment: "e",
          version: "v2",
          outcome: "failure",
          score: 0.25,
          rating: 2,
          requestKey: "user-9",
          source: "serving",
        },
      ],
      dir,
    );
    const read = readExperimentOutcomes("e", dir);
    expect(read).toHaveLength(2);
    expect(read[1]).toEqual({
      ts: "2026-01-01T00:00:01.000Z",
      experiment: "e",
      version: "v2",
      outcome: "failure",
      requestKey: "user-9",
      score: 0.25,
      rating: 2,
      source: "serving",
    });
  });

  test("a torn final line degrades the tally by one, never throws", () => {
    appendExperimentOutcome({ ts: "t", experiment: "e", version: "v1", outcome: "success" }, dir);
    appendFileSync(join(dir, "e.jsonl"), '{"experiment":"e","version":"v1","outc', "utf-8");
    const read = readExperimentOutcomes("e", dir);
    expect(read).toHaveLength(1);
  });

  test("records with an unusable outcome/version are skipped", () => {
    writeFileSync(
      join(dir, "e.jsonl"),
      [
        JSON.stringify({ experiment: "e", version: "v1", outcome: "success" }),
        JSON.stringify({ experiment: "e", version: "v1", outcome: "maybe" }),
        JSON.stringify({ experiment: "e", outcome: "failure" }),
        JSON.stringify({ experiment: "e", version: "v1", outcome: "failure", score: "NaN" }),
      ].join("\n"),
      "utf-8",
    );
    const read = readExperimentOutcomes("e", dir);
    expect(read.map((r) => r.outcome)).toEqual(["success", "failure"]);
    expect(read[1]?.score).toBeUndefined();
  });

  test("an absent ledger reads as empty, not an error", () => {
    expect(readExperimentOutcomes("never-written", dir)).toEqual([]);
    expect(listExperiments(join(dir, "nope"))).toEqual([]);
  });

  test("listExperiments names every ledger", () => {
    appendExperimentOutcome({ ts: "t", experiment: "b", version: "v", outcome: "success" }, dir);
    appendExperimentOutcome({ ts: "t", experiment: "a", version: "v", outcome: "success" }, dir);
    expect(listExperiments(dir)).toEqual(["a", "b"]);
  });

  test("tally folds counts, scores and ratings in first-appearance order", () => {
    const tally = tallyExperimentOutcomes([
      { ts: "t", experiment: "e", version: "v1", outcome: "success", score: 1 },
      { ts: "t", experiment: "e", version: "v2", outcome: "failure", score: 0, rating: 1 },
      { ts: "t", experiment: "e", version: "v1", outcome: "failure", score: 0.5 },
      { ts: "t", experiment: "e", version: "v1", outcome: "success" },
      { ts: "t", experiment: "e", version: "v2", outcome: "success", rating: 5 },
    ]);
    expect(tally.map((t) => t.version)).toEqual(["v1", "v2"]);
    const v1 = tally[0];
    expect(v1?.n).toBe(3);
    expect(v1?.successes).toBe(2);
    expect(v1?.failures).toBe(1);
    expect(v1?.successRate).toBeCloseTo(2 / 3, 10);
    expect(v1?.scoredN).toBe(2);
    expect(v1?.meanScore).toBeCloseTo(0.75, 10);
    expect(v1?.meanRating).toBeUndefined();
    const v2 = tally[1];
    expect(v2?.meanRating).toBe(3);
    expect(v2?.ratedN).toBe(2);
  });

  test("tally records where each version's n came from", () => {
    const tally = tallyExperimentOutcomes([
      { ts: "t", experiment: "e", version: "v1", outcome: "success", source: "eval" },
      { ts: "t", experiment: "e", version: "v1", outcome: "failure", source: "serving" },
      { ts: "t", experiment: "e", version: "v1", outcome: "success", source: "eval" },
      // A record with no source is not silently attributed to one.
      { ts: "t", experiment: "e", version: "v2", outcome: "success" },
    ]);
    expect(tally[0]?.sources).toEqual({ eval: 2, serving: 1 });
    expect(tally[1]?.sources).toEqual({ unknown: 1 });
  });

  test("removeExperimentAssignment retires a concluded split, idempotently", () => {
    writeExperimentAssignment({ ...AB, updatedAt: "t" }, dir);
    expect(readExperimentAssignment("checkout-agent", dir)).toBeDefined();
    expect(removeExperimentAssignment("checkout-agent", dir)).toBe(true);
    expect(readExperimentAssignment("checkout-agent", dir)).toBeUndefined();
    // Removing what is already gone is not an error — a ramp that never wrote
    // an assignment still runs its terminal hook.
    expect(removeExperimentAssignment("checkout-agent", dir)).toBe(false);
    expect(removeExperimentAssignment("never-existed", dir)).toBe(false);
  });

  test("assignment manifest round-trips and validates", () => {
    const path = writeExperimentAssignment(
      {
        ...AB,
        updatedAt: "2026-01-01T00:00:00.000Z",
        env: "prod",
        note: "no serving surface consumes this yet",
      },
      dir,
    );
    expect(readFileSync(path, "utf-8")).toContain('"checkout-agent"');
    const back = readExperimentAssignment("checkout-agent", dir);
    expect(back?.variants).toEqual(AB.variants);
    expect(back?.env).toBe("prod");
    expect(back?.note).toContain("no serving surface");
  });

  test("a malformed assignment manifest reads as undefined", () => {
    writeFileSync(join(dir, "broken.assignment.json"), "{not json", "utf-8");
    expect(readExperimentAssignment("broken", dir)).toBeUndefined();
  });

  test("re-measured eval samples collapse; serving repeats do not", () => {
    const evalRec = (
      version: string,
      key: string,
      outcome: "success" | "failure",
      ts: string,
    ): ExperimentOutcomeRecord => ({
      ts,
      experiment: "e",
      version,
      outcome,
      requestKey: key,
      source: "eval",
    });
    const { records, collapsed } = dedupeExperimentOutcomes([
      // A 2-step ramp over a 2-sample dataset: each (version, sample) twice.
      evalRec("v1", "s1", "success", "t1"),
      evalRec("v1", "s2", "failure", "t1"),
      evalRec("v2", "s1", "success", "t1"),
      evalRec("v2", "s2", "success", "t1"),
      evalRec("v1", "s1", "success", "t2"),
      // Last write wins: s2 flipped on the second measurement.
      evalRec("v1", "s2", "success", "t2"),
      evalRec("v2", "s1", "success", "t2"),
      evalRec("v2", "s2", "success", "t2"),
      // A sticky serving key seen twice is TWO real requests — never collapsed.
      {
        ts: "t3",
        experiment: "e",
        version: "v1",
        outcome: "success",
        requestKey: "user-9",
        source: "serving",
      },
      {
        ts: "t4",
        experiment: "e",
        version: "v1",
        outcome: "failure",
        requestKey: "user-9",
        source: "serving",
      },
      // An eval record with no request key has no unit to dedupe on.
      { ts: "t5", experiment: "e", version: "v1", outcome: "success", source: "eval" },
    ]);
    expect(collapsed).toBe(4);
    const tally = tallyExperimentOutcomes(records);
    // v1: s1 + s2 (both t2) + 2 serving + 1 keyless = 5; v2: s1 + s2 = 2.
    expect(tally.find((t) => t.version === "v1")?.n).toBe(5);
    expect(tally.find((t) => t.version === "v2")?.n).toBe(2);
    // The SURVIVING eval observation is the last one (s2 flipped to success).
    const s2 = records.filter((r) => r.requestKey === "s2" && r.version === "v1");
    expect(s2).toHaveLength(1);
    expect(s2[0]).toMatchObject({ outcome: "success", ts: "t2" });
    // First-appearance order (control = baseline) survives the collapse.
    expect(tally.map((t) => t.version)).toEqual(["v1", "v2"]);
  });

  test("dedupe is a no-op on a ledger with no repeats", () => {
    const input: ExperimentOutcomeRecord[] = [
      {
        ts: "t",
        experiment: "e",
        version: "v1",
        outcome: "success",
        requestKey: "a",
        source: "eval",
      },
      {
        ts: "t",
        experiment: "e",
        version: "v2",
        outcome: "failure",
        requestKey: "a",
        source: "eval",
      },
    ];
    const { records, collapsed } = dedupeExperimentOutcomes(input);
    expect(collapsed).toBe(0);
    expect(records).toEqual(input);
    expect(dedupeExperimentOutcomes([])).toEqual({ records: [], collapsed: 0 });
  });

  test("writing an invalid assignment throws before touching disk", () => {
    expect(() =>
      writeExperimentAssignment(
        {
          name: "bad",
          variants: [{ version: "v1", weight: 100 }],
          updatedAt: "t",
        },
        dir,
      ),
    ).toThrow(CanaryError);
    expect(readExperimentAssignment("bad", dir)).toBeUndefined();
  });
});
