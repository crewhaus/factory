import { describe, expect, test } from "bun:test";
import type { Grader } from "@crewhaus/eval-grader";
import { unverifiedBundle } from "@crewhaus/provability";
import {
  NOW,
  POLICY,
  POLICY_FETCH,
  accrual,
  bundleFor,
  ev,
  fetched,
  moneyAdd,
  pass,
  response,
  runWith,
  sample,
} from "./__test__/fixtures";
import {
  FLOOR_ABOVE_BUNDLE,
  INFINITE_COST_PREFIX,
  NO_PROOF_BUNDLE,
  PROVABILITY_GRADERS,
  UNPRICED_COST_PREFIX,
  assumptionRate,
  citationValidity,
  claimCoverage,
  costPerProvenClaim,
  createCostPerProvenClaim,
  createProvabilityGraders,
  isUnmeasured,
  replayIntegrity,
  rungAchieved,
} from "./index";

const GROUNDED_ANSWER = `The refund window is 14 days [1].\n\n[1]: ${POLICY}`;

describe("every grader — no bundle, unverified, malformed metadata", () => {
  for (const [name, grader] of PROVABILITY_GRADERS) {
    test(`${name}: a run with no proof bundle FAILS, naming the missing block`, async () => {
      const result = await grader(sample(), runWith(undefined));
      expect(result.passed).toBe(false);
      expect(result.score).toBe(0);
      expect(result.rationale).toContain(NO_PROOF_BUNDLE);
      expect(result.rationale).toContain("--provability <level>");
      // True on a --provability run whose sample errored before the gate ran, too.
      expect(result.rationale).toContain("or the sample ended before the gate graded an answer");
      expect(isUnmeasured(result)).toBe(true);
    });

    test(`${name}: a run without artifacts at all is the same no-bundle failure`, async () => {
      const { artifacts: _gone, ...bare } = runWith(undefined);
      const result = await grader(sample(), bare);
      expect(result.passed).toBe(false);
      expect(result.rationale).toContain(NO_PROOF_BUNDLE);
    });

    test(`${name}: an UNVERIFIED bundle (the verifier threw) fails, never passes`, async () => {
      const bundle = unverifiedBundle({ level: "grounded", threshold: 1 }, new Error("disk full"));
      const result = await grader(sample(), runWith(bundle));
      expect(result.passed).toBe(false);
      expect(result.rationale).toContain("disk full");
      expect(result.rationale).toContain("unverified");
      expect(isUnmeasured(result)).toBe(true);
    });

    test(`${name}: malformed metadata.provability fails, naming the field`, async () => {
      const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
      const result = await grader(sample({ provability: { level: "certain" } }), runWith(bundle));
      expect(result.passed).toBe(false);
      expect(result.rationale).toContain("metadata.provability.level");
      expect(isUnmeasured(result)).toBe(true);
    });
  }
});

describe("provability.claimCoverage", () => {
  test("a grounded answer at the grounded floor scores the gate's own 1.0", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    expect(bundle.verdict).toBe("pass");
    const result = await claimCoverage(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 1 });
    expect(result.rationale).toContain("1/1 claim meet the grounded floor");
  });

  test("a citation never fetched misses grounded, and the reason is tallied", async () => {
    const bundle = await bundleFor(
      `The refund window is 14 days [1]. Shipping takes 3 business days [2].\n\n[1]: ${POLICY}\n[2]: https://acme.example/shipping`,
      "grounded",
      [POLICY_FETCH],
    );
    const result = await claimCoverage(sample(), runWith(bundle));
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.5);
    expect(result.rationale).toContain("1/2 claims meet the grounded floor");
    expect(result.rationale).toContain("unmet: not_fetched");
  });

  test("the threshold is 0.95, not the spec's: 19 of 20 passes", async () => {
    const sentences: string[] = [];
    for (let i = 0; i < 19; i++) sentences.push(`Order ${i + 1} ships within 14 days [1].`);
    sentences.push("Order 20 ships within 14 days.");
    const bundle = await bundleFor(`${sentences.join(" ")}\n\n[1]: ${POLICY}`, "cited");
    const result = await claimCoverage(sample(), runWith(bundle));
    expect(bundle.verdict).toBe("fail"); // the spec's threshold is 1.0
    expect(result.score).toBeCloseTo(0.95, 5);
    expect(result.passed).toBe(true);
    expect(result.rationale).toContain("no_citation");
  });

  test("a zero-claim answer is a vacuous pass that says so", async () => {
    const bundle = await bundleFor("Which order do you mean?", "grounded");
    const result = await claimCoverage(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 1 });
    expect(result.rationale).toContain("vacuous");
  });

  test("a sample floor ABOVE the bundle's is not graded from recorded rungs: unmeasured, never a pass", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "cited"); // gate at cited, nothing fetched
    expect(bundle.verdict).toBe("pass");
    const atRun = await claimCoverage(sample(), runWith(bundle));
    expect(atRun.passed).toBe(true);
    const raised = await claimCoverage(sample({ provability: "grounded" }), runWith(bundle));
    expect(raised).toMatchObject({ passed: false, score: 0 });
    expect(raised.rationale.startsWith(FLOOR_ABOVE_BUNDLE)).toBe(true);
    expect(raised.rationale).toContain("the sample's grounded floor is above the cited floor");
    expect(isUnmeasured(raised)).toBe(true);
  });

  test("a tampered tool result is never graded as meeting checked from a grounded bundle (review W3-C2)", async () => {
    const SUM = { id: "toolu_sum", name: "MoneyAdd", content: moneyAdd("1284.50") };
    const ANSWER = "The invoice total is 1,284.50 [4].\n\n[4]: tool:toolu_sum";
    const tampered = {
      isPureTool: () => true,
      replay: async () => ({ content: moneyAdd("1284.51"), isError: false }),
    };
    // The gate AT checked replays and catches it.
    const atChecked = await bundleFor(ANSWER, "checked", [SUM], tampered);
    expect(atChecked.verdict).toBe("fail");
    expect(await claimCoverage(sample(), runWith(atChecked))).toMatchObject({
      passed: false,
      score: 0,
    });
    // A grounded gate never replays — its recorded `checked` rung is unchecked,
    // so a sample asking for checked gets no grade from it, on any floor-dependent grader.
    const atGrounded = await bundleFor(ANSWER, "grounded", [SUM], tampered);
    const meta = sample({ provability: { level: "checked" } });
    for (const grader of [claimCoverage, rungAchieved, replayIntegrity, costPerProvenClaim]) {
      const result = await grader(meta, runWith(atGrounded));
      expect(result.passed).toBe(false);
      expect(result.rationale.startsWith(FLOOR_ABOVE_BUNDLE)).toBe(true);
    }
    // The floor-independent graders still measure.
    expect((await citationValidity(meta, runWith(atGrounded))).passed).toBe(true);
    expect((await assumptionRate(meta, runWith(atGrounded))).passed).toBe(true);
  });

  test("metadata.provability.level lowers the floor: a not-fetched citation still meets cited", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded"); // never fetched
    expect(bundle.verdict).toBe("fail");
    const lowered = await claimCoverage(
      sample({ provability: { level: "cited" } }),
      runWith(bundle),
    );
    expect(lowered).toMatchObject({ passed: true, score: 1 });
  });

  test("a dangling marker never meets any floor, re-read or not", async () => {
    const bundle = await bundleFor(
      `The refund window is 14 days [1] [2].\n\n[1]: ${POLICY}`,
      "grounded",
      [POLICY_FETCH],
    );
    for (const level of ["cited", "grounded"] as const) {
      const result = await claimCoverage(sample({ provability: level }), runWith(bundle));
      expect(result.passed).toBe(false);
      expect(result.rationale).toContain("no_definition");
    }
  });

  test("expected_sources: every expected origin grounding the answer passes, normalized", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const result = await claimCoverage(
      sample({ provability: { expected_sources: ["https://ACME.example/policy/"] } }),
      runWith(bundle),
    );
    expect(result.passed).toBe(true);
  });

  test("expected_sources: a missing origin fails the sample and is named", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const result = await claimCoverage(
      sample({
        provability: { expected_sources: [POLICY, "https://acme.example/terms"] },
      }),
      runWith(bundle),
    );
    expect(result.passed).toBe(false);
    expect(result.score).toBe(1); // coverage itself is complete
    expect(result.rationale).toContain('"https://acme.example/terms"');
    expect(result.rationale).not.toContain(`"${POLICY}"`);
  });

  test("expected_sources at checked / proven: a source that grounded its claim counts (no source is ever ok there)", async () => {
    // The figure is computed by an allowed tool AND grounded in the fetched policy.
    const SUM = { id: "toolu_sum", name: "MoneyAdd", content: moneyAdd("14.00") };
    const text = `The refund window is 14 days [1] [4].\n\n[1]: ${POLICY}\n[4]: tool:toolu_sum`;
    for (const level of ["checked", "proven"] as const) {
      const bundle = await bundleFor(text, level, [POLICY_FETCH, SUM]);
      const source = bundle.claims[0]?.bindings.find((b) => b.kind === "source");
      expect(source).toMatchObject({ rung: "grounded", ok: false, reason: "below_floor" });
      const result = await claimCoverage(
        sample({ provability: { expected_sources: [POLICY] } }),
        runWith(bundle),
      );
      expect(result.rationale).not.toContain("expected source(s) not grounding");
    }
    // At checked, the claim is met by the tool binding: the whole grade passes.
    const checked = await bundleFor(text, "checked", [POLICY_FETCH, SUM]);
    expect(checked.verdict).toBe("pass");
    expect(
      await claimCoverage(
        sample({ provability: { expected_sources: [POLICY] } }),
        runWith(checked),
      ),
    ).toMatchObject({ passed: true, score: 1 });
    // A source cited but never fetched still does not count above grounded.
    const unfetched = await bundleFor(text, "checked", [SUM]);
    const missing = await claimCoverage(
      sample({ provability: { expected_sources: [POLICY] } }),
      runWith(unfetched),
    );
    expect(missing.passed).toBe(false);
    expect(missing.rationale).toContain(`"${POLICY}"`);
  });

  test("expected_sources: a source cited but never fetched does not count at grounded", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded");
    const result = await claimCoverage(
      sample({ provability: { expected_sources: [POLICY] } }),
      runWith(bundle),
    );
    expect(result.rationale).toContain(`"${POLICY}"`);
  });

  test("assumptions are excluded from the score and counted in the rationale", async () => {
    const bundle = await bundleFor(
      `The refund window is 14 days [1]. The customer ordered after the sale ended [A1].\n\n[1]: ${POLICY}\n[A1]: assume: the order date is after the sale`,
      "grounded",
      [POLICY_FETCH],
    );
    const result = await claimCoverage(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 1 });
    expect(result.rationale).toContain("1 assumption excluded");
  });
});

describe("provability.rungAchieved", () => {
  test("an answer that reached grounded scores 2/4 and passes the grounded floor", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const result = await rungAchieved(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 0.5 });
    expect(result.rationale).toContain("achieved grounded (rung 2/4)");
  });

  test("an answer that only reached cited is one rung short of grounded", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded");
    expect(bundle.achieved).toBe("cited");
    const result = await rungAchieved(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: false, score: 0.25 });
    expect(result.rationale).toContain("1 rung short");
  });

  test("an uncited answer achieves none: score 0", async () => {
    const bundle = await bundleFor("The refund window is 14 days.", "cited");
    const result = await rungAchieved(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: false, score: 0 });
  });

  test("a lower sample floor decides the pass; a higher one is unmeasured", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const cited = await rungAchieved(sample({ provability: "cited" }), runWith(bundle));
    expect(cited).toMatchObject({ passed: true, score: 0.5 });
    // `achieved` above a gate's floor is computed without that floor's checks.
    const checked = await rungAchieved(sample({ provability: "checked" }), runWith(bundle));
    expect(checked).toMatchObject({ passed: false, score: 0 });
    expect(isUnmeasured(checked)).toBe(true);
  });

  test("a checked computation reaches rung 3", async () => {
    const bundle = await bundleFor(
      "The invoice total is 1,284.50 [4].\n\n[4]: tool:toolu_sum",
      "checked",
      [{ id: "toolu_sum", name: "MoneyAdd", content: moneyAdd("1284.50") }],
    );
    const result = await rungAchieved(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 0.75 });
  });
});

describe("provability.citationValidity", () => {
  test("every marker defined scores 1", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "cited");
    expect(await citationValidity(sample(), runWith(bundle))).toMatchObject({
      passed: true,
      score: 1,
    });
  });

  test("one dangling marker of two scores 0.5 and names the ref", async () => {
    const bundle = await bundleFor(
      `The refund window is 14 days [1] [2].\n\n[1]: ${POLICY}`,
      "cited",
    );
    const result = await citationValidity(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: false, score: 0.5 });
    expect(result.rationale).toContain("no definition for [2]");
  });

  test("no markers is a vacuous pass that points at the uncited claims", async () => {
    const bundle = await bundleFor("The refund window is 14 days.", "cited");
    const result = await citationValidity(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 1 });
    expect(result.rationale).toContain("1 uncited claim");
  });

  test("an assumption marker counts as defined", async () => {
    const bundle = await bundleFor(
      "The customer ordered after the sale ended [A1].\n\n[A1]: assume: the order date is after the sale",
      "cited",
    );
    expect((await citationValidity(sample(), runWith(bundle))).score).toBe(1);
  });

  // Design §9.1: defined markers / markers counts the markers the answer
  // WROTE. A definition's gloss sentence is a claim citing that definition
  // through a synthetic self-binding — defined by construction — so it must
  // not add a defined marker to either side of the ratio.
  const GLOSS = "Refunds are processed within five business days of receipt.";

  test("a definition's gloss claim adds no marker (its self-binding is not one the answer wrote)", async () => {
    const bundle = await bundleFor(
      `The refund window is 14 days [1] [2].\n\n[1]: ${POLICY} ${GLOSS}`,
      "cited",
    );
    // The verifier does read the gloss as a claim bound to [1] …
    expect(bundle.claims.some((c) => c.definition === "[1]" && c.bindings.length === 1)).toBe(true);
    // … but the answer wrote two markers, one of them dangling.
    const result = await citationValidity(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: false, score: 0.5 });
    expect(result.rationale).toContain("1/2 markers defined");
    expect(result.rationale).toContain("no definition for [2]");
  });

  test("a gloss sentence cannot lift a ratio just under the bar over it", async () => {
    const cited = Array.from({ length: 98 }, (_, i) => `Clause ${i + 1} holds as written [1].`);
    const answer = `${cited.join(" ")} The refund window is 14 days [2].\n\n[1]: ${POLICY}`;
    const without = await citationValidity(sample(), runWith(await bundleFor(answer, "cited")));
    expect(without.passed).toBe(false);
    expect(without.rationale).toContain("98/99 markers defined");
    const glossed = await citationValidity(
      sample(),
      runWith(await bundleFor(`${answer} ${GLOSS}`, "cited")),
    );
    expect(glossed).toMatchObject({ passed: false, score: without.score });
    expect(glossed.rationale).toContain("98/99 markers defined");
  });

  test("an answer whose only markers sit under a gloss is still vacuous", async () => {
    const bundle = await bundleFor(
      `The refund window is 14 days.\n\n[1]: ${POLICY} ${GLOSS}`,
      "cited",
    );
    const result = await citationValidity(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 1 });
    expect(result.rationale).toContain("no citation markers to check (vacuous)");
  });
});

describe("provability.assumptionRate", () => {
  const twoClaims = (assume: boolean): string =>
    `The refund window is 14 days [1]. The customer ordered after the sale ended [${assume ? "A1" : "1"}].\n\n[1]: ${POLICY}\n[A1]: assume: the order date is after the sale`;

  test("no assumptions: rate 0", async () => {
    const bundle = await bundleFor(twoClaims(false), "cited");
    expect(await assumptionRate(sample(), runWith(bundle))).toMatchObject({
      passed: true,
      score: 0,
    });
  });

  test("one of two claims assumed: rate 0.5 fails the ≤0.1 bound", async () => {
    const bundle = await bundleFor(twoClaims(true), "cited");
    const result = await assumptionRate(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: false, score: 0.5 });
    expect(result.rationale).toContain("1/2 claims rest on a declared assumption");
  });

  test("a REFUSED assumption still counts (assumptions: forbid)", async () => {
    const bundle = await bundleFor(twoClaims(true), "cited", [], {
      patch: { assumptions: "forbid" },
    });
    expect(bundle.assumptions).toBe(0);
    expect(bundle.assumptionsRefused).toBe(1);
    const result = await assumptionRate(sample(), runWith(bundle));
    expect(result.score).toBe(0.5);
    expect(result.rationale).toContain("1 refused by the config");
  });

  test("zero claims is a vacuous 0", async () => {
    const bundle = await bundleFor("Which order?", "cited");
    expect(await assumptionRate(sample(), runWith(bundle))).toMatchObject({
      passed: true,
      score: 0,
    });
  });

  test("a proof's hypotheses count: a proof that assumes its conclusion is not 0 assumptions", async () => {
    const proven = await bundleFor(twoClaims(false), "cited");
    // The bundle a proven claim leaves when its proof rests on one hypothesis.
    const bundle = { ...proven, hypotheses: 1 };
    const result = await assumptionRate(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: false, score: 0.5 });
    expect(result.rationale).toContain("1 proof hypothesis counted");
  });
});

describe("provability.replayIntegrity", () => {
  const SUM = {
    id: "toolu_sum",
    name: "MoneyAdd",
    input: { currency: "USD", amountsMinor: ["100000", "28450"] },
    content: moneyAdd("1284.50"),
  };
  const TOTAL =
    "The invoice total is 1,284.50 [4]. Again, the total is 1,284.50 [5].\n\n[4]: tool:toolu_sum\n[5]: tool:toolu_sum";

  test("a matching replay scores 1, counted once per execution", async () => {
    const bundle = await bundleFor(TOTAL, "checked", [SUM], {
      isPureTool: () => true,
      replay: async () => ({ content: moneyAdd("1284.50"), isError: false }),
    });
    const result = await replayIntegrity(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 1 });
    expect(result.rationale).toContain("1/1 replayed execution matched");
  });

  test("a tampered result fails replay: score below 1 names the call", async () => {
    const bundle = await bundleFor(
      `${TOTAL.split("\n\n")[0]} The fee is 3 [6].\n\n[4]: tool:toolu_sum\n[5]: tool:toolu_sum\n[6]: tool:toolu_mcp`,
      "checked",
      [SUM, { id: "toolu_mcp", name: "mcp__calc__add", input: { a: 1, b: 2 }, content: "3" }],
      {
        isPureTool: () => true,
        replay: async (name) =>
          name === "MoneyAdd"
            ? { content: moneyAdd("1284.51"), isError: false }
            : { content: "3", isError: false },
      },
    );
    const result = await replayIntegrity(sample(), runWith(bundle));
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.5);
    expect(result.rationale).toContain("replay mismatch: toolu_sum");
  });

  test("no replay (below checked, or replay off) is a vacuous pass", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const result = await replayIntegrity(sample(), runWith(bundle));
    expect(result).toMatchObject({ passed: true, score: 1 });
    expect(result.rationale).toContain("vacuous");
  });
});

describe("provability.costPerProvenClaim", () => {
  test("no gate spend with met claims: $0 per claim, passes", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const result = await costPerProvenClaim(sample(), runWith(bundle, [pass("pass", 0)]));
    expect(result).toMatchObject({ passed: true, score: 0 });
    expect(result.rationale).toContain("$0.0000 per proven claim");
    expect(result.rationale).toContain("reported, no threshold");
  });

  test("a failing pass then a retry: the retry window's spend is gate-caused", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const events = [
      accrual(5_000), // the original answer — not the gate's
      pass("fail", 0),
      response(1000, 200),
      accrual(30_000), // the re-run the failing verdict triggered
      accrual(2_000, { role: "judge" }), // a judge in the window — excluded
      pass("pass", 1, { judgeCostUsdMicros: 4_000 }),
      accrual(9_000), // after the standing pass — not the gate's
    ];
    const result = await costPerProvenClaim(sample(), runWith(bundle, events));
    expect(result.passed).toBe(true);
    // ($0.030 re-run + $0.004 waiver judge) / 1 met claim
    expect(result.score).toBeCloseTo(0.034, 9);
    expect(result.rationale).toContain("re-runs $0.0300 over 1 gate pass after the first");
    expect(result.rationale).toContain("waiver judge $0.0040");
  });

  test("windows are per turn: another turn's spend is not this turn's retry", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const events = [pass("fail", 0, {}, 1), accrual(7_000, {}, 2), pass("pass", 0, {}, 2)];
    const result = await costPerProvenClaim(sample(), runWith(bundle, events));
    expect(result.score).toBe(0);
  });

  test("spend with zero met claims is the infinite ratio, kept JSON-safe", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded"); // never fetched
    const events = [pass("fail", 0), accrual(12_000), pass("fail", 1)];
    const result = await costPerProvenClaim(sample(), runWith(bundle, events));
    expect(result.passed).toBe(true);
    expect(result.score).toBe(0);
    expect(result.rationale.startsWith(INFINITE_COST_PREFIX)).toBe(true);
    expect(result.rationale).toContain("$0.0120");
  });

  test("re-run tokens nothing priced are a lower bound under the UNPRICED prefix, never a free $0", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const events = [pass("fail", 0), response(5000, 2000), pass("pass", 1)];
    const result = await costPerProvenClaim(sample(), runWith(bundle, events));
    expect(result.passed).toBe(true);
    expect(result.rationale.startsWith(UNPRICED_COST_PREFIX)).toBe(true);
    expect(result.rationale).toContain("7000 of 7000 re-run tokens unpriced");
    expect(result.rationale.startsWith("$0.0000")).toBe(false);
  });

  test("the pricing seam prices an unmetered run's re-run tokens (a plain `crewhaus eval`)", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const events = [pass("fail", 0), response(5000, 2000), pass("pass", 1)];
    const seen: string[] = [];
    const priced = createCostPerProvenClaim({
      pricing: (model, tokens) => {
        seen.push(model);
        return tokens.input * 3 + tokens.output * 15; // $3 / $15 per Mtok
      },
    });
    const result = await priced(sample(), runWith(bundle, events));
    expect(result.rationale.startsWith(UNPRICED_COST_PREFIX)).toBe(false);
    expect(result.score).toBeCloseTo((5000 * 3 + 2000 * 15) / 1_000_000, 9);
    expect(seen).toEqual(["claude-haiku-4-5"]);
    // A model the seam cannot price stays unpriced.
    const blind = createCostPerProvenClaim({ pricing: () => undefined });
    const unknown = await blind(sample(), runWith(bundle, events));
    expect(unknown.rationale.startsWith(UNPRICED_COST_PREFIX)).toBe(true);
  });

  test("unpriced tokens with zero met claims are the infinite ratio, not $0", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded"); // never fetched
    const events = [pass("fail", 0), response(800, 200), pass("fail", 1)];
    const result = await costPerProvenClaim(sample(), runWith(bundle, events));
    expect(result.rationale.startsWith(INFINITE_COST_PREFIX)).toBe(true);
    expect(result.rationale).toContain("1000 unpriced tokens");
  });

  test("createProvabilityGraders: the seam reaches only the cost grader", async () => {
    expect(createProvabilityGraders()).toBe(PROVABILITY_GRADERS);
    const priced = createProvabilityGraders({ pricing: () => 1 });
    expect(priced.map(([n]) => n)).toEqual(PROVABILITY_GRADERS.map(([n]) => n));
    priced.forEach(([name, grader], i) => {
      const same = grader === PROVABILITY_GRADERS[i]?.[1];
      expect({ name, same }).toEqual({ name, same: name !== "provability.costPerProvenClaim" });
    });
  });

  test("checker time is reported beside the spend, never added to it", async () => {
    const bundle = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const events = [
      ev({
        kind: "proof_checked",
        checker: "builtin",
        ok: true,
        artifactId: "prf_1",
        durationMs: 40,
        axioms: [],
      }),
      ev({
        kind: "proof_checked",
        checker: "smt",
        ok: false,
        artifactId: "prf_2",
        durationMs: 60,
        axioms: [],
      }),
      pass("pass", 0),
    ];
    const result = await costPerProvenClaim(sample(), runWith(bundle, events));
    expect(result.score).toBe(0);
    expect(result.rationale).toContain("checker time 100ms over 2 checks");
  });

  test("a bundle-only run (no pass events) counts the bundle's waiver spend", async () => {
    const base = await bundleFor(GROUNDED_ANSWER, "grounded", [POLICY_FETCH]);
    const bundle = { ...base, spentUsdMicros: 2_500 };
    const result = await costPerProvenClaim(sample(), runWith(bundle, []));
    expect(result.score).toBeCloseTo(0.0025, 9);
  });
});

test("every grader is a Grader and the six names are the design's table, in order", () => {
  const names = PROVABILITY_GRADERS.map(([n]) => n);
  expect(names).toEqual([
    "provability.claimCoverage",
    "provability.rungAchieved",
    "provability.citationValidity",
    "provability.assumptionRate",
    "provability.replayIntegrity",
    "provability.costPerProvenClaim",
  ]);
  for (const [, g] of PROVABILITY_GRADERS) expect(typeof (g as Grader)).toBe("function");
  expect(fetched(POLICY, "x")).toContain(POLICY);
  expect(NOW.toISOString()).toBe("2026-10-22T12:00:00.000Z");
});
