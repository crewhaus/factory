/**
 * Memory tab — the fabric, read-only: facts (tombstones folded), local wiki
 * (list + safe-markdown reader), continuity focus/plan, dream state, and
 * watchme state. Each area loads independently so one absent store never
 * hides another ("absence is not an error").
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, mdBlocks, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import { fmtRelativeTime, parseTs } from "../util.js";

export async function renderMemory(root, ctx) {
  if (ctx.route.wikiSlug !== undefined) {
    await renderWikiArticle(root, ctx, ctx.route.wikiSlug);
    return;
  }
  clear(root).appendChild(skeleton(8));
  const [facts, wiki, continuity, dream, watchme] = await Promise.allSettled([
    api.memory(ctx.id, "facts"),
    api.memory(ctx.id, "wiki"),
    api.memory(ctx.id, "state"),
    api.memory(ctx.id, "dream"),
    api.memory(ctx.id, "watchme"),
  ]);
  clear(root);
  const grid = el("div", { class: "ov-grid" });
  grid.appendChild(factsCard(value(facts)));
  grid.appendChild(wikiCard(value(wiki), ctx));
  grid.appendChild(continuityCard(value(continuity)));
  grid.appendChild(dreamCard(value(dream)));
  grid.appendChild(watchmeCard(value(watchme)));
  root.appendChild(grid);
}

function value(res) {
  return res.status === "fulfilled" ? res.value : null;
}

function card(title, children, wide = false) {
  return el("section", { class: `card ov-card${wide ? " ov-wide" : ""}` }, [
    el("h3", { class: "card-title", text: title }),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

function factsCard(data) {
  const facts = Array.isArray(data) ? data : Array.isArray(data?.facts) ? data.facts : [];
  if (facts.length === 0) {
    return card("Facts", emptyState("No facts yet", "crewhaus remember"));
  }
  const isTombstoned = (f) =>
    f.tombstone === true || (f.supersededBy !== undefined && f.supersededBy !== null);
  const active = facts.filter((f) => !isTombstoned(f));
  const superseded = facts.filter(isTombstoned);
  const factLi = (f) =>
    el("li", { class: "fact" }, [
      el("div", { text: String(f.text ?? "") }),
      el("div", { class: "fact-meta" }, [
        ...(Array.isArray(f.tags) ? f.tags : []).map((t) =>
          el("span", { class: "chip", text: String(t) }),
        ),
        f.supersededBy
          ? el("span", { class: "chip chip-warn", text: `superseded by ${String(f.supersededBy)}` })
          : null,
      ]),
    ]);
  const children = [el("ul", { class: "fact-list" }, active.map(factLi))];
  if (superseded.length > 0) {
    children.push(
      collapsible(
        [
          el("span", {
            class: "muted",
            text: `${superseded.length} superseded fact${superseded.length === 1 ? "" : "s"} (tombstoned, never deleted)`,
          }),
        ],
        [el("ul", { class: "fact-list folded" }, superseded.map(factLi))],
      ),
    );
  }
  return card("Facts", children, true);
}

function wikiCard(data, ctx) {
  const articles = Array.isArray(data) ? data : Array.isArray(data?.articles) ? data.articles : [];
  if (articles.length === 0) {
    return card("Wiki", emptyState("No wiki articles yet", "crewhaus wiki write"));
  }
  return card(
    "Wiki",
    el(
      "ul",
      { class: "wiki-list" },
      articles.map((a) => {
        const slug = String(a.slug ?? a.id ?? "");
        return el("li", null, [
          el("a", {
            class: "name-link",
            href: hrefHarness(ctx.id, "memory", "wiki", slug),
            text: String(a.title ?? slug),
          }),
          ...(Array.isArray(a.tags) ? a.tags : []).map((t) =>
            el("span", { class: "chip", text: String(t) }),
          ),
          a.status ? el("span", { class: "chip chip-group", text: String(a.status) }) : null,
        ]);
      }),
    ),
  );
}

async function renderWikiArticle(root, ctx, slug) {
  clear(root).appendChild(skeleton(6));
  const data = await api.wikiArticle(ctx.id, slug);
  clear(root);
  root.appendChild(
    el("div", { class: "crumb-line" }, [
      el("a", { href: hrefHarness(ctx.id, "memory"), text: "← memory" }),
      el("span", { class: "mono muted", text: slug }),
    ]),
  );
  if (data === null) {
    root.appendChild(emptyState("Nothing here yet — no article with that slug"));
    return;
  }
  const body = typeof data.markdown === "string" ? data.markdown : String(data.body ?? "");
  root.appendChild(
    el("article", { class: "card wiki-article" }, [
      el("h2", { text: String(data.title ?? slug) }),
      data.updatedAt
        ? el("p", {
            class: "muted",
            text: `updated ${fmtRelativeTime(data.updatedAt, Date.now())}`,
          })
        : null,
      mdBlocks(body),
    ]),
  );
}

function continuityCard(data) {
  const focus = typeof data?.focus === "string" ? data.focus : "";
  const plan = typeof data?.plan === "string" ? data.plan : "";
  if (focus === "" && plan === "") {
    return card("Continuity", emptyState("No continuity state yet", "crewhaus /focus (or /plan)"));
  }
  const children = [];
  if (focus !== "") {
    children.push(el("h4", { class: "sub-title", text: "Focus" }));
    children.push(el("pre", { class: "prose-pre", text: focus }));
  }
  if (plan !== "") {
    children.push(el("h4", { class: "sub-title", text: "Plan" }));
    children.push(el("pre", { class: "prose-pre", text: plan }));
  }
  return card("Continuity", children);
}

function dreamCard(data) {
  if (data === null || typeof data !== "object") {
    return card("Dream", emptyState("No dream state yet", "crewhaus dream run"));
  }
  const nextDue = typeof data.nextDueAt === "string" ? data.nextDueAt : null;
  const overdue =
    data.overdue === true ||
    (nextDue !== null && (parseTs(nextDue) ?? Number.POSITIVE_INFINITY) < Date.now());
  return card("Dream", [
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "last outcome" }),
      el("span", { class: "kv-v", text: String(data.lastOutcome ?? "—") }),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "next due" }),
      el("span", { class: "kv-v" }, [
        el("span", { text: nextDue ? fmtRelativeTime(nextDue, Date.now()) : "—" }),
        overdue ? el("span", { class: "chip chip-warn", text: "overdue" }) : null,
      ]),
    ]),
  ]);
}

function watchmeCard(data) {
  if (data === null || typeof data !== "object") {
    return card("Watchme", emptyState("Not watching yet", "crewhaus watchme start"));
  }
  const watching = data.watching === true || data.active === true;
  return card("Watchme", [
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "state" }),
      el("span", { class: "kv-v" }, [dot(watching ? "ok" : "off", watching ? "watching" : "off")]),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "observations" }),
      el("span", {
        class: "kv-v",
        text: String(data.observationCount ?? data.observations ?? "—"),
      }),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "last report" }),
      el("span", {
        class: "kv-v",
        text: data.lastReportAt ? fmtRelativeTime(data.lastReportAt, Date.now()) : "—",
      }),
    ]),
  ]);
}
