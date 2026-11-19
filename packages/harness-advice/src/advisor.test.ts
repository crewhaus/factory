/**
 * The Advisor's pure half as its own subpath: the names it exports (so a dropped export
 * fails here, not in a consumer), and the twin table arriving as data.
 */
import { describe, expect, test } from "bun:test";
import * as advisor from "./advisor";
import {
  type AdvisorInputs,
  type DecisionRecord,
  assembleFeed,
  deriveAdvisorItems,
  specIssueKey,
} from "./advisor";

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
  openIncidents: [],
  procState: "running",
  pendingApprovals: { count: 0, newestId: "", newestAt: "" },
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
        "BUDGET_PERIOD",
        "ESCALATION_RATE_CEILING",
        "JUDGE_SPEND_SHARE",
        "LEGACY_ITEM_FAMILIES",
        "POSITIONAL_SPEC_ISSUE_RE",
        "SAFE_SEGMENT_RE",
        "UNDERPERFORMING_GAP",
        "assembleFeed",
        "deriveAdvisorItems",
        "foldDecisions",
        "specIssueKey",
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

const line = (itemId: string, at: string, action: DecisionRecord["action"] = "dismissed") =>
  ({ v: 1, itemId, action, at, by: "ana", reason: "seen it" }) as DecisionRecord;

describe("items keyed by their evidence", () => {
  const twoIncidents: AdvisorInputs = {
    ...CLEAN,
    openIncidents: [
      { id: "2026-11-01T00-00-00-guard", at: "2026-11-01T00:00:00.000Z" },
      { id: "2026-11-05T00-00-00-guard", at: "2026-11-05T00:00:00.000Z" },
    ],
  };

  test("one item per open incident, each carrying when it was written", () => {
    const items = deriveAdvisorItems(twoIncidents).filter((i) => i.source === "security");
    expect(items.map((i) => [i.id, i.evidenceAt])).toEqual([
      ["incident-2026-11-01T00-00-00-guard", "2026-11-01T00:00:00.000Z"],
      ["incident-2026-11-05T00-00-00-guard", "2026-11-05T00:00:00.000Z"],
    ]);
  });

  test("a dismissal of one incident hides only that incident, and a new one opens", () => {
    const items = deriveAdvisorItems(twoIncidents);
    const feed = assembleFeed(items, [
      line("incident-2026-11-01T00-00-00-guard", "2026-11-02T00:00:00.000Z"),
    ]);
    expect(feed.dismissed.map((i) => i.id)).toEqual(["incident-2026-11-01T00-00-00-guard"]);
    expect(feed.open.map((i) => i.id)).toContain("incident-2026-11-05T00-00-00-guard");
  });

  test("a count-keyed dismissal hides incidents written before it, never one written after", () => {
    const feed = assembleFeed(deriveAdvisorItems(twoIncidents), [
      line("incidents-open", "2026-11-03T00:00:00.000Z"),
    ]);
    expect(feed.dismissed.map((i) => i.id)).toEqual(["incident-2026-11-01T00-00-00-guard"]);
    expect(feed.open.map((i) => i.id)).toContain("incident-2026-11-05T00-00-00-guard");
  });

  test("a reopen lifts a count-keyed dismissal", () => {
    const feed = assembleFeed(deriveAdvisorItems(twoIncidents), [
      line("incidents-open", "2026-11-03T00:00:00.000Z"),
      line("incidents-open", "2026-11-04T00:00:00.000Z", "reopened"),
    ]);
    expect(feed.dismissed).toEqual([]);
  });

  test("approvals are keyed by the newest request, so a new one opens past a dismissal", () => {
    const at = "2026-11-05T00:00:00.000Z";
    const items = deriveAdvisorItems({
      ...CLEAN,
      pendingApprovals: { count: 2, newestId: "appr_0123456789abcdef", newestAt: at },
    });
    expect(items[0]?.id).toBe("approvals-pending-appr_0123456789abcdef");
    expect(items[0]?.evidenceAt).toBe(at);
    expect(deriveAdvisorItems({ ...CLEAN, pendingApprovals: null })).toEqual([]);
    const feed = assembleFeed(items, [line("approvals-pending", "2026-11-04T00:00:00.000Z")]);
    expect(feed.open.map((i) => i.id)).toEqual(["approvals-pending-appr_0123456789abcdef"]);
  });

  test("budget items name their decile and period, and a count-keyed line does not hide them", () => {
    const near = deriveAdvisorItems({ ...CLEAN, budget: { declaredUsd: 10, spentUsd: 9.1 } });
    expect(near[0]?.id).toBe("budget-near-9-total");
    const over = deriveAdvisorItems({ ...CLEAN, budget: { declaredUsd: 10, spentUsd: 12 } });
    expect(over[0]?.id).toBe("budget-exceeded-total");
    const feed = assembleFeed(near, [line("budget-near-limit", "2030-01-01T00:00:00.000Z")]);
    expect(feed.open.map((i) => i.id)).toEqual(["budget-near-9-total"]);
  });

  test("a spec issue is keyed by its message; a positional dismissal hides nothing and is reported", () => {
    const items = deriveAdvisorItems({
      ...CLEAN,
      specIssues: [{ message: "agent.model: required" }, { message: "tools[0]: unknown" }],
    });
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([
      `spec-issue-${specIssueKey("agent.model: required")}`,
      `spec-issue-${specIssueKey("tools[0]: unknown")}`,
    ]);
    // Reordering the issues keeps each one's id.
    const swapped = deriveAdvisorItems({
      ...CLEAN,
      specIssues: [{ message: "tools[0]: unknown" }, { message: "agent.model: required" }],
    }).map((i) => i.id);
    expect([...swapped].sort()).toEqual([...ids].sort());
    const feed = assembleFeed(items, [line("spec-issue-1", "2030-01-01T00:00:00.000Z")]);
    expect(feed.open).toHaveLength(2);
    expect(feed.olderSpec.map((l) => l.itemId)).toEqual(["spec-issue-1"]);
  });
});
