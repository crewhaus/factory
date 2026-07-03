/**
 * Item 4 — `crewhaus graders suggest`: draft grader suites from the failure
 * rationale that already accumulates on disk, instead of hand-authoring
 * gotcha-prone graders.yaml files from scratch.
 *
 * Evidence sources (all read-side, none mutated):
 * - Per-sample grader rationale from recent eval run dirs (the grades.json
 *   the runner persists next to results.json), located via the item-3
 *   run-history index for the cwd spec.
 * - Judge criterionScores where present in grades.json (GradeResult carries
 *   no structured output today, so this is a defensive parse that lights up
 *   as soon as a judge grader persists them).
 * - User feedback comments (`extractFeedbackRecords` rows) — down-rated
 *   comments join the failure evidence; up-rated turns join the pass
 *   exemplars.
 *
 * Pipeline: failure texts cluster into themes DETERMINISTICALLY (normalized
 * token overlap — no model call needed to cluster); each theme then gets a
 * deterministic draft grader (tool_call_sequence / json_path / regex /
 * contains, in that priority order) derived from the observed up-rated
 * outputs; with `--model`/credentials one complete llm_judge rubric (all
 * five anchors) is additionally drafted from real good/bad exemplars — the
 * model call itself lives in the CLI entry file, this module owns the pure
 * prompt builder + response parser.
 *
 * The output is a REVIEW file (never auto-applied) whose header documents
 * the hard-AND collapse: `crewhaus eval` combines stacked graders with
 * eval-grader's `all(...)` (min-score, every-grader-must-pass), so the file
 * tells the user to adopt ONE grader rather than the whole stack.
 *
 * Kept in a side-effect-free module (the CLI entry file runs an argv switch
 * on import) mirroring `feedback.ts` / `triage.ts`.
 */
import type { LoadedRun } from "@crewhaus/eval-report";
import {
  type FeedbackRecord,
  type GraderSpecObject,
  type GradersConfigObject,
  type SessionTurn,
  gradersConfigToYaml,
  mergeFeedback,
  normalizeRating,
} from "./feedback";

/** Thrown on malformed flags / unusable evidence. The CLI entry file routes
 *  it through `die()`; tests assert on `.message`. */
export class GradersSuggestError extends Error {
  override readonly name = "GradersSuggestError";
}

/** How many recent runs (for the cwd spec) feed the suggestion by default. */
export const DEFAULT_SUGGEST_RUNS = 10;

/** Default output path for the review file. */
export const DEFAULT_SUGGESTED_GRADERS_FILE = "graders-suggested.yaml";

/** One-liner printed by `crewhaus distill` when it falls back to the floor
 *  grader (see {@link isFloorGraderConfig}). */
export const FLOOR_GRADER_HINT =
  "hint: draft sharper graders from recent eval failures and ratings with `crewhaus graders suggest`";

/** True when a synthesized config is exactly the non-empty-answer floor
 *  grader `synthesizeGraders` emits when the ratings carry no signal — the
 *  trigger for the {@link FLOOR_GRADER_HINT} suggestion hook. */
export function isFloorGraderConfig(config: GradersConfigObject): boolean {
  const g = config.graders[0];
  return (
    config.graders.length === 1 &&
    g !== undefined &&
    g.type === "regex" &&
    g.name === "non_empty_answer"
  );
}

// -------- --runs flag --------

export type RunsSelector = { kind: "dir"; dir: string } | { kind: "last"; n: number };

/** Parse `--runs`: `last:N` / `last N` selects the N most recent indexed
 *  runs; anything else is a run directory path. */
export function parseRunsFlag(value: string): RunsSelector {
  const m = /^last[:\s]?(\d+)$/i.exec(value.trim());
  if (m !== null) {
    const n = Number.parseInt(m[1] as string, 10);
    if (n < 1) throw new GradersSuggestError(`invalid --runs "${value}" — need at least 1 run`);
    return { kind: "last", n };
  }
  return { kind: "dir", dir: value };
}

// -------- evidence extraction --------

/** One failing grader verdict (or down-rated comment), joined to its sample. */
export type FailureEvidence = {
  readonly sampleId: string;
  /** runId, or "feedback" for rating comments. */
  readonly runId: string;
  /** Grader name, `<grader>:criterion`, or "user_feedback". */
  readonly source: string;
  /** Cleaned rationale/comment text — the clustering signal. */
  readonly text: string;
  /** The failing output, when known (discriminative-token drafting). */
  readonly output?: string;
};

/** One up-rated output — a passing eval sample or a thumbs-up turn. */
export type PassExemplar = {
  readonly sampleId: string;
  readonly runId: string;
  readonly output: string;
  readonly toolNames: ReadonlyArray<string>;
};

export type SuggestEvidence = {
  readonly failures: ReadonlyArray<FailureEvidence>;
  readonly passes: ReadonlyArray<PassExemplar>;
};

/** Mirror of eval-runner's per-sample dir sanitizer — the key LoadedRun's
 *  perSample map uses. Keep in sync with run-sample.ts. */
export function sanitizeSampleId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Unique tool names (first-seen order) from a per-sample events.jsonl —
 *  `tool_call_end` trace events carry the runtime tool name. Tolerant of
 *  torn/corrupt lines. */
export function toolNamesFromEventsJsonl(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ev = parsed as { kind?: unknown; toolName?: unknown };
    if (ev.kind !== "tool_call_end" || typeof ev.toolName !== "string") continue;
    if (seen.has(ev.toolName)) continue;
    seen.add(ev.toolName);
    out.push(ev.toolName);
  }
  return out;
}

/**
 * Strip runner/judge boilerplate from a grader rationale so clustering sees
 * the substance: the `[name: ✗]` combinator markers, the `judge=N (need
 * ≥M):` prefix. Infra noise ("grader threw: …", "agent invocation error:
 * …") returns "" — an outage is not a failure theme.
 */
export function cleanRationale(rationale: string): string {
  let s = rationale.trim();
  if (s.startsWith("grader threw:") || s.startsWith("agent invocation error")) return "";
  s = s.replace(/\[[^\]]*: [✓✗]\]/g, " ");
  s = s.replace(/judge=\d+(?:\.\d+)? \(need ≥\d+(?:\.\d+)?\):/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Defensive parse of a raw grades.json for judge criterionScores (not part
 *  of GradeResult today — see the module doc). Criteria scored ≤ 2 of 5
 *  become failure evidence in their own right. */
export function criterionEvidence(
  gradesText: string,
  sampleId: string,
  runId: string,
): FailureEvidence[] {
  if (gradesText.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(gradesText);
  } catch {
    return [];
  }
  const perGrader = (parsed as { perGrader?: unknown }).perGrader;
  if (!Array.isArray(perGrader)) return [];
  const out: FailureEvidence[] = [];
  for (const entry of perGrader) {
    const e = entry as { name?: unknown; criterionScores?: unknown };
    if (typeof e.name !== "string" || typeof e.criterionScores !== "object") continue;
    if (e.criterionScores === null) continue;
    const scores = Object.entries(e.criterionScores as Record<string, unknown>)
      .filter((kv): kv is [string, number] => typeof kv[1] === "number" && kv[1] <= 2)
      .sort((a, b) => a[0].localeCompare(b[0]));
    for (const [criterion, score] of scores) {
      out.push({
        sampleId,
        runId,
        source: `${e.name}:criterion`,
        text: `judge criterion ${criterion} scored ${score}/5`,
      });
    }
  }
  return out;
}

/**
 * Extract failure evidence + pass exemplars from one loaded eval run.
 * Samples are visited in sampleId order (determinism), errored/grader-threw
 * samples are skipped wholesale (infra noise, not a failure theme — the
 * same posture as triage's pin guards).
 */
export function evidenceFromRun(run: LoadedRun): SuggestEvidence {
  const runId = run.summary.runId;
  const failures: FailureEvidence[] = [];
  const passes: PassExemplar[] = [];
  const samples = [...run.summary.samples].sort((a, b) => a.sampleId.localeCompare(b.sampleId));
  for (const s of samples) {
    if (s.error !== undefined || s.graderError !== undefined) continue;
    const perSample = run.perSample[sanitizeSampleId(s.sampleId)];
    if (s.grades.overall.passed) {
      passes.push({
        sampleId: s.sampleId,
        runId,
        output: s.agentOutput,
        toolNames: toolNamesFromEventsJsonl(perSample?.events ?? ""),
      });
      continue;
    }
    for (const g of s.grades.perGrader) {
      if (g.passed) continue;
      const text = cleanRationale(g.rationale);
      if (text === "") continue;
      failures.push({ sampleId: s.sampleId, runId, source: g.name, text, output: s.agentOutput });
    }
    failures.push(...criterionEvidence(perSample?.grades ?? "", s.sampleId, runId));
  }
  return { failures, passes };
}

/**
 * Fold user ratings into the evidence: down-rated comments become failure
 * evidence, up-rated turns become pass exemplars (their outputs + observed
 * tool names). Positive comments are returned separately — they season the
 * llm_judge rubric prompt, not the clustering.
 */
export function evidenceFromFeedback(
  turns: ReadonlyArray<SessionTurn>,
  records: ReadonlyArray<FeedbackRecord>,
  minScore: number,
): SuggestEvidence & { positiveComments: string[] } {
  const turnByKey = new Map<string, SessionTurn>();
  for (const t of turns) turnByKey.set(`${t.sessionId}#${t.turnNumber}`, t);
  const failures: FailureEvidence[] = [];
  const passes: PassExemplar[] = [];
  const positiveComments: string[] = [];
  for (const fb of mergeFeedback(records)) {
    const turn = turnByKey.get(`${fb.sessionId}#${fb.turnNumber}`);
    if (turn === undefined) continue;
    const score = normalizeRating(fb);
    const isPositive = (score !== undefined && score >= minScore) || fb.correction !== undefined;
    const sampleId = `${fb.sessionId}_t${fb.turnNumber}`;
    if (isPositive) {
      if (turn.output.trim() !== "") {
        passes.push({
          sampleId,
          runId: "feedback",
          output: turn.output,
          toolNames: turn.toolNames,
        });
      }
      if (fb.comment !== undefined && fb.comment.trim() !== "") {
        positiveComments.push(fb.comment);
      }
    } else if (fb.comment !== undefined && fb.comment.trim() !== "") {
      failures.push({
        sampleId,
        runId: "feedback",
        source: "user_feedback",
        text: fb.comment,
        output: turn.output,
      });
    }
  }
  return { failures, passes, positiveComments };
}

// -------- deterministic clustering --------

/** Stopwords for the theme tokens: common English glue plus grader-rationale
 *  boilerplate that would otherwise weld unrelated failures together. */
const THEME_STOPWORDS = new Set([
  "the",
  "and",
  "that",
  "this",
  "with",
  "from",
  "your",
  "have",
  "will",
  "here",
  "there",
  "what",
  "when",
  "which",
  "would",
  "could",
  "should",
  "about",
  "into",
  "then",
  "than",
  "them",
  "they",
  "you",
  "for",
  "are",
  "was",
  "were",
  "its",
  "not",
  "but",
  "does",
  // grader-rationale boilerplate
  "output",
  "expected",
  "got",
  "saw",
]);

/** Normalized token list for one evidence text: lowercase, alphanumeric,
 *  length ≥ 3, non-stopword, unique, in first-seen order. */
export function normalizeEvidenceTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || THEME_STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

export type FailureTheme = {
  /** Top tokens joined — the human handle for the theme. */
  readonly label: string;
  readonly tokens: ReadonlyArray<string>;
  readonly items: ReadonlyArray<FailureEvidence>;
  readonly sampleIds: ReadonlyArray<string>;
  readonly runIds: ReadonlyArray<string>;
  readonly sources: ReadonlyArray<string>;
};

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Deterministic greedy clustering by normalized token overlap — no model
 * call. Items are visited in a stable sort order (runId, sampleId, source,
 * text) and joined to the best existing cluster when the Jaccard overlap
 * with its SEED item's tokens reaches `threshold` (seed comparison keeps a
 * cluster from drifting as it grows); otherwise they seed a new cluster.
 * Themes come back largest-first, labelled by their most frequent tokens.
 */
export function clusterFailures(
  items: ReadonlyArray<FailureEvidence>,
  opts: { threshold?: number } = {},
): FailureTheme[] {
  const threshold = opts.threshold ?? 0.34;
  const sorted = [...items].sort(
    (a, b) =>
      a.runId.localeCompare(b.runId) ||
      a.sampleId.localeCompare(b.sampleId) ||
      a.source.localeCompare(b.source) ||
      a.text.localeCompare(b.text),
  );
  const clusters: Array<{
    seed: Set<string>;
    items: FailureEvidence[];
    tokenSets: Array<Set<string>>;
  }> = [];
  for (const item of sorted) {
    const tokens = new Set(normalizeEvidenceTokens(item.text));
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
      c.items.push(item);
      c.tokenSets.push(tokens);
    } else {
      clusters.push({ seed: tokens, items: [item], tokenSets: [tokens] });
    }
  }
  const themes = clusters.map((c) => {
    const freq = new Map<string, number>();
    for (const set of c.tokenSets) {
      for (const t of set) freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    const tokens = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([t]) => t);
    return {
      label: tokens.join(" "),
      tokens,
      items: c.items as ReadonlyArray<FailureEvidence>,
      sampleIds: [...new Set(c.items.map((i) => i.sampleId))],
      runIds: [...new Set(c.items.map((i) => i.runId))],
      sources: [...new Set(c.items.map((i) => i.source))].sort(),
    };
  });
  return themes.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
}

// -------- deterministic grader drafting --------

export type SuggestedGrader = {
  readonly spec: GraderSpecObject;
  /** Comment lines (without the leading `# `) citing the evidence. */
  readonly evidence: ReadonlyArray<string>;
};

export type DraftResult = {
  readonly suggestions: ReadonlyArray<SuggestedGrader>;
  /** Themes no deterministic grader could be drafted for. */
  readonly undrafted: ReadonlyArray<FailureTheme>;
};

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

function themeEvidenceLine(theme: FailureTheme): string {
  return (
    `evidence: ${theme.items.length} failing rationale(s) on ${theme.sampleIds.length} sample(s) ` +
    `across ${theme.runIds.length} run(s)/source(s) [${theme.sources.join(", ")}]`
  );
}

/** Tools present in EVERY tool-using pass exemplar (falling back to the
 *  single most common tool) — the same selection `synthesizeGraders` makes. */
function sharedPassTools(passes: ReadonlyArray<PassExemplar>): string[] {
  const counts = new Map<string, number>();
  let toolUsing = 0;
  for (const p of passes) {
    const uniq = [...new Set(p.toolNames)];
    if (uniq.length > 0) toolUsing += 1;
    for (const t of uniq) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (toolUsing === 0 || counts.size === 0) return [];
  const inEvery = [...counts.entries()]
    .filter(([, c]) => c === toolUsing)
    .map(([t]) => t)
    .sort();
  if (inEvery.length > 0) return inEvery;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return top !== undefined ? [top[0]] : [];
}

function themeMentionsTools(theme: FailureTheme, toolNames: ReadonlyArray<string>): boolean {
  if (theme.tokens.includes("tool") || theme.tokens.includes("tools")) return true;
  const lowered = new Set(toolNames.map((t) => t.toLowerCase()));
  return theme.items.some((i) => normalizeEvidenceTokens(i.text).some((tok) => lowered.has(tok)));
}

/** All pass outputs parse as JSON objects sharing ≥1 top-level key → that
 *  key (alphabetically first among common keys); undefined otherwise. */
function commonJsonKey(passes: ReadonlyArray<PassExemplar>): string | undefined {
  if (passes.length === 0) return undefined;
  let common: Set<string> | undefined;
  for (const p of passes) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(p.output);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const keys = new Set(Object.keys(parsed as Record<string, unknown>));
    common = common === undefined ? keys : new Set([...common].filter((k) => keys.has(k)));
  }
  const sorted = [...(common ?? [])].sort();
  return sorted[0];
}

/** Longest common prefix of the trimmed pass outputs (≥ 2 passes, ≥ 4
 *  chars, must contain a non-space char); undefined otherwise. */
function commonOutputPrefix(passes: ReadonlyArray<PassExemplar>): string | undefined {
  if (passes.length < 2) return undefined;
  const outputs = passes.map((p) => p.output.trim());
  if (outputs.some((o) => o === "")) return undefined;
  let prefix = outputs[0] as string;
  for (const o of outputs.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < o.length && prefix[i] === o[i]) i += 1;
    prefix = prefix.slice(0, i);
    if (prefix === "") return undefined;
  }
  prefix = prefix.trimEnd();
  if (prefix.length < 4 || prefix.trim() === "") return undefined;
  return prefix.slice(0, 60);
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The most discriminative token: appears in ≥ half of the up-rated outputs
 * and is ranked by how much rarer it is in the failing outputs (pass
 * document-frequency minus fail document-frequency, ties alphabetical).
 */
function discriminativeToken(
  passes: ReadonlyArray<PassExemplar>,
  failOutputs: ReadonlyArray<string>,
): string | undefined {
  const nonEmpty = passes.map((p) => p.output).filter((o) => o.trim() !== "");
  if (nonEmpty.length === 0) return undefined;
  const passFreq = new Map<string, number>();
  for (const output of nonEmpty) {
    for (const t of new Set(normalizeEvidenceTokens(output))) {
      passFreq.set(t, (passFreq.get(t) ?? 0) + 1);
    }
  }
  const failFreq = new Map<string, number>();
  const fails = failOutputs.filter((o) => o.trim() !== "");
  for (const output of fails) {
    for (const t of new Set(normalizeEvidenceTokens(output))) {
      failFreq.set(t, (failFreq.get(t) ?? 0) + 1);
    }
  }
  const threshold = Math.ceil(nonEmpty.length / 2);
  const ranked = [...passFreq.entries()]
    .filter(([t, c]) => t.length >= 4 && c >= threshold)
    .map(([t, c]) => ({
      token: t,
      score: c / nonEmpty.length - (fails.length === 0 ? 0 : (failFreq.get(t) ?? 0) / fails.length),
    }))
    .sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));
  const best = ranked[0];
  // A token every failing output also carries discriminates nothing.
  return best !== undefined && best.score > 0 ? best.token : undefined;
}

/**
 * Draft one deterministic grader per failure theme from the observed
 * up-rated outputs, in priority order: tool_call_sequence (theme mentions
 * tools + passes share tools) → json_path (all pass outputs are JSON
 * objects with a common key) → regex (shared output prefix) → contains
 * (discriminative pass token). Themes with no deterministic signal come
 * back in `undrafted` so the review file can note them.
 */
export function draftGradersForThemes(
  themes: ReadonlyArray<FailureTheme>,
  passes: ReadonlyArray<PassExemplar>,
): DraftResult {
  const suggestions: SuggestedGrader[] = [];
  const undrafted: FailureTheme[] = [];
  const usedNames = new Set<string>();
  const uniqueName = (base: string): string => {
    let name = base;
    let i = 2;
    while (usedNames.has(name)) {
      name = `${base}_${i}`;
      i += 1;
    }
    usedNames.add(name);
    return name;
  };

  const passTools = sharedPassTools(passes);
  const jsonKey = commonJsonKey(passes);
  const prefix = commonOutputPrefix(passes);

  for (const theme of themes) {
    const rawSlug = slugify(theme.label);
    const slug = rawSlug === "" ? "theme" : rawSlug;
    const failOutputs = theme.items
      .map((i) => i.output)
      .filter((o): o is string => o !== undefined);

    if (passTools.length > 0 && themeMentionsTools(theme, passTools)) {
      suggestions.push({
        spec: {
          name: uniqueName(`suggested_tools_${slug}`),
          type: "tool_call_sequence",
          expected: passTools,
          mode: "set",
        },
        evidence: [
          themeEvidenceLine(theme),
          `drafted from ${passes.length} up-rated output(s): every tool-using one called [${passTools.join(", ")}]`,
        ],
      });
      continue;
    }
    if (jsonKey !== undefined) {
      const path = /^[A-Za-z_][A-Za-z0-9_]*$/.test(jsonKey)
        ? `$.${jsonKey}`
        : `$[${JSON.stringify(jsonKey)}]`;
      suggestions.push({
        spec: { name: uniqueName(`suggested_json_${slug}`), type: "json_path", path },
        evidence: [
          themeEvidenceLine(theme),
          `drafted from ${passes.length} up-rated output(s): all are JSON objects carrying key "${jsonKey}"`,
        ],
      });
      continue;
    }
    if (prefix !== undefined) {
      suggestions.push({
        spec: {
          name: uniqueName(`suggested_format_${slug}`),
          type: "regex",
          pattern: `^${escapeRegex(prefix)}`,
        },
        evidence: [
          themeEvidenceLine(theme),
          `drafted from ${passes.length} up-rated output(s): all start with "${prefix}"`,
        ],
      });
      continue;
    }
    const token = discriminativeToken(passes, failOutputs);
    if (token !== undefined) {
      suggestions.push({
        spec: {
          name: uniqueName(`suggested_contains_${slug}`),
          type: "contains",
          substring: token,
          case_insensitive: true,
        },
        evidence: [
          themeEvidenceLine(theme),
          `drafted from ${passes.length} up-rated output(s): "${token}" is common in up-rated outputs and rare in failing ones`,
        ],
      });
      continue;
    }
    undrafted.push(theme);
  }
  return { suggestions, undrafted };
}

// -------- model-drafted llm_judge rubric (pure halves) --------

/** System block for the one-shot rubric drafting call. */
export const RUBRIC_SUGGESTION_SYSTEM = `You design eval rubrics for AI agent harnesses. You will receive real GOOD exemplars (outputs users or graders rated up), real BAD evidence (grader rationales / user complaints), and the clustered failure themes. Write one llm_judge rubric criterion that separates the good from the bad.

Hard rules:
- Output exactly one JSON object: {"name": "...", "description": "...", "anchors": {"1": "...", "2": "...", "3": "...", "4": "...", "5": "..."}, "passing_score": 3}. No text outside the JSON.
- "name" is a short snake_case identifier.
- The five anchors must be concrete, observable behaviors grounded in the exemplars — 1 is the worst observed failure mode, 5 is the best observed behavior.
- Do not quote any exemplar verbatim for more than a short phrase.`;

const MAX_EXEMPLARS_IN_PROMPT = 4;
const MAX_EXEMPLAR_CHARS = 600;

const clipExemplar = (s: string): string =>
  s.length > MAX_EXEMPLAR_CHARS ? `${s.slice(0, MAX_EXEMPLAR_CHARS)}…` : s;

/** The user message for the rubric call: clipped good/bad exemplars + the
 *  deterministic theme labels. */
export function buildRubricSuggestionPrompt(
  goodOutputs: ReadonlyArray<string>,
  badEvidence: ReadonlyArray<FailureEvidence>,
  themes: ReadonlyArray<FailureTheme>,
): string {
  const good = goodOutputs
    .filter((o) => o.trim() !== "")
    .slice(0, MAX_EXEMPLARS_IN_PROMPT)
    .map((o, i) => `GOOD ${i + 1}:\n${clipExemplar(o)}`);
  const bad = badEvidence
    .slice(0, MAX_EXEMPLARS_IN_PROMPT)
    .map((e, i) => `BAD ${i + 1} (${e.source}): ${clipExemplar(e.text)}`);
  const themeLines = themes.map((t) => `- ${t.label} (${t.items.length} rationale(s))`);
  return [
    "FAILURE THEMES:",
    ...(themeLines.length > 0 ? themeLines : ["(none clustered)"]),
    "",
    ...(good.length > 0 ? good : ["(no up-rated exemplars)"]),
    "",
    ...(bad.length > 0 ? bad : ["(no failure evidence)"]),
    "",
    "Write the rubric JSON now.",
  ].join("\n");
}

const ANCHOR_KEYS = ["1", "2", "3", "4", "5"] as const;

/**
 * Tolerant parse of the rubric response into a complete single-criterion
 * `llm_judge` GraderSpecObject (all five anchors required). Returns
 * undefined on ANY shape failure — the caller keeps the deterministic
 * suggestions and notes the skipped rubric.
 */
export function parseRubricSuggestion(raw: string, model?: string): GraderSpecObject | undefined {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return undefined;
  }
  const r = parsed as {
    name?: unknown;
    description?: unknown;
    anchors?: unknown;
    passing_score?: unknown;
  };
  if (typeof r.description !== "string" || r.description.trim() === "") return undefined;
  if (typeof r.anchors !== "object" || r.anchors === null) return undefined;
  const anchorsIn = r.anchors as Record<string, unknown>;
  const anchors: Record<string, string> = {};
  for (const k of ANCHOR_KEYS) {
    const v = anchorsIn[k];
    if (typeof v !== "string" || v.trim() === "") return undefined;
    anchors[k] = v;
  }
  const rawName = typeof r.name === "string" ? slugify(r.name) : "";
  const name = rawName === "" ? "suggested_judge_rubric" : rawName;
  const passing =
    typeof r.passing_score === "number" && r.passing_score >= 1 && r.passing_score <= 5
      ? r.passing_score
      : 3;
  return {
    name,
    type: "llm_judge",
    rubric: {
      criteria: [
        {
          name,
          description: r.description,
          anchors: anchors as { "1": string; "2": string; "3": string; "4": string; "5": string },
        },
      ],
      passing_score: passing,
    },
    ...(model !== undefined ? { model } : {}),
  };
}

// -------- review-file rendering --------

export type RenderSuggestionsOptions = {
  readonly specName?: string;
  readonly runsSeen: number;
  readonly failureCount: number;
  readonly feedbackCount: number;
  readonly undraftedLabels: ReadonlyArray<string>;
};

/**
 * Render the review file: a hard-AND-aware header, then a valid graders.yaml
 * (parseable by `parseGradersConfig`, so a reviewed grader can be copied —
 * or the file trimmed to one grader and used directly), with each grader
 * preceded by a `# evidence:` comment citing what it was drafted from.
 */
export function renderSuggestedGradersYaml(
  suggestions: ReadonlyArray<SuggestedGrader>,
  opts: RenderSuggestionsOptions,
): string {
  if (suggestions.length === 0) {
    throw new GradersSuggestError("no graders to render — nothing was drafted");
  }
  const forSpec = opts.specName !== undefined ? ` for spec "${opts.specName}"` : "";
  const feedbackNote =
    opts.feedbackCount > 0 ? ` + ${opts.feedbackCount} user feedback comment(s)` : "";
  const judgeCount = suggestions.filter((s) => s.spec.type === "llm_judge").length;
  const header: string[] = [
    `# Drafted by \`crewhaus graders suggest\`${forSpec} from ${opts.failureCount} failure rationale(s)`,
    `# across ${opts.runsSeen} eval run(s)${feedbackNote}. REVIEW FILE — never applied automatically.`,
    "#",
    "# GOTCHA — stacking graders hard-ANDs their scores: `crewhaus eval` combines every",
    "# grader in a graders.yaml with eval-grader's `all(...)` (overall passes only when",
    "# EVERY grader passes; overall score is the minimum). Do NOT adopt this whole file.",
    `# Adopt ONE grader into eval/graders.yaml${judgeCount > 0 ? " — the llm_judge rubric is the broadest single choice" : ""};`,
    "# only stack additional graders you genuinely want ALL to pass on every sample.",
  ];
  if (opts.undraftedLabels.length > 0) {
    header.push(
      "#",
      `# ${opts.undraftedLabels.length} theme(s) had no deterministic signal in the up-rated outputs`,
      `# (${opts.undraftedLabels.join("; ")}) — consider an llm_judge rubric for those.`,
    );
  }
  const yaml = gradersConfigToYaml({ graders: suggestions.map((s) => s.spec) }, header);
  const lines = yaml.split("\n");
  const out: string[] = [];
  let graderIdx = 0;
  for (const line of lines) {
    if (line.startsWith("  - name:")) {
      const suggestion = suggestions[graderIdx];
      graderIdx += 1;
      for (const evidence of suggestion?.evidence ?? []) {
        out.push(`  # ${evidence}`);
      }
    }
    out.push(line);
  }
  return out.join("\n");
}
