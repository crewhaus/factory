/**
 * Home (`#/`): what needs you, what is working, what changed.
 *
 * A machine with no harnesses and no scan roots is a first visit, and gets
 * the onboarding screen the harness list has always shown. Otherwise Home
 * draws one card per row of `HOME_PANELS`, and each card loads, empties and
 * fails on its own: a slow or failed read in one never blanks the others.
 * Every card ends in "See all", the page its row owns.
 *
 * Home reads only what the panels need: Home's inbox (`attention.list`), each
 * harness's process picture, and the last day of the activity digest. The
 * inbox's items read in the inbox's own words (`views/attention.js`), so an
 * item says the same thing on Home as on the Needs-you page.
 *
 * Above the panels, the status line (`home.status`): the harnesses counted by
 * what they are doing, in words, each part a link to its list. A count Home
 * cannot know is not printed. It is read again on each event of Home's fleet
 * stream and when the tab comes back, patched in place, and a new item that
 * needs you is said politely, at most once every few seconds.
 *
 * A list Home read only part of says so in a muted note: the harnesses whose
 * requests could not be read, more items waiting than were read, and older
 * changes that were not shown. Counts stay as shown.
 */

import { api } from "../api.js";
import { HOME_PANELS } from "../destinations.js";
import { clear, dot, el, skeleton } from "../dom.js";
import { hrefFleet, hrefHarness } from "../router.js";
import { openRunStream } from "../runview/stream.js";
import { activityHref, procRow } from "../supervision.js";
import { emptyFor } from "../ui/empty.js";
import { announce } from "../ui/live.js";
import { timeEl } from "../ui/time.js";
import { dirTail, normalizeRows } from "../util.js";
import { call } from "../v1.js";
import { BANDS, itemIdOf, nameOf, partialNotes, textOf } from "./attention.js";
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
  const line = el("nav", { class: "home-status", "aria-label": "Your harnesses at a glance" });
  root.appendChild(line);
  const grid = el("div", { class: "home-panels" });
  root.appendChild(grid);
  const harnesses = rows.filter((row) => row.missingSince === null);
  await Promise.all([
    mountStatusLine(line, ctx),
    ...HOME_PANELS.map((row) => mountPanel(grid, row, { ...ctx, harnesses })),
  ]);
}

/** The status line's parts, in order: `{key, text, href}`. Absent counts are left out. Pure. */
export function statusLineParts(status) {
  const counts =
    status && typeof status.counts === "object" && status.counts !== null ? status.counts : {};
  const n = (key) => (typeof counts[key] === "number" && counts[key] >= 0 ? counts[key] : null);
  const parts = [];
  const harnesses = n("harnesses");
  if (harnesses !== null) {
    parts.push({
      key: "harnesses",
      text: `${harnesses} harness${harnesses === 1 ? "" : "es"}`,
      href: hrefFleet("harnesses"),
    });
  }
  const rows = [
    ["needsYou", (c) => `${c} need${c === 1 ? "s" : ""} you`, hrefFleet("home", "needs-you")],
    ["working", (c) => `${c} working`, hrefFleet("home", "working")],
    ["paused", (c) => `${c} paused`, hrefFleet("harnesses", null, { state: "paused" })],
    [
      "notResponding",
      (c) => `${c} not responding`,
      hrefFleet("harnesses", null, { state: "not-responding" }),
    ],
    ["waitingForBudget", (c) => `${c} waiting for budget`, hrefFleet("harnesses", "spend")],
  ];
  for (const [key, words, href] of rows) {
    const count = n(key);
    if (count !== null && count > 0) parts.push({ key, text: words(count), href });
  }
  return parts;
}

/** Why a count is not shown, one line each, from the answer's notes. Pure. */
export function statusLineNotes(status) {
  const notes = Array.isArray(status?.notes) ? status.notes : [];
  return notes
    .map((note) => (note && typeof note.note === "string" ? note.note : null))
    .filter((note) => note !== null);
}

/**
 * Patch the status line in place: one node per part, kept by its key, so a part that
 * stays keeps its node (and the focus on it) while its words and link change; only parts
 * that appear or go are added or removed. `nodes` holds the nodes across patches.
 */
export function patchStatusLine(line, parts, notes, nodes = new Map()) {
  const want = [];
  const keep = (key, make) => {
    let node = nodes.get(key);
    if (node === undefined) {
      node = make();
      nodes.set(key, node);
    }
    want.push(node);
    return node;
  };
  parts.forEach((part, i) => {
    if (i > 0) {
      keep(`sep:${part.key}`, () =>
        el("span", { class: "home-status-sep", "aria-hidden": "true", text: " · " }),
      );
    }
    const link = keep(`part:${part.key}`, () => el("a", { class: "home-status-part" }));
    if (link.textContent !== part.text) link.textContent = part.text;
    if (link.getAttribute("href") !== part.href) link.setAttribute("href", part.href);
    link.dataset.key = part.key;
  });
  for (const note of notes) {
    keep(`note:${note}`, () => el("span", { class: "muted home-status-note", text: note }));
  }
  const wanted = new Set(want);
  for (const child of [...line.childNodes]) {
    if (!wanted.has(child)) line.removeChild(child);
  }
  for (const [key, node] of nodes) {
    if (!wanted.has(node)) nodes.delete(key);
  }
  want.forEach((node, i) => {
    const at = line.childNodes[i];
    if (at !== node) line.insertBefore(node, at ?? null);
  });
  return nodes;
}

/** How long a polite "needs you" announcement waits before another. */
const ANNOUNCE_GAP_MS = 5_000;

/** Draw the status line, then keep it current from the fleet stream and the tab's return. */
async function mountStatusLine(line, ctx) {
  let lastNeeds = null;
  let lastAnnounced = 0;
  const nodes = new Map();
  const draw = async () => {
    const answer = await call("home.status");
    if (ctx.signal?.aborted) return;
    if (!answer.ok) {
      patchStatusLine(line, [], ["The status of your harnesses could not be read."], nodes);
      return;
    }
    patchStatusLine(line, statusLineParts(answer.body), statusLineNotes(answer.body), nodes);
    const needs = answer.body?.counts?.needsYou;
    if (typeof needs === "number" && lastNeeds !== null && needs > lastNeeds) {
      const now = Date.now();
      if (now - lastAnnounced >= ANNOUNCE_GAP_MS) {
        lastAnnounced = now;
        const more = needs - lastNeeds;
        announce(`${more} new item${more === 1 ? "" : "s"} need${more === 1 ? "s" : ""} you`);
      }
    }
    if (typeof needs === "number") lastNeeds = needs;
  };
  await draw();
  if (ctx.signal?.aborted || typeof document === "undefined") return;
  let pending = false;
  const again = () => {
    if (pending || ctx.signal?.aborted) return;
    pending = true;
    void draw().finally(() => {
      pending = false;
    });
  };
  const stream = openRunStream({
    path: "/api/v1/events",
    onFrame: (frame) => {
      if (frame.event !== "heartbeat") again();
    },
    onEnd: () => {},
  });
  const onVisible = () => {
    if (document.hidden !== true) again();
  };
  document.addEventListener("visibilitychange", onVisible);
  ctx.signal?.addEventListener("abort", () => {
    stream.close();
    document.removeEventListener("visibilitychange", onVisible);
  });
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

/** How many items a band holds, in words. */
const BAND_WORDS = Object.freeze({
  decide: (n) => `${n} to decide`,
  fix: (n) => `${n} to fix`,
  consider: (n) => `${n} to consider`,
});

/**
 * What needs you, from Home's inbox (`attention.list`). Pure. A read that
 * failed is passed as `null` and is not zero: `failed` is true and no band is
 * counted, so nothing downstream can print "nothing needs you" for a list
 * nobody could read. Each band is counted as the list shows it; a list read
 * only in part says so in `notes`. Each item links to its own card on the
 * Needs-you page. `{ bands, items, notes, failed, empty }`.
 */
export function needsYouModel(list) {
  if (list === null || typeof list !== "object") {
    return { bands: [], items: [], notes: [], failed: true, empty: null };
  }
  const all = (Array.isArray(list.items) ? list.items : []).filter(
    (item) => item !== null && typeof item === "object",
  );
  const names = list.names ?? [];
  const bands = BANDS.map((band) => ({
    id: band.id,
    label: band.label,
    count: all.filter((item) => item.band === band.id).length,
  }));
  const items = all.slice(0, PANEL_ITEMS).map((item) => {
    const harness = typeof item.harness === "string" ? item.harness : undefined;
    return {
      text: textOf(item.title),
      band: String(item.band ?? ""),
      where: harness === undefined ? "" : nameOf(names, harness),
      since: item.since,
      href: hrefFleet("home", "needs-you", { item: itemIdOf(item.ref) }),
    };
  });
  const empty =
    list.empty !== null && typeof list.empty === "object" && typeof list.empty.remedy === "string"
      ? { reason: String(list.empty.reason ?? ""), remedy: list.empty.remedy }
      : null;
  return { bands, items, notes: partialNotes(list), failed: false, empty };
}

/** The muted note under the changes when older ones were left out, or null. Pure. */
export function olderChangesNote(payload) {
  return payload && typeof payload === "object" && payload.truncated === true
    ? "Older changes not shown"
    : null;
}

/** True only when the inbox answered in full and holds nothing. Pure. */
export function nothingNeedsYou(model) {
  return !model.failed && model.notes.length === 0 && model.bands.every((b) => b.count === 0);
}

/** The summary line, each band with something in it, in band order. Pure; null when none. */
export function needsYouSummary(model) {
  const parts = model.bands
    .filter((band) => band.count > 0)
    .map((band) => BAND_WORDS[band.id]?.(band.count) ?? `${band.count} ${band.label}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Home's "Needs you": the inbox's bands counted, and its first items, each linking to its card. */
export async function renderNeedsYouPanel(root, ctx = {}) {
  const answer = await call("attention.list", { query: { limit: "500" } });
  if (ctx.signal?.aborted) return;
  if (!answer.ok && answer.status !== 403) throw new Error(answer.error.message);
  clear(root);
  if (!answer.ok) {
    root.appendChild(emptyFor({ cause: "no-access", detail: answer.error.message }));
    return;
  }
  const model = needsYouModel(answer.body);
  if (nothingNeedsYou(model)) {
    root.appendChild(
      nothing(
        model.empty?.reason === "no-access" ? model.empty.remedy : "Nothing needs you right now.",
      ),
    );
    return;
  }
  const summary = needsYouSummary(model);
  if (summary !== null) root.appendChild(el("p", { class: "muted home-summary", text: summary }));
  for (const note of model.notes) {
    root.appendChild(el("p", { class: "muted home-note", text: note }));
  }
  if (model.items.length > 0) {
    root.appendChild(
      itemList(
        model.items.map((item) =>
          el("li", { class: "home-item" }, [
            el("a", { href: item.href, text: item.text }),
            el("span", { class: "muted", text: item.where }),
            timeEl(item.since),
          ]),
        ),
      ),
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
  const older = olderChangesNote(payload);
  if (items.length === 0) {
    root.appendChild(nothing("No changes in the last day."));
    if (older !== null) root.appendChild(el("p", { class: "muted home-note", text: older }));
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
  if (older !== null) root.appendChild(el("p", { class: "muted home-note", text: older }));
}
