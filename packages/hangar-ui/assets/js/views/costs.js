/**
 * Costs tab — per-model spend table plus the 7-day bar mini-chart (inline
 * SVG, no chart lib). The route returns `{ id, costs }` where `costs` holds
 * integer USD-micros figures (`byModel`, zero-filled `days`, rolling
 * `spend7dUsdMicros`, `truncatedFiles`); dollars are derived client-side in
 * one place (`usdFromMicros`). Capped reads are flagged, never hidden.
 */

import { api } from "../api.js";
import { clear, el, emptyState, scrollRegion, skeleton } from "../dom.js";
import { chart, chartModel } from "../ui/chart.js";
import { fmtCount, fmtUsd, usdFromMicros } from "../util.js";

export async function renderCosts(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const data = await api.costs(ctx.id);
  clear(root);
  const costs = data?.costs && typeof data.costs === "object" ? data.costs : null;
  const models = Array.isArray(costs?.byModel) ? costs.byModel : [];
  const days = Array.isArray(costs?.days) ? costs.days : [];
  if (costs === null || (models.length === 0 && costs.calls === 0)) {
    root.appendChild(
      emptyState("No cost data yet", "crewhaus run (cost tracking is on by default)"),
    );
    return;
  }

  if (days.length > 0) {
    // A day with no figure is unknown: no bar, and never $0.
    const rows = days.slice(-7).map((d) => ({
      label: String(d.day ?? ""),
      value: usdFromMicros(d.usdMicros),
    }));
    root.appendChild(
      el("div", { class: "card" }, [
        el("h3", { class: "card-title" }, [
          el("span", { text: "Last 7 days" }),
          el("span", {
            class: "muted card-sub",
            text: fmtUsd(usdFromMicros(costs.spend7dUsdMicros)),
          }),
          typeof costs.truncatedFiles === "number" && costs.truncatedFiles > 0
            ? el("span", {
                class: "chip chip-warn",
                title: "some session logs hit the read cap — totals are floors, not lies",
                text: `${costs.truncatedFiles} capped file${costs.truncatedFiles === 1 ? "" : "s"}`,
              })
            : null,
        ]),
        chart(
          chartModel({
            kind: "bars",
            title: "Spend per day, last 7 days",
            rows,
            format: fmtUsd,
            noun: "day",
            width: 420,
            height: 64,
          }),
          { labelHead: "Day", valueHead: "Spend" },
        ),
      ]),
    );
  }

  if (models.length > 0) {
    const tbody = el("tbody");
    for (const m of models) {
      tbody.appendChild(
        el("tr", null, [
          el("td", { class: "mono", text: String(m.modelId ?? "?") }),
          el("td", { text: String(m.provider ?? "—") }),
          el("td", { class: "num", text: fmtCount(numOr(m.calls)) }),
          el("td", { class: "num", text: fmtCount(numOr(m.inputTokens)) }),
          el("td", { class: "num", text: fmtCount(numOr(m.outputTokens)) }),
          el("td", { class: "num", text: fmtUsd(usdFromMicros(m.usdMicros)) }),
        ]),
      );
    }
    root.appendChild(
      scrollRegion("Spend by model", [
        el("table", { class: "fleet" }, [
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ["Model", "Provider", "Calls", "In tokens", "Out tokens", "Cost"].map((h) =>
                el("th", { text: h }),
              ),
            ),
          ),
          tbody,
        ]),
      ]),
    );
  }
}

function numOr(v) {
  return typeof v === "number" ? v : null;
}
