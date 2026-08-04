/**
 * The shared triage shell both fleet inboxes wear: a selected row, j/k
 * movement, one-key verdicts, a `.` row menu and a `?` bindings sheet.
 *
 * All of the thinking is in `triageKey` — a pure reducer this package
 * unit-tests without a browser. This module only turns its `effect` into an
 * API call and its `state` into a redraw, which is why the bindings can be
 * proven correct without driving a DOM.
 */

import { clear, el } from "../dom.js";
import { isTriageKey, keyHelp, triageKey } from "../supervision.js";

/**
 * Mount a keyboard-triaged list into `host`.
 *
 * opts:
 *   keys    — action-key map (`{ g: "grant" }`), also the row menu's contents
 *   render  — (row, index, state, redraw, reload) → node
 *   perform — (row, action, reload) → void
 *   reload  — refetch + redraw the whole inbox after a decision
 */
export function mountTriage(host, rows, opts) {
  const listNode = el("div", { class: "inbox" });
  const helpNode = el("div", { class: "card keyhelp" });
  const menuNode = el("div", { class: "card rowmenu" });
  const reload = opts.reload ?? (() => {});
  let state = { index: 0, count: rows.length, menuOpen: false, helpOpen: false };

  const redraw = (next) => {
    state = next;
    clear(listNode);
    rows.forEach((row, i) => {
      listNode.appendChild(opts.render(row, i, state, redraw, reload));
    });
    helpNode.hidden = !state.helpOpen;
    menuNode.hidden = !state.menuOpen;
    if (state.menuOpen) {
      const row = rows[state.index];
      clear(menuNode).appendChild(
        el(
          "div",
          { class: "rowmenu-body" },
          Object.entries(opts.keys).map(([key, action]) =>
            el("button", {
              class: "btn",
              type: "button",
              text: `${action} (${key})`,
              onClick: () => {
                if (row !== undefined) opts.perform(row, action, reload);
              },
            }),
          ),
        ),
      );
    }
  };

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

  const onKey = (event) => {
    if (!listNode.isConnected) {
      document.removeEventListener("keydown", onKey);
      return;
    }
    const target = event.target;
    // Never steal keys from a field the operator is typing in.
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!isTriageKey(event.key, opts.keys)) return;
    event.preventDefault();
    const { state: next, effect } = triageKey(state, event.key, opts.keys);
    if (effect !== null) {
      const row = rows[effect.index];
      if (row !== undefined) opts.perform(row, effect.action, reload);
    }
    redraw(next);
  };
  document.addEventListener("keydown", onKey);

  host.appendChild(
    el("div", { class: "inbox-hint muted" }, [
      el("span", { text: "j/k move · " }),
      el("span", { text: `${Object.keys(opts.keys).join("/")} decide · ` }),
      el("span", { text: ". row menu · ? bindings" }),
    ]),
  );
  host.appendChild(helpNode);
  host.appendChild(menuNode);
  host.appendChild(listNode);
  redraw(state);
}
