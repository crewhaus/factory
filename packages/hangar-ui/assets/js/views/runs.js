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
 * THE CONSOLE relies on the SSE grammar rather than branching on liveness:
 * `replay` (a whole RunDetail) opens every stream and `done` always closes
 * it, so a finished run replays and terminates through the same code path a
 * live one streams through. Trace events render as feed cards in the M1
 * transcript vocabulary — same chips, same folds — with interleaved prose
 * from the captured (scrubbed) log and a stats/cost HUD folded from the
 * frames as they arrive.
 */

import { api, streamRunEvents } from "../api.js";
import { clear, collapsible, dot, el, emptyState, jsonPre, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import { shapeAccent, shapeLabel } from "../shapes.js";
import {
  failureBoard,
  ledgerExit,
  procRow,
  runHud,
  runLedgerRow,
  sseFrameToFeed,
} from "../supervision.js";
import { dirTail, fmtUsd, normalizeRows } from "../util.js";
import { actionTwin } from "./control.js";
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

export async function renderRunsBoard(root) {
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

  const tbody = el("tbody");
  const table = el("div", { class: "table-scroll" }, [
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

  const reload = () => renderRunsBoard(root);
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
  if (!root.isConnected) return;
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
          style: { "--accent": shapeAccent(feedRow.target) },
          text: shapeLabel(feedRow.target),
        }),
        el("a", { class: "name-link", href: hrefHarness(feedRow.id, "runs"), text: name }),
      ]),
      el("div", { class: "sub mono", title: feedRow.dir, text: dirTail(feedRow.dir, 2) }),
      feedRow.pendingApprovals > 0
        ? el("a", {
            class: "chip chip-warn",
            href: "#/approvals",
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
    el("td", { class: "num", text: cold ? "…" : row.uptime }),
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
    el("div", { class: "table-scroll" }, [
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
 * One run's console. Opens the SSE feed, renders `replay` history and any
 * live frames into the same feed, and closes the stream when the view is
 * replaced (a navigation must not leave a reader dangling).
 */
async function renderRunConsole(root, ctx, runId) {
  clear(root);
  root.appendChild(
    el("div", { class: "crumb-line" }, [
      el("a", { href: hrefHarness(ctx.id, "runs"), text: "← runs" }),
      el("span", { class: "mono muted", text: runId }),
      actionTwin("logs", { dir: ctx.dir ?? "", runId }),
    ]),
  );

  const hudNode = el("div", { class: "hud" });
  const banner = el("div", { class: "run-banner" });
  const feed = el("div", { class: "transcript run-feed" });
  root.appendChild(hudNode);
  root.appendChild(banner);
  root.appendChild(el("div", { class: "feed-wrap" }, [feed]));

  const items = [];
  const drawHud = () => {
    const hud = runHud(items);
    clear(hudNode);
    const stat = (label, value) =>
      el("div", { class: "mini" }, [
        el("div", { class: "mini-num", text: value }),
        el("div", { class: "mini-label", text: label }),
      ]);
    hudNode.appendChild(
      el("div", { class: "mini-row" }, [
        stat("events", String(hud.events)),
        stat("turns", String(hud.turns)),
        stat(
          "tool calls",
          `${hud.tools}${hud.toolErrors > 0 ? ` / ${hud.toolErrors} failed` : ""}`,
        ),
        stat("cost", fmtUsd(hud.costUsd)),
        stat("tokens in/out", `${hud.inputTokens}/${hud.outputTokens}`),
      ]),
    );
  };
  drawHud();

  let done = false;
  const push = (item) => {
    items.push(item);
    feed.appendChild(feedNode(item));
    if (item.type === "exit" && item.banner !== null) {
      clear(banner).appendChild(exitBannerNode(item.banner));
    }
    if (item.type === "done") {
      done = true;
      banner.appendChild(el("span", { class: "chip", text: `stream closed — ${item.detail}` }));
    }
  };

  // The stream is bound to this node: the first frame that arrives after the
  // router replaced the view aborts the reader instead of leaving it holding
  // a connection.
  const stream = streamRunEvents(ctx.id, runId, (frame) => {
    if (!feed.isConnected) {
      stream.close();
      return;
    }
    if (frame.event === "error") {
      const message = frame.data?.message ? String(frame.data.message) : "stream failed";
      clear(banner).appendChild(dot("bad", message));
      return;
    }
    if (frame.event === "closed") {
      // Only worth saying when the server never sent its terminal `done` —
      // that is the difference between "finished" and "dropped".
      if (!done) {
        banner.appendChild(el("span", { class: "chip chip-warn", text: "connection dropped" }));
      }
      return;
    }
    for (const item of sseFrameToFeed(frame.event, frame.data)) push(item);
    drawHud();
  });
}

function exitBannerNode(banner) {
  return el("div", { class: "exit-banner" }, [
    dot(banner.dot, banner.title),
    banner.classLabel !== null
      ? el("span", { class: "chip chip-warn", text: banner.classLabel })
      : null,
    banner.exitCode !== null
      ? el("span", { class: "chip", text: `exit ${banner.exitCode}` })
      : null,
    banner.restartable
      ? el("span", { class: "chip", text: "restartable" })
      : el("span", { class: "chip chip-warn", text: "will not auto-restart" }),
    banner.remediation !== null
      ? el("div", { class: "muted reason", text: banner.remediation })
      : null,
  ]);
}

/** One feed item → its card, in the M1 transcript vocabulary. */
function feedNode(item) {
  if (item.type === "prose") {
    return el("pre", { class: "prose-pre feed-prose", text: item.lines.join("\n") });
  }
  if (item.type === "marker") {
    return el("div", { class: "gutter" }, [
      el("span", { class: "chip", text: item.title }),
      item.detail ? el("span", { class: "muted", text: item.detail }) : null,
    ]);
  }
  if (item.type === "state") {
    return el("div", { class: "gutter" }, [dot(item.dot, item.title)]);
  }
  if (item.type === "exit") {
    return el("div", { class: "gutter" }, [dot(item.dot, `exited — ${item.title}`)]);
  }
  if (item.type === "done") {
    return el("div", { class: "gutter" }, [
      el("span", { class: "chip", text: "done" }),
      el("span", { class: "muted", text: item.detail }),
    ]);
  }
  // A trace event: a fold whose summary reads at a glance and whose body is
  // the raw (already masked + scrubbed) payload.
  return collapsible(
    [
      el("span", { class: "chip chip-tool", text: item.kind }),
      item.dot !== null ? dot(item.dot, item.title) : el("span", { text: item.title }),
      el("span", { class: "muted tool-summary", text: item.detail ?? "" }),
    ],
    [
      item.remediation ? el("p", null, [el("strong", { text: "Fix: " }), item.remediation]) : null,
      jsonPre(item.payload),
    ],
  );
}
