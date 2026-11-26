/**
 * Spend (`#/harnesses/spend`): this period's spend of every harness you can see, against
 * its limit, from one `home.spend` read. A call nothing could price is "cost unknown",
 * never $0: the row says how many calls, and the total says "at least". Spending is
 * tracked only where a harness has a spending limit, so the total names that scope, and a
 * Home where no harness has one shows no total at all. A harness whose limit is used up
 * says it is waiting for budget until its renewal day, in its own zone.
 * The table scrolls inside its own container, so the page reflows at any width.
 */

import { clear, el, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import { emptyFor } from "../ui/empty.js";
import { call } from "../v1.js";
import { shortDate } from "./budget.js";

/** Dollars from micros, or null when there is no amount. Pure. */
export function usdOf(micros) {
  return typeof micros === "number" && Number.isFinite(micros)
    ? `$${(micros / 1_000_000).toFixed(2)}`
    : null;
}

/**
 * One row's words: `{harness, name, spent, limit, renews, status, unknown}`, each a
 * plain sentence piece. Pure.
 */
export function spendRowModel(row) {
  const name = String(row?.name ?? row?.harness ?? "");
  const harness = String(row?.harness ?? "");
  if (row?.present !== true) {
    return {
      harness,
      name,
      spent: row?.why === "spec_unreadable" ? "Not known" : "Not tracked",
      limit: row?.why === "spec_unreadable" ? "Limit unknown" : "No spending limit",
      renews: null,
      status: row?.why === "spec_unreadable" ? "Spending limit unknown" : "No spending limit",
      unknown: null,
    };
  }
  const zone = typeof row.timezone === "string" && row.timezone !== "" ? row.timezone : "UTC";
  const limit = (row.capUsdMicros ?? 0) + (row.extensionsUsdMicros ?? 0);
  const calls = typeof row.unknownCalls === "number" ? row.unknownCalls : 0;
  const renewal = shortDate(row.renewsAt, zone);
  return {
    harness,
    name,
    spent: usdOf(row.spentUsdMicros),
    limit: usdOf(limit),
    renews: renewal,
    status:
      row.exhausted === true
        ? `Waiting for budget until ${renewal}`
        : row.truncated === true
          ? "Some spending was not read"
          : "Within its limit",
    unknown: calls > 0 ? `+ cost unknown for ${calls} call${calls === 1 ? "" : "s"}` : null,
  };
}

/** What the total says when no harness has a spending limit. */
export const SPEND_UNTRACKED = "No harness has a spending limit, so spending is not tracked.";

/**
 * The total line over the harnesses with a spending limit, saying "at least" when some
 * cost is unknown or was not read, and naming its scope when some harnesses have no
 * limit. No limit anywhere is no total, never $0. `shown` is how many rows the view
 * lists. Pure.
 */
export function spendTotalLine(totals, shown = null) {
  if (totals === null || typeof totals !== "object") return null;
  const tracked = Number.isSafeInteger(totals.harnesses) ? totals.harnesses : 0;
  if (tracked === 0) return SPEND_UNTRACKED;
  const spent = usdOf(totals.spentUsdMicros);
  if (spent === null) return "This period's spending could not be read.";
  const limit = usdOf(totals.capUsdMicros);
  const atLeast = totals.lowerBound === true ? "at least " : "";
  const of = limit !== null ? ` of ${limit}` : "";
  const unknown =
    typeof totals.unknownCalls === "number" && totals.unknownCalls > 0
      ? `, and cost unknown for ${totals.unknownCalls} call${totals.unknownCalls === 1 ? "" : "s"}`
      : "";
  const scope =
    shown === null || tracked < shown
      ? `This period, across the ${tracked === 1 ? "harness" : `${tracked} harnesses`} with a limit`
      : "This period";
  return `${scope}: ${atLeast}${spent}${of} spent${unknown}.`;
}

export async function renderSpend(root, ctx = {}) {
  clear(root).appendChild(skeleton(4));
  const answer = await call("home.spend");
  if (ctx.signal?.aborted) return;
  clear(root);
  if (!answer.ok) {
    root.appendChild(
      emptyFor({
        cause: answer.status === 403 ? "no-access" : "connection-failed",
        subject: "spending",
        detail: answer.error?.message,
        onAction: () => void renderSpend(root, ctx),
      }),
    );
    return;
  }
  const rows = Array.isArray(answer.body?.rows) ? answer.body.rows : [];
  if (rows.length === 0) {
    root.appendChild(
      el("div", { class: "empty", "data-cause": "no-data" }, [
        el("div", { class: "empty-msg", text: "No harnesses to show spending for." }),
      ]),
    );
    return;
  }
  const total = spendTotalLine(answer.body?.totals, rows.length);
  if (total !== null) root.appendChild(el("p", { class: "spend-total", text: total }));
  const head = el("tr", null, [
    el("th", { scope: "col", text: "Harness" }),
    el("th", { scope: "col", text: "Spent this period" }),
    el("th", { scope: "col", text: "Limit" }),
    el("th", { scope: "col", text: "Renews" }),
    el("th", { scope: "col", text: "Status" }),
  ]);
  const body = el(
    "tbody",
    null,
    rows.map((row) => {
      const m = spendRowModel(row);
      return el("tr", null, [
        el("th", { scope: "row" }, [el("a", { href: hrefHarness(m.harness), text: m.name })]),
        el("td", null, [
          el("span", { text: m.spent ?? "Not known" }),
          m.unknown !== null ? el("span", { class: "muted", text: ` ${m.unknown}` }) : null,
        ]),
        el("td", { text: m.limit ?? "—" }),
        el("td", { text: m.renews ?? "—" }),
        el("td", { text: m.status }),
      ]);
    }),
  );
  root.appendChild(
    el(
      "div",
      { class: "table-scroll", role: "region", "aria-label": "Spending by harness", tabindex: "0" },
      [
        el("table", { class: "table" }, [
          el("caption", { class: "sr-only", text: "This period's spending, by harness" }),
          el("thead", null, [head]),
          body,
        ]),
      ],
    ),
  );
  root.appendChild(
    el("p", {
      class: "muted",
      text: "One harness's spending in a terminal: crewhaus budget show --harness <id>",
    }),
  );
}
