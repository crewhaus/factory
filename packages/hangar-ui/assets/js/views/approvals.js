/**
 * The approvals inbox — every harness's parked tool-approval requests folded
 * into one triage list.
 *
 * THE INPUT IS SHOWN VERBATIM (the server masked credential shapes on the
 * way out, and nothing else): an approver cannot judge a call they cannot
 * see, so the tool input renders in full rather than as a hash or a summary.
 *
 * Triage is keyboard-first while the list has focus — j/k to move, g or d to
 * choose grant or deny and Enter to confirm, `.` for the row menu, `?` for
 * the keys — because an inbox with twenty parked calls is a keyboard task. Granting a request whose run PARKED also resumes it: the
 * row says so, because "what happens after I click" is the question an
 * approver actually has.
 */

import { api } from "../api.js";
import { clear, dot, el, jsonPre, skeleton, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { APPROVAL_KEYS, approvalRow } from "../supervision.js";
import { emptyFor } from "../ui/empty.js";
import { toggleBtn } from "../ui/toggle.js";
import { actionTwin, gatedBtn } from "./control.js";
import { mountTriage } from "./inbox.js";

export async function renderApprovals(root) {
  clear(root).appendChild(skeleton(6));
  await draw(root, { showSettled: false, seq: 0, toolbar: null, rollup: null, body: null });
}

/**
 * The toolbar, and the "Show settled" toggle in it, are built once per mount and
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
      label: "Show settled",
      pressed: view.showSettled,
      onToggle: (next) => {
        view.showSettled = next;
        void draw(host, view);
      },
    }),
  ]);
  view.body = el("div");
  clear(host).append(view.toolbar, view.body);
  return view.body;
}

async function draw(host, view) {
  const { showSettled } = view;
  view.seq = (view.seq ?? 0) + 1;
  const mine = view.seq;
  let payload;
  try {
    payload = await api.approvals(showSettled);
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
  const rows = (payload && Array.isArray(payload.approvals) ? payload.approvals : []).map((r) =>
    approvalRow(r, nowMs),
  );
  const pending = payload && typeof payload.pending === "number" ? payload.pending : 0;
  const truncated =
    payload && Array.isArray(payload.truncatedHarnesses) ? payload.truncatedHarnesses : [];
  const reload = () => draw(host, view);

  view.rollup.textContent = `${pending} pending · ${rows.length} shown`;
  if (truncated.length > 0) {
    body.appendChild(
      el("p", {
        class: "muted",
        text: `${truncated.length} harness log${truncated.length === 1 ? " was" : "s were"} capped mid-read — older entries are not shown.`,
      }),
    );
  }
  if (rows.length === 0) {
    body.appendChild(
      emptyFor({
        cause: "no-data",
        detail: showSettled
          ? "No approvals are recorded on this fleet."
          : "Nothing is waiting for a decision. A tool call that needs a person parks here.",
        verb: "crewhaus approvals list",
      }),
    );
    return;
  }
  mountTriage(body, rows, {
    name: "approvals",
    label: "Approvals",
    keys: APPROVAL_KEYS,
    reload,
    render: approvalCard,
    rowLabel: (row) => `${row.toolName} for ${row.specName}, ${row.status}`,
    prompt: (row, action) => `${action === "grant" ? "Grant" : "Deny"} ${row.toolName}?`,
    perform: decide,
  });
}

async function decide(row, action, reload) {
  const grant = action === "grant";
  try {
    await (grant
      ? api.grantApproval(row.harnessId, row.id)
      : api.denyApproval(row.harnessId, row.id));
  } catch (err) {
    toast(
      `${grant ? "Grant" : "Deny"} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  toast(`${grant ? "Granted" : "Denied"} ${row.toolName}`, "info");
  reload();
}

/** One row's content. The triage shell owns the row itself (its selection,
 *  its Tab stop, the armed prompt); a decision goes through `perform`, so
 *  the shell can keep the selection across the reload it causes. */
function approvalCard(row, { perform }) {
  const gate = { enabled: row.pending, reason: `already ${row.status}` };
  return [
    el("div", { class: "inbox-head" }, [
      dot(row.dot, row.status),
      el("span", { class: "chip chip-tool", text: row.toolName }),
      el("a", { class: "name-link", href: hrefHarness(row.harnessId), text: row.specName }),
      el("span", { class: "chip", text: row.surface }),
      el("span", { class: "muted", text: row.age }),
    ]),
    // Verbatim (already masked) — the whole point of an approval screen.
    jsonPre(row.input),
    row.parkedRun !== null
      ? el("div", { class: "muted reason" }, [
          el("span", { text: "parked run " }),
          el("a", {
            class: "mono",
            href: hrefHarness(row.harnessId, "runs", row.parkedRun.runId),
            text: row.parkedRun.runId,
          }),
          el("span", { text: " · session " }),
          el("a", {
            class: "mono",
            href: hrefHarness(row.harnessId, "sessions", row.parkedRun.sessionId),
            text: row.parkedRun.sessionId,
          }),
        ])
      : null,
    row.resumeNote !== null ? el("div", { class: "muted reason", text: row.resumeNote }) : null,
    row.decidedBy !== null
      ? el("div", { class: "muted reason", text: `decided by ${row.decidedBy}` })
      : null,
    el("div", { class: "inbox-actions" }, [
      gatedBtn("Grant", gate, () => perform("grant"), "btn btn-primary"),
      gatedBtn("Deny", gate, () => perform("deny"), "btn btn-danger"),
    ]),
    el("div", { class: "inbox-twins" }, [
      actionTwin("grant", { id: row.id }),
      actionTwin("deny", { id: row.id }),
    ]),
  ];
}
