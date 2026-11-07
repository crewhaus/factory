/**
 * Evals tab — run history, one run's per-sample table (pass/fail filter),
 * and one sample's grades + transcript excerpt. Partial runs render
 * deflated (badged, never chartable as regressions); replayed runs are
 * badged not-live; the baseline run carries a star.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, jsonPre, skeleton, toast } from "../dom.js";
import { hrefHarness } from "../router.js";
import { fmtPct, fmtRelativeTime, fmtUsd, notMeasuredCopy } from "../util.js";
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
  drawHistory(root, ctx, data, () => renderHistory(root, ctx));
}

/** The history table, drawn from one `evals` payload. */
export function drawHistory(root, ctx, data, reload) {
  clear(root);
  const runs = runsOf(data);
  if (runs.length === 0) {
    const copy = notMeasuredCopy(data);
    root.appendChild(emptyState(copy.message, copy.verb));
    return;
  }
  // The runs were readable but the pin file was not: say so above the table.
  if (typeof data?.unreadable === "string") {
    root.appendChild(el("p", { class: "muted", text: data.unreadable }));
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
        el("td", null, [passDot(run)]),
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
          baselineCell(ctx.id, run, runId, baselineRunIds.has(runId), ctx.dir ?? "", reload),
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
 *
 * A run that cannot be a baseline gets the reason as visible text and no button:
 * a tooltip would be out of reach from a keyboard.
 */
export function baselineCell(harnessId, run, runId, isBaseline, dir, reload) {
  if (isBaseline) return el("span", { class: "chip chip-group", text: "baseline" });
  if (typeof run.pinRefusal === "string") {
    return el("span", { class: "muted gated-why", text: run.pinRefusal });
  }
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
  drawRun(root, ctx, runId, data);
}

/** The sample filters: a verdict falls in exactly one besides "all". */
export const SAMPLE_FILTERS = [
  { id: "all", label: "all", verdicts: null, none: "No per-sample results recorded for this run." },
  { id: "pass", label: "pass", verdicts: ["pass"], none: "No case in this run passed." },
  {
    id: "fail",
    label: "fail",
    verdicts: ["fail", "error"],
    none: "No case in this run failed or errored.",
  },
  {
    id: "other",
    label: "no verdict",
    verdicts: ["abstained", "canary", "unknown"],
    none: "Every case in this run has a verdict.",
  },
];

/** The rows one filter shows. */
export function filterRows(rows, filterId) {
  const filter = SAMPLE_FILTERS.find((f) => f.id === filterId);
  if (filter === undefined || filter.verdicts === null) return rows;
  return rows.filter((r) => filter.verdicts.includes(r.verdict));
}

/** One run, drawn from its `evalRun` payload: `stats` and `rows` are the
 *  server's join of `results.json`, the index row and the sample directories. */
export function drawRun(root, ctx, runId, data) {
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
  const stats = data.stats && typeof data.stats === "object" ? data.stats : {};
  root.appendChild(
    el("div", { class: "card" }, [
      el("div", { class: "mini-row" }, [
        miniStat("pass rate", passRateWord(stats)),
        miniStat("mean score", fmtScore(stats.meanScore)),
        miniStat(
          "samples",
          typeof stats.sampleCount === "number" ? String(stats.sampleCount) : "—",
        ),
        miniStat("cost", fmtUsd(numOr(stats.costUsd))),
      ]),
      el("div", { class: "cell-caps" }, [
        stats.partial === true ? el("span", { class: "chip chip-warn", text: "partial" }) : null,
        stats.replayed === true ? el("span", { class: "chip", text: "replayed" }) : null,
        stats.flakyCount > 0 ? el("span", { class: "chip chip-warn", text: "flaky" }) : null,
      ]),
    ]),
  );

  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (rows.length === 0) {
    root.appendChild(emptyState(SAMPLE_FILTERS[0].none));
    return;
  }
  const known = rows.some((r) => r.verdict !== "unknown");

  let filter = "all";
  const listWrap = el("div");
  const drawList = () => {
    clear(listWrap);
    const visible = filterRows(rows, filter);
    if (visible.length === 0) {
      const chosen = SAMPLE_FILTERS.find((f) => f.id === filter);
      listWrap.appendChild(emptyState(chosen?.none ?? SAMPLE_FILTERS[0].none));
      return;
    }
    const tbody = el("tbody");
    for (const row of visible) {
      const sid = String(row.sampleId ?? "");
      tbody.appendChild(
        el("tr", null, [
          el("td", null, [
            typeof row.dir === "string"
              ? el("a", {
                  class: "mono name-link",
                  href: hrefHarness(ctx.id, "evals", runId, row.dir),
                  text: sid || "(sample)",
                })
              : el("span", { class: "mono", text: sid || "(sample)" }),
          ]),
          el("td", null, [
            verdictDot(row.verdict),
            row.flaky === true ? el("span", { class: "chip chip-warn", text: "flaky" }) : null,
            row.needsReview === true
              ? el("span", { class: "chip chip-warn", text: "needs a person" })
              : null,
          ]),
          el("td", { class: "num", text: fmtScore(row.score) }),
          el("td", { class: "muted", text: String(row.note ?? "") }),
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
      SAMPLE_FILTERS.map((f) => {
        const btn = el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: f.label,
          "aria-pressed": f.id === filter ? "true" : "false",
        });
        btn.addEventListener("click", () => {
          filter = f.id;
          for (const b of filterBar.querySelectorAll("button")) {
            b.classList.remove("active");
            b.setAttribute("aria-pressed", "false");
          }
          btn.classList.add("active");
          btn.setAttribute("aria-pressed", "true");
          drawList();
        });
        if (f.id === "all") btn.classList.add("active");
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
  drawSample(root, ctx, runId, sampleId, data);
}

/**
 * `grades.json` as the runner writes it: `overall` plus one `perGrader` entry
 * per grader. Anything else reads as no grades, never as a verdict.
 */
export function gradeRowsOf(grades) {
  const perGrader = Array.isArray(grades?.perGrader) ? grades.perGrader : [];
  return perGrader
    .filter((g) => g && typeof g === "object")
    .map((g) => ({
      name: String(g.name ?? "grader"),
      passed: g.passed,
      abstained: g.abstained === true,
      score: g.score,
      rationale: typeof g.rationale === "string" ? g.rationale : "",
    }));
}

/** One sample, drawn from its `evalSample` payload. */
export function drawSample(root, ctx, runId, sampleId, data) {
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
  const overall =
    data.grades?.overall && typeof data.grades.overall === "object" ? data.grades.overall : null;
  const grades = gradeRowsOf(data.grades);
  const gradeCard = el("div", { class: "card" }, [
    el("h3", { class: "card-title" }, [
      el("span", { text: "Grades" }),
      overall === null ? null : passFailDot(overall.passed, overall.abstained === true),
    ]),
    grades.length === 0
      ? el("p", { class: "muted", text: "No grades recorded." })
      : el(
          "ul",
          { class: "check-list" },
          grades.map((g) =>
            el("li", null, [
              passFailDot(g.passed, g.abstained),
              el("span", { text: ` ${g.name}` }),
              el("span", { class: "num muted", text: ` ${fmtScore(g.score)}` }),
              g.rationale ? el("div", { class: "muted reason", text: g.rationale }) : null,
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

/**
 * What a run's pass rate may honestly be called. A run stopped at its budget or
 * with no verdict at all has no rate worth printing: its 0% would read as a
 * score.
 */
export function passRateWord(run) {
  if (run?.partial === true) return "partial";
  if (run?.measuredCount === 0) return "not measured";
  return fmtPct(numOr(run?.passRate));
}

/** The dot beside a run's pass rate. */
export function passDotState(run) {
  if (run?.partial === true) return "warn";
  if (run?.measuredCount === 0 || typeof run?.passRate !== "number") return "unknown";
  return run.passRate >= 1 ? "ok" : "warn";
}

function passDot(run) {
  return dot(passDotState(run), passRateWord(run));
}

/** Every verdict's dot and its word. Status is never colour alone. */
export const VERDICT_FACES = {
  pass: { state: "ok", word: "pass" },
  fail: { state: "bad", word: "fail" },
  error: { state: "bad", word: "error" },
  abstained: { state: "warn", word: "needs a person" },
  canary: { state: "off", word: "canary" },
  unknown: { state: "unknown", word: "no result" },
};

/** A sample verdict's face. Anything unrecognised has no result. */
export function verdictFace(verdict) {
  return Object.hasOwn(VERDICT_FACES, verdict) ? VERDICT_FACES[verdict] : VERDICT_FACES.unknown;
}

function verdictDot(verdict) {
  const face = verdictFace(verdict);
  return dot(face.state, face.word);
}

/** One grader's verdict as `grades.json` records it. */
export function gradeVerdict(passed, abstained) {
  if (abstained === true) return "abstained";
  if (passed === true) return "pass";
  if (passed === false) return "fail";
  return "unknown";
}

function passFailDot(passed, abstained) {
  return verdictDot(gradeVerdict(passed, abstained));
}
