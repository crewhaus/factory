/**
 * HM-190 — keyboard triage, at the APP level.
 *
 * The inbox half of this item shipped with M2: `triageKey` in
 * `supervision.js` owns j/k movement, the one-key verdicts, the `.` row menu
 * and the `?` bindings sheet inside the approvals and review lists, and
 * `views/inbox.js` mounts it. M4 adds the layer above that — ⌘K, Escape, and
 * a bindings sheet that works on screens with no inbox on them — and, more
 * importantly, decides WHO owns a key when both layers want it.
 *
 * The whole decision is one pure reducer, {@link globalKey}, so the answer
 * to "does `?` open the global sheet or the inbox's?" is a unit test rather
 * than an argument with a browser.
 *
 * THE OWNERSHIP RULES, in the order they apply:
 *
 *   1. A key pressed inside an INPUT, TEXTAREA or contenteditable belongs to
 *      the field — an operator typing a spec edit must never have a modal
 *      stolen out from under them by a shortcut. There is exactly ONE
 *      exception, and it is the omnibox's own input: the overlay focuses it
 *      the instant it opens, so from that instant every key arrives with
 *      `inField: true`. Bailing unconditionally would make Escape and the
 *      ⌘K toggle unreachable and turn a keyboard feature into a keyboard
 *      TRAP — the only way out a mouse click on the backdrop. So while the
 *      omnibox is open, the two keys that CLOSE it are claimed even in a
 *      field, and nothing else is: typing a query still belongs to the
 *      field.
 *   2. ⌘K / Ctrl-K opens the omnibox from anywhere else, and toggles it
 *      closed when it is already open.
 *   3. While the omnibox is OPEN it owns every key: the list beneath it must
 *      not scroll while a query is being typed.
 *   4. Escape closes the topmost overlay — omnibox first, then the sheet.
 *   5. `?` toggles the bindings sheet, but ONLY when no inbox is mounted;
 *      an inbox already binds `?` for its own sheet, and two sheets opening
 *      on one keypress is the bug this rule exists to prevent.
 *
 * Nothing here touches `document`; the caller normalizes a KeyboardEvent
 * with {@link keyShape} and applies the returned effect.
 */

/** The global bindings, as data — the sheet renders from this list. */
export const GLOBAL_BINDINGS = [
  { keys: "⌘K / Ctrl-K", does: "open the omnibox (harnesses, sessions, wiki, runs, actions)" },
  { keys: "?", does: "show or hide this bindings sheet" },
  { keys: "Esc", does: "close the omnibox, then this sheet" },
];

/** The inbox bindings, repeated in the global sheet so one overlay answers
 *  "what can I press here?" wherever it is opened. */
export const INBOX_BINDINGS = [
  { keys: "j / ↓", does: "move down a row" },
  { keys: "k / ↑", does: "move up a row" },
  { keys: "g / d", does: "grant or deny (approvals inbox)" },
  { keys: "u / d / p / f", does: "up, down, pass or fail (review queue)" },
  { keys: ".", does: "open the row menu" },
  { keys: "?", does: "show the inbox's own bindings" },
];

/** Fields that own their keystrokes. */
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** The omnibox chord, in both flavours. */
function isOmniChord(k) {
  return (k.meta === true || k.ctrl === true) && (k.key === "k" || k.key === "K");
}

/**
 * Normalize a KeyboardEvent into the plain record the reducer takes. Pure
 * apart from reading the event; kept here so tests describe key presses as
 * data rather than constructing DOM events.
 */
export function keyShape(event) {
  const target = event?.target ?? null;
  const tag = target && typeof target.tagName === "string" ? target.tagName : "";
  return {
    key: typeof event?.key === "string" ? event.key : "",
    meta: event?.metaKey === true,
    ctrl: event?.ctrlKey === true,
    alt: event?.altKey === true,
    shift: event?.shiftKey === true,
    inField: FIELD_TAGS.has(tag) || target?.isContentEditable === true,
  };
}

/** The initial overlay state. */
export function initialKeyState() {
  return { omniboxOpen: false, sheetOpen: false, inboxMounted: false };
}

/**
 * The reducer. Returns `{ state, effect, claimed }`:
 *
 *   - `state`   — the next overlay state;
 *   - `effect`  — `"open-omnibox" | "close-omnibox" | "toggle-sheet" |
 *                 "close-sheet" | null`;
 *   - `claimed` — true when the app handled the key and the caller should
 *                 `preventDefault()`. A key the app did NOT claim must fall
 *                 through untouched, which is what lets the inbox reducer
 *                 keep working on the same screen.
 */
export function globalKey(state, shape) {
  const s = { ...initialKeyState(), ...(state && typeof state === "object" ? state : {}) };
  const k = { key: "", meta: false, ctrl: false, alt: false, inField: false, ...(shape ?? {}) };
  const keep = { state: s, effect: null, claimed: false };

  // 1. A field owns its keys — including ⌘K — except the two that close an
  //    open omnibox. The overlay focuses its own input, so without this
  //    exception it would swallow both of its own exits.
  const closesOmnibox = s.omniboxOpen && (k.key === "Escape" || isOmniChord(k));
  if (k.inField && !closesOmnibox) return keep;

  // 2. ⌘K / Ctrl-K toggles the omnibox.
  if (isOmniChord(k)) {
    return s.omniboxOpen
      ? { state: { ...s, omniboxOpen: false }, effect: "close-omnibox", claimed: true }
      : {
          state: { ...s, omniboxOpen: true, sheetOpen: false },
          effect: "open-omnibox",
          claimed: true,
        };
  }
  // Any other modifier chord belongs to the browser (⌘R, ⌘L, ⌘T…).
  if (k.meta || k.ctrl || k.alt) return keep;

  // 3. While the omnibox is open it owns everything except Escape, which
  //    rule 4 handles.
  if (s.omniboxOpen) {
    if (k.key === "Escape") {
      return { state: { ...s, omniboxOpen: false }, effect: "close-omnibox", claimed: true };
    }
    return { state: s, effect: null, claimed: true };
  }

  // 4. Escape closes the sheet when it is the topmost overlay.
  if (k.key === "Escape") {
    return s.sheetOpen
      ? { state: { ...s, sheetOpen: false }, effect: "close-sheet", claimed: true }
      : keep;
  }

  // 5. `?` is the inbox's when an inbox is mounted.
  if (k.key === "?") {
    if (s.inboxMounted) return keep;
    return { state: { ...s, sheetOpen: !s.sheetOpen }, effect: "toggle-sheet", claimed: true };
  }

  return keep;
}

/** Every binding the sheet shows, grouped. Pure — the overlay renders it. */
export function bindingSheet(inboxMounted = false) {
  return [
    { section: "Anywhere", bindings: GLOBAL_BINDINGS },
    {
      section: inboxMounted ? "This inbox" : "Inboxes (approvals, review)",
      bindings: INBOX_BINDINGS,
    },
  ];
}
