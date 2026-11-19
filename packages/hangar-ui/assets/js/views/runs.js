/**
 * Runs & daemons — the fleet supervision board (`#/runs`), one harness's run
 * ledger, and the run console with the live SSE feed.
 *
 * THE BOARD paints twice, like the Library: instantly from the fleet feed
 * (whose rows carry `supervision` and `pendingApprovals` — a cheap fold, no
 * transcript opened), then again as each harness's `/proc` answers with pid,
 * uptime, restart countdown, control availability and last exit. Under the
 * table sit the two fleet-level reads an operator actually acts on: the job
 * queue, and the failure board that turns three red rows into one incident.
 *
 * THE CONSOLE is the run view (`../runview/index.js`): one feed for Home's own
 * run stream and the versioned API's, with filters, a window, follow mode, the
 * markers a stream says about itself, and a reconnect that resumes where it
 * stopped.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, scrollRegion, skeleton, toast } from "../dom.js";
import { actionBar } from "../inspect/actions.js";
import { hrefGlobal, hrefHarness } from "../router.js";
import { mountRunView } from "../runview/index.js";
import { shapeAccentVars, shapeLabel } from "../shapes.js";
import { failureBoard, ledgerExit, procRow, runLedgerRow, uptimeLabel } from "../supervision.js";
import { timeEl } from "../ui/time.js";
import { APPROVALS_UNKNOWN, dirTail, normalizeRows } from "../util.js";
import { HOME_WIDE, actionTwin, writeTwin } from "./control.js";
import { renderJobs } from "./jobs.js";
import { procActionBar } from "./proc.js";

// ---------------------------------------------------------------------------
// #/runs — the fleet board
// ---------------------------------------------------------------------------

const BOARD_COLUMNS = [
  "Harness",
  "State",
  "PID",
  "Uptime",
  "Restarts",
  "Last exit",
  "Control",
  "Actions",
];

export async function renderRunsBoard(root, ctx = {}) {
  clear(root).appendChild(skeleton(6));
  const feed = await api.harnesses();
  const rows = normalizeRows(feed).filter((r) => r.missingSince === null);
  clear(root);
  root.appendChild(
    el("div", { class: "rollup" }, [
      el("span", { text: `${rows.length} registered · supervision board` }),
      el("span", { class: "muted", text: "· loading process detail…" }),
    ]),
  );
  if (rows.length === 0) {
    root.appendChild(emptyState("No harnesses registered yet", "crewhaus harness add <dir>"));
    return;
  }

  // Groups first: a fleet is brought up as a fleet, in the order its members
  // declare, and doing that a row at a time was N clicks in an order the
  // operator had to remember.
  const groupsCard = el("section", { class: "card" });
  root.appendChild(groupsCard);
  void renderGroupStrip(groupsCard, () => renderRunsBoard(root, ctx));

  const tbody = el("tbody");
  const table = scrollRegion("Harness processes", [
    el("table", { class: "fleet" }, [
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          BOARD_COLUMNS.map((h) => el("th", { text: h })),
        ),
      ),
      tbody,
    ]),
  ]);
  root.appendChild(table);

  const failures = el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "Failure board" }),
    el("p", { class: "muted", text: "loading…" }),
  ]);
  const jobsCard = el("section", { class: "card" }, [
    el("h3", { class: "card-title", text: "Job queue" }),
  ]);
  const jobsBody = el("div");
  jobsCard.appendChild(jobsBody);
  root.appendChild(el("div", { class: "ov-grid" }, [failures, jobsCard]));
  renderJobs(jobsBody);

  const reload = () => renderRunsBoard(root, ctx);
  const nowMs = Date.now();
  const placeholders = new Map();
  for (const row of rows) {
    const tr = boardRow(row, null, nowMs, reload);
    placeholders.set(row.id, tr);
    tbody.appendChild(tr);
  }

  // Hydrate each row with its process detail. One request per harness, all
  // in flight together; a failing one leaves its cold row standing.
  const details = await Promise.allSettled(rows.map((r) => api.proc(r.id)));
  if (ctx.signal?.aborted === true) return;
  const exits = [];
  rows.forEach((row, i) => {
    const settled = details[i];
    const payload = settled.status === "fulfilled" ? settled.value : null;
    const tr = placeholders.get(row.id);
    if (tr === undefined) return;
    tr.replaceWith(boardRow(row, payload, Date.now(), reload));
    // The live snapshot when this manager supervised the run; the harness's
    // own ledger when it did not (a console restart must not erase failures).
    const exit = payload === null ? null : (payload.lastExit ?? ledgerExit(payload.recentRuns));
    if (exit !== null) {
      exits.push({ id: row.id, name: row.specName || dirTail(row.dir, 1), lastExit: exit });
    }
  });
  const rollup = root.querySelector(".rollup .muted");
  if (rollup !== null) rollup.remove();
  clear(failures).appendChild(el("h3", { class: "card-title", text: "Failure board" }));
  const groups = failureBoard(exits);
  if (groups.length === 0) {
    failures.appendChild(
      el("p", { class: "muted", text: "No harness has a failing last exit — nothing to group." }),
    );
  } else {
    for (const group of groups) {
      failures.appendChild(
        el("div", { class: "fail-group" }, [
          el("div", { class: "fail-head" }, [
            dot(group.dot, group.label),
            // The classification's own sentence, when it says more than the
            // count line already does.
            group.title !== "" && !group.label.includes(group.title)
              ? el("span", { class: "muted", text: group.title })
              : null,
          ]),
          group.remediation !== null
            ? el("div", { class: "muted reason", text: group.remediation })
            : null,
          el(
            "div",
            { class: "fail-members" },
            group.harnesses.map((h) =>
              el("a", { class: "chip", href: hrefHarness(h.id, "runs"), text: h.name }),
            ),
          ),
        ]),
      );
    }
  }
}

/**
 * The group strip — group-ordered bulk lifecycle, PLAN FIRST.
 *
 * A fleet has dependency order (the secretary everyone's A2A door mounts
 * boots first; the chief that supervises the rest last), and the board was
 * per-row Start/Stop, so bringing one up was N clicks in an order the
 * operator had to remember. Clicking a verb here does NOT act: it fetches
 * the walk and renders it, in order, with every skip named — and only the
 * second click runs it. A sweep that touches a whole fleet should be
 * readable before it is authorized.
 */
async function renderGroupStrip(card, reload) {
  clear(card).appendChild(el("h3", { class: "card-title", text: "Groups" }));
  let groups = [];
  try {
    groups = (await api.groups())?.groups ?? [];
  } catch {
    // The board is the point; a registry read that fails leaves the strip
    // out rather than taking the page down.
    card.remove();
    return;
  }
  if (groups.length === 0) {
    card.appendChild(
      emptyState("No groups yet", "crewhaus harness group <name> --add <dir> --member-order <n>"),
    );
    return;
  }
  for (const group of groups) {
    const body = el("div", { class: "muted", text: "pick a verb to see the planned order" });
    card.appendChild(
      el("div", { class: "group-row" }, [
        el("div", { class: "row-head" }, [
          el("strong", { text: group.name }),
          el("span", { class: "muted", text: `order ${group.order}` }),
          ...["start", "restart", "stop"].map((verb) =>
            el("button", {
              class: "btn",
              text: verb,
              onclick: () => void showGroupPlan(body, group.name, verb, reload),
            }),
          ),
        ]),
        body,
      ]),
    );
  }
}

/** Render the walk a verb WOULD take, with a confirm that runs it. */
async function showGroupPlan(body, name, verb, reload) {
  clear(body).appendChild(el("p", { class: "muted", text: "planning…" }));
  let plan = null;
  try {
    plan = (await api.groupProcPlan(name, verb))?.plan ?? null;
  } catch (err) {
    clear(body).appendChild(el("p", { class: "error", text: String(err?.message ?? err) }));
    return;
  }
  if (plan === null || plan.members.length === 0) {
    clear(body).appendChild(el("p", { class: "muted", text: `group ${name} has no members` }));
    return;
  }
  clear(body);
  body.appendChild(
    el("p", {
      text: `${verb} would walk ${plan.actionable} member(s)${
        verb === "stop" ? " in REVERSE boot order" : " in boot order"
      }${plan.skipped > 0 ? `, skipping ${plan.skipped}` : ""}:`,
    }),
  );
  body.appendChild(
    el(
      "ol",
      { class: "plan-list" },
      plan.members.map((m) =>
        el("li", null, [
          el("span", { text: `${m.specName} (${m.target})` }),
          m.declaredOrder === null
            ? el("span", { class: "muted", text: " no declared order" })
            : null,
          m.skip === null ? null : el("span", { class: "muted", text: ` — skipped: ${m.skip}` }),
        ]),
      ),
    ),
  );
  const run = el("button", {
    class: "btn btn-primary",
    text: `run ${verb} on ${plan.actionable} member(s)`,
    onclick: async () => {
      run.disabled = true;
      run.textContent = `${verb}ing…`;
      try {
        const result = (await api.groupProc(name, verb))?.result ?? null;
        toast(
          result === null
            ? `${verb} ${name}: no result`
            : `${verb} ${name}: ${result.ok} ok, ${result.failed} failed${
                result.skipped > 0 ? `, ${result.skipped} skipped` : ""
              }`,
          result !== null && result.failed === 0 ? "ok" : "error",
        );
        reload();
      } catch (err) {
        toast(String(err?.message ?? err), "error");
        run.disabled = false;
        run.textContent = `run ${verb} on ${plan.actionable} member(s)`;
      }
    },
  });
  body.appendChild(run);
  body.appendChild(writeTwin("groupProc", HOME_WIDE, "Run on the group"));
}

function boardRow(feedRow, proc, nowMs, reload) {
  const name = feedRow.specName || dirTail(feedRow.dir, 1) || feedRow.id;
  // The fleet feed's `supervision` is the instant answer; `/proc` refines it.
  const row = procRow(proc ?? { state: feedRow.supervision ?? "stopped" }, nowMs);
  const cold = proc === null;
  return el("tr", { class: "fleet-row" }, [
    el("td", { class: "cell-name" }, [
      el("div", { class: "name-line" }, [
        el("span", {
          class: "shape-badge",
          "data-shape-accent": "",
          style: shapeAccentVars(feedRow.target),
          text: shapeLabel(feedRow.target),
        }),
        el("a", { class: "name-link", href: hrefHarness(feedRow.id, "runs"), text: name }),
      ]),
      el("div", { class: "sub mono", title: feedRow.dir, text: dirTail(feedRow.dir, 2) }),
      feedRow.approvalsUnreachable
        ? el("span", {
            class: "chip chip-warn",
            title: "Its sessions folder is outside its folder, so its approvals can't be read.",
            text: APPROVALS_UNKNOWN,
          })
        : feedRow.pendingApprovals > 0
          ? el("a", {
              class: "chip chip-warn",
              href: hrefGlobal("approvals"),
              text: `${feedRow.pendingApprovals} approval${feedRow.pendingApprovals === 1 ? "" : "s"} waiting`,
            })
          : null,
    ]),
    el("td", null, [
      dot(row.pill.dot, row.pill.label),
      row.adopted ? el("span", { class: "chip", text: "adopted" }) : null,
      row.draining ? el("span", { class: "chip chip-warn", text: "draining" }) : null,
    ]),
    el("td", { class: "num", text: row.pid === null ? "—" : String(row.pid) }),
    // A running process's uptime keeps counting, from the shared ticker.
    el("td", { class: "num" }, [
      cold
        ? "…"
        : typeof proc?.startedAt === "string" && row.uptime !== "—"
          ? timeEl(proc.startedAt, { format: (iso, nowMs) => uptimeLabel(iso, nowMs) })
          : row.uptime,
    ]),
    el("td", { class: "num" }, [
      el("span", { text: String(row.restartsInWindow) }),
      row.restart !== null ? el("div", { class: "chip chip-warn", text: row.restart.label }) : null,
    ]),
    el("td", null, [
      row.lastExit === null
        ? el("span", { class: "muted", text: cold ? "…" : "—" })
        : el("span", null, [
            dot(row.lastExit.dot, row.lastExit.title),
            row.lastExit.classLabel !== null
              ? el("span", { class: "chip chip-warn", text: row.lastExit.classLabel })
              : null,
            row.lastExit.fromLedger
              ? el("span", {
                  class: "chip",
                  title: "recorded in the harness's run ledger, not observed by this manager",
                  text: "from the ledger",
                })
              : null,
          ]),
    ]),
    el("td", null, [
      dot(row.control.dot, row.control.label),
      !row.control.available && row.control.reason !== null
        ? el("div", { class: "muted reason", text: row.control.reason })
        : null,
    ]),
    el("td", { class: "cell-actions" }, [
      cold
        ? el("span", { class: "muted", text: "…" })
        : procActionBar(feedRow.id, feedRow.dir, row, reload),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// #/h/:id/runs — the ledger, and one run's console
// ---------------------------------------------------------------------------

export async function renderRuns(root, ctx) {
  if (ctx.route.runId !== undefined) {
    await renderRunConsole(root, ctx, ctx.route.runId);
    return;
  }
  clear(root).appendChild(skeleton(6));
  const [procRes, runsRes] = await Promise.allSettled([api.proc(ctx.id), api.runs(ctx.id)]);
  clear(root);
  const reload = () => renderRuns(root, ctx);

  if (procRes.status === "fulfilled" && procRes.value !== null) {
    const row = procRow(procRes.value, Date.now());
    root.appendChild(
      el("section", { class: "card" }, [
        el("h3", { class: "card-title" }, [
          el("span", { text: "Supervision" }),
          dot(row.pill.dot, row.pill.label),
          row.runId !== null
            ? el("a", {
                class: "mono",
                href: hrefHarness(ctx.id, "runs", row.runId),
                text: "watch the live run →",
              })
            : null,
        ]),
        procActionBar(ctx.id, ctx.dir ?? "", row, reload),
      ]),
    );
  }

  const data = runsRes.status === "fulfilled" ? runsRes.value : null;
  const runs = data && Array.isArray(data.runs) ? data.runs : [];
  if (runs.length === 0) {
    root.appendChild(emptyState("No runs recorded yet", "crewhaus daemon start"));
    return;
  }
  const nowMs = Date.now();
  const tbody = el("tbody");
  for (const entry of runs) {
    const row = runLedgerRow(entry, nowMs);
    tbody.appendChild(
      el("tr", null, [
        el("td", null, [
          el("a", {
            class: "mono name-link",
            href: hrefHarness(ctx.id, "runs", row.runId),
            text: row.runId,
          }),
          actionBar({
            ref: `${ctx.id}/${/^run_[0-9a-f]{16}$/.test(row.runId) ? "exec" : "run"}/${row.runId}`,
            label: `run ${row.runId}`,
            ...(typeof ctx.dir === "string" && ctx.dir !== "" ? { dir: ctx.dir } : {}),
            operation: { id: "runs.get", params: { run: row.runId }, query: { harness: ctx.id } },
          }),
        ]),
        el("td", { class: "mono", text: row.kind }),
        el("td", { text: row.startedLabel }),
        el("td", { class: "num", text: row.duration }),
        el("td", null, [
          dot(row.dot, row.exitLabel),
          row.forced ? el("span", { class: "chip chip-warn", text: "forced" }) : null,
        ]),
      ]),
    );
  }
  root.appendChild(
    scrollRegion("Run history", [
      el("table", { class: "fleet" }, [
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            ["Run", "Kind", "Started", "Duration", "Outcome"].map((h) => el("th", { text: h })),
          ),
        ),
        tbody,
      ]),
    ]),
  );
  if (data && data.truncated === true) {
    root.appendChild(
      el("p", { class: "muted", text: "Long ledger — showing the most recent runs only." }),
    );
  }
}

/**
 * One run's console, drawn by the run view (`../runview/index.js`): its state
 * in words, the harness, the spec revision, the cost so far, and its events,
 * live. The stream closes when the view is replaced: a navigation never leaves
 * a reader holding a connection.
 */
async function renderRunConsole(root, ctx, runId) {
  clear(root);
  const ref = `${ctx.id}/${/^run_[0-9a-f]{16}$/.test(runId) ? "exec" : "run"}/${runId}`;
  root.appendChild(
    el("div", { class: "crumb-line" }, [
      el("a", { href: hrefHarness(ctx.id, "runs"), text: "← runs" }),
      el("span", { class: "mono muted", text: runId }),
      actionTwin("logs", { dir: ctx.dir ?? "", runId }),
      actionBar({
        ref,
        label: `run ${runId}`,
        ...(typeof ctx.dir === "string" ? { dir: ctx.dir } : {}),
        operation: { id: "runs.get", params: { run: runId }, query: { harness: ctx.id } },
      }),
    ]),
  );
  const host = el("section", { class: "run-view", "aria-label": "Run events" });
  root.appendChild(host);
  mountRunView(host, {
    harness: ctx.id,
    run: runId,
    harnessName: String(ctx.detail?.inventory?.specName ?? ctx.detail?.entry?.specName ?? ctx.id),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
  });
}
