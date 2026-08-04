/**
 * Harness detail — Overview tab: health checklist, eval trend mini-line,
 * memory-fabric mini-cards, cost mini-chart, and the expandable preflight
 * report. Pure reads; every absent payload renders as "nothing yet".
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, skeleton, svgEl } from "../dom.js";
import {
  barRects,
  fmtCount,
  fmtPct,
  fmtUsd,
  healthChecks,
  sparklinePath,
  usdFromMicros,
} from "../util.js";

export async function renderOverview(root, ctx) {
  clear(root).appendChild(skeleton(5));
  const [preflightRes, evalsRes, costsRes] = await Promise.allSettled([
    api.preflight(ctx.id),
    api.evals(ctx.id),
    api.costs(ctx.id),
  ]);
  clear(root);
  const grid = el("div", { class: "ov-grid" });
  grid.appendChild(healthCard(ctx.detail));
  grid.appendChild(evalTrendCard(settled(evalsRes)));
  grid.appendChild(memoryCard(ctx.detail));
  grid.appendChild(costCard(settled(costsRes)));
  root.appendChild(grid);
  root.appendChild(preflightCard(settled(preflightRes)));
}

function settled(res) {
  return res.status === "fulfilled" ? res.value : null;
}

function card(title, children) {
  return el("section", { class: "card ov-card" }, [
    el("h3", { class: "card-title", text: title }),
    ...(Array.isArray(children) ? children : [children]),
  ]);
}

function healthCard(detail) {
  // The detail payload's `health` is the server's HarnessHealth record;
  // `healthChecks` maps its fields into checklist rows.
  const checks = healthChecks(detail?.health);
  if (checks.length === 0) {
    return card("Health", emptyState("No health data yet", "crewhaus doctor"));
  }
  return card(
    "Health",
    el(
      "ul",
      { class: "check-list" },
      checks.map((c) =>
        el("li", null, [
          dot(c.state, c.label),
          c.reason ? el("span", { class: "muted reason", text: c.reason }) : null,
        ]),
      ),
    ),
  );
}

function evalTrendCard(evals) {
  const runs = Array.isArray(evals) ? evals : Array.isArray(evals?.runs) ? evals.runs : [];
  if (runs.length === 0) {
    return card("Eval trend", emptyState("No evals yet", "crewhaus eval"));
  }
  const chronological = [...runs].reverse();
  const rates = chronological
    .map((r) => (typeof r.passRate === "number" ? r.passRate : null))
    .filter((v) => v !== null)
    .slice(-12);
  const latest = rates.length > 0 ? rates[rates.length - 1] : null;
  const path = sparklinePath(rates, 220, 44);
  const children = [
    el("div", { class: "big-stat" }, [
      el("span", { class: "stat-num", text: fmtPct(latest) }),
      el("span", { class: "muted", text: ` latest pass rate · ${runs.length} runs` }),
    ]),
  ];
  if (path !== "") {
    children.push(
      svgEl(
        "svg",
        { class: "spark", viewBox: "0 0 220 44", role: "img", "aria-label": "pass-rate trend" },
        [svgEl("path", { d: path, fill: "none", "stroke-width": "2" })],
      ),
    );
  }
  return card("Eval trend", children);
}

function memoryCard(detail) {
  // The detail payload carries small counts only: { facts, articles }.
  const mem = detail?.memory && typeof detail.memory === "object" ? detail.memory : null;
  if (mem === null) {
    return card("Memory fabric", emptyState("No memory data yet", "crewhaus remember"));
  }
  const mini = (label, value) =>
    el("div", { class: "mini" }, [
      el("div", { class: "mini-num", text: value }),
      el("div", { class: "mini-label", text: label }),
    ]);
  return card(
    "Memory fabric",
    el("div", { class: "mini-row" }, [
      mini("live facts", fmtCount(mem.facts)),
      mini("wiki articles", fmtCount(mem.articles)),
    ]),
  );
}

function costCard(payload) {
  // `/api/h/:id/costs` returns { id, costs: { spend7dUsdMicros, days, … } }.
  const costs = payload?.costs && typeof payload.costs === "object" ? payload.costs : null;
  const days = Array.isArray(costs?.days) ? costs.days : [];
  if (costs === null || (costs.calls === 0 && days.every((d) => d.usdMicros === 0))) {
    return card(
      "Spend (7d)",
      emptyState("No cost data yet", "crewhaus run (cost tracking is on by default)"),
    );
  }
  const values = days.map((d) => usdFromMicros(d.usdMicros) ?? 0);
  const total = usdFromMicros(costs.spend7dUsdMicros);
  const rects = barRects(values.slice(-7), 220, 44);
  return card("Spend (7d)", [
    el("div", { class: "big-stat" }, [el("span", { class: "stat-num", text: fmtUsd(total) })]),
    svgEl(
      "svg",
      { class: "bars", viewBox: "0 0 220 44", role: "img", "aria-label": "daily spend bars" },
      rects.map((r) => svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: "1" })),
    ),
  ]);
}

const LEVEL_META = {
  info: { mark: "✓", state: "ok" },
  warn: { mark: "⚠", state: "warn" },
  blocking: { mark: "✗", state: "bad" },
};

function preflightCard(payload) {
  // The preflight route returns { report, envFiles }; tolerate a bare report.
  const report = payload?.report && typeof payload.report === "object" ? payload.report : payload;
  const items = Array.isArray(report?.items) ? report.items : [];
  if (items.length === 0) {
    return card("Preflight", emptyState("No preflight report yet", "crewhaus harness preflight"));
  }
  const warns = items.filter((i) => i.level === "warn").length;
  const blocking = items.filter((i) => i.level === "blocking").length;
  const summaryLine = `${items.length} checks · ${warns} warning${warns === 1 ? "" : "s"} · ${blocking} blocking`;
  const list = el(
    "div",
    { class: "preflight-list" },
    items.map((item) => {
      const meta = LEVEL_META[item.level] ?? LEVEL_META.info;
      return collapsible(
        [
          el("span", { class: `pf-mark pf-${meta.state}`, "aria-hidden": "true", text: meta.mark }),
          el("span", { class: "pf-level", text: item.level ?? "info" }),
          el("span", { class: "pf-area muted", text: item.area ?? "" }),
          el("span", { class: "pf-msg", text: item.message ?? "" }),
        ],
        [
          item.remediation
            ? el("p", null, [el("strong", { text: "Fix: " }), item.remediation])
            : el("p", { class: "muted", text: "No remediation recorded." }),
          item.envVar ? el("p", { class: "mono muted", text: `env: ${item.envVar}` }) : null,
        ],
        item.level === "blocking",
      );
    }),
  );
  return el("section", { class: "card ov-card ov-wide" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Preflight" }),
      el("span", { class: "muted card-sub", text: summaryLine }),
      dot(
        blocking > 0 ? "bad" : warns > 0 ? "warn" : "ok",
        blocking > 0 ? "will not boot" : warns > 0 ? "degraded" : "ready",
      ),
    ]),
    list,
  ]);
}
