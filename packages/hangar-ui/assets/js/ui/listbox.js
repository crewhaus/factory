/**
 * Two keyboard patterns, each with its decisions in a pure function.
 *
 *   - A COMBOBOX (the command menu): focus stays in the text field, the list
 *     is a `role=listbox` of options only, and `aria-activedescendant` says
 *     which option the arrows are on. An option may hold no button: an
 *     interactive child of an option is invisible to assistive tech, so an
 *     action is ARMED by Enter and confirmed outside the list.
 *   - A ROVING LIST (the inboxes): the rows are ordinary list items that
 *     hold buttons and links, so they cannot be options. One row is in the
 *     Tab order at a time (`tabindex=0`), and the arrows move it.
 */

/**
 * The combobox reducer. Pure.
 *
 *   state: { count, cursor, kinds, armed }
 *     count  — options in the list
 *     cursor — the active option, or -1 for none
 *     kinds  — each option's kind; `"action"` options are armed, not opened
 *     armed  — the index of an armed action, or null
 *
 * Returns { state, effect, index }, where effect is
 * `"move" | "open" | "arm" | "disarm" | null`. Arrows wrap, and an empty list
 * keeps the cursor at -1. Escape disarms an armed action; with nothing
 * armed it is not this reducer's (the menu itself closes).
 */
export function comboboxKey(state, key) {
  const s = {
    count: 0,
    cursor: -1,
    kinds: [],
    armed: null,
    ...(state && typeof state === "object" ? state : {}),
  };
  const none = { state: s, effect: null, index: s.cursor };
  const move = (cursor) => ({
    state: { ...s, cursor, armed: null },
    effect: "move",
    index: cursor,
  });
  switch (key) {
    case "ArrowDown":
      if (s.count <= 0) return none;
      return move(s.cursor < 0 ? 0 : (s.cursor + 1) % s.count);
    case "ArrowUp":
      if (s.count <= 0) return none;
      return move(s.cursor <= 0 ? s.count - 1 : s.cursor - 1);
    case "Home":
      return s.count <= 0 ? none : move(0);
    case "End":
      return s.count <= 0 ? none : move(s.count - 1);
    case "Enter": {
      if (s.cursor < 0 || s.cursor >= s.count) return none;
      if (s.kinds[s.cursor] === "action") {
        return { state: { ...s, armed: s.cursor }, effect: "arm", index: s.cursor };
      }
      return { state: s, effect: "open", index: s.cursor };
    }
    case "Escape":
      if (s.armed === null) return none;
      return { state: { ...s, armed: null }, effect: "disarm", index: s.cursor };
    default:
      return none;
  }
}

/**
 * Mark up a text field and a list as a combobox and its listbox. Returns
 * `{ setActive(optionId | null), setExpanded(bool) }`; the caller owns the
 * options and the keys.
 */
let listboxCount = 0;

export function wireCombobox(input, list) {
  if (!list.id) {
    listboxCount += 1;
    list.id = `listbox-${listboxCount}`;
  }
  list.setAttribute("role", "listbox");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  return {
    setActive(optionId) {
      if (typeof optionId === "string" && optionId !== "") {
        input.setAttribute("aria-activedescendant", optionId);
      } else input.removeAttribute("aria-activedescendant");
    },
    setExpanded(open) {
      input.setAttribute("aria-expanded", open ? "true" : "false");
      list.hidden = !open;
    },
  };
}

/**
 * Roving focus over `container`'s rows (`rowSelector`): exactly one row is a
 * Tab stop. `onKey(event, rowIndex)` sees every keydown inside the
 * container, with the index of the row the key came from (-1 for none).
 *
 * Returns { rows(), indexOf(node), setCurrent(i), focus(i) }.
 */
export function rovingList(container, rowSelector, opts = {}) {
  const rows = () => [...container.querySelectorAll(rowSelector)];
  const indexOf = (node) => {
    if (!(node instanceof Element)) return -1;
    const row = node.closest(rowSelector);
    return row === null ? -1 : rows().indexOf(row);
  };
  const setCurrent = (index) => {
    rows().forEach((row, i) => {
      row.setAttribute("tabindex", i === index ? "0" : "-1");
    });
  };
  const focus = (index) => {
    const row = rows()[index];
    if (row !== undefined) row.focus();
  };
  if (typeof opts.onKey === "function") {
    container.addEventListener("keydown", (event) => opts.onKey(event, indexOf(event.target)));
  }
  return { rows, indexOf, setCurrent, focus };
}
