import { describe, expect, test } from "bun:test";
import { SCOPED_REF_KINDS, mintRunId, parseRef, scopedRunRef } from "./index.js";

const HRN = "hrn_0123456789abcdef";

describe("scopedRunRef", () => {
  test("a supervisor execution is an exec ref, and the ref parses", () => {
    const ref = scopedRunRef(HRN, "run_0123456789abcdef");
    expect(ref).toBe(`${HRN}/exec/run_0123456789abcdef`);
    expect(parseRef(ref)).toEqual({ scope: HRN, kind: "exec", id: "run_0123456789abcdef" });
  });

  test("a canonical, hex8 or base36 id is a run ref", () => {
    for (const id of [mintRunId(), "run_0123abcd", "run_z9k2"]) {
      const ref = scopedRunRef(HRN, id);
      expect(ref).toBe(`${HRN}/run/${id}`);
      expect("error" in parseRef(ref)).toBe(false);
    }
  });

  test("anything else names no ref", () => {
    for (const id of [
      "wf_123e4567-e89b-42d3-a456-426614174000",
      "run_channel",
      "fedrun_abc",
      "nope",
      "",
    ]) {
      expect(scopedRunRef(HRN, id)).toBeUndefined();
    }
  });

  test("the kinds a scoped token may name", () => {
    expect([...SCOPED_REF_KINDS]).toEqual(["run", "exec"]);
    // The other hex16 kind is never one a scoped token reads.
    expect(SCOPED_REF_KINDS as readonly string[]).not.toContain("evalrun");
  });
});
