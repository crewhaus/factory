/**
 * Per-shape accent colors (the drop-in shape UIs' palette, restated here so
 * the console stays dependency-free). Pure data + lookups; DOM-free so the
 * map is unit-testable.
 *
 * Two tables, one per theme. The dark palette holds 4.5:1 on every dark
 * surface; on the light surfaces it falls to under 3:1, so the light table
 * carries a darker partner for each shape, holding 4.5:1 on every light
 * surface and on its own 8% wash. `src/hangar-css.test.ts` computes both.
 */

/**
 * The compile targets, in the order the shape × panel matrix lists them.
 * This is the strict union `@crewhaus/spec` validates against; a target that
 * is NOT in this list is unknown to this build, and an unknown shape is gated
 * at nothing — hiding a screen from a shape the console has never heard of
 * would be a guess wearing the clothes of a rule. The router re-exports it.
 */
export const SHAPE_TARGETS = Object.freeze([
  "cli",
  "workflow",
  "channel",
  "graph",
  "managed",
  "pipeline",
  "crew",
  "research",
  "batch",
  "voice",
  "browser",
  "eval",
  "onchain",
  "onchain-game",
]);

export const DEFAULT_ACCENT = "#2ecc8b";
/** The light theme's default, the console's light `--accent`. */
export const DEFAULT_ACCENT_LIGHT = "#0a6e47";

/** target shape → accent hex in the dark theme. Covers the canonical compile targets. */
export const SHAPE_ACCENTS = {
  cli: "#2ecc8b",
  channel: "#5b8cff",
  workflow: "#2bc4b4",
  graph: "#b08cff",
  managed: "#8fa3ff",
  pipeline: "#4fb6e0",
  crew: "#f2a65a",
  research: "#c792ea",
  batch: "#6fd08c",
  voice: "#ff6fb5",
  browser: "#74c0fc",
  eval: "#5cd6a8",
  onchain: "#e8b339",
  "onchain-game": "#ff8a5b",
};

/** target shape → accent hex in the light theme. Same keys as SHAPE_ACCENTS. */
export const SHAPE_ACCENTS_LIGHT = {
  cli: "#196e4b",
  channel: "#004bfc",
  workflow: "#186c63",
  graph: "#6c29ff",
  managed: "#1f47ff",
  pipeline: "#18698a",
  crew: "#934f0c",
  research: "#8e28d2",
  batch: "#246e3a",
  voice: "#be005c",
  browser: "#0462ad",
  eval: "#1c6e4f",
  onchain: "#7c5b0e",
  "onchain-game": "#b23300",
};

/** Accent for a target shape; unknown/blank shapes get the default mint. */
export function shapeAccent(target) {
  const key = typeof target === "string" ? target : "";
  return Object.hasOwn(SHAPE_ACCENTS, key) ? SHAPE_ACCENTS[key] : DEFAULT_ACCENT;
}

/**
 * The two custom properties a node needs to wear a shape's accent in either
 * theme. Pass it as an OBJECT `style` beside `"data-shape-accent": ""`: the
 * stylesheet picks `--accent` per theme, so a theme switch needs no
 * re-render, and an object style goes through the CSSOM, which a strict
 * style policy allows where a style attribute string is blocked.
 */
export function shapeAccentVars(target) {
  const key = typeof target === "string" ? target : "";
  const known = Object.hasOwn(SHAPE_ACCENTS, key);
  return {
    "--accent-dark": known ? SHAPE_ACCENTS[key] : DEFAULT_ACCENT,
    "--accent-light": known ? SHAPE_ACCENTS_LIGHT[key] : DEFAULT_ACCENT_LIGHT,
  };
}

/** Display label for a target shape ("?" when unknown). */
export function shapeLabel(target) {
  return typeof target === "string" && target !== "" ? target : "?";
}
