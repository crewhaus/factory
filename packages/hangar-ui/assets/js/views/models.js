/**
 * Models tab (0.6.0 design §8.3) — the answer to "which model served, with
 * which settings, at what cost, and is the cheap lane winning?"
 *
 * Four panels, in the order an operator asks the questions:
 *
 *   1. **Registry** — the `models:` profiles this spec declares, and the
 *      `model_pool` candidates that reference them (one card per pool: a
 *      crew role or a workflow step declares one as readily as `agent:`).
 *   2. **Per-profile spend** — the same cost fold the Costs tab reads, split
 *      by `role` and by `profile` instead of by model. This is where a
 *      judge, an escalation or a sub-agent's spend becomes visible: those
 *      calls carry the attribution, and until 0.6.0 nothing rendered it.
 *   3. **Leaderboard** — the learned arms ranked inside each routing band,
 *      with the arm a `learned` policy would exploit starred.
 *   4. **Route timeline** — one run's durable routing lines in order, so the
 *      shape of a hybrid turn (draft → judge → escalate) can be read back.
 *
 * READ-ONLY. Nothing on this screen writes: the roster, the rules, the
 * strategy membership and the conservative floor are human-owned and travel
 * through `crewhaus propose`; the arms are the runtime's to write.
 *
 * The pure shaping functions are exported for unit tests; the renderers are
 * thin DOM builders over them, in the M2 tradition.
 */

import { api } from "../api.js";
import { clear, collapsible, el, emptyState, jsonPre, skeleton } from "../dom.js";
import { fmtCount, fmtUsd, usdFromMicros } from "../util.js";

/** A spend row's share of the total, in [0, 1]. Pure. */
export function spendShare(usdMicros, totalUsdMicros) {
  const total = typeof totalUsdMicros === "number" ? totalUsdMicros : 0;
  const part = typeof usdMicros === "number" ? usdMicros : 0;
  return total > 0 ? part / total : 0;
}

/**
 * Payload → the per-profile spend rows the table renders, biggest first.
 * The server already ranks them; this normalizes the shape and attaches the
 * share so the bar and the number cannot disagree. Pure.
 */
export function profileSpendRows(payload) {
  const spend =
    payload && typeof payload.spend === "object" && payload.spend !== null ? payload.spend : {};
  const total = typeof spend.totalUsdMicros === "number" ? spend.totalUsdMicros : 0;
  const rows = Array.isArray(spend.byProfile) ? spend.byProfile : [];
  return rows.map((row) => ({
    profile: String(row?.profile ?? "(none)"),
    calls: typeof row?.calls === "number" ? row.calls : 0,
    usdMicros: typeof row?.usdMicros === "number" ? row.usdMicros : 0,
    share: spendShare(row?.usdMicros, total),
  }));
}

/**
 * Payload → the declared pools, one row per host that declares one. Pure.
 *
 * `model_pool` is not an `agent:` field — a crew role, a workflow step, a
 * graph node or a sub-agent declares one too — so the tab renders a card per
 * pool. A manager one version behind serves only `pool`; that single view is
 * used as the one row rather than claiming nothing is declared.
 */
export function declaredPools(payload) {
  const rows = Array.isArray(payload?.pools) ? payload.pools : [];
  const shaped = rows
    .filter((row) => row && typeof row.pool === "object" && row.pool !== null)
    .map((row) => ({ hostPath: String(row.hostPath ?? "model_pool"), pool: row.pool }));
  if (shaped.length > 0) return shaped;
  const single = payload?.pool;
  return single && typeof single === "object" && single.declared === true
    ? [{ hostPath: "model_pool", pool: single }]
    : [];
}

/** The same shaping for the per-role split. Pure. */
export function roleSpendRows(payload) {
  const spend =
    payload && typeof payload.spend === "object" && payload.spend !== null ? payload.spend : {};
  const total = typeof spend.totalUsdMicros === "number" ? spend.totalUsdMicros : 0;
  const rows = Array.isArray(spend.byRole) ? spend.byRole : [];
  return rows.map((row) => ({
    role: String(row?.role ?? "primary"),
    calls: typeof row?.calls === "number" ? row.calls : 0,
    usdMicros: typeof row?.usdMicros === "number" ? row.usdMicros : 0,
    share: spendShare(row?.usdMicros, total),
  }));
}

/**
 * One timeline entry → the single line the gutter renders. Pure, and
 * deliberately total: an unknown routing kind still renders its kind rather
 * than vanishing, because a manager one version behind its harness must not
 * silently drop events.
 */
export function timelineLine(entry) {
  const kind = String(entry?.kind ?? "");
  const p =
    entry && typeof entry.payload === "object" && entry.payload !== null ? entry.payload : {};
  const parts = [];
  const push = (value) => {
    if (value !== undefined && value !== null && String(value) !== "") parts.push(String(value));
  };
  switch (kind) {
    case "model_route":
      push(p.model);
      if (p.profile) push(`profile=${p.profile}`);
      if (p.band) push(`band=${p.band}`);
      if (p.policy) push(`policy=${p.policy}${p.explored === true ? " (exploring)" : ""}`);
      if (p.ruleId) push(`rule=${p.ruleId}`);
      break;
    case "model_tier_route":
      push(p.model);
      if (p.tier) push(`tier=${p.tier}${p.escalated === true ? " (escalated)" : ""}`);
      break;
    case "model_stage":
      push(`${p.stage ?? "?"} · ${p.outcome ?? "?"}`);
      if (p.strategy) push(`strategy=${p.strategy}`);
      if (p.model) push(p.model);
      if (p.profile) push(`profile=${p.profile}`);
      if (p.cause) push(p.cause);
      break;
    case "model_directive":
      push(`${p.requested ?? "?"} → ${p.resolved ?? "(refused)"}`);
      push(p.accepted === true ? "accepted" : "refused");
      if (p.reason) push(p.reason);
      break;
    case "model_failover":
      push(`${p.from ?? "?"} → ${p.to ?? "?"}`);
      if (p.reason) push(p.reason);
      break;
    case "judge_verdict":
      push(p.verdict);
      if (typeof p.score === "number") push(`score=${p.score}`);
      if (p.judgeModel) push(`judge=${p.judgeModel}`);
      break;
    default:
      break;
  }
  return {
    kind,
    turn: typeof entry?.turnNumber === "number" ? entry.turnNumber : null,
    detail: parts.join(" · "),
  };
}

function shareBar(share) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  return el("div", { class: "meter" }, [
    el("div", { class: "meter-fill", style: `width:${pct.toFixed(1)}%` }),
  ]);
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

function card(title, sub, body) {
  return el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: title }),
      sub === null ? null : el("span", { class: "muted card-sub", text: sub }),
    ]),
    ...(Array.isArray(body) ? body : [body]),
  ]);
}

/** The whole tab. `ctx` is `{ id, … }`, the same shape every tab receives. */
export async function renderModels(root, ctx) {
  clear(root).appendChild(skeleton(8));
  const data = await api.models({ id: ctx.id });
  clear(root);
  const body = data && typeof data.body === "object" && data.body !== null ? data.body : data;
  if (!body || typeof body !== "object") {
    root.appendChild(emptyState("No model data", "crewhaus models list"));
    return;
  }

  const registry = Array.isArray(body.registry) ? body.registry : [];
  const pools = declaredPools(body);
  const arms = Array.isArray(body.arms) ? body.arms : [];
  const leaderboard = Array.isArray(body.leaderboard) ? body.leaderboard : [];
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const profiles = profileSpendRows(body);
  const roles = roleSpendRows(body);

  if (typeof body.note === "string" && body.note !== "") {
    root.appendChild(el("p", { class: "muted", text: body.note }));
  }

  // ---- 1. the registry + the pool ----------------------------------------
  root.appendChild(
    card(
      "Registry",
      registry.length === 0 ? "no models: block declared" : `${registry.length} profile(s)`,
      registry.length === 0
        ? el("p", {
            class: "muted",
            text: "declare models: to give a profile its own settings, tools and permissions once, then reference it as $name at any model slot.",
          })
        : table(
            ["Profile", "Model", "Settings"],
            registry.map((row) =>
              el("tr", null, [
                el("td", { class: "mono", text: String(row?.name ?? "?") }),
                el("td", { class: "mono", text: String(row?.model ?? "—") }),
                el("td", {
                  class: "muted",
                  text: (Array.isArray(row?.settings) ? row.settings : [])
                    .filter((s) => s?.key !== "model")
                    .map((s) => `${s.key}=${s.value}`)
                    .join(" · "),
                }),
              ]),
            ),
          ),
    ),
  );

  if (pools.length === 0) {
    root.appendChild(
      card(
        "Routing pool",
        "not declared",
        el("p", {
          class: "muted",
          text: "no model_pool anywhere in the spec — every turn is served by the one declared model.",
        }),
      ),
    );
  } else {
    for (const { hostPath, pool: p } of pools) {
      root.appendChild(
        card(
          `Routing pool · ${hostPath}`,
          `policy ${p.policy ?? "static"}${p.scope ? ` · scope ${p.scope}` : ""}`,
          table(
            ["Candidate", "Profile", "Tags", "Enabled"],
            (Array.isArray(p.candidates) ? p.candidates : []).map((c) =>
              el("tr", null, [
                el("td", { class: "mono", text: String(c?.model ?? "—") }),
                el("td", { class: "mono", text: String(c?.profile ?? "—") }),
                el("td", {
                  class: "muted",
                  text: (Array.isArray(c?.tags) ? c.tags : []).join(", "),
                }),
                el("td", { text: c?.enabled === false ? "no" : "yes" }),
              ]),
            ),
          ),
        ),
      );
    }
  }

  // ---- 2. per-role and per-profile spend ---------------------------------
  const spendBody = [];
  if (roles.length > 0) {
    spendBody.push(
      table(
        ["Role", "Calls", "Cost", "Share"],
        roles.map((r) =>
          el("tr", null, [
            el("td", { text: r.role }),
            el("td", { class: "num", text: fmtCount(r.calls) }),
            el("td", { class: "num", text: fmtUsd(usdFromMicros(r.usdMicros)) }),
            el("td", null, shareBar(r.share)),
          ]),
        ),
      ),
    );
  }
  if (profiles.length > 0) {
    spendBody.push(
      table(
        ["Profile", "Calls", "Cost", "Share"],
        profiles.map((p) =>
          el("tr", null, [
            el("td", { class: "mono", text: p.profile }),
            el("td", { class: "num", text: fmtCount(p.calls) }),
            el("td", { class: "num", text: fmtUsd(usdFromMicros(p.usdMicros)) }),
            el("td", null, shareBar(p.share)),
          ]),
        ),
      ),
    );
  }
  if (spendBody.length === 0) {
    spendBody.push(
      el("p", { class: "muted", text: "no priced model calls recorded for this harness yet." }),
    );
  } else if (typeof body.spend?.rollups === "number" && body.spend.rollups > 0) {
    spendBody.push(
      el("p", {
        class: "muted",
        text: `${body.spend.rollups} nested-run roll-up line(s) were skipped — a sub-agent's spend is counted from the child's own session log, which is folded here too.`,
      }),
    );
  }
  root.appendChild(
    card("Spend by role and profile", fmtUsd(usdFromMicros(body.spend?.totalUsdMicros)), spendBody),
  );

  // ---- 3. the leaderboard -------------------------------------------------
  root.appendChild(
    card(
      "Leaderboard",
      arms.length === 0 ? "no arms recorded" : `${arms.length} arm(s)`,
      leaderboard.length === 0
        ? el("p", {
            class: "muted",
            text: "a pooled run folds one observation per turn into its band's arm; nothing has been observed yet.",
          })
        : table(
            ["Band", "Model", "n", "Reward", "Quality", "Latency", "Cost/call"],
            leaderboard.map((row) =>
              el("tr", { class: row?.best === true ? "row-best" : null }, [
                el("td", {
                  class: "mono",
                  text: `${row?.band ?? "?"}${row?.shadow === true ? " (shadow)" : ""}`,
                }),
                el("td", {
                  class: "mono",
                  text: `${row?.model ?? "?"}${row?.best === true ? " ★" : ""}`,
                }),
                el("td", { class: "num", text: fmtCount(row?.n) }),
                el("td", { class: "num", text: Number(row?.meanReward ?? 0).toFixed(3) }),
                el("td", {
                  class: "num",
                  text: row?.qualityCount > 0 ? Number(row.meanQuality).toFixed(3) : "—",
                }),
                el("td", {
                  class: "num",
                  text: `${Math.round(Number(row?.meanLatencyMs ?? 0))}ms`,
                }),
                el("td", {
                  class: "num",
                  text: row?.meanCostUsd > 0 ? `$${Number(row.meanCostUsd).toFixed(5)}` : "—",
                }),
              ]),
            ),
          ),
    ),
  );

  // ---- 4. the route timeline ---------------------------------------------
  const timelineRoot = el("div");
  root.appendChild(
    card(
      "Route timeline",
      sessions.length === 0
        ? "no session recorded a routing decision"
        : `${sessions.length} session(s)`,
      sessions.length === 0
        ? el("p", {
            class: "muted",
            text: "only runs whose spec declares a pool, tiers or a hybrid strategy persist routing lines.",
          })
        : [
            el(
              "div",
              { class: "chips" },
              sessions.slice(0, 12).map((s) => {
                const btn = el("button", {
                  class: "chip",
                  text: `${s.id} (${s.routingLines})`,
                });
                btn.addEventListener("click", () => {
                  void loadTimeline(timelineRoot, ctx.id, String(s.id));
                });
                return btn;
              }),
            ),
            timelineRoot,
          ],
    ),
  );
  const first = sessions[0];
  if (first !== undefined) await loadTimeline(timelineRoot, ctx.id, String(first.id));

  if (body.freeze) {
    root.appendChild(
      collapsible(
        [el("span", { text: "Routing is FROZEN — the learned policy is pinned" })],
        [jsonPre(body.freeze)],
      ),
    );
  }
}

/** Load and render one session's timeline into `host`. */
async function loadTimeline(host, id, sessionId) {
  clear(host).appendChild(skeleton(3));
  const data = await api.modelRoutes({ id, sess: sessionId });
  const body = data && typeof data.body === "object" && data.body !== null ? data.body : data;
  clear(host);
  const entries = Array.isArray(body?.entries) ? body.entries : [];
  if (entries.length === 0) {
    host.appendChild(
      el("p", { class: "muted", text: String(body?.note ?? "no routing lines in this session.") }),
    );
    return;
  }
  host.appendChild(
    table(
      ["Turn", "Kind", "Detail"],
      entries.map((entry) => {
        const line = timelineLine(entry);
        return el("tr", null, [
          el("td", { class: "num", text: line.turn === null ? "—" : String(line.turn) }),
          el("td", { class: "mono", text: line.kind }),
          el("td", { class: "muted", text: line.detail }),
        ]);
      }),
    ),
  );
}
