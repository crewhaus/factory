/**
 * HM-190 — keyboard triage, at the APP level.
 *
 * The inbox half lives in `supervision.js` (`triageKey`: j/k movement, the
 * choose-then-Enter verdicts, the `.` row menu and the `?` inbox help) and is
 * mounted by `views/inbox.js` on the LIST, so its keys work only while the
 * list has focus (WCAG 2.1.4). This is the layer above that — ⌘K, `/`,
 * Escape, and a bindings sheet that works everywhere — and, more
 * importantly, it decides WHO owns a key when both layers want it.
 *
 * The whole decision is one pure reducer, {@link globalKey}, so the answer
 * to "does `?` open the global sheet or the inbox's?" is a unit test rather
 * than an argument with a browser.
 *
 * THE OWNERSHIP RULES, in the order they apply:
 *
 *   0. While a dialog this reducer does not own is open (a typed
 *      confirmation, a spec dialog), no shortcut claims anything: `/`, `?`
 *      and ⌘K would stack a second overlay on a half-typed confirmation, and
 *      Escape is the dialog's own way out.
 *   1. A key pressed inside an INPUT, TEXTAREA or contenteditable belongs to
 *      the field — an operator typing a spec edit must never have a modal
 *      stolen out from under them by a shortcut. There is exactly ONE
 *      exception, and it is the command menu's own input: the overlay
 *      focuses it the instant it opens, so from that instant every key
 *      arrives with `inField: true`. Bailing unconditionally would make
 *      Escape and the ⌘K toggle unreachable and turn a keyboard feature into
 *      a keyboard TRAP. So while the menu is open, the two keys that CLOSE
 *      it are claimed even in a field, and nothing else is.
 *   2. ⌘K / Ctrl-K opens the command menu from anywhere else, and toggles it
 *      closed when it is already open.
 *   3. While the command menu is OPEN no other shortcut fires: `/` and `?`
 *      would stack a second overlay on it. Every other key is left to the
 *      control that has focus, unclaimed: Tab, Enter and Space must reach an
 *      armed action's "Run it" and "Cancel", or the action could be armed by
 *      keyboard and never confirmed. Typing in the menu's field never gets
 *      here (rule 1).
 *   4. Escape closes the topmost overlay — the menu first, then the sheet.
 *   5. With single-key shortcuts off (Readability), no character key is
 *      claimed — not here, and not in an inbox. Arrows, Enter, Escape and
 *      every button still work.
 *   6. `/` opens the command menu.
 *   7. `?` toggles the bindings sheet, except while focus is inside an inbox
 *      list, whose own help it opens instead; two sheets opening on one
 *      keypress is the bug this rule exists to prevent.
 *
 * Nothing here touches `document`; the caller normalizes a KeyboardEvent
 * with {@link keyShape}, adds `dialogOpen`, and applies the returned effect.
 */

/** The global bindings, as data — the sheet renders from this list. */
export const GLOBAL_BINDINGS = [
  { keys: "⌘K / Ctrl-K", does: "open or close the command menu" },
  { keys: "/", does: "open the command menu (not while typing)" },
  { keys: "?", does: "show or hide this list" },
  { keys: "Esc", does: "close the top overlay" },
];

/** The inbox bindings, repeated in the global sheet so one overlay answers
 *  "what can I press here?" wherever it is opened. A letter only CHOOSES a
 *  verdict; Enter confirms it. */
export const INBOX_BINDINGS = [
  { keys: "j / ↓", does: "move down a row" },
  { keys: "k / ↑", does: "move up a row" },
  { keys: "g / d", does: "choose grant or deny, then Enter (approvals inbox)" },
  { keys: "u / d / p / f", does: "choose up, down, pass or fail, then Enter (review queue)" },
  { keys: "Enter", does: "confirm the choice, or open the row" },
  { keys: "Esc", does: "cancel the choice" },
  { keys: ".", does: "open the row menu" },
  { keys: "?", does: "show the inbox's own keys" },
];

/** Fields that own their keystrokes. */
const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** The command menu chord, in both flavours. */
function isOmniChord(k) {
  return (k.meta === true || k.ctrl === true) && (k.key === "k" || k.key === "K");
}

/** A key that types one character (`?`, `/`, a letter) — what Readability's
 *  "Single-key shortcuts: Off" turns off. */
export function isCharacterKey(key) {
  return typeof key === "string" && [...key].length === 1 && key !== " ";
}

/**
 * Normalize a KeyboardEvent into the plain record the reducer takes. Pure
 * apart from reading the event; kept here so tests describe key presses as
 * data rather than constructing DOM events. `inboxFocused` is read off the
 * event, never kept in state: a re-render can remove the focused row with no
 * focusout, and only the event knows where focus is now.
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
    inboxFocused: typeof target?.closest === "function" && target.closest("[data-triage]") !== null,
  };
}

/** The initial overlay state. */
export function initialKeyState() {
  return { omniboxOpen: false, sheetOpen: false, inboxMounted: false, singleKeys: true };
}

/**
 * The reducer. Returns `{ state, effect, claimed }`:
 *
 *   - `state`   — the next overlay state;
 *   - `effect`  — `"open-omnibox" | "close-omnibox" | "toggle-sheet" |
 *                 "close-sheet" | null`;
 *   - `claimed` — true when the app handled the key and the caller should
 *                 `preventDefault()`. A key the app did NOT claim must fall
 *                 through untouched, which is what lets the inbox list and an
 *                 open dialog keep their own keys.
 */
export function globalKey(state, shape) {
  const s = { ...initialKeyState(), ...(state && typeof state === "object" ? state : {}) };
  const k = {
    key: "",
    meta: false,
    ctrl: false,
    alt: false,
    inField: false,
    inboxFocused: false,
    dialogOpen: false,
    ...(shape ?? {}),
  };
  const keep = { state: s, effect: null, claimed: false };

  // 0. A dialog this reducer does not own keeps every key.
  if (k.dialogOpen === true) return keep;

  // 1. A field owns its keys — including ⌘K — except the two that close an
  //    open command menu.
  const closesOmnibox = s.omniboxOpen && (k.key === "Escape" || isOmniChord(k));
  if (k.inField && !closesOmnibox) return keep;

  // 2. ⌘K / Ctrl-K toggles the command menu.
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

  // 3. While the menu is open, Escape closes it and no other shortcut fires.
  //    Nothing else is claimed: the focused control keeps Tab, Enter and Space.
  if (s.omniboxOpen) {
    if (k.key === "Escape") {
      return { state: { ...s, omniboxOpen: false }, effect: "close-omnibox", claimed: true };
    }
    return keep;
  }

  // 4. Escape closes the sheet when it is the topmost overlay.
  if (k.key === "Escape") {
    return s.sheetOpen
      ? { state: { ...s, sheetOpen: false }, effect: "close-sheet", claimed: true }
      : keep;
  }

  // 5. Single-key shortcuts off: no character key is anyone's.
  if (s.singleKeys === false && isCharacterKey(k.key)) return keep;

  // 6. `/` opens the command menu.
  if (k.key === "/") {
    return {
      state: { ...s, omniboxOpen: true, sheetOpen: false },
      effect: "open-omnibox",
      claimed: true,
    };
  }

  // 7. `?` is the inbox's while focus is in an inbox list.
  if (k.key === "?") {
    if (k.inboxFocused) return keep;
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
