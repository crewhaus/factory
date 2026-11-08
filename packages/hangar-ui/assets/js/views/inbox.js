/**
 * The shared triage shell both fleet inboxes wear: a list whose rows rove
 * (one row is the Tab stop; the arrows and j/k move it), choose-then-Enter
 * verdicts, a `.` row menu and a `?` help list.
 *
 * All of the thinking is in `triageKey` — a pure reducer this package
 * unit-tests without a browser. This module turns its `state` into the rows'
 * look, in place, and its `effect` into an API call. Four rules it keeps:
 *
 *   - The keys belong to the LIST. The listener is on a wrapper around the
 *     list, its row menu and its help (the menu and the help are siblings of
 *     the list, so a listener on the list alone would never hear Escape from
 *     inside the menu), never on `document` (WCAG 2.1.4). The wrapper
 *     carries `data-triage`, which is how the app's own key layer knows that
 *     `?` is the inbox's here and the global sheet's everywhere else.
 *   - A letter only arms a verdict. The row says "Armed" and what Enter will
 *     do, and the same sentence is announced politely. Enter on the ROW
 *     confirms; Enter on one of the row's own buttons is that button's.
 *   - Rows are built once per mount and updated in place, so the row that
 *     has focus keeps it while the selection moves.
 *   - After a decision, the selection holds by row id, and focus returns to
 *     the row (or to the row that took its place). A decision reloads the
 *     screen and mounts this shell again, so that memory outlives the mount.
 */

import { el, statusBadge } from "../dom.js";
import { readPrefs } from "../prefs.js";
import { isTriageKey, keyHelp, triageKey } from "../supervision.js";
import { reconcile } from "../ui/keyed.js";
import { rovingList } from "../ui/listbox.js";
import { announce } from "../ui/live.js";

/** name → { id, index, focus }: the selection a mount hands to the next. */
const kept = new Map();

const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isField(node) {
  return (
    node instanceof Element && (FIELD_TAGS.has(node.tagName) || node.isContentEditable === true)
  );
}

/**
 * Where a mount starts: the kept row by id, else the kept position, else the
 * top; and whether focus should go there. Pure.
 */
export function startSelection(rowIds, memory) {
  const ids = Array.isArray(rowIds) ? rowIds : [];
  if (memory === null || memory === undefined || typeof memory !== "object") {
    return { index: 0, focus: false };
  }
  const byId = ids.indexOf(memory.id);
  const last = Math.max(0, ids.length - 1);
  const index = byId >= 0 ? byId : Math.min(Math.max(Number(memory.index) || 0, 0), last);
  return { index, focus: memory.focus === true && ids.length > 0 };
}

/**
 * Mount a keyboard-triaged list into `host`.
 *
 * opts:
 *   name      — which inbox ("approvals", "review"): the key the kept
 *               selection is stored under
 *   label     — the list's accessible name
 *   keys      — action-key map (`{ g: "grant" }`), also the row menu's contents
 *   render    — (row, { perform(action), reload }) → the row's content nodes
 *   rowLabel  — (row) → the row's short accessible name
 *   prompt    — (row, action) → the armed question ("Grant Bash?")
 *   perform   — (row, action, reload) → void
 *   reload    — refetch + redraw the whole inbox after a decision
 */
export function mountTriage(host, rows, opts) {
  const name = typeof opts.name === "string" ? opts.name : "inbox";
  const reload = opts.reload ?? (() => {});
  const rowId = (row) => String(row?.id ?? "");
  const listNode = el("ul", { class: "inbox", "aria-label": String(opts.label ?? "inbox") });
  const helpNode = el("div", { class: "card keyhelp" });
  const menuNode = el("div", { class: "card rowmenu" });
  const wrapper = el("div", { class: "triage", "data-triage": name });

  const start = startSelection(rows.map(rowId), kept.get(name) ?? null);
  kept.delete(name);
  let state = {
    index: start.index,
    count: rows.length,
    menuOpen: false,
    helpOpen: false,
    armed: null,
  };

  const perform = (row, action) => {
    kept.set(name, { id: rowId(row), index: rows.indexOf(row), focus: true });
    opts.perform(row, action, reload);
  };

  const prompt = (row, action) =>
    `${typeof opts.prompt === "function" ? opts.prompt(row, action) : `${action}?`} Enter confirms, Esc cancels.`;

  // Each row is built once and then decorated in place, keyed by its id, so
  // the row that holds focus keeps it while the selection moves.
  const slots = [];
  const nodes = [];
  const build = ({ row, i }) => {
    const slot = el("div", { class: "inbox-state" });
    slots[i] = slot;
    const node = el(
      "li",
      {
        class: "card inbox-card",
        tabindex: "-1",
        "aria-label": typeof opts.rowLabel === "function" ? opts.rowLabel(row) : null,
      },
      [slot, ...opts.render(row, { perform: (action) => perform(row, action), reload })],
    );
    // A click or a focus anywhere in a row makes it the selected one.
    node.addEventListener("click", () => select(i));
    node.addEventListener("focusin", () => select(i));
    nodes[i] = node;
    return node;
  };
  const keyed = rows.map((row, i) => ({ row, i }));

  const roving = rovingList(wrapper, ".inbox-card", { onKey });

  function select(i) {
    if (i === state.index) return;
    state = { ...state, index: i, armed: null };
    paint();
  }

  function paint() {
    reconcile(listNode, keyed, { keyOf: ({ row, i }) => `${i}:${rowId(row)}`, create: build });
    nodes.forEach((node, i) => {
      const selected = i === state.index;
      node.classList.toggle("selected", selected);
      if (selected) node.setAttribute("aria-current", "true");
      else node.removeAttribute("aria-current");
      const armed = state.armed !== null && state.armed.index === i ? state.armed : null;
      slots[i].replaceChildren(
        ...(selected ? [statusBadge("info", "Selected")] : []),
        ...(armed !== null
          ? [
              statusBadge("warn", "Armed"),
              el("span", { class: "inbox-armed", text: prompt(rows[i], armed.action) }),
            ]
          : []),
      );
    });
    roving.setCurrent(state.index);
    helpNode.hidden = !state.helpOpen;
    menuNode.hidden = !state.menuOpen;
    if (state.menuOpen) {
      const row = rows[state.index];
      menuNode.replaceChildren(
        el(
          "div",
          { class: "rowmenu-body", role: "group", "aria-label": "row actions" },
          Object.entries(opts.keys).map(([key, action]) =>
            el("button", {
              class: "btn",
              type: "button",
              text: `${action} (${key})`,
              onClick: () => {
                if (row !== undefined) perform(row, action);
              },
            }),
          ),
        ),
      );
    }
  }

  function onKey(event, rowIndex) {
    const target = event.target;
    // Never steal keys from a field the operator is typing in.
    if (isField(target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!isTriageKey(event.key, opts.keys, readPrefs().singleKeys)) return;
    const onRow = target instanceof Element && target.matches(".inbox-card");
    // Enter on a row's own button or link is that control's.
    if (event.key === "Enter" && !onRow) return;
    // Escape in the row menu closes it and hands focus back to the row.
    if (event.key === "Escape" && menuNode.contains(target)) {
      event.preventDefault();
      state = { ...state, menuOpen: false };
      paint();
      roving.focus(state.index);
      return;
    }
    event.preventDefault();
    if (rowIndex >= 0 && rowIndex !== state.index)
      state = { ...state, index: rowIndex, armed: null };
    const before = state;
    const { state: next, effect, follow } = triageKey(state, event.key, opts.keys);
    state = next;
    paint();
    if (state.armed !== null && state.armed !== before.armed) {
      announce(prompt(rows[state.armed.index], state.armed.action));
    }
    if (effect !== null) {
      const row = rows[effect.index];
      if (row !== undefined) perform(row, effect.action);
      return;
    }
    if (follow !== null) {
      const link = nodes[follow]?.querySelector(".name-link");
      if (link instanceof HTMLElement) link.click();
      return;
    }
    if (state.index !== before.index) roving.focus(state.index);
    if (event.key === "." && state.menuOpen) {
      const first = menuNode.querySelector("button");
      if (first instanceof HTMLElement) first.focus();
    }
  }

  helpNode.appendChild(
    el(
      "ul",
      { class: "check-list" },
      keyHelp(opts.keys).map((b) =>
        el("li", null, [
          el("kbd", { class: "mono", text: b.key }),
          el("span", { text: ` — ${b.does}` }),
        ]),
      ),
    ),
  );

  wrapper.appendChild(
    el("div", { class: "inbox-hint muted" }, [
      el("span", { text: "j/k move · " }),
      el("span", { text: `${Object.keys(opts.keys).join("/")} choose, Enter confirms · ` }),
      el("span", { text: ". row menu · ? keys (while the list has focus)" }),
    ]),
  );
  wrapper.appendChild(helpNode);
  wrapper.appendChild(menuNode);
  wrapper.appendChild(listNode);
  host.appendChild(wrapper);
  paint();
  if (start.focus) roving.focus(state.index);
}
