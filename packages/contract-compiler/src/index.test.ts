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

describe("compileContract — completeness inference branches", () => {
  test("infers a state-transition requirement when status is implied but transitions are not", async () => {
    const c = await compileContract({
      // mentions "status" (matches state-rule's positive signal) but never
      // says "transition" (negative signal absent) -> rule fires.
      rawIssue: "Track the order status and surface invalid empty failures.",
    });
    const completeness = c.requirements.filter((r) => r.source === "completeness-pass");
    expect(completeness.some((r) => /state transitions/i.test(r.text))).toBe(true);
  });

  test("does not infer a state-transition requirement when 'transition' is already present", async () => {
    const c = await compileContract({
      rawIssue: "Document each status transition; handle invalid empty error inputs.",
    });
    const completeness = c.requirements.filter((r) => r.source === "completeness-pass");
    expect(completeness.some((r) => /state transitions/i.test(r.text))).toBe(false);
  });

  test("infers a trust-boundary requirement when secrets are mentioned without a threat model", async () => {
    const c = await compileContract({
      // mentions "token"/"password" but no trust-boundary/threat-model/attacker.
      rawIssue: "Store the user password and issue a token. Handle invalid empty failures.",
    });
    const completeness = c.requirements.filter((r) => r.source === "completeness-pass");
    expect(completeness.some((r) => /trust boundaries/i.test(r.text))).toBe(true);
  });

  test("does not infer a trust-boundary requirement when a threat model is already named", async () => {
    const c = await compileContract({
      rawIssue:
        "Handle the auth token under an explicit threat model. Cover invalid empty error inputs.",
    });
    const completeness = c.requirements.filter((r) => r.source === "completeness-pass");
    expect(completeness.some((r) => /trust boundaries/i.test(r.text))).toBe(false);
  });
});

describe("compileContract — title + requirement extraction edge cases", () => {
  test("strips a leading markdown heading marker from the title", async () => {
    const c = await compileContract({ rawIssue: "# Build the widget\nbody text" });
    expect(c.title).toBe("Build the widget");
  });

  test("truncates a long single-line title to 120 chars", async () => {
    const long = "x".repeat(200);
    const c = await compileContract({ rawIssue: long });
    expect(c.title.length).toBe(120);
  });

  test("ignores bullet markers that have no body", async () => {
    // "-" / "1." with no following text must not produce a requirement.
    const c = await compileContract({ rawIssue: "Title line\n-\n1.\n- real item" });
    const userReqs = c.requirements.filter((r) => r.source === "user");
    expect(userReqs.length).toBe(1);
    expect(userReqs[0]?.text).toBe("real item");
  });
});

describe("ambiguityPass — global-regex statefulness regression", () => {
  test("flags vague quantifiers independently across consecutive requirements", async () => {
    // Regression guard: VAGUE_RE carries the /g flag and is reused across the
    // requirement loop. A leaked lastIndex would cause a later requirement to
    // be skipped or mis-matched. Every vague line must be flagged regardless
    // of position.
    const c = await compileContract({
      rawIssue: [
        "Title",
        "- return some results",
        "- handle maybe the timeout",
        "- a clean requirement with no vague words",
        "- perhaps several edge cases",
        "- another clean concrete requirement",
        "- might retry once",
      ].join("\n"),
    });
    const userReqs = c.requirements.filter((r) => r.source === "user");
    const flagged = userReqs.filter((r) => r.text.includes("[QUANTIFY]"));
    // Lines containing some / maybe / perhaps+several / might -> 4 flagged.
    expect(flagged.length).toBe(4);
    // Each flagged requirement is recorded once in ambiguitiesResolved.
    expect(c.ambiguitiesResolved.length).toBe(4);
    // The two concrete requirements are passed through untouched.
    expect(userReqs.some((r) => r.text === "a clean requirement with no vague words")).toBe(true);
    expect(userReqs.some((r) => r.text === "another clean concrete requirement")).toBe(true);
  });

  test("replaces every vague occurrence within a single requirement", async () => {
    const c = await compileContract({ rawIssue: "Title\n- perhaps several retries" });
    const req = c.requirements.find((r) => r.source === "user");
    expect(req?.text).toBe("[QUANTIFY] [QUANTIFY] retries");
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

  test("renders the specialization header line with confidence when matched", async () => {
    const c = await compileContract({ rawIssue: "anything", forceSpecialization: "auth" });
    const md = renderContract(c);
    expect(md).toContain("# Specialization: auth (confidence 1.00)");
  });

  test("renders required vs optional invariants distinctly", async () => {
    const c = await compileContract({ rawIssue: "Stripe refund and invoice charge flow" });
    const md = renderContract(c);
    // payments has both required (idempotency-key) and optional
    // (discount-deduction-source) invariants.
    expect(md).toContain("- [required] idempotency-key:");
    expect(md).toContain("- [optional] discount-deduction-source:");
  });

  test("omits the optional sections when the contract has no invariants/oos/ambiguities", async () => {
    // Plain input with explicit error+edge handling -> no specialization, no
    // invariants, no completeness noise that triggers ambiguity, no out-of-scope.
    const c = await compileContract({
      rawIssue:
        "Rename a CSS class with explicit error handling and edge case enumeration for empty + invalid inputs.",
    });
    const md = renderContract(c);
    expect(md).not.toContain("## Invariants");
    expect(md).not.toContain("## Out of scope");
    expect(md).not.toContain("## Ambiguities resolved");
    expect(md).not.toContain("# Specialization:");
    expect(md).toContain("## Requirements");
  });

  test("renders an out-of-scope section when present", async () => {
    const c = await compileContract({
      rawIssue: "Add a feature",
      refiner: async (draft) => ({ ...draft, outOfScope: ["payments integration"] }),
    });
    const md = renderContract(c);
    expect(md).toContain("## Out of scope");
    expect(md).toContain("- payments integration");
  });
});
