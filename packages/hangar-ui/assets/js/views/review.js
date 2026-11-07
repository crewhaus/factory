/**
 * The review queue — `.crewhaus/review/queue.jsonl` folded across the fleet,
 * with the same triage ergonomics as the approvals inbox (j/k, a letter to
 * choose a verdict and Enter to confirm, `.` row menu, `?` keys).
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
import { clear, dot, el, jsonPre, skeleton, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { REVIEW_KEYS, reviewRow } from "../supervision.js";
import { emptyFor } from "../ui/empty.js";
import { toggleBtn } from "../ui/toggle.js";
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
      toggleBtn({
        label: "Show resolved",
        pressed: showResolved,
        onToggle: (next) => draw(host, next),
      }),
    ]),
  );
  if (rows.length === 0) {
    host.appendChild(
      emptyFor({
        cause: "no-data",
        detail: showResolved
          ? "No review items are recorded on this fleet."
          : "Nothing is waiting for review. A split rating or a quarantined case lands here.",
        verb: "crewhaus review list",
      }),
    );
    return;
  }
  mountTriage(host, rows, {
    name: "review",
    label: "Review queue",
    keys: REVIEW_KEYS,
    reload,
    render: reviewCard,
    rowLabel: (row) => `${row.kind} for ${row.specName}, ${row.status}`,
    prompt: (row, verdict) => `Record ${verdict} for ${row.specName}?`,
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

/** One row's content; the triage shell owns the row (see approvals.js). */
function reviewCard(row, { perform }) {
  const verdictBtn = (verdict) => {
    const btn = el("button", {
      class: `btn${verdict === "up" || verdict === "pass" ? " btn-primary" : ""}`,
      type: "button",
      text: verdict,
      title: row.open ? `record ${verdict}` : `already ${row.status}`,
    });
    if (!row.open) btn.disabled = true;
    else btn.addEventListener("click", () => perform(verdict));
    return btn;
  };
  return [
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
  ];
}
