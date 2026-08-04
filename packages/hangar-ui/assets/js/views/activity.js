/**
 * The activity digest — "what changed since yesterday", across the fleet,
 * grouped by kind.
 *
 * Every item is a POINTER, never a payload copy (the server builds the
 * digest from mtimes and small capped folds — no transcript is ever opened
 * for it), so every row's job is to be a good link: each one deep-links into
 * the screen that owns the thing that changed.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import { activityGroups, activityHref } from "../supervision.js";
import { fmtRelativeTime } from "../util.js";

/** The windows the digest offers; `since` is the server's own grammar. */
const WINDOWS = [
  { since: "1d", label: "24 hours" },
  { since: "7d", label: "7 days" },
  { since: "30d", label: "30 days" },
];

export async function renderActivity(root) {
  clear(root).appendChild(skeleton(6));
  await draw(root, "1d", null);
}

async function draw(host, since, enabled) {
  let payload;
  try {
    payload = await api.activity(since);
  } catch (err) {
    clear(host).appendChild(
      el("div", { class: "card error-card" }, [
        el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      ]),
    );
    return;
  }
  clear(host);
  const nowMs = Date.now();
  const items = payload && Array.isArray(payload.items) ? payload.items : [];
  const groups = activityGroups(items, enabled);

  host.appendChild(
    el(
      "div",
      { class: "filter-bar", role: "group", "aria-label": "digest window" },
      WINDOWS.map((w) =>
        el("button", {
          class: `btn btn-ghost${w.since === since ? " active" : ""}`,
          type: "button",
          text: w.label,
          onClick: () => draw(host, w.since, enabled),
        }),
      ),
    ),
  );
  host.appendChild(
    el("div", { class: "rollup" }, [
      el("span", {
        text: `${items.length} change${items.length === 1 ? "" : "s"} since ${
          payload && typeof payload.since === "string"
            ? fmtRelativeTime(payload.since, nowMs)
            : since
        }`,
      }),
      payload && payload.truncated === true
        ? el("span", { class: "chip chip-warn", text: "capped — older items not shown" })
        : null,
    ]),
  );

  if (items.length === 0) {
    host.appendChild(
      emptyState("Nothing has changed in this window", "crewhaus run (or start a daemon)"),
    );
    return;
  }

  // Per-group filters: a switched-off kind still shows its count, so the
  // digest never hides how much it is hiding.
  host.appendChild(
    el(
      "div",
      { class: "filter-bar", role: "group", "aria-label": "activity kinds" },
      groups.map((g) =>
        el("button", {
          class: `btn btn-ghost${g.shown ? " active" : ""}`,
          type: "button",
          text: `${g.label} ${g.count}`,
          onClick: () => {
            const next = new Set(
              enabled === null ? groups.filter((x) => x.shown).map((x) => x.kind) : enabled,
            );
            if (next.has(g.kind)) next.delete(g.kind);
            else next.add(g.kind);
            draw(host, since, next);
          },
        }),
      ),
    ),
  );

  const visible = groups.filter((g) => g.shown);
  if (visible.length === 0) {
    host.appendChild(emptyState("Every kind is filtered out — re-enable one above"));
    return;
  }
  for (const group of visible) {
    host.appendChild(
      el("section", { class: "card" }, [
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
      ]),
    );
  }
}
