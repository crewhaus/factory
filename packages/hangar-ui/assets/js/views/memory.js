/**
 * Memory tab — the fabric, read-only, rendered from the server's actual
 * view shapes: facts `{files:[{items,…}]}` (status folded server-side from
 * tombstones), wiki `{index, articles: [slug]}`, continuity
 * `{focus, goals, plans:[{file,text}]}`, dream `{specs:[{specName,state}]}`,
 * and watchme `{state, observationsTail, judgmentsTail}`. Each area loads
 * independently so one absent store never hides another ("absence is not
 * an error").
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, jsonPre, mdBlocks, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import { fmtRelativeTime } from "../util.js";

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
  // One entry per memories/<spec>.jsonl file; items carry a folded status.
  const files = Array.isArray(data?.files) ? data.files : [];
  const items = files.flatMap((f) =>
    Array.isArray(f?.items)
      ? f.items.map((i) => ({ ...i, specName: String(f.specName ?? "") }))
      : [],
  );
  if (items.length === 0) {
    return card("Facts", emptyState("No facts yet", "crewhaus remember"));
  }
  const live = items.filter((i) => i.status === "live");
  const folded = items.filter((i) => i.status !== "live");
  const factLi = (f) =>
    el("li", { class: "fact" }, [
      el("div", { text: String(f.text ?? "") }),
      el("div", { class: "fact-meta" }, [
        ...(Array.isArray(f.tags) ? f.tags : []).map((t) =>
          el("span", { class: "chip", text: String(t) }),
        ),
        f.status !== "live"
          ? el("span", { class: "chip chip-warn", text: String(f.status) })
          : null,
      ]),
    ]);
  const children = [el("ul", { class: "fact-list" }, live.map(factLi))];
  if (folded.length > 0) {
    children.push(
      collapsible(
        [
          el("span", {
            class: "muted",
            text: `${folded.length} superseded/expired fact${folded.length === 1 ? "" : "s"} (tombstoned, never deleted)`,
          }),
        ],
        [el("ul", { class: "fact-list folded" }, folded.map(factLi))],
      ),
    );
  }
  if (files.some((f) => f?.truncated === true)) {
    children.push(
      el("p", { class: "muted", text: "Long store — showing the first entries only." }),
    );
  }
  return card("Facts", children, true);
}

function wikiCard(data, ctx) {
  // Articles are slugs (the on-disk authority); titles come from the
  // tolerant index.json cache when it has them.
  const slugs = Array.isArray(data?.articles) ? data.articles.map(String) : [];
  if (slugs.length === 0) {
    return card("Wiki", emptyState("No wiki articles yet", "crewhaus wiki write"));
  }
  const index = data?.index && typeof data.index === "object" ? data.index : {};
  return card(
    "Wiki",
    el(
      "ul",
      { class: "wiki-list" },
      slugs.map((slug) => {
        const meta = index[slug] && typeof index[slug] === "object" ? index[slug] : {};
        return el("li", null, [
          el("a", {
            class: "name-link",
            href: hrefHarness(ctx.id, "memory", "wiki", slug),
            text: typeof meta.title === "string" && meta.title !== "" ? meta.title : slug,
          }),
          ...(Array.isArray(meta.tags) ? meta.tags : []).map((t) =>
            el("span", { class: "chip", text: String(t) }),
          ),
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
  root.appendChild(
    el("article", { class: "card wiki-article" }, [
      el("h2", { text: slug }),
      data.truncated === true
        ? el("p", { class: "muted", text: "Long article — showing the first part only." })
        : null,
      mdBlocks(String(data.body ?? "")),
    ]),
  );
}

function continuityCard(data) {
  const focus = typeof data?.focus === "string" ? data.focus : "";
  const goals = typeof data?.goals === "string" ? data.goals : "";
  const plans = Array.isArray(data?.plans) ? data.plans : [];
  if (focus === "" && goals === "" && plans.length === 0) {
    return card("Continuity", emptyState("No continuity state yet", "crewhaus /focus (or /plan)"));
  }
  const children = [];
  if (focus !== "") {
    children.push(el("h4", { class: "sub-title", text: "Focus" }));
    children.push(el("pre", { class: "prose-pre", text: focus }));
  }
  if (goals !== "") {
    children.push(el("h4", { class: "sub-title", text: "Goals" }));
    children.push(el("pre", { class: "prose-pre", text: goals }));
  }
  for (const plan of plans) {
    children.push(
      collapsible(
        [el("span", { class: "mono", text: String(plan.file ?? "plan") })],
        [el("pre", { class: "prose-pre", text: String(plan.text ?? "") })],
      ),
    );
  }
  return card("Continuity", children);
}

function dreamCard(data) {
  const specs = Array.isArray(data?.specs) ? data.specs : [];
  if (specs.length === 0) {
    return card("Dream", emptyState("No dream state yet", "crewhaus dream run"));
  }
  const children = specs.map((s) => {
    const state = s?.state && typeof s.state === "object" ? s.state : {};
    const lastRunAt = typeof state.lastRunAt === "string" ? state.lastRunAt : null;
    return collapsible(
      [
        el("span", { class: "mono", text: String(s.specName ?? "spec") }),
        el("span", {
          class: "muted",
          text: lastRunAt ? ` last ran ${fmtRelativeTime(lastRunAt, Date.now())}` : "",
        }),
      ],
      [jsonPre(state)],
    );
  });
  return card("Dream", children);
}

function watchmeCard(data) {
  const state = data?.state && typeof data.state === "object" ? data.state : null;
  if (state === null) {
    return card("Watchme", emptyState("Not watching yet", "crewhaus watchme start"));
  }
  const watching = state.watching === true || state.active === true;
  const observations = Array.isArray(data.observationsTail) ? data.observationsTail.length : 0;
  const judgments = Array.isArray(data.judgmentsTail) ? data.judgmentsTail.length : 0;
  return card("Watchme", [
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "state" }),
      el("span", { class: "kv-v" }, [dot(watching ? "ok" : "off", watching ? "watching" : "off")]),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "recent observations" }),
      el("span", { class: "kv-v", text: String(observations) }),
    ]),
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: "recent judgments" }),
      el("span", { class: "kv-v", text: String(judgments) }),
    ]),
  ]);
}
