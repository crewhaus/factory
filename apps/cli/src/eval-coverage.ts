/**
 * Item 6 — `crewhaus eval coverage`: detect agent behaviors that PRODUCTION
 * exercises but the eval dataset never does. Answers "what is the agent doing
 * in the wild that my eval is blind to?" so a user can close the gaps before
 * they ship a regression.
 *
 * Two distributions are built and intersected, both DETERMINISTICALLY (no
 * model call — the same clustering `graders-suggest` uses):
 *
 * - PRODUCTION behavior, from the cwd spec's session JSONLs
 *   (`.crewhaus/sessions/*.jsonl`): tool/MCP call frequencies (parsed from
 *   `assistant_message` `tool_use` blocks — MCP tools carry the `mcp__`
 *   prefix), tool sequence bigrams, compaction-fired frequency, and clustered
 *   user-input themes (via `deriveTurns` + token clustering).
 * - EVAL coverage, from what the dataset EXERCISES: each Sample's
 *   `expected_tools` (file or `registry:` ref) plus the tools actually used
 *   in the most recent eval run's per-sample `events.jsonl` (located via the
 *   item-3 run-history index; the eval events use the `tool_call_end` trace
 *   shape, distinct from the production `assistant_message` shape).
 *
 * The report is a ranked backlog of gaps — tools/bigrams/behaviors present in
 * prod but absent from eval — rendered as text, dependency-free HTML (mirrors
 * eval-report / graders-suggest style), or JSON. The JSON is a stable,
 * ranked backlog `dataset mine` (item 2) can consume.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv switch on
 * import) mirroring `feedback.ts` / `graders-suggest.ts`; all filesystem
 * access and registry/run-index resolution live in `apps/cli/src/index.ts`.
 */
import { deriveTurns } from "./feedback";
import type { LoggedEvent, SessionTurn } from "./feedback";
import { normalizeEvidenceTokens, toolNamesFromEventsJsonl } from "./graders-suggest";

/** Thrown on malformed flags / unusable inputs. The CLI entry file routes it
 *  through `die()`; tests assert on `.message` without the process exiting. */
export class EvalCoverageError extends Error {
  override readonly name = "EvalCoverageError";
}

/** How many sessions feed the distribution by default (most-recent first). */
export const DEFAULT_COVERAGE_SESSIONS = 50;

export type CoverageFormat = "text" | "html" | "json";

/** Parse `--format`; defaults to text. */
export function parseCoverageFormat(value: string | undefined): CoverageFormat {
  if (value === undefined) return "text";
  if (value === "text" || value === "html" || value === "json") return value;
  throw new EvalCoverageError(`invalid --format "${value}" — expected text, html, or json`);
}

/** Parse `--sessions`: a positive integer or `all`. */
export function parseSessionsFlag(value: string | undefined): number | "all" {
  if (value === undefined) return DEFAULT_COVERAGE_SESSIONS;
  if (value.trim().toLowerCase() === "all") return "all";
  if (!/^\d+$/.test(value.trim())) {
    throw new EvalCoverageError(
      `invalid --sessions "${value}" — expected a positive integer or "all"`,
    );
  }
  const n = Number.parseInt(value, 10);
  if (n < 1) throw new EvalCoverageError(`invalid --sessions "${value}" — need at least 1`);
  return n;
}

// -------- production behavior distribution --------

type Block = { type?: string; text?: string; name?: string };

function contentBlocks(payload: unknown): Block[] {
  const content = (payload as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

/** The tool names an `assistant_message` payload called, verbatim (PascalCase
 *  builtins, `mcp__`-prefixed MCP tools), in first-seen order. */
export function assistantToolNames(payload: unknown): string[] {
  return contentBlocks(payload)
    .filter((b) => b.type === "tool_use" && typeof b.name === "string")
    .map((b) => b.name as string);
}

/** True when a tool name is an MCP tool (verbatim `mcp__`-prefixed). */
export function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__");
}

export type ProdBehavior = {
  /** Sessions scanned. */
  readonly sessionCount: number;
  /** tool name → number of SESSIONS in which it was called at least once. */
  readonly toolSessions: ReadonlyMap<string, number>;
  /** tool name → total call count across all sessions. */
  readonly toolCalls: ReadonlyMap<string, number>;
  /** ordered `A B` tool bigram → number of sessions it appeared in. */
  readonly bigramSessions: ReadonlyMap<string, number>;
  /** Number of sessions in which a `compaction` event fired. */
  readonly compactionSessions: number;
  /** Deterministic clusters of user-input themes. */
  readonly inputThemes: ReadonlyArray<InputTheme>;
};

export type InputTheme = {
  /** Top tokens joined — the human handle. */
  readonly label: string;
  readonly tokens: ReadonlyArray<string>;
  /** How many user inputs fell in this cluster. */
  readonly count: number;
  /** A representative input (shortest, for a compact exemplar). */
  readonly exemplar: string;
};

const BIGRAM_SEP = " ";

/** Split a bigram key back into its two tool names. */
export function splitBigram(key: string): [string, string] {
  const idx = key.indexOf(BIGRAM_SEP);
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * Build the production behavior distribution from a set of sessions' parsed
 * event arrays. Each session contributes at most once to the per-session
 * counts (tool_sessions / bigram_sessions / compaction), so a chatty session
 * cannot dominate the frequency ranking; raw call totals are kept separately.
 * User inputs are clustered by the same deterministic token overlap
 * `graders-suggest` uses.
 */
export function buildProdBehavior(
  sessions: ReadonlyArray<{ sessionId: string; events: ReadonlyArray<LoggedEvent> }>,
): ProdBehavior {
  const toolSessions = new Map<string, number>();
  const toolCalls = new Map<string, number>();
  const bigramSessions = new Map<string, number>();
  let compactionSessions = 0;
  const allInputs: string[] = [];

  for (const { events } of sessions) {
    const seenTools = new Set<string>();
    const seenBigrams = new Set<string>();
    // Ordered tool-call stream across the whole session (for bigrams).
    const toolStream: string[] = [];
    let sawCompaction = false;

    for (const ev of events) {
      if (ev.kind === "assistant_message") {
        for (const name of assistantToolNames(ev.payload)) {
          toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
          seenTools.add(name);
          toolStream.push(name);
        }
      } else if (ev.kind === "compaction") {
        sawCompaction = true;
      }
    }
    for (const name of seenTools) toolSessions.set(name, (toolSessions.get(name) ?? 0) + 1);
    for (let i = 0; i + 1 < toolStream.length; i += 1) {
      const key = `${toolStream[i]}${BIGRAM_SEP}${toolStream[i + 1]}`;
      seenBigrams.add(key);
    }
    for (const key of seenBigrams) bigramSessions.set(key, (bigramSessions.get(key) ?? 0) + 1);
    if (sawCompaction) compactionSessions += 1;

    // Derived user-input text for clustering.
    for (const t of deriveTurns(events)) {
      if (t.input.trim() !== "") allInputs.push(t.input);
    }
  }

  return {
    sessionCount: sessions.length,
    toolSessions,
    toolCalls,
    bigramSessions,
    compactionSessions,
    inputThemes: clusterInputs(allInputs),
  };
}

/**
 * Deterministic greedy clustering of user inputs by normalized token overlap
 * — the same seed-comparison algorithm `graders-suggest.clusterFailures`
 * uses, inlined here over plain strings. Inputs are visited in a stable order
 * (text asc); themes come back largest-first, labelled by their most frequent
 * tokens. Inputs with no clusterable tokens are dropped.
 */
export function clusterInputs(inputs: ReadonlyArray<string>, threshold = 0.34): InputTheme[] {
  const sorted = [...inputs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const clusters: Array<{ seed: Set<string>; texts: string[]; tokenSets: Array<Set<string>> }> = [];
  for (const input of sorted) {
    const tokens = new Set(normalizeEvidenceTokens(input));
    if (tokens.size === 0) continue;
    let bestIdx = -1;
    let bestOverlap = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const overlap = jaccard(tokens, (clusters[i] as { seed: Set<string> }).seed);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestOverlap >= threshold) {
      const c = clusters[bestIdx] as (typeof clusters)[number];
      c.texts.push(input);
      c.tokenSets.push(tokens);
    } else {
      clusters.push({ seed: tokens, texts: [input], tokenSets: [tokens] });
    }
  }
  const themes = clusters.map((c) => {
    const freq = new Map<string, number>();
    for (const set of c.tokenSets) for (const t of set) freq.set(t, (freq.get(t) ?? 0) + 1);
    const tokens = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([t]) => t);
    const exemplar = [...c.texts].sort((a, b) => a.length - b.length || (a < b ? -1 : 1))[0] ?? "";
    return { label: tokens.join(" "), tokens, count: c.texts.length, exemplar };
  });
  return themes.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// -------- eval coverage distribution --------

export type EvalCoverage = {
  /** Every tool named in a Sample's `expected_tools`, or observed in the most
   *  recent eval run's per-sample events. Compared against prod, so the set
   *  IS the coverage. */
  readonly toolsExercised: ReadonlySet<string>;
  /** Ordered `A B` tool bigrams present in any Sample's expected_tools
   *  sequence, or the eval run's per-sample tool stream. */
  readonly bigramsExercised: ReadonlySet<string>;
  /** Number of dataset samples inspected. */
  readonly sampleCount: number;
  /** Whether a recent eval run's per-sample events were available. */
  readonly hasRunEvents: boolean;
  /** Whether any sample declared expected_tools. */
  readonly hasExpectedTools: boolean;
};

/** Minimal sample view the coverage computation needs. */
export type CoverageSample = { readonly expected_tools?: ReadonlyArray<string> };

/**
 * Build the eval-coverage distribution from the dataset's `expected_tools` and
 * (optionally) the most recent eval run's per-sample `events.jsonl` texts.
 * Both a sample's expected_tools sequence and a run's observed tool stream
 * contribute their ordered bigrams, so a bigram is "exercised" if EITHER the
 * dataset asserts it or a real eval run walked it.
 */
export function buildEvalCoverage(
  samples: ReadonlyArray<CoverageSample>,
  runEventTexts: ReadonlyArray<string>,
): EvalCoverage {
  const tools = new Set<string>();
  const bigrams = new Set<string>();
  let hasExpectedTools = false;

  for (const s of samples) {
    const seq = s.expected_tools ?? [];
    if (seq.length > 0) hasExpectedTools = true;
    for (const t of seq) tools.add(t);
    for (let i = 0; i + 1 < seq.length; i += 1) {
      bigrams.add(`${seq[i]}${BIGRAM_SEP}${seq[i + 1]}`);
    }
  }
  for (const text of runEventTexts) {
    const seq = toolNamesFromEventsJsonl(text);
    for (const t of seq) tools.add(t);
    for (let i = 0; i + 1 < seq.length; i += 1) {
      bigrams.add(`${seq[i]}${BIGRAM_SEP}${seq[i + 1]}`);
    }
  }
  return {
    toolsExercised: tools,
    bigramsExercised: bigrams,
    sampleCount: samples.length,
    hasRunEvents: runEventTexts.length > 0,
    hasExpectedTools,
  };
}

// -------- gap computation --------

export type CoverageGapKind = "tool" | "mcp-tool" | "bigram" | "compaction";

export type CoverageGap = {
  readonly kind: CoverageGapKind;
  /** Human-readable subject: a tool name, `A → B` bigram, or "compaction". */
  readonly subject: string;
  /** Sessions the behavior appeared in. */
  readonly sessions: number;
  /** Fraction of scanned sessions (0..1). */
  readonly fraction: number;
  /** One-line rationale for the report. */
  readonly detail: string;
};

export type CoverageReport = {
  readonly specName?: string;
  readonly sessionsScanned: number;
  readonly datasetName?: string;
  readonly sampleCount: number;
  readonly hasRunEvents: boolean;
  /** Ranked (by session frequency desc) production behaviors with no eval. */
  readonly gaps: ReadonlyArray<CoverageGap>;
  /** Input themes with no obviously-covering sample (advisory — inputs aren't
   *  directly intersected, so these are surfaced, not counted as hard gaps). */
  readonly inputThemes: ReadonlyArray<InputTheme>;
};

const pct = (f: number): string => `${Math.round(f * 100)}%`;

/**
 * Intersect the production distribution with the eval coverage and rank the
 * gaps. A tool/bigram is a gap when it appears in ≥1 production session but is
 * never exercised by the dataset or a recent eval run. Compaction is a gap
 * when it fired in prod but no run event stream shows it was exercised (eval
 * runs don't compact, so any prod compaction is by definition uncovered —
 * surfaced whenever it fired at all). Gaps are ranked by session frequency
 * desc, then subject asc for stability.
 */
export function computeCoverage(opts: {
  prod: ProdBehavior;
  evalCov: EvalCoverage;
  specName?: string;
  datasetName?: string;
}): CoverageReport {
  const { prod, evalCov } = opts;
  const gaps: CoverageGap[] = [];
  const n = prod.sessionCount;
  const frac = (c: number): number => (n === 0 ? 0 : c / n);

  for (const [tool, sessions] of prod.toolSessions) {
    if (evalCov.toolsExercised.has(tool)) continue;
    const calls = prod.toolCalls.get(tool) ?? sessions;
    gaps.push({
      kind: isMcpTool(tool) ? "mcp-tool" : "tool",
      subject: tool,
      sessions,
      fraction: frac(sessions),
      detail: `${tool} appears in ${pct(frac(sessions))} of sessions (${sessions}/${n}, ${calls} call(s)) but 0 dataset samples exercise it`,
    });
  }
  for (const [key, sessions] of prod.bigramSessions) {
    if (evalCov.bigramsExercised.has(key)) continue;
    const [a, b] = splitBigram(key);
    gaps.push({
      kind: "bigram",
      subject: `${a} → ${b}`,
      sessions,
      fraction: frac(sessions),
      detail: `tool sequence ${a} → ${b} occurs in ${pct(frac(sessions))} of sessions (${sessions}/${n}) but no expected_tools sequence covers it`,
    });
  }
  if (prod.compactionSessions > 0) {
    const f = frac(prod.compactionSessions);
    gaps.push({
      kind: "compaction",
      subject: "compaction",
      sessions: prod.compactionSessions,
      fraction: f,
      detail: `compaction fired in ${prod.compactionSessions} session(s) (${pct(f)}) but is never exercised in eval — add a long-context sample`,
    });
  }

  gaps.sort(
    (a, b) =>
      b.sessions - a.sessions ||
      kindRank(a.kind) - kindRank(b.kind) ||
      a.subject.localeCompare(b.subject),
  );

  return {
    ...(opts.specName !== undefined ? { specName: opts.specName } : {}),
    sessionsScanned: n,
    ...(opts.datasetName !== undefined ? { datasetName: opts.datasetName } : {}),
    sampleCount: evalCov.sampleCount,
    hasRunEvents: evalCov.hasRunEvents,
    gaps,
    inputThemes: prod.inputThemes,
  };
}

function kindRank(kind: CoverageGapKind): number {
  return kind === "mcp-tool" ? 0 : kind === "tool" ? 1 : kind === "compaction" ? 2 : 3;
}

// -------- rendering --------

/** The JSON backlog — stable, ranked, consumable by `dataset mine`. */
export function renderCoverageJson(report: CoverageReport): string {
  const backlog = report.gaps.map((g) => ({
    kind: g.kind,
    subject: g.subject,
    sessions: g.sessions,
    fraction: Number(g.fraction.toFixed(4)),
    detail: g.detail,
  }));
  return `${JSON.stringify(
    {
      spec: report.specName ?? null,
      dataset: report.datasetName ?? null,
      sessionsScanned: report.sessionsScanned,
      sampleCount: report.sampleCount,
      hasRunEvents: report.hasRunEvents,
      gapCount: report.gaps.length,
      backlog,
      inputThemes: report.inputThemes.map((t) => ({
        label: t.label,
        tokens: t.tokens,
        count: t.count,
        exemplar: t.exemplar,
      })),
    },
    null,
    2,
  )}\n`;
}

/** The plain-text report — the default terminal output. */
export function renderCoverageText(report: CoverageReport): string {
  const lines: string[] = [];
  const forSpec = report.specName !== undefined ? ` for "${report.specName}"` : "";
  lines.push(
    `eval coverage${forSpec}: ${report.sessionsScanned} session(s) vs ${report.sampleCount} dataset sample(s)`,
  );
  if (report.datasetName !== undefined) lines.push(`  dataset: ${report.datasetName}`);
  if (!report.hasRunEvents) {
    lines.push("  (no recent eval run events found — coverage is dataset-expected_tools only)");
  }
  lines.push("");
  if (report.gaps.length === 0) {
    lines.push("no coverage gaps — every production tool/sequence is exercised by the eval.");
  } else {
    lines.push(`${report.gaps.length} coverage gap(s), ranked by production frequency:`);
    for (const g of report.gaps) lines.push(`  - [${g.kind}] ${g.detail}`);
  }
  if (report.inputThemes.length > 0) {
    lines.push("");
    lines.push(
      `production input themes (${report.inputThemes.length}) — check the dataset probes each:`,
    );
    for (const t of report.inputThemes.slice(0, 10)) {
      lines.push(`  - "${t.label}" (${t.count} input(s)) e.g. ${clip(t.exemplar, 80)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Dependency-free HTML report, styled to mirror eval-report / graders-suggest. */
export function renderCoverageHtml(report: CoverageReport): string {
  const forSpec = report.specName !== undefined ? ` — ${escapeHtml(report.specName)}` : "";
  const rows = report.gaps
    .map(
      (g) => `      <tr>
        <td><span class="kind kind-${g.kind}">${escapeHtml(g.kind)}</span></td>
        <td>${escapeHtml(g.subject)}</td>
        <td data-sort="${g.sessions}">${g.sessions} (${pct(g.fraction)})</td>
        <td>${escapeHtml(g.detail)}</td>
      </tr>`,
    )
    .join("\n");
  const themes = report.inputThemes
    .slice(0, 20)
    .map(
      (t) =>
        `      <li><strong>${escapeHtml(t.label)}</strong> — ${t.count} input(s): <code>${escapeHtml(clip(t.exemplar, 120))}</code></li>`,
    )
    .join("\n");
  const gapSection =
    report.gaps.length === 0
      ? `<p class="empty">No coverage gaps — every production tool/sequence is exercised by the eval.</p>`
      : `<table data-sortable>
      <thead><tr><th>kind</th><th>subject</th><th>sessions</th><th>detail</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eval coverage${forSpec}</title>
<style>
:root { --bg:#0f1115; --fg:#e6e6e6; --muted:#999; --card:#1a1d23; --border:#333; --link:#61dafb; --warn:#ffb74d; --mcp:#ef5350; }
* { box-sizing:border-box; }
body { font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--fg); margin:0; padding:24px; line-height:1.5; }
h1 { margin:0 0 8px; } h2 { margin:24px 0 12px; }
.meta { color:var(--muted); font-size:13px; margin-bottom:16px; }
table { width:100%; border-collapse:collapse; background:var(--card); border-radius:6px; overflow:hidden; }
th,td { padding:10px 14px; text-align:left; border-bottom:1px solid var(--border); font-size:14px; vertical-align:top; }
th { background:#14171c; cursor:pointer; user-select:none; } th:hover { color:var(--link); }
tr:last-child td { border-bottom:none; }
code { background:#0a0c10; padding:2px 5px; border-radius:4px; font-size:12px; }
.kind { font-weight:600; font-size:12px; text-transform:uppercase; }
.kind-mcp-tool { color:var(--mcp); } .kind-tool { color:var(--link); } .kind-bigram { color:var(--warn); } .kind-compaction { color:var(--muted); }
.empty { color:var(--muted); } ul { padding-left:20px; }
</style>
</head>
<body>
<h1>eval coverage${forSpec}</h1>
<p class="meta">${report.sessionsScanned} session(s) scanned vs ${report.sampleCount} dataset sample(s)${report.datasetName !== undefined ? ` (${escapeHtml(report.datasetName)})` : ""}${report.hasRunEvents ? "" : " — no recent eval run events; coverage is dataset-expected_tools only"}. ${report.gaps.length} gap(s).</p>
<h2>Coverage gaps</h2>
${gapSection}
${report.inputThemes.length > 0 ? `<h2>Production input themes</h2>\n<ul>\n${themes}\n</ul>` : ""}
<script>
(function(){
  function sortTable(table,col){var tb=table.querySelector('tbody');if(!tb)return;var rows=Array.from(tb.rows);var asc=table.dataset.sortCol===String(col)?table.dataset.sortDir!=='asc':true;rows.sort(function(a,b){var va=a.cells[col].dataset.sort||a.cells[col].textContent.trim();var vb=b.cells[col].dataset.sort||b.cells[col].textContent.trim();var na=parseFloat(va),nb=parseFloat(vb);if(!isNaN(na)&&!isNaN(nb))return asc?na-nb:nb-na;return asc?va.localeCompare(vb):vb.localeCompare(va);});rows.forEach(function(r){tb.appendChild(r);});table.dataset.sortCol=String(col);table.dataset.sortDir=asc?'asc':'desc';}
  document.querySelectorAll('table[data-sortable] th').forEach(function(th,i){th.addEventListener('click',function(){sortTable(th.closest('table'),i);});});
})();
</script>
</body>
</html>
`;
}

/** Dispatch the requested format. */
export function renderCoverage(report: CoverageReport, format: CoverageFormat): string {
  if (format === "json") return renderCoverageJson(report);
  if (format === "html") return renderCoverageHtml(report);
  return renderCoverageText(report);
}

/** Suggested output filename for a `-o <dir>` write (text/html/json). */
export function coverageFileName(format: CoverageFormat): string {
  return format === "html" ? "coverage.html" : format === "json" ? "coverage.json" : "coverage.txt";
}

// Re-export for the CLI wiring's convenience (kept explicit so callers don't
// reach into graders-suggest for the shared session-turn shape).
export type { SessionTurn };
