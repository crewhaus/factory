/**
 * Feedback — the growth loops: the ratings browser with the distill
 * watermark, the few-shot pool, FAQ distill, lessons, the advice feed, and
 * channel reaction state. Plus the fleet-wide rollup screen, which answers
 * "which harnesses have enough feedback to distill".
 *
 * The review QUEUE and its adjudication are the M2 screen (`views/review.js`)
 * and stay there; this is what the ratings turn INTO.
 *
 * Two things this screen refuses to soften:
 *   - the watermark travels WITH the unprocessed count. "12 new ratings"
 *     without the timestamp it counts from is a guess, and the screen would
 *     be inviting a distill run on a number it made up.
 *   - the advice feed is ADVISORY. Rendering a proposed SpecPatch is not
 *     applying it — apply is a separate gesture that goes back through the
 *     spec write path, and a human-owned path routes to `crewhaus propose`.
 *
 * Every node is built with el() — markup strings are banned app-wide, so a
 * user's own rating comment can never inject into this page.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, mdBlocks, skeleton, toast } from "../dom.js";
import { fmtCount, fmtPct, fmtRelativeTime } from "../util.js";

/** The per-harness Feedback tab. */
export async function renderFeedback(root, ctx) {
  clear(root).appendChild(skeleton(4));
  const [ratings, fewshot, faq, lessons, advice, reactions] = await Promise.all(
    [api.feedback, api.fewshot, api.faq, api.lessons, api.advice, api.reactions].map((fn) =>
      fn({ id: ctx.id }).catch((err) => ({ ok: false, status: 0, body: { error: String(err) } })),
    ),
  );
  clear(root);
  const reload = () => renderFeedback(root, ctx);
  root.appendChild(ratingsCard(ctx, ratings, reload));
  root.appendChild(fewshotCard(ctx, fewshot, reload));
  root.appendChild(faqCard(ctx, faq, reload));
  root.appendChild(lessonsCard(ctx, lessons, reload));
  root.appendChild(adviceCard(ctx, advice, reload));
  root.appendChild(reactionsCard(reactions));
}

/** The fleet-wide rollup (`#/feedback`). */
export async function renderFeedbackBoard(root) {
  clear(root).appendChild(skeleton(4));
  const res = await api
    .feedbackFleet({})
    .catch((err) => ({ ok: false, status: 0, body: { error: String(err) } }));
  clear(root);
  root.appendChild(
    panel("Fleet feedback", res, (card, data) => {
      const ready = new Set(data.distillReady ?? []);
      card.appendChild(
        table(
          ["Harness", "Ratings", "Balance", "Unprocessed", "Watermark", "Last rating"],
          (data.harnesses ?? []).map((row) =>
            el("tr", null, [
              el("td", { class: "mono", text: String(row.specName) }),
              el("td", { class: "num", text: fmtCount(row.total) }),
              el("td", null, [
                row.total > 0
                  ? dot(
                      row.up >= row.down ? "ok" : "warn",
                      `${fmtCount(row.up)}↑ ${fmtCount(row.down)}↓`,
                    )
                  : dot("unknown", "none"),
              ]),
              el("td", null, [
                ready.has(row.id)
                  ? dot("warn", `${fmtCount(row.unprocessed)} — distill-ready`)
                  : el("span", { class: "num", text: fmtCount(row.unprocessed) }),
              ]),
              el("td", { text: fmtRelativeTime(row.watermarkTs, Date.now()) }),
              el("td", { text: fmtRelativeTime(row.lastRatingTs, Date.now()) }),
            ]),
          ),
        ),
      );
      card.appendChild(el("p", { class: "muted", text: String(data.scope ?? "") }));
    }),
  );
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

function payload(res) {
  return res && typeof res === "object" && res.body && typeof res.body === "object" ? res.body : {};
}

function panel(title, res, draw) {
  const data = payload(res);
  const card = el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [el("span", { text: title })]),
  ]);
  if (res && res.ok === false && data.present === undefined) {
    card.appendChild(el("p", { class: "muted", text: `unavailable (HTTP ${String(res.status)})` }));
    return card;
  }
  if (data.present === false) {
    card.appendChild(emptyState(String(data.note ?? "Nothing yet"), data.verb ?? null));
    return card;
  }
  if (typeof data.note === "string" && data.note !== "") {
    card.appendChild(el("p", { class: "muted", text: data.note }));
  }
  draw(card, data);
  return card;
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

function stat(label, value) {
  return el("div", { class: "mini" }, [
    el("div", { class: "mini-num", text: value }),
    el("div", { class: "mini-label", text: label }),
  ]);
}

async function call(fn, params, body) {
  return await fn(params, body).catch((err) => ({
    ok: false,
    status: 0,
    body: { error: String(err) },
  }));
}

function refusalText(res) {
  const raw = typeof payload(res).error === "string" ? payload(res).error : "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.error === "string") {
      return `${parsed.error}${parsed.route ? ` — use ${parsed.route}` : ""}`;
    }
  } catch {
    // not a structured refusal — fall through to the raw message
  }
  return raw || `HTTP ${String(res.status)}`;
}

async function fire(fn, params, body, okMessage, reload) {
  const res = await call(fn, params, body);
  if (!res.ok) {
    toast(refusalText(res), "error");
    return res;
  }
  toast(okMessage, "info");
  if (reload) reload();
  return res;
}

// ---------------------------------------------------------------------------
// ratings + distill
// ---------------------------------------------------------------------------

function ratingsCard(ctx, res, reload) {
  const card = panel("Ratings", res, (node, data) => {
    const watermark = data.watermark ?? {};
    const balance = data.balance ?? {};
    node.appendChild(
      el("div", { class: "mini-row" }, [
        stat("ratings", fmtCount(balance.total)),
        stat(
          "balance",
          balance.total ? `${fmtCount(balance.up)}↑ ${fmtCount(balance.down)}↓` : "—",
        ),
        stat("unprocessed", fmtCount(watermark.unprocessed)),
      ]),
    );
    // The watermark IS the truth about what distill has consumed. Without it
    // the unprocessed count above would be an assumption, so say which.
    node.appendChild(
      el("p", null, [
        watermark.present
          ? dot(
              "ok",
              `watermark ${fmtRelativeTime(watermark.lastProcessedTs, Date.now())} · ${fmtCount(
                watermark.processedCount,
              )} folded`,
            )
          : dot("warn", "no distill watermark — every rating counts as unprocessed"),
      ]),
    );
    node.appendChild(
      table(
        ["When", "Session · turn", "Rating", "Comment", "Source", ""],
        (data.items ?? []).map((item) =>
          el("tr", null, [
            el("td", { text: fmtRelativeTime(item.ts, Date.now()) }),
            el("td", {
              class: "mono",
              text: `${String(item.sessionId)} · ${String(item.turnNumber)}`,
            }),
            el("td", null, [
              typeof item.score === "number"
                ? dot(item.score > 0.5 ? "ok" : "bad", fmtPct(item.score))
                : dot("unknown", "comment"),
            ]),
            el("td", { class: "muted", text: String(item.comment || item.correction || "") }),
            el("td", { class: "muted", text: String(item.source) }),
            el("td", { class: "cell-caps" }, [
              item.adjudication === true
                ? el("span", { class: "chip chip-group", text: "adjudicated" })
                : null,
              item.unprocessed === true ? el("span", { class: "chip", text: "new" }) : null,
            ]),
          ]),
        ),
      ),
    );
    if (Array.isArray(data.sinks) && data.sinks.length > 0) {
      node.appendChild(el("p", { class: "muted mono", text: data.sinks.join(" · ") }));
    }
  });

  const judge = el("input", { type: "checkbox", name: "judge" });
  const register = el("input", { type: "checkbox", name: "register" });
  const go = el("button", { class: "btn btn-primary", type: "button", text: "Distill now" });
  go.addEventListener("click", async () => {
    go.disabled = true;
    await fire(
      api.distillRun,
      { id: ctx.id },
      { judge: judge.checked, register: register.checked },
      register.checked ? "Distill queued — result will be registered" : "Distill queued",
      reload,
    );
    go.disabled = false;
  });
  card.appendChild(
    el("div", { class: "editor-actions" }, [
      el("label", { class: "check" }, [judge, el("span", { text: " use the judge" })]),
      el("label", { class: "check" }, [
        register,
        el("span", { text: " promote into the dataset registry (--register)" }),
      ]),
      go,
    ]),
  );
  card.appendChild(
    el("p", {
      class: "muted",
      text: "This runs the distill verb. It does not enable the spec's autoDistill, which the shipped runtime honours only from the CLI.",
    }),
  );
  return card;
}

// ---------------------------------------------------------------------------
// the growers
// ---------------------------------------------------------------------------

function fewshotCard(ctx, res, reload) {
  const card = panel("Few-shot pool", res, (node, data) => {
    node.appendChild(
      table(
        ["Input", "Golden answer", "Score", "Source", "Pool"],
        (data.entries ?? []).map((entry) =>
          el("tr", null, [
            el("td", { text: String(entry.input) }),
            el("td", { class: "muted", text: String(entry.output) }),
            el("td", {
              class: "num",
              text: typeof entry.score === "number" ? fmtPct(entry.score) : "—",
            }),
            el("td", { class: "muted", text: String(entry.source ?? "") }),
            el("td", { class: "cell-caps" }, [
              entry.inUse === true
                ? el("span", {
                    class: "chip chip-group",
                    title: "injected by this spec",
                    text: "in use",
                  })
                : el("span", { class: "chip", text: String(entry.file) }),
            ]),
          ]),
        ),
      ),
    );
  });
  const harvest = el("button", { class: "btn btn-ghost", type: "button", text: "Preview harvest" });
  const holder = el("div");
  harvest.addEventListener("click", async () => {
    harvest.disabled = true;
    const res2 = await call(api.fewshotHarvest, { id: ctx.id }, {});
    harvest.disabled = false;
    clear(holder);
    if (!res2.ok) {
      toast(refusalText(res2), "error");
      return;
    }
    const data = payload(res2);
    holder.appendChild(el("p", { class: "gated-why", text: String(data.note ?? "") }));
    holder.appendChild(el("p", { class: "muted mono", text: (data.writes ?? []).join(" · ") }));
    const run = el("button", { class: "btn btn-danger", type: "button", text: "Harvest now" });
    run.addEventListener("click", async () => {
      run.disabled = true;
      await fire(api.fewshotHarvest, { id: ctx.id }, { confirm: true }, "Harvest queued", reload);
      run.disabled = false;
    });
    holder.appendChild(el("div", { class: "editor-actions" }, [run]));
  });
  card.appendChild(el("div", { class: "editor-actions" }, [harvest]));
  card.appendChild(holder);
  return card;
}

function faqCard(ctx, res, reload) {
  const card = panel("Auto-discovered FAQ skill", res, (node, data) => {
    node.appendChild(el("p", { class: "muted mono", text: String(data.path ?? "") }));
    // Rendered, not summarized: a generated skill the operator cannot read is
    // a behaviour change nobody approved.
    node.appendChild(mdBlocks(String(data.skill ?? "")));
  });
  const distill = el("button", { class: "btn btn-ghost", type: "button", text: "Distill FAQ" });
  distill.addEventListener("click", async () => {
    distill.disabled = true;
    await fire(api.faqDistill, { id: ctx.id }, {}, "FAQ distill queued", reload);
    distill.disabled = false;
  });
  card.appendChild(el("div", { class: "editor-actions" }, [distill]));
  return card;
}

function lessonsCard(ctx, res, reload) {
  const card = panel("Lessons + preferences", res, (node, data) => {
    if (data.lessons) {
      node.appendChild(
        collapsible(
          [
            el("span", { text: "LESSONS.md" }),
            el("span", {
              class: "muted",
              text: ` updated ${fmtRelativeTime(data.lessonsUpdatedAt, Date.now())}`,
            }),
          ],
          [mdBlocks(String(data.lessons))],
          true,
        ),
      );
    }
    for (const pref of data.preferences ?? []) {
      node.appendChild(
        collapsible(
          [el("span", { class: "mono", text: `preferences/${String(pref.user)}` })],
          [mdBlocks(String(pref.body))],
          false,
        ),
      );
    }
  });
  const holder = el("div");
  const update = el("button", { class: "btn btn-ghost", type: "button", text: "Preview update" });
  update.addEventListener("click", async () => {
    update.disabled = true;
    const res2 = await call(api.lessonsUpdate, { id: ctx.id }, {});
    update.disabled = false;
    clear(holder);
    if (!res2.ok) {
      toast(refusalText(res2), "error");
      return;
    }
    holder.appendChild(el("p", { class: "gated-why", text: String(payload(res2).note ?? "") }));
    const run = el("button", { class: "btn btn-danger", type: "button", text: "Update lessons" });
    run.addEventListener("click", async () => {
      run.disabled = true;
      await fire(
        api.lessonsUpdate,
        { id: ctx.id },
        { confirm: true },
        "Lessons update queued",
        reload,
      );
      run.disabled = false;
    });
    holder.appendChild(el("div", { class: "editor-actions" }, [run]));
  });
  card.appendChild(el("div", { class: "editor-actions" }, [update]));
  card.appendChild(holder);
  return card;
}

// ---------------------------------------------------------------------------
// the advisory feed
// ---------------------------------------------------------------------------

function adviceCard(ctx, res, reload) {
  const card = panel("Advice", res, (node, data) => {
    node.appendChild(
      el("p", {
        class: "muted",
        text: "Advisory only. Applying an auto-tunable proposal writes the spec through the same restriction the optimizer runs under; a human-owned path is refused and routed to crewhaus propose.",
      }),
    );
    for (const proposal of data.proposals ?? []) {
      node.appendChild(proposalRow(ctx, proposal, reload));
    }
  });
  const mine = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Mine sessions for advice",
  });
  mine.addEventListener("click", async () => {
    mine.disabled = true;
    await fire(api.adviceRun, { id: ctx.id }, {}, "Advise queued (proposals only)", reload);
    mine.disabled = false;
  });
  card.appendChild(el("div", { class: "editor-actions" }, [mine]));
  return card;
}

function proposalRow(ctx, proposal, reload) {
  const auto = proposal.tier === "auto-tunable";
  const holder = el("div");
  const previewBtn = el("button", { class: "btn btn-ghost", type: "button", text: "Preview diff" });
  previewBtn.addEventListener("click", async () => {
    previewBtn.disabled = true;
    const res = await call(
      api.adviceApply,
      { id: ctx.id, adviceId: String(proposal.adviceId) },
      {},
    );
    previewBtn.disabled = false;
    clear(holder);
    if (!res.ok) {
      // A human-owned refusal is a FIRST-CLASS state: show the diff it would
      // have made and name the route that can carry it.
      const raw = typeof payload(res).error === "string" ? payload(res).error : "";
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === "object") {
        holder.appendChild(el("p", { class: "gated-why", text: String(parsed.error) }));
        holder.appendChild(diffList(parsed.diff ?? []));
        holder.appendChild(
          el("p", { class: "muted" }, [
            el("span", { text: "This path is human-owned — route it through " }),
            el("code", { text: String(parsed.route ?? "crewhaus propose") }),
          ]),
        );
        return;
      }
      toast(refusalText(res), "error");
      return;
    }
    const data = payload(res);
    if (data.present === false) {
      holder.appendChild(emptyState(String(data.note), data.verb ?? null));
      return;
    }
    holder.appendChild(diffList(data.diff ?? []));
    const apply = el("button", {
      class: "btn btn-danger",
      type: "button",
      text: "Apply to the spec",
    });
    apply.addEventListener("click", async () => {
      apply.disabled = true;
      await fire(
        api.adviceApply,
        { id: ctx.id, adviceId: String(proposal.adviceId) },
        { confirm: true },
        "Applied to crewhaus.yaml",
        reload,
      );
      apply.disabled = false;
    });
    holder.appendChild(el("div", { class: "editor-actions" }, [apply]));
  });

  return el("div", { class: "inbox-card" }, [
    el("div", { class: "inbox-head" }, [
      dot(auto ? "ok" : "warn", proposal.tier ?? "unknown"),
      el("span", { class: "mono", text: ` ${(proposal.path ?? []).join(".")}` }),
      el("span", { class: "chip", text: String(proposal.severity ?? "info") }),
    ]),
    el("p", { text: String(proposal.summary ?? "") }),
    proposal.rationale ? el("p", { class: "reason", text: String(proposal.rationale) }) : null,
    el("p", { class: "gated-why", text: String(proposal.tierReason ?? "") }),
    el("div", { class: "inbox-actions" }, [previewBtn]),
    holder,
  ]);
}

function diffList(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return el("p", { class: "muted", text: "no textual change" });
  }
  return el(
    "ul",
    { class: "check-list" },
    entries.map((d) =>
      el("li", { class: "mono" }, [
        el("span", { text: String(d.path ?? "") }),
        el("span", {
          class: "muted",
          text: ` ${String(d.before ?? "—")} → ${String(d.after ?? "—")}`,
        }),
      ]),
    ),
  );
}

// ---------------------------------------------------------------------------
// channel reactions
// ---------------------------------------------------------------------------

/** The precondition is the point: under a `thread` sessionKey a reaction has
 *  no session to attach to and the loop collects NOTHING. A panel showing a
 *  bare zero would be indistinguishable from a quiet week. */
function reactionsCard(res) {
  return panel("Channel reactions", res, (card, data) => {
    card.appendChild(
      el("p", null, [
        data.collecting === true
          ? dot("ok", `collecting (sessionKey: ${String(data.sessionKeyMode)})`)
          : dot("warn", "collecting nothing"),
      ]),
    );
    if (data.caveat) card.appendChild(el("p", { class: "gated-why", text: String(data.caveat) }));
    card.appendChild(
      table(
        ["When", "Session · turn", "Reaction"],
        (data.reactions ?? []).map((r) =>
          el("tr", null, [
            el("td", { text: fmtRelativeTime(r.ts, Date.now()) }),
            el("td", { class: "mono", text: `${String(r.sessionId)} · ${String(r.turnNumber)}` }),
            el("td", null, [dot(r.thumbs === "up" ? "ok" : "bad", String(r.thumbs ?? "—"))]),
          ]),
        ),
      ),
    );
  });
}
