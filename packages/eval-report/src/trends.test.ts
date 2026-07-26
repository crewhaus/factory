import { describe, expect, test } from "bun:test";
import type { RunIndexEntry } from "./history";
import { buildTrends, formatTrendSummaryLines, renderTrends, trendTable } from "./trends";

function entry(overrides: Partial<RunIndexEntry> & { runId: string }): RunIndexEntry {
  return {
    specName: "concierge",
    specHash: "spec1",
    datasetName: "smoke",
    datasetHash: "d".repeat(64),
    passRate: 0.5,
    meanScore: 0.5,
    sampleCount: 10,
    ts: "2026-07-01T00:00:00.000Z",
    outDir: `/abs/evals/${overrides.runId}`,
    ...overrides,
  };
}

describe("buildTrends (C31)", () => {
  test("groups by (spec, dataset) and orders points oldest first", () => {
    const series = buildTrends([
      entry({ runId: "run_c", ts: "2026-07-03T00:00:00.000Z", passRate: 0.9 }),
      entry({ runId: "run_a", ts: "2026-07-01T00:00:00.000Z", passRate: 0.6 }),
      entry({ runId: "run_z", datasetName: "hard", ts: "2026-07-02T00:00:00.000Z" }),
      entry({ runId: "run_b", ts: "2026-07-02T00:00:00.000Z", passRate: 0.7 }),
    ]);
    expect(series.map((s) => `${s.specName}/${s.datasetName}`)).toEqual([
      "concierge/smoke",
      "concierge/hard",
    ]);
    expect(series[0]?.points.map((p) => p.runId)).toEqual(["run_a", "run_b", "run_c"]);
  });

  test("carries the ops columns through, and marks the pinned baseline", () => {
    const series = buildTrends(
      [
        entry({ runId: "run_a", costUsd: 0.0123, p95LatencyMs: 900, flakyCount: 2 }),
        entry({ runId: "run_b", ts: "2026-07-02T00:00:00.000Z", partial: true }),
      ],
      { pinnedRunIds: new Set(["run_a"]) },
    );
    const [first, second] = series[0]?.points ?? [];
    expect(first).toMatchObject({
      costUsd: 0.0123,
      p95LatencyMs: 900,
      flakyCount: 2,
      pinned: true,
    });
    expect(second?.partial).toBe(true);
    expect(second?.pinned).toBeUndefined();
  });

  test("a zero flake count is not carried (the column is a flag, not a statistic)", () => {
    const series = buildTrends([entry({ runId: "run_a", flakyCount: 0 })]);
    expect(series[0]?.points[0]?.flakyCount).toBeUndefined();
  });

  test("unparseable timestamps keep index order instead of throwing", () => {
    const series = buildTrends([
      entry({ runId: "run_a", ts: "not-a-date" }),
      entry({ runId: "run_b", ts: "also-bad" }),
    ]);
    expect(series[0]?.points.map((p) => p.runId)).toEqual(["run_a", "run_b"]);
  });
});

describe("trendTable + summary lines", () => {
  test("renders one row per run with n/a for unpriced/unmeasured columns", () => {
    const series = buildTrends([entry({ runId: "run_a" })]);
    const { header, rows } = trendTable(series);
    expect(header).toContain("cost_usd");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      "concierge",
      "smoke",
      "2026-07-01T00:00:00.000Z",
      "run_a",
      "50.0%",
      "0.500",
      "10",
      "n/a",
      "n/a",
      "",
      "",
    ]);
  });

  test("summary reports the delta in percentage POINTS", () => {
    const series = buildTrends([
      entry({ runId: "run_a", passRate: 0.4, meanScore: 0.4 }),
      entry({ runId: "run_b", ts: "2026-07-05T00:00:00.000Z", passRate: 0.5, meanScore: 0.55 }),
    ]);
    const [line] = formatTrendSummaryLines(series);
    expect(line).toContain("pass_rate 40.0% → 50.0% (+10.0pp)");
    expect(line).toContain("mean_score 0.400 → 0.550 (+0.150)");
  });

  test("a single-run lineage says there is no trend rather than inventing one", () => {
    const [line] = formatTrendSummaryLines(buildTrends([entry({ runId: "run_a" })]));
    expect(line).toContain("no trend yet");
  });

  test("cost and flake totals ride the summary when present", () => {
    const [line] = formatTrendSummaryLines(
      buildTrends([
        entry({ runId: "run_a", costUsd: 0.01, flakyCount: 1 }),
        entry({ runId: "run_b", ts: "2026-07-02T00:00:00.000Z", costUsd: 0.02, flakyCount: 2 }),
      ]),
    );
    expect(line).toContain("cost $0.0300 over 2 priced run(s)");
    expect(line).toContain("flaky_samples=3");
  });
});

describe("renderTrends (self-contained HTML)", () => {
  const html = renderTrends(
    buildTrends([
      entry({ runId: "run_a", passRate: 0.4, costUsd: 0.01 }),
      entry({ runId: "run_b", ts: "2026-07-02T00:00:00.000Z", passRate: 0.8, costUsd: 0.02 }),
    ]),
  );

  test("draws an inline SVG chart with a point per run", () => {
    expect(html).toContain("<svg");
    expect(html).toContain("<path");
    // pass rate + mean score + cost series, two points each.
    expect([...html.matchAll(/<circle /g)]).toHaveLength(6);
  });

  test("references NO external asset (no CDN script, stylesheet, font or image)", () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).not.toMatch(/<img/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  test("sets a background wherever it sets a foreground (the shell's head CSS is DARK)", () => {
    // The trends CSS is body content, so it lands AFTER shell()'s head
    // stylesheet at identical specificity: the last rule per selector wins.
    // A rule that recolors the ink without repainting the surface leaves
    // #222 text on the shell's #0f1115/#1a1d23 — unreadable.
    const lastRule = (selector: string): string => {
      const rules = [
        ...html.matchAll(new RegExp(`(?:^|[};])\\s*${selector}\\s*\\{([^}]*)\\}`, "g")),
      ].map((m) => m[1] ?? "");
      expect(rules.length).toBeGreaterThan(0);
      return rules[rules.length - 1] as string;
    };
    for (const selector of ["body", "table", "th, td", "th"]) {
      const rule = lastRule(selector);
      expect(rule).toMatch(/(^|[;\s])color\s*:/);
      expect(rule).toMatch(/(^|[;\s])background\s*:/);
    }
    // And the winning body paint is light, matching the charts' own #fff.
    expect(lastRule("body")).toContain("background: #fff");
  });

  test("escapes spec/dataset names into the page", () => {
    const evil = renderTrends(
      buildTrends([entry({ runId: "run_a", specName: "<script>alert(1)</script>" })]),
    );
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("an empty selection renders an honest empty page", () => {
    expect(renderTrends([])).toContain("No recorded runs match.");
  });
});
