/**
 * Memory — the M3 half of the Memory tab: the facts browser with provenance,
 * the recall playground, the continuity panel and its trash, the wiki
 * browser/editor with versions and the link graph, the dream control panel,
 * watchme analytics and the synthesize review, the learning panel, and
 * knowledge sync.
 *
 * The M1 reads (`views/memory.js`: facts/wiki/state/dream/watchme cards)
 * stay where they are and are rendered above this.
 *
 * THE INVARIANT THIS SCREEN EXISTS TO MAKE VISIBLE: nothing here deletes.
 * Forgetting a fact writes a supersede tombstone with the operator's reason,
 * clearing continuity moves it to a restorable trash snapshot, and a wiki
 * article is archived rather than removed. Every one of those is reversible,
 * and every button says so AT THE POINT OF THE CLICK — a promise made only
 * in a docblock is a promise the operator never reads.
 *
 * Two more house rules this file leans on:
 *   - a refusal is a STATE, not a toast. A stale wiki write comes back 200
 *     with the version that moved and the diff; the editor renders it inline
 *     with a retry button rather than throwing the operator's draft away.
 *   - judge verdicts and human feedback are drawn in separate blocks, with
 *     their sources named, because they are separate stores by design.
 *
 * Panels load lazily: seven areas' worth of routes on one paint would make
 * the tab slow for an operator who came to look at one of them.
 */

import { api } from "../api.js";
import {
  asOf,
  clear,
  collapsible,
  copyBtn,
  dot,
  el,
  emptyState,
  jsonPre,
  mdBlocks,
  skeleton,
  toast,
} from "../dom.js";
import { hrefHarness } from "../router.js";
import { fmtCount, fmtPct, fmtRelativeTime, fmtUsd, usdFromMicros } from "../util.js";

const PANELS = [
  ["facts", "Facts"],
  ["continuity", "Continuity"],
  ["wiki", "Wiki"],
  ["dream", "Dream"],
  ["watchme", "Watchme"],
  ["learning", "Learning"],
  ["knowledge", "Knowledge"],
];

// ---------------------------------------------------------------------------
// pure helpers (unit-tested in hangar-ui/src/memory-fabric.test.ts)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** What the server's value-shape masker leaves behind. Text carrying it is
 *  not safe to write back — the mask would replace what it hid. */
const MASK_MARK = "***";

/** Human TTL countdown for a fact. Null when the fact has no expiry. */
export function ttlLabel(expiresInMs) {
  if (typeof expiresInMs !== "number") return null;
  const days = Math.abs(expiresInMs) / DAY_MS;
  const rounded = days >= 1 ? `${Math.round(days)}d` : `${Math.max(1, Math.round(days * 24))}h`;
  return expiresInMs >= 0 ? `expires in ${rounded}` : `past TTL by ${rounded}`;
}

/** Traffic-light state for a folded fact status (never colour alone). */
export function factTone(status) {
  if (status === "live") return "ok";
  if (status === "superseded") return "off";
  return "warn";
}

/**
 * Split watchme's per-model spend into what is PRICED and what is not. An
 * unpriced model's cost is UNKNOWN, and folding it into the total would turn
 * a measurement gap into a false zero — so it gets its own line, always.
 */
export function costSummary(analytics) {
  const a = analytics && typeof analytics === "object" ? analytics : {};
  const unpriced = a.unpriced && typeof a.unpriced === "object" ? a.unpriced : {};
  const models = Array.isArray(unpriced.models) ? unpriced.models : [];
  return {
    priced: typeof a.costUsdMicros === "number" ? a.costUsdMicros : 0,
    unpricedModels: models.length,
    unpricedTurns: typeof unpriced.turns === "number" ? unpriced.turns : 0,
    note: models.length === 0 ? null : (unpriced.note ?? "some models are unpriced"),
  };
}

/**
 * Classify a wiki write answer. `stale_article_version` is a first-class
 * state carrying the version to retry from — never an error toast.
 */
export function writeOutcome(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.ok === true) return { kind: "ok", message: String(b.note ?? "saved"), retryVersion: null };
  if (b.code === "stale_article_version") {
    const current = b.current && typeof b.current === "object" ? b.current : {};
    return {
      kind: "stale",
      message: String(b.note ?? "the article moved under you"),
      retryVersion: typeof b.currentVersion === "number" ? b.currentVersion : null,
      currentBody: typeof current.body === "string" ? current.body : "",
    };
  }
  if (b.code === "missing_sources") {
    return {
      kind: "gate",
      message: String(b.note ?? "a ## Sources heading is required"),
      retryVersion: null,
    };
  }
  return {
    kind: "error",
    message: String(b.note ?? b.message ?? "the write was refused"),
    retryVersion: null,
  };
}

/** Dream lane verdict: overdue, on schedule, or not on a timer at all. */
export function dreamTone(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (p.declared !== true) return { state: "off", label: "no dream cadence declared" };
  if (p.overdue === true) return { state: "warn", label: "overdue" };
  return { state: "ok", label: `every ${String(p.cadence ?? "?")}` };
}

/** Staleness label for a REFLECT row, or null when it is fresh. */
export function staleLabel(row) {
  const r = row && typeof row === "object" ? row : {};
  if (typeof r.staleMs !== "number") return null;
  const days = Math.floor(r.staleMs / DAY_MS);
  const label = days >= 1 ? `${days}d since last touch` : "touched today";
  return r.stale === true ? `stale — ${label}` : label;
}

// ---------------------------------------------------------------------------
// shared rendering
// ---------------------------------------------------------------------------

/** Card shell used by every panel. */
function card(title, children, extraTitle = null) {
  return el("section", { class: "card ov-card ov-wide" }, [
    el("h3", { class: "card-title" }, [el("span", { text: title }), extraTitle]),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

/** A refusal the server answered with — including "not built yet" (501). */
function refusalCard(res) {
  const body = res && typeof res.body === "object" && res.body !== null ? res.body : {};
  const message = String(body.error ?? body.message ?? `HTTP ${res?.status ?? 0}`);
  return el("div", { class: "card error-card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Not available" }),
      dot(res?.status === 501 ? "off" : "bad", `HTTP ${res?.status ?? 0}`),
    ]),
    el("p", { class: "muted", text: message }),
  ]);
}

/** Load one M3 read into `host`, rendering its refusal instead on failure. */
async function load(host, call) {
  const res = await call();
  if (!res.ok) {
    host.appendChild(refusalCard(res));
    return null;
  }
  return res.body && typeof res.body === "object" ? res.body : {};
}

/**
 * Run one write with a busy button. A non-2xx (or an `ok:false` envelope)
 * never fails silently: it becomes a toast carrying the server's own note,
 * which is the sentence that explains what to do next.
 */
async function run(btn, label, call, onDone) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = `${label}…`;
  let res;
  try {
    res = await call();
  } catch (err) {
    res = { ok: false, status: 0, body: { message: String(err) } };
  }
  btn.textContent = original;
  btn.disabled = false;
  const body = res.body && typeof res.body === "object" ? res.body : {};
  if (!res.ok) {
    toast(`${label} failed: ${String(body.error ?? body.message ?? res.status)}`);
  } else if (body.ok === false) {
    toast(String(body.note ?? body.message ?? `${label} was refused`));
  }
  if (onDone) onDone(res);
  return res;
}

/** A labelled key/value row. */
function kv(k, v) {
  return el("div", { class: "kv" }, [
    el("span", { class: "kv-k", text: k }),
    el("span", { class: "kv-v" }, typeof v === "string" ? el("span", { text: v }) : v),
  ]);
}

/** A table from a header list and row-node builder. */
function table(headers, rows) {
  const tbody = el("tbody");
  for (const row of rows) tbody.appendChild(row);
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
      tbody,
    ]),
  ]);
}

/** The empty state for a payload that carries its own note + verb. */
function empty(payload, fallback) {
  const note = typeof payload?.note === "string" ? payload.note : fallback;
  const verb = typeof payload?.verb === "string" ? payload.verb : null;
  return emptyState(note ?? fallback, verb);
}

/** A text input with a label. */
function field(label, attrs = {}) {
  const input = el("input", { class: "input", type: "text", ...attrs });
  return { node: el("label", { class: "field" }, [el("span", { text: label }), input]), input };
}

/** A deep link into the session viewer — the join that makes memory auditable. */
function sessionLink(ctx, sessionId, label) {
  return el("a", {
    class: "mono",
    href: hrefHarness(ctx.id, "sessions", sessionId),
    text: label ?? sessionId,
  });
}

// ---------------------------------------------------------------------------
// the shell
// ---------------------------------------------------------------------------

export async function renderMemoryFabric(root, ctx) {
  const state = { panel: "facts" };
  clear(root);
  const nav = el("nav", { class: "tabs", "aria-label": "memory fabric panels" });
  const host = el("div", { class: "tab-body" });
  const draw = () => {
    clear(nav);
    for (const [id, label] of PANELS) {
      nav.appendChild(
        el("button", {
          class: `tab${state.panel === id ? " active" : ""}`,
          type: "button",
          "aria-current": state.panel === id ? "page" : null,
          text: label,
          onClick: () => {
            state.panel = id;
            draw();
          },
        }),
      );
    }
    clear(host).appendChild(skeleton(6));
    void panelFor(state.panel)(host, ctx, () => draw());
  };
  root.appendChild(el("h3", { class: "sub-title", text: "Memory fabric" }));
  root.appendChild(nav);
  root.appendChild(host);
  draw();
}

function panelFor(id) {
  switch (id) {
    case "continuity":
      return continuityPanel;
    case "wiki":
      return wikiPanel;
    case "dream":
      return dreamPanel;
    case "watchme":
      return watchmePanel;
    case "learning":
      return learningPanel;
    case "knowledge":
      return knowledgePanel;
    default:
      return factsPanel;
  }
}

// ---------------------------------------------------------------------------
// facts + recall
// ---------------------------------------------------------------------------

async function factsPanel(host, ctx, reload, spec) {
  const first = spec ?? String(ctx.detail?.entry?.specName ?? "");
  clear(host).appendChild(skeleton(6));
  const data = await load(host, () => api.memoryFacts({ id: ctx.id, spec: first || "default" }));
  if (data === null) return;
  clear(host);

  const specs = Array.isArray(data.specs) ? data.specs.map(String) : [];
  if (specs.length > 0) {
    host.appendChild(
      el("div", { class: "filter-bar" }, [
        el("span", { class: "muted", text: "store" }),
        ...specs.map((name) =>
          el("button", {
            class: `btn btn-ghost${name === data.specName ? " active" : ""}`,
            type: "button",
            text: name,
            onClick: () => void factsPanel(host, ctx, reload, name),
          }),
        ),
      ]),
    );
  }

  const items = Array.isArray(data.items) ? data.items : [];
  if (items.length === 0) {
    host.appendChild(card("Facts", empty(data, "No facts yet")));
  } else {
    const counts = data.counts && typeof data.counts === "object" ? data.counts : {};
    const live = items.filter((i) => i.status === "live");
    const folded = items.filter((i) => i.status !== "live");
    const rows = [
      el("div", { class: "filter-bar" }, [
        dot("ok", `${fmtCount(counts.live ?? 0)} live`),
        dot("off", `${fmtCount(counts.superseded ?? 0)} superseded`),
        dot("warn", `${fmtCount(counts.expired ?? 0)} expired`),
        data.truncated === true
          ? el("span", { class: "chip chip-warn", text: "capped — counts are floors" })
          : null,
      ]),
      el(
        "ul",
        { class: "fact-list" },
        live.map((f) => factRow(f, ctx, host, reload, data.specName)),
      ),
    ];
    if (folded.length > 0) {
      rows.push(
        collapsible(
          [
            el("span", {
              class: "muted",
              text: `${folded.length} superseded/expired — tombstoned, never deleted`,
            }),
          ],
          [
            el(
              "ul",
              { class: "fact-list folded" },
              folded.map((f) => factRow(f, ctx, host, reload, data.specName)),
            ),
          ],
        ),
      );
    }
    host.appendChild(card("Facts", rows));
  }

  host.appendChild(sweepCard(ctx, String(data.specName ?? ""), host, reload));
  host.appendChild(recallCard(ctx));
  host.appendChild(migrateCard(ctx));
}

function factRow(fact, ctx, host, reload, spec) {
  const provenance =
    fact.provenance && typeof fact.provenance === "object" ? fact.provenance : null;
  const meta = el("div", { class: "fact-meta" }, [
    ...(Array.isArray(fact.tags) ? fact.tags : []).map((t) =>
      el("span", { class: "chip", text: String(t) }),
    ),
    fact.status !== "live" ? dot(factTone(fact.status), String(fact.status)) : null,
    ttlLabel(fact.expiresInMs) === null
      ? null
      : el("span", {
          class: fact.status === "expired" ? "chip chip-warn" : "chip",
          text: ttlLabel(fact.expiresInMs),
        }),
    typeof fact.createdAt === "string" && fact.createdAt !== ""
      ? el("span", {
          class: "muted",
          title: fact.createdAt,
          text: fmtRelativeTime(fact.createdAt, Date.now()),
        })
      : null,
  ]);
  const children = [el("div", { text: String(fact.text ?? "") }), meta];

  if (provenance !== null) {
    const evidence = Array.isArray(provenance.evidence) ? provenance.evidence : [];
    children.push(
      el("div", { class: "fact-meta" }, [
        el("span", { class: "muted", text: "from" }),
        provenance.sessionId ? sessionLink(ctx, String(provenance.sessionId)) : null,
        ...evidence.map((toolUseId) =>
          el("a", {
            class: "chip chip-tool",
            href: provenance.sessionId
              ? hrefHarness(ctx.id, "sessions", String(provenance.sessionId))
              : hrefHarness(ctx.id, "sessions"),
            title: `evidence ${String(toolUseId)} — open the session that produced it`,
            text: String(toolUseId),
          }),
        ),
      ]),
    );
  }

  if (typeof fact.supersededBy === "string" || typeof fact.supersedeReason === "string") {
    children.push(
      el("div", { class: "muted" }, [
        el("span", {
          text: `superseded${fact.supersedeReason ? `: ${fact.supersedeReason}` : ""}`,
        }),
        fact.supersededBy ? el("span", { class: "mono", text: ` → ${fact.supersededBy}` }) : null,
      ]),
    );
  }

  if (fact.status === "live") {
    children.push(forgetControl(ctx, spec, String(fact.id ?? ""), host, reload));
  }
  return el("li", { class: "fact" }, children);
}

/** Forget = a supersede tombstone with a REASON. The reason is required, and
 *  the control says what actually happens before the click. */
function forgetControl(ctx, spec, factId, host, reload) {
  const wrap = el("div", { class: "row-editor" });
  const open = el("button", { class: "btn btn-ghost", type: "button", text: "Forget…" });
  open.addEventListener("click", () => {
    clear(wrap);
    const reason = field("why (recorded on the tombstone)", { placeholder: "superseded by …" });
    const confirm = el("button", { class: "btn btn-danger", type: "button", text: "Forget" });
    confirm.addEventListener("click", () => {
      if (reason.input.value.trim() === "") {
        toast("a reason is required — it is what the tombstone records");
        return;
      }
      void run(
        confirm,
        "Forget",
        () =>
          api.memoryForget(
            { id: ctx.id, spec },
            { factId, reason: reason.input.value.trim(), confirm: true },
          ),
        (res) => {
          if (res.ok && res.body?.ok !== false) void factsPanel(host, ctx, reload, spec);
        },
      );
    });
    wrap.appendChild(
      el("div", { class: "editor-actions" }, [
        reason.node,
        confirm,
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: "Cancel",
          onClick: () => {
            clear(wrap).appendChild(open);
          },
        }),
        el("span", {
          class: "muted gated-why",
          text: "this appends a tombstone — the original line stays on disk and stays auditable",
        }),
      ]),
    );
  });
  wrap.appendChild(open);
  return wrap;
}

/** Sweep: dry-run first, the real pass as a second, separate gesture. */
function sweepCard(ctx, spec, host, reload) {
  const body = el("div");
  const plan = el("button", { class: "btn", type: "button", text: "Preview expiry sweep" });
  plan.addEventListener("click", () => {
    void run(
      plan,
      "Preview",
      () => api.memorySweep({ id: ctx.id, spec }, { dryRun: true }),
      (res) => {
        clear(body);
        if (!res.ok) return;
        const rows = Array.isArray(res.body?.plan) ? res.body.plan : [];
        body.appendChild(el("p", { class: "muted", text: String(res.body?.note ?? "") }));
        if (rows.length === 0) return;
        body.appendChild(
          el(
            "ul",
            { class: "fact-list" },
            rows.map((r) =>
              el("li", { class: "fact" }, [
                el("div", { text: String(r.text ?? "") }),
                el("div", { class: "fact-meta" }, [
                  el("span", { class: "mono muted", text: String(r.id ?? "") }),
                ]),
              ]),
            ),
          ),
        );
        const real = el("button", {
          class: "btn btn-danger",
          type: "button",
          text: "Run the sweep",
        });
        real.addEventListener("click", () => {
          void run(
            real,
            "Sweep",
            () => api.memorySweep({ id: ctx.id, spec }, { dryRun: false }),
            () => void factsPanel(host, ctx, reload, spec),
          );
        });
        body.appendChild(
          el("div", { class: "editor-actions" }, [
            real,
            el("span", {
              class: "muted gated-why",
              text: "the sweep appends expired tombstones — it never rewrites or compacts the file",
            }),
          ]),
        );
      },
    );
  });
  return card("Expiry sweep", [
    el("p", {
      class: "muted",
      text: "TTL expiry is the store's own pass; the manager shows the plan first.",
    }),
    plan,
    body,
  ]);
}

/** The recall playground: exactly what the agent would recall, with scores. */
function recallCard(ctx) {
  const results = el("div");
  const query = field("query", { placeholder: "what would the agent recall for…" });
  const go = el("button", { class: "btn btn-primary", type: "button", text: "Recall" });
  go.addEventListener("click", () => {
    if (query.input.value.trim() === "") return;
    void run(
      go,
      "Recall",
      () => api.memoryRecall({ id: ctx.id }, { query: query.input.value, k: 5 }),
      (res) => {
        clear(results);
        if (!res.ok) return;
        const hits = Array.isArray(res.body?.results) ? res.body.results : [];
        results.appendChild(el("p", { class: "muted", text: String(res.body?.note ?? "") }));
        if (hits.length === 0) {
          results.appendChild(el("p", { class: "muted", text: "nothing would be recalled" }));
          return;
        }
        results.appendChild(
          table(
            ["Score", "Fact", "Tags"],
            hits.map((h) =>
              el("tr", null, [
                el("td", { class: "num", text: (Number(h.score) || 0).toFixed(3) }),
                el("td", { text: String(h.text ?? "") }),
                el("td", {
                  text: (Array.isArray(h.tags) ? h.tags : []).join(", "),
                }),
              ]),
            ),
          ),
        );
      },
    );
  });
  return card("Recall playground", [
    el("div", { class: "editor-actions" }, [query.node, go]),
    el("p", {
      class: "muted",
      text: "a read: recall touches no counter and no file",
    }),
    results,
  ]);
}

/** The v1 → v2 fact-store backfill, dry-run first and typed-confirm to run. */
function migrateCard(ctx) {
  const out = el("div");
  const dry = el("button", { class: "btn", type: "button", text: "Preview migration" });
  const name = field("type the spec name to run it", { placeholder: "spec name" });
  const real = el("button", { class: "btn btn-danger", type: "button", text: "Migrate" });
  dry.addEventListener("click", () => {
    void run(
      dry,
      "Preview",
      () => api.memoryMigrate({ id: ctx.id }, { dryRun: true }),
      (res) => {
        clear(out);
        if (!res.ok) return;
        out.appendChild(el("p", { class: "muted", text: String(res.body?.note ?? "") }));
        const fleet = Array.isArray(res.body?.fleet) ? res.body.fleet : [];
        out.appendChild(
          table(
            ["Harness", "Memory schema", "State"],
            fleet.map((row) =>
              el("tr", null, [
                el("td", { class: "mono", text: String(row.specName ?? row.id ?? "") }),
                el("td", {
                  class: "num",
                  text: row.schemaVersion === null ? "—" : String(row.schemaVersion),
                }),
                el("td", null, [
                  row.behind === true ? dot("warn", "behind") : dot("ok", "current"),
                ]),
              ]),
            ),
          ),
        );
      },
    );
  });
  real.addEventListener("click", () => {
    void run(real, "Migrate", () =>
      api.memoryMigrate({ id: ctx.id }, { dryRun: false, confirmName: name.input.value.trim() }),
    );
  });
  return card("Schema migration", [
    el("p", {
      class: "muted",
      text: "`crewhaus migrate memories` — the v1 → v2 backfill, through the job queue.",
    }),
    el("div", { class: "editor-actions" }, [dry, name.node, real]),
    out,
  ]);
}

// ---------------------------------------------------------------------------
// continuity
// ---------------------------------------------------------------------------

async function continuityPanel(host, ctx, reload) {
  clear(host).appendChild(skeleton(6));
  const [data, trash] = await Promise.all([
    load(host, () => api.continuity({ id: ctx.id })),
    load(host, () => api.continuityTrash({ id: ctx.id })),
  ]);
  clear(host);
  if (data === null) return;

  if (data.present !== true) {
    host.appendChild(card("Continuity", empty(data, "No continuity state yet")));
  } else {
    const focus = data.focus && typeof data.focus === "object" ? data.focus : {};
    const children = [
      el("div", { class: "filter-bar" }, [
        focus.managed === true
          ? dot("ok", "managed focus.md")
          : dot("off", "unmanaged focus.md — a human's file, never overwritten"),
        el("span", { class: "chip", text: String(data.layout ?? "") }),
        typeof data.degraded === "string" && data.degraded !== ""
          ? el("span", { class: "chip chip-warn", title: data.degraded, text: "degraded read" })
          : null,
      ]),
    ];
    if (typeof focus.body === "string" && focus.body !== "") {
      children.push(el("h4", { class: "sub-title", text: "Focus" }));
      children.push(mdBlocks(focus.body));
    }
    const reqs = Array.isArray(focus.requirements) ? focus.requirements : [];
    if (reqs.length > 0) {
      children.push(el("h4", { class: "sub-title", text: "Requirements ledger" }));
      children.push(
        table(
          ["REQ", "Status", "The user's words", "Source"],
          reqs.map((r) =>
            el("tr", null, [
              el("td", { class: "mono", text: String(r.id ?? "") }),
              el("td", null, [
                dot(
                  r.status === "confirmed" ? "ok" : r.status === "dropped" ? "off" : "warn",
                  String(r.status ?? ""),
                ),
              ]),
              el("td", { text: String(r.text ?? "") }),
              el("td", null, [
                r.sessionId
                  ? sessionLink(ctx, String(r.sessionId), `turn ${String(r.turn ?? "?")}`)
                  : el("span", { text: "—" }),
              ]),
            ]),
          ),
        ),
      );
      if (focus.ledgerTruncated === true) {
        children.push(
          el("p", {
            class: "muted",
            text: "the ledger evicted its oldest entries to stay under its cap",
          }),
        );
      }
    }
    host.appendChild(card("Continuity", children));
    host.appendChild(plansCard(data, ctx));
    host.appendChild(goalsCard(data));
    if (data.handoff && typeof data.handoff === "object") {
      host.appendChild(card("Handoff", mdBlocks(String(data.handoff.text ?? ""))));
    }
  }

  host.appendChild(trashCard(trash, ctx, host, reload));
}

function plansCard(data, ctx) {
  const plans = Array.isArray(data.plans) ? data.plans : [];
  if (plans.length === 0) {
    return card("Plans", emptyState("No plans yet", "crewhaus run (then /plan)"));
  }
  return card(
    "Plans",
    plans.map((plan) =>
      collapsible(
        [
          el("span", { class: "mono", text: String(plan.id ?? "") }),
          el("span", { text: ` ${String(plan.title ?? "")}` }),
        ],
        [
          typeof plan.text === "string"
            ? el("pre", { class: "prose-pre", text: plan.text })
            : el(
                "ol",
                { class: "check-list" },
                (Array.isArray(plan.steps) ? plan.steps : []).map((step) =>
                  el("li", null, [
                    dot(ladderTone(step.status), String(step.status ?? "")),
                    el("span", { text: ` ${String(step.text ?? "")}` }),
                    ...(Array.isArray(step.proofs) ? step.proofs : []).map((proof) =>
                      el("a", {
                        class: "chip chip-tool",
                        href: hrefHarness(ctx.id, "sessions", String(proof.sessionId ?? "")),
                        title: `${String(proof.toolName ?? "tool")} — ${String(proof.resultDigest ?? "")}`,
                        text: String(proof.toolUseId ?? ""),
                      }),
                    ),
                  ]),
                ),
              ),
        ],
        true,
      ),
    ),
  );
}

function ladderTone(status) {
  if (status === "proven") return "ok";
  if (status === "claimed") return "warn";
  if (status === "in_progress") return "unknown";
  return "off";
}

function goalsCard(data) {
  const goals = Array.isArray(data.goals) ? data.goals : [];
  if (goals.length === 0)
    return card("Goals", emptyState("No goals yet", "crewhaus run (then /goal)"));
  return card(
    "Goals",
    table(
      ["Goal", "Status", "Progress"],
      goals.map((g) =>
        el("tr", null, [
          el("td", { text: String(g.title ?? "") }),
          el("td", null, [dot(ladderTone(g.status), String(g.status ?? ""))]),
          el("td", {
            text:
              typeof g.current === "number" && typeof g.target === "number"
                ? `${g.current} / ${g.target}${g.unit ? ` ${g.unit}` : ""}`
                : "—",
          }),
        ]),
      ),
    ),
  );
}

/** The trash browser — the screen that makes "clear never deletes" visible. */
function trashCard(trash, ctx, host, reload) {
  const snapshots = Array.isArray(trash?.snapshots) ? trash.snapshots : [];
  if (snapshots.length === 0) {
    return card("Trash", empty(trash, "Nothing has been cleared yet"));
  }
  const rows = snapshots.map((snap) => {
    const restore = el("button", {
      class: "btn",
      type: "button",
      text: "Restore",
      disabled: snap.restorable === false || null,
      title:
        snap.restorable === false
          ? `restoring would overwrite ${(snap.blockedBy ?? []).join(", ")} — move those aside first`
          : "move every file in this snapshot back where it came from",
    });
    if (snap.restorable !== false) {
      restore.addEventListener("click", () => {
        void run(
          restore,
          "Restore",
          () => api.continuityRestore({ id: ctx.id }, { stamp: String(snap.ts), confirm: true }),
          () => void continuityPanel(host, ctx, reload),
        );
      });
    }
    return el("tr", null, [
      el("td", { class: "mono", text: String(snap.ts ?? "") }),
      el("td", {
        text: typeof snap.at === "string" ? fmtRelativeTime(snap.at, Date.now()) : "—",
      }),
      el("td", { class: "num", text: String((snap.files ?? []).length) }),
      el("td", null, [
        snap.restorable === false ? dot("warn", "blocked") : dot("ok", "restorable"),
      ]),
      el("td", null, [restore]),
    ]);
  });
  return card("Trash", [
    el("p", {
      class: "muted",
      text: `clearing continuity moves files here — restorable by timestamp, purged after ${String(trash?.purgeAfterDays ?? 7)} days`,
    }),
    table(["Snapshot", "Age", "Files", "State", ""], rows),
  ]);
}

// ---------------------------------------------------------------------------
// wiki
// ---------------------------------------------------------------------------

async function wikiPanel(host, ctx, reload) {
  clear(host).appendChild(skeleton(6));
  const state = { tags: "", status: "all", q: "" };
  await drawReflect(host, ctx, reload, state);
}

async function drawReflect(host, ctx, reload, state) {
  const query = [
    state.tags ? `tags=${encodeURIComponent(state.tags)}` : "",
    state.status && state.status !== "all" ? `status=${encodeURIComponent(state.status)}` : "",
    state.q ? `q=${encodeURIComponent(state.q)}` : "",
  ]
    .filter((p) => p !== "")
    .join("&");
  clear(host).appendChild(skeleton(4));
  const data = await load(host, () =>
    api.wikiReflect({ id: ctx.id }, undefined, query === "" ? "" : `?${query}`),
  );
  clear(host);
  if (data === null) return;

  const filters = data.filters && typeof data.filters === "object" ? data.filters : {};
  const tagInput = field("tags (comma separated)", { value: state.tags });
  const qInput = field("search", { value: state.q });
  const statusSelect = el(
    "select",
    { class: "input" },
    ["all", "draft", "review", "published", "archived"].map((s) =>
      el("option", { value: s, text: s, selected: s === state.status ? true : null }),
    ),
  );
  const apply = el("button", { class: "btn", type: "button", text: "Filter" });
  apply.addEventListener("click", () => {
    state.tags = tagInput.input.value.trim();
    state.q = qInput.input.value.trim();
    state.status = statusSelect.value;
    void drawReflect(host, ctx, reload, state);
  });

  host.appendChild(
    card("REFLECT queue", [
      el("p", {
        class: "muted",
        text: `stale-first over ${String(data.total ?? 0)} article(s); the threshold comes from ${String(data.thresholdSource ?? "the default")}`,
      }),
      el("div", { class: "filter-bar" }, [
        tagInput.node,
        qInput.node,
        statusSelect,
        apply,
        data.sourcesGate === true
          ? el("span", {
              class: "chip",
              title:
                "a LOCAL rule (memory.wiki.requireSources) — the Thredz backend does not apply it",
              text: "## Sources required (local)",
            })
          : null,
        dot(Number(data.stale ?? 0) > 0 ? "warn" : "ok", `${fmtCount(data.stale ?? 0)} stale`),
      ]),
      (Array.isArray(data.articles) ? data.articles : []).length === 0
        ? empty(data, "No wiki articles yet")
        : reflectTable(data, ctx, host, reload, state),
      ...(Array.isArray(filters.available) && filters.available.length > 0
        ? [
            el("p", {
              class: "muted",
              text: `tags in this wiki: ${filters.available.join(", ")}`,
            }),
          ]
        : []),
    ]),
  );
  host.appendChild(editorCard(ctx, host, reload, state, null));
}

function reflectTable(data, ctx, host, reload, state) {
  const rows = (Array.isArray(data.articles) ? data.articles : []).map((row) => {
    const actions = el("div", { class: "cell-actions" }, [
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Edit",
        onClick: () => {
          clear(host);
          host.appendChild(editorCard(ctx, host, reload, state, row));
        },
      }),
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "History",
        onClick: () => void versionsPanel(host, ctx, reload, state, String(row.slug)),
      }),
      el("button", {
        class: "btn btn-ghost",
        type: "button",
        text: "Links",
        onClick: () => void linksPanel(host, ctx, reload, state, String(row.slug)),
      }),
      archiveButton(ctx, host, reload, state, row),
    ]);
    return el("tr", null, [
      el("td", null, [
        el("a", {
          class: "name-link",
          href: hrefHarness(ctx.id, "memory", "wiki", String(row.slug)),
          text: String(row.title ?? row.slug),
        }),
        row.malformed === true
          ? el("span", {
              class: "chip chip-warn",
              title: "no frontmatter — rendered as a document",
              text: "no frontmatter",
            })
          : null,
      ]),
      el("td", { class: "num", text: `v${String(row.version ?? 1)}` }),
      el("td", null, [dot(row.status === "archived" ? "off" : "ok", String(row.status ?? ""))]),
      el("td", null, [
        row.verified === true ? dot("ok", "verified") : dot("unknown", "unverified"),
        el("span", { class: "muted", text: ` ${fmtPct(Number(row.confidence ?? 0))}` }),
      ]),
      el("td", null, [
        row.hasSources === true
          ? el("span", { class: "chip", text: "## Sources" })
          : el("span", { class: "muted", text: "—" }),
      ]),
      el("td", {
        class: row.stale === true ? "chip chip-warn" : "muted",
        text: staleLabel(row) ?? "—",
      }),
      el("td", null, [actions]),
    ]);
  });
  return table(["Article", "Version", "Status", "Signals", "Sources", "Freshness", ""], rows);
}

function archiveButton(ctx, host, reload, state, row) {
  const archived = row.status === "archived";
  const btn = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: archived ? "Unarchive" : "Archive",
    title: archived
      ? "restore this article to the live list"
      : "archiving hides it from the live list — every version stays on disk, and this is reversible",
  });
  btn.addEventListener("click", () => {
    void run(
      btn,
      archived ? "Unarchive" : "Archive",
      () =>
        api.wikiArchive(
          { id: ctx.id, slug: String(row.slug) },
          { archived: !archived, confirm: true },
        ),
      () => void drawReflect(host, ctx, reload, state),
    );
  });
  return btn;
}

/**
 * The editor. Every save carries `expectedVersion`; a stale answer renders
 * the version that moved plus a retry that re-sends against it — the
 * re-read-then-reapply contract, identical for the local and Thredz
 * backends.
 */
function editorCard(ctx, host, reload, state, row) {
  const slugField = field("slug", {
    value: row ? String(row.slug) : "",
    placeholder: "kebab-case-slug",
  });
  const titleField = field("title", { value: row ? String(row.title ?? "") : "" });
  const area = el("textarea", { class: "input", rows: "12", spellcheck: "false" });
  const versionLabel = el("span", { class: "muted" });
  const guard = el("div");
  const status = el("div");
  const expected = { version: row ? Number(row.version ?? 0) : 0 };

  const setVersion = (v) => {
    expected.version = typeof v === "number" ? v : 0;
    versionLabel.textContent =
      expected.version > 0 ? `saving against version ${expected.version}` : "new article";
  };
  setVersion(row ? Number(row.version ?? 0) : 0);

  const save = el("button", { class: "btn btn-primary", type: "button", text: "Save" });

  if (row) {
    // Load the live body to edit, and re-read the CURRENT version rather than
    // trusting the row the queue was painted from — the article may have
    // moved while the operator was reading the list.
    void (async () => {
      let article = null;
      try {
        article = await api.wikiArticle(ctx.id, String(row.slug));
      } catch {
        article = null;
      }
      if (article !== null && typeof article.body === "string") area.value = article.body;
      const versions = await api.wikiVersions({ id: ctx.id, slug: String(row.slug) });
      if (versions.ok && typeof versions.body?.currentVersion === "number") {
        setVersion(versions.body.currentVersion);
      }
      // Served text is MASKED. Saving a masked span back would persist the
      // mask over whatever it hid, which is silent data loss — so this one
      // article is read-only here and says why.
      if (area.value.includes(MASK_MARK)) {
        save.disabled = true;
        clear(guard).appendChild(
          el("div", { class: "gated" }, [
            dot("warn", "read-only here"),
            el("span", {
              class: "muted gated-why",
              text: "this body contains a masked credential-shaped span; saving from the console would persist the mask — edit it with `crewhaus wiki write`",
            }),
          ]),
        );
      }
    })();
  }
  save.addEventListener("click", () => {
    const slug = slugField.input.value.trim();
    if (slug === "") {
      toast("a slug is required");
      return;
    }
    void run(
      save,
      "Save",
      () =>
        api.wikiWrite(
          { id: ctx.id, slug },
          {
            body: area.value,
            title: titleField.input.value.trim(),
            ...(expected.version > 0 ? { expectedVersion: expected.version } : {}),
          },
        ),
      (res) => {
        clear(status);
        if (!res.ok) return;
        const outcome = writeOutcome(res.body);
        if (outcome.kind === "ok") {
          status.appendChild(
            el("p", { class: "muted" }, [
              dot("ok", "saved"),
              el("span", { text: ` ${outcome.message}` }),
            ]),
          );
          void drawReflect(host, ctx, reload, state);
          return;
        }
        status.appendChild(
          el("div", { class: "refusal-item" }, [
            el("div", { class: "refusal-head" }, [
              dot(
                outcome.kind === "stale" ? "warn" : "bad",
                outcome.kind === "stale" ? "version moved" : "refused",
              ),
            ]),
            el("p", { class: "muted", text: outcome.message }),
          ]),
        );
        if (outcome.kind === "stale") {
          const diff = String(res.body?.diff ?? "");
          if (diff !== "") status.appendChild(el("pre", { class: "rawjson", text: diff }));
          const retry = el("button", {
            class: "btn",
            type: "button",
            text: `Retry against version ${String(outcome.retryVersion ?? "?")}`,
          });
          retry.addEventListener("click", () => {
            setVersion(outcome.retryVersion);
            save.click();
          });
          const takeTheirs = el("button", {
            class: "btn btn-ghost",
            type: "button",
            text: "Load what is on disk now",
          });
          takeTheirs.addEventListener("click", () => {
            area.value = outcome.currentBody ?? "";
            setVersion(outcome.retryVersion);
          });
          status.appendChild(el("div", { class: "editor-actions" }, [takeTheirs, retry]));
        }
      },
    );
  });

  const signals = signalsControl(ctx, row, host, reload, state);
  return card("Editor", [
    row
      ? el("div", { class: "crumb-line" }, [
          el("button", {
            class: "btn btn-ghost",
            type: "button",
            text: "← back to the queue",
            onClick: () => void drawReflect(host, ctx, reload, state),
          }),
          el("span", { class: "mono muted", text: String(row.slug) }),
        ])
      : null,
    el("div", { class: "editor-actions" }, [slugField.node, titleField.node, versionLabel]),
    area,
    guard,
    el("div", { class: "editor-actions" }, [
      save,
      el("span", {
        class: "muted gated-why",
        text: "every save carries expectedVersion; the outgoing version is frozen under versions/ before the new one lands",
      }),
    ]),
    status,
    signals,
  ]);
}

/** verified / confidence — metadata only, never a way to rewrite a body. */
function signalsControl(ctx, row, host, reload, state) {
  if (!row) return null;
  const verified = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: row.verified === true ? "Mark unverified" : "Mark verified",
  });
  verified.addEventListener("click", () => {
    void run(
      verified,
      "Signals",
      () =>
        api.wikiSignals(
          { id: ctx.id, slug: String(row.slug) },
          { verified: row.verified !== true },
        ),
      () => void drawReflect(host, ctx, reload, state),
    );
  });
  return el("div", { class: "editor-actions" }, [
    verified,
    el("span", {
      class: "muted gated-why",
      text: "signals are metadata: no version bump, no snapshot, the body untouched",
    }),
  ]);
}

async function versionsPanel(host, ctx, reload, state, slug) {
  clear(host).appendChild(skeleton(4));
  const data = await load(host, () => api.wikiVersions({ id: ctx.id, slug }));
  clear(host);
  if (data === null) return;
  const back = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "← back to the queue",
    onClick: () => void drawReflect(host, ctx, reload, state),
  });
  const detail = el("div");
  const versions = Array.isArray(data.versions) ? data.versions : [];
  host.appendChild(
    card(`History · ${slug}`, [
      el("div", { class: "crumb-line" }, [
        back,
        el("span", { class: "mono muted", text: `current v${String(data.currentVersion ?? "?")}` }),
      ]),
      versions.length === 0
        ? empty(data, "This article has no frozen versions yet")
        : table(
            ["Version", "Author", "When", "Bytes", ""],
            versions.map((v) =>
              el("tr", null, [
                el("td", { class: "num", text: `v${String(v.version)}` }),
                el("td", null, [
                  v.sessionId
                    ? sessionLink(ctx, String(v.sessionId), String(v.author ?? "agent"))
                    : el("span", { text: String(v.author ?? "operator") }),
                ]),
                el("td", {
                  text:
                    typeof v.updatedAt === "string"
                      ? fmtRelativeTime(v.updatedAt, Date.now())
                      : "—",
                }),
                el("td", { class: "num", text: fmtCount(Number(v.bytes ?? 0)) }),
                el("td", null, [
                  el("button", {
                    class: "btn btn-ghost",
                    type: "button",
                    text: "Diff vs live",
                    onClick: () => void showVersion(detail, ctx, slug, String(v.version)),
                  }),
                ]),
              ]),
            ),
          ),
      detail,
    ]),
  );
}

async function showVersion(host, ctx, slug, version) {
  clear(host).appendChild(skeleton(3));
  const data = await load(host, () => api.wikiVersion({ id: ctx.id, slug, version }));
  clear(host);
  if (data === null) return;
  if (data.present !== true) {
    host.appendChild(empty(data, "No such version"));
    return;
  }
  host.appendChild(el("h4", { class: "sub-title", text: `v${version} → live` }));
  host.appendChild(
    el("pre", { class: "rawjson", text: String(data.diff ?? "") || "(no textual difference)" }),
  );
  host.appendChild(
    collapsible(
      [el("span", { class: "muted", text: `the v${version} body` })],
      [mdBlocks(String(data.body ?? ""))],
    ),
  );
}

async function linksPanel(host, ctx, reload, state, slug) {
  clear(host).appendChild(skeleton(4));
  const data = await load(host, () => api.wikiLinks({ id: ctx.id, slug }));
  clear(host);
  if (data === null) return;
  const links = Array.isArray(data.links) ? data.links : [];
  host.appendChild(
    card(`Links · ${slug}`, [
      el("div", { class: "crumb-line" }, [
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: "← back to the queue",
          onClick: () => void drawReflect(host, ctx, reload, state),
        }),
        el("span", {
          class: "muted",
          text: `${String(data.outbound ?? 0)} out · ${String(data.backlinks ?? 0)} in`,
        }),
        data.indexStale === true
          ? el("span", {
              class: "chip",
              title:
                "index.json is a rebuildable cache — this graph was rebuilt from the article bodies",
              text: "rebuilt from disk",
            })
          : null,
      ]),
      links.length === 0
        ? empty(data, "This article neither links out nor is linked to")
        : table(
            ["Direction", "Article", "State"],
            links.map((link) =>
              el("tr", null, [
                el("td", { text: link.direction === "in" ? "backlink" : "outbound" }),
                el("td", null, [
                  el("a", {
                    class: "name-link",
                    href: hrefHarness(ctx.id, "memory", "wiki", String(link.slug)),
                    text: String(link.title ?? link.slug),
                  }),
                ]),
                el("td", null, [
                  link.exists === true ? dot("ok", "written") : dot("warn", "not written yet"),
                ]),
              ]),
            ),
          ),
    ]),
  );
}

// ---------------------------------------------------------------------------
// dream
// ---------------------------------------------------------------------------

async function dreamPanel(host, ctx) {
  clear(host).appendChild(skeleton(5));
  const data = await load(host, () => api.dreamScaffold({ id: ctx.id }));
  clear(host);
  if (data === null) return;
  const tone = dreamTone(data);
  const specs = Array.isArray(data.specs) ? data.specs : [];

  host.appendChild(
    card("Dream", [
      el("div", { class: "filter-bar" }, [
        dot(tone.state, tone.label),
        data.modelPhase === true
          ? el("span", {
              class: "chip",
              text: `model phase, budget ${fmtUsd(Number(data.budgetUsd ?? 0))}`,
            })
          : el("span", { class: "chip", text: "deterministic only" }),
      ]),
      specs.length === 0
        ? empty(data, "This harness has never consolidated")
        : table(
            ["Spec", "Last run", "Outcome", "Next due", ""],
            specs.map((s) =>
              el("tr", null, [
                el("td", { class: "mono", text: String(s.specName ?? "") }),
                el("td", {
                  text:
                    typeof s.lastRunAt === "string"
                      ? fmtRelativeTime(s.lastRunAt, Date.now())
                      : "never",
                }),
                el("td", { text: String(s.lastOutcome ?? "—") }),
                el("td", {
                  text:
                    typeof s.nextDueAt === "string"
                      ? fmtRelativeTime(s.nextDueAt, Date.now())
                      : "—",
                }),
                el("td", null, [
                  s.overdue === true ? dot("warn", "overdue") : dot("ok", "on schedule"),
                ]),
              ]),
            ),
          ),
      el("p", {
        class: "muted",
        text: "Run now lives on the Memory tab's dream card above: it goes through the job queue, which is window-idempotent and run.lock-serialized, so it can never double-fire against the daemon's janitor.",
      }),
    ]),
  );

  host.appendChild(
    card("Nightly cron scaffold", [
      el("p", {
        class: "muted",
        text: `print-only — this is what \`${String(data.verb ?? "crewhaus dream init")}\` would write to ${String(data.workflowPath ?? "")}`,
      }),
      el("div", { class: "editor-actions" }, [
        el("span", { class: "mono", text: `cron: ${String(data.cron ?? "")}` }),
        copyBtn(String(data.workflow ?? ""), "copy the workflow"),
      ]),
      el("pre", { class: "rawjson", text: String(data.workflow ?? "") }),
    ]),
  );
}

// ---------------------------------------------------------------------------
// watchme
// ---------------------------------------------------------------------------

async function watchmePanel(host, ctx, reload) {
  clear(host).appendChild(skeleton(8));
  const [analytics, intents, reports, synthesized] = await Promise.all([
    load(host, () => api.watchmeAnalytics({ id: ctx.id })),
    load(host, () => api.watchmeIntents({ id: ctx.id })),
    load(host, () => api.watchmeReports({ id: ctx.id })),
    load(host, () => api.watchmeSynthesized({ id: ctx.id })),
  ]);
  clear(host);
  if (analytics === null) return;

  const cost = costSummary(analytics);
  const models = Array.isArray(analytics.models) ? analytics.models : [];
  const tools = Array.isArray(analytics.tools) ? analytics.tools : [];
  const judgments =
    analytics.judgments && typeof analytics.judgments === "object" ? analytics.judgments : {};
  const observed =
    analytics.observedFeedback && typeof analytics.observedFeedback === "object"
      ? analytics.observedFeedback
      : {};

  host.appendChild(
    card(
      "Watchme",
      [
        el("div", { class: "filter-bar" }, [
          analytics.watching === true ? dot("ok", "watching") : dot("off", "not watching"),
          el("span", { class: "muted", text: `${fmtCount(analytics.sessions ?? 0)} sessions` }),
          el("span", {
            class: "muted",
            text: `${fmtCount(analytics.turns?.total ?? 0)} turns`,
          }),
          analytics.truncated === true
            ? el("span", { class: "chip chip-warn", text: "capped — figures are floors" })
            : null,
          toggleControl(ctx, analytics, host, reload),
        ]),
        analytics.present !== true ? empty(analytics, "Watchme has never run here") : null,
        models.length === 0
          ? null
          : table(
              ["Model", "Provider", "Turns", "In", "Out", "Cost"],
              models.map((m) =>
                el("tr", null, [
                  el("td", { class: "mono", text: String(m.wire ?? "") }),
                  el("td", { text: String(m.provider ?? "") }),
                  el("td", { class: "num", text: fmtCount(Number(m.turns ?? 0)) }),
                  el("td", { class: "num", text: fmtCount(Number(m.tokensIn ?? 0)) }),
                  el("td", { class: "num", text: fmtCount(Number(m.tokensOut ?? 0)) }),
                  el("td", {
                    class: "num",
                    text: fmtUsd(usdFromMicros(Number(m.costUsdMicros ?? 0))),
                  }),
                ]),
              ),
            ),
        kv("priced spend", fmtUsd(usdFromMicros(cost.priced))),
        cost.unpricedModels === 0
          ? null
          : el("div", { class: "kv" }, [
              el("span", { class: "kv-k", text: "unpriced" }),
              el("span", { class: "kv-v" }, [
                dot(
                  "warn",
                  `${cost.unpricedModels} model(s), ${fmtCount(cost.unpricedTurns)} turns — cost UNKNOWN`,
                ),
              ]),
            ]),
        cost.note === null ? null : el("p", { class: "muted", text: cost.note }),
      ],
      asOf(typeof analytics.asOf === "string" ? analytics.asOf : null),
    ),
  );

  if (tools.length > 0) {
    host.appendChild(
      card(
        "Tool error rates",
        table(
          ["Tool", "Calls", "Errors", "Rate"],
          tools.map((t) =>
            el("tr", null, [
              el("td", { class: "mono", text: String(t.name ?? "") }),
              el("td", { class: "num", text: fmtCount(Number(t.calls ?? 0)) }),
              el("td", { class: "num", text: fmtCount(Number(t.errors ?? 0)) }),
              el("td", null, [
                typeof t.errorRate === "number"
                  ? dot(t.errorRate > 0.1 ? "warn" : "ok", fmtPct(t.errorRate))
                  : el("span", { class: "muted", text: "—" }),
              ]),
            ]),
          ),
        ),
      ),
    );
  }

  // Two surfaces, deliberately apart: the judge's verdicts are a machine
  // signal and the human channel is not, and one blended number would hide
  // which of the two an operator is actually looking at.
  host.appendChild(
    card("Judge verdicts", [
      el("p", { class: "muted", text: String(judgments.source ?? "watchme/judgments.jsonl") }),
      kv("judged turns", fmtCount(Number(judgments.count ?? 0))),
      kv(
        "mean judge score",
        typeof judgments.meanScore === "number" ? judgments.meanScore.toFixed(2) : "—",
      ),
      kv(
        "judge models",
        (Array.isArray(judgments.judgeModels) ? judgments.judgeModels : []).join(", ") || "—",
      ),
    ]),
  );
  host.appendChild(
    card("Observed human feedback", [
      el("p", {
        class: "muted",
        text: `${String(observed.source ?? "watchme observations")} — a separate store from the judge above, never summed with it`,
      }),
      el("div", { class: "filter-bar" }, [
        dot("ok", `${fmtCount(Number(observed.up ?? 0))} up`),
        dot("warn", `${fmtCount(Number(observed.down ?? 0))} down`),
      ]),
    ]),
  );

  const clusters = Array.isArray(intents?.intents) ? intents.intents : [];
  host.appendChild(
    card(
      "Intent clusters",
      clusters.length === 0
        ? empty(intents, "No intent clusters yet")
        : table(
            ["Cluster", "Count", "Last seen", "Sessions"],
            clusters.map((c) =>
              el("tr", null, [
                el("td", { text: String(c.cluster ?? "") }),
                el("td", { class: "num", text: fmtCount(Number(c.count ?? 0)) }),
                el("td", {
                  text:
                    typeof c.lastSeen === "string" ? fmtRelativeTime(c.lastSeen, Date.now()) : "—",
                }),
                el(
                  "td",
                  null,
                  (Array.isArray(c.sessions) ? c.sessions : [])
                    .slice(0, 5)
                    .map((s) => sessionLink(ctx, String(s), String(s).slice(-6))),
                ),
              ]),
            ),
          ),
    ),
  );

  host.appendChild(reportsCard(reports, ctx));
  host.appendChild(synthesizedCard(synthesized, ctx, host, reload));
  host.appendChild(publishCard(ctx));
}

function toggleControl(ctx, analytics, host, reload) {
  const watching = analytics.watching === true;
  const btn = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: watching ? "Turn watching off" : "Turn watching on",
    title: "watchme: is a human-owned spec block — this is a spec edit, not a flag file",
  });
  const nameField = field("type the spec name to apply", { placeholder: "spec name" });
  const wrap = el("div", { class: "gated" }, [btn, nameField.node]);
  btn.addEventListener("click", () => {
    void run(
      btn,
      "Toggle",
      () =>
        api.watchmeToggle(
          { id: ctx.id },
          {
            watching: !watching,
            confirm: true,
            ...(nameField.input.value.trim() !== ""
              ? { confirmName: nameField.input.value.trim() }
              : {}),
          },
        ),
      (res) => {
        if (res.ok && res.body?.applied === true) void watchmePanel(host, ctx, reload);
        else if (res.ok && res.body?.code === "needs_typed_confirm") {
          toast(
            String(res.body.note ?? "type the spec name to apply this human-owned edit"),
            "info",
          );
        }
      },
    );
  });
  return wrap;
}

function reportsCard(reports, ctx) {
  const rows = Array.isArray(reports?.reports) ? reports.reports : [];
  const detail = el("div");
  if (rows.length === 0) return card("Reports", empty(reports, "No watchme report yet"));
  return card("Reports", [
    table(
      ["Report", "When", "Summary", ""],
      rows.map((r) =>
        el("tr", null, [
          el("td", { class: "mono", text: String(r.stamp ?? "") }),
          el("td", { text: typeof r.at === "string" ? fmtRelativeTime(r.at, Date.now()) : "—" }),
          el("td", { text: String(r.summary ?? "—") }),
          el("td", null, [
            el("button", {
              class: "btn btn-ghost",
              type: "button",
              text: "Open",
              onClick: () => void showReport(detail, ctx, String(r.stamp)),
            }),
          ]),
        ]),
      ),
    ),
    detail,
  ]);
}

async function showReport(host, ctx, stamp) {
  clear(host).appendChild(skeleton(4));
  const data = await load(host, () => api.watchmeReport({ id: ctx.id, stamp }));
  clear(host);
  if (data === null) return;
  if (data.present !== true) {
    host.appendChild(empty(data, "No such report"));
    return;
  }
  host.appendChild(el("h4", { class: "sub-title", text: stamp }));
  host.appendChild(mdBlocks(String(data.body ?? "")));
  if (data.truncated === true) {
    host.appendChild(el("p", { class: "muted", text: "long report — the first part only" }));
  }
}

/** Synthesize review: a proposal is rendered, never applied by rendering it. */
function synthesizedCard(synthesized, ctx, host, reload) {
  const proposals = Array.isArray(synthesized?.proposals) ? synthesized.proposals : [];
  if (proposals.length === 0) {
    return card("Synthesized proposals", empty(synthesized, "Nothing has been synthesized yet"));
  }
  return card("Synthesized proposals", [
    el("p", {
      class: "muted",
      text: String(synthesized.note ?? "advisory only — reading a proposal is not applying it"),
    }),
    ...proposals.map((p) => proposalBlock(p, ctx, host, reload)),
  ]);
}

function proposalBlock(proposal, ctx, host, reload) {
  const edits = Array.isArray(proposal.edits) ? proposal.edits : [];
  const picked = new Set();
  const nameField = field("type the spec name for human-owned edits", { placeholder: "spec name" });
  const apply = el("button", { class: "btn btn-primary", type: "button", text: "Apply selected" });
  apply.addEventListener("click", () => {
    void run(
      apply,
      "Apply",
      () =>
        api.watchmeApply(
          { id: ctx.id, stamp: String(proposal.stamp) },
          {
            edits: [...picked],
            confirm: true,
            ...(nameField.input.value.trim() !== ""
              ? { confirmName: nameField.input.value.trim() }
              : {}),
          },
        ),
      (res) => {
        if (res.ok && res.body?.applied === true) void watchmePanel(host, ctx, reload);
      },
    );
  });

  const rows = edits.map((edit) => {
    const box = el("input", { type: "checkbox" });
    box.addEventListener("change", () => {
      if (box.checked) picked.add(String(edit.path));
      else picked.delete(String(edit.path));
    });
    return el("tr", null, [
      el("td", null, [box]),
      el("td", { class: "mono", text: String(edit.path ?? "") }),
      el("td", null, [
        edit.tier === "auto-tunable"
          ? dot("ok", "auto-tunable")
          : dot("warn", "human-owned — needs the typed confirmation"),
      ]),
      el("td", { class: "mono", text: String(edit.before ?? "—") }),
      el("td", { class: "mono", text: String(edit.after ?? "—") }),
      el("td", { class: "muted", text: String(edit.rationale ?? "") }),
    ]);
  });

  return collapsible(
    [
      el("span", { class: "mono", text: String(proposal.stamp ?? "") }),
      el("span", {
        class: "muted",
        text: ` ${String(proposal.autoTunable ?? 0)} auto-tunable · ${String(proposal.humanOwned ?? 0)} human-owned`,
      }),
    ],
    [
      typeof proposal.error === "string" && proposal.error !== ""
        ? el("p", { class: "muted", text: proposal.error })
        : null,
      edits.length === 0
        ? el("p", { class: "muted", text: "this proposal changes nothing in the live spec" })
        : table(["", "Path", "Tier", "Now", "Proposed", "Why"], rows),
      el("div", { class: "editor-actions" }, [nameField.node, apply]),
      collapsible(
        [el("span", { class: "muted", text: "the proposed spec" })],
        [el("pre", { class: "rawjson", text: String(proposal.yaml ?? "") })],
      ),
    ],
  );
}

function publishCard(ctx) {
  const out = el("div");
  const dry = el("button", { class: "btn", type: "button", text: "Preview publish" });
  const nameField = field("type the spec name to publish", { placeholder: "spec name" });
  const real = el("button", { class: "btn btn-danger", type: "button", text: "Publish" });
  dry.addEventListener("click", () => {
    void run(
      dry,
      "Preview",
      () => api.watchmePublish({ id: ctx.id }, { dryRun: true }),
      (res) => {
        clear(out);
        if (!res.ok) return;
        const targets = Array.isArray(res.body?.targets) ? res.body.targets : [];
        out.appendChild(
          table(
            ["Article", "Would"],
            targets.map((t) =>
              el("tr", null, [
                el("td", { class: "mono", text: String(t.slug ?? "") }),
                el("td", null, [
                  dot(t.action === "create" ? "ok" : "warn", String(t.action ?? "")),
                ]),
              ]),
            ),
          ),
        );
        out.appendChild(el("p", { class: "muted", text: String(res.body?.note ?? "") }));
      },
    );
  });
  real.addEventListener("click", () => {
    void run(real, "Publish", () =>
      api.watchmePublish(
        { id: ctx.id },
        { dryRun: false, confirmName: nameField.input.value.trim() },
      ),
    );
  });
  return card("Publish findings to the wiki", [
    el("p", {
      class: "muted",
      text: "publishing writes articles into the memory fabric — the dry run is what makes it a review instead of a surprise",
    }),
    el("div", { class: "editor-actions" }, [dry, nameField.node, real]),
    out,
  ]);
}

// ---------------------------------------------------------------------------
// learning + knowledge
// ---------------------------------------------------------------------------

async function learningPanel(host, ctx) {
  clear(host).appendChild(skeleton(5));
  const data = await load(host, () => api.learning({ id: ctx.id }));
  clear(host);
  if (data === null) return;
  if (data.declared !== true) {
    host.appendChild(card("Learning", empty(data, "This spec declares no learning: block")));
    return;
  }
  const curriculum =
    data.curriculum && typeof data.curriculum === "object" ? data.curriculum : null;
  const exam = data.exam && typeof data.exam === "object" ? data.exam : null;
  const study = data.study && typeof data.study === "object" ? data.study : {};
  const gaps = data.gaps && typeof data.gaps === "object" ? data.gaps : {};

  host.appendChild(
    card("Learning", [
      el("div", { class: "filter-bar" }, [
        data.enabled === true ? dot("ok", "enabled") : dot("off", "declared but off"),
        study.onHeartbeat === true
          ? dot("ok", "studies on heartbeat")
          : dot("off", "no heartbeat study"),
        study.onDream === true ? dot("ok", "studies on dream") : dot("off", "no dream study"),
      ]),
      kv("domain", String(data.domain ?? "—")),
      (Array.isArray(data.sources) ? data.sources : []).length === 0
        ? null
        : el("div", { class: "kv" }, [
            el("span", { class: "kv-k", text: "source allowlist" }),
            el(
              "span",
              { class: "kv-v" },
              data.sources.map((s) => el("span", { class: "chip", text: String(s) })),
            ),
          ]),
    ]),
  );

  if (curriculum !== null) {
    const rungs = Array.isArray(curriculum.rungs) ? curriculum.rungs : [];
    host.appendChild(
      card("Curriculum", [
        el("p", {
          class: "muted",
          text: `${String(curriculum.done ?? 0)} / ${String(curriculum.total ?? 0)} rungs — ${String(curriculum.path ?? "")}`,
        }),
        curriculum.present !== true
          ? el("p", { class: "muted", text: String(curriculum.note ?? "") })
          : el(
              "ul",
              { class: "check-list" },
              rungs.map((r) =>
                el("li", null, [
                  r.done === true ? dot("ok", "done") : dot("off", "open"),
                  el("span", { text: ` ${String(r.text ?? "")}` }),
                ]),
              ),
            ),
      ]),
    );
  }

  if (exam !== null) {
    const last = exam.lastRun && typeof exam.lastRun === "object" ? exam.lastRun : null;
    host.appendChild(
      card("Exam", [
        kv("dataset", String(exam.dataset ?? "—")),
        kv("graders", String(exam.graders ?? "—")),
        last === null
          ? emptyState(
              "The exam has never run",
              `crewhaus eval crewhaus.yaml --dataset ${String(exam.dataset ?? "")}`,
            )
          : el("div", null, [
              kv("pass rate", fmtPct(Number(last.passRate ?? 0))),
              kv("samples", fmtCount(Number(last.sampleCount ?? 0))),
              kv("when", typeof last.ts === "string" ? fmtRelativeTime(last.ts, Date.now()) : "—"),
            ]),
        el("p", { class: "muted", text: String(exam.note ?? "") }),
      ]),
    );
  }

  const goals = Array.isArray(gaps.goals) ? gaps.goals : [];
  const articles = Array.isArray(gaps.articles) ? gaps.articles : [];
  host.appendChild(
    card("Knowledge gaps (the study queue)", [
      goals.length + articles.length === 0
        ? emptyState("No open gaps", "crewhaus run (the agent logs gaps as it studies)")
        : el("ul", { class: "check-list" }, [
            ...goals.map((g) =>
              el("li", null, [
                dot("warn", "goal"),
                el("span", { text: ` ${String(g.title ?? "")}` }),
              ]),
            ),
            ...articles.map((a) =>
              el("li", null, [
                dot("warn", "article"),
                el("a", {
                  class: "name-link",
                  href: hrefHarness(ctx.id, "memory", "wiki", String(a.slug)),
                  text: ` ${String(a.title ?? a.slug)}`,
                }),
              ]),
            ),
          ]),
      el("p", {
        class: "muted",
        text: `hosted twin: Thredz tasks tagged \`${String(data.thredzTag ?? "knowledge-gap")}\` — the same queue, on the Thredz tab`,
      }),
    ]),
  );
}

async function knowledgePanel(host, ctx, reload) {
  clear(host).appendChild(skeleton(5));
  const data = await load(host, () => api.knowledge({ id: ctx.id }));
  clear(host);
  if (data === null) return;
  const counts = data.counts && typeof data.counts === "object" ? data.counts : {};
  const manifest = Array.isArray(data.manifest) ? data.manifest : [];
  const out = el("div");

  const pull = el("button", { class: "btn", type: "button", text: "Preview pull" });
  pull.addEventListener("click", () => {
    void run(
      pull,
      "Pull",
      () => api.knowledgeSync({ id: ctx.id }, { direction: "pull", dryRun: true }),
      (res) => {
        clear(out);
        if (res.ok)
          out.appendChild(el("p", { class: "muted", text: String(res.body?.note ?? "") }));
      },
    );
  });
  const pushPreview = el("button", { class: "btn", type: "button", text: "Preview push" });
  const nameField = field("type the spec name to push", { placeholder: "spec name" });
  const push = el("button", { class: "btn btn-danger", type: "button", text: "Push" });
  pushPreview.addEventListener("click", () => {
    void run(
      pushPreview,
      "Preview push",
      () => api.knowledgeSync({ id: ctx.id }, { direction: "push", dryRun: true }),
      (res) => {
        clear(out);
        if (!res.ok) return;
        const preview =
          res.body?.preview && typeof res.body.preview === "object" ? res.body.preview : {};
        const redacted = Array.isArray(preview.wouldRedact) ? preview.wouldRedact : [];
        out.appendChild(
          el("p", {
            class: "muted",
            text: `${String(preview.candidates ?? 0)} fact(s) would be considered`,
          }),
        );
        out.appendChild(
          redacted.length === 0
            ? el("p", { class: "muted" }, [dot("ok", "nothing looks credential-shaped")])
            : el("div", null, [
                el("p", { class: "muted" }, [
                  dot("warn", `${redacted.length} fact(s) carry credential-shaped text`),
                ]),
                el(
                  "ul",
                  { class: "fact-list" },
                  redacted.map((r) =>
                    el("li", { class: "fact" }, [
                      el("div", { text: String(r.text ?? "") }),
                      el("div", { class: "fact-meta" }, [
                        el("span", { class: "mono muted", text: String(r.id ?? "") }),
                      ]),
                    ]),
                  ),
                ),
              ]),
        );
        out.appendChild(el("p", { class: "muted", text: String(res.body?.note ?? "") }));
      },
    );
  });
  push.addEventListener("click", () => {
    void run(
      push,
      "Push",
      () =>
        api.knowledgeSync(
          { id: ctx.id },
          { direction: "push", dryRun: false, confirmName: nameField.input.value.trim() },
        ),
      () => void knowledgePanel(host, ctx, reload),
    );
  });

  host.appendChild(
    card("Knowledge sync", [
      el("div", { class: "filter-bar" }, [
        data.share === true
          ? dot("ok", "opted in to sharing")
          : dot("off", "not opted in — a fleet sync skips this harness"),
        data.present === true
          ? dot("ok", "shared store present")
          : dot("unknown", "no shared store yet"),
      ]),
      kv("shared store", el("span", { class: "mono", text: String(data.sharedDir ?? "—") })),
      kv("resolved from", String(data.sharedDirSource ?? "—")),
      kv(
        "shared artifacts",
        `${fmtCount(Number(counts.memories ?? 0))} memories · ${fmtCount(Number(counts.graders ?? 0))} graders · ${fmtCount(Number(counts.prompts ?? 0))} prompts`,
      ),
      kv("pushed by this harness", fmtCount(Number(data.pushedByThisHarness ?? 0))),
      el("div", { class: "editor-actions" }, [pull, pushPreview, nameField.node, push]),
      el("p", {
        class: "muted",
        text: "push is the one direction that can leak: it redacts on the way out and drops anything still credential-shaped",
      }),
      out,
    ]),
  );

  if (manifest.length > 0) {
    host.appendChild(
      card(
        "Provenance manifest",
        collapsible(
          [el("span", { class: "muted", text: `${manifest.length} shared artifact record(s)` })],
          [jsonPre(manifest)],
        ),
      ),
    );
  }
}
