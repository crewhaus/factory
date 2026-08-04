/**
 * Evals tab — run history, one run's per-sample table (pass/fail filter),
 * and one sample's grades + transcript excerpt. Partial runs render
 * deflated (badged, never chartable as regressions); replayed runs are
 * badged not-live; the baseline run carries a star.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, jsonPre, skeleton, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { fmtPct, fmtRelativeTime, fmtUsd } from "../util.js";
import { actionTwin } from "./control.js";

export async function renderEvals(root, ctx) {
  if (ctx.route.runId !== undefined && ctx.route.sampleId !== undefined) {
    await renderSample(root, ctx, ctx.route.runId, ctx.route.sampleId);
    return;
  }
  if (ctx.route.runId !== undefined) {
    await renderRun(root, ctx, ctx.route.runId);
    return;
  }
  await renderHistory(root, ctx);
}

function runsOf(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.runs)) return data.runs;
  return [];
}

async function renderHistory(root, ctx) {
  clear(root).appendChild(skeleton(6));
  const data = await api.evals(ctx.id);
  clear(root);
  const runs = runsOf(data);
  if (runs.length === 0) {
    root.appendChild(emptyState("No evals yet", "crewhaus eval"));
    return;
  }
  // Baselines are keyed `<spec>::<dataset>` → the pinned run; star any run
  // that IS a pinned baseline.
  const baselines = data?.baselines && typeof data.baselines === "object" ? data.baselines : {};
  const baselineRunIds = new Set(
    Object.values(baselines)
      .map((b) => (b && typeof b === "object" ? b.runId : null))
      .filter((id) => typeof id === "string"),
  );
  const nowMs = Date.now();
  const reload = () => renderHistory(root, ctx);
  const tbody = el("tbody");
  for (const run of runs) {
    const runId = String(run.runId ?? run.id ?? "");
    const partial = run.partial === true;
    const flaky = run.flaky === true || (typeof run.flakyCount === "number" && run.flakyCount > 0);
    tbody.appendChild(
      el("tr", { class: partial ? "deflated" : null }, [
        el("td", { text: fmtRelativeTime(run.ts ?? run.at ?? null, nowMs) }),
        el("td", null, [
          baselineRunIds.has(runId)
            ? el("span", { class: "baseline-star", title: "baseline run", text: "★ " })
            : null,
          el("a", {
            class: "mono name-link",
            href: hrefHarness(ctx.id, "evals", runId),
            text: runId || "(run)",
          }),
        ]),
        el("td", { class: "mono", text: String(run.datasetName ?? run.dataset ?? "—") }),
        el("td", null, [passDot(run.passRate, run.gatePassed)]),
        el("td", { class: "num", text: fmtScore(run.meanScore) }),
        el("td", {
          class: "num",
          text: fmtUsd(typeof run.costUsd === "number" ? run.costUsd : null),
        }),
        el("td", { class: "cell-caps" }, [
          flaky ? el("span", { class: "chip chip-warn", text: "flaky" }) : null,
          partial ? el("span", { class: "chip chip-warn", text: "partial" }) : null,
          run.replayed === true ? el("span", { class: "chip", text: "replayed" }) : null,
        ]),
        el("td", { class: "cell-edit" }, [
          baselineBtn(ctx.id, runId, baselineRunIds.has(runId), ctx.dir ?? "", reload),
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
            ["When", "Run", "Dataset", "Pass rate", "Mean score", "Cost", "Flags", "Baseline"].map(
              (h) => el("th", { text: h }),
            ),
          ),
        ),
        tbody,
      ]),
    ]),
  );
}

/**
 * Re-pin the eval baseline to this run. The baseline key is
 * `(specName, datasetName)` BY DESIGN — that is what keeps a spec edit gated
 * against the same measurement — so the server copies both off the run's own
 * index entry and this button only names the run.
 */
function baselineBtn(harnessId, runId, isBaseline, dir, reload) {
  if (isBaseline) return el("span", { class: "chip chip-group", text: "baseline" });
  const btn = el("button", {
    class: "btn btn-ghost",
    type: "button",
    text: "Pin baseline",
    title: "make this run the gate every future run is compared against",
  });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await api.pinBaseline(harnessId, runId);
    } catch (err) {
      btn.disabled = false;
      toast(`Re-pin failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    toast("Baseline re-pinned", "info");
    reload();
  });
  return el("div", { class: "job-action" }, [btn, actionTwin("baseline", { dir, runId })]);
}

async function renderRun(root, ctx, runId) {
  clear(root).appendChild(skeleton(6));
  const data = await api.evalRun(ctx.id, runId);
  clear(root);
  root.appendChild(
    el("div", { class: "crumb-line" }, [
      el("a", { href: hrefHarness(ctx.id, "evals"), text: "← eval history" }),
      el("span", { class: "mono muted", text: runId }),
    ]),
  );
  if (data === null) {
    root.appendChild(emptyState("Nothing here yet — no run with that id"));
    return;
  }
  // The run view is { runId, summary, sampleIds }: `summary` is the run's
  // parsed results.json (tolerated shape), `sampleIds` the on-disk sample
  // dirs — the navigable authority for the drill-down table.
  const summary = data.summary && typeof data.summary === "object" ? data.summary : {};
  root.appendChild(
    el("div", { class: "card" }, [
      el("div", { class: "mini-row" }, [
        miniStat("pass rate", fmtPct(numOr(summary.passRate))),
        miniStat("mean score", fmtScore(summary.meanScore)),
        miniStat("samples", String(summary.sampleCount ?? summary.samples ?? "—")),
        miniStat("cost", fmtUsd(numOr(summary.costUsd))),
      ]),
    ]),
  );

  const sampleIds = Array.isArray(data.sampleIds) ? data.sampleIds.map(String) : [];
  if (sampleIds.length === 0) {
    root.appendChild(emptyState("No per-sample results recorded for this run"));
    return;
  }
  // Join per-sample verdicts out of the summary when it carries them.
  const verdicts = new Map();
  const summaryRows = Array.isArray(summary.results)
    ? summary.results
    : Array.isArray(summary.samples)
      ? summary.samples
      : [];
  for (const s of summaryRows) {
    if (!s || typeof s !== "object") continue;
    const sid = String(s.sampleId ?? s.id ?? "");
    if (sid !== "") verdicts.set(sid, s);
  }
  const known = sampleIds.some((sid) => typeof verdicts.get(sid)?.pass === "boolean");

  let filter = "all";
  const listWrap = el("div");
  const drawList = () => {
    clear(listWrap);
    const visible = sampleIds.filter((sid) => {
      if (filter === "all") return true;
      const pass = verdicts.get(sid)?.pass;
      return filter === "pass" ? pass === true : pass !== true;
    });
    if (visible.length === 0) {
      listWrap.appendChild(emptyState(`No ${filter} samples`));
      return;
    }
    const tbody = el("tbody");
    for (const sid of visible) {
      const s = verdicts.get(sid) ?? {};
      tbody.appendChild(
        el("tr", null, [
          el("td", null, [
            el("a", {
              class: "mono name-link",
              href: hrefHarness(ctx.id, "evals", runId, sid),
              text: sid || "(sample)",
            }),
          ]),
          el("td", null, [passFailDot(s.pass)]),
          el("td", { class: "num", text: fmtScore(s.score) }),
          el("td", { class: "muted", text: String(s.reason ?? s.verdict ?? "") }),
        ]),
      );
    }
    listWrap.appendChild(
      el("div", { class: "table-scroll" }, [
        el("table", { class: "fleet" }, [
          el(
            "thead",
            null,
            el(
              "tr",
              null,
              ["Sample", "Verdict", "Score", "Notes"].map((h) => el("th", { text: h })),
            ),
          ),
          tbody,
        ]),
      ]),
    );
  };
  if (known) {
    const filterBar = el(
      "div",
      { class: "filter-bar", role: "group", "aria-label": "sample filter" },
      ["all", "pass", "fail"].map((f) => {
        const btn = el("button", { class: "btn btn-ghost", type: "button", text: f });
        btn.addEventListener("click", () => {
          filter = f;
          for (const b of filterBar.querySelectorAll("button")) b.classList.remove("active");
          btn.classList.add("active");
          drawList();
        });
        if (f === "all") btn.classList.add("active");
        return btn;
      }),
    );
    root.appendChild(filterBar);
  }
  drawList();
  root.appendChild(listWrap);
}

async function renderSample(root, ctx, runId, sampleId) {
  clear(root).appendChild(skeleton(6));
  const data = await api.evalSample(ctx.id, runId, sampleId);
  clear(root);
  root.appendChild(
    el("div", { class: "crumb-line" }, [
      el("a", { href: hrefHarness(ctx.id, "evals", runId), text: "← run" }),
      el("span", { class: "mono muted", text: `${runId} / ${sampleId}` }),
    ]),
  );
  if (data === null) {
    root.appendChild(emptyState("Nothing here yet — no sample with that id"));
    return;
  }
  // grades.json is passed through tolerantly: a list of grader results or
  // one bare result object.
  const grades = Array.isArray(data.grades)
    ? data.grades
    : data.grades && typeof data.grades === "object"
      ? [data.grades]
      : [];
  const gradeCard = el("div", { class: "card" }, [
    el("h3", { class: "card-title", text: "Grades" }),
    grades.length === 0
      ? el("p", { class: "muted", text: "No grades recorded." })
      : el(
          "ul",
          { class: "check-list" },
          grades.map((g) =>
            el("li", null, [
              passFailDot(g.pass),
              el("span", { text: ` ${String(g.grader ?? g.name ?? "grader")}` }),
              el("span", { class: "num muted", text: ` ${fmtScore(g.score)}` }),
              g.rationale ? el("div", { class: "muted reason", text: String(g.rationale) }) : null,
            ]),
          ),
        ),
  ]);
  root.appendChild(gradeCard);

  const transcript = Array.isArray(data.transcript) ? data.transcript : [];
  const excerptCard = el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Transcript" }),
      data.transcriptTruncated === true
        ? el("span", { class: "chip chip-warn", text: "truncated" })
        : null,
    ]),
  ]);
  if (transcript.length === 0) {
    excerptCard.appendChild(el("p", { class: "muted", text: "No transcript captured." }));
  } else {
    excerptCard.appendChild(jsonPre(transcript));
  }
  root.appendChild(excerptCard);
}

function miniStat(label, value) {
  return el("div", { class: "mini" }, [
    el("div", { class: "mini-num", text: value }),
    el("div", { class: "mini-label", text: label }),
  ]);
}

function numOr(v) {
  return typeof v === "number" ? v : null;
}

function fmtScore(v) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "—";
}

function passDot(passRate, gatePassed) {
  const pct = fmtPct(numOr(passRate));
  if (
    gatePassed === false ||
    (typeof passRate === "number" && passRate < 1 && gatePassed !== true)
  ) {
    return dot(typeof passRate === "number" && passRate < 1 ? "warn" : "unknown", pct);
  }
  if (typeof passRate !== "number") return dot("unknown", pct);
  return dot(passRate >= 1 ? "ok" : "warn", pct);
}

function passFailDot(pass) {
  if (pass === true) return dot("ok", "pass");
  if (pass === false) return dot("bad", "fail");
  return dot("unknown", "?");
}
