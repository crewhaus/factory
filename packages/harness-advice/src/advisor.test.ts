/**
 * The Advisor's pure half as its own subpath: the names it exports (so a dropped export
 * fails here, not in a consumer), and the twin table arriving as data.
 */
import { describe, expect, test } from "bun:test";
import * as advisor from "./advisor";
import { type AdvisorInputs, deriveAdvisorItems } from "./advisor";

const offer = { offered: true, shapeOk: true, note: null, verb: "crewhaus eval crewhaus.yaml" };

const CLEAN: AdvisorInputs = {
  preflight: { items: [] },
  specUnreadable: false,
  specIssues: [],
  evalHealth: { state: "healthy", note: "at baseline" },
  evalRuns: 3,
  evalsUnreadable: false,
  baselinePinned: true,
  offers: { eval: offer, optimize: offer },
  openIncidents: 0,
  procState: "running",
  pendingApprovals: 0,
  budget: { declaredUsd: 10, spentUsd: 1 },
  adviceProposals: 0,
  overdueDreams: [],
  routing: null,
  routeStats: { decisions: 0, escalations: 0 },
  roleSpend: { totalUsdMicros: 0, byRole: {} },
  sunsets: [],
  unservedPins: [],
};

describe("@crewhaus/harness-advice/advisor", () => {
  test("exports exactly these runtime names", () => {
    expect(Object.keys(advisor).sort()).toEqual(
      [
        "ADVISOR_SCREENS",
        "ARM_SAMPLE_FLOOR",
        "ESCALATION_RATE_CEILING",
        "JUDGE_SPEND_SHARE",
        "SAFE_SEGMENT_RE",
        "UNDERPERFORMING_GAP",
        "assembleFeed",
        "deriveAdvisorItems",
        "foldDecisions",
      ].sort(),
    );
  });

  test("a job action shows the command the caller's twin table names, and none without one", () => {
    const inputs = { ...CLEAN, overdueDreams: ["support"] };
    const withTwins = deriveAdvisorItems(inputs, {
      "dream-run": "crewhaus dream run crewhaus.yaml",
    });
    expect(withTwins[0]?.action).toEqual({
      kind: "job",
      label: "Run the dream now",
      cliTwin: "crewhaus dream run crewhaus.yaml",
      jobKind: "dream-run",
    });
    expect(deriveAdvisorItems(inputs)[0]?.action?.cliTwin).toBeNull();
  });

  test("a clean harness derives nothing", () => {
    expect(deriveAdvisorItems(CLEAN)).toEqual([]);
  });
});
