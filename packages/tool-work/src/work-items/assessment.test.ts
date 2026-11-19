import { describe, expect, test } from "bun:test";
import {
  checkProposal,
  demandEvidence,
  evidenceWords,
  hasObservedEvidence,
  parseAssessment,
} from "./assessment";

const NOW = "2026-11-18T00:00:00.000Z";
const REPORTED = {
  label: "reported",
  kind: "user-report",
  ref: "thredz-task:t1",
  note: "Asked twice.",
};
const GUESS = { label: "hypothesis", kind: "inferred", note: "Probably useful." };

function parse(raw: unknown) {
  const parsed = parseAssessment(raw, NOW);
  if (!parsed.ok) throw new Error(`${parsed.field}: ${parsed.message}`);
  return parsed.assessment;
}

describe("the assessment's shape", () => {
  test("a minimal one parses, and evidence gets the time it was taken in", () => {
    const a = parse({ problem: "Exports are manual.", evidence: [REPORTED], counterEvidence: [] });
    expect(a.evidence[0]?.ingestedAt).toBe(NOW);
    expect(
      parse({
        problem: "x",
        evidence: [{ ...REPORTED, ingestedAt: "2026-01-01T00:00:00Z" }],
        counterEvidence: [],
      }).evidence[0]?.ingestedAt,
    ).toBe("2026-01-01T00:00:00Z");
  });

  test("simulated or inferred evidence labelled observed is refused", () => {
    for (const kind of ["simulated", "inferred"]) {
      const refused = parseAssessment(
        {
          problem: "x",
          evidence: [{ label: "observed", kind, ref: "r", note: "n" }],
          counterEvidence: [],
        },
        NOW,
      );
      expect(refused).toMatchObject({
        ok: false,
        code: "assessment_invalid",
        field: "assessment.evidence.0.label",
      });
    }
  });

  test("observed and reported evidence names where it can be checked", () => {
    const refused = parseAssessment(
      {
        problem: "x",
        evidence: [{ label: "observed", kind: "observed-usage", note: "n" }],
        counterEvidence: [],
      },
      NOW,
    );
    expect(refused).toMatchObject({ ok: false, field: "assessment.evidence.0.ref" });
  });

  test("unknown keys, levels out of range and empty problems are refused, naming the field", () => {
    const bad: readonly [unknown, string][] = [
      [{ problem: "x", evidence: [], counterEvidence: [], score: 9 }, "assessment.score"],
      [{ problem: "x", evidence: [], counterEvidence: [], cost: 4 }, "assessment.cost"],
      [{ problem: " ", evidence: [], counterEvidence: [] }, "assessment.problem"],
      [
        { problem: "x", evidence: [], counterEvidence: [], intentFit: { maybe: "y" } },
        "assessment.intentFit.maybe",
      ],
    ];
    for (const [raw, field] of bad)
      expect(parseAssessment(raw, NOW)).toMatchObject({ ok: false, field });
  });
});

describe("the proposal rules", () => {
  test("a feature without doNothing is refused", () => {
    const assessment = parse({ problem: "x", evidence: [REPORTED], counterEvidence: [] });
    expect(checkProposal({ kind: "feature", basis: "user-pain", assessment })).toMatchObject({
      ok: false,
      field: "assessment.doNothing",
    });
    expect(
      checkProposal({ kind: "feature", basis: "user-pain", assessment: undefined }),
    ).toMatchObject({
      ok: false,
      field: "assessment.doNothing",
    });
    expect(
      checkProposal({
        kind: "feature",
        basis: "user-pain",
        assessment: { ...assessment, doNothing: "Manual." },
      }).ok,
    ).toBe(true);
  });

  test("user-pain with only hypothesis evidence is refused", () => {
    const assessment = parse({ problem: "x", evidence: [GUESS], counterEvidence: [] });
    expect(checkProposal({ kind: "fix", basis: "user-pain", assessment })).toMatchObject({
      ok: false,
      field: "assessment.evidence",
    });
    expect(demandEvidence(assessment)).toEqual([]);
  });

  test("compatibility-security rests on an advisory, a dependency change or a release note", () => {
    const reported = parse({ problem: "x", evidence: [REPORTED], counterEvidence: [] });
    expect(
      checkProposal({ kind: "maintenance", basis: "compatibility-security", assessment: reported })
        .ok,
    ).toBe(false);
    const advisory = parse({
      problem: "x",
      evidence: [{ label: "reported", kind: "advisory", ref: "GHSA-1", note: "n" }],
      counterEvidence: [],
    });
    expect(
      checkProposal({ kind: "maintenance", basis: "compatibility-security", assessment: advisory })
        .ok,
    ).toBe(true);
  });

  test("every proposal says its basis; a speculative one needs no evidence", () => {
    expect(checkProposal({ kind: "fix", basis: undefined, assessment: undefined })).toMatchObject({
      field: "basis",
    });
    expect(checkProposal({ kind: "fix", basis: "speculative", assessment: undefined }).ok).toBe(
      true,
    );
  });

  test("a hypothesis reads as one, and never counts as observed", () => {
    const a = parse({ problem: "x", evidence: [GUESS, REPORTED], counterEvidence: [] });
    expect(evidenceWords(a.evidence[0] as never)).toBe("hypothesis — not observed");
    expect(evidenceWords(a.evidence[1] as never)).toBe("reported");
    expect(hasObservedEvidence(a)).toBe(false);
  });
});
