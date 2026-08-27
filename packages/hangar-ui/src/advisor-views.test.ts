/**
 * The Advisor tab/board's PURE decisions: item → action face, fleet payload
 * → ranked rows, eval series → trend bars, severity → dot state. The render
 * functions are thin DOM builders over these (the M2 testing shape).
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import {
  itemActionModel,
  rankAdvisorRows,
  severityDot,
  trendBars,
} from "../assets/js/views/advisor.js";

describe("severityDot", () => {
  test("maps the three severities; junk degrades to unknown", () => {
    expect(severityDot("critical")).toBe("bad");
    expect(severityDot("warn")).toBe("warn");
    expect(severityDot("suggestion")).toBe("unknown");
    expect(severityDot("???")).toBe("unknown");
  });
});

describe("itemActionModel", () => {
  const ID = "hrn_0123456789abcdef";

  test("a job action renders as an executable button with its CLI twin", () => {
    const model = itemActionModel(
      {
        screen: "evals",
        action: {
          kind: "job",
          jobKind: "optimize",
          label: "Queue an optimize run",
          cliTwin: "crewhaus optimize crewhaus.yaml",
        },
      },
      ID,
    );
    expect(model).toEqual({
      kind: "job",
      label: "Queue an optimize run",
      cliTwin: "crewhaus optimize crewhaus.yaml",
    });
  });

  test("a link action deep-links the harness tab that owns the fix", () => {
    const model = itemActionModel(
      { screen: "creds", action: { kind: "link", label: "Open creds", cliTwin: null } },
      ID,
    );
    expect(model.kind).toBe("link");
    expect(model.href).toBe(`#/h/${ID}/creds`);
  });

  test("the approvals screen is a FLEET link, not a harness tab", () => {
    const model = itemActionModel(
      { screen: "approvals", action: { kind: "link", label: "Open approvals", cliTwin: null } },
      ID,
    );
    expect(model.href).toBe("#/approvals");
  });

  test("no action still says so instead of rendering nothing", () => {
    const model = itemActionModel({ screen: "spec", action: null }, ID);
    expect(model.kind).toBe("none");
    expect(model.label.length).toBeGreaterThan(0);
  });
});

describe("rankAdvisorRows", () => {
  test("worst first: critical count, then open count, ties by name — stable across polls", () => {
    const rows = rankAdvisorRows({
      harnesses: [
        {
          id: "a",
          specName: "alpha",
          open: 1,
          critical: 0,
          warn: 1,
          suggestion: 0,
          optimal: false,
        },
        { id: "b", specName: "beta", open: 3, critical: 2, warn: 1, suggestion: 0, optimal: false },
        { id: "c", specName: "gamma", open: 0, critical: 0, warn: 0, suggestion: 0, optimal: true },
        {
          id: "d",
          specName: "delta",
          open: 1,
          critical: 0,
          warn: 0,
          suggestion: 1,
          optimal: false,
        },
      ],
    });
    expect(rows.map((r: { id: string }) => r.id)).toEqual(["b", "a", "d", "c"]);
  });

  test("junk payloads degrade to an empty board, never a throw", () => {
    expect(rankAdvisorRows(null)).toEqual([]);
    expect(rankAdvisorRows({ harnesses: "nope" })).toEqual([]);
  });
});

describe("trendBars", () => {
  test("pass rates clamp into [0.05, 1] and non-numbers drop out", () => {
    expect(
      trendBars([{ passRate: 0 }, { passRate: 0.5 }, { passRate: 1.2 }, { passRate: "x" }, {}]),
    ).toEqual([0.05, 0.5, 1]);
  });

  test("junk series render no bars", () => {
    expect(trendBars(undefined)).toEqual([]);
  });
});
