/**
 * SVG construction, shared by the chart, sparkline and diagram renderers.
 *
 * Determinism is the whole contract here: same data in, byte-identical SVG
 * out. That rules out `toLocaleString` (locale-dependent), `Intl` (ICU
 * version-dependent) and real text measurement (font-dependent). Numbers go
 * through `num` below, and label widths are ESTIMATED from a fixed
 * per-character advance — an estimate that is stable everywhere rather than
 * accurate on one machine.
 */

/** Escape the five characters that cannot appear raw in XML text or attributes. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * A coordinate, to at most three decimals, with no trailing zeroes and no
 * `-0`. `toFixed` then trim is stable across engines in a way that
 * `toString` on a float is not.
 */
export function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const fixed = value.toFixed(3);
  const trimmed = fixed.replace(/\.?0+$/, "");
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}

/**
 * Format a data value for an axis label or legend. Fixed rules, no locale:
 * integers plain, magnitudes at or above 10000 in thousands/millions/
 * billions with one decimal, everything else to at most three significant
 * decimals.
 */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${num(Math.round(value / 1e8) / 10)}B`;
  if (abs >= 1e6) return `${num(Math.round(value / 1e5) / 10)}M`;
  if (abs >= 1e4) return `${num(Math.round(value / 1e2) / 10)}k`;
  if (Number.isInteger(value)) return String(value);
  if (abs >= 100) return value.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1) return num(Math.round(value * 100) / 100);
  return num(Math.round(value * 1000) / 1000);
}

/**
 * Estimated rendered width of `text` at `fontSize`, in user units.
 *
 * 0.55em per character is close to the average advance of the sans-serif
 * faces this package's `font-family` names, wide enough that a label rarely
 * overflows its reserved space and narrow enough that axes do not look
 * padded. It is an estimate by design: measuring for real would make the
 * output depend on which fonts a machine has.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  return Math.round(text.length * fontSize * 0.55 * 100) / 100;
}

/** The font stack every renderer here names, ending in a generic family. */
export const FONT_STACK =
  "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export type TextAnchor = "start" | "middle" | "end";

export type TextOptions = {
  readonly fill?: string;
  readonly anchor?: TextAnchor;
  readonly weight?: "normal" | "bold";
  readonly baseline?: "auto" | "middle" | "hanging";
};

/** A `<text>` element with escaped content. */
export function text(
  x: number,
  y: number,
  content: string,
  fontSize: number,
  options: TextOptions = {},
): string {
  const parts = [`x="${num(x)}"`, `y="${num(y)}"`, `font-size="${num(fontSize)}"`];
  parts.push(`font-family="${escapeXml(FONT_STACK)}"`);
  if (options.fill !== undefined) parts.push(`fill="${escapeXml(options.fill)}"`);
  if (options.anchor !== undefined) parts.push(`text-anchor="${options.anchor}"`);
  if (options.weight === "bold") parts.push('font-weight="600"');
  if (options.baseline !== undefined && options.baseline !== "auto") {
    parts.push(`dominant-baseline="${options.baseline}"`);
  }
  return `<text ${parts.join(" ")}>${escapeXml(content)}</text>`;
}

/** A `<rect>`. */
export function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  extra = "",
): string {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="${escapeXml(fill)}"${extra === "" ? "" : ` ${extra}`}/>`;
}

/** A straight `<line>`. */
export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  stroke: string,
  width = 1,
): string {
  return `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" stroke="${escapeXml(stroke)}" stroke-width="${num(width)}"/>`;
}

/** A `<polyline>` with no fill. */
export function polyline(
  points: ReadonlyArray<[number, number]>,
  stroke: string,
  width: number,
): string {
  const d = points.map(([x, y]) => `${num(x)},${num(y)}`).join(" ");
  return `<polyline points="${d}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="${num(width)}" stroke-linejoin="round" stroke-linecap="round"/>`;
}

/** A `<circle>`. */
export function circle(cx: number, cy: number, r: number, fill: string): string {
  return `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${escapeXml(fill)}"/>`;
}

/** Wrap body elements in a complete, standalone SVG document. */
export function svgDocument(
  width: number,
  height: number,
  background: string,
  body: ReadonlyArray<string>,
  title?: string,
): string {
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}" role="img"${title === undefined ? "" : ' aria-labelledby="t"'}>`;
  const titleElement = title === undefined ? "" : `<title id="t">${escapeXml(title)}</title>`;
  const bg = background === "none" ? "" : rect(0, 0, width, height, background);
  return `${head}${titleElement}${bg}${body.join("")}</svg>\n`;
}

/**
 * "Nice" axis bounds and tick step for a value range — the 1/2/5 x 10^n
 * ladder every plotting library uses, chosen without looking at pixel
 * widths so the same data always gets the same ticks.
 */
export function niceScale(
  min: number,
  max: number,
  targetTicks: number,
): { min: number; max: number; step: number; ticks: number[] } {
  let low = min;
  let high = max;
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = 0;
    high = 1;
  }
  if (low === high) {
    // A flat series still needs an axis: open a symmetric window round it.
    const pad = low === 0 ? 1 : Math.abs(low) * 0.1;
    low -= pad;
    high += pad;
  }
  const range = high - low;
  const rawStep = range / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const niceMin = Math.floor(low / step) * step;
  const niceMax = Math.ceil(high / step) * step;
  const ticks: number[] = [];
  // Count the steps rather than accumulating, and snap each tick to the
  // decimal place the step implies — `0 + 3 * 0.1` is 0.30000000000000004,
  // and a tick label must not carry that into the rendered SVG.
  const decimals = Math.min(12, Math.max(0, 1 - Math.floor(Math.log10(step))));
  const snap = (value: number): number => Number.parseFloat(value.toFixed(decimals));
  const count = Math.round((niceMax - niceMin) / step);
  for (let i = 0; i <= count; i++) {
    const value = snap(niceMin + i * step);
    ticks.push(value === 0 ? 0 : value);
  }
  return { min: niceMin, max: niceMax, step, ticks };
}

/**
 * A fixed categorical palette. Fixed because "deterministic" has to include
 * the colours: a chart that picks a hue from a hash of the series name
 * still renders the same twice, but a chart that picks at random does not,
 * and neither reads as one system beside its neighbours.
 */
export const PALETTE: ReadonlyArray<string> = Object.freeze([
  "#3b6fd4",
  "#e07b39",
  "#4ba36b",
  "#c2504a",
  "#8a63c4",
  "#7d5a4f",
  "#d1719f",
  "#6f7782",
  "#b3a133",
  "#3f9aa8",
]);

/** The palette colour for series `index`, wrapping. */
export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length] as string;
}
