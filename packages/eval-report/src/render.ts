import type { EvalRunSummary, SampleResult } from "@crewhaus/eval-runner";
import type { ReportDiff } from "./diff";
import type { LoadedRun } from "./load";
import { formatSignificanceLine } from "./significance";

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
.abstain { color: #ffb74d; font-weight: 600; }
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

/** C27 — `[87.2%, 99.0%]` / `[0.61, 0.79]` for the CI cards. */
function formatCI(ci: readonly [number, number], asPct: boolean): string {
  const fmt = (v: number) => (asPct ? `${(v * 100).toFixed(1)}%` : v.toFixed(3));
  return `[${fmt(ci[0])}, ${fmt(ci[1])}]`;
}

/** A12 — a criterion mean on the raw 1–5 scale: `4` exact, `4.33` otherwise. */
function formatCriterionMean(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * B13 — the per-slice table: one row per (key, metadata value) with the
 * slice's sample count, pass rate, and mean score. Rendered only when the
 * summary carries `slices` (runs from pre-B13 CLIs, and metadata-less
 * datasets, don't).
 */
function slicesSection(slices: NonNullable<EvalRunSummary["slices"]>): string {
  const rows = Object.entries(slices)
    .flatMap(([key, byValue]) =>
      Object.entries(byValue).map(
        ([value, stats]) => `
<tr>
  <td>${escapeHtml(key)}</td>
  <td>${escapeHtml(value)}</td>
  <td data-sort="${stats.sampleCount}">${stats.sampleCount}</td>
  <td data-sort="${stats.passRate}">${(stats.passRate * 100).toFixed(1)}%</td>
  <td data-sort="${stats.meanScore}">${stats.meanScore.toFixed(3)}</td>
</tr>`,
      ),
    )
    .join("");
  return `
<section class="diff-section" id="slices">
  <h2>Slices</h2>
  <table data-sortable>
    <thead><tr><th>Key</th><th>Value</th><th>Samples</th><th>Pass rate</th><th>Mean score</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

/**
 * A12 — per-criterion mean judge scores (raw 1–5 scale), one row per
 * (grader, criterion). Rendered only when the aggregates carry
 * `criterionMeans` (i.e. some judge grade carried a `detail` breakdown).
 */
function criterionSection(
  means: NonNullable<EvalRunSummary["aggregates"]["criterionMeans"]>,
): string {
  const rows = Object.entries(means)
    .flatMap(([grader, byCriterion]) =>
      Object.entries(byCriterion).map(
        ([criterion, mean]) => `
<tr>
  <td>${escapeHtml(grader)}</td>
  <td>${escapeHtml(criterion)}</td>
  <td data-sort="${mean}">${formatCriterionMean(mean)}</td>
</tr>`,
      ),
    )
    .join("");
  return `
<section class="diff-section" id="criteria">
  <h2>Judge criteria (mean, 1–5)</h2>
  <table data-sortable>
    <thead><tr><th>Grader</th><th>Criterion</th><th>Mean score</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

/**
 * A3 — the needs-human bucket: abstained samples awaiting a human verdict
 * (excluded from the pass-rate denominator), id-listed for `crewhaus rate`.
 */
function needsHumanSection(a: EvalRunSummary["aggregates"]): string {
  if (a.needsHuman === undefined || a.needsHuman === 0) return "";
  const ids = (a.needsHumanSampleIds ?? []).map((id) => escapeHtml(id)).join(", ");
  return `
<section class="diff-section" id="needs-human">
  <h2>Needs human (${a.needsHuman})</h2>
  <p class="meta">The judge abstained on these samples (insufficient evidence) and nothing else failed —
  they are excluded from the pass rate and await a human verdict (<code>crewhaus rate</code>): <span class="abstain">${ids}</span></p>
</section>`;
}

/**
 * A2 — the needs-review bucket: samples whose judge-panel vote nearly
 * split (high normalized entropy). Their verdicts are REAL and still count
 * in the pass rate — unlike the abstained needs-human bucket above — but a
 * near-coin-flip vote deserves a human look.
 */
function needsReviewSection(a: EvalRunSummary["aggregates"]): string {
  if (a.needsReview === undefined || a.needsReview === 0) return "";
  const ids = (a.needsReviewSampleIds ?? []).map((id) => escapeHtml(id)).join(", ");
  return `
<section class="diff-section" id="needs-review">
  <h2>Needs review (${a.needsReview})</h2>
  <p class="meta">The judge panel nearly split on these samples (high vote entropy) — the recorded
  verdicts still count in the pass rate, but deserve a human look: <span class="abstain">${ids}</span></p>
</section>`;
}

/**
 * B18 — the canary bucket: contamination-tripwire samples
 * (`metadata.source: "canary"`, injected by `crewhaus datasets put --canary`).
 * Their verdicts are meaningless by construction, so they are excluded from
 * the pass-rate denominator like the needs-human bucket — this section keeps
 * the report's denominator story honest for canary-carrying runs.
 */
function canarySection(a: EvalRunSummary["aggregates"]): string {
  if (a.canary === undefined || a.canary === 0) return "";
  const ids = (a.canarySampleIds ?? []).map((id) => escapeHtml(id)).join(", ");
  return `
<section class="diff-section" id="canary">
  <h2>Canary (${a.canary})</h2>
  <p class="meta">Contamination-tripwire samples (<code>metadata.source: "canary"</code>) — their verdicts
  are meaningless by construction and are excluded from the pass rate: <span class="abstain">${ids}</span></p>
</section>`;
}

function aggregateCards(s: EvalRunSummary): string {
  const a = s.aggregates;
  const cards = [
    { label: "Pass rate", value: `${(a.passRate * 100).toFixed(1)}%` },
    { label: "Mean score", value: a.meanScore.toFixed(3) },
    { label: "Samples", value: String(s.samples.length) },
    { label: "Errors", value: String(a.errorCount) },
    { label: "p50 turns", value: a.p50Turns.toFixed(1) },
    { label: "p95 turns", value: a.p95Turns.toFixed(1) },
    { label: "p50 latency", value: `${Math.round(a.p50LatencyMs)}ms` },
    { label: "p95 latency", value: `${Math.round(a.p95LatencyMs)}ms` },
    { label: "Tokens in", value: String(a.totalTokens.input) },
    { label: "Tokens out", value: String(a.totalTokens.output) },
  ];
  // Loop contract 0.4 (Batch B) — G15 pass@k / pass^k and G56 loop-quality
  // aggregates. All guarded: results.json written by older CLIs lacks them
  // and must keep rendering card-for-card as before.
  const k = s.config.repeats;
  if (a.passAtK !== undefined) {
    cards.push({
      label: k !== undefined ? `pass@${k}` : "pass@k",
      value: `${(a.passAtK * 100).toFixed(1)}%`,
    });
  }
  if (a.passHatK !== undefined) {
    cards.push({
      label: k !== undefined ? `pass^${k}` : "pass^k",
      value: `${(a.passHatK * 100).toFixed(1)}%`,
    });
  }
  if (a.totalTokensAllTrials !== undefined) {
    cards.push({
      label: "Tokens (all trials)",
      value: `${a.totalTokensAllTrials.input}/${a.totalTokensAllTrials.output}`,
    });
  }
  if (a.partialScoreMean !== undefined) {
    cards.push({ label: "Partial score", value: a.partialScoreMean.toFixed(3) });
  }
  if (a.toolCallAccuracy !== undefined) {
    cards.push({ label: "Tool accuracy", value: `${(a.toolCallAccuracy * 100).toFixed(1)}%` });
  }
  if (a.interventionRate !== undefined) {
    cards.push({
      label: "Intervention rate",
      value: `${(a.interventionRate * 100).toFixed(1)}%`,
    });
  }
  if (a.safetyViolations !== undefined) {
    cards.push({ label: "Safety violations", value: String(a.safetyViolations.total) });
  }
  if (a.p50ModelCallMs !== undefined) {
    cards.push({ label: "p50 model call", value: `${Math.round(a.p50ModelCallMs)}ms` });
  }
  if (a.p95ModelCallMs !== undefined) {
    cards.push({ label: "p95 model call", value: `${Math.round(a.p95ModelCallMs)}ms` });
  }
  // C27 — closed-form 95% CIs; A3 — the needs-human bucket. All guarded:
  // results.json from older CLIs lacks the fields.
  if (a.passRateCI95 !== undefined) {
    cards.push({ label: "Pass rate 95% CI", value: formatCI(a.passRateCI95, true) });
  }
  if (a.meanScoreCI95 !== undefined) {
    cards.push({ label: "Mean score 95% CI", value: formatCI(a.meanScoreCI95, false) });
  }
  if (a.needsHuman !== undefined) {
    cards.push({ label: "Needs human", value: String(a.needsHuman) });
  }
  // A2 — high-entropy panel votes flagged for review (verdicts still count).
  if (a.needsReview !== undefined) {
    cards.push({ label: "Needs review", value: String(a.needsReview) });
  }
  // B18 — contamination canaries (excluded from the pass-rate denominator).
  if (a.canary !== undefined) {
    cards.push({ label: "Canary", value: String(a.canary) });
  }
  // A9 — abstention-aware accuracy lens (calibration.abstentionAware pack).
  if (a.calibration !== undefined) {
    cards.push({ label: "Answer rate", value: `${(a.calibration.answerRate * 100).toFixed(1)}%` });
    cards.push({
      label: "Abstention rate",
      value: `${(a.calibration.abstentionRate * 100).toFixed(1)}%`,
    });
    if (a.calibration.accuracyWhenAnswered !== undefined) {
      cards.push({
        label: "Accuracy when answered",
        value: `${(a.calibration.accuracyWhenAnswered * 100).toFixed(1)}%`,
      });
    }
  }
  // A10 — cross-sample paraphrase consistency (consistency.paraphraseGroup).
  if (a.paraphraseConsistency !== undefined) {
    cards.push({
      label: "Paraphrase consistency",
      value: `${(a.paraphraseConsistency.meanConsistency * 100).toFixed(1)}% (${a.paraphraseConsistency.groupCount} groups)`,
    });
  }
  return `<section class="aggregate">${cards
    .map(
      (c) =>
        `<div class="card"><div class="label">${escapeHtml(c.label)}</div><div class="value">${escapeHtml(c.value)}</div></div>`,
    )
    .join("")}</section>`;
}

/** Which of the additive per-sample columns this run actually carries —
 *  header and rows must agree, so this is computed once per report. */
type SampleColumnFlags = {
  readonly trials: boolean;
  readonly toolAccuracy: boolean;
  readonly interventions: boolean;
  readonly safety: boolean;
};

function sampleColumnFlags(samples: ReadonlyArray<SampleResult>): SampleColumnFlags {
  return {
    trials: samples.some((s) => s.trials !== undefined && s.trials.length > 0),
    toolAccuracy: samples.some((s) => s.metrics?.toolCallAccuracy !== undefined),
    interventions: samples.some((s) => (s.metrics?.interventions ?? 0) > 0),
    safety: samples.some((s) => (s.metrics?.safetyViolations?.total ?? 0) > 0),
  };
}

function sampleRow(s: SampleResult, cols: SampleColumnFlags): string {
  // A3 — an abstained sample is neither a pass nor a fail: the judge
  // declined and nothing else failed, so the verdict awaits a human.
  const abstained = s.error === undefined && s.grades.overall.abstained === true;
  const status = abstained
    ? "abstain"
    : s.error
      ? "fail"
      : s.grades.overall.passed
        ? "pass"
        : "fail";
  const statusText = abstained ? "ABSTAINED" : status.toUpperCase();
  const statusSort = abstained ? 0.5 : status === "pass" ? 1 : 0;
  const scoreBar = `<span class="score-bar"><span style="width:${(s.grades.overall.score * 100).toFixed(0)}%"></span></span>`;
  const drillId = `drill-${escapeHtml(s.sampleId)}`;
  const trialsCell = (): string => {
    if (s.trials === undefined || s.trials.length === 0) {
      return `<td class="na" data-sort="-1">n/a</td>`;
    }
    const passes = s.trials.filter((t) => t.passed).length;
    const rate = s.trialPassRate ?? passes / s.trials.length;
    const cls = passes === s.trials.length ? "pass" : passes === 0 ? "fail" : "";
    return `<td${cls ? ` class="${cls}"` : ""} data-sort="${rate}">${passes}/${s.trials.length}</td>`;
  };
  const toolAccCell = (): string =>
    s.metrics?.toolCallAccuracy !== undefined
      ? `<td data-sort="${s.metrics.toolCallAccuracy}">${(s.metrics.toolCallAccuracy * 100).toFixed(0)}%</td>`
      : `<td class="na" data-sort="-1">n/a</td>`;
  const interventionsCell = (): string => {
    const n = s.metrics?.interventions ?? 0;
    return `<td data-sort="${n}">${n}</td>`;
  };
  const safetyCell = (): string => {
    const n = s.metrics?.safetyViolations?.total ?? 0;
    return `<td${n > 0 ? ' class="fail"' : ""} data-sort="${n}">${n}</td>`;
  };
  return `
<tr>
  <td>${escapeHtml(s.sampleId)}</td>
  <td class="${status}" data-sort="${statusSort}">${statusText}</td>
  <td data-sort="${s.grades.overall.score}">${scoreBar}${s.grades.overall.score.toFixed(2)}</td>${cols.trials ? trialsCell() : ""}${cols.toolAccuracy ? toolAccCell() : ""}${cols.interventions ? interventionsCell() : ""}${cols.safety ? safetyCell() : ""}
  <td data-sort="${s.turns}">${s.turns}</td>
  <td data-sort="${s.latencyMs}">${s.latencyMs}ms</td>
  <td data-sort="${s.tokens.input + s.tokens.output}">${s.tokens.input}/${s.tokens.output}</td>
  <td><a href="#${drillId}">drill</a></td>
</tr>`;
}

function trialsTable(s: SampleResult): string {
  if (s.trials === undefined || s.trials.length === 0) return "";
  const rows = s.trials
    .map(
      (t) => `
<tr>
  <td>${t.trial}</td>
  <td class="${t.passed ? "pass" : "fail"}">${t.passed ? "PASS" : "FAIL"}</td>
  <td>${t.score.toFixed(2)}</td>
  <td>${t.latencyMs}ms</td>
  <td>${t.tokens.input}/${t.tokens.output}</td>
  <td>${t.error !== undefined ? `<span class="fail">${escapeHtml(t.error)}</span>` : t.graderError !== undefined ? `<span class="fail">${escapeHtml(t.graderError)}</span>` : ""}${t.retried === true ? ' <span class="na">(retried)</span>' : ""}</td>
</tr>`,
    )
    .join("");
  return `
    <h3>Trials (${s.trials.filter((t) => t.passed).length}/${s.trials.length} passed)</h3>
    <table>
      <thead><tr><th>#</th><th>Verdict</th><th>Score</th><th>Latency</th><th>Tokens</th><th>Error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function metricsLine(s: SampleResult): string {
  const m = s.metrics;
  if (m === undefined) return "";
  const parts: string[] = [];
  if (m.toolCallAccuracy !== undefined) {
    parts.push(`tool accuracy ${(m.toolCallAccuracy * 100).toFixed(0)}%`);
  }
  parts.push(`interventions ${m.interventions}`);
  const v = m.safetyViolations;
  parts.push(
    `safety violations ${v.total} (deny ${v.permissionDenials} · egress ${v.egressBlocks} · justification ${v.justificationRejections})`,
  );
  parts.push(`model calls ${m.modelCallLatenciesMs.length}`);
  return `<p class="meta">${escapeHtml(parts.join(" · "))}</p>`;
}

function sampleDrill(s: SampleResult, perSample?: LoadedRun["perSample"][string]): string {
  const transcript = perSample?.transcript ?? "";
  const events = perSample?.events ?? "";
  const verdict =
    s.error === undefined && s.grades.overall.abstained === true
      ? '<span class="abstain">ABSTAINED</span>'
      : s.grades.overall.passed
        ? '<span class="pass">PASS</span>'
        : '<span class="fail">FAIL</span>';
  return `
<details id="drill-${escapeHtml(s.sampleId)}">
  <summary><strong>${escapeHtml(s.sampleId)}</strong> — ${verdict} · score ${s.grades.overall.score.toFixed(2)}${s.error ? ` · <span class="fail">${escapeHtml(s.error)}</span>` : ""}${s.failureClass !== undefined ? ` · <span class="na">class: ${escapeHtml(s.failureClass)}</span>` : ""}</summary>
  <div class="drill">
    ${metricsLine(s)}${trialsTable(s)}
    <h3>Agent output</h3>
    <pre>${escapeHtml(s.agentOutput || "(empty)")}</pre>
    <h3>Graders</h3>
    ${s.grades.perGrader
      .map(
        (g) =>
          `<div class="grader-row">
            <span class="grader-name">${escapeHtml(g.name)}</span>
            <span class="grader-score ${g.abstained === true ? "abstain" : g.passed ? "pass" : "fail"}">${g.abstained === true ? "?" : g.passed ? "✓" : "✗"} ${g.score.toFixed(2)}</span>
            <span class="grader-rationale">${escapeHtml(g.rationale)}${
              g.detail !== undefined
                ? ` <span class="na">(${escapeHtml(
                    Object.entries(g.detail)
                      .map(([c, v]) => `${c}=${formatCriterionMean(v)}`)
                      .join(" · "),
                  )})</span>`
                : ""
            }</span>
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
  const cols = sampleColumnFlags(s.samples);
  const extraHeaders = `${cols.trials ? "<th>Trials</th>" : ""}${cols.toolAccuracy ? "<th>Tool acc</th>" : ""}${cols.interventions ? "<th>Interv.</th>" : ""}${cols.safety ? "<th>Safety</th>" : ""}`;
  const calibration = s.config.judgeCalibration;
  const calibrationNote =
    calibration !== undefined
      ? `<p class="meta">Judge calibration applied from ${escapeHtml(calibration.path)}: ${calibration.applied
          .map(
            (a) =>
              `${escapeHtml(a.grader)} gated at min-score ${a.minScore} (${escapeHtml(a.specKey)})`,
          )
          .join(" · ")}</p>`
      : "";
  const body = `
<h1>Eval run ${escapeHtml(s.runId)}</h1>
<p class="meta">Started ${escapeHtml(s.startedAt)} · ended ${escapeHtml(s.endedAt)} · model ${escapeHtml(s.config.model)} · concurrency ${s.config.concurrency}${s.config.judgeModel ? ` · judge ${escapeHtml(s.config.judgeModel)}` : ""}${s.config.repeats !== undefined ? ` · repeats ${s.config.repeats}` : ""}</p>
${calibrationNote}${aggregateCards(s)}${needsHumanSection(s.aggregates)}${needsReviewSection(s.aggregates)}${canarySection(s.aggregates)}${s.slices !== undefined ? slicesSection(s.slices) : ""}${s.aggregates.criterionMeans !== undefined ? criterionSection(s.aggregates.criterionMeans) : ""}${opts.verdicts !== undefined ? triageSection(opts.verdicts) : ""}
<table data-sortable>
  <thead><tr>
    <th>Sample</th><th>Status</th><th>Score</th>${extraHeaders}<th>Turns</th><th>Latency</th><th>Tokens (in/out)</th><th>Drill</th>
  </tr></thead>
  <tbody>
    ${s.samples.map((sm) => sampleRow(sm, cols)).join("")}
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
  // G15 — when a side carried repeat trials, show its per-sample pass-rate
  // beside the canonical verdict (the flip may be a pure reliability move).
  // A3 — an abstained side renders ABSTAINED: its FAIL is a placeholder.
  const side = (v: {
    passed: boolean;
    score: number;
    passRate?: number;
    abstained?: boolean;
  }): string =>
    `${
      v.abstained === true
        ? '<span class="abstain">ABSTAINED</span>'
        : v.passed
          ? '<span class="pass">PASS</span>'
          : '<span class="fail">FAIL</span>'
    } (${v.score.toFixed(2)})${v.passRate !== undefined ? ` · ${(v.passRate * 100).toFixed(0)}% of trials` : ""}`;
  const flipRow = (e: ReportDiff["regressions"][number], cls: string): string => `
<tr class="${cls}">
  <td>${escapeHtml(e.sampleId)}</td>
  <td>${side(e.prev)}</td>
  <td>→</td>
  <td>${side(e.next)}</td>
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

  // B13 — per-slice deltas over the (key, value) slices both runs share.
  const sliceDeltaSection =
    diff.sliceDeltas === undefined
      ? ""
      : `
<section class="diff-section">
  <h2>Slice deltas (${diff.sliceDeltas.length})</h2>
  <table data-sortable>
    <thead><tr><th>Key</th><th>Value</th><th>Prev pass</th><th>New pass</th><th>Δ pass</th><th>Prev score</th><th>New score</th><th>n</th></tr></thead>
    <tbody>${diff.sliceDeltas
      .map((d) => {
        const delta = d.next.passRate - d.prev.passRate;
        const cls = delta < 0 ? "fail" : delta > 0 ? "pass" : "na";
        return `
<tr>
  <td>${escapeHtml(d.key)}</td>
  <td>${escapeHtml(d.value)}</td>
  <td data-sort="${d.prev.passRate}">${(d.prev.passRate * 100).toFixed(1)}%</td>
  <td data-sort="${d.next.passRate}">${(d.next.passRate * 100).toFixed(1)}%</td>
  <td class="${cls}" data-sort="${delta}">${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%</td>
  <td data-sort="${d.prev.meanScore}">${d.prev.meanScore.toFixed(3)}</td>
  <td data-sort="${d.next.meanScore}">${d.next.meanScore.toFixed(3)}</td>
  <td data-sort="${d.next.sampleCount}">${d.prev.sampleCount === d.next.sampleCount ? d.next.sampleCount : `${d.prev.sampleCount}→${d.next.sampleCount}`}</td>
</tr>`;
      })
      .join("")}</tbody>
  </table>
</section>`;

  // C29 — the paired-significance line rides in the header as plain
  // language (decision support; the strict flip sections below are the
  // gate's view). Absent on diffs of runs with no comparable pairs.
  const significanceNote =
    diff.significance === undefined
      ? ""
      : `\n<p class="meta">Paired significance: ${escapeHtml(formatSignificanceLine(diff.significance))}</p>`;

  // A1 — the pairwise-judging section (`--pairwise`): summary tallies plus
  // per-sample order-swapped verdicts. Absent on offline diffs.
  const pairwiseSection = diff.pairwise === undefined ? "" : renderPairwiseSection(diff.pairwise);

  const body = `
<h1>Diff: ${escapeHtml(diff.prevRunId)} → ${escapeHtml(diff.newRunId)}</h1>
<p class="meta">Prev pass rate: ${(prev.aggregates.passRate * 100).toFixed(1)}% · New pass rate: ${(next.aggregates.passRate * 100).toFixed(1)}% · Unchanged: ${diff.unchanged}</p>${significanceNote}
${section("Regressions (pass-rate dropped)", diff.regressions, "regression-row")}
${section("Recoveries (pass-rate rose)", diff.recoveries, "recovery-row")}
${section("Score shifts (|Δ| > 0.1)", diff.scoreShifts, "")}
${sliceDeltaSection}${pairwiseSection}`;
  return shell(`Diff ${diff.prevRunId} → ${diff.newRunId}`, body);
}

/**
 * A1 — the pairwise head-to-head section of the diff report. A sample's
 * consolidated verdict colors the row: NEW winning renders as a recovery
 * (green), PREV winning as a regression (red), ties neutral. The two
 * per-order verdicts are shown side by side so an order-inconsistent judge
 * (position bias — consolidated to a tie) is visible at a glance.
 */
function renderPairwiseSection(p: NonNullable<ReportDiff["pairwise"]>): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
  const verdictCell = (winner: "prev" | "new" | "tie"): string =>
    winner === "new"
      ? '<span class="pass">NEW</span>'
      : winner === "prev"
        ? '<span class="fail">PREV</span>'
        : '<span class="na">TIE</span>';
  const rows = p.samples
    .map((s) => {
      const cls =
        s.verdict === "new" ? "recovery-row" : s.verdict === "prev" ? "regression-row" : "";
      return `
<tr class="${cls}">
  <td>${escapeHtml(s.sampleId)}</td>
  <td>${verdictCell(s.prevFirst.winner)}</td>
  <td>${verdictCell(s.newFirst.winner)}</td>
  <td>${s.agreed ? "✓" : "✗"}</td>
  <td>${verdictCell(s.verdict)}</td>
  <td>${escapeHtml(s.newFirst.rationale.slice(0, 200))}</td>
</tr>`;
    })
    .join("");
  const skipNote =
    p.skippedErrored === undefined
      ? ""
      : `\n  <p class="meta">${p.skippedErrored} sample(s) skipped — errored on a side, no output to compare.</p>`;
  return `
<section class="diff-section" id="pairwise">
  <h2>Pairwise judging (${p.samples.length})</h2>
  <p class="meta">Judge ${escapeHtml(p.judgeModel)} · new wins ${p.newWins} · prev wins ${p.prevWins} · ties ${p.ties} ·
  win-rate ${pct(p.winRate)} (new over prev, ties half) · order-consistency ${pct(p.orderConsistency)}.
  Each sample is judged twice with the presentation order swapped; a disagreement between orders is
  position bias and consolidates to a tie — a tie is never counted as a win.</p>${skipNote}
  ${
    p.samples.length === 0
      ? '<p class="meta">none</p>'
      : `<table>
      <thead><tr><th>Sample</th><th>Prev-first</th><th>New-first</th><th>Agreed</th><th>Verdict</th><th>Rationale (new-first)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
  }
</section>`;
}
