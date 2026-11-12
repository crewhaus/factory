/**
 * Harness detail — Overview tab: the process card (M2's Start/Stop/Restart/
 * Drain, with the preflight-refusal flow), health checklist, eval trend
 * mini-line, memory-fabric mini-cards, cost mini-chart, and the expandable
 * preflight report. Every absent payload renders as "nothing yet".
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, skeleton } from "../dom.js";
import { chart, chartModel } from "../ui/chart.js";
import {
  fmtCount,
  fmtPct,
  fmtUsd,
  healthChecks,
  measuredNothing,
  notMeasuredCopy,
  passRateWord,
  usdFromMicros,
} from "../util.js";
import { procCard } from "./proc.js";

export async function renderOverview(root, ctx) {
  clear(root).appendChild(skeleton(5));
  const [preflightRes, evalsRes, costsRes] = await Promise.allSettled([
    api.preflight(ctx.id),
    api.evals(ctx.id),
    api.costs(ctx.id),
  ]);
  clear(root);
  // The process picture came with the page load — render it without a
  // second fetch, at the top, because it is the only card with verbs.
  if (ctx.proc) root.appendChild(procCard(ctx.proc, ctx, ctx.reload ?? (() => {})));
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

/** The trend card. Runs come newest first. A run with no measurement, or one
 *  stopped at its budget, has no rate to plot; the headline still says what the
 *  newest run was. */
export function evalTrendCard(evals) {
  const runs = Array.isArray(evals) ? evals : Array.isArray(evals?.runs) ? evals.runs : [];
  if (runs.length === 0) {
    const copy = notMeasuredCopy(evals);
    return card("Eval trend", emptyState(copy.message, copy.verb));
  }
  const chronological = [...runs].reverse();
  // A run that measured nothing, or stopped at its budget, has no rate: it
  // is a row that reads "unknown", never a point at zero.
  const points = chronological.slice(-12).map((r) => ({
    label: String(r.ts ?? r.runId ?? ""),
    value:
      r.partial !== true && !measuredNothing(r) && typeof r.passRate === "number"
        ? r.passRate
        : null,
  }));
  const latest = passRateWord(runs[0]);
  const children = [
    el("div", { class: "big-stat" }, [
      el("span", { class: "stat-num", text: latest }),
      el("span", {
        class: "muted",
        text: ` ${latest.endsWith("%") ? "latest pass rate" : "latest run"} · ${runs.length} runs`,
      }),
    ]),
  ];
  children.push(
    chart(
      chartModel({
        kind: "line",
        title: "Pass rate per run, oldest first",
        rows: points,
        format: fmtPct,
        noun: "run",
      }),
      { labelHead: "Run", valueHead: "Pass rate" },
    ),
  );
  return card("Eval trend", children);
}

/** A fact count for the Overview. null means a store was too large to count. */
export function factCountLabel(n) {
  return n === null ? "unknown" : fmtCount(n);
}

function memoryCard(detail) {
  // The detail payload carries small counts only: { facts, articles }.
  const mem = detail?.memory && typeof detail.memory === "object" ? detail.memory : null;
  if (mem === null) {
    return card("Memory fabric", emptyState("No memory data yet"));
  }
  const mini = (label, value) =>
    el("div", { class: "mini" }, [
      el("div", { class: "mini-num", text: value }),
      el("div", { class: "mini-label", text: label }),
    ]);
  return card(
    "Memory fabric",
    el("div", { class: "mini-row" }, [
      mini("live facts", factCountLabel(mem.facts)),
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
      emptyState("No cost data yet. Cost tracking is on by default.", "crewhaus run crewhaus.yaml"),
    );
  }
  // A day with no figure is unknown, never $0.
  const rows = days.slice(-7).map((d) => ({
    label: String(d.day ?? ""),
    value: usdFromMicros(d.usdMicros),
  }));
  const total = usdFromMicros(costs.spend7dUsdMicros);
  return card("Spend (7d)", [
    el("div", { class: "big-stat" }, [el("span", { class: "stat-num", text: fmtUsd(total) })]),
    chart(chartModel({ kind: "bars", title: "Spend per day", rows, format: fmtUsd, noun: "day" }), {
      labelHead: "Day",
      valueHead: "Spend",
    }),
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
    return card(
      "Preflight",
      emptyState("No preflight report yet", "crewhaus harness preflight <dir>"),
    );
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
