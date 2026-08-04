/**
 * Costs tab — per-model spend table plus the 7-day bar mini-chart (inline
 * SVG, no chart lib). Unpriced usage is flagged distinctly, never silently
 * folded into dollar totals. Cached figures show their as-of time.
 */

import { api } from "../api.js";
import { asOf, clear, el, emptyState, skeleton, svgEl } from "../dom.js";
import { barRects, fmtCount, fmtUsd } from "../util.js";

export async function renderCosts(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const data = await api.costs(ctx.id);
  clear(root);
  const models = Array.isArray(data?.models) ? data.models : [];
  const days = Array.isArray(data?.days) ? data.days : [];
  if (models.length === 0 && days.length === 0) {
    root.appendChild(
      emptyState("No cost data yet", "crewhaus run (cost tracking is on by default)"),
    );
    return;
  }

  if (days.length > 0) {
    const values = days.slice(-7).map((d) => (typeof d.costUsd === "number" ? d.costUsd : 0));
    const total = values.reduce((a, b) => a + b, 0);
    const rects = barRects(values, 420, 64);
    root.appendChild(
      el("div", { class: "card" }, [
        el("h3", { class: "card-title" }, [
          el("span", { text: "Last 7 days" }),
          el("span", { class: "muted card-sub", text: fmtUsd(total) }),
          data?.cachedAt ? asOf(data.cachedAt) : null,
        ]),
        svgEl(
          "svg",
          {
            class: "bars bars-lg",
            viewBox: "0 0 420 64",
            role: "img",
            "aria-label": "daily spend",
          },
          rects.map((r) => svgEl("rect", { x: r.x, y: r.y, width: r.w, height: r.h, rx: "1.5" })),
        ),
        el(
          "div",
          { class: "bar-labels" },
          days
            .slice(-7)
            .map((d) => el("span", { class: "muted", text: String(d.day ?? "").slice(5) })),
        ),
      ]),
    );
  }

  if (models.length > 0) {
    const tbody = el("tbody");
    for (const m of models) {
      tbody.appendChild(
        el("tr", null, [
          el("td", { class: "mono", text: String(m.model ?? "?") }),
          el("td", { text: String(m.provider ?? "—") }),
          el("td", { class: "num", text: fmtCount(numOr(m.calls)) }),
          el("td", { class: "num", text: fmtCount(numOr(m.inputTokens)) }),
          el("td", { class: "num", text: fmtCount(numOr(m.outputTokens)) }),
          el("td", { class: "num" }, [
            el("span", { text: fmtUsd(numOr(m.costUsd)) }),
            m.unpriced === true
              ? el("span", {
                  class: "chip chip-warn",
                  title: "no pricing entry for this model — dollars unknown, not zero",
                  text: "unpriced",
                })
              : null,
          ]),
        ]),
      );
    }
    root.appendChild(
      el("div", { class: "table-scroll" }, [
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
