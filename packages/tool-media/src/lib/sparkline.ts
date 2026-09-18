/**
 * Sparklines — a series reduced to something that fits on one line.
 *
 * Two renderings: an SVG path for a report or a dashboard, and a run of
 * Unicode block characters for a digest line, a commit message or a
 * terminal. Both quantise the same way, so the shapes agree.
 */
import { MediaFormatError } from "./bytes";
import { circle, escapeXml, num, polyline, rect, svgDocument } from "./svg";

/** Eight levels, from an eighth of a block to a full one. */
const BLOCKS: ReadonlyArray<string> = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export type SparklineRange = { readonly min: number; readonly max: number };

function resolveRange(
  values: ReadonlyArray<number>,
  explicit: Partial<SparklineRange>,
): SparklineRange {
  const min = explicit.min ?? Math.min(...values);
  const max = explicit.max ?? Math.max(...values);
  if (min > max) throw new MediaFormatError(`min ${min} is above max ${max}`);
  if (min === max) {
    // A flat series has no shape; centre it rather than divide by zero.
    return { min: min - 0.5, max: max + 0.5 };
  }
  return { min, max };
}

function check(values: ReadonlyArray<number>): void {
  if (values.length === 0) throw new MediaFormatError("a sparkline needs at least one value");
  for (const value of values) {
    if (!Number.isFinite(value)) throw new MediaFormatError(`the series contains ${value}`);
  }
}

/**
 * The series as block characters, one per value. Values at or below `min`
 * get the shortest block and values at or above `max` the tallest, so a
 * caller supplying an explicit range gets clipping rather than a surprise.
 */
export function sparklineBlocks(
  values: ReadonlyArray<number>,
  explicit: Partial<SparklineRange> = {},
): string {
  check(values);
  const range = resolveRange(values, explicit);
  const span = range.max - range.min;
  let out = "";
  for (const value of values) {
    const fraction = (value - range.min) / span;
    const level = Math.min(7, Math.max(0, Math.round(fraction * 7)));
    out += BLOCKS[level] as string;
  }
  return out;
}

export type SparklineSvgOptions = {
  readonly width?: number;
  readonly height?: number;
  readonly stroke?: string;
  readonly fill?: string;
  readonly background?: string;
  /** Mark the last point, the way a dashboard sparkline usually does. */
  readonly markLast?: boolean;
};

/** The series as a small standalone SVG. */
export function sparklineSvg(
  values: ReadonlyArray<number>,
  options: SparklineSvgOptions = {},
  explicit: Partial<SparklineRange> = {},
): string {
  check(values);
  const width = options.width ?? 120;
  const height = options.height ?? 24;
  if (width < 8 || height < 4) {
    throw new MediaFormatError(`${width}x${height} is too small for a sparkline`);
  }
  const range = resolveRange(values, explicit);
  const span = range.max - range.min;
  const pad = 2;
  const usableWidth = width - pad * 2;
  const usableHeight = height - pad * 2;
  const step = values.length === 1 ? 0 : usableWidth / (values.length - 1);
  const points: Array<[number, number]> = values.map((value, i) => {
    const clamped = Math.min(range.max, Math.max(range.min, value));
    return [pad + i * step, pad + usableHeight - ((clamped - range.min) / span) * usableHeight];
  });

  const stroke = options.stroke ?? "#3b6fd4";
  const body: string[] = [];
  if (options.fill !== undefined) {
    const first = points[0] as [number, number];
    const last = points[points.length - 1] as [number, number];
    const area = [
      `M ${num(first[0])} ${num(height - pad)}`,
      ...points.map(([x, y]) => `L ${num(x)} ${num(y)}`),
      `L ${num(last[0])} ${num(height - pad)}`,
      "Z",
    ].join(" ");
    // Escaped like every other caller-supplied colour: a raw `"` here would
    // close the attribute and let the value append elements of its own.
    body.push(`<path d="${area}" fill="${escapeXml(options.fill)}"/>`);
  }
  if (points.length === 1) {
    const only = points[0] as [number, number];
    body.push(rect(pad, only[1] - 1, usableWidth, 2, stroke));
  } else {
    body.push(polyline(points, stroke, 1.5));
  }
  if (options.markLast === true) {
    const last = points[points.length - 1] as [number, number];
    body.push(circle(last[0], last[1], 2, stroke));
  }
  return svgDocument(width, height, options.background ?? "none", body);
}
