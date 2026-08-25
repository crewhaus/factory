/**
 * M5 — the Advisor: every alert, suggestion and optimization signal about a
 * harness on ONE screen, each item explained (hover for the why), each with
 * its quick action (a queued CLI verb or a deep link), and each decision
 * recorded — acting takes an optional comment, dismissing REQUIRES a reason,
 * and a dismissal can always be reopened.
 *
 * Two surfaces:
 *   - the per-harness tab (`#/h/<id>/advisor`): the feed, the improvement
 *     trend, the reports panel, and the issue inbox that turns a complaint
 *     into an update ready to run;
 *   - the fleet board (`#/advisor`): every harness's rollup, worst first.
 *
 * The pure decisions (row model, severity dot, action face, trend bars) are
 * exported for unit tests; the render functions are thin DOM builders over
 * them, in the M2 tradition.
 */

import { api } from "../api.js";
import {
  clear,
  collapsible,
  dot,
  el,
  emptyState,
  jsonPre,
  skeleton,
  tipIcon,
  toast,
  withTip,
} from "../dom.js";
import { hrefGlobal, hrefHarness } from "../router.js";

/** severity → the traffic-light dot state (always paired with text). */
export function severityDot(severity) {
  if (severity === "critical") return "bad";
  if (severity === "warn") return "warn";
  return "unknown";
}

/**
 * One item → what its action face renders. Pure.
 *   { kind: "job", label, cliTwin }        an executable button
 *   { kind: "link", label, href, cliTwin } a deep link
 *   { kind: "none", label }                guidance only — still says so
 */
export function itemActionModel(item, id) {
  const action =
    item && typeof item.action === "object" && item.action !== null ? item.action : null;
  if (action === null) return { kind: "none", label: "no quick action — see the guidance" };
  if (action.kind === "job" && typeof action.jobKind === "string") {
    return {
      kind: "job",
      label: String(action.label ?? "Run"),
      cliTwin: typeof action.cliTwin === "string" ? action.cliTwin : null,
    };
  }
  const screen = String(item.screen ?? "overview");
  // Fleet screens (the approvals inbox) are global; everything else is a tab
  // on this harness.
  const href = screen === "approvals" ? hrefGlobal("approvals") : hrefHarness(id, screen);
  return {
    kind: "link",
    label: String(action.label ?? `Open ${screen}`),
    href,
    cliTwin: typeof action.cliTwin === "string" ? action.cliTwin : null,
  };
}

/** Fleet payload → board rows, worst first (ties by name, stable). Pure. */
export function rankAdvisorRows(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const rows = Array.isArray(body.harnesses) ? body.harnesses : [];
  return rows
    .map((row) => ({
      id: String(row?.id ?? ""),
      specName: String(row?.specName ?? row?.id ?? ""),
      open: typeof row?.open === "number" ? row.open : 0,
      critical: typeof row?.critical === "number" ? row.critical : 0,
      warn: typeof row?.warn === "number" ? row.warn : 0,
      suggestion: typeof row?.suggestion === "number" ? row.suggestion : 0,
      optimal: row?.optimal === true,
      topItem: row?.topItem && typeof row.topItem === "object" ? row.topItem : null,
    }))
    .sort(
      (a, b) => b.critical - a.critical || b.open - a.open || a.specName.localeCompare(b.specName),
    );
}

/** Eval-series points → bar heights in [0.05, 1]. Pure (unit-tested). */
export function trendBars(series) {
  const points = Array.isArray(series) ? series : [];
  return points
    .map((p) => (typeof p?.passRate === "number" ? p.passRate : null))
    .filter((r) => r !== null)
    .map((rate) => Math.max(0.05, Math.min(1, rate)));
}

async function tryWrite(label, fn, onOk) {
  let result;
  try {
    result = await fn();
  } catch (err) {
    toast(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (result && result.ok === false) {
    toast(`${label} refused: ${String(result.body?.error ?? `HTTP ${result.status}`)}`);
    return;
  }
  onOk(result);
}

// ---------------------------------------------------------------------------
// The per-harness tab
// ---------------------------------------------------------------------------

export async function renderAdvisor(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const [feedRes, trendRes, reportsRes, issuesRes] = await Promise.allSettled([
    api.advisor({ id: ctx.id }),
    api.advisorTrend({ id: ctx.id }),
    api.advisorReports({ id: ctx.id }),
    api.advisorIssues({ id: ctx.id }),
  ]);
  clear(root);
  const reload = () => renderAdvisor(root, ctx);
  const feed = feedRes.status === "fulfilled" && feedRes.value.ok ? feedRes.value.body : null;
  root.appendChild(feedCard(feed, ctx, reload));
  const trend = trendRes.status === "fulfilled" && trendRes.value.ok ? trendRes.value.body : null;
  root.appendChild(trendCard(trend));
  const reports =
    reportsRes.status === "fulfilled" && reportsRes.value.ok ? reportsRes.value.body : null;
  root.appendChild(reportsCard(reports, ctx, reload));
  const issues =
    issuesRes.status === "fulfilled" && issuesRes.value.ok ? issuesRes.value.body : null;
  root.appendChild(issuesCard(issues, ctx, reload));
}

function feedCard(feed, ctx, reload) {
  const card = el("section", { class: "card" });
  card.appendChild(
    el("h3", { class: "card-title" }, [
      el("span", { text: "Needs attention" }),
      tipIcon(
        "Every alert and suggestion the manager can derive about this harness, in one feed: preflight, spec lint, eval health vs the pinned baseline, spend vs budget, incidents, approvals, overdue dreams, mined advice. Hover any item for why it matters.",
      ),
    ]),
  );
  if (feed === null) {
    card.appendChild(emptyState("The advisor feed could not be read", "crewhaus doctor"));
    return card;
  }
  const items = Array.isArray(feed.items) ? feed.items : [];
  const dismissed = Array.isArray(feed.dismissed) ? feed.dismissed : [];
  if (feed.optimal === true) {
    card.appendChild(
      el("div", { class: "adv-optimal" }, [
        dot("ok", "running optimally"),
        el("p", {
          class: "adv-note",
          text: String(feed.note ?? "every signal this manager reads is clean"),
        }),
      ]),
    );
  } else {
    card.appendChild(
      el("p", { class: "adv-note" }, [el("span", { text: String(feed.guidance ?? "") })]),
    );
    for (const item of items) card.appendChild(itemRow(item, ctx, reload));
  }
  if (dismissed.length > 0) {
    card.appendChild(
      collapsible(
        [dot("off", `${dismissed.length} dismissed — each with its recorded reason`)],
        dismissed.map((item) => dismissedRow(item, ctx, reload)),
      ),
    );
  }
  return card;
}

function itemRow(item, ctx, reload) {
  const severity = String(item.severity ?? "suggestion");
  const model = itemActionModel(item, ctx.id);
  const row = el("div", { class: `adv-item adv-${severity}` });
  row.appendChild(
    withTip(el("div", null, [dot(severityDot(severity), severity)]), String(item.explain ?? "")),
  );
  const main = el("div", { class: "adv-main" }, [
    withTip(
      el("div", { class: "adv-title", text: String(item.title ?? "") }),
      String(item.explain ?? ""),
    ),
    el("div", { class: "adv-detail muted", text: String(item.detail ?? "") }),
    el("div", { class: "adv-guidance" }, [
      el("span", { text: `→ ${String(item.guidance ?? "")}` }),
    ]),
  ]);
  if (item.lastAction && typeof item.lastAction === "object") {
    const la = item.lastAction;
    main.appendChild(
      el("div", {
        class: "adv-decision",
        text: `acted ${String(la.at ?? "")}${la.comment ? ` — “${String(la.comment)}”` : ""}${la.jobId ? ` (job ${String(la.jobId)})` : ""}`,
      }),
    );
  }
  row.appendChild(main);

  const actions = el("div", { class: "adv-actions" });
  if (model.kind === "job") {
    const runBtn = el("button", { class: "btn btn-primary", type: "button", text: model.label });
    runBtn.addEventListener("click", () => openActForm(row, item, ctx, reload, model));
    actions.appendChild(
      withTip(
        runBtn,
        "Opens a confirm where you can attach a comment; the comment is recorded in the advisor ledger next to the queued job.",
      ),
    );
  } else if (model.kind === "link") {
    actions.appendChild(el("a", { class: "btn", href: model.href, text: model.label }));
  } else {
    actions.appendChild(el("span", { class: "muted", text: model.label }));
  }
  if (model.cliTwin)
    actions.appendChild(
      el("span", { class: "adv-cli", title: model.cliTwin, text: model.cliTwin }),
    );
  const dismissBtn = el("button", { class: "btn btn-ghost", type: "button", text: "Dismiss…" });
  dismissBtn.addEventListener("click", () => openDismissForm(row, item, ctx, reload));
  actions.appendChild(
    withTip(
      dismissBtn,
      "Dismissing requires a reason — it is recorded in the ledger so “why was this ignored” always has an answer. A dismissal can be reopened.",
    ),
  );
  row.appendChild(actions);
  return row;
}

/** The act confirm: the exact CLI twin, plus the optional comment that is
 *  injected into the recorded decision. Only one form open per row. */
function openActForm(row, item, ctx, reload, model) {
  closeForms(row);
  const comment = el("input", {
    class: "input",
    type: "text",
    placeholder: "optional comment, recorded with the action",
    "aria-label": "comment recorded with this action",
  });
  const form = el("form", { class: "adv-form" }, [
    model.cliTwin ? el("code", { class: "mono", text: model.cliTwin }) : null,
    comment,
    el("button", { class: "btn btn-primary", type: "submit", text: "Queue it" }),
    el("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Cancel",
      onClick: () => form.remove(),
    }),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = comment.value.trim() === "" ? {} : { comment: comment.value.trim() };
    tryWrite(
      "Act",
      () => api.advisorAct({ id: ctx.id, itemId: String(item.id) }, body),
      (result) => {
        toast(
          result?.body?.acted === true
            ? "Queued — watch it in the job queue"
            : "That item has cleared; reloading",
          "info",
        );
        reload();
      },
    );
  });
  row.appendChild(form);
  comment.focus();
}

/** The dismiss form: the reason is REQUIRED — the server refuses without it. */
function openDismissForm(row, item, ctx, reload) {
  closeForms(row);
  const reason = el("input", {
    class: "input",
    type: "text",
    placeholder: "why this is fine to leave (required, recorded)",
    "aria-label": "dismissal reason",
    required: "",
  });
  const form = el("form", { class: "adv-form" }, [
    reason,
    el("button", { class: "btn", type: "submit", text: "Dismiss with reason" }),
    el("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Cancel",
      onClick: () => form.remove(),
    }),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (reason.value.trim() === "") return;
    tryWrite(
      "Dismiss",
      () =>
        api.advisorDismiss(
          { id: ctx.id, itemId: String(item.id) },
          { reason: reason.value.trim() },
        ),
      () => reload(),
    );
  });
  row.appendChild(form);
  reason.focus();
}

function closeForms(row) {
  for (const old of row.querySelectorAll(".adv-form")) old.remove();
}

function dismissedRow(item, ctx, reload) {
  const dismissal = item.dismissal && typeof item.dismissal === "object" ? item.dismissal : {};
  const reopenBtn = el("button", { class: "btn btn-ghost", type: "button", text: "Reopen" });
  reopenBtn.addEventListener("click", () => {
    tryWrite(
      "Reopen",
      () => api.advisorReopen({ id: ctx.id, itemId: String(item.id) }, {}),
      () => reload(),
    );
  });
  return el("div", { class: "adv-item adv-suggestion" }, [
    el("div", null, [dot("off", "dismissed")]),
    el("div", { class: "adv-main" }, [
      el("div", { class: "adv-title", text: String(item.title ?? "") }),
      el("div", {
        class: "adv-decision",
        text: `by ${String(dismissal.by ?? "?")} ${String(dismissal.at ?? "")} — “${String(dismissal.reason ?? "")}”`,
      }),
    ]),
    el("div", { class: "adv-actions" }, [reopenBtn]),
  ]);
}

// ---------------------------------------------------------------------------
// Trend, reports, issues
// ---------------------------------------------------------------------------

function trendCard(trend) {
  const card = el("section", { class: "card" });
  card.appendChild(
    el("h3", { class: "card-title" }, [
      el("span", { text: "Is it improving?" }),
      tipIcon(
        "Folded from durable sources only — the eval run index, the session cost ledger, and the advisor's own decision records. Nothing here is a stored snapshot.",
      ),
    ]),
  );
  if (trend === null) {
    card.appendChild(emptyState("The trend could not be read", "crewhaus eval crewhaus.yaml"));
    return card;
  }
  card.appendChild(el("p", { class: "adv-note", text: String(trend.summary ?? "") }));
  const bars = trendBars(trend.evalSeries);
  if (bars.length > 0) {
    card.appendChild(
      withTip(
        el(
          "div",
          {
            class: "trend-bars",
            role: "img",
            "aria-label": "eval pass rate per run, oldest first",
          },
          bars.map((h) =>
            el("div", { class: "trend-bar", style: { height: `${Math.round(h * 100)}%` } }),
          ),
        ),
        "Eval pass rate per recorded run, oldest first — the improvement curve the optimizer climbs.",
      ),
    );
  }
  const decisions = trend.decisions && typeof trend.decisions === "object" ? trend.decisions : {};
  card.appendChild(
    el("p", {
      class: "muted small",
      text: `decisions recorded: ${Number(decisions.acted ?? 0)} acted · ${Number(decisions.dismissed ?? 0)} dismissed`,
    }),
  );
  return card;
}

const REPORT_TIPS = {
  "model-usage":
    "Per-model spend, calls and tokens, with the model to right-size first named in the finding.",
  costs: "The daily spend series and how much of the declared budget ceiling is used.",
  usefulness:
    "Sessions on record, eval runs, the latest pass rate, and waiting advice — is this harness earning its keep?",
  optimization:
    "The eval series vs recorded optimize runs — whether the active-optimization loop is actually being closed.",
};

function reportsCard(reports, ctx, reload) {
  const card = el("section", { class: "card" });
  card.appendChild(
    el("h3", { class: "card-title" }, [
      el("span", { text: "Reports" }),
      tipIcon(
        "Generate a report about anything measured here; each one is saved on the harness and can be re-read and compared later.",
      ),
    ]),
  );
  const kinds = Array.isArray(reports?.kinds) ? reports.kinds : Object.keys(REPORT_TIPS);
  const bar = el("div", { class: "toolbar" });
  for (const kind of kinds) {
    const btn = el("button", { class: "btn", type: "button", text: `Generate ${kind}` });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      tryWrite(
        "Generate report",
        () => api.advisorReportRun({ id: ctx.id }, { kind }),
        () => {
          toast(`Generated ${kind}`, "info");
          reload();
        },
      );
    });
    bar.appendChild(withTip(btn, REPORT_TIPS[kind] ?? `Generate the ${kind} report.`));
  }
  card.appendChild(bar);
  const rows = Array.isArray(reports?.reports) ? reports.reports : [];
  if (rows.length === 0) {
    card.appendChild(emptyState(String(reports?.note ?? "No reports generated yet"), null));
    return card;
  }
  const list = el("div", null);
  for (const row of rows) {
    const openBtn = el("button", { class: "btn btn-ghost", type: "button", text: "View" });
    const holder = el("div");
    openBtn.addEventListener("click", async () => {
      openBtn.disabled = true;
      const answer = await api.advisorReport({ id: ctx.id, reportId: String(row.reportId) });
      openBtn.disabled = false;
      clear(holder);
      if (answer.ok && answer.body?.report) holder.appendChild(jsonPre(answer.body.report));
      else toast("Report could not be read");
    });
    list.appendChild(
      el("div", { class: "find-row" }, [
        el("span", { class: "chip", text: String(row.kind ?? "?") }),
        el("span", { class: "mono", text: String(row.reportId ?? "") }),
        el("span", { class: "muted small", text: String(row.generatedAt ?? "") }),
        openBtn,
      ]),
    );
    list.appendChild(holder);
  }
  card.appendChild(list);
  return card;
}

const ISSUE_KIND_TIPS = {
  optimize:
    "Queues the eval→patch optimize loop: it searches the spec's tunable paths against your evals and lands a reviewable spec patch — an update ready to run, never an automatic write.",
  eval: "Queues an eval run, so the issue gets a measured before/after.",
  doctor: "Queues the doctor — for issues that smell like credentials, wiring or environment.",
  compile: "Queues a recompile — for issues that smell like a stale bundle.",
  advise: "Queues the advice miner over recorded sessions — it proposes concrete spec patches.",
  note: "Records the issue for a human plan; nothing is queued.",
};

function issuesCard(issues, ctx, reload) {
  const card = el("section", { class: "card" });
  card.appendChild(
    el("h3", { class: "card-title" }, [
      el("span", { text: "Report an issue" }),
      tipIcon(
        "Describe a problem and it is tuned into an update ready to run: the kind picks what gets queued (optimize is the default — its artifact is a reviewable spec patch). The issue and its update land in a harness-local ledger.",
      ),
    ]),
  );
  const title = el("input", {
    class: "input grow",
    type: "text",
    placeholder: "what's wrong? (one line)",
    "aria-label": "issue title",
  });
  const detail = el("textarea", {
    class: "input notes",
    rows: "2",
    placeholder: "details (optional)",
    "aria-label": "issue detail",
  });
  const kinds = Array.isArray(issues?.kinds) ? issues.kinds : Object.keys(ISSUE_KIND_TIPS);
  const kindSel = el("select", { class: "input", "aria-label": "update kind" });
  for (const kind of kinds) {
    kindSel.appendChild(el("option", { value: String(kind), text: String(kind) }));
  }
  // The kind's tooltip follows the selection: `withTip` seeds the class and
  // the initial text; the change listener rewrites BOTH faces of the tip
  // (the hover bubble reads data-tip, assistive tech reads title).
  const retip = () => {
    const tipText = ISSUE_KIND_TIPS[kindSel.value] ?? "";
    kindSel.dataset.tip = tipText;
    kindSel.setAttribute("title", tipText);
  };
  kindSel.addEventListener("change", retip);
  withTip(kindSel, ISSUE_KIND_TIPS[String(kinds[0] ?? "optimize")] ?? "");
  // Field order = tab order: title, details, then the kind and the submit.
  const form = el("form", { class: "adv-form" }, [
    title,
    detail,
    kindSel,
    el("button", {
      class: "btn btn-primary",
      type: "submit",
      text: "Submit → update ready to run",
    }),
  ]);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (title.value.trim() === "") return;
    tryWrite(
      "Submit issue",
      () =>
        api.advisorIssueSubmit(
          { id: ctx.id },
          {
            title: title.value.trim(),
            ...(detail.value.trim() !== "" ? { detail: detail.value.trim() } : {}),
            kind: kindSel.value,
          },
        ),
      (result) => {
        toast(String(result?.body?.issue?.update?.note ?? "Submitted"), "info");
        reload();
      },
    );
  });
  card.appendChild(form);
  const rows = Array.isArray(issues?.issues) ? issues.issues : [];
  if (rows.length === 0) {
    card.appendChild(emptyState(String(issues?.note ?? "No issues submitted yet"), null));
    return card;
  }
  for (const row of rows) {
    const update = row.update && typeof row.update === "object" ? row.update : {};
    card.appendChild(
      el("div", { class: "find-row" }, [
        update.ready === true
          ? el("span", { class: "chip chip-group", text: "update queued" })
          : el("span", { class: "chip", text: "recorded" }),
        el("span", { text: String(row.title ?? "") }),
        el("span", { class: "muted small", text: String(row.at ?? "") }),
        update.cliTwin
          ? el("span", {
              class: "adv-cli",
              title: String(update.cliTwin),
              text: String(update.cliTwin),
            })
          : null,
      ]),
    );
  }
  return card;
}

// ---------------------------------------------------------------------------
// The fleet board
// ---------------------------------------------------------------------------

export async function renderAdvisorBoard(root) {
  clear(root).appendChild(skeleton(6));
  let payload = null;
  try {
    const answer = await api.advisorFleet({});
    payload = answer.ok ? answer.body : null;
  } catch (err) {
    clear(root).appendChild(
      el("div", { class: "card error-card" }, [
        el("h2", { text: "Fleet advisor unavailable" }),
        el("p", { class: "muted", text: err instanceof Error ? err.message : String(err) }),
      ]),
    );
    return;
  }
  clear(root);
  root.appendChild(
    el("div", { class: "rollup" }, [
      el("h2", { text: "Fleet advisor" }),
      el("span", {
        class: "muted",
        text: "worst first — open a harness's Advisor tab for the feed and its actions",
      }),
    ]),
  );
  if (payload === null) {
    root.appendChild(emptyState("The fleet advisor could not be read", "crewhaus doctor"));
    return;
  }
  const rows = rankAdvisorRows(payload);
  if (rows.length === 0) {
    root.appendChild(emptyState("No live harness to advise", "crewhaus harness add <dir>"));
    return;
  }
  const card = el("section", { class: "card" });
  for (const row of rows) {
    card.appendChild(
      el("div", { class: "adv-board-row" }, [
        el("a", { class: "name-link", href: hrefHarness(row.id, "advisor"), text: row.specName }),
        row.optimal
          ? dot("ok", "optimal")
          : dot(row.critical > 0 ? "bad" : row.warn > 0 ? "warn" : "unknown", `${row.open} open`),
        el("span", {
          class: "muted small",
          text: `${row.critical} critical · ${row.warn} warn · ${row.suggestion} suggested`,
        }),
        row.topItem
          ? withTip(
              el("span", { class: "muted", text: String(row.topItem.title ?? "") }),
              "The worst open item — the feed on the harness's Advisor tab has the full explanation and the quick action.",
            )
          : el("span", { class: "muted", text: "—" }),
      ]),
    );
  }
  root.appendChild(card);
}
