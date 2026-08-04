/**
 * The approvals inbox — every harness's parked tool-approval requests folded
 * into one triage list.
 *
 * THE INPUT IS SHOWN VERBATIM (the server masked credential shapes on the
 * way out, and nothing else): an approver cannot judge a call they cannot
 * see, so the tool input renders in full rather than as a hash or a summary.
 *
 * Triage is keyboard-first — j/k to move, g/d to grant/deny, `.` for the row
 * menu, `?` for the bindings — because an inbox with twenty parked calls is
 * a keyboard task. Granting a request whose run PARKED also resumes it: the
 * row says so, because "what happens after I click" is the question an
 * approver actually has.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, jsonPre, skeleton, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { APPROVAL_KEYS, approvalRow } from "../supervision.js";
import { actionTwin, gatedBtn } from "./control.js";
import { mountTriage } from "./inbox.js";

export async function renderApprovals(root) {
  clear(root).appendChild(skeleton(6));
  await draw(root, false);
}

async function draw(host, showSettled) {
  let payload;
  try {
    payload = await api.approvals(showSettled);
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
  const rows = (payload && Array.isArray(payload.approvals) ? payload.approvals : []).map((r) =>
    approvalRow(r, nowMs),
  );
  const pending = payload && typeof payload.pending === "number" ? payload.pending : 0;
  const truncated =
    payload && Array.isArray(payload.truncatedHarnesses) ? payload.truncatedHarnesses : [];
  const reload = () => draw(host, showSettled);

  host.appendChild(
    el("div", { class: "toolbar" }, [
      el("span", { class: "rollup", text: `${pending} pending · ${rows.length} shown` }),
      el("span", { class: "spacer" }),
      el("button", {
        class: `btn btn-ghost${showSettled ? " active" : ""}`,
        type: "button",
        text: showSettled ? "Showing settled too" : "Show settled",
        onClick: () => draw(host, !showSettled),
      }),
    ]),
  );
  if (truncated.length > 0) {
    host.appendChild(
      el("p", {
        class: "muted",
        text: `${truncated.length} harness log${truncated.length === 1 ? " was" : "s were"} capped mid-read — older entries are not shown.`,
      }),
    );
  }
  if (rows.length === 0) {
    host.appendChild(
      emptyState(
        showSettled ? "No approvals recorded on this fleet" : "Nothing waiting for a decision",
        "crewhaus approvals list",
      ),
    );
    return;
  }
  mountTriage(host, rows, {
    keys: APPROVAL_KEYS,
    reload,
    render: approvalCard,
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

function approvalCard(row, index, state, redraw, reload) {
  const selected = state.index === index;
  const gate = { enabled: row.pending, reason: `already ${row.status}` };
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
        gatedBtn("Grant", gate, () => decide(row, "grant", reload), "btn btn-primary"),
        gatedBtn("Deny", gate, () => decide(row, "deny", reload), "btn btn-danger"),
      ]),
      el("div", { class: "inbox-twins" }, [
        actionTwin("grant", { id: row.id }),
        actionTwin("deny", { id: row.id }),
      ]),
    ],
  );
}
