/**
 * Handoff determinism (design §2.2): same inputs → identical bytes, no model
 * call, claimed vs proven rendered distinctly.
 */
import { describe, expect, test } from "bun:test";
import {
  type HandoffInput,
  PROVEN_UNVERIFIED_LABEL,
  isProvenByAssertion,
  renderHandoff,
  renderLadderStatus,
  renderStatus,
} from "./handoff";
import type { Goal, PlanRecord, Requirement } from "./types";

const proof = {
  toolUseId: "tu_abc",
  sessionId: "sess_0123456789abcdef",
  toolName: "Bash",
  inputHash: "sha256:00",
  resultDigest: "42 pass",
  verifiedAt: "2026-07-13T00:00:00.000Z",
};

const plan: PlanRecord = {
  id: "plan-0001",
  slug: "ship-csv-export",
  title: "Ship CSV export",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T01:00:00.000Z",
  steps: [
    { index: 1, text: "Parse the CSV", status: "proven", proofs: [proof] },
    { index: 2, text: "Write the exporter", status: "claimed", proofs: [] },
    { index: 3, text: "Add tests", status: "open", proofs: [] },
  ],
};

const otherPlan: PlanRecord = {
  id: "plan-0002",
  slug: "fix-auth",
  title: "Fix auth",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  steps: [{ index: 1, text: "Rotate keys", status: "in_progress", proofs: [] }],
};

const goals: Goal[] = [
  {
    id: "goal-0001",
    title: "Increase coverage",
    status: "claimed",
    target: 80,
    current: 40,
    unit: "%",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  },
];

const requirements: Requirement[] = [
  {
    id: "REQ-001",
    text: "RFC-4180 quoting",
    status: "confirmed",
    source: { sessionId: "sess_0123456789abcdef", turn: 1 },
  },
  {
    id: "REQ-002",
    text: "tab delimiter",
    status: "open",
    source: { sessionId: "sess_0123456789abcdef", turn: 4 },
  },
];

const input: HandoffInput = {
  focusBody: "Ship CSV export",
  activePlan: plan,
  plans: [plan, otherPlan],
  goals,
  requirements,
  lastSessionId: "sess_0123456789abcdef",
};

describe("renderHandoff", () => {
  test("same inputs → byte-identical output", () => {
    const a = renderHandoff(input);
    const b = renderHandoff({ ...input });
    expect(a).toBe(b);
  });

  test("marks claimed vs proven distinctly", () => {
    const out = renderHandoff(input);
    expect(out).toContain("1. [proven] Parse the CSV — proof: tu_abc (sess_0123456789abcdef)");
    expect(out).toContain("2. [claimed — unverified] Write the exporter");
    expect(out).toContain("3. [open] Add tests");
    expect(out).toContain("- goal-0001 [claimed — unverified] Increase coverage (40/80 %)");
  });

  test("renders unresolved requirements only (open), verbatim-quoted", () => {
    const out = renderHandoff(input);
    expect(out).toContain('- REQ-002 [open] "tab delimiter"');
    expect(out).not.toContain("REQ-001");
  });

  test("derives next actions: claimed → in_progress → open, capped", () => {
    const out = renderHandoff(input);
    const nextSection = out.slice(out.indexOf("## Next actions"));
    expect(nextSection).toContain(
      "1. Verify or redo: Write the exporter (plan-0001 step 2 is claimed but unproven)",
    );
    expect(nextSection).toContain("2. Do: Add tests (plan-0001 step 3)");
  });

  test("lists other plans with open steps and the last session id", () => {
    const out = renderHandoff(input);
    expect(out).toContain("- plan-0002 — Fix auth (0/1 steps proven)");
    expect(out.trimEnd().endsWith("sess_0123456789abcdef")).toBe(true);
  });

  test("renders placeholders on an empty store", () => {
    const out = renderHandoff({
      focusBody: "",
      activePlan: null,
      plans: [],
      goals: [],
      requirements: [],
    });
    expect(out).toContain("_no focus set_");
    expect(out).toContain("_none_");
    expect(out).toContain("_unknown_");
    // Still deterministic.
    expect(out).toBe(
      renderHandoff({ focusBody: "", activePlan: null, plans: [], goals: [], requirements: [] }),
    );
  });
});

describe("renderStatus", () => {
  test("claimed is explicitly unverified; everything else is plain", () => {
    expect(renderStatus("claimed")).toBe("[claimed — unverified]");
    expect(renderStatus("proven")).toBe("[proven]");
    expect(renderStatus("open")).toBe("[open]");
  });
});

// ---------------------------------------------------------------------------
// design/0.8.0 §6.3 — proven by assertion (`continuity.proof: off`)
// ---------------------------------------------------------------------------

const asserted = {
  toolUseId: "tu_said",
  sessionId: "sess_0123456789abcdef",
  recordedAt: "2026-10-22T00:00:00.000Z",
};

describe("renderLadderStatus / isProvenByAssertion", () => {
  test("matches renderStatus for every record the ladder writes", () => {
    for (const status of ["open", "in_progress", "claimed", "proven"]) {
      expect(renderLadderStatus({ status })).toBe(renderStatus(status));
      expect(renderLadderStatus({ status, unverified: [] })).toBe(renderStatus(status));
    }
  });

  test("proven with unverified refs renders apart from a verified ✓", () => {
    const record = { status: "proven", unverified: [asserted] };
    expect(isProvenByAssertion(record)).toBe(true);
    expect(renderLadderStatus(record)).toBe(PROVEN_UNVERIFIED_LABEL);
    expect(PROVEN_UNVERIFIED_LABEL).toBe("[proven (unverified)]");
  });

  test("unverified refs on a reopened record do not make it proven", () => {
    const record = { status: "claimed", unverified: [asserted] };
    expect(isProvenByAssertion(record)).toBe(false);
    expect(renderLadderStatus(record)).toBe("[claimed — unverified]");
  });
});

describe("renderHandoff — proven by assertion", () => {
  const offPlan: PlanRecord = {
    ...plan,
    steps: [
      plan.steps[0] as PlanRecord["steps"][number],
      {
        index: 2,
        text: "Write the exporter",
        status: "proven",
        proofs: [],
        unverified: [asserted],
      },
      {
        index: 3,
        text: "Add tests",
        status: "proven",
        proofs: [],
        unverified: [{ toolUseId: "tu_bare", recordedAt: "2026-10-22T00:00:00.000Z" }],
      },
    ],
  };
  const offInput: HandoffInput = { ...input, activePlan: offPlan, plans: [offPlan, otherPlan] };

  test("each step says how it was proven; the summary counts the unchecked ones", () => {
    const out = renderHandoff(offInput);
    expect(out).toContain("plan-0001 — Ship CSV export (3/3 steps proven, 2 unverified)");
    expect(out).toContain("1. [proven] Parse the CSV — proof: tu_abc (sess_0123456789abcdef)");
    expect(out).toContain(
      "2. [proven (unverified)] Write the exporter — cited, not verified: tu_said (sess_0123456789abcdef)",
    );
    expect(out).toContain("3. [proven (unverified)] Add tests — cited, not verified: tu_bare");
  });

  test("a proven-by-assertion plan is not an open plan and leaves no next action", () => {
    const out = renderHandoff(offInput);
    expect(out).not.toContain("Verify or redo");
    expect(out.slice(out.indexOf("## Next actions"))).toContain("_none_");
  });

  test("an asserted goal is proven (not listed as open); a reopened one renders by status", () => {
    const out = renderHandoff({
      ...offInput,
      goals: [
        { ...(goals[0] as Goal), status: "proven", unverified: [asserted] },
        { ...(goals[0] as Goal), id: "goal-0002", status: "claimed", unverified: [asserted] },
      ],
    });
    expect(out).not.toContain("goal-0001");
    expect(out).toContain("- goal-0002 [claimed — unverified] Increase coverage (40/80 %)");
  });

  test("still deterministic", () => {
    expect(renderHandoff(offInput)).toBe(renderHandoff({ ...offInput }));
  });
});
