/**
 * HM-11 — the health score, rendered the only way it is allowed to be:
 * with its deductions.
 *
 * A bare "72" is a mystery an operator cannot act on, so the number never
 * appears without the list that produced it, and every row in that list is
 * a LINK to the tab that fixes it. Where the server could not read a signal
 * at all, the card says so — an unknown is not a pass.
 *
 * Two surfaces, one renderer: the per-harness card (Overview) and the fleet
 * board (`#/health`), which is the "needs attention" screen — worst first.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, emptyState, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";

/** band → the traffic-light state, always paired with the text below. */
const BAND_DOT = { good: "ok", fair: "warn", poor: "bad" };
const BAND_TEXT = {
  good: "healthy",
  fair: "needs attention",
  poor: "unhealthy",
};

/** One deduction row: the points, the label, the detail, and the fix. */
function deductionRow(id, deduction) {
  const points = Number(deduction?.points ?? 0);
  const screen = String(deduction?.screen ?? "overview");
  return el("li", { class: "ded-row" }, [
    el("span", { class: "ded-points mono", text: `−${points}` }),
    el("span", { class: "ded-label", text: String(deduction?.label ?? "") }),
    el("span", { class: "ded-detail muted", text: String(deduction?.detail ?? "") }),
    // The whole point of the item: a deduction that names where it is fixed.
    id
      ? el("a", { class: "ded-fix", href: hrefHarness(id, screen), text: `fix in ${screen} →` })
      : el("span", { class: "ded-fix muted", text: `fix in ${screen}` }),
  ]);
}

/**
 * The score card.
 *
 * `id` may be null (a card with no harness behind it renders the fix
 * targets as text rather than links); `name`, when given, puts the harness's
 * name at the top — which is what turns the same card into a fleet-board
 * row.
 */
export function healthScoreCard(health, id, name = null) {
  if (!health || typeof health !== "object") {
    return el("section", { class: "card ov-card" }, [
      el("h3", { class: "card-title", text: "Health score" }),
      emptyState("No score yet — the harness could not be read", "crewhaus doctor"),
    ]);
  }
  const band = String(health.band ?? "poor");
  const deductions = Array.isArray(health.deductions) ? health.deductions : [];
  const unknowns = Array.isArray(health.unknowns) ? health.unknowns : [];
  const body = [
    name !== null
      ? el("div", { class: "health-row-head" }, [
          el("a", {
            class: "health-name",
            href: id ? hrefHarness(id) : "#/",
            text: String(name),
          }),
        ])
      : null,
    el("div", { class: "health-head" }, [
      el("span", { class: `health-score health-${band}`, text: String(health.score ?? "—") }),
      el("span", { class: "health-of muted", text: "/ 100" }),
      dot(BAND_DOT[band] ?? "unknown", BAND_TEXT[band] ?? band),
    ]),
    el("p", { class: "muted", text: String(health.summary ?? "") }),
  ];
  if (deductions.length > 0) {
    body.push(
      el(
        "ul",
        { class: "ded-list", "aria-label": "deductions" },
        deductions.map((d) => deductionRow(id, d)),
      ),
    );
  }
  if (unknowns.length > 0) {
    body.push(
      collapsible(
        [dot("unknown", `${unknowns.length} signal(s) could not be read`)],
        el(
          "ul",
          { class: "check-list" },
          unknowns.map((u) => el("li", { class: "muted", text: String(u) })),
        ),
      ),
    );
  }
  return el("section", { class: "card ov-card health-card" }, [
    el("h3", { class: "card-title", text: "Health score" }),
    ...body,
  ]);
}

/** The per-harness card, fetched on its own so a slow preflight never holds
 *  the Overview's first paint. */
export async function renderHealthCard(root, ctx) {
  clear(root).appendChild(skeleton(3));
  let payload = null;
  try {
    payload = await api.health(ctx.id);
  } catch (err) {
    clear(root).appendChild(
      el("section", { class: "card ov-card" }, [
        el("h3", { class: "card-title", text: "Health score" }),
        el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      ]),
    );
    return;
  }
  clear(root).appendChild(healthScoreCard(payload?.health ?? null, ctx.id));
}

/** `#/health` — the fleet board, worst first. */
export async function renderHealthBoard(root) {
  clear(root).appendChild(skeleton(6));
  let payload = null;
  try {
    payload = await api.fleetHealth();
  } catch (err) {
    clear(root).appendChild(
      el("div", { class: "card error-card" }, [
        el("h2", { text: "Fleet health unavailable" }),
        el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      ]),
    );
    return;
  }
  const rows = rankHealthRows(payload);
  clear(root);
  root.appendChild(
    el("div", { class: "rollup" }, [
      el("h2", { text: "Fleet health" }),
      el("span", {
        class: "muted",
        text: "every score lists the deductions that produced it — worst first",
      }),
    ]),
  );
  if (rows.length === 0) {
    root.appendChild(
      emptyState("No registered harness could be scored yet", "crewhaus harness add <dir>"),
    );
    return;
  }
  const grid = el("div", { class: "ov-grid" });
  for (const row of rows) {
    grid.appendChild(healthScoreCard(row.health, row.id, row.specName));
  }
  root.appendChild(grid);
}

/**
 * Payload → rows, worst score first, ties broken by name so the board does
 * not reshuffle between polls. Pure (unit-tested).
 */
export function rankHealthRows(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const rows = Array.isArray(body.harnesses) ? body.harnesses : [];
  return rows
    .map((row) => ({
      id: String(row?.id ?? ""),
      specName: String(row?.specName ?? row?.id ?? ""),
      health: row?.health ?? null,
      score: typeof row?.health?.score === "number" ? row.health.score : 100,
    }))
    .sort((a, b) => a.score - b.score || a.specName.localeCompare(b.specName));
}
