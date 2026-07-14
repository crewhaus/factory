/**
 * Handoff determinism (design §2.2): same inputs → identical bytes, no model
 * call, claimed vs proven rendered distinctly.
 */
import { describe, expect, test } from "bun:test";
import { type HandoffInput, renderHandoff, renderStatus } from "./handoff";
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
