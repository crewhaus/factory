/**
 * Home (`#/`): what needs you, what is working, what changed.
 *
 * A machine with no harnesses and no scan roots is a first visit, and gets
 * the onboarding screen the harness list has always shown. Otherwise Home
 * draws one card per row of `HOME_PANELS`, and each card loads, empties and
 * fails on its own: a slow or failed read in one never blanks the others.
 * Every card ends in "See all", the page its row owns.
 *
 * Home reads only what the panels need, through `api`: the inboxes' counts
 * and newest items, each harness's process picture, and the last day of the
 * activity digest. It never imports another screen's module.
 */

import { api } from "../api.js";
import { HOME_PANELS } from "../destinations.js";
import { clear, dot, el, skeleton } from "../dom.js";
import { hrefFleet, hrefGlobal, hrefHarness } from "../router.js";
import { activityHref, procRow } from "../supervision.js";
import { emptyFor } from "../ui/empty.js";
import { timeEl } from "../ui/time.js";
import { dirTail, normalizeRows } from "../util.js";
import { renderOnboarding, shouldOnboard } from "./onboarding.js";

const DAY_MS = 86_400_000;
/** How many items a panel lists before "See all". */
export const PANEL_ITEMS = 3;
/** The process states that count as working now. */
export const WORKING_STATES = Object.freeze([
  "preflight",
  "starting",
  "running",
  "draining",
  "parked",
]);

export async function renderHome(root, ctx = {}) {
  clear(root).appendChild(skeleton(4));
  const feed = await api.harnesses();
  const rows = normalizeRows(feed);
  if (rows.length === 0) {
    const [onboarding] = await Promise.allSettled([api.onboarding()]);
    const view = onboarding.status === "fulfilled" ? onboarding.value : null;
    if (ctx.signal?.aborted) return;
    if (shouldOnboard(view, rows.length)) {
      clear(root);
      await renderOnboarding(root, { reload: () => renderHome(root, ctx) });
      return;
    }
  }
  if (ctx.signal?.aborted) return;
  clear(root);
  const grid = el("div", { class: "home-panels" });
  root.appendChild(grid);
  const harnesses = rows.filter((row) => row.missingSince === null);
  await Promise.all(HOME_PANELS.map((row) => mountPanel(grid, row, { ...ctx, harnesses })));
}

/** One card: its heading, its body, and its "See all". */
async function mountPanel(grid, row, ctx) {
  const headingId = `home-panel-${row.id}`;
  const body = el("div", { class: "home-panel-body" }, [skeleton(3)]);
  grid.appendChild(
    el("section", { class: "card home-panel", "aria-labelledby": headingId }, [
      el("div", { class: "home-panel-head" }, [
        el("h2", { class: "card-title", id: headingId, text: row.title }),
        el("a", {
          class: "home-see-all",
          href: hrefFleet("home", row.id),
          "aria-label": `See all: ${row.title}`,
          text: "See all",
        }),
      ]),
      body,
    ]),
  );
  const draw = async () => {
    clear(body).appendChild(skeleton(3));
    try {
      const mod = await row.panel.load();
      if (ctx.signal?.aborted) return;
      await row.panel.render(mod, body, ctx);
    } catch (err) {
      if (ctx.signal?.aborted) return;
      clear(body).appendChild(
        emptyFor({
          cause: "connection-failed",
          subject: "Home",
          detail: err instanceof Error ? err.message : String(err),
          onAction: () => void draw(),
        }),
      );
    }
  };
  await draw();
}

/** A panel with nothing in it: why, in one sentence. */
function nothing(message) {
  return el("div", { class: "empty", "data-cause": "no-data" }, [
    el("div", { class: "empty-msg", text: message }),
  ]);
}

/**
 * A Retry that draws the panel again in place; if the whole panel then
 * fails, it says so and offers Retry again.
 */
function retryInto(root, ctx, render, subject) {
  return () => {
    clear(root).appendChild(skeleton(3));
    render(root, ctx).catch((err) => {
      if (ctx.signal?.aborted) return;
      clear(root).appendChild(
        emptyFor({
          cause: "connection-failed",
          subject,
          detail: err instanceof Error ? err.message : String(err),
          onAction: retryInto(root, ctx, render, subject),
        }),
      );
    });
  };
}

const itemList = (items) => el("ul", { class: "home-list" }, items);

/** The newest `n` of a list, by an ISO time field. Pure. */
export function newestFirst(items, field, n = PANEL_ITEMS) {
  const list = Array.isArray(items) ? items.filter((i) => i && typeof i === "object") : [];
  return [...list]
    .sort((a, b) => String(b[field] ?? "").localeCompare(String(a[field] ?? "")))
    .slice(0, n);
}

/**
 * What needs you, from the two inbox reads. Pure. A read that failed is
 * passed as `null` and is not zero: its count is `null` and its name is in
 * `failed`, so nothing downstream can print "0 waiting" or "nothing needs
 * you" for a list nobody could read.
 * `{ approvals: [...top], review: [...top], pending, open, failed }`.
 */
export function needsYouModel(approvalsPayload, reviewPayload) {
  const read = (payload) => payload !== null && typeof payload === "object";
  const a = read(approvalsPayload) ? approvalsPayload : null;
  const r = read(reviewPayload) ? reviewPayload : null;
  const approvals = (Array.isArray(a?.approvals) ? a.approvals : []).filter(
    (row) => row?.status === "pending",
  );
  const review = (Array.isArray(r?.items) ? r.items : []).filter((row) => row?.status === "open");
  const failed = [];
  if (a === null) failed.push("approvals");
  if (r === null) failed.push("review");
  return {
    approvals: newestFirst(approvals, "createdAt"),
    review: newestFirst(review, "ts"),
    pending: a === null ? null : typeof a.pending === "number" ? a.pending : approvals.length,
    open: r === null ? null : typeof r.open === "number" ? r.open : review.length,
    failed,
  };
}

/** True only when both inboxes answered and neither holds anything. Pure. */
export function nothingNeedsYou(model) {
  return (
    model.failed.length === 0 &&
    model.approvals.length === 0 &&
    model.review.length === 0 &&
    model.pending === 0 &&
    model.open === 0
  );
}

/** The summary line, from the inboxes that answered only. Pure; null when neither did. */
export function needsYouSummary(model) {
  const parts = [];
  if (model.pending !== null) {
    parts.push(`${model.pending} approval${model.pending === 1 ? "" : "s"} waiting`);
  }
  if (model.open !== null) {
    parts.push(`${model.open} review item${model.open === 1 ? "" : "s"} open`);
  }
  return parts.length === 0 ? null : parts.join(" · ");
}

const INBOX_SUBJECTS = Object.freeze({
  approvals: "the approvals list",
  review: "the review list",
});

/** Home's "Needs you": pending approvals and open review items, newest first. */
export async function renderNeedsYouPanel(root, ctx = {}) {
  const [approvals, review] = await Promise.allSettled([api.approvals(), api.review()]);
  if (approvals.status === "rejected" && review.status === "rejected") throw approvals.reason;
  if (ctx.signal?.aborted) return;
  const model = needsYouModel(
    approvals.status === "fulfilled" ? approvals.value : null,
    review.status === "fulfilled" ? review.value : null,
  );
  clear(root);
  if (nothingNeedsYou(model)) {
    root.appendChild(nothing("Nothing needs you right now."));
    return;
  }
  const items = [
    ...model.approvals.map((row) =>
      el("li", { class: "home-item" }, [
        el("a", {
          href: hrefGlobal("approvals"),
          text: `Approve or deny: ${String(row.toolName)}`,
        }),
        el("span", { class: "muted", text: String(row.specName ?? "") }),
        timeEl(row.createdAt),
      ]),
    ),
    ...model.review.map((row) =>
      el("li", { class: "home-item" }, [
        el("a", {
          href: hrefGlobal("review"),
          text: `Review: ${String(row.kind).replace(/_/g, " ")}`,
        }),
        el("span", { class: "muted", text: String(row.specName ?? "") }),
        timeEl(row.ts),
      ]),
    ),
  ];
  const summary = needsYouSummary(model);
  if (summary !== null) root.appendChild(el("p", { class: "muted home-summary", text: summary }));
  if (items.length > 0) root.appendChild(itemList(items));
  for (const source of model.failed) {
    root.appendChild(
      emptyFor({
        cause: "connection-failed",
        subject: INBOX_SUBJECTS[source],
        onAction: retryInto(root, ctx, renderNeedsYouPanel, INBOX_SUBJECTS[source]),
      }),
    );
  }
}

/** The harnesses whose process is working now, judged the way the board judges them. Pure. */
export function workingRows(harnesses, procs, nowMs) {
  const out = [];
  (Array.isArray(harnesses) ? harnesses : []).forEach((harness, i) => {
    const proc = Array.isArray(procs) ? procs[i] : null;
    if (proc === null || proc === undefined) return;
    const row = procRow(proc, nowMs);
    if (!WORKING_STATES.includes(row.state)) return;
    out.push({ id: harness.id, name: harness.specName || dirTail(harness.dir, 1), row });
  });
  return out;
}

/**
 * The Working-now picture from the per-harness process reads. Pure. A read
 * that failed is counted in `unchecked`, never judged "not running".
 */
export function workingModel(harnesses, settled, nowMs) {
  const list = Array.isArray(settled) ? settled : [];
  const procs = list.map((s) => (s?.status === "fulfilled" ? s.value : null));
  return {
    working: workingRows(harnesses, procs, nowMs),
    unchecked: list.filter((s) => s?.status !== "fulfilled").length,
  };
}

/** Home's "Working now": every harness whose process is running. */
export async function renderWorkingPanel(root, ctx = {}) {
  const harnesses = Array.isArray(ctx.harnesses) ? ctx.harnesses : [];
  const settled = await Promise.allSettled(harnesses.map((h) => api.proc(h.id)));
  if (ctx.signal?.aborted) return;
  if (harnesses.length > 0 && settled.every((s) => s.status === "rejected")) {
    throw settled[0].reason;
  }
  const { working, unchecked } = workingModel(harnesses, settled, Date.now());
  clear(root);
  if (unchecked > 0) {
    root.appendChild(
      emptyFor({
        cause: "connection-failed",
        subject: `${unchecked} harness${unchecked === 1 ? "" : "es"}`,
        onAction: retryInto(root, ctx, renderWorkingPanel, "the harnesses"),
      }),
    );
  }
  if (working.length === 0) {
    root.appendChild(nothing(unchecked > 0 ? "Nothing else is running." : "Nothing is running."));
    return;
  }
  root.appendChild(
    itemList(
      working
        .slice(0, PANEL_ITEMS)
        .map(({ id, name, row }) =>
          el("li", { class: "home-item" }, [
            el("a", { href: hrefHarness(id), text: name }),
            dot(row.pill.dot, row.pill.label),
            row.uptime !== "—" ? el("span", { class: "muted", text: `up ${row.uptime}` }) : null,
          ]),
        ),
    ),
  );
  if (working.length > PANEL_ITEMS) {
    root.appendChild(el("p", { class: "muted", text: `${working.length} working in all.` }));
  }
}

/** Home's "What changed": the activity digest for the last day, newest first. */
export async function renderChangesPanel(root, ctx = {}) {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const payload = await api.activity(since);
  if (ctx.signal?.aborted) return;
  const items = newestFirst(
    payload && typeof payload === "object" && Array.isArray(payload.items) ? payload.items : [],
    "at",
    5,
  );
  clear(root);
  if (items.length === 0) {
    root.appendChild(nothing("No changes in the last day."));
    return;
  }
  root.appendChild(
    itemList(
      items.map((item) => {
        const href = activityHref(item);
        const label = String(item.label ?? "");
        return el("li", { class: "home-item" }, [
          href === null ? el("span", { text: label }) : el("a", { href, text: label }),
          el("span", { class: "muted", text: String(item.specName ?? "") }),
          timeEl(item.at),
        ]);
      }),
    ),
  );
}
