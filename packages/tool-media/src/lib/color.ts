/**
 * Colour parsing, conversion and the WCAG contrast check.
 *
 * The contrast maths is WCAG 2.x (the version every audit tool and every
 * procurement checklist still keys on): sRGB channels linearised with the
 * 0.03928 piecewise curve, luminance weighted 0.2126/0.7152/0.0722, ratio
 * `(lighter + 0.05) / (darker + 0.05)`.
 */
import { MediaFormatError } from "./bytes";

export type Rgb = {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
};

const HEX3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX4 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8 = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB_FN = /^rgba?\(\s*([^)]+)\)$/i;
const HSL_FN = /^hsla?\(\s*([^)]+)\)$/i;

/**
 * The 16 colour keywords every CSS level has had, lowercase. The full
 * 148-name list is deliberately not carried here: a caller who means
 * `rebeccapurple` can write `#663399`, and a half-remembered table is
 * worse than none.
 */
const KEYWORDS: Readonly<Record<string, string>> = Object.freeze({
  black: "#000000",
  silver: "#c0c0c0",
  gray: "#808080",
  grey: "#808080",
  white: "#ffffff",
  maroon: "#800000",
  red: "#ff0000",
  purple: "#800080",
  fuchsia: "#ff00ff",
  green: "#008000",
  lime: "#00ff00",
  olive: "#808000",
  yellow: "#ffff00",
  navy: "#000080",
  blue: "#0000ff",
  teal: "#008080",
  aqua: "#00ffff",
  transparent: "#00000000",
});

/** Colour keywords this package accepts, sorted. */
export function colorKeywords(): ReadonlyArray<string> {
  return Object.keys(KEYWORDS).sort();
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function channel(text: string): number {
  const trimmed = text.trim();
  if (trimmed.endsWith("%")) {
    const pct = Number.parseFloat(trimmed.slice(0, -1));
    if (Number.isNaN(pct)) throw new MediaFormatError(`"${text}" is not a percentage`);
    return clamp(Math.round((pct / 100) * 255), 0, 255);
  }
  const value = Number.parseFloat(trimmed);
  if (Number.isNaN(value)) throw new MediaFormatError(`"${text}" is not a channel value`);
  return clamp(Math.round(value), 0, 255);
}

function alphaValue(text: string | undefined): number {
  if (text === undefined) return 255;
  const trimmed = text.trim();
  const raw = trimmed.endsWith("%")
    ? Number.parseFloat(trimmed.slice(0, -1)) / 100
    : Number.parseFloat(trimmed);
  if (Number.isNaN(raw)) throw new MediaFormatError(`"${text}" is not an alpha value`);
  return clamp(Math.round(raw * 255), 0, 255);
}

/**
 * Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`,
 * `hsla()` or one of the basic colour keywords. Throws `MediaFormatError`
 * with the offending text on anything else.
 */
export function parseColor(input: string): Rgb {
  const text = input.trim();
  const keyword = KEYWORDS[text.toLowerCase()];
  if (keyword !== undefined) return parseColor(keyword);

  const hex8 = HEX8.exec(text);
  if (hex8) {
    return {
      r: Number.parseInt(hex8[1] as string, 16),
      g: Number.parseInt(hex8[2] as string, 16),
      b: Number.parseInt(hex8[3] as string, 16),
      a: Number.parseInt(hex8[4] as string, 16),
    };
  }
  const hex6 = HEX6.exec(text);
  if (hex6) {
    return {
      r: Number.parseInt(hex6[1] as string, 16),
      g: Number.parseInt(hex6[2] as string, 16),
      b: Number.parseInt(hex6[3] as string, 16),
      a: 255,
    };
  }
  const hex4 = HEX4.exec(text);
  if (hex4) {
    const double = (d: string): number => Number.parseInt(d + d, 16);
    return {
      r: double(hex4[1] as string),
      g: double(hex4[2] as string),
      b: double(hex4[3] as string),
      a: double(hex4[4] as string),
    };
  }
  const hex3 = HEX3.exec(text);
  if (hex3) {
    const double = (d: string): number => Number.parseInt(d + d, 16);
    return {
      r: double(hex3[1] as string),
      g: double(hex3[2] as string),
      b: double(hex3[3] as string),
      a: 255,
    };
  }
  const rgbFn = RGB_FN.exec(text);
  if (rgbFn) {
    const parts = (rgbFn[1] as string)
      .split(/[,/]/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (parts.length < 3) throw new MediaFormatError(`"${input}" needs three channels`);
    return {
      r: channel(parts[0] as string),
      g: channel(parts[1] as string),
      b: channel(parts[2] as string),
      a: alphaValue(parts[3]),
    };
  }
  const hslFn = HSL_FN.exec(text);
  if (hslFn) {
    const parts = (hslFn[1] as string)
      .split(/[,/]/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    if (parts.length < 3)
      throw new MediaFormatError(`"${input}" needs hue, saturation and lightness`);
    const h = Number.parseFloat((parts[0] as string).replace(/deg$/i, ""));
    const s = Number.parseFloat((parts[1] as string).replace(/%$/, ""));
    const l = Number.parseFloat((parts[2] as string).replace(/%$/, ""));
    if (Number.isNaN(h) || Number.isNaN(s) || Number.isNaN(l)) {
      throw new MediaFormatError(`"${input}" has a component that is not a number`);
    }
    return { ...hslToRgb(h, s, l), a: alphaValue(parts[3]) };
  }
  throw new MediaFormatError(
    `"${input}" is not a colour this package reads (hex, rgb(), hsl(), or a basic keyword)`,
  );
}

/** HSL with hue in degrees and saturation/lightness in percent, to 8-bit RGB. */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = light - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** 8-bit RGB to HSL, hue in degrees, saturation and lightness in percent. */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const round1 = (v: number): number => Math.round(v * 10) / 10;
  return { h: round1(h), s: round1(s * 100), l: round1(l * 100) };
}

/** `#rrggbb`, or `#rrggbbaa` when the colour is not fully opaque. */
export function toHexString(color: Rgb): string {
  const pair = (v: number): string => v.toString(16).padStart(2, "0");
  const base = `#${pair(color.r)}${pair(color.g)}${pair(color.b)}`;
  return color.a === 255 ? base : `${base}${pair(color.a)}`;
}

/** WCAG 2.x relative luminance of an opaque sRGB colour. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const linear = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * Composite a possibly-translucent colour over an opaque backdrop. WCAG's
 * ratio is defined for opaque colours only, so a caller passing `#0008`
 * gets a defensible answer rather than a wrong one.
 */
export function compositeOver(top: Rgb, backdrop: Rgb): Rgb {
  const alpha = top.a / 255;
  const mix = (t: number, b: number): number => Math.round(t * alpha + b * (1 - alpha));
  return {
    r: mix(top.r, backdrop.r),
    g: mix(top.g, backdrop.g),
    b: mix(top.b, backdrop.b),
    a: 255,
  };
}

export type ContrastReport = {
  readonly ratio: number;
  readonly foreground: string;
  readonly background: string;
  readonly normalTextAA: boolean;
  readonly normalTextAAA: boolean;
  readonly largeTextAA: boolean;
  readonly largeTextAAA: boolean;
  readonly uiComponentAA: boolean;
  /** The highest level the pair clears for body text. */
  readonly verdict: "AAA" | "AA" | "AA-large-only" | "fail";
};

/**
 * Contrast ratio and the levels it clears. "Large" text is WCAG's own
 * definition: at least 18pt, or 14pt bold.
 */
export function contrastReport(foreground: Rgb, background: Rgb): ContrastReport {
  const bg =
    background.a === 255
      ? background
      : compositeOver(background, { r: 255, g: 255, b: 255, a: 255 });
  const fg = foreground.a === 255 ? foreground : compositeOver(foreground, bg);
  const lf = relativeLuminance(fg.r, fg.g, fg.b);
  const lb = relativeLuminance(bg.r, bg.g, bg.b);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  const raw = (lighter + 0.05) / (darker + 0.05);
  // Two decimal places is what every accessibility report quotes, and it
  // keeps the number stable against floating-point noise.
  const ratio = Math.round(raw * 100) / 100;
  return {
    ratio,
    foreground: toHexString(fg),
    background: toHexString(bg),
    normalTextAA: ratio >= 4.5,
    normalTextAAA: ratio >= 7,
    largeTextAA: ratio >= 3,
    largeTextAAA: ratio >= 4.5,
    uiComponentAA: ratio >= 3,
    verdict: ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA-large-only" : "fail",
  };
}
