/**
 * The process card and the Start / Stop / Restart / Drain action bar — the
 * console's first real verbs.
 *
 * The whole screen is built around one idea: a refusal is information. A
 * start that preflight blocks opens a modal listing every finding with its
 * remediation (and offers "Start anyway" only when every finding is
 * acknowledgeable); a spawn plan that cannot be built renders its remedy as
 * a BUTTON; a bundle says whether its freshness verdict was hash-exact or a
 * file-time approximation. Nothing here is a bare error toast.
 */

import { api } from "../api.js";
import { clear, collapsible, dot, el, jsonPre, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { procRow, procWriteOutcome, refusalModel } from "../supervision.js";
import { actionTwin, cliTwin, gatedBtn, refusalModal, runAction } from "./control.js";

/**
 * Report what a Stop / Drain actually did, then reload.
 *
 * A 200 is not the same as a stop. The supervisor answers `not-adopted` when
 * it held no pid while a live runfile existed — a daemon IS running, this
 * manager just never adopted it, and nothing was signalled. Reloading
 * silently there would paint the row from a snapshot that agrees the daemon
 * is "stopped", which is precisely the lie this reports instead.
 */
function reportProcWrite(res, label, reload) {
  const outcome = procWriteOutcome(res, label);
  if (outcome.message !== null) toast(outcome.message, outcome.tone);
  reload();
}

/**
 * Start (or restart) a harness, routing the typed 409 to the refusal modal.
 * `opts` carries `{ force, acknowledge }` on the second pass.
 */
export async function startProc(id, dir, opts, restart, reload) {
  let res;
  try {
    res = restart ? await api.procRestart(id, opts) : await api.procStart(id, opts);
  } catch (err) {
    toast(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (res.ok) {
    reload();
    return;
  }
  if (res.status !== 409) {
    toast(`Start failed: ${res.body?.message ?? `HTTP ${res.status}`}`);
    return;
  }
  const model = refusalModel(res.body);
  refusalModal(model, {
    dir,
    onForce: (acknowledge) => {
      // `force` waves every FORCEABLE finding through; the id list keeps the
      // audit trail honest about which ones an operator accepted.
      startProc(id, dir, { force: true, acknowledge }, restart, reload);
    },
    onRemedy: async (kind) => {
      try {
        await api.submitJob(id, kind);
        toast(`Queued ${kind} — watch it in the job queue`, "info");
        reload();
      } catch (err) {
        toast(`Could not queue ${kind}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

/** Start / Stop / Restart / Drain, each disabled with its reason. */
export function procActionBar(id, dir, row, reload) {
  const bar = el("div", { class: "proc-actions" });
  const twinHost = el("div", { class: "proc-twin" });
  const showTwin = (action) => {
    clear(twinHost).appendChild(actionTwin(action, { dir }) ?? el("span"));
  };

  const startBtn = gatedBtn(
    "Start",
    row.actions.start,
    () => startProc(id, dir, {}, false, reload),
    "btn btn-primary",
  );
  const stopBtn = gatedBtn("Stop", row.actions.stop, () => {
    runAction(
      stopBtn,
      "Stop",
      () => api.procStop(id),
      (res) => reportProcWrite(res, "Stop", reload),
    );
  });
  const restartBtn = gatedBtn("Restart", row.actions.restart, () =>
    startProc(id, dir, {}, true, reload),
  );
  const drainBtn = gatedBtn("Drain", row.actions.drain, () => {
    // A drain has three endings — drained, drained by SIGTERM because no
    // control plane answered, and nothing-was-signalled — and only the first
    // deserves silence.
    runAction(
      drainBtn,
      "Drain",
      () => api.procDrain(id),
      (res) => reportProcWrite(res, "Drain", reload),
    );
  });

  for (const [btn, action] of [
    [startBtn, "start"],
    [stopBtn, "stop"],
    [restartBtn, "restart"],
    [drainBtn, "drain"],
  ]) {
    btn.addEventListener("mouseenter", () => showTwin(action));
    btn.addEventListener("focus", () => showTwin(action));
    bar.appendChild(btn);
  }
  showTwin(row.state === "running" ? "stop" : "start");

  // A plan that cannot be built has an obvious next step — offer it.
  const planError = row.launch.error;
  if (planError !== null && planError.action !== null) {
    const remedy = el("button", {
      class: "btn",
      type: "button",
      text: planError.action.label,
      title: planError.action.hint,
    });
    if (planError.action.jobKind === null) {
      remedy.disabled = true;
    } else {
      remedy.addEventListener("click", () => {
        runAction(
          remedy,
          planError.action.label,
          () => api.submitJob(id, planError.action.jobKind),
          () => {
            toast(`Queued ${planError.action.jobKind}`, "info");
            reload();
          },
        );
      });
    }
    bar.appendChild(remedy);
  }

  const reasons = el("div", { class: "proc-reasons" });
  for (const [label, gate] of Object.entries(row.actions)) {
    if (gate.enabled || !gate.reason) continue;
    reasons.appendChild(el("div", { class: "muted gated-why", text: `${label}: ${gate.reason}` }));
  }
  return el("div", { class: "proc-bar" }, [bar, twinHost, reasons]);
}

/** The full process card: state, identity, restarts, last exit, launch plan. */
export function procCard(payload, ctx, reload) {
  const nowMs = Date.now();
  const row = procRow(payload, nowMs);
  const dir = ctx.dir ?? "";
  const kv = (k, v) =>
    el("div", { class: "kv" }, [
      el("span", { class: "kv-k", text: k }),
      typeof v === "string"
        ? el("span", { class: "kv-v", text: v })
        : el("span", { class: "kv-v" }, [v]),
    ]);

  const facts = el("div", { class: "proc-facts" }, [
    kv("state", el("span", null, [dot(row.pill.dot, row.pill.label)])),
    row.pill.note !== "" ? kv("", el("span", { class: "muted", text: row.pill.note })) : null,
    kv("pid", row.pid === null ? "—" : String(row.pid)),
    kv("uptime", row.uptime),
    kv("run", row.runId === null ? "—" : row.runId),
    kv("run class", row.runClass || "—"),
    kv(
      "restarts",
      el("span", null, [
        el("span", { text: String(row.restartsInWindow) }),
        row.restart !== null
          ? el("span", { class: "chip chip-warn", text: row.restart.label })
          : null,
      ]),
    ),
    kv(
      "control",
      el("span", null, [
        dot(row.control.dot, row.control.label),
        row.control.reason !== null
          ? el("div", { class: "muted reason", text: row.control.reason })
          : null,
      ]),
    ),
    kv(
      "bundle",
      el("span", null, [
        dot(row.bundle.dot, row.bundle.label),
        el("div", { class: "muted reason", text: row.bundle.precision }),
        row.bundle.compiledWith !== null
          ? el("div", { class: "muted reason", text: `compiled with ${row.bundle.compiledWith}` })
          : null,
      ]),
    ),
  ]);

  const children = [facts, procActionBar(ctx.id, dir, row, reload)];

  if (row.lastExit !== null) {
    children.push(
      el("div", { class: "exit-banner" }, [
        dot(row.lastExit.dot, row.lastExit.title),
        row.lastExit.classLabel !== null
          ? el("span", { class: "chip chip-warn", text: row.lastExit.classLabel })
          : null,
        row.lastExit.exitCode !== null
          ? el("span", { class: "chip", text: `exit ${row.lastExit.exitCode}` })
          : null,
        row.lastExit.fromLedger ? el("span", { class: "chip", text: "from the run ledger" }) : null,
        row.lastExit.remediation !== null
          ? el("div", { class: "muted reason", text: row.lastExit.remediation })
          : null,
      ]),
    );
  }
  if (row.forensics !== null) {
    const tail = Array.isArray(row.forensics.tail) ? row.forensics.tail : [];
    children.push(
      collapsible(
        [el("span", { class: "muted", text: "forensics from the last failure" })],
        [
          row.forensics.lastRunFailed
            ? jsonPre(row.forensics.lastRunFailed)
            : el("pre", { class: "prose-pre", text: tail.join("\n") || "no captured tail" }),
        ],
      ),
    );
  }

  // What Start would actually spawn — the plan preview, never the env (which
  // carries the control token).
  if (row.launch.cliTwin !== null) {
    children.push(
      collapsible(
        [
          el("span", { class: "muted", text: `launch: ${row.launch.mode ?? "?"}` }),
          row.launch.canResume ? el("span", { class: "chip", text: "resumable" }) : null,
          row.launch.detached ? el("span", { class: "chip", text: "detached" }) : null,
        ],
        [
          cliTwin(row.launch.cliTwin),
          row.launch.envFiles.length > 0
            ? el("div", {
                class: "muted reason",
                text: `env chain: ${row.launch.envFiles.join(", ")}`,
              })
            : null,
        ],
      ),
    );
  } else if (row.launch.error !== null) {
    children.push(el("p", { class: "muted", text: row.launch.error.message }));
  }

  children.push(
    el("div", { class: "proc-links" }, [
      el("a", { href: hrefHarness(ctx.id, "runs"), text: "run history →" }),
      el("a", { href: hrefHarness(ctx.id, "schedulers"), text: "schedulers →" }),
    ]),
  );

  return el("section", { class: "card ov-card ov-wide" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Process" }),
      el("span", { class: "muted card-sub", text: row.target }),
    ]),
    ...children,
  ]);
}
