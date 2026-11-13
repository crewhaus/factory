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
  await draw(root, { showResolved: false, seq: 0, toolbar: null, rollup: null, body: null });
}

/**
 * The toolbar, and the "Show resolved" toggle in it, are built once per mount and
 * kept; only the body under them is repainted. A toggle rebuilt by its own
 * redraw would drop focus to the page.
 */
function frame(host, view) {
  if (view.body !== null) {
    clear(view.body);
    return view.body;
  }
  view.rollup = el("span", { class: "rollup" });
  view.toolbar = el("div", { class: "toolbar" }, [
    view.rollup,
    el("span", { class: "spacer" }),
    toggleBtn({
      label: "Show resolved",
      pressed: view.showResolved,
      onToggle: (next) => {
        view.showResolved = next;
        void draw(host, view);
      },
    }),
  ]);
  view.body = el("div");
  clear(host).append(view.toolbar, view.body);
  return view.body;
}

async function draw(host, view) {
  const { showResolved } = view;
  view.seq = (view.seq ?? 0) + 1;
  const mine = view.seq;
  let payload;
  try {
    payload = await api.review(showResolved);
  } catch (err) {
    const failed = el("div", { class: "card error-card" }, [
      el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
    ]);
    if (mine !== view.seq) return;
    if (view.body === null) clear(host).appendChild(failed);
    else frame(host, view).appendChild(failed);
    return;
  }
  // A newer toggle or reload already asked: this answer is out of date.
  if (mine !== view.seq) return;
  const body = frame(host, view);
  const nowMs = Date.now();
  const rows = (payload && Array.isArray(payload.items) ? payload.items : []).map((r) =>
    reviewRow(r, nowMs),
  );
  const open = payload && typeof payload.open === "number" ? payload.open : 0;
  const reload = () => draw(host, view);

  view.rollup.textContent = `${open} open · ${rows.length} shown`;
  if (rows.length === 0) {
    body.appendChild(
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
  mountTriage(body, rows, {
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
    row.contextWithheld
      ? el("p", {
          class: "muted",
          text: "The quoted context is hidden: reading it needs content access to this harness.",
        })
      : row.context !== ""
        ? el("pre", { class: "prose-pre", text: row.context })
        : null,
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
    // One equivalent per verdict button: thumbs adjudicate the rated turn,
    // pass and fail record the verdict on the item.
    el(
      "div",
      { class: "inbox-twins" },
      row.verdicts.map((verdict) =>
        verdict === "up" || verdict === "down"
          ? actionTwin(
              "adjudicate",
              {
                dir: row.dir,
                id: row.id,
                sessionId: row.sessionId,
                turn: row.turn,
                verdict,
              },
              verdict,
            )
          : actionTwin("review", { dir: row.dir, id: row.id, verdict }, verdict),
      ),
    ),
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
