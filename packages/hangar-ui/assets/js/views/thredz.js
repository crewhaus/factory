/**
 * Thredz — the explorer: wiki, records and schemas, goals and tasks, views,
 * dashboards and cards, listeners, webhooks, connectors, activity, traverse,
 * and API-key administration. Plus the harness-less global explorer.
 *
 * EVERY REQUEST IS PROXIED. The browser never holds a Thredz key: it calls
 * `/api/h/:id/thredz/*`, and the server reads the harness's key at request
 * time. That is why this view has no key field and no "connect" button, and
 * why the key-admin panel accepts a value but can never display one.
 *
 * Things the screen presents faithfully rather than smoothing over:
 *   - deletes are SOFT, with restore. There is no hard-delete affordance.
 *   - visibility is always set explicitly, defaulting to private.
 *   - a wiki write carries `expectedVersion` and gets the same
 *     re-read-retry flow as the local wiki.
 *   - every article arrives MASKED, so the editor writes back only what the
 *     operator typed: it never echoes a served value, and it goes read-only
 *     when the body carries the mask mark rather than persisting `***` over
 *     what it hid.
 *   - card-grammar validation messages are shown VERBATIM (KPI cards need
 *     both `display.aggregation` and `display.aggregationField`; record
 *     filters take a `tags` array, task/goal filters a singular `tag`).
 *   - free-plan quotas (three goals, listener limits) are facts, not errors.
 *   - the local store stays authoritative; a degraded mirror is a badge.
 *
 * EVERY PANEL RENDERS ITS OWN OUTAGE. The proxy answers 200 with
 * `{ ok, note, upstream }` whatever the workspace said, so an unreachable
 * workspace, a lapsed subscription and a plan cap each paint as a labelled
 * state carrying the upstream status — never a blank panel, never a spinner
 * that never ends, and never a zero that is really "we could not ask".
 */

import { api } from "../api.js";
import { asOf, clear, dot, el, emptyState, jsonPre, mdBlocks, skeleton, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { clampText, fmtRelativeTime } from "../util.js";

/** The sub-tabs of the Thredz tab, in display order. */
const PANELS = [
  ["wiki", "Wiki"],
  ["records", "Records"],
  ["plan", "Goals & tasks"],
  ["boards", "Views & dashboards"],
  ["ops", "Automations"],
  ["graph", "Graph"],
  ["keys", "Keys"],
];

// ---------------------------------------------------------------------------
// shared rendering helpers
// ---------------------------------------------------------------------------

function card(title, children, titleExtra) {
  return el("section", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: title }), titleExtra ?? null]),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

function str(value, fallback = "") {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function list(payload, key) {
  return payload && Array.isArray(payload[key]) ? payload[key] : [];
}

/** Row id, whatever the API called it. */
function idOf(row) {
  if (!row || typeof row !== "object") return "";
  return str(row._id, str(row.id, ""));
}

// ---------------------------------------------------------------------------
// write safety (pure — unit-tested in hangar-ui/src/thredz-views.test.ts)
// ---------------------------------------------------------------------------

/** What the server's value-shape masker leaves behind. Text carrying it is
 *  not safe to write back — the mask would replace what it hid. */
export const MASK_MARK = "***";

/**
 * Whether a served article body may be written back at all.
 *
 * Every Thredz article is served through the server's `maskText`, so a body
 * carrying the mask mark is a VIEW rather than the article: saving it would
 * persist `***` over a real span — upstream, in a workspace other people
 * read. The local wiki editor holds exactly this line (`memory-fabric.js`);
 * the hosted one is not allowed to be looser.
 */
export function maskedEditGuard(bodyText) {
  if (typeof bodyText !== "string" || !bodyText.includes(MASK_MARK)) {
    return { readOnly: false, reason: null };
  }
  return {
    readOnly: true,
    reason:
      "this body contains a masked credential-shaped span; saving from the console would persist the mask over what it hid — edit this article in the Thredz workspace",
  };
}

/**
 * The exact body a wiki EDIT posts.
 *
 * A field this form does not edit is ABSENT rather than echoed. The server
 * leaves an omitted field alone; an echoed one would be the MASKED value
 * (the title is masked too), and a defaulted one would rename the article
 * and force-publish a draft. `expectedVersion` rides along whenever the read
 * gave us one — without it the server refuses the update outright, which is
 * the same answer the local wiki gives.
 */
export function wikiEditBody(bodyText, version, visibilityChoice, editMessage) {
  const message = typeof editMessage === "string" ? editMessage.trim() : "";
  return {
    body: bodyText,
    ...(message === "" ? {} : { editMessage: message }),
    ...(typeof version === "number" ? { expectedVersion: version } : {}),
    ...(visibilityChoice === "private" || visibilityChoice === "shared"
      ? { visibility: visibilityChoice }
      : {}),
  };
}

/** The one place a proxy answer becomes a traffic light + a sentence. Colour
 *  is never alone: every state carries its own words. */
function proxyState(payload) {
  if (!payload) return { state: "unknown", label: "no answer from the manager" };
  if (payload.unconfigured === true) return { state: "off", label: "no key in this harness" };
  if (payload.ok === true) return { state: "ok", label: "workspace answered" };
  const upstream = payload.upstream;
  if (!upstream) return { state: "warn", label: str(payload.note, "refused") };
  const cls = str(upstream.failureClass, "upstream-error");
  const status = typeof upstream.status === "number" ? upstream.status : 0;
  const where = status === 0 ? "no answer" : `HTTP ${status}`;
  const bad = cls === "unreachable" || cls === "auth" || cls === "billing";
  return { state: bad ? "bad" : "warn", label: `${cls} (${where})` };
}

/**
 * The banner a panel puts above its data when the workspace did not answer
 * cleanly. The upstream MESSAGE is printed verbatim: on a card or schema
 * refusal it names the valid keys, and paraphrasing it would turn a fixable
 * mistake into a mystery.
 */
function upstreamBanner(payload) {
  if (!payload || payload.ok === true) return null;
  const { state, label } = proxyState(payload);
  const upstream = payload.upstream ?? null;
  const details = upstream && Array.isArray(upstream.details) ? upstream.details : [];
  return el("div", { class: "error-card" }, [
    el("div", { class: "refusal-head" }, [dot(state, label)]),
    payload.note ? el("p", { class: "prose-pre", text: String(payload.note) }) : null,
    details.length > 0
      ? el(
          "ul",
          { class: "refusal-list" },
          details.map((d) => el("li", { class: "refusal-item", text: String(d) })),
        )
      : null,
    upstream?.remediation ? el("p", { class: "muted", text: String(upstream.remediation) }) : null,
  ]);
}

/** "as of …" for a proxied figure — nothing here is live, it is a fetch. */
function fetchedChip(payload) {
  return payload && typeof payload.fetchedAt === "string" ? asOf(payload.fetchedAt) : null;
}

function table(headers, rows) {
  return el("div", { class: "table-scroll" }, [
    el("table", { class: "fleet" }, [
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          headers.map((h) => el("th", { text: h })),
        ),
      ),
      el("tbody", null, rows),
    ]),
  ]);
}

function chips(values) {
  return (Array.isArray(values) ? values : []).map((v) =>
    el("span", { class: "chip", text: String(v) }),
  );
}

function when(iso) {
  return typeof iso === "string" && iso !== "" ? fmtRelativeTime(iso, Date.now()) : "—";
}

function field(label, control) {
  return el("label", { class: "field" }, [
    el("span", { class: "mini-label", text: label }),
    control,
  ]);
}

function input(attrs) {
  return el("input", { class: "input", type: "text", ...attrs });
}

function select(options, value) {
  return el(
    "select",
    { class: "input" },
    options.map((opt) => el("option", { value: opt, text: opt, selected: opt === value || null })),
  );
}

/** Run a proxied call; a MANAGER-side failure toasts rather than blanking the
 *  screen, and the caller gets `null`. (A WORKSPACE refusal is not a failure
 *  here — it arrives as a 200 body with `ok:false`, which the panels render.) */
async function callProxy(fn) {
  try {
    const res = await fn();
    return res?.body ? res.body : null;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** A write: report what happened either way. `ok:false` carries the
 *  workspace's own words, so the toast quotes them. */
async function write(fn, okMessage) {
  const body = await callProxy(fn);
  if (body === null) return null;
  if (body.ok === true) toast(okMessage, "info");
  else toast(str(body.note, "the workspace refused that"));
  return body;
}

// ---------------------------------------------------------------------------
// the per-harness tab
// ---------------------------------------------------------------------------

/** The per-harness Thredz tab. */
export async function renderThredz(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const status = await callProxy(() => api.thredzStatus({ id: ctx.id }));
  clear(root);
  root.appendChild(statusCard(status, ctx));
  if (!status || status.keyPresent !== true) {
    root.appendChild(wiringCard(status));
    return;
  }
  const host = el("div", { class: "tab-section" });
  const state = { panel: "wiki" };
  const nav = el("nav", { class: "tabs", "aria-label": "thredz panels" });
  const paint = () => {
    clear(nav);
    for (const [key, label] of PANELS) {
      nav.appendChild(
        el("button", {
          class: `tab${state.panel === key ? " active" : ""}`,
          type: "button",
          "aria-current": state.panel === key ? "page" : null,
          text: label,
          onClick: () => {
            state.panel = key;
            paint();
          },
        }),
      );
    }
    clear(host).appendChild(skeleton(4));
    void renderPanel(host, ctx, state.panel);
  };
  root.appendChild(nav);
  root.appendChild(host);
  paint();
}

function renderPanel(host, ctx, panel) {
  if (panel === "wiki") return renderWikiPanel(host, ctx);
  if (panel === "records") return renderRecordsPanel(host, ctx);
  if (panel === "plan") return renderPlanPanel(host, ctx);
  if (panel === "boards") return renderBoardsPanel(host, ctx);
  if (panel === "ops") return renderOpsPanel(host, ctx);
  if (panel === "graph") return renderGraphPanel(host, ctx);
  return renderKeysPanel(host, ctx);
}

/**
 * The status card: which backend this harness's wiki actually uses, whether a
 * key resolved and WHERE from (a provenance label — never a value), the tier
 * that key carries, and the plan's listener quota.
 */
function statusCard(status, ctx) {
  if (!status) {
    return card("Thredz", emptyState("The manager did not answer for this harness", null));
  }
  const spec = status.spec && typeof status.spec === "object" ? status.spec : {};
  const { state, label } = proxyState(status);
  const backend = str(status.backend, "local");
  const rows = [
    ["Wiki backend", backend === "thredz" ? "Thredz (hosted)" : "local files"],
    ["Key", status.keyPresent === true ? `resolved from ${str(status.keySource, "?")}` : "not set"],
    ["Variable", str(spec.envName, "—")],
    ["Workspace", str(status.workspace, "—")],
    ["New writes", `visibility: ${str(status.defaultVisibility, "private")}`],
    ["Permission tier", str(status.tier, "unknown")],
    ["Goal mirror", spec.goalsMirror === true ? "on (local goals stay authoritative)" : "off"],
    ["Messaging tools", spec.messaging === true ? "enabled" : "off"],
  ];
  const quota =
    status.listenerQuota && typeof status.listenerQuota === "object" ? status.listenerQuota : null;
  if (quota) rows.push(["Listener quota", `${quota.used ?? "?"} of ${quota.limit ?? "?"} used`]);
  const stats = status.wikiStats && typeof status.wikiStats === "object" ? status.wikiStats : null;
  return card(
    "Thredz",
    [
      el("div", { class: "safety-strip" }, [
        dot(state, label),
        el("span", { class: "chip", text: `backend: ${backend}` }),
        status.localWikiDeclared === true
          ? el("span", { class: "chip", text: "local wiki store present — still authoritative" })
          : null,
      ]),
      upstreamBanner(status),
      el(
        "dl",
        { class: "kv" },
        rows.flatMap(([k, v]) => [
          el("dt", { class: "kv-k", text: k }),
          el("dd", { text: String(v) }),
        ]),
      ),
      stats
        ? el("details", { class: "fold" }, [
            el("summary", { class: "fold-summary" }, [
              el("span", { class: "muted", text: "workspace wiki stats" }),
            ]),
            el("div", { class: "fold-body" }, [jsonPre(stats)]),
          ])
        : null,
      el("p", { class: "muted" }, [
        "The key is read server-side per request and never reaches this browser. Local memory lives under ",
        el("a", { class: "name-link", href: hrefHarness(ctx.id, "memory"), text: "Memory" }),
        ".",
      ]),
    ],
    fetchedChip(status),
  );
}

/** What to do when there is no key — an empty state that names the fix. */
function wiringCard(status) {
  const spec = status?.spec && typeof status.spec === "object" ? status.spec : {};
  const note = status ? str(status.note, "this harness has no Thredz workspace") : "";
  const body = [el("p", { class: "prose-pre", text: note })];
  if (spec.declared === true && spec.inlineKey !== true) {
    body.push(
      el("p", { class: "muted" }, [
        "Set ",
        el("code", { text: str(spec.envName, "THREDZ_API_KEY") }),
        " in this harness's own .env — values go in, only presence comes back.",
      ]),
    );
  } else if (spec.declared !== true) {
    body.push(
      el("p", { class: "muted" }, [
        "Add a ",
        el("code", { text: "thredz:" }),
        " block to the spec to point this harness's wiki at a hosted workspace. Until then the local store is the whole story.",
      ]),
    );
  }
  return card("Not wired to a workspace", body);
}

// ---------------------------------------------------------------------------
// wiki
// ---------------------------------------------------------------------------

async function renderWikiPanel(host, ctx, state = { q: "", semantic: false, slug: null }) {
  if (state.slug !== null) return renderArticle(host, ctx, state);
  const query =
    state.q === "" ? "" : `?q=${encodeURIComponent(state.q)}${state.semantic ? "&semantic=1" : ""}`;
  const payload = await callProxy(() => api.thredzWiki({ id: ctx.id }, undefined, query));
  clear(host);
  const search = input({ value: state.q, placeholder: "search the workspace wiki…" });
  const semantic = el("input", { type: "checkbox", checked: state.semantic || null });
  const form = el("form", { class: "filter-bar" }, [
    search,
    el("label", { class: "check" }, [semantic, el("span", { text: "semantic" })]),
    el("button", { class: "btn btn-primary", type: "submit", text: "Search" }),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void renderWikiPanel(host, ctx, {
      q: search.value.trim(),
      semantic: semantic.checked,
      slug: null,
    });
  });
  const rows = list(payload, "articles").map((a) =>
    el("tr", null, [
      el(
        "td",
        null,
        el("button", {
          class: "btn btn-ghost name-link",
          type: "button",
          text: str(a.title, str(a.slug, "(untitled)")),
          onClick: () => void renderWikiPanel(host, ctx, { ...state, slug: str(a.slug, idOf(a)) }),
        }),
      ),
      el("td", { class: "mono", text: str(a.slug, "—") }),
      el("td", null, chips(a.tags)),
      el("td", { class: "mono", text: String(a.version ?? "—") }),
      el("td", { text: str(a.visibility, "—") }),
      el("td", { text: when(a.updatedAt) }),
    ]),
  );
  host.appendChild(
    card(
      payload && payload.mode === "semantic" ? "Wiki — semantic search" : "Wiki",
      [
        form,
        upstreamBanner(payload),
        rows.length === 0
          ? emptyState(
              payload && payload.ok === true
                ? str(payload.note, "No articles in this workspace")
                : "Nothing to show — the workspace did not answer",
              null,
            )
          : table(["Title", "Slug", "Tags", "Version", "Visibility", "Updated"], rows),
      ],
      fetchedChip(payload),
    ),
  );
  host.appendChild(newArticleCard(ctx, (slug) => renderWikiPanel(host, ctx, { ...state, slug })));
}

/** Create an article. The only place in this console that mints a hosted
 *  wiki page, and it always sends an explicit visibility — private unless
 *  the operator chooses otherwise, whatever the API would have defaulted to. */
function newArticleCard(ctx, open) {
  const slug = input({ placeholder: "slug (how-to-deploy)" });
  const title = input({ placeholder: "title" });
  const body = el("textarea", { class: "input", rows: 6, spellcheck: "false" });
  const visibility = select(["private", "shared"], "private");
  const form = el("form", { class: "row-editor" }, [
    field("Slug", slug),
    field("Title", title),
    field("Body", body),
    field("Visibility", visibility),
    el("div", { class: "editor-actions" }, [
      el("button", { class: "btn btn-primary", type: "submit", text: "Create article" }),
    ]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = slug.value.trim();
    if (name === "") {
      toast("a new article needs a slug");
      return;
    }
    const res = await write(
      () =>
        api.thredzWikiWrite(
          { id: ctx.id, slug: name },
          {
            body: body.value,
            title: title.value.trim() === "" ? name : title.value.trim(),
            visibility: visibility.value,
          },
        ),
      "Article created",
    );
    if (res && res.ok === true) void open(name);
  });
  return card("New article", [
    el("p", {
      class: "muted",
      text: "New articles are private unless you say otherwise — the hosted API would default them to shared, and this console does not inherit that.",
    }),
    form,
  ]);
}

async function renderArticle(host, ctx, state) {
  clear(host).appendChild(skeleton(6));
  const slug = state.slug;
  const [payload, versions] = await Promise.all([
    callProxy(() => api.thredzWikiArticle({ id: ctx.id, slug })),
    callProxy(() => api.thredzWikiVersions({ id: ctx.id, slug })),
  ]);
  clear(host);
  const back = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "← all articles",
    onClick: () => void renderWikiPanel(host, ctx, { ...state, slug: null }),
  });
  const article = payload?.article && typeof payload.article === "object" ? payload.article : null;
  if (!article) {
    host.appendChild(
      card(slug, [back, upstreamBanner(payload), emptyState("No such article", null)]),
    );
    return;
  }
  const version = typeof payload.version === "number" ? payload.version : null;
  host.appendChild(
    card(str(article.title, slug), [
      el("div", { class: "safety-strip" }, [
        back,
        el("span", { class: "chip", text: `v${version ?? "?"}` }),
        el("span", { class: "chip", text: `visibility: ${str(payload.visibility, "?")}` }),
        payload.deleted === true
          ? dot("warn", "soft-deleted upstream — restorable, never destroyed")
          : null,
        fetchedChip(payload),
      ]),
      upstreamBanner(payload),
      mdBlocks(str(article.body, "")),
    ]),
  );
  host.appendChild(editorCard(ctx, slug, article, version, () => renderArticle(host, ctx, state)));
  host.appendChild(
    card("Backlinks & comments", [
      el("div", { class: "twin" }, [
        el("div", null, [
          el("h4", { class: "sub-title", text: "Backlinks" }),
          list(payload, "backlinks").length === 0
            ? emptyState("Nothing links here yet", null)
            : el(
                "ul",
                { class: "wiki-list" },
                list(payload, "backlinks").map((b) =>
                  el("li", { text: str(b.slug, str(b.title, "—")) }),
                ),
              ),
        ]),
        el("div", null, [
          el("h4", { class: "sub-title", text: "Comments" }),
          payload.commentsError
            ? el("p", { class: "muted", text: String(payload.commentsError) })
            : null,
          list(payload, "comments").length === 0
            ? emptyState("No comments", null)
            : el(
                "ul",
                { class: "fact-list" },
                list(payload, "comments").map((c) =>
                  el("li", { class: "fact" }, [
                    el("div", { text: str(c.body, str(c.text, "")) }),
                    el("div", { class: "fact-meta", text: when(c.createdAt) }),
                  ]),
                ),
              ),
        ]),
      ]),
    ]),
  );
  host.appendChild(versionsCard(ctx, slug, versions, () => renderArticle(host, ctx, state)));
}

/**
 * The editor. Every write carries `expectedVersion`; a stale answer is a
 * FIRST-CLASS state — the panel says which version moved, offers a re-read,
 * and keeps the operator's draft so nothing typed is lost.
 *
 * Two things this form deliberately does NOT do, both because the text it
 * was seeded with is a masked VIEW of the article rather than the article:
 *   - it never echoes the title back (the served one may carry `***`, and an
 *     echoed default renames the article upstream);
 *   - it goes read-only when the served body carries the mask mark, the same
 *     guard the local wiki editor uses (`memory-fabric.js`).
 */
function editorCard(ctx, slug, article, version, reload) {
  const body = el("textarea", { class: "input", rows: 12, spellcheck: "false" });
  body.value = str(article.body, "");
  const visibility = select(["(unchanged)", "private", "shared"], "(unchanged)");
  const message = input({ placeholder: "edit message (optional)" });
  const conflict = el("div", { class: "gated-why" });
  const save = el("button", { class: "btn btn-primary", type: "submit", text: "Save" });
  const guard = el("div", null, []);
  const form = el("form", { class: "row-editor" }, [
    field("Body", body),
    field("Visibility", visibility),
    field("Edit message", message),
    guard,
    conflict,
    el("div", { class: "editor-actions" }, [save]),
  ]);
  const masked = maskedEditGuard(body.value);
  if (masked.readOnly) {
    save.disabled = true;
    body.readOnly = true;
    guard.appendChild(
      el("div", { class: "gated" }, [
        dot("warn", "read-only here"),
        el("span", { class: "muted gated-why", text: masked.reason }),
      ]),
    );
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clear(conflict);
    const stillMasked = maskedEditGuard(body.value);
    if (stillMasked.readOnly) {
      toast(stillMasked.reason);
      return;
    }
    const edit = wikiEditBody(body.value, version, visibility.value, message.value);
    const res = await write(() => api.thredzWikiWrite({ id: ctx.id, slug }, edit), "Article saved");
    if (res && res.stale === true) {
      conflict.appendChild(
        dot("warn", str(res.note, `this article moved to v${res.currentVersion ?? "?"}`)),
      );
      conflict.appendChild(
        el("p", {
          class: "muted",
          text: "Nothing was written. Re-read it, then re-apply your edit — the same flow the local wiki uses.",
        }),
      );
      conflict.appendChild(
        el("button", {
          class: "btn",
          type: "button",
          text: "Re-read the current version",
          onClick: () => void reload(),
        }),
      );
      return;
    }
    if (res && res.ok === true) void reload();
  });
  return card("Edit", [
    el("p", {
      class: "muted",
      text: "Writes carry the version you read; a create is private unless you say otherwise. The title is edited in the workspace, never echoed from here.",
    }),
    form,
  ]);
}

function versionsCard(ctx, slug, payload, reload) {
  const rows = list(payload, "versions").map((v) => {
    const number = typeof v.version === "number" ? v.version : null;
    return el("tr", null, [
      el("td", { class: "mono", text: String(number ?? "—") }),
      el("td", { text: str(v.editMessage, "—") }),
      el("td", { text: when(v.createdAt ?? v.updatedAt) }),
      el(
        "td",
        { class: "cell-actions" },
        number === null
          ? null
          : el("button", {
              class: "btn btn-ghost",
              type: "button",
              text: "Roll back to this",
              onClick: async () => {
                const res = await write(
                  () =>
                    api.thredzWikiRollback(
                      { id: ctx.id, slug },
                      { version: number, confirm: true },
                    ),
                  `Rolled back to v${number} (as a new version)`,
                );
                if (res && res.ok === true) void reload();
              },
            }),
      ),
    ]);
  });
  return card(
    "Versions",
    [
      upstreamBanner(payload),
      el("p", {
        class: "muted",
        text: "A rollback creates a NEW version on top; the versions in between are never removed.",
      }),
      rows.length === 0
        ? emptyState("No recorded versions yet", null)
        : table(["Version", "Message", "When", ""], rows),
    ],
    fetchedChip(payload),
  );
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

async function renderRecordsPanel(host, ctx, state = { type: "", status: "", tag: "" }) {
  const params = new URLSearchParams();
  for (const key of ["type", "status", "tag"]) {
    if (state[key] !== "") params.set(key, state[key]);
  }
  const query = params.toString() === "" ? "" : `?${params.toString()}`;
  const [payload, schemas] = await Promise.all([
    callProxy(() => api.thredzRecords({ id: ctx.id }, undefined, query)),
    callProxy(() => api.thredzSchemas({ id: ctx.id })),
  ]);
  clear(host);
  const fields = {
    type: input({ value: state.type, placeholder: "type" }),
    status: input({ value: state.status, placeholder: "status" }),
    tag: input({ value: state.tag, placeholder: "tag" }),
  };
  const filters = el("form", { class: "filter-bar" }, [
    fields.type,
    fields.status,
    fields.tag,
    el("button", { class: "btn btn-primary", type: "submit", text: "Filter" }),
  ]);
  filters.addEventListener("submit", (e) => {
    e.preventDefault();
    void renderRecordsPanel(host, ctx, {
      type: fields.type.value.trim(),
      status: fields.status.value.trim(),
      tag: fields.tag.value.trim(),
    });
  });
  const reload = () => renderRecordsPanel(host, ctx, state);
  const rows = list(payload, "records").map((r) => {
    const recordId = idOf(r);
    const deleted = r.status === "deleted";
    return el("tr", null, [
      el("td", { text: str(r.title, recordId) }),
      el("td", { class: "mono", text: str(r.type, "—") }),
      el("td", null, [
        el("span", { text: str(r.status, "—") }),
        deleted ? dot("warn", "soft-deleted") : null,
      ]),
      el("td", null, chips(r.tags)),
      el("td", { text: when(r.updatedAt) }),
      el(
        "td",
        { class: "cell-actions" },
        deleted
          ? el("button", {
              class: "btn btn-ghost",
              type: "button",
              text: "Restore",
              onClick: async (e) => {
                // A restore is a one-shot: the second click has no stashed
                // status to put back, so the button leaves the flight rather
                // than firing again, and the toast quotes what the server
                // actually did instead of asserting a restore.
                const button = e.currentTarget;
                if (button) button.disabled = true;
                const res = await callProxy(() =>
                  api.thredzRecordRestore({ id: ctx.id, recordId }, {}),
                );
                if (res === null) {
                  if (button) button.disabled = false;
                  return;
                }
                if (res.restored === true) toast("Record restored", "info");
                else toast(str(res.note, "the workspace refused that"));
                if (res.ok === true) void reload();
                else if (button) button.disabled = false;
              },
            })
          : el("button", {
              class: "btn btn-ghost",
              type: "button",
              text: "Soft-delete",
              onClick: async () => {
                const label = str(r.title, recordId);
                if (!window.confirm(`Soft-delete "${label}"? It stays restorable.`)) return;
                const res = await write(
                  () => api.thredzRecordDelete({ id: ctx.id, recordId }),
                  "Soft-deleted — restore is one click away",
                );
                if (res && res.ok === true) void reload();
              },
            }),
      ),
    ]);
  });
  host.appendChild(
    card(
      "Records",
      [
        filters,
        upstreamBanner(payload),
        payload?.tagsNote ? el("p", { class: "muted", text: String(payload.tagsNote) }) : null,
        el("p", {
          class: "muted",
          text: "Delete is SOFT: the record is parked and its previous status stashed, so restore puts it back exactly.",
        }),
        rows.length === 0
          ? emptyState(
              payload && payload.ok === true
                ? str(payload.note, "No records")
                : "The workspace did not answer",
              null,
            )
          : table(["Title", "Type", "Status", "Tags", "Updated", ""], rows),
      ],
      fetchedChip(payload),
    ),
  );
  host.appendChild(recordCreateCard(ctx, schemas, reload));
  host.appendChild(schemasCard(schemas));
}

function recordCreateCard(ctx, schemas, reload) {
  const types = list(schemas, "schemas")
    .map((s) => str(s.type, str(s.name, "")))
    .filter((t) => t !== "");
  const type = types.length > 0 ? select(types, types[0]) : input({ placeholder: "record type" });
  const title = input({ placeholder: "title" });
  const graphId = input({ placeholder: "graph id" });
  const custom = el("textarea", { class: "input", rows: 4, spellcheck: "false" });
  custom.value = "{}";
  const form = el("form", { class: "row-editor" }, [
    field("Type", type),
    field("Title", title),
    field("Graph", graphId),
    field("Custom fields (JSON)", custom),
    el("div", { class: "editor-actions" }, [
      el("button", { class: "btn btn-primary", type: "submit", text: "Create record" }),
    ]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let parsed = {};
    try {
      parsed = JSON.parse(custom.value === "" ? "{}" : custom.value);
    } catch {
      toast("custom fields must be JSON");
      return;
    }
    const res = await write(
      () =>
        api.thredzRecordCreate(
          { id: ctx.id },
          { type: type.value, title: title.value, graphId: graphId.value, fields: parsed },
        ),
      "Record created",
    );
    if (res && res.ok === true) void reload();
  });
  return card("New record", [
    el("p", {
      class: "muted",
      text: "Schema validation happens in the workspace; its message is shown here word for word.",
    }),
    form,
  ]);
}

function schemasCard(payload) {
  const schemas = list(payload, "schemas");
  return card(
    "Schemas",
    [
      upstreamBanner(payload),
      schemas.length === 0
        ? emptyState(
            payload && payload.ok === true
              ? "This workspace defines no record schemas"
              : "Unavailable",
            null,
          )
        : el(
            "ul",
            { class: "fact-list" },
            schemas.map((s) =>
              el("li", { class: "fact" }, [
                el("div", { text: str(s.type, str(s.name, "—")) }),
                el(
                  "div",
                  { class: "fact-meta" },
                  chips(Object.keys(s.fields ?? s.properties ?? {})),
                ),
              ]),
            ),
          ),
    ],
    fetchedChip(payload),
  );
}

// ---------------------------------------------------------------------------
// goals + tasks
// ---------------------------------------------------------------------------

async function renderPlanPanel(host, ctx) {
  const [goals, tasks] = await Promise.all([
    callProxy(() => api.thredzGoals({ id: ctx.id })),
    callProxy(() => api.thredzTasks({ id: ctx.id })),
  ]);
  clear(host);
  const goalRows = list(goals, "goals").map((g) =>
    el("tr", null, [
      el("td", { text: str(g.title, idOf(g)) }),
      el("td", { class: "mono", text: `${g.currentValue ?? "—"} / ${g.targetValue ?? "—"}` }),
      el("td", { text: str(g.health, "—") }),
      el("td", null, chips(g.tags)),
      el("td", { text: when(g.deadline) }),
    ]),
  );
  host.appendChild(
    card(
      "Goals",
      [
        upstreamBanner(goals),
        goals && goals.mirrored === true
          ? el("p", {
              class: "muted",
              text: "This harness mirrors its goals here; the local continuity store stays authoritative.",
            })
          : null,
        el("p", {
          class: "muted",
          text: "Goal filters take a singular `tag` — the array form is card grammar.",
        }),
        goalRows.length === 0
          ? emptyState(
              goals && goals.ok === true
                ? str(goals.note, "No goals")
                : "The workspace did not answer",
              null,
            )
          : table(["Goal", "Progress", "Health", "Tags", "Deadline"], goalRows),
      ],
      fetchedChip(goals),
    ),
  );
  const reload = () => renderPlanPanel(host, ctx);
  const taskRows = list(tasks, "tasks").map((t) => {
    const taskId = idOf(t);
    const gap = Array.isArray(t.tags) && t.tags.includes("knowledge-gap");
    const done = t.status === "completed" || Boolean(t.completedAt);
    return el("tr", null, [
      el("td", null, [
        el("span", { text: str(t.title, taskId) }),
        gap ? el("span", { class: "chip chip-warn", text: "study queue" }) : null,
      ]),
      el("td", { text: str(t.status, "—") }),
      el("td", { text: str(t.priority, "—") }),
      el("td", null, chips(t.tags)),
      el("td", { text: when(t.deadline) }),
      el(
        "td",
        { class: "cell-actions" },
        done
          ? el("span", { class: "muted", text: "done" })
          : el("button", {
              class: "btn btn-ghost",
              type: "button",
              text: "Complete",
              onClick: async () => {
                const res = await write(
                  () => api.thredzTaskUpdate({ id: ctx.id, taskId }, { status: "done" }),
                  "Task completed",
                );
                if (res && res.ok === true) void reload();
              },
            }),
      ),
    ]);
  });
  const studyQueue = tasks && typeof tasks.studyQueue === "number" ? tasks.studyQueue : 0;
  host.appendChild(
    card(
      "Tasks",
      [
        upstreamBanner(tasks),
        el("p", {
          class: "muted",
          text: `${studyQueue} tagged knowledge-gap — the learning loop's study queue.`,
        }),
        taskRows.length === 0
          ? emptyState(
              tasks && tasks.ok === true
                ? str(tasks.note, "No tasks")
                : "The workspace did not answer",
              null,
            )
          : table(["Task", "Status", "Priority", "Tags", "Deadline", ""], taskRows),
      ],
      fetchedChip(tasks),
    ),
  );
}

// ---------------------------------------------------------------------------
// views + dashboards
// ---------------------------------------------------------------------------

async function renderBoardsPanel(host, ctx, state = { dashboardId: null }) {
  if (state.dashboardId !== null) return renderDashboard(host, ctx, state);
  const [views, dashboards] = await Promise.all([
    callProxy(() => api.thredzViews({ id: ctx.id })),
    callProxy(() => api.thredzDashboards({ id: ctx.id })),
  ]);
  clear(host);
  const results = el("div", { class: "tab-section" });
  const viewRows = list(views, "views").map((v) => {
    const viewId = idOf(v);
    return el("tr", null, [
      el("td", { text: str(v.name, viewId) }),
      el("td", { class: "mono", text: str(v.entityType, "—") }),
      el("td", { text: when(v.updatedAt) }),
      el(
        "td",
        { class: "cell-actions" },
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: "Run",
          onClick: async () => {
            clear(results).appendChild(skeleton(3));
            const body = await callProxy(() =>
              api.thredzViewExecute({ id: ctx.id, viewId }, { params: {} }),
            );
            clear(results).appendChild(viewResultsCard(body));
          },
        }),
      ),
    ]);
  });
  host.appendChild(
    card(
      "Saved views",
      [
        upstreamBanner(views),
        viewRows.length === 0
          ? emptyState(
              views && views.ok === true
                ? str(views.note, "No saved views")
                : "The workspace did not answer",
              null,
            )
          : table(["View", "Entity", "Updated", ""], viewRows),
        filterKeysFold(views),
      ],
      fetchedChip(views),
    ),
  );
  host.appendChild(results);
  const boardRows = list(dashboards, "dashboards").map((d) => {
    const dashboardId = idOf(d);
    return el("tr", null, [
      el(
        "td",
        null,
        el("button", {
          class: "btn btn-ghost name-link",
          type: "button",
          text: str(d.name, dashboardId),
          onClick: () => void renderBoardsPanel(host, ctx, { dashboardId }),
        }),
      ),
      el("td", { class: "mono", text: String(list(d, "cards").length) }),
      el("td", { text: when(d.updatedAt) }),
    ]);
  });
  host.appendChild(
    card(
      "Dashboards",
      [
        upstreamBanner(dashboards),
        boardRows.length === 0
          ? emptyState(
              dashboards && dashboards.ok === true
                ? str(dashboards.note, "No dashboards")
                : "The workspace did not answer",
              null,
            )
          : table(["Dashboard", "Cards", "Updated"], boardRows),
        grammarFold(dashboards),
      ],
      fetchedChip(dashboards),
    ),
  );
}

function viewResultsCard(payload) {
  if (!payload) return card("View results", emptyState("No answer", null));
  const rows = list(payload, "results");
  const columns = rows.length > 0 ? Object.keys(rows[0]).slice(0, 6) : [];
  return card(
    `Results — ${str(payload.viewName, str(payload.viewId, "view"))}`,
    [
      upstreamBanner(payload),
      rows.length === 0
        ? emptyState(str(payload.note, "This view matched no rows"), null)
        : table(
            columns,
            rows.map((row) =>
              el(
                "tr",
                null,
                columns.map((c) => el("td", { text: clampText(String(row[c] ?? "—"), 60) })),
              ),
            ),
          ),
    ],
    fetchedChip(payload),
  );
}

/** The filter vocabulary, straight off the payload — records take a `tags`
 *  ARRAY (AND), tasks and goals a singular `tag`. */
function filterKeysFold(payload) {
  const keys =
    payload?.filterKeys && typeof payload.filterKeys === "object" ? payload.filterKeys : null;
  if (!keys) return null;
  return el("details", { class: "fold" }, [
    el("summary", { class: "fold-summary" }, [
      el("span", { class: "muted", text: "valid filter keys per entity type" }),
    ]),
    el("div", { class: "fold-body" }, [
      table(
        ["Entity", "Filter keys"],
        Object.entries(keys).map(([entity, names]) =>
          el("tr", null, [el("td", { class: "mono", text: entity }), el("td", null, chips(names))]),
        ),
      ),
      el("p", {
        class: "muted",
        text: "Record filters take `tags` as an ARRAY (all of them must match); task and goal filters take a singular `tag`.",
      }),
    ]),
  ]);
}

function grammarFold(payload) {
  const grammar =
    payload?.cardGrammar && typeof payload.cardGrammar === "object" ? payload.cardGrammar : null;
  if (!grammar) return null;
  return el("details", { class: "fold" }, [
    el("summary", { class: "fold-summary" }, [
      el("span", { class: "muted", text: "the card grammar" }),
    ]),
    el("div", { class: "fold-body" }, [
      el("p", { class: "muted" }, ["Card types: ", ...chips(grammar.cardTypes)]),
      el("p", { class: "muted" }, ["Graph types: ", ...chips(grammar.graphTypes)]),
      el("p", { class: "muted" }, ["KPI aggregations: ", ...chips(grammar.aggregations)]),
      el("p", { class: "muted" }, ["A KPI card needs both ", ...chips(grammar.kpiRequires)]),
      filterKeysFold(payload),
    ]),
  ]);
}

async function renderDashboard(host, ctx, state) {
  clear(host).appendChild(skeleton(5));
  const dashboardId = state.dashboardId;
  const payload = await callProxy(() => api.thredzDashboard({ id: ctx.id, dashboardId }));
  clear(host);
  const back = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "← all dashboards",
    onClick: () => void renderBoardsPanel(host, ctx, { dashboardId: null }),
  });
  const dashboard =
    payload?.dashboard && typeof payload.dashboard === "object" ? payload.dashboard : null;
  const cards = list(payload, "cards");
  host.appendChild(
    card(dashboard ? str(dashboard.name, dashboardId) : dashboardId, [
      el("div", { class: "safety-strip" }, [
        back,
        payload && payload.dataResolved === false
          ? dot("warn", "card data unavailable — the cards are real, their numbers are not")
          : null,
        fetchedChip(payload),
      ]),
      upstreamBanner(payload),
      payload?.dataError ? el("p", { class: "prose-pre", text: String(payload.dataError) }) : null,
      cards.length === 0
        ? emptyState("This dashboard has no cards yet", null)
        : el(
            "div",
            { class: "ov-grid" },
            cards.map((c) => cardTile(c)),
          ),
    ]),
  );
  host.appendChild(addCardCard(ctx, dashboardId, payload, () => renderDashboard(host, ctx, state)));
}

function cardTile(cardDef) {
  const display = cardDef.display && typeof cardDef.display === "object" ? cardDef.display : {};
  const source =
    cardDef.dataSource && typeof cardDef.dataSource === "object" ? cardDef.dataSource : {};
  const data = cardDef.data;
  const body = [];
  if (str(cardDef.type) === "kpi") {
    const value = data && typeof data === "object" && "value" in data ? data.value : null;
    body.push(
      el("div", { class: "big-stat" }, [
        el("span", { class: "stat-num", text: String(value ?? "—") }),
      ]),
    );
    body.push(
      el("div", { class: "mini-row" }, [
        el("span", {
          class: "mini-label",
          text: `${str(display.aggregation, "?")}(${str(display.aggregationField, "?")})`,
        }),
      ]),
    );
  } else if (Array.isArray(data) && data.length > 0) {
    const columns = Object.keys(data[0]).slice(0, 4);
    body.push(
      table(
        columns,
        data.slice(0, 8).map((row) =>
          el(
            "tr",
            null,
            columns.map((c) => el("td", { text: clampText(String(row[c] ?? "—"), 40) })),
          ),
        ),
      ),
    );
  } else {
    body.push(el("p", { class: "muted", text: "no data resolved for this card" }));
  }
  const filterNames = Object.keys(source.filters ?? {}).join(", ");
  return el("section", { class: "card ov-card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: str(cardDef.title, "card") }),
      el("span", { class: "chip", text: str(cardDef.type, "?") }),
    ]),
    el("div", {
      class: "muted",
      text: `${str(source.entityType, "?")} · ${filterNames === "" ? "no filters" : filterNames}`,
    }),
    ...body,
  ]);
}

/**
 * The add-card form. It does NOT pre-validate the grammar: the workspace is
 * the authority, and its refusal names the valid keys for the entity type —
 * so the refusal is printed here verbatim, under the form, with the draft
 * intact.
 */
function addCardCard(ctx, dashboardId, payload, reload) {
  const grammar = payload?.cardGrammar ? payload.cardGrammar : {};
  const title = input({ placeholder: "card title" });
  const type = select(Array.isArray(grammar.cardTypes) ? grammar.cardTypes : ["table"], "table");
  const entity = select(
    payload?.filterKeys ? Object.keys(payload.filterKeys) : ["record"],
    "record",
  );
  const filters = el("textarea", { class: "input", rows: 3, spellcheck: "false" });
  filters.value = '{"tags": []}';
  const aggregation = select(
    ["(none)", ...(Array.isArray(grammar.aggregations) ? grammar.aggregations : [])],
    "(none)",
  );
  const aggregationField = input({ placeholder: "aggregation field (KPI cards)" });
  const graphType = select(
    ["(none)", ...(Array.isArray(grammar.graphTypes) ? grammar.graphTypes : [])],
    "(none)",
  );
  const refusal = el("div", { class: "gated-why" });
  const form = el("form", { class: "row-editor" }, [
    field("Title", title),
    field("Type", type),
    field("Entity", entity),
    field("Filters (JSON)", filters),
    field("KPI aggregation", aggregation),
    field("KPI aggregation field", aggregationField),
    field("Graph type", graphType),
    refusal,
    el("div", { class: "editor-actions" }, [
      el("button", { class: "btn btn-primary", type: "submit", text: "Add card" }),
    ]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clear(refusal);
    let parsedFilters = {};
    try {
      parsedFilters = JSON.parse(filters.value === "" ? "{}" : filters.value);
    } catch {
      toast("filters must be JSON");
      return;
    }
    const display = {};
    if (aggregation.value !== "(none)") display.aggregation = aggregation.value;
    if (aggregationField.value.trim() !== "") {
      display.aggregationField = aggregationField.value.trim();
    }
    if (graphType.value !== "(none)") display.graphType = graphType.value;
    const res = await write(
      () =>
        api.thredzCardCreate(
          { id: ctx.id, dashboardId },
          {
            title: title.value,
            type: type.value,
            dataSource: { entityType: entity.value, filters: parsedFilters },
            display,
          },
        ),
      "Card added",
    );
    if (res && res.ok === true) {
      void reload();
      return;
    }
    if (res) {
      // Verbatim — this string names the keys that WOULD have worked.
      refusal.appendChild(dot("warn", "the workspace rejected this card"));
      refusal.appendChild(el("p", { class: "prose-pre", text: str(res.note, "refused") }));
    }
  });
  return card("Add a card", [
    el("p", {
      class: "muted",
      text: "A KPI card needs both an aggregation and an aggregation field. Record filters take `tags` as an array; task and goal filters take a singular `tag`.",
    }),
    form,
  ]);
}

// ---------------------------------------------------------------------------
// automations
// ---------------------------------------------------------------------------

async function renderOpsPanel(host, ctx) {
  const [listeners, webhooks, connectors, activity] = await Promise.all([
    callProxy(() => api.thredzListeners({ id: ctx.id })),
    callProxy(() => api.thredzWebhooks({ id: ctx.id })),
    callProxy(() => api.thredzConnectors({ id: ctx.id })),
    callProxy(() => api.thredzActivity({ id: ctx.id })),
  ]);
  clear(host);
  const reload = () => renderOpsPanel(host, ctx);
  const quota = listeners?.quota && typeof listeners.quota === "object" ? listeners.quota : null;
  host.appendChild(
    card(
      "Listeners",
      [
        upstreamBanner(listeners),
        listeners && listeners.quotaLocked === true
          ? dot("warn", "plan quota reached — a fact about the plan, not a failure")
          : null,
        quota
          ? el("p", {
              class: "muted",
              text: `${quota.used ?? "?"} of ${quota.limit ?? "?"} listener slots used${quota.plan ? ` on the ${quota.plan} plan` : ""}.`,
            })
          : null,
        list(listeners, "listeners").length === 0
          ? emptyState(
              listeners && listeners.ok === true
                ? str(listeners.note, "No listeners")
                : "The workspace did not answer",
              null,
            )
          : table(
              ["Listener", "Event", "Enabled", "Updated"],
              list(listeners, "listeners").map((l) =>
                el("tr", null, [
                  el("td", { text: str(l.name, idOf(l)) }),
                  el("td", { class: "mono", text: str(l.event, str(l.source, "—")) }),
                  el("td", null, l.enabled === false ? dot("off", "off") : dot("ok", "on")),
                  el("td", { text: when(l.updatedAt) }),
                ]),
              ),
            ),
        listenerCreateForm(ctx, reload),
      ],
      fetchedChip(listeners),
    ),
  );
  host.appendChild(
    card(
      "Webhooks",
      [
        upstreamBanner(webhooks),
        webhooks && webhooks.failedDeliveries > 0
          ? dot("warn", `${webhooks.failedDeliveries} recent deliveries did not land`)
          : null,
        webhooks?.deliveriesError
          ? el("p", { class: "muted", text: String(webhooks.deliveriesError) })
          : null,
        list(webhooks, "webhooks").length === 0
          ? emptyState(
              webhooks && webhooks.ok === true
                ? str(webhooks.note, "No webhooks")
                : "The workspace did not answer",
              null,
            )
          : table(
              ["URL", "Events", "Active"],
              list(webhooks, "webhooks").map((w) =>
                el("tr", null, [
                  el("td", { class: "mono", text: clampText(str(w.url, "—"), 60) }),
                  el("td", null, chips(w.events)),
                  el("td", null, w.active === false ? dot("off", "off") : dot("ok", "on")),
                ]),
              ),
            ),
      ],
      fetchedChip(webhooks),
    ),
  );
  host.appendChild(
    card(
      "Connectors",
      [
        upstreamBanner(connectors),
        list(connectors, "connectors").length === 0
          ? emptyState(
              connectors && connectors.ok === true
                ? str(connectors.note, "No connectors")
                : "The workspace did not answer",
              null,
            )
          : table(
              ["Connector", "Type", "Source → destination"],
              list(connectors, "connectors").map((c) =>
                el("tr", null, [
                  el("td", { text: str(c.title, idOf(c)) }),
                  el("td", { class: "mono", text: str(c.type, "—") }),
                  el("td", {
                    class: "mono",
                    text: `${str(c.sourceId, "?")} → ${str(c.destinationId, "?")}`,
                  }),
                ]),
              ),
            ),
      ],
      fetchedChip(connectors),
    ),
  );
  host.appendChild(
    card(
      "Workspace activity",
      [
        upstreamBanner(activity),
        el("p", {
          class: "muted",
          text: "This is the Thredz workspace's own feed — distinct from the manager's fleet activity digest.",
        }),
        list(activity, "items").length === 0
          ? emptyState(
              activity && activity.ok === true
                ? str(activity.note, "No activity")
                : "The workspace did not answer",
              null,
            )
          : el(
              "ul",
              { class: "fact-list" },
              list(activity, "items").map((a) =>
                el("li", { class: "fact" }, [
                  el("div", {
                    text: `${str(a.action, "?")} ${str(a.entityType, "")} ${str(a.entityTitle, "")}`.trim(),
                  }),
                  el("div", { class: "fact-meta", text: when(a.createdAt) }),
                ]),
              ),
            ),
        wikiAuditFold(activity),
      ],
      fetchedChip(activity),
    ),
  );
}

/** The wiki's own audit log — who edited, rolled back or re-graded an
 *  article. A separate log upstream, so it gets its own fold rather than
 *  being blended into the general feed. */
function wikiAuditFold(activity) {
  const entries = list(activity, "wikiAudit");
  const error = activity?.wikiAuditError ?? null;
  if (entries.length === 0 && error === null) return null;
  return el("details", { class: "fold" }, [
    el("summary", { class: "fold-summary" }, [
      el("span", { class: "muted", text: "wiki audit log" }),
    ]),
    el("div", { class: "fold-body" }, [
      error !== null ? el("p", { class: "muted", text: String(error) }) : null,
      entries.length === 0
        ? emptyState("No wiki audit entries", null)
        : table(
            ["Action", "Article", "By", "When"],
            entries.map((entry) =>
              el("tr", null, [
                el("td", { text: str(entry.action, "—") }),
                el("td", { class: "mono", text: str(entry.slug, str(entry.articleId, "—")) }),
                el("td", { class: "mono", text: str(entry.keyId, "—") }),
                el("td", { text: when(entry.createdAt) }),
              ]),
            ),
          ),
    ]),
  ]);
}

function listenerCreateForm(ctx, reload) {
  const event = input({ placeholder: "event (e.g. record.created)" });
  const name = input({ placeholder: "name" });
  const form = el("form", { class: "add-form" }, [
    event,
    name,
    el("button", { class: "btn", type: "submit", text: "Create listener" }),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await write(
      () =>
        api.thredzListenerCreate(
          { id: ctx.id },
          { event: event.value.trim(), name: name.value.trim() },
        ),
      "Listener created",
    );
    if (res && res.ok === true) void reload();
  });
  return el("div", null, [
    form,
    el("p", {
      class: "muted",
      text: "Creates are idempotency-keyed, so a replayed request cannot duplicate the automation.",
    }),
  ]);
}

// ---------------------------------------------------------------------------
// traverse
// ---------------------------------------------------------------------------

async function renderGraphPanel(host, ctx) {
  clear(host);
  const results = el("div", { class: "tab-section" });
  const startId = input({ placeholder: "start id" });
  const startType = select(["record", "goal", "task", "connector", "graph"], "record");
  const direction = select(["both", "upstream", "downstream"], "both");
  const depth = input({ type: "number", value: "3", min: "1", max: "10" });
  const form = el("form", { class: "row-editor" }, [
    field("Start id", startId),
    field("Start type", startType),
    field("Direction", direction),
    field("Max depth", depth),
    el("div", { class: "editor-actions" }, [
      el("button", { class: "btn btn-primary", type: "submit", text: "Traverse" }),
    ]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clear(results).appendChild(skeleton(3));
    const body = await callProxy(() =>
      api.thredzTraverse(
        { id: ctx.id },
        {
          startId: startId.value.trim(),
          startType: startType.value,
          direction: direction.value,
          maxDepth: Number.parseInt(depth.value, 10) || 3,
        },
      ),
    );
    clear(results);
    if (!body) return;
    const nodes = list(body, "nodes");
    results.appendChild(
      card(
        "Traversal",
        [
          upstreamBanner(body),
          nodes.length === 0
            ? emptyState(str(body.note, "Nothing connected in that direction"), null)
            : table(
                ["Node", "Type", "Depth"],
                nodes.map((n) =>
                  el("tr", null, [
                    el("td", { text: str(n.title, idOf(n)) }),
                    el("td", { class: "mono", text: str(n.type, str(n.entityType, "—")) }),
                    el("td", { class: "mono", text: String(n.depth ?? "—") }),
                  ]),
                ),
              ),
          el("p", { class: "muted", text: `${list(body, "edges").length} edges` }),
        ],
        fetchedChip(body),
      ),
    );
  });
  host.appendChild(
    card("Graph traversal", [
      el("p", {
        class: "muted",
        text: "Walk the workspace graph from one node — records, goals, tasks and their connectors.",
      }),
      form,
    ]),
  );
  host.appendChild(results);
}

// ---------------------------------------------------------------------------
// key administration
// ---------------------------------------------------------------------------

async function renderKeysPanel(host, ctx) {
  const payload = await callProxy(() => api.thredzKeys({ id: ctx.id }));
  clear(host);
  const reload = () => renderKeysPanel(host, ctx);
  const keys = list(payload, "keys");
  const grants = list(payload, "grants");
  host.appendChild(
    card("API keys", [
      el("div", { class: "safety-strip" }, [
        dot(
          payload && payload.tier === "admin" ? "ok" : "off",
          `tier: ${payload ? str(payload.tier, "unknown") : "unknown"}`,
        ),
        fetchedChip(payload),
      ]),
      upstreamBanner(payload),
      el("p", {
        class: "muted",
        text: "Key VALUES never reach this screen — the manager strips them server-side. Only metadata and grants are shown.",
      }),
      keys.length === 0
        ? emptyState(
            payload && payload.ok === true
              ? str(payload.note, "No keys")
              : "Key administration needs an admin-tier key",
            null,
          )
        : table(
            ["Key", "Owner", "Permissions", "Created", ""],
            keys.map((k) =>
              el("tr", null, [
                el("td", { class: "mono", text: str(k.id, "—") }),
                el("td", { text: str(k.owner, "—") }),
                el("td", null, [
                  el("span", { text: str(k.permissions, "—") }),
                  k.disabled === true ? dot("bad", "disabled") : null,
                ]),
                el("td", { text: when(k.createdAt) }),
                el(
                  "td",
                  { class: "cell-actions" },
                  el("button", {
                    class: "btn btn-ghost",
                    type: "button",
                    text: "Rotate…",
                    onClick: () => renderRotate(host, ctx, k, reload),
                  }),
                ),
              ]),
            ),
          ),
      grants.length === 0
        ? null
        : el("details", { class: "fold" }, [
            el("summary", { class: "fold-summary" }, [
              el("span", { class: "muted", text: "wiki grants" }),
            ]),
            el("div", { class: "fold-body" }, [
              table(
                ["Key", "Permission"],
                grants.map((g) =>
                  el("tr", null, [
                    el("td", { class: "mono", text: str(g.keyId, "—") }),
                    el("td", { text: str(g.permission, "—") }),
                  ]),
                ),
              ),
            ]),
          ]),
    ]),
  );
  if (payload && payload.tier === "admin") host.appendChild(keyCreateCard(ctx, reload));
}

function keyCreateCard(ctx, reload) {
  const label = input({ placeholder: "owner / label" });
  const permissions = select(["read-write", "read", "admin"], "read-write");
  const value = el("input", { class: "input", type: "password", placeholder: "the key's value" });
  const grant = select(["(none)", "read", "read-write"], "read-write");
  const form = el("form", { class: "row-editor" }, [
    field("Owner", label),
    field("Permissions", permissions),
    field("Value (write-only)", value),
    field("Wiki grant", grant),
    el("div", { class: "editor-actions" }, [
      el("button", { class: "btn btn-primary", type: "submit", text: "Register key" }),
    ]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await write(
      () =>
        api.thredzKeyCreate(
          { id: ctx.id },
          {
            label: label.value.trim(),
            permissions: permissions.value,
            value: value.value,
            ...(grant.value === "(none)" ? {} : { wikiAccess: grant.value }),
          },
        ),
      "Key registered — its value was forwarded once and stored nowhere",
    );
    value.value = "";
    if (res && res.ok === true) void reload();
  });
  return card("Register a key", [
    el("p", {
      class: "muted",
      text: "Mint the key in the Thredz account portal, then paste it here once. The manager forwards it and never stores, logs or returns it — which is also why it can never show you a key you have lost.",
    }),
    form,
  ]);
}

function renderRotate(host, ctx, key, reload) {
  const expected = str(key.owner, str(key.id, ""));
  const value = el("input", {
    class: "input",
    type: "password",
    placeholder: "the replacement value",
  });
  const confirmName = input({ placeholder: `type "${expected}" to confirm` });
  const form = el("form", { class: "row-editor" }, [
    field("Replacement value (write-only)", value),
    field("Confirm", confirmName),
    el("div", { class: "editor-actions" }, [
      el("button", { class: "btn btn-danger", type: "submit", text: "Rotate" }),
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Cancel",
        onClick: () => void reload(),
      }),
    ]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const res = await write(
      () =>
        api.thredzKeyRotate(
          { id: ctx.id, keyId: str(key.id, "") },
          { value: value.value, confirmName: confirmName.value },
        ),
      "Replacement key registered",
    );
    value.value = "";
    if (res && res.ok === true) void reload();
  });
  clear(host).appendChild(
    card(`Rotate ${expected}`, [
      el("p", {
        class: "muted",
        text: "Rotation registers a REPLACEMENT key with the same owner, permissions and wiki grant. It does not delete the old key — this console ships no hard-delete affordance, so retiring the old value stays a deliberate act in the Thredz account portal.",
      }),
      form,
    ]),
  );
}

// ---------------------------------------------------------------------------
// the global explorer
// ---------------------------------------------------------------------------

/** The harness-less global explorer (`#/thredz`). */
export async function renderThredzGlobal(root) {
  clear(root).appendChild(skeleton(5));
  const payload = await callProxy(() => api.thredzGlobal());
  clear(root);
  if (!payload) {
    root.appendChild(card("Thredz explorer", emptyState("The manager did not answer", null)));
    return;
  }
  const { state, label } = proxyState(payload);
  const counts = payload.counts && typeof payload.counts === "object" ? payload.counts : null;
  const keyed = payload.keyPresent === true;
  root.appendChild(
    card(
      "Thredz explorer",
      [
        el("div", { class: "safety-strip" }, [
          dot(keyed ? state : "off", keyed ? label : "no manager key"),
          el("span", { class: "chip", text: str(payload.workspace, "—") }),
        ]),
        upstreamBanner(payload),
        keyed
          ? el(
              "dl",
              { class: "kv" },
              [
                ["Key source", str(payload.keySource, "—")],
                ["Records", counts && counts.records !== null ? String(counts.records) : "—"],
                [
                  "Dashboards",
                  counts && counts.dashboards !== null ? String(counts.dashboards) : "—",
                ],
              ].flatMap(([k, v]) => [el("dt", { class: "kv-k", text: k }), el("dd", { text: v })]),
            )
          : el("p", { class: "prose-pre", text: str(payload.note, "") }),
        el("p", {
          class: "muted",
          text: "This explorer uses the manager's own CREWHAUS_THREDZ_KEY when one is set. It is read from the environment per request and never written to manager config.",
        }),
      ],
      fetchedChip(payload),
    ),
  );
  const harnesses = list(payload, "harnesses");
  root.appendChild(
    card("Harnesses wired to a workspace", [
      el("p", {
        class: "muted",
        text: `${payload.wired ?? 0} of ${harnesses.length} declare a \`thredz:\` block.`,
      }),
      harnesses.length === 0
        ? emptyState("No harnesses registered yet", "crewhaus hangar add")
        : table(
            ["Harness", "Backend", "Key variable", "New writes"],
            harnesses.map((h) =>
              el("tr", null, [
                el(
                  "td",
                  null,
                  el("a", {
                    class: "name-link",
                    href: hrefHarness(str(h.id, ""), "thredz"),
                    text: str(h.specName, str(h.id, "—")),
                  }),
                ),
                el(
                  "td",
                  null,
                  h.declared === true ? dot("ok", "thredz") : dot("off", "local files"),
                ),
                el("td", { class: "mono", text: str(h.envName, "—") }),
                el("td", { text: str(h.defaultVisibility, "private") }),
              ]),
            ),
          ),
    ]),
  );
}
