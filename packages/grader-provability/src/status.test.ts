/**
 * A provability grade that replaces a measurement says so: `status:
 * "not_measured"` with the reason it could not measure, beside the pinned
 * rationale prefix that `isUnmeasured` reads.
 */
import { describe, expect, test } from "bun:test";
import { unverifiedBundle } from "@crewhaus/provability";
import { POLICY, POLICY_FETCH, bundleFor, runWith, sample } from "./__test__/fixtures";
import { PROVABILITY_GRADERS, claimCoverage, isUnmeasured } from "./index";

const GROUNDED_ANSWER = `The refund window is 14 days [1].\n\n[1]: ${POLICY}`;

describe("each standing reason maps to its code", () => {
  for (const [name, grader] of PROVABILITY_GRADERS) {
    test(`${name}: no bundle, an unverified bundle and invalid metadata`, async () => {
      const none = await grader(sample(), runWith(undefined));
      expect(none).toMatchObject({
        passed: false,
        score: 0,
        status: "not_measured",
        statusReason: "no_proof_bundle",
      });
      expect(isUnmeasured(none)).toBe(true);

      const failed = unverifiedBundle({ level: "grounded", threshold: 1 }, new Error("disk full"));
      const unverified = await grader(sample(), runWith(failed));
      expect(unverified).toMatchObject({ status: "not_measured", statusReason: "unverified" });
      expect(isUnmeasured(unverified)).toBe(true);

      const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
      const invalid = await grader(sample({ provability: { level: "certain" } }), runWith(bundle));
      expect(invalid).toMatchObject({ status: "not_measured", statusReason: "invalid_metadata" });
      expect(isUnmeasured(invalid)).toBe(true);
    });
  }

  test("a sample floor above the bundle's is floor_above_bundle", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "cited");
    const raised = await claimCoverage(sample({ provability: "grounded" }), runWith(bundle));
    expect(raised).toMatchObject({
      passed: false,
      status: "not_measured",
      statusReason: "floor_above_bundle",
    });
    expect(isUnmeasured(raised)).toBe(true);
  });

  test("a measured grade carries no status", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const measured = await claimCoverage(sample(), runWith(bundle));
    expect(measured.passed).toBe(true);
    expect("status" in measured).toBe(false);
    expect("statusReason" in measured).toBe(false);
  });
});
