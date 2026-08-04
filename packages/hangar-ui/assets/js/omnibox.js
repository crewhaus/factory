/**
 * HM-189 — the ⌘K overlay.
 *
 * A text field, a ranked result list, and — kept visually and behaviourally
 * separate — the ACTIONS the server proposed for the query. Navigation
 * results are links: pressing Enter on one goes somewhere. Actions are not:
 * an action needs a second, explicit confirm before the console calls the
 * ordinary route, and the row shows the exact CLI command it will run first.
 *
 * That split is the point. An omnibox that can start a daemon on Enter is a
 * loaded gun on the keyboard; one that can only ever propose, and shows its
 * CLI twin while proposing, is a faster way to do the thing you were going
 * to do anyway.
 *
 * The index itself lives server-side and is built lazily (nothing is
 * indexed until the first query), so opening this overlay on a hundred-
 * harness machine costs one request, not a scan.
 */

import { api } from "./api.js";
import { clear, el, emptyState, toast } from "./dom.js";
import { ROUTES } from "./routes.js";

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

/**
 * Mount the overlay. Returns `{ close }`; the caller (app.js) owns when it
 * opens, because ⌘K ownership is decided by the `keys.js` reducer.
 */
export function openOmnibox(host, opts = {}) {
  const onClose = opts.onClose ?? (() => {});
  const backdrop = el("div", { class: "omni-backdrop", role: "presentation" });
  const input = el("input", {
    class: "omni-input",
    type: "search",
    placeholder: "Search harnesses, sessions, wiki, runs… or type “start <harness>”",
    "aria-label": "search the fleet",
    autocomplete: "off",
    spellcheck: "false",
  });
  const listNode = el("div", { class: "omni-list", role: "listbox" });
  const hint = el("div", { class: "omni-hint muted" }, [
    el("span", { text: "Enter opens · actions ask first · Esc closes" }),
  ]);
  const panel = el(
    "div",
    { class: "omni-panel", role: "dialog", "aria-modal": "true", "aria-label": "omnibox" },
    [input, listNode, hint],
  );
  backdrop.appendChild(panel);
  host.appendChild(backdrop);

  let rows = [];
  let cursor = 0;
  let seq = 0;
  let timer = null;
  let pendingConfirm = null;

  const close = () => {
    if (timer !== null) clearTimeout(timer);
    backdrop.remove();
    onClose();
  };

  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });

  const draw = () => {
    clear(listNode);
    if (rows.length === 0) {
      listNode.appendChild(
        input.value.trim() === ""
          ? el("div", { class: "empty" }, [
              el("div", { class: "empty-msg", text: "Type to search the fleet" }),
              el("div", {
                class: "empty-verb muted",
                text: "the index is built on demand — nothing is scanned until you ask",
              }),
            ])
          : emptyState(`Nothing matches “${input.value.trim()}”`, "crewhaus harness list"),
      );
      return;
    }
    rows.forEach((row, i) => listNode.appendChild(rowNode(row, i)));
  };

  const rowNode = (row, index) => {
    const selected = index === cursor;
    const chip = el("span", { class: "omni-kind", text: KIND_LABEL[row.kind] ?? row.kind });
    if (row.kind === "action") {
      const confirming = pendingConfirm === row.id;
      const node = el(
        "div",
        {
          class: `omni-row omni-action${selected ? " selected" : ""}`,
          role: "option",
          "aria-selected": selected ? "true" : "false",
        },
        [
          chip,
          el("span", { class: "omni-title", text: row.title }),
          el("code", { class: "omni-twin mono", text: row.cliTwin }),
          confirming
            ? el("span", { class: "omni-confirm" }, [
                el("button", {
                  class: "btn btn-danger",
                  type: "button",
                  text: "Run it",
                  onClick: () => runAction(row),
                }),
                el("button", {
                  class: "btn btn-ghost",
                  type: "button",
                  text: "Cancel",
                  onClick: () => {
                    pendingConfirm = null;
                    draw();
                  },
                }),
              ])
            : el("button", {
                class: "btn",
                type: "button",
                text: "Confirm…",
                onClick: () => {
                  pendingConfirm = row.id;
                  draw();
                },
              }),
        ],
      );
      return node;
    }
    return el(
      "a",
      {
        class: `omni-row${selected ? " selected" : ""}`,
        role: "option",
        "aria-selected": selected ? "true" : "false",
        href: row.href,
        onClick: () => close(),
      },
      [
        chip,
        el("span", { class: "omni-title", text: row.title }),
        el("span", { class: "omni-sub muted", text: row.subtitle }),
      ],
    );
  };

  const runAction = async (row) => {
    const executor = ACTION_EXECUTORS[row.route];
    if (executor === undefined) {
      toast(`This build cannot run “${row.route}” from the omnibox`, "error");
      return;
    }
    pendingConfirm = null;
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
      draw();
      return;
    }
    let payload = null;
    try {
      payload = await api.search(query);
    } catch (err) {
      if (mine !== seq) return;
      rows = [];
      clear(listNode).appendChild(
        emptyState(
          `Search failed: ${err instanceof Error ? err.message : String(err)}`,
          "crewhaus harness list",
        ),
      );
      return;
    }
    if (mine !== seq) return; // a newer keystroke already answered
    rows = omniRows(payload);
    cursor = 0;
    pendingConfirm = null;
    draw();
  };

  input.addEventListener("input", () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(search, DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      cursor = rows.length === 0 ? 0 : Math.min(cursor + 1, rows.length - 1);
      draw();
      return;
    }
    if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      cursor = Math.max(cursor - 1, 0);
      draw();
      return;
    }
    if (event.key === "Enter") {
      const row = rows[cursor];
      if (row === undefined) return;
      event.preventDefault();
      // Enter NEVER runs an action: it asks. Navigation rows go.
      if (row.kind === "action") {
        pendingConfirm = row.id;
        draw();
        return;
      }
      window.location.hash = row.href.startsWith("#") ? row.href.slice(1) : row.href;
      close();
    }
  });

  input.focus();
  draw();
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
