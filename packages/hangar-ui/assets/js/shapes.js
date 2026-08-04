/**
 * Per-shape accent colors (the drop-in shape UIs' palette, restated here so
 * the console stays dependency-free). Pure data + lookups; DOM-free so the
 * map is unit-testable.
 */

export const DEFAULT_ACCENT = "#2ecc8b";

/** target shape → accent hex. Covers the canonical compile targets. */
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

/** Accent for a target shape; unknown/blank shapes get the default mint. */
export function shapeAccent(target) {
  const key = typeof target === "string" ? target : "";
  return Object.hasOwn(SHAPE_ACCENTS, key) ? SHAPE_ACCENTS[key] : DEFAULT_ACCENT;
}

/** Display label for a target shape ("?" when unknown). */
export function shapeLabel(target) {
  return typeof target === "string" && target !== "" ? target : "?";
}
