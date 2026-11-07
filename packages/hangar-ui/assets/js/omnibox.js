/**
 * HM-189 — the ⌘K command menu.
 *
 * A text field, a ranked result list, and — kept visually and behaviourally
 * separate — the ACTIONS the server proposed for the query. Navigation
 * results go somewhere on Enter. Actions do not: Enter (or a click) on an
 * action only ARMS it, opening a confirm row outside the list that shows the
 * exact CLI command, and nothing runs until "Run it" is pressed.
 *
 * That split is the point. A menu that can start a daemon on Enter is a
 * loaded gun on the keyboard; one that can only ever propose, and shows its
 * CLI twin while proposing, is a faster way to do the thing you were going
 * to do anyway.
 *
 * It is a combobox (`ui/listbox.js`): focus stays in the field, the list is
 * a listbox of options only (an option may hold no button), and
 * `aria-activedescendant` follows the arrows. The empty and no-match words
 * sit outside the listbox, in a status line. The whole menu is one native
 * dialog (`ui/dialog.js`), so the page behind is inert and focus returns to
 * whatever opened it.
 *
 * The index itself lives server-side and is built lazily (nothing is
 * indexed until the first query), so opening this overlay on a hundred-
 * harness machine costs one request, not a scan.
 */

import { api } from "./api.js";
import { el, emptyState, toast } from "./dom.js";
import { ROUTES } from "./routes.js";
import { openDialog } from "./ui/dialog.js";
import { comboboxKey, wireCombobox } from "./ui/listbox.js";

/** Debounce for keystroke → request. Short enough to feel live, long enough
 *  that a fast typist issues one request per word, not per letter. */
const DEBOUNCE_MS = 120;

/** Kind → the short label shown in the row's leading chip. */
const KIND_LABEL = {
  harness: "harness",
  group: "group",
  tag: "tag",
  session: "session",
  wiki: "wiki",
  fact: "facts",
  dataset: "dataset",
  grader: "grader",
  "eval-run": "eval run",
  incident: "incident",
  approval: "approval",
  action: "action",
};

/**
 * Which api wrapper an action's `route` names. Actions only ever reference
 * the process verbs, and this map is the allowlist that keeps it that way:
 * a server proposing anything else finds no executor here and the row
 * renders disabled with the reason.
 */
const ACTION_EXECUTORS = {
  procStart: (id) => api.procStart(id),
  procStop: (id) => api.procStop(id),
  procRestart: (id) => api.procRestart(id),
  procDrain: (id) => api.procDrain(id),
};

let menuCount = 0;

/**
 * Open the menu. Returns `{ close }`; the caller (app.js) owns when it
 * opens, because ⌘K ownership is decided by the `keys.js` reducer.
 */
export function openOmnibox(opts = {}) {
  const onClose = typeof opts.onClose === "function" ? opts.onClose : () => {};
  menuCount += 1;
  const prefix = `omni-${menuCount}`;
  const input = el("input", {
    class: "omni-input",
    type: "search",
    placeholder: "Search harnesses, sessions, wiki, runs… or type “start <harness>”",
    "aria-label": "Search the fleet",
    autocomplete: "off",
    spellcheck: "false",
  });
  const listNode = el("div", { class: "omni-list", id: `${prefix}-list`, "aria-label": "Results" });
  const status = el("div", { class: "omni-status", role: "status" });
  const confirmRow = el("div", {
    class: "omni-confirm-row",
    role: "group",
    "aria-label": "Confirm this action",
    tabindex: "-1",
    hidden: true,
  });
  const hint = el("div", { class: "omni-hint muted" }, [
    el("span", { text: "Enter opens · actions ask first · Esc closes" }),
  ]);
  const combo = wireCombobox(input, listNode);

  let rows = [];
  let cursor = -1;
  let armed = null;
  let seq = 0;
  let timer = null;

  const dialog = openDialog({
    title: "Search the fleet",
    titleHidden: true,
    className: "omni-panel",
    dataset: { keyOwned: "" },
    dismissOnBackdrop: true,
    initialFocus: input,
    body: [input, listNode, status, confirmRow, hint],
    onClose: () => {
      if (timer !== null) clearTimeout(timer);
      onClose();
    },
  });
  const close = () => dialog.close();

  const optionId = (index) => `${prefix}-opt-${index}`;

  const showStatus = (node) => {
    status.replaceChildren(...(node === null ? [] : [node]));
  };

  const disarm = () => {
    armed = null;
    confirmRow.hidden = true;
    confirmRow.replaceChildren();
  };

  const arm = (index) => {
    const row = rows[index];
    if (row === undefined) return;
    armed = index;
    const runnable = canRunAction(row.route);
    const run = el("button", {
      class: "btn btn-danger",
      type: "button",
      text: "Run it",
      disabled: !runnable,
      onClick: () => runAction(row),
    });
    const cancel = el("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Cancel",
      onClick: () => {
        disarm();
        input.focus();
      },
    });
    confirmRow.replaceChildren(
      el("strong", { text: `${row.title}?` }),
      row.cliTwin !== "" ? el("code", { class: "omni-twin mono", text: row.cliTwin }) : null,
      runnable
        ? null
        : el("span", { class: "muted", text: `this build cannot run “${row.route}” from here` }),
      run,
      cancel,
    );
    confirmRow.hidden = false;
    confirmRow.focus();
  };

  // Escape on the confirm row cancels the action, not the whole menu.
  confirmRow.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    disarm();
    input.focus();
  });

  const paint = () => {
    listNode.replaceChildren(...rows.map((row, i) => rowNode(row, i)));
    combo.setExpanded(rows.length > 0);
    combo.setActive(cursor >= 0 && cursor < rows.length ? optionId(cursor) : null);
    if (rows.length === 0) {
      showStatus(
        input.value.trim() === ""
          ? el("div", null, [
              el("div", { class: "empty-msg", text: "Type to search the fleet" }),
              el("div", {
                class: "empty-verb muted",
                text: "the index is built on demand — nothing is scanned until you ask",
              }),
            ])
          : emptyState(`Nothing matches “${input.value.trim()}”`, "crewhaus harness list"),
      );
    } else showStatus(null);
  };

  const go = (index) => {
    const row = rows[index];
    if (row === undefined) return;
    if (row.kind === "action") {
      arm(index);
      return;
    }
    close();
    window.location.hash = row.href.startsWith("#") ? row.href.slice(1) : row.href;
  };

  const rowNode = (row, index) => {
    const selected = index === cursor;
    const chip = el("span", { class: "omni-kind", text: KIND_LABEL[row.kind] ?? row.kind });
    const children =
      row.kind === "action"
        ? [
            chip,
            el("span", { class: "omni-title", text: row.title }),
            el("code", { class: "omni-twin mono", text: row.cliTwin }),
          ]
        : [
            chip,
            el("span", { class: "omni-title", text: row.title }),
            el("span", { class: "omni-sub muted", text: row.subtitle }),
          ];
    return el(
      "div",
      {
        class: `omni-row${row.kind === "action" ? " omni-action" : ""}${selected ? " selected" : ""}`,
        role: "option",
        id: optionId(index),
        "aria-selected": selected ? "true" : "false",
        onClick: () => {
          cursor = index;
          paint();
          go(index);
        },
      },
      children,
    );
  };

  const runAction = async (row) => {
    const executor = ACTION_EXECUTORS[row.route];
    if (executor === undefined) {
      toast(`This build cannot run “${row.route}” from the command menu`, "error");
      return;
    }
    disarm();
    try {
      const res = await executor(row.params?.id);
      // The process routes answer a typed refusal as a BODY; surface it.
      if (res && res.ok === false) {
        toast(String(res.body?.message ?? res.body?.reason ?? "refused"), "error");
      } else {
        toast(`${row.title} — sent`, "info");
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), "error");
    }
    close();
  };

  const search = async () => {
    const query = input.value.trim();
    const mine = ++seq;
    if (query === "") {
      rows = [];
      cursor = -1;
      disarm();
      paint();
      return;
    }
    let payload = null;
    try {
      payload = await api.search(query);
    } catch (err) {
      if (mine !== seq) return;
      rows = [];
      cursor = -1;
      paint();
      showStatus(
        emptyState(
          `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          "crewhaus harness list",
        ),
      );
      return;
    }
    if (mine !== seq) return; // a newer keystroke already answered
    rows = omniRows(payload);
    cursor = rows.length > 0 ? 0 : -1;
    disarm();
    paint();
  };

  input.addEventListener("input", () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(search, DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (event) => {
    const key =
      event.ctrlKey && event.key === "n"
        ? "ArrowDown"
        : event.ctrlKey && event.key === "p"
          ? "ArrowUp"
          : event.key;
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(key)) return;
    if (key === "Escape" && armed === null) return; // the menu itself closes
    const result = comboboxKey(
      { count: rows.length, cursor, kinds: rows.map((r) => r.kind), armed },
      key,
    );
    if (result.effect === null) return;
    event.preventDefault();
    if (result.effect === "disarm") {
      event.stopPropagation();
      disarm();
      return;
    }
    cursor = result.state.cursor;
    if (result.effect === "move") {
      disarm();
      paint();
      document.getElementById(optionId(cursor))?.scrollIntoView({ block: "nearest" });
      return;
    }
    // Enter NEVER runs an action: it asks. Navigation rows go.
    go(result.index);
  });

  paint();
  return { close };
}

/**
 * The server payload → the overlay's row list: navigation entries first,
 * then actions. Pure, and exported so the ordering and the shape can be
 * tested without a DOM.
 */
export function omniRows(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const actions = Array.isArray(body.actions) ? body.actions : [];
  return [
    ...entries.map((e) => ({
      kind: typeof e.kind === "string" ? e.kind : "harness",
      id: String(e.id ?? ""),
      title: String(e.title ?? ""),
      subtitle: String(e.subtitle ?? ""),
      href: typeof e.href === "string" ? e.href : "#/",
    })),
    ...actions.map((a) => ({
      kind: "action",
      id: String(a.id ?? ""),
      title: String(a.label ?? ""),
      subtitle: "",
      href: "#/",
      route: String(a.route ?? ""),
      params: a.params && typeof a.params === "object" ? a.params : {},
      cliTwin: String(a.cliTwin ?? ""),
      // Never trusted from the payload: an action is confirmed here, always.
      confirm: true,
    })),
  ];
}

/** True when this build can execute the named action route. Exported so the
 *  row can render disabled-with-reason rather than failing on click. */
export function canRunAction(route) {
  return Object.hasOwn(ACTION_EXECUTORS, String(route)) && Object.hasOwn(ROUTES, String(route));
}
