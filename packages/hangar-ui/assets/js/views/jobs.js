/**
 * The global job queue — running, pending, and interrupted work.
 *
 * `interrupted` is the row that matters most and appears least: a job that
 * was RUNNING when the previous manager died is closed as interrupted at the
 * next boot rather than silently re-run, because a half-finished `compile`
 * or `eval` re-run without an operator's say-so is how a console loses
 * someone's afternoon. The panel says so rather than hiding an empty group.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, skeleton, toast } from "../dom.js";
import { JOB_COMMANDS, jobQueueModel, jobRow } from "../supervision.js";
import { cliTwin, runAction } from "./control.js";

/** Submit one job and report it — the shared path for every action face. */
export async function submitJob(btn, id, kind, options, onOk) {
  return runAction(
    btn,
    kind,
    () => api.submitJob(id, kind, options),
    (result) => {
      const jobId = typeof result?.job?.jobId === "string" ? result.job.jobId : "";
      toast(`Queued ${kind}${jobId !== "" ? ` (${jobId})` : ""}`, "info");
      if (onOk) onOk(result);
    },
  );
}

/** A button that enqueues a job and shows the command it will run. */
export function jobButton(label, id, kind, options, onOk) {
  const btn = el("button", { class: "btn", type: "button", text: label });
  btn.addEventListener("click", () => submitJob(btn, id, kind, options, onOk));
  return el("div", { class: "job-action" }, [btn, cliTwin(JOB_COMMANDS[kind] ?? null)]);
}

function jobsTable(rows) {
  const tbody = el("tbody");
  for (const row of rows) {
    tbody.appendChild(
      el("tr", null, [
        el("td", null, [dot(row.dot, row.state)]),
        el("td", { class: "mono", text: row.kind }),
        el("td", { class: "mono sub", title: row.harnessDir, text: row.harnessDir }),
        el("td", { class: "mono", text: row.argv.join(" ") }),
        el("td", null, [
          el("span", { text: row.enqueued }),
          row.mutating ? el("span", { class: "chip chip-warn", text: "mutating" }) : null,
        ]),
        el("td", { class: "muted", text: row.error ?? "" }),
      ]),
    );
  }
  return el("div", { class: "table-scroll" }, [
    el("table", { class: "fleet" }, [
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          ["State", "Kind", "Harness", "Command", "Queued", "Error"].map((h) =>
            el("th", { text: h }),
          ),
        ),
      ),
      tbody,
    ]),
  ]);
}

/** Render the queue panel into `root` (it loads itself). */
export async function renderJobs(root) {
  clear(root).appendChild(skeleton(3));
  let payload;
  try {
    payload = await api.jobs();
  } catch (err) {
    clear(root).appendChild(
      el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  const nowMs = Date.now();
  const model = jobQueueModel(payload);
  clear(root);
  if (model.total === 0) {
    root.appendChild(emptyState("No jobs queued", "crewhaus doctor (or Run now on any harness)"));
    return;
  }
  const section = (title, jobs, note) => {
    if (jobs.length === 0) return null;
    return el("div", { class: "job-group" }, [
      el("h4", { class: "sub-title", text: `${title} · ${jobs.length}` }),
      note ? el("p", { class: "muted", text: note }) : null,
      jobsTable(jobs.map((j) => jobRow(j, nowMs))),
    ]);
  };
  root.appendChild(
    el("div", { class: "job-groups" }, [
      section("Running", model.running),
      section("Pending", model.pending),
      section(
        "Interrupted",
        model.interrupted,
        "these were running when a manager died — closed at boot, never silently re-run",
      ),
    ]),
  );
}
