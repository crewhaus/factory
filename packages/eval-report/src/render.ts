import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import type { ReportDiff } from "./diff";
import type { LoadedRun } from "./load";

const STYLE = `
:root {
  --bg: #0f1115; --fg: #e6e6e6; --muted: #999; --pass: #4caf50; --fail: #ef5350;
  --card: #1a1d23; --border: #333; --link: #61dafb;
}
* { box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 24px; line-height: 1.5; }
h1 { margin: 0 0 16px; }
.meta { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
.aggregate { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 24px; }
.aggregate .card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
.aggregate .label { color: var(--muted); font-size: 12px; text-transform: uppercase; }
.aggregate .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 6px; overflow: hidden; }
th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); font-size: 14px; }
th { background: #14171c; cursor: pointer; user-select: none; }
th:hover { color: var(--link); }
tr:last-child td { border-bottom: none; }
.pass { color: var(--pass); font-weight: 600; }
.fail { color: var(--fail); font-weight: 600; }
details { background: var(--card); margin: 12px 0; border-radius: 6px; padding: 0; border: 1px solid var(--border); }
summary { padding: 12px 16px; cursor: pointer; user-select: none; }
.drill { padding: 16px; border-top: 1px solid var(--border); }
.drill h3 { margin: 0 0 8px; font-size: 14px; color: var(--muted); text-transform: uppercase; }
.drill pre { background: #0a0c10; padding: 12px; overflow-x: auto; border-radius: 4px; font-size: 12px; line-height: 1.4; max-height: 400px; }
.grader-row { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; border-bottom: 1px dashed var(--border); }
.grader-row:last-child { border-bottom: none; }
.grader-name { font-weight: 600; min-width: 140px; }
.grader-score { color: var(--muted); font-size: 13px; }
.grader-rationale { color: var(--fg); font-size: 13px; flex: 1; }
.diff-section { margin: 24px 0; }
.diff-section h2 { margin: 0 0 12px; }
.regression-row { background: rgba(239, 83, 80, 0.08); }
.recovery-row { background: rgba(76, 175, 80, 0.08); }
.score-bar { display: inline-block; width: 60px; height: 8px; background: #2a2d33; border-radius: 4px; vertical-align: middle; margin-right: 8px; }
.score-bar > span { display: block; height: 100%; background: var(--pass); border-radius: 4px; }
.best { color: var(--pass); font-weight: 600; }
.na { color: var(--muted); }
.triage-bug { color: var(--fail); font-weight: 600; }
.triage-spec-gap { color: #ffb74d; font-weight: 600; }
.triage-noise { color: var(--muted); font-weight: 600; }
.triage-contract-ambiguity { color: var(--link); font-weight: 600; }
`;

const SCRIPT = `
(function() {
  function sortTable(table, col) {
    var tbody = table.querySelector('tbody');
    if (!tbody) return;
    var rows = Array.from(tbody.rows);
    var asc = table.dataset.sortCol === String(col) ? table.dataset.sortDir !== 'asc' : true;
    rows.sort(function(a, b) {
      var va = a.cells[col].dataset.sort || a.cells[col].textContent.trim();
      var vb = b.cells[col].dataset.sort || b.cells[col].textContent.trim();
      var na = parseFloat(va), nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return asc ? na - nb : nb - na;
      return asc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    rows.forEach(function(r) { tbody.appendChild(r); });
    table.dataset.sortCol = String(col);
    table.dataset.sortDir = asc ? 'asc' : 'desc';
  }
  document.querySelectorAll('table[data-sortable] th').forEach(function(th, i) {
    th.addEventListener('click', function() { sortTable(th.closest('table'), i); });
  });
})();
`;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function shell(title: string, body: string): string {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
<script>${SCRIPT}</script>
</body></html>`;
}

function aggregateCards(s: EvalRunSummary): string {
  const cards = [
    { label: "Pass rate", value: `${(s.aggregates.passRate * 100).toFixed(1)}%` },
    { label: "Mean score", value: s.aggregates.meanScore.toFixed(3) },
    { label: "Samples", value: String(s.samples.length) },
    { label: "Errors", value: String(s.aggregates.errorCount) },
    { label: "p50 turns", value: s.aggregates.p50Turns.toFixed(1) },
    { label: "p95 turns", value: s.aggregates.p95Turns.toFixed(1) },
    { label: "p50 latency", value: `${Math.round(s.aggregates.p50LatencyMs)}ms` },
    { label: "p95 latency", value: `${Math.round(s.aggregates.p95LatencyMs)}ms` },
    { label: "Tokens in", value: String(s.aggregates.totalTokens.input) },
    { label: "Tokens out", value: String(s.aggregates.totalTokens.output) },
  ];
  return `<section class="aggregate">${cards
    .map(
      (c) =>
        `<div class="card"><div class="label">${escapeHtml(c.label)}</div><div class="value">${escapeHtml(c.value)}</div></div>`,
    )
    .join("")}</section>`;
}

function sampleRow(s: SampleResult, perSample?: LoadedRun["perSample"][string]): string {
  const status = s.error ? "fail" : s.grades.overall.passed ? "pass" : "fail";
  const scoreBar = `<span class="score-bar"><span style="width:${(s.grades.overall.score * 100).toFixed(0)}%"></span></span>`;
  const drillId = `drill-${escapeHtml(s.sampleId)}`;
  return `
<tr>
  <td>${escapeHtml(s.sampleId)}</td>
  <td class="${status}" data-sort="${status === "pass" ? 1 : 0}">${status.toUpperCase()}</td>
  <td data-sort="${s.grades.overall.score}">${scoreBar}${s.grades.overall.score.toFixed(2)}</td>
  <td data-sort="${s.turns}">${s.turns}</td>
  <td data-sort="${s.latencyMs}">${s.latencyMs}ms</td>
  <td data-sort="${s.tokens.input + s.tokens.output}">${s.tokens.input}/${s.tokens.output}</td>
  <td><a href="#${drillId}">drill</a></td>
</tr>`;
}

function sampleDrill(s: SampleResult, perSample?: LoadedRun["perSample"][string]): string {
  const transcript = perSample?.transcript ?? "";
  const events = perSample?.events ?? "";
  return `
<details id="drill-${escapeHtml(s.sampleId)}">
  <summary><strong>${escapeHtml(s.sampleId)}</strong> — ${s.grades.overall.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'} · score ${s.grades.overall.score.toFixed(2)}${s.error ? ` · <span class="fail">${escapeHtml(s.error)}</span>` : ""}</summary>
  <div class="drill">
    <h3>Agent output</h3>
    <pre>${escapeHtml(s.agentOutput || "(empty)")}</pre>
    <h3>Graders</h3>
    ${s.grades.perGrader
      .map(
        (g) =>
          `<div class="grader-row">
            <span class="grader-name">${escapeHtml(g.name)}</span>
            <span class="grader-score ${g.passed ? "pass" : "fail"}">${g.passed ? "✓" : "✗"} ${g.score.toFixed(2)}</span>
            <span class="grader-rationale">${escapeHtml(g.rationale)}</span>
          </div>`,
      )
      .join("")}
    <h3>Transcript (${transcript.split("\n").filter(Boolean).length} events)</h3>
    <pre>${escapeHtml(transcript || "(empty)")}</pre>
    <h3>Trace events (${events.split("\n").filter(Boolean).length} events)</h3>
    <pre>${escapeHtml(events || "(empty)")}</pre>
  </div>
</details>`;
}

/** One failing sample's triage verdict, as the report renders it. */
export type ReportVerdictRow = {
  readonly sampleId: string;
  readonly class: string;
  readonly reason: string;
};

/**
 * Failure-triage verdicts for a run — written by the CLI's failure-arbiter
 * wiring (item 7) as `verdicts.json` next to `results.json` and passed to
 * {@link renderReport}. Deliberately structural (`class` is a plain string,
 * counts an open record): this package does NOT depend on
 * eval-optimizer-orchestrator's types, so any object with these fields
 * renders and an arbiter gaining a fifth class needs no change here.
 */
export type ReportVerdicts = {
  readonly counts: Readonly<Record<string, number>>;
  readonly dominantClass: string;
  readonly total: number;
  readonly verdicts: ReadonlyArray<ReportVerdictRow>;
};

/** Fixed display order for the four shipped classes (unknown classes append). */
const TRIAGE_CLASS_ORDER = ["bug", "spec-gap", "noise", "contract-ambiguity"];

function triageSection(v: ReportVerdicts): string {
  const classes = [
    ...TRIAGE_CLASS_ORDER.filter((c) => c in v.counts),
    ...Object.keys(v.counts).filter((c) => !TRIAGE_CLASS_ORDER.includes(c)),
  ];
  const countsLine = classes.map((c) => `${escapeHtml(c)} ${v.counts[c] ?? 0}`).join(" · ");
  const rows = v.verdicts
    .map((row) => {
      // Only a known-shaped class name becomes a CSS class; anything else
      // renders unstyled rather than risking attribute breakout.
      const cls = /^[a-z][a-z-]*$/.test(row.class) ? ` class="triage-${row.class}"` : "";
      return `
<tr>
  <td>${escapeHtml(row.sampleId)}</td>
  <td${cls}>${escapeHtml(row.class)}</td>
  <td>${escapeHtml(row.reason)}</td>
</tr>`;
    })
    .join("");
  return `
<section class="diff-section" id="triage">
  <h2>Failure triage (${v.total} failing)</h2>
  <p class="meta">${countsLine} · dominant: ${escapeHtml(v.dominantClass)}</p>
  <table data-sortable>
    <thead><tr><th>Sample</th><th>Class</th><th>Reason</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

export function renderReport(
  run: LoadedRun,
  opts: { readonly verdicts?: ReportVerdicts } = {},
): { html: string; json: string } {
  const s = run.summary;
  const body = `
<h1>Eval run ${escapeHtml(s.runId)}</h1>
<p class="meta">Started ${escapeHtml(s.startedAt)} · ended ${escapeHtml(s.endedAt)} · model ${escapeHtml(s.config.model)} · concurrency ${s.config.concurrency}${s.config.judgeModel ? ` · judge ${escapeHtml(s.config.judgeModel)}` : ""}</p>
${aggregateCards(s)}${opts.verdicts !== undefined ? triageSection(opts.verdicts) : ""}
<table data-sortable>
  <thead><tr>
    <th>Sample</th><th>Status</th><th>Score</th><th>Turns</th><th>Latency</th><th>Tokens (in/out)</th><th>Drill</th>
  </tr></thead>
  <tbody>
    ${s.samples.map((sm) => sampleRow(sm, run.perSample[sm.sampleId])).join("")}
  </tbody>
</table>
${s.samples.map((sm) => sampleDrill(sm, run.perSample[sm.sampleId])).join("")}
`;
  return {
    html: shell(`Eval ${s.runId}`, body),
    json: JSON.stringify(s, null, 2),
  };
}

export function renderDiffHtml(
  diff: ReportDiff,
  prev: EvalRunSummary,
  next: EvalRunSummary,
): string {
  const flipRow = (e: ReportDiff["regressions"][number], cls: string): string => `
<tr class="${cls}">
  <td>${escapeHtml(e.sampleId)}</td>
  <td>${e.prev.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'} (${e.prev.score.toFixed(2)})</td>
  <td>→</td>
  <td>${e.next.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'} (${e.next.score.toFixed(2)})</td>
  <td>${escapeHtml(e.next.rationale.slice(0, 200))}</td>
</tr>`;

  const section = (
    title: string,
    entries: ReadonlyArray<ReportDiff["regressions"][number]>,
    cls: string,
  ): string => `
<section class="diff-section">
  <h2>${escapeHtml(title)} (${entries.length})</h2>
  ${
    entries.length === 0
      ? '<p class="meta">none</p>'
      : `<table>
      <thead><tr><th>Sample</th><th>Prev</th><th></th><th>New</th><th>Rationale</th></tr></thead>
      <tbody>${entries.map((e) => flipRow(e, cls)).join("")}</tbody>
    </table>`
  }
</section>`;

  const body = `
<h1>Diff: ${escapeHtml(diff.prevRunId)} → ${escapeHtml(diff.newRunId)}</h1>
<p class="meta">Prev pass rate: ${(prev.aggregates.passRate * 100).toFixed(1)}% · New pass rate: ${(next.aggregates.passRate * 100).toFixed(1)}% · Unchanged: ${diff.unchanged}</p>
${section("Regressions (PASS → FAIL)", diff.regressions, "regression-row")}
${section("Recoveries (FAIL → PASS)", diff.recoveries, "recovery-row")}
${section("Score shifts (|Δ| > 0.1)", diff.scoreShifts, "")}
`;
  return shell(`Diff ${diff.prevRunId} → ${diff.newRunId}`, body);
}
