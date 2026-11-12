/**
 * The five harness sections, in order, and what the shell, the router and the
 * gate read from them. Pure data plus lazy loaders: importing this module
 * loads no view, so it is safe in the shell's static import graph and under
 * bun.
 *
 * Shape gating lives on the rows. A gated row carries `gate: {shapes, why}`;
 * the sub-view list draws an off-matrix row as text with its reason, and the
 * deep link still resolves, because the honest empty state that screen
 * renders is a real answer and a shared address must not go dead.
 */

import { SHAPE_TARGETS } from "../shapes.js";
import { KNOWLEDGE } from "./knowledge.js";
import { OVERVIEW } from "./overview.js";
import { QUALITY } from "./quality.js";
import { SETUP } from "./setup.js";
import { WORK } from "./work.js";

export const SECTIONS = Object.freeze([OVERVIEW, WORK, QUALITY, KNOWLEDGE, SETUP]);

export const SECTION_IDS = Object.freeze(SECTIONS.map((section) => section.id));

/** The template token each typed capture stands for. */
export const CAPTURE_TOKENS = Object.freeze({
  runId: ":run",
  sampleId: ":sample",
  sessionId: ":session",
  wikiSlug: ":slug",
});

/** A section by id, or null. */
export function sectionById(id) {
  return SECTIONS.find((section) => section.id === id) ?? null;
}

/** A section's sub-view row by id, or null. */
export function subViewOf(section, id) {
  const s = typeof section === "string" ? sectionById(section) : section;
  if (s === null || s === undefined) return null;
  return s.views.find((row) => row.id === id) ?? null;
}

/** The rows a section lists (a hidden row is reached by its link only). */
export function listedViews(section) {
  const s = typeof section === "string" ? sectionById(section) : section;
  return s === null || s === undefined ? [] : s.views.filter((row) => row.hidden !== true);
}

/**
 * Every gate, keyed by sub-view id, derived from the rows: the one table
 * there is. Frozen, so nothing can edit a copy and drift from the rows.
 */
export const SHAPE_GATED_TABS = Object.freeze(
  Object.fromEntries(
    SECTIONS.flatMap((section) =>
      section.views
        .filter((row) => row.gate !== undefined)
        .map((row) => [row.id, Object.freeze({ shapes: row.gate.shapes, why: row.gate.why })]),
    ),
  ),
);

/**
 * Which of a section's listed sub-views this target can use, in list order:
 * `{ id, on, reason }`. An off-matrix row carries the sentence the list shows
 * instead of a link. An unknown or missing target is gated at nothing.
 */
export function subViewAvailability(section, target) {
  const shape = typeof target === "string" ? target : "";
  const known = SHAPE_TARGETS.includes(shape);
  return listedViews(section).map((row) => {
    if (row.gate === undefined || !known || row.gate.shapes.includes(shape)) {
      return { id: row.id, on: true, reason: null };
    }
    return { id: row.id, on: false, reason: `${row.gate.why} — this harness's target is ${shape}` };
  });
}

/** A section's listed rows grouped by their `group`, in first-seen order. */
export function subViewGroups(section) {
  const groups = [];
  for (const row of listedViews(section)) {
    const name = typeof row.group === "string" ? row.group : null;
    const existing = groups.find((g) => g.group === name);
    if (existing !== undefined) existing.rows.push(row);
    else groups.push({ group: name, rows: [row] });
  }
  return groups;
}
