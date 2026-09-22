/**
 * B26 + NEW-HUNT-10 + B18 — unit tests for the offline dataset lint engine:
 * one describe per rule class, plus the orchestrator's context gating and
 * the `crewhaus eval` preflight lint-lite (refusal vs warning semantics).
 * Everything here is pure — no filesystem, no model.
 */
import { describe, expect, test } from "bun:test";
import type { Sample } from "@crewhaus/eval-dataset";
import {
  canaryPhrasesIn,
  findCanaryLeaks,
  findCrossVersionIdReuse,
  findDuplicateIds,
  findEmptyGolds,
  findExpectedToolsNoTools,
  findGraderGoldMismatch,
  findNearDuplicates,
  findOffTaxonomyProvenance,
  lintDataset,
  lintGraderSpecOf,
  preflightLint,
  renderLintFindings,
} from "./dataset-lint";
import { canaryPhrase, canarySample } from "./datasets";

const s = (id: string, input: string, extra: Partial<Sample> = {}): Sample => ({
  id,
  input,
  ...extra,
});

describe("dataset lint — duplicate ids (B26)", () => {
  test("flags each duplicated id once, as an error", () => {
    const findings = findDuplicateIds([s("a", "1"), s("b", "2"), s("a", "3"), s("a", "4")]);
    expect(findings.length).toBe(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain('"a"');
    expect(findings[0]?.message).toContain("3 occurrences");
  });

  test("unique ids are clean", () => {
    expect(findDuplicateIds([s("a", "1"), s("b", "2")])).toEqual([]);
  });
});

describe("dataset lint — cross-version id reuse (B26)", () => {
  test("same id with different content in another version warns", () => {
    const findings = findCrossVersionIdReuse(
      { version: "v2", samples: [s("q1", "new content"), s("q2", "same")] },
      [{ version: "v1", samples: [s("q1", "old content"), s("q2", "same")] }],
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.sampleIds).toEqual(["q1"]);
    expect(findings[0]?.message).toContain("v1");
  });

  test("identical content across versions is normal lineage — clean", () => {
    const shared = s("q1", "unchanged");
    expect(
      findCrossVersionIdReuse({ version: "v2", samples: [shared] }, [
        { version: "v1", samples: [shared] },
      ]),
    ).toEqual([]);
  });
});

describe("dataset lint — near-duplicate inputs (B26)", () => {
  test("token overlap ≥ 0.9 warns with both ids", () => {
    const findings = findNearDuplicates([
      s("a", "please summarize the quarterly revenue report for the board meeting"),
      s("b", "please summarize the quarterly revenue report for the board meeting today"),
      s("c", "completely different question about llamas"),
    ]);
    expect(findings.length).toBe(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.sampleIds).toEqual(["a", "b"]);
  });

  test("distinct inputs are clean, and canary samples are exempt", () => {
    expect(
      findNearDuplicates([
        s("a", "what is the capital of france"),
        s("b", "how do i renew a passport"),
        canarySample("d", "v1"),
        canarySample("d", "v2"),
      ]),
    ).toEqual([]);
  });
});

describe("dataset lint — grader↔dataset gold mismatch (NEW-HUNT-10)", () => {
  const goldNeeding = [{ name: "exact", type: "exact_match" }];

  test("no sample carries a gold → error (all-fail-by-construction)", () => {
    const findings = findGraderGoldMismatch([s("a", "1"), s("b", "2")], goldNeeding);
    expect(findings.length).toBe(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain("NO sample");
  });

  test("partial gold gaps → warning naming the offenders", () => {
    const findings = findGraderGoldMismatch(
      [s("a", "1", { expected_output: "gold" }), s("b", "2")],
      goldNeeding,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.sampleIds).toEqual(["b"]);
  });

  test("gold-less graders (llm_judge etc.) never fire, and canaries don't count", () => {
    expect(findGraderGoldMismatch([s("a", "1")], [{ name: "j", type: "llm_judge" }])).toEqual([]);
    // A fully-golded dataset + its canary is clean (the canary is gold-less
    // BY DESIGN).
    expect(
      findGraderGoldMismatch(
        [s("a", "1", { expected_output: "g" }), canarySample("d", "v1")],
        goldNeeding,
      ),
    ).toEqual([]);
  });

  test("registry nlg.*/semantic.similarity refs are gold-needing (named by ref)", () => {
    const goldless = [s("a", "1"), s("b", "2")];
    for (const ref of ["nlg.rougeL", "nlg.bleu4", "semantic.similarity"]) {
      const findings = findGraderGoldMismatch(goldless, [
        { name: "g", type: "registry", registryGrader: ref },
      ]);
      expect(findings.length).toBe(1);
      expect(findings[0]?.severity).toBe("error");
      expect(findings[0]?.message).toContain(`(${ref})`);
    }
  });

  test("an opts.reference override lifts the gold requirement; unknown refs never fire", () => {
    const goldless = [s("a", "1")];
    expect(
      findGraderGoldMismatch(goldless, [
        { name: "g", type: "registry", registryGrader: "nlg.rougeL", hasReferenceOverride: true },
      ]),
    ).toEqual([]);
    // Third-party / unknown packs are never assumed gold-needing.
    expect(
      findGraderGoldMismatch(goldless, [
        { name: "g", type: "registry", registryGrader: "acme.customMetric" },
        { name: "h", type: "registry", registryGrader: "safety.toxicity" },
      ]),
    ).toEqual([]);
  });

  test("lintGraderSpecOf threads the registry ref + reference override through", () => {
    expect(lintGraderSpecOf({ name: "e", type: "exact_match" })).toEqual({
      name: "e",
      type: "exact_match",
    });
    expect(lintGraderSpecOf({ name: "r", type: "registry", grader: "nlg.rougeL" })).toEqual({
      name: "r",
      type: "registry",
      registryGrader: "nlg.rougeL",
    });
    expect(
      lintGraderSpecOf({
        name: "r",
        type: "registry",
        grader: "semantic.similarity",
        opts: { reference: "the gold", threshold: 0.7 },
      }),
    ).toEqual({
      name: "r",
      type: "registry",
      registryGrader: "semantic.similarity",
      hasReferenceOverride: true,
    });
    // opts WITHOUT a reference key do not lift the requirement.
    expect(
      lintGraderSpecOf({ name: "r", type: "registry", grader: "nlg.meteor", opts: { alpha: 0.9 } })
        .hasReferenceOverride,
    ).toBeUndefined();
  });
});

describe("dataset lint — expected_tools vs tool-less spec (B26)", () => {
  const withTools = s("a", "1", { expected_tools: ["bash"] });

  test("warns only on a POSITIVELY tool-less spec", () => {
    expect(findExpectedToolsNoTools([withTools], false).length).toBe(1);
    expect(findExpectedToolsNoTools([withTools], true)).toEqual([]);
    expect(findExpectedToolsNoTools([withTools], undefined)).toEqual([]);
    expect(findExpectedToolsNoTools([s("b", "2")], false)).toEqual([]);
  });
});

describe("dataset lint — provenance taxonomy (B22)", () => {
  test("off-taxonomy values warn per distinct value, listing offenders", () => {
    const findings = findOffTaxonomyProvenance([
      // B22 — "mine" is a legacy tool tag, not a taxonomy member (mine now
      // stamps "production_log"), so it warns like any free-form value.
      s("a", "1", { metadata: { source: "mine" } }),
      s("b", "2", { metadata: { source: "synthesize" } }),
      s("c", "3", { metadata: { source: "synthesize" } }),
      s("d", "4", { metadata: { source: "manual" } }),
      s("e", "5"), // untagged — fine
    ]);
    expect(findings.length).toBe(3);
    const synthesize = findings.find((f) => f.message.includes('"synthesize"'));
    expect(synthesize?.sampleIds).toEqual(["b", "c"]);
    const mine = findings.find((f) => f.message.includes('"mine"'));
    expect(mine?.sampleIds).toEqual(["a"]);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  test("every taxonomy member is accepted", () => {
    const members = [
      "human_authored",
      "production_log",
      "synthetic",
      "synthetic_human_verified",
      "canary",
    ];
    expect(
      findOffTaxonomyProvenance(
        members.map((m, i) => s(`s${i}`, "x", { metadata: { source: m } })),
      ),
    ).toEqual([]);
  });
});

describe("dataset lint — empty golds (B26)", () => {
  test("empty/whitespace expected_output is an error; absent is fine", () => {
    const findings = findEmptyGolds([
      s("a", "1", { expected_output: "" }),
      s("b", "2", { expected_output: "   " }),
      s("c", "3", { expected_output: "real" }),
      s("d", "4"),
    ]);
    expect(findings.length).toBe(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.sampleIds).toEqual(["a", "b"]);
  });
});

describe("dataset lint — canary leak scan (B18)", () => {
  test("extracts phrases from canary samples only, and flags prompt-side leaks", () => {
    const canary = canarySample("smoke", "v3");
    const phrases = canaryPhrasesIn([s("a", "0123456789abcdef0123456789abcdef ordinary"), canary]);
    expect(phrases.length).toBe(1);
    expect(phrases[0]?.phrase).toBe(canaryPhrase("smoke", "v3"));

    const leaked = findCanaryLeaks(phrases, [
      { label: "crewhaus.yaml", text: `instructions: mention ${canaryPhrase("smoke", "v3")}` },
      { label: "clean.yaml", text: "nothing here" },
    ]);
    expect(leaked.length).toBe(1);
    expect(leaked[0]?.severity).toBe("error");
    expect(leaked[0]?.message).toContain("crewhaus.yaml");
    expect(findCanaryLeaks(phrases, [{ label: "clean", text: "no phrase" }])).toEqual([]);
  });

  test("canary phrases are deterministic per (name, version) and distinct across versions", () => {
    expect(canaryPhrase("d", "v1")).toBe(canaryPhrase("d", "v1"));
    expect(canaryPhrase("d", "v1")).not.toBe(canaryPhrase("d", "v2"));
    expect(canaryPhrase("d", "v1")).not.toBe(canaryPhrase("e", "v1"));
    expect(canaryPhrase("d", "v1")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("dataset lint — orchestrator + rendering", () => {
  test("context-less lint runs only the sample-local rules; errors sort first", () => {
    const findings = lintDataset({
      samples: [
        s("dup", "1"),
        s("dup", "2"),
        s("x", "3", { metadata: { source: "weird" } }),
        // expected_tools present but no specHasTools context → rule skipped.
        s("y", "4", { expected_tools: ["bash"] }),
      ],
    });
    expect(findings.some((f) => f.rule === "duplicate-id")).toBe(true);
    expect(findings.some((f) => f.rule === "provenance-source")).toBe(true);
    expect(findings.some((f) => f.rule === "expected-tools-no-tools")).toBe(false);
    expect(findings.some((f) => f.rule === "grader-gold-mismatch")).toBe(false);
    expect(findings[0]?.severity).toBe("error");
  });

  test("a clean dataset renders a clean summary line", () => {
    const lines = renderLintFindings([], "smoke@v1");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("0 error(s), 0 warning(s) — clean");
  });

  test("findings render one severity-tagged line each", () => {
    const findings = lintDataset({ samples: [s("dup", "1"), s("dup", "2")] });
    const lines = renderLintFindings(findings, "bad.jsonl");
    expect(lines[0]).toContain("1 error(s), 0 warning(s)");
    expect(lines[1]).toContain("ERROR duplicate-id");
  });
});

describe("eval preflight lint-lite (NEW-HUNT-10)", () => {
  const graders = [{ name: "exact", type: "exact_match" }];

  test("duplicate ids refuse", () => {
    const pf = preflightLint(
      [
        { id: "a", hasGold: true },
        { id: "a", hasGold: true },
      ],
      [],
    );
    expect(pf.refusals.length).toBe(1);
    expect(pf.refusals[0]).toContain('duplicate sample id "a"');
  });

  test("gold-needing graders over an all-goldless dataset refuse", () => {
    const pf = preflightLint(
      [
        { id: "a", hasGold: false },
        { id: "b", hasGold: false },
      ],
      graders,
    );
    expect(pf.refusals.length).toBe(1);
    expect(pf.refusals[0]).toContain("fail by construction");
  });

  test("partial gold gaps warn but do not refuse; canaries never count", () => {
    const pf = preflightLint(
      [
        { id: "a", hasGold: true },
        { id: "b", hasGold: false },
        { id: "c", hasGold: false, isCanary: true },
      ],
      graders,
    );
    expect(pf.refusals).toEqual([]);
    expect(pf.warnings.length).toBe(1);
    expect(pf.warnings[0]).toContain("1/2");
    // A fully-golded dataset + canary is silent.
    const clean = preflightLint(
      [
        { id: "a", hasGold: true },
        { id: "c", hasGold: false, isCanary: true },
      ],
      graders,
    );
    expect(clean.refusals).toEqual([]);
    expect(clean.warnings).toEqual([]);
  });

  test("a healthy dataset passes silently", () => {
    const pf = preflightLint(
      [
        { id: "a", hasGold: true },
        { id: "b", hasGold: true },
      ],
      graders,
    );
    expect(pf.refusals).toEqual([]);
    expect(pf.warnings).toEqual([]);
  });

  test("registry nlg.*/semantic.similarity graders refuse over an all-goldless dataset", () => {
    const goldless = [
      { id: "a", hasGold: false },
      { id: "b", hasGold: false },
    ];
    const pf = preflightLint(goldless, [
      { name: "rouge", type: "registry", registryGrader: "nlg.rougeL" },
    ]);
    expect(pf.refusals.length).toBe(1);
    expect(pf.refusals[0]).toContain("nlg.rougeL");
    expect(pf.refusals[0]).toContain("fail by construction");
    // opts.reference override → the pack no longer reads expected_output.
    expect(
      preflightLint(goldless, [
        {
          name: "sem",
          type: "registry",
          registryGrader: "semantic.similarity",
          hasReferenceOverride: true,
        },
      ]).refusals,
    ).toEqual([]);
    // Unknown registry refs never trip the pre-spend gate.
    expect(
      preflightLint(goldless, [{ name: "x", type: "registry", registryGrader: "acme.custom" }])
        .refusals,
    ).toEqual([]);
  });
});
