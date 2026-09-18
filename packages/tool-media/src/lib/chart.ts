/**
 * Bar, line, scatter and pie charts, laid out and emitted as SVG.
 *
 * The layout is arithmetic on the data plus a handful of fixed constants —
 * no measurement, no iteration to convergence, no randomness — so the same
 * spec renders byte-identical SVG on every machine. The one approximation
 * is label width (see `estimateTextWidth`), which is deliberately an
 * estimate so it cannot vary with installed fonts.
 */
import { MediaFormatError } from "./bytes";
import {
  FONT_STACK,
  circle,
  escapeXml,
  estimateTextWidth,
  formatValue,
  line,
  niceScale,
  num,
  paletteColor,
  polyline,
  rect,
  svgDocument,
  text,
} from "./svg";

export type ChartType = "bar" | "line" | "scatter" | "pie";

export type ChartSeries = {
  readonly name: string;
  /** Bar charts: one value per category. */
  readonly values?: ReadonlyArray<number>;
  /** Line and scatter charts: `[x, y]` pairs. */
  readonly points?: ReadonlyArray<readonly [number, number]>;
};

export type ChartSlice = { readonly label: string; readonly value: number };

export type ChartSpec = {
  readonly type: ChartType;
  readonly title?: string;
  readonly width: number;
  readonly height: number;
  readonly categories?: ReadonlyArray<string>;
  readonly series?: ReadonlyArray<ChartSeries>;
  readonly slices?: ReadonlyArray<ChartSlice>;
  readonly xLabel?: string;
  readonly yLabel?: string;
  readonly colors?: ReadonlyArray<string>;
  readonly background?: string;
  readonly legend?: boolean;
  /** Bar charts only: stack the series instead of grouping them. */
  readonly stacked?: boolean;
};

const AXIS = "#8a919b";
const GRID = "#e2e5ea";
const INK = "#1f2329";
const MUTED = "#5a6069";
const TITLE_SIZE = 16;
const LABEL_SIZE = 12;
const TICK_SIZE = 11;

function colorAt(spec: ChartSpec, index: number): string {
  const custom = spec.colors?.[index % Math.max(1, spec.colors.length)];
  return custom ?? paletteColor(index);
}

function requireFinite(values: ReadonlyArray<number>, what: string): void {
  for (const value of values) {
    if (!Number.isFinite(value)) throw new MediaFormatError(`${what} contains ${value}`);
  }
}

/** Legend rows, laid out in one horizontal strip under the plot. */
function legendStrip(
  names: ReadonlyArray<string>,
  spec: ChartSpec,
  y: number,
  width: number,
): string[] {
  const out: string[] = [];
  const swatch = 10;
  const gap = 16;
  const widths = names.map((name) => swatch + 5 + estimateTextWidth(name, LABEL_SIZE));
  const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, names.length - 1);
  let x = Math.max(8, (width - total) / 2);
  for (let i = 0; i < names.length; i++) {
    out.push(rect(x, y - swatch + 2, swatch, swatch, colorAt(spec, i), 'rx="2"'));
    out.push(text(x + swatch + 5, y, names[i] as string, LABEL_SIZE, { fill: MUTED }));
    x += (widths[i] as number) + gap;
  }
  return out;
}

type Plot = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

/** Margins, derived from what the chart actually has to show. */
function plotArea(spec: ChartSpec, yTickLabels: ReadonlyArray<string>, legendRows: number): Plot {
  const widest = yTickLabels.reduce(
    (w, label) => Math.max(w, estimateTextWidth(label, TICK_SIZE)),
    0,
  );
  const left = Math.ceil(12 + widest + 8 + (spec.yLabel === undefined ? 0 : LABEL_SIZE + 6));
  const top = spec.title === undefined ? 16 : 16 + TITLE_SIZE + 10;
  const bottom =
    16 + TICK_SIZE + 8 + (spec.xLabel === undefined ? 0 : LABEL_SIZE + 6) + legendRows * 22;
  return { left, top, right: spec.width - 16, bottom: spec.height - bottom };
}

function axisFrame(
  spec: ChartSpec,
  plot: Plot,
  yTicks: ReadonlyArray<number>,
  yMin: number,
  yMax: number,
): string[] {
  const out: string[] = [];
  const span = yMax - yMin;
  for (const tick of yTicks) {
    const y = plot.bottom - ((tick - yMin) / span) * (plot.bottom - plot.top);
    out.push(line(plot.left, y, plot.right, y, GRID, 1));
    out.push(
      text(plot.left - 6, y, formatValue(tick), TICK_SIZE, {
        fill: MUTED,
        anchor: "end",
        baseline: "middle",
      }),
    );
  }
  out.push(line(plot.left, plot.top, plot.left, plot.bottom, AXIS, 1));
  out.push(line(plot.left, plot.bottom, plot.right, plot.bottom, AXIS, 1));
  if (spec.yLabel !== undefined) {
    const cx = 14;
    const cy = (plot.top + plot.bottom) / 2;
    out.push(
      `<g transform="rotate(-90 ${num(cx)} ${num(cy)})">${text(cx, cy, spec.yLabel, LABEL_SIZE, { fill: MUTED, anchor: "middle", baseline: "middle" })}</g>`,
    );
  }
  return out;
}

function renderBar(spec: ChartSpec): string {
  const categories = spec.categories ?? [];
  const series = spec.series ?? [];
  if (categories.length === 0) throw new MediaFormatError("a bar chart needs `categories`");
  if (series.length === 0) throw new MediaFormatError("a bar chart needs at least one series");
  for (const s of series) {
    if (s.values === undefined) {
      throw new MediaFormatError(`bar series "${s.name}" needs \`values\``);
    }
    if (s.values.length !== categories.length) {
      throw new MediaFormatError(
        `bar series "${s.name}" has ${s.values.length} values but there are ${categories.length} categories`,
      );
    }
    requireFinite(s.values, `bar series "${s.name}"`);
  }

  const stacked = spec.stacked === true && series.length > 1;
  const columnTotals = categories.map((_, i) =>
    series.reduce((sum, s) => sum + ((s.values as ReadonlyArray<number>)[i] as number), 0),
  );
  const flat = series.flatMap((s) => [...(s.values as ReadonlyArray<number>)]);
  const dataMin = stacked ? Math.min(0, ...columnTotals) : Math.min(0, ...flat);
  const dataMax = stacked ? Math.max(0, ...columnTotals) : Math.max(0, ...flat);
  const scale = niceScale(dataMin, dataMax, 5);
  const legendRows = (spec.legend ?? series.length > 1) ? 1 : 0;
  const plot = plotArea(spec, scale.ticks.map(formatValue), legendRows);
  const body: string[] = [];
  if (spec.title !== undefined) {
    body.push(
      text(spec.width / 2, 16 + TITLE_SIZE, spec.title, TITLE_SIZE, {
        fill: INK,
        anchor: "middle",
        weight: "bold",
      }),
    );
  }
  body.push(...axisFrame(spec, plot, scale.ticks, scale.min, scale.max));

  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const span = scale.max - scale.min;
  const slot = plotWidth / categories.length;
  const bandPadding = Math.min(12, slot * 0.2);
  const band = slot - bandPadding;
  const barWidth = stacked ? band : band / series.length;
  const zeroY = plot.bottom - ((0 - scale.min) / span) * plotHeight;

  for (let c = 0; c < categories.length; c++) {
    const slotLeft = plot.left + c * slot + bandPadding / 2;
    let stackTop = 0;
    let stackBottom = 0;
    for (let s = 0; s < series.length; s++) {
      const value = (series[s]?.values as ReadonlyArray<number>)[c] as number;
      let y0: number;
      let y1: number;
      if (stacked) {
        const base = value >= 0 ? stackTop : stackBottom;
        const tip = base + value;
        if (value >= 0) stackTop = tip;
        else stackBottom = tip;
        y0 = plot.bottom - ((Math.max(base, tip) - scale.min) / span) * plotHeight;
        y1 = plot.bottom - ((Math.min(base, tip) - scale.min) / span) * plotHeight;
      } else {
        const valueY = plot.bottom - ((value - scale.min) / span) * plotHeight;
        y0 = Math.min(valueY, zeroY);
        y1 = Math.max(valueY, zeroY);
      }
      const x = stacked ? slotLeft : slotLeft + s * barWidth;
      body.push(
        rect(
          x,
          y0,
          Math.max(1, barWidth - (stacked ? 0 : 1)),
          Math.max(0, y1 - y0),
          colorAt(spec, s),
        ),
      );
    }
    body.push(
      text(slotLeft + band / 2, plot.bottom + TICK_SIZE + 6, categories[c] as string, TICK_SIZE, {
        fill: MUTED,
        anchor: "middle",
      }),
    );
  }

  if (spec.xLabel !== undefined) {
    body.push(
      text(
        (plot.left + plot.right) / 2,
        plot.bottom + TICK_SIZE + 6 + LABEL_SIZE + 6,
        spec.xLabel,
        LABEL_SIZE,
        { fill: MUTED, anchor: "middle" },
      ),
    );
  }
  if (legendRows > 0) {
    body.push(
      ...legendStrip(
        series.map((s) => s.name),
        spec,
        spec.height - 12,
        spec.width,
      ),
    );
  }
  return svgDocument(spec.width, spec.height, spec.background ?? "#ffffff", body, spec.title);
}

function renderXy(spec: ChartSpec, mode: "line" | "scatter"): string {
  const series = spec.series ?? [];
  if (series.length === 0) throw new MediaFormatError(`a ${mode} chart needs at least one series`);
  for (const s of series) {
    if (s.points === undefined || s.points.length === 0) {
      throw new MediaFormatError(`${mode} series "${s.name}" needs a non-empty \`points\` array`);
    }
    requireFinite(
      s.points.flatMap((p) => [p[0], p[1]]),
      `${mode} series "${s.name}"`,
    );
  }
  const xs = series.flatMap((s) =>
    (s.points as ReadonlyArray<readonly [number, number]>).map((p) => p[0]),
  );
  const ys = series.flatMap((s) =>
    (s.points as ReadonlyArray<readonly [number, number]>).map((p) => p[1]),
  );
  const xScale = niceScale(Math.min(...xs), Math.max(...xs), 6);
  const yScale = niceScale(Math.min(...ys), Math.max(...ys), 5);
  const legendRows = (spec.legend ?? series.length > 1) ? 1 : 0;
  const plot = plotArea(spec, yScale.ticks.map(formatValue), legendRows);
  const body: string[] = [];
  if (spec.title !== undefined) {
    body.push(
      text(spec.width / 2, 16 + TITLE_SIZE, spec.title, TITLE_SIZE, {
        fill: INK,
        anchor: "middle",
        weight: "bold",
      }),
    );
  }
  body.push(...axisFrame(spec, plot, yScale.ticks, yScale.min, yScale.max));

  const toX = (value: number): number =>
    plot.left + ((value - xScale.min) / (xScale.max - xScale.min)) * (plot.right - plot.left);
  const toY = (value: number): number =>
    plot.bottom - ((value - yScale.min) / (yScale.max - yScale.min)) * (plot.bottom - plot.top);

  for (const tick of xScale.ticks) {
    body.push(
      text(toX(tick), plot.bottom + TICK_SIZE + 6, formatValue(tick), TICK_SIZE, {
        fill: MUTED,
        anchor: "middle",
      }),
    );
  }

  for (let s = 0; s < series.length; s++) {
    const points = series[s]?.points as ReadonlyArray<readonly [number, number]>;
    // Sorted by x so a line never doubles back on itself for the same data
    // given in a different order — the same series always draws the same.
    const ordered = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const mapped: Array<[number, number]> = ordered.map((p) => [toX(p[0]), toY(p[1])]);
    const color = colorAt(spec, s);
    if (mode === "line") {
      body.push(polyline(mapped, color, 2));
      for (const [x, y] of mapped) body.push(circle(x, y, 2.5, color));
    } else {
      for (const [x, y] of mapped) body.push(circle(x, y, 3.5, color));
    }
  }

  if (spec.xLabel !== undefined) {
    body.push(
      text(
        (plot.left + plot.right) / 2,
        plot.bottom + TICK_SIZE + 6 + LABEL_SIZE + 6,
        spec.xLabel,
        LABEL_SIZE,
        { fill: MUTED, anchor: "middle" },
      ),
    );
  }
  if (legendRows > 0) {
    body.push(
      ...legendStrip(
        series.map((s) => s.name),
        spec,
        spec.height - 12,
        spec.width,
      ),
    );
  }
  return svgDocument(spec.width, spec.height, spec.background ?? "#ffffff", body, spec.title);
}

function renderPie(spec: ChartSpec): string {
  const slices = spec.slices ?? [];
  if (slices.length === 0) throw new MediaFormatError("a pie chart needs `slices`");
  requireFinite(
    slices.map((s) => s.value),
    "pie slices",
  );
  for (const slice of slices) {
    if (slice.value < 0) {
      throw new MediaFormatError(
        `slice "${slice.label}" is ${slice.value}; a pie cannot show a negative share`,
      );
    }
  }
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) throw new MediaFormatError("every slice is zero, so there is no pie to draw");

  const body: string[] = [];
  const top = spec.title === undefined ? 16 : 16 + TITLE_SIZE + 10;
  if (spec.title !== undefined) {
    body.push(
      text(spec.width / 2, 16 + TITLE_SIZE, spec.title, TITLE_SIZE, {
        fill: INK,
        anchor: "middle",
        weight: "bold",
      }),
    );
  }
  const legendHeight = 22 * Math.ceil(slices.length / 3) + 8;
  const available = spec.height - top - legendHeight - 12;
  const radius = Math.max(10, Math.min(available, spec.width - 32) / 2);
  const cx = spec.width / 2;
  const cy = top + available / 2;

  let angle = -Math.PI / 2; // start at twelve o'clock
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i] as ChartSlice;
    const sweep = (slice.value / total) * Math.PI * 2;
    const color = colorAt(spec, i);
    if (sweep <= 0) continue;
    if (sweep >= Math.PI * 2 - 1e-9) {
      body.push(circle(cx, cy, radius, color));
    } else {
      const x0 = cx + radius * Math.cos(angle);
      const y0 = cy + radius * Math.sin(angle);
      const x1 = cx + radius * Math.cos(angle + sweep);
      const y1 = cy + radius * Math.sin(angle + sweep);
      const largeArc = sweep > Math.PI ? 1 : 0;
      body.push(
        `<path d="M ${num(cx)} ${num(cy)} L ${num(x0)} ${num(y0)} A ${num(radius)} ${num(radius)} 0 ${largeArc} 1 ${num(x1)} ${num(y1)} Z" fill="${escapeXml(color)}"/>`,
      );
    }
    angle += sweep;
  }

  // Legend: three columns, each row a swatch, a label and the share.
  const columns = Math.min(3, slices.length);
  const columnWidth = (spec.width - 32) / columns;
  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i] as ChartSlice;
    const column = i % columns;
    const row = Math.floor(i / columns);
    const x = 16 + column * columnWidth;
    const y = spec.height - legendHeight + 12 + row * 22;
    const percent = Math.round((slice.value / total) * 1000) / 10;
    body.push(rect(x, y - 9, 10, 10, colorAt(spec, i), 'rx="2"'));
    body.push(text(x + 15, y, `${slice.label} (${num(percent)}%)`, LABEL_SIZE, { fill: MUTED }));
  }
  return svgDocument(spec.width, spec.height, spec.background ?? "#ffffff", body, spec.title);
}

/** The font stack the renderers name, re-exported for the tests. */
export const CHART_FONT_STACK = FONT_STACK;

/** Render a chart spec to a complete SVG document. */
export function renderChart(spec: ChartSpec): string {
  if (spec.width < 120 || spec.height < 80) {
    throw new MediaFormatError(
      `${spec.width}x${spec.height} is too small to draw a readable chart`,
    );
  }
  switch (spec.type) {
    case "bar":
      return renderBar(spec);
    case "line":
      return renderXy(spec, "line");
    case "scatter":
      return renderXy(spec, "scatter");
    case "pie":
      return renderPie(spec);
  }
}
