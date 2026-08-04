/**
 * The review queue — `.crewhaus/review/queue.jsonl` folded across the fleet,
 * with the same triage ergonomics as the approvals inbox (j/k, one-key
 * verdicts, `.` row menu, `?` bindings).
 *
 * THE VERDICTS DIFFER BY ITEM. An item that points at a session TURN can be
 * ADJUDICATED — up/down take the same path `crewhaus rate --adjudicate`
 * takes, settling the disagreement at its source so the next distill does
 * not re-open it. An item with no turn (an eval abstention, a quarantine
 * pointer) can only record pass/fail on the item itself, so the thumbs are
 * not offered there: the server would 409, and a button that always fails is
 * worse than one that is not there.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, jsonPre, skeleton, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { REVIEW_KEYS, reviewRow } from "../supervision.js";
import { actionTwin } from "./control.js";
import { mountTriage } from "./inbox.js";

export async function renderReview(root) {
  clear(root).appendChild(skeleton(6));
  await draw(root, false);
}

async function draw(host, showResolved) {
  let payload;
  try {
    payload = await api.review(showResolved);
  } catch (err) {
    clear(host).appendChild(
      el("div", { class: "card error-card" }, [
        el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      ]),
    );
    return;
  }
  clear(host);
  const nowMs = Date.now();
  const rows = (payload && Array.isArray(payload.items) ? payload.items : []).map((r) =>
    reviewRow(r, nowMs),
  );
  const open = payload && typeof payload.open === "number" ? payload.open : 0;
  const reload = () => draw(host, showResolved);

  host.appendChild(
    el("div", { class: "toolbar" }, [
      el("span", { class: "rollup", text: `${open} open · ${rows.length} shown` }),
      el("span", { class: "spacer" }),
      el("button", {
        class: `btn btn-ghost${showResolved ? " active" : ""}`,
        type: "button",
        text: showResolved ? "Showing resolved too" : "Show resolved",
        onClick: () => draw(host, !showResolved),
      }),
    ]),
  );
  if (rows.length === 0) {
    host.appendChild(
      emptyState(
        showResolved ? "No review items on this fleet" : "Nothing waiting for review",
        "crewhaus review list",
      ),
    );
    return;
  }
  mountTriage(host, rows, {
    keys: REVIEW_KEYS,
    reload,
    render: reviewCard,
    perform: adjudicate,
  });
}

async function adjudicate(row, verdict, reload) {
  if (!row.verdicts.includes(verdict)) {
    toast(`${verdict} does not apply here — ${row.verdictNote}`, "info");
    return;
  }
  let result;
  try {
    result = await api.adjudicateReview(row.harnessId, row.id, verdict);
  } catch (err) {
    toast(`Verdict failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  toast(
    result && result.adjudicated === true
      ? `Adjudicated the rated turn (${verdict})`
      : `Recorded ${verdict} on the item`,
    "info",
  );
  reload();
}

function reviewCard(row, index, state, redraw, reload) {
  const selected = state.index === index;
  const verdictBtn = (verdict) => {
    const btn = el("button", {
      class: `btn${verdict === "up" || verdict === "pass" ? " btn-primary" : ""}`,
      type: "button",
      text: verdict,
      title: row.open ? `record ${verdict}` : `already ${row.status}`,
    });
    if (!row.open) btn.disabled = true;
    else btn.addEventListener("click", () => adjudicate(row, verdict, reload));
    return btn;
  };
  return el(
    "section",
    {
      class: `card inbox-card${selected ? " selected" : ""}`,
      "aria-current": selected ? "true" : null,
      onClick: () => {
        if (!selected) redraw({ ...state, index });
      },
    },
    [
      el("div", { class: "inbox-head" }, [
        dot(row.dot, row.status),
        el("span", { class: "chip", text: row.kind }),
        el("a", { class: "name-link", href: hrefHarness(row.harnessId), text: row.specName }),
        row.adjudicable
          ? el("span", { class: "chip chip-group", text: "adjudicable" })
          : el("span", { class: "chip", text: "item verdict only" }),
        el("span", { class: "muted", text: row.age }),
      ]),
      row.context !== "" ? el("pre", { class: "prose-pre", text: row.context }) : null,
      row.sessionId !== null
        ? el("div", { class: "muted reason" }, [
            el("span", { text: "turn " }),
            el("span", { class: "mono", text: String(row.turn ?? "?") }),
            el("span", { text: " of " }),
            el("a", {
              class: "mono",
              href: hrefHarness(row.harnessId, "sessions", row.sessionId),
              text: row.sessionId,
            }),
          ])
        : null,
      el("div", { class: "muted reason", text: row.verdictNote }),
      el("div", { class: "inbox-actions" }, row.verdicts.map(verdictBtn)),
      el("div", { class: "inbox-twins" }, [
        row.adjudicable
          ? actionTwin("adjudicate", {
              sessionId: row.sessionId,
              turn: row.turn ?? 0,
              verdict: "up",
            })
          : null,
        actionTwin("review", { id: row.id }),
      ]),
      Object.keys(row.sourceRef).length > 0
        ? el("details", { class: "fold" }, [
            el("summary", { class: "fold-summary" }, [
              el("span", { class: "muted", text: "source reference" }),
            ]),
            el("div", { class: "fold-body" }, [jsonPre(row.sourceRef)]),
          ])
        : null,
    ],
  );
}
