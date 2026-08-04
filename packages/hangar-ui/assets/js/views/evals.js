/**
 * Evals tab — run history, one run's per-sample table (pass/fail filter),
 * and one sample's grades + transcript excerpt. Partial runs render
 * deflated (badged, never chartable as regressions); replayed runs are
 * badged not-live; the baseline run carries a star.
 */

import { api } from "../api.js";
import { clear, dot, el, emptyState, jsonPre, skeleton } from "../dom.js";
import { hrefHarness } from "../router.js";
import { fmtPct, fmtRelativeTime, fmtUsd } from "../util.js";

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
  const nowMs = Date.now();
  const tbody = el("tbody");
  for (const run of runs) {
    const runId = String(run.runId ?? run.id ?? "");
    const partial = run.partial === true;
    tbody.appendChild(
      el("tr", { class: partial ? "deflated" : null }, [
        el("td", { text: fmtRelativeTime(run.ts ?? run.at ?? null, nowMs) }),
        el("td", null, [
          run.baseline === true
            ? el("span", { class: "baseline-star", title: "baseline run", text: "★ " })
            : null,
          el("a", {
            class: "mono name-link",
            href: hrefHarness(ctx.id, "evals", runId),
            text: runId || "(run)",
          }),
        ]),
        el("td", { class: "mono", text: String(run.dataset ?? "—") }),
        el("td", null, [passDot(run.passRate, run.gatePassed)]),
        el("td", { class: "num", text: fmtScore(run.meanScore) }),
        el("td", {
          class: "num",
          text: fmtUsd(typeof run.costUsd === "number" ? run.costUsd : null),
        }),
        el("td", { class: "cell-caps" }, [
          run.flaky === true ? el("span", { class: "chip chip-warn", text: "flaky" }) : null,
          partial ? el("span", { class: "chip chip-warn", text: "partial" }) : null,
          run.replayed === true ? el("span", { class: "chip", text: "replayed" }) : null,
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
            ["When", "Run", "Dataset", "Pass rate", "Mean score", "Cost", "Flags"].map((h) =>
              el("th", { text: h }),
            ),
          ),
        ),
        tbody,
      ]),
    ]),
  );
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
  const summary = data.summary && typeof data.summary === "object" ? data.summary : data;
  root.appendChild(
    el("div", { class: "card" }, [
      el("div", { class: "mini-row" }, [
        miniStat("pass rate", fmtPct(numOr(summary.passRate))),
        miniStat("mean score", fmtScore(summary.meanScore)),
        miniStat("samples", String(summary.samples ?? summary.sampleCount ?? "—")),
        miniStat("cost", fmtUsd(numOr(summary.costUsd))),
      ]),
    ]),
  );

  const samples = Array.isArray(data.samples) ? data.samples : [];
  if (samples.length === 0) {
    root.appendChild(emptyState("No per-sample results recorded for this run"));
    return;
  }
  let filter = "all";
  const listWrap = el("div");
  const drawList = () => {
    clear(listWrap);
    const visible = samples.filter((s) =>
      filter === "all" ? true : filter === "pass" ? s.pass === true : s.pass !== true,
    );
    if (visible.length === 0) {
      listWrap.appendChild(emptyState(`No ${filter} samples`));
      return;
    }
    const tbody = el("tbody");
    for (const s of visible) {
      const sid = String(s.id ?? s.sampleId ?? "");
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
  const grades = Array.isArray(data.grades) ? data.grades : [];
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

  const excerpt = data.transcriptExcerpt ?? data.transcript ?? null;
  const excerptCard = el("div", { class: "card" }, [
    el("h3", { class: "card-title", text: "Transcript excerpt" }),
  ]);
  if (excerpt === null) {
    excerptCard.appendChild(el("p", { class: "muted", text: "No transcript captured." }));
  } else if (typeof excerpt === "string") {
    excerptCard.appendChild(el("pre", { class: "rawjson", text: excerpt }));
  } else {
    excerptCard.appendChild(jsonPre(excerpt));
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
