import { describe, expect, test } from "bun:test";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { UNKNOWN, chartModel } from "../assets/js/ui/chart.js";
// @ts-expect-error — hand-written browser JS, typed as text for the embed map
import { barRects, fmtUsd, sparklinePath } from "../assets/js/util.js";

const DAYS = [
  { label: "11-01", value: 0.001 },
  { label: "11-02", value: null },
  { label: "11-03", value: 0.003 },
];

describe("chartModel", () => {
  test("a summary sentence and a row per value", () => {
    const m = chartModel({
      kind: "bars",
      title: "Spend per day",
      rows: DAYS,
      format: fmtUsd,
      noun: "day",
    });
    expect(m.summary).toBe(
      "Spend per day: 3 days, lowest $0.0010, highest $0.0030, latest $0.0030. 1 day unknown.",
    );
    expect(m.rows.map((r: { label: string; text: string }) => [r.label, r.text])).toEqual([
      ["11-01", "$0.0010"],
      ["11-02", UNKNOWN],
      ["11-03", "$0.0030"],
    ]);
  });

  test("a value nobody could obtain is unknown: no bar, and never $0", () => {
    const m = chartModel({ kind: "bars", title: "Spend", rows: DAYS, format: fmtUsd });
    expect(m.bars).toHaveLength(2);
    expect(m.bars.map((b: { label: string }) => b.label)).toEqual(["11-01", "11-03"]);
    expect(m.rows[1].text).toBe("unknown");
    expect(JSON.stringify(m)).not.toContain('$0.00"');
    expect(m.summary).not.toContain("$0.00 ");
  });

  test("the bars come from the same helper the screens used, where values are known", () => {
    const m = chartModel({ kind: "bars", title: "Spend", rows: DAYS, width: 220, height: 44 });
    const rects = barRects([0.001, 0, 0.003], 220, 44);
    expect(
      m.bars.map(({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => ({
        x,
        y,
        w,
        h,
      })),
    ).toEqual([rects[0], rects[2]]);
  });

  test("a line is drawn through the known values only", () => {
    const m = chartModel({
      kind: "line",
      title: "Pass rate",
      rows: [
        { label: "a", value: 0.5 },
        { label: "b", value: null },
        { label: "c", value: 1 },
      ],
    });
    expect(m.path).toBe(sparklinePath([0.5, 1], 220, 44));
  });

  test("a rate scale draws a rate as its own height", () => {
    const m = chartModel({
      kind: "bars",
      scale: "rate",
      title: "Pass rate",
      rows: [
        { label: "a", value: 1 },
        { label: "b", value: 0.5 },
      ],
      height: 44,
    });
    expect(m.bars[0].h).toBeCloseTo(43, 1);
    expect(m.bars[1].h).toBeCloseTo(21.5, 1);
  });

  test("no rows says nothing was recorded; every value unknown says so", () => {
    expect(chartModel({ title: "Spend", rows: [] }).summary).toBe("Spend: nothing recorded yet.");
    const unknown = chartModel({
      title: "Spend",
      rows: [{ label: "a", value: null }],
      noun: "day",
    });
    expect(unknown.summary).toBe("Spend: 1 day, every value unknown.");
    expect(unknown.bars).toEqual([]);
  });

  test("labels stay strings, whatever arrives", () => {
    const m = chartModel({ title: "x", rows: [{ label: "<img src=x>", value: 1 }] });
    expect(m.rows[0].label).toBe("<img src=x>");
  });
});
