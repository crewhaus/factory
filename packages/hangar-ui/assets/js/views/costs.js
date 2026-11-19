/**
 * Costs tab — per-model spend table plus the 7-day bar mini-chart (inline
 * SVG, no chart lib). The route returns `{ id, costs }` where `costs` holds
 * integer USD-micros figures (`byModel`, zero-filled `days`, rolling
 * `spend7dUsdMicros`, `truncatedFiles`); dollars are derived client-side in
 * one place (`usdFromMicros`). Capped reads are flagged, never hidden.
 *
 * A call with no price has an unknown cost, never $0: a total that includes
 * one reads "$1.20 + unknown", a model with no price reads "Unknown: no price"
 * and names `crewhaus models audit`, and a day whose calls were all unpriced
 * gets no bar (a partly unpriced one gets a dashed cap and "+ unknown").
 */

import { api } from "../api.js";
import { clear, el, emptyState, scrollRegion, skeleton } from "../dom.js";
import { chart, chartModel } from "../ui/chart.js";
import { fmtCount, fmtUsd, usdFromMicros } from "../util.js";

/** What a model with no price shows in place of a cost. */
export const UNPRICED_COST = "Unknown: no price";

/** The verb that lists the models with no price, and where to add one. */
export const PRICE_AUDIT_VERB = "crewhaus models audit";

/** A dollar total, with "+ unknown" when some of its calls have no price. */
export function totalText(micros, unpricedCalls) {
  const base = fmtUsd(usdFromMicros(micros));
  return typeof unpricedCalls === "number" && unpricedCalls > 0 ? `${base} + unknown` : base;
}

/** One chart row per day: unknown when every call had no price, partly unknown when some did. */
export function dayRow(d) {
  const calls = typeof d?.calls === "number" ? d.calls : 0;
  const unpriced = typeof d?.unpricedCalls === "number" ? d.unpricedCalls : 0;
  const allUnknown = unpriced > 0 && unpriced >= calls;
  return {
    label: String(d?.day ?? ""),
    value: allUnknown ? null : usdFromMicros(d?.usdMicros),
    ...(unpriced > 0 && !allUnknown ? { unknownPart: true } : {}),
  };
}

export async function renderCosts(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const data = await api.costs(ctx.id);
  clear(root);
  const costs = data?.costs && typeof data.costs === "object" ? data.costs : null;
  const models = Array.isArray(costs?.byModel) ? costs.byModel : [];
  const days = Array.isArray(costs?.days) ? costs.days : [];
  // Unobtainable is not zero: when the logs could not be read, the cost is unknown.
  if (costs !== null && typeof costs.unknown === "string" && costs.unknown !== "") {
    root.appendChild(emptyState(`Cost unknown: ${costs.unknown}`, null));
    return;
  }
  if (costs === null || (models.length === 0 && costs.calls === 0)) {
    root.appendChild(
      emptyState("No cost data yet. Cost tracking is on by default.", "crewhaus run crewhaus.yaml"),
    );
    return;
  }

  if (days.length > 0) {
    // A day with no figure is unknown: no bar, and never $0.
    const rows = days.slice(-7).map(dayRow);
    root.appendChild(
      el("div", { class: "card" }, [
        el("h3", { class: "card-title" }, [
          el("span", { text: "Last 7 days" }),
          el("span", {
            class: "muted card-sub",
            text: totalText(
              costs.spend7dUsdMicros,
              days.slice(-7).reduce((n, d) => n + (numOr(d.unpricedCalls) ?? 0), 0),
            ),
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
          m.unpriced === true
            ? el("td", { class: "num" }, [
                el("span", { text: UNPRICED_COST }),
                el("span", { class: "muted", text: " · " }),
                el("code", { text: PRICE_AUDIT_VERB }),
              ])
            : el("td", { class: "num", text: fmtUsd(usdFromMicros(m.usdMicros)) }),
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

  if (typeof costs.unpricedCalls === "number" && costs.unpricedCalls > 0) {
    root.appendChild(
      el("p", { class: "muted" }, [
        el("span", {
          text: `Total ${totalText(costs.totalUsdMicros, costs.unpricedCalls)}: ${fmtCount(costs.unpricedCalls)} call${costs.unpricedCalls === 1 ? "" : "s"} used a model with no price. Add a price, or see which models need one: `,
        }),
        el("code", { text: PRICE_AUDIT_VERB }),
      ]),
    );
  }
}

function numOr(v) {
  return typeof v === "number" ? v : null;
}
