/**
 * Charts a screen reader can read. The picture is decoration (`aria-hidden`
 * SVG); the data is the `<figcaption>` summary sentence and a data table in
 * a `<details>` beside it. A value the console could not obtain is
 * "unknown": it gets no bar, and it never reads as zero. A value with an
 * unknown part (`unknownPart: true`, a day whose spend includes calls with no
 * price) keeps its bar, marked with a dashed cap, and reads "… + unknown".
 *
 * {@link chartModel} decides everything and is pure, so the summary, the
 * table and the "unknown" rule are unit tests. The geometry comes from the
 * same helpers the screens used before (`barRects`, `sparklinePath` in
 * `util.js`, `trendBars` in the Advisor), so their pins still hold.
 */

import { el, svgEl } from "../dom.js";
import { barRects, sparklinePath } from "../util.js";

/** The text a missing value shows. */
export const UNKNOWN = "unknown";

const isKnown = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * `{ kind: "bars" | "line", title, rows: [{ label, value, unknownPart? }],
 *    format, scale, noun, width, height }` → the chart's model.
 *
 *   format(value) — how a value reads (default: String)
 *   scale         — `"relative"` (bars against the largest, the default) or
 *                   `"rate"` (a 0–1 value is its own height)
 *   noun          — what one row is ("day", "run"), for the summary
 *
 * Returns { kind, title, summary, rows: [{ label, text, known }], bars,
 * marks, path, width, height }. `bars` holds one rect per KNOWN value only;
 * `marks` holds one dashed cap per bar whose value has an unknown part.
 */
export function chartModel(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const kind = o.kind === "line" ? "line" : "bars";
  const title = String(o.title ?? "Chart");
  const format = typeof o.format === "function" ? o.format : (v) => String(v);
  const noun = typeof o.noun === "string" && o.noun !== "" ? o.noun : "value";
  const width = Number.isFinite(o.width) ? Number(o.width) : 220;
  const height = Number.isFinite(o.height) ? Number(o.height) : 44;
  const input = Array.isArray(o.rows) ? o.rows : [];
  const rows = input.map((row) => {
    const value = isKnown(row?.value) ? row.value : null;
    const partial = value !== null && row?.unknownPart === true;
    return {
      label: String(row?.label ?? ""),
      value,
      known: value !== null,
      partial,
      text: value === null ? UNKNOWN : partial ? `${format(value)} + ${UNKNOWN}` : format(value),
    };
  });
  const known = rows.filter((row) => row.known);

  let summary;
  if (rows.length === 0) summary = `${title}: nothing recorded yet.`;
  else if (known.length === 0) {
    summary = `${title}: ${rows.length} ${plural(noun, rows.length)}, every value unknown.`;
  } else {
    const values = known.map((row) => row.value);
    const lowest = Math.min(...values);
    const highest = Math.max(...values);
    const latest = rows[rows.length - 1];
    const range =
      lowest === highest
        ? `each ${format(lowest)}`
        : `lowest ${format(lowest)}, highest ${format(highest)}`;
    const unknown = rows.length - known.length;
    const unknownNote = unknown > 0 ? ` ${unknown} ${plural(noun, unknown)} unknown.` : "";
    const partial = rows.filter((row) => row.partial).length;
    const partialNote = partial > 0 ? ` ${partial} ${plural(noun, partial)} partly unknown.` : "";
    summary = `${title}: ${rows.length} ${plural(noun, rows.length)}, ${range}, latest ${latest.text}.${unknownNote}${partialNote}`;
  }

  let bars = [];
  let path = "";
  if (kind === "bars") {
    if (o.scale === "rate") {
      const n = rows.length;
      const gap = 3;
      const barW = n === 0 ? 0 : (width - gap * (n - 1)) / n;
      const round = (x) => Math.round(x * 100) / 100;
      bars = rows.flatMap((row, i) => {
        if (!row.known) return [];
        const h = Math.max(0.05, Math.min(1, row.value)) * (height - 1);
        return [
          {
            x: round(i * (barW + gap)),
            y: round(height - h),
            w: round(barW),
            h: round(h),
            label: row.label,
          },
        ];
      });
    } else {
      const rects = barRects(
        rows.map((row) => (row.known ? row.value : 0)),
        width,
        height,
      );
      bars = rects.flatMap((rect, i) => (rows[i].known ? [{ ...rect, label: rows[i].label }] : []));
    }
  } else {
    path = sparklinePath(
      known.map((row) => row.value),
      width,
      height,
    );
  }
  // A dashed cap over each bar whose value has an unknown part, so a partly
  // unknown day never looks like a whole one (its text says "+ unknown").
  const partialLabels = new Set(rows.filter((row) => row.partial).map((row) => row.label));
  const marks = bars
    .filter((bar) => partialLabels.has(bar.label))
    .map((bar) => ({ x: bar.x, y: Math.max(0, bar.y - 4), w: bar.w, h: 4, label: bar.label }));
  return { kind, title, summary, rows, bars, marks, path, width, height };
}

function plural(noun, n) {
  return n === 1 ? noun : `${noun}s`;
}

/**
 * Draw a model: `<figure class="chart">`, the hidden picture, the summary as
 * the caption, and the data table folded beneath it.
 */
export function chart(model, opts = {}) {
  const m = model && typeof model === "object" ? model : chartModel({});
  const picture =
    m.kind === "line"
      ? m.path === ""
        ? null
        : svgEl(
            "svg",
            {
              class: "chart-line",
              viewBox: `0 0 ${m.width} ${m.height}`,
              "aria-hidden": "true",
              focusable: "false",
            },
            [svgEl("path", { d: m.path, "stroke-width": "2" })],
          )
      : m.bars.length === 0
        ? null
        : svgEl(
            "svg",
            {
              class: "chart-bars",
              viewBox: `0 0 ${m.width} ${m.height}`,
              "aria-hidden": "true",
              focusable: "false",
            },
            [
              ...m.bars.map((b) =>
                svgEl("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: "1" }),
              ),
              ...(Array.isArray(m.marks) ? m.marks : []).map((b) =>
                svgEl("rect", {
                  class: "chart-unknown",
                  x: b.x,
                  y: b.y,
                  width: b.w,
                  height: b.h,
                }),
              ),
            ],
          );
  const labelHead = typeof opts.labelHead === "string" ? opts.labelHead : "When";
  const valueHead = typeof opts.valueHead === "string" ? opts.valueHead : "Value";
  const table =
    m.rows.length === 0
      ? null
      : el("details", { class: "chart-data" }, [
          el("summary", { text: "Data table" }),
          el("table", null, [
            el("caption", { class: "sr-only", text: m.title }),
            el("thead", null, [
              el("tr", null, [
                el("th", { scope: "col", text: labelHead }),
                el("th", { scope: "col", class: "num", text: valueHead }),
              ]),
            ]),
            el(
              "tbody",
              null,
              m.rows.map((row) =>
                el("tr", null, [
                  el("td", { text: row.label }),
                  el("td", { class: "num", text: row.text }),
                ]),
              ),
            ),
          ]),
        ]);
  return el("figure", { class: "chart" }, [
    picture,
    el("figcaption", { class: "chart-caption", text: m.summary }),
    table,
  ]);
}
