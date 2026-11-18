/**
 * Capability badges that say whether the harness's shape uses them.
 *
 * The server sends the declared badges (`badges`, a lenient spec scan) and,
 * per declared badge, what it does on this harness's shape as its bundle was
 * compiled (`badgeSupport`, from the support manifest), plus one `badgeNote`
 * when the build cannot be read against this release (no build yet, one
 * compiled before the manifest existed, or one by a newer CrewHaus), with
 * `badgeVerb` when a command answers it. A badge the shape does not use reads
 * its name and "Not used on <shape> harnesses" in words, never by colour
 * alone, with a native "Why?" disclosure holding the reason; one that needs a
 * recompile reads "Recompile to turn on", and one whose effect is not known
 * reads "Not checked". DOM through `el()` (createElement + textContent) only.
 */
import { el } from "../dom.js";

/** Statuses that mean the shape does not use the badge. */
const NOT_USED = new Set(["unwired", "rejected"]);

/** The words a badge that is neither in effect nor unused carries, by status. */
const PENDING_WORDS = { recompile: "Recompile to turn on", unknown: "Not checked" };

/** The short form of the same words, for a Library chip. */
const PENDING_SHORT = { recompile: "recompile to turn on", unknown: "not checked" };

/** The support entry for one badge, or null. */
function supportOf(support, key) {
  if (!support || typeof support !== "object") return null;
  const entry = support[key];
  return entry && typeof entry === "object" && typeof entry.status === "string" ? entry : null;
}

/** Whether a badge is declared but not used on this shape. */
export function badgeNotUsed(support, key) {
  const entry = supportOf(support, key);
  return entry !== null && NOT_USED.has(entry.status);
}

/** The pending words for a support entry, or null when it is in effect or unused. */
function pendingOf(entry, words) {
  if (entry === null || !Object.hasOwn(words, entry.status)) return null;
  return words[entry.status];
}

/** One badge chip on the harness header. */
function badgeChip(key, entry, shape) {
  const pending = pendingOf(entry, PENDING_WORDS);
  if (pending !== null) {
    return el("span", { class: "chip chip-off badge-pending" }, [
      el("span", { class: "badge-name", text: key }),
      el("span", { class: "badge-why-line", text: ` ${pending}` }),
    ]);
  }
  if (entry === null || !NOT_USED.has(entry.status)) {
    return el("span", { class: "chip", text: key });
  }
  return el("span", { class: "chip chip-off badge-off" }, [
    el("span", { class: "badge-name", text: key }),
    el("span", { class: "badge-why-line", text: ` Not used on ${shape} harnesses` }),
    typeof entry.reason === "string" && entry.reason !== ""
      ? el("details", { class: "badge-why" }, [
          el("summary", { text: "Why?" }),
          el("span", { class: "badge-reason", text: entry.reason }),
        ])
      : null,
  ]);
}

/**
 * The header's capability strip: one chip per declared badge, and the note
 * once beneath it, with the command that answers it when there is one
 * (`verb`, `crewhaus compile`). Null when no badge is declared.
 */
export function badgeStrip(badges, support, note, shape, verb) {
  if (!badges || typeof badges !== "object") return null;
  const active = Object.keys(badges).filter((k) => badges[k] === true);
  if (active.length === 0) return null;
  const label = typeof shape === "string" && shape !== "" ? shape : "this kind of";
  const strip = el(
    "div",
    { class: "safety-strip", "aria-label": "capabilities" },
    active.map((k) => badgeChip(k, supportOf(support, k), label)),
  );
  if (typeof note !== "string" || note === "") return strip;
  return el("div", { class: "badge-block" }, [
    strip,
    el(
      "p",
      { class: "muted badge-note" },
      typeof verb === "string" && verb !== ""
        ? [el("span", { text: `${note} ` }), el("code", { class: "mono", text: verb })]
        : [el("span", { text: note })],
    ),
  ]);
}

/**
 * A Library table chip: the badge's name, and "not used here" when the shape
 * does not use it ("recompile to turn on" or "not checked" when that is not known yet).
 */
export function libraryChip(key, support) {
  if (badgeNotUsed(support, key)) {
    return el("span", { class: "chip chip-off", text: `${key} · not used here` });
  }
  const pending = pendingOf(supportOf(support, key), PENDING_SHORT);
  return pending !== null
    ? el("span", { class: "chip chip-off", text: `${key} · ${pending}` })
    : el("span", { class: "chip", text: key });
}
