/**
 * The activity digest — "what changed since yesterday", across the fleet,
 * grouped by kind.
 *
 * Every item is a POINTER, never a payload copy (the server builds the
 * digest from mtimes and small capped folds — no transcript is ever opened
 * for it), so every row's job is to be a good link: each one deep-links into
 * the screen that owns the thing that changed.
 *
 * The window and the per-kind filters are toggles that update in place: the
 * button that was pressed is the one that holds focus afterwards, and a kind
 * that is switched off keeps its count, so the digest never hides how much
 * it is hiding. An empty digest says which kind of empty it is — nothing
 * happened, or the filters hide what did.
 */

import { api } from "../api.js";
import { clear, dot, el, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import { activityGroups, activityHref } from "../supervision.js";
import { emptyFor } from "../ui/empty.js";
import { reconcile } from "../ui/keyed.js";
import { setPressed, setToggleLabel, toggleBtn } from "../ui/toggle.js";
import { fmtRelativeTime } from "../util.js";

/** The windows the digest offers; `since` is the server's own grammar. */
const WINDOWS = [
  { since: "1d", label: "24 hours" },
  { since: "7d", label: "7 days" },
  { since: "30d", label: "30 days" },
];

export async function renderActivity(root) {
  clear(root).appendChild(skeleton(6));
  const view = {
    since: "1d",
    enabled: null,
    payload: null,
    windowBar: el("div", { class: "filter-bar", role: "group", "aria-label": "digest window" }),
    rollup: el("div", { class: "rollup" }),
    kindBar: el("div", { class: "filter-bar", role: "group", "aria-label": "activity kinds" }),
    body: el("div", { class: "activity-body" }),
    error: el("div"),
  };
  const windowBtns = WINDOWS.map((w) =>
    toggleBtn({
      label: w.label,
      pressed: w.since === view.since,
      onToggle: (_next, btn) => {
        // A window is a choice of one: pressing the current one keeps it.
        windowBtns.forEach((other, i) => setPressed(other, WINDOWS[i].since === w.since));
        if (view.since === w.since) return;
        view.since = w.since;
        void load(view, root);
        btn.focus();
      },
    }),
  );
  view.windowBar.replaceChildren(...windowBtns);
  await load(view, root);
}

async function load(view, root) {
  let payload;
  try {
    payload = await api.activity(view.since);
  } catch (err) {
    clear(root).appendChild(
      el("div", { class: "card error-card" }, [
        el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      ]),
    );
    return;
  }
  view.payload = payload;
  // The screen's frame is built once and kept, so the window toggles keep
  // focus while the digest under them changes.
  if (!root.contains(view.windowBar)) {
    clear(root);
    root.append(view.windowBar, view.rollup, view.kindBar, view.body);
  }
  paint(view);
}

function paint(view) {
  const payload = view.payload;
  const nowMs = Date.now();
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  const groups = activityGroups(items, view.enabled);

  view.rollup.replaceChildren(
    el("span", {
      text: `${items.length} change${items.length === 1 ? "" : "s"} since ${
        payload && typeof payload.since === "string"
          ? fmtRelativeTime(payload.since, nowMs)
          : view.since
      }`,
    }),
    payload && payload.truncated === true
      ? el("span", { class: "chip chip-warn", text: "capped — older items not shown" })
      : null,
  );

  // Per-kind toggles, keyed by kind: a toggle that stays is updated in place.
  reconcile(view.kindBar, groups, {
    keyOf: (g) => g.kind,
    create: (g) =>
      toggleBtn({
        label: `${g.label} ${g.count}`,
        pressed: g.shown,
        onToggle: () => {
          // Read at the click, not at creation: a toggle outlives a window change.
          const current = Array.isArray(view.payload?.items) ? view.payload.items : [];
          const next = new Set(
            view.enabled === null ? activityGroups(current, null).map((x) => x.kind) : view.enabled,
          );
          if (next.has(g.kind)) next.delete(g.kind);
          else next.add(g.kind);
          view.enabled = next;
          paint(view);
        },
      }),
    update: (btn, g) => {
      setPressed(btn, g.shown);
      setToggleLabel(btn, `${g.label} ${g.count}`);
    },
  });
  view.kindBar.hidden = groups.length === 0;

  if (items.length === 0) {
    view.body.replaceChildren(
      emptyFor({
        cause: "no-data",
        detail: "Nothing has changed in this window.",
        verb: "crewhaus run (or start a daemon)",
      }),
    );
    return;
  }
  const visible = groups.filter((g) => g.shown);
  if (visible.length === 0) {
    view.body.replaceChildren(
      emptyFor({
        cause: "filtered",
        detail: "Every kind is switched off above.",
        onAction: () => {
          view.enabled = null;
          paint(view);
          const first = view.kindBar.querySelector("button");
          if (first instanceof HTMLElement) first.focus();
        },
      }),
    );
    return;
  }
  // A body that held the empty state goes back to holding groups.
  for (const child of [...view.body.children]) {
    if (child.dataset.key === undefined) child.remove();
  }
  reconcile(view.body, visible, {
    keyOf: (g) => g.kind,
    create: (g) => el("section", { class: "card" }, groupContent(g, nowMs)),
    update: (node, g) => node.replaceChildren(...groupContent(g, nowMs)),
  });
}

function groupContent(group, nowMs) {
  return [
    el("h3", { class: "card-title" }, [
      el("span", { text: group.label }),
      el("span", { class: "muted card-sub", text: `${group.count}` }),
    ]),
    el(
      "ul",
      { class: "check-list" },
      group.items.map((item) => {
        const href = activityHref(item);
        const label = typeof item.label === "string" ? item.label : group.label;
        return el("li", { class: "activity-row" }, [
          dot("off", fmtRelativeTime(item.at ?? null, nowMs)),
          href !== null
            ? el("a", { class: "name-link", href, text: label })
            : el("span", { text: label }),
          el("a", {
            class: "muted sub",
            href: hrefHarness(String(item.harnessId ?? "")),
            text: String(item.specName ?? item.harnessId ?? ""),
          }),
        ]);
      }),
    ),
  ];
}
