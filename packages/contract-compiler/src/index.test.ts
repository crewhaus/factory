import { describe, expect, test } from "bun:test";
import { ContractCompilerError, compileContract, renderContract } from "./index";

describe("compileContract — pass 1 completeness", () => {
  test("throws on empty input", async () => {
    await expect(compileContract({ rawIssue: "   " })).rejects.toThrow(ContractCompilerError);
  });

  test("extracts bullet-list requirements", async () => {
    const c = await compileContract({
      rawIssue: "Implement search\n- Must handle empty queries\n- Should return top 10 results",
    });
    const userReqs = c.requirements.filter((r) => r.source === "user");
    expect(userReqs.length).toBe(2);
    expect(userReqs[0]?.text).toContain("empty queries");
  });

  test("extracts numbered requirements", async () => {
    const c = await compileContract({
      rawIssue: "Add login\n1. JWT tokens\n2. Refresh after 1h",
    });
    const userReqs = c.requirements.filter((r) => r.source === "user");
    expect(userReqs.length).toBe(2);
  });

  test("adds completeness-pass requirements when error handling is unmentioned", async () => {
    const c = await compileContract({ rawIssue: "Add a button that increments a counter" });
    const completeness = c.requirements.filter((r) => r.source === "completeness-pass");
    expect(completeness.some((r) => /error-handling/i.test(r.text))).toBe(true);
  });

  test("skips completeness rule when the signal is already present", async () => {
    const c = await compileContract({
      rawIssue:
        "Add /search endpoint with explicit error handling and edge case enumeration for empty + invalid inputs.",
    });
    const completeness = c.requirements.filter((r) => r.source === "completeness-pass");
    expect(completeness.some((r) => /error-handling/i.test(r.text))).toBe(false);
  });
});

describe("compileContract — specialization injection", () => {
  test("injects payments invariants when input mentions stripe", async () => {
    const c = await compileContract({
      rawIssue: "Build a Stripe paymentintent + refund flow",
    });
    expect(c.specialization?.specialization.name).toBe("payments");
    const ids = c.invariants.map((i) => i.id);
    expect(ids).toContain("idempotency-key");
    expect(ids).toContain("trust-boundary-client-status");
  });

  test("does not inject any specialization for unrelated input", async () => {
    const c = await compileContract({
      rawIssue: "Style the homepage with a new color scheme",
    });
    expect(c.specialization).toBeUndefined();
    expect(c.invariants.length).toBe(0);
  });

  test("forceSpecialization overrides auto-detect", async () => {
    const c = await compileContract({
      rawIssue: "anything at all",
      forceSpecialization: "auth",
    });
    expect(c.specialization?.specialization.name).toBe("auth");
    expect(c.specialization?.confidence).toBe(1);
  });
});

describe("compileContract — pass 2 ambiguity", () => {
  test("flags vague quantifiers in requirements", async () => {
    const c = await compileContract({
      rawIssue: "Notes:\n- Return some results when the user searches",
    });
    expect(c.ambiguitiesResolved.length).toBeGreaterThan(0);
    const r = c.requirements.find((r) => r.source === "user");
    expect(r?.text).toContain("[QUANTIFY]");
  });

  test("supplied refiner replaces the rule-based pass 2", async () => {
    const c = await compileContract({
      rawIssue: "Maybe handle the timeout case",
      refiner: async (draft) => ({
        ...draft,
        outOfScope: ["everything except the happy path"],
      }),
    });
    expect(c.outOfScope).toEqual(["everything except the happy path"]);
    // Refiner replaced the rule-based pass, so vague quantifiers are NOT
    // automatically flagged.
    expect(c.ambiguitiesResolved.length).toBe(0);
  });
});

describe("renderContract", () => {
  test("emits a markdown-flavored block including invariants and ambiguities", async () => {
    const c = await compileContract({
      rawIssue: "Stripe paymentintent flow\n- Refund support\n- Some retries",
    });
    const md = renderContract(c);
    expect(md).toContain("# Contract:");
    expect(md).toContain("## Requirements");
    expect(md).toContain("## Invariants");
    expect(md).toContain("idempotency-key");
    expect(md).toContain("## Ambiguities resolved");
  });
});
