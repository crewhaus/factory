/**
 * M3 · MEMORY — watch-me: analytics, the reports browser, the intents
 * ranking, the watch toggle, and the synthesize review flow.
 *
 * Owned by the Memory implementer. The M1 `watchmeView` read stays in
 * `memory.ts`.
 *
 * Three properties of this subsystem the manager preserves rather than
 * papers over:
 *
 *   1. JUDGMENTS ARE NOT FEEDBACK. `watchme/judgments.jsonl` (what the judge
 *      thought) and `.crewhaus/feedback/feedback.jsonl` (what a human said)
 *      are separate stores BY DESIGN. They come back in separate blocks,
 *      each labelled with its source, and are never summed into one
 *      "quality" number. The `feedback` counters inside an observation are
 *      watchme's OWN tally of what it observed, so they ride under
 *      `observedFeedback` — never under `judgments`.
 *   2. SYNTHESIZE IS ADVISORY. `watchme/synthesized/` holds PROPOSED mimic
 *      specs. Reading one is not applying it — applying is a separate,
 *      explicit gesture that goes through the spec write path, edit by
 *      edit, with the human-owned/auto-tunable split enforced exactly as it
 *      is for a hand edit.
 *   3. UNPRICED COST IS ITS OWN BUCKET. Observations carry an `unpriced`
 *      flag per model; folding those into "$0" turns a measurement gap into
 *      a false zero. They are counted, listed and reported as unpriced.
 *
 * `watchme:` is a human-owned spec block, so the watch toggle is a
 * confirm-gated spec edit — not a side-channel flag file. Writing
 * `watchme/state.json` would be the side channel: `crewhaus watchme
 * start/stop` owns that file, and a console that raced it would make the
 * spec and the runtime disagree.
 *
 * Publishing to the wiki offers `--dry-run` FIRST: it writes articles into
 * the memory fabric, and a preview is the difference between a review and a
 * surprise.
 *
 * ---------------------------------------------------------------------------
 * READS ARE CAPPED HERE, NOT IN THE STORE
 * ---------------------------------------------------------------------------
 * `@crewhaus/watchme-store` reads its JSONL files whole; this server never
 * does (a long-horizon store is exactly the file that grows without bound).
 * So the line GRAMMAR comes from the store's types and its documented folds
 * — including last-writer-wins per `sessionId`, which is what keeps a
 * re-analyzed session from being counted twice — while the reading is done
 * through the capped, torn-line-tolerant reader every other JSONL in this
 * package uses.
 */
import { existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpec } from "@crewhaus/spec";
import {
  OPTIMIZABLE_PATHS,
  type SpecEdit,
  applySpecEdits,
  diffSpecYaml,
} from "@crewhaus/spec-patch";
import type {
  WatchmeAggregate,
  WatchmeJudgment,
  WatchmeObservation,
} from "@crewhaus/watchme-store";
import { MAX_TEXT_BYTES, SAFE_SEGMENT_RE } from "./constants";
import { HttpError } from "./http";
import { readJsonlCapped, readTextCapped } from "./jsonl";
import type { M3Context, M3Handler } from "./m3";
import { isDryRun, requireBoolean, requireTypedConfirm } from "./m3";
import { maskDeep, maskText } from "./mask";
import {
  containedPath,
  describeFailure,
  harnessDirOf,
  harnessSpecName,
  listDirSafe,
  listSubdirs,
  readBase,
  readJsonSafe,
  readProse,
  specBlock,
  specScalar,
} from "./memory-ops";
import { readSpecYaml } from "./schedulers";

const START_VERB = "crewhaus watchme start";
const REPORT_VERB = "crewhaus watchme report";

/** The three co-learning articles `watchme publish` upserts. */
const PUBLISH_SLUGS = ["watchme-intents", "watchme-model-fit", "watchme-pitfalls"] as const;

// ---------------------------------------------------------------------------
// capped store reads
// ---------------------------------------------------------------------------

function watchmeFile(ctx: M3Context, name: string): string | undefined {
  const path = containedPath(ctx, [".crewhaus", "watchme", name]);
  return path !== undefined && existsSync(path) ? path : undefined;
}

type WatchmeRead = {
  readonly observations: readonly WatchmeObservation[];
  readonly aggregates: readonly WatchmeAggregate[];
  readonly truncated: boolean;
  readonly torn: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Raw observation lines + `{agg:1}` aggregate lines, capped.
 *
 * The store's documented fold applies: observations are LAST-WRITER-WINS per
 * `sessionId`, because a session that grew is re-analyzed and re-appended —
 * summing both lines would double-count the same conversation.
 */
function readWatchme(ctx: M3Context): WatchmeRead {
  const path = watchmeFile(ctx, "observations.jsonl");
  if (path === undefined) return { observations: [], aggregates: [], truncated: false, torn: 0 };
  const read = readJsonlCapped(path);
  const bySession = new Map<string, WatchmeObservation>();
  const aggregates: WatchmeAggregate[] = [];
  for (const line of read.objects) {
    if (!isRecord(line)) continue;
    if (line["agg"] === 1) {
      aggregates.push(line as unknown as WatchmeAggregate);
      continue;
    }
    if (typeof line["sessionId"] !== "string") continue;
    bySession.set(line["sessionId"], line as unknown as WatchmeObservation);
  }
  return {
    observations: [...bySession.values()],
    aggregates,
    truncated: read.truncated,
    torn: read.tornCount,
  };
}

function readJudgments(ctx: M3Context): {
  judgments: readonly WatchmeJudgment[];
  truncated: boolean;
} {
  const path = watchmeFile(ctx, "judgments.jsonl");
  if (path === undefined) return { judgments: [], truncated: false };
  const read = readJsonlCapped(path);
  const judgments: WatchmeJudgment[] = [];
  for (const line of read.objects) {
    if (!isRecord(line) || typeof line["sessionId"] !== "string") continue;
    judgments.push(line as unknown as WatchmeJudgment);
  }
  return { judgments, truncated: read.truncated };
}

function watchmeState(ctx: M3Context): Record<string, unknown> | null {
  const path = watchmeFile(ctx, "state.json");
  const state = readJsonSafe(path);
  return isRecord(state) ? state : null;
}

// ---------------------------------------------------------------------------
// analytics
// ---------------------------------------------------------------------------

type ModelFold = {
  wire: string;
  spec: string | null;
  provider: string;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreate: number;
  costUsdMicros: number;
  unpriced: boolean;
};

/**
 * `GET /api/h/:id/memory/watchme/analytics` — the charts.
 *
 * From `watchme/observations.jsonl` plus the `{agg:1}` Welford aggregate
 * lines: turns, per-model cost (with the UNKNOWN-unpriced bucket kept
 * distinct), tool error rates, the observed feedback tally, and the
 * continuity/factuality scores. Capped and torn-line tolerant.
 */
export const watchmeAnalytics: M3Handler = (ctx) => {
  const { observations, aggregates, truncated, torn } = readWatchme(ctx);
  const state = watchmeState(ctx);
  const { judgments, truncated: judgmentsTruncated } = readJudgments(ctx);

  const models = new Map<string, ModelFold>();
  const tools = new Map<string, { name: string; calls: number; errors: number }>();
  const continuity = new Map<string, { name: string; total: number; passed: number; n: number }>();
  let turns = 0;
  let ratings = 0;
  let ratingSum = 0;
  let judged = 0;
  let judgeSum = 0;
  let up = 0;
  let down = 0;
  let claims = 0;
  let grounded = 0;
  let asOfMs: number | null = null;

  for (const obs of observations) {
    turns += typeof obs.turnCount === "number" ? obs.turnCount : 0;
    if (typeof obs.ts === "number" && (asOfMs === null || obs.ts > asOfMs)) asOfMs = obs.ts;
    for (const m of obs.models ?? []) {
      const key = String(m.wire ?? "unknown");
      const fold = models.get(key) ?? {
        wire: key,
        spec: typeof m.spec === "string" ? m.spec : null,
        provider: String(m.provider ?? "unknown"),
        turns: 0,
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreate: 0,
        costUsdMicros: 0,
        unpriced: false,
      };
      fold.turns += m.turns ?? 0;
      fold.tokensIn += m.usage?.in ?? 0;
      fold.tokensOut += m.usage?.out ?? 0;
      fold.cacheRead += m.usage?.cacheRead ?? 0;
      fold.cacheCreate += m.usage?.cacheCreate ?? 0;
      fold.costUsdMicros += m.costUsdMicros ?? 0;
      // An unpriced model's spend is UNKNOWN, not zero — the flag survives
      // the fold so the panel can say so instead of charting a false $0.
      if (m.unpriced === true || m.costUsdMicros === undefined) fold.unpriced = true;
      models.set(key, fold);
    }
    for (const t of obs.toolStats ?? []) {
      const key = String(t.name ?? "unknown");
      const fold = tools.get(key) ?? { name: key, calls: 0, errors: 0 };
      fold.calls += t.calls ?? 0;
      fold.errors += t.errors ?? 0;
      tools.set(key, fold);
    }
    for (const [name, score] of Object.entries(obs.continuity ?? {})) {
      const fold = continuity.get(name) ?? { name, total: 0, passed: 0, n: 0 };
      fold.total += typeof score.score === "number" ? score.score : 0;
      fold.passed += score.passed === true ? 1 : 0;
      fold.n += 1;
      continuity.set(name, fold);
    }
    if (obs.factuality !== undefined) {
      claims += obs.factuality.claims ?? 0;
      grounded += obs.factuality.grounded ?? 0;
    }
    if (obs.quality !== undefined) {
      ratings += obs.quality.ratings ?? 0;
      if (typeof obs.quality.meanRating === "number") {
        ratingSum += obs.quality.meanRating * (obs.quality.ratings ?? 0);
      }
      judged += obs.quality.judged ?? 0;
      if (typeof obs.quality.meanJudge === "number") {
        judgeSum += obs.quality.meanJudge * (obs.quality.judged ?? 0);
      }
    }
    up += obs.feedback?.up ?? 0;
    down += obs.feedback?.down ?? 0;
  }

  // Aggregates carry the sessions that have already been compacted away.
  let aggSessions = 0;
  let aggCostUsdMicros = 0;
  for (const agg of aggregates) {
    aggSessions += agg.n ?? 0;
    aggCostUsdMicros += agg.costUsdMicros ?? 0;
    turns += (agg.meanTurns ?? 0) * (agg.n ?? 0);
    up += agg.feedbackUp ?? 0;
    down += agg.feedbackDown ?? 0;
  }

  const modelRows = [...models.values()].sort((a, b) => b.turns - a.turns);
  const priced = modelRows.filter((m) => !m.unpriced);
  const unpriced = modelRows.filter((m) => m.unpriced);
  const sessions = observations.length + aggSessions;
  const judgeScores = judgments
    .map((j) => (typeof j.score === "number" ? j.score : null))
    .filter((s): s is number => s !== null);

  return {
    ...readBase(
      sessions > 0 || state !== null,
      sessions === 0
        ? state === null
          ? "watchme has never run in this harness"
          : "watching, but no session has been analyzed yet — a report is what writes the first digest"
        : truncated
          ? "long observation store — the head of the file only; every figure is a floor"
          : null,
      START_VERB,
    ),
    watching: state?.["watching"] === true,
    state: maskDeep(state),
    sessions,
    observations: observations.length,
    compactedSessions: aggSessions,
    turns: { total: turns, mean: sessions === 0 ? null : turns / sessions },
    models: priced,
    costUsdMicros: priced.reduce((sum, m) => sum + m.costUsdMicros, 0) + aggCostUsdMicros,
    // Its own bucket, deliberately: an unpriced model's cost is UNKNOWN.
    unpriced: {
      models: unpriced,
      turns: unpriced.reduce((sum, m) => sum + m.turns, 0),
      note:
        unpriced.length === 0
          ? null
          : "these models have no pricing entry — their spend is UNKNOWN and is deliberately not summed into the total",
    },
    tools: [...tools.values()]
      .map((t) => ({ ...t, errorRate: t.calls === 0 ? null : t.errors / t.calls }))
      .sort((a, b) => b.calls - a.calls),
    continuity: [...continuity.values()].map((c) => ({
      name: c.name,
      mean: c.n === 0 ? null : c.total / c.n,
      passRate: c.n === 0 ? null : c.passed / c.n,
      n: c.n,
    })),
    factuality: {
      claims,
      grounded,
      groundedRate: claims === 0 ? null : grounded / claims,
    },
    // watchme's OWN tally of the feedback it observed — not the human
    // feedback store, which has its own surface.
    observedFeedback: { up, down, source: "watchme observations" },
    quality: {
      ratings,
      meanRating: ratings === 0 ? null : ratingSum / ratings,
      judged,
      meanJudge: judged === 0 ? null : judgeSum / judged,
    },
    // The judge's verdicts, kept in their own block — never summed with the
    // human channel above.
    judgments: {
      count: judgments.length,
      meanScore:
        judgeScores.length === 0
          ? null
          : judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length,
      judgeModels: [...new Set(judgments.map((j) => String(j.judgeModel ?? "unknown")))],
      truncated: judgmentsTruncated,
      source: "watchme/judgments.jsonl (machine signal, not human feedback)",
    },
    aggregates: aggregates.map((a) => ({
      // `bucket`, not `key`: a field named `key` is redacted by the
      // dispatcher's credential-key masker on the way out.
      bucket: String(a.key ?? ""),
      n: a.n ?? 0,
      meanTurns: a.meanTurns ?? 0,
      sdTurns: a.n > 1 ? Math.sqrt((a.m2Turns ?? 0) / (a.n - 1)) : 0,
      meanQuality: a.meanQuality ?? 0,
      qualityN: a.qualityN ?? 0,
      costUsdMicros: a.costUsdMicros ?? 0,
      toolCalls: a.toolCalls ?? 0,
      toolErrors: a.toolErrors ?? 0,
    })),
    asOf: asOfMs === null ? null : new Date(asOfMs).toISOString(),
    truncated,
    torn,
  };
};

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

/** The first prose line of a report body — its summary. */
export function reportSummaryOf(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return trimmed.slice(0, 240);
  }
  return null;
}

/** …read from a contained path (already masked by `readProse`). */
function reportSummary(path: string | undefined): string | null {
  const doc = readProse(path);
  return doc === null ? null : reportSummaryOf(doc.text);
}

/**
 * `GET /api/h/:id/memory/watchme/reports` — the reports index.
 *
 * `watchme/reports/<ts>/` directories, newest first, with each report's
 * summary line. Directory names are validated as safe segments before use
 * and every file inside is contained per file.
 */
export const watchmeReports: M3Handler = (ctx) => {
  const dir = containedPath(ctx, [".crewhaus", "watchme", "reports"]);
  const stamps = listSubdirs(dir);
  const reports = stamps
    .map((stamp) => {
      const mdPath = containedPath(ctx, [".crewhaus", "watchme", "reports", stamp, "report.md"]);
      const jsonPath = containedPath(ctx, [
        ".crewhaus",
        "watchme",
        "reports",
        stamp,
        "report.json",
      ]);
      let at: string | null = null;
      try {
        const target = mdPath ?? jsonPath;
        at = target === undefined ? null : statSync(target).mtime.toISOString();
      } catch {
        at = null;
      }
      return {
        stamp,
        at,
        summary: reportSummary(mdPath),
        files: listDirSafe(containedPath(ctx, [".crewhaus", "watchme", "reports", stamp])).filter(
          (n) => SAFE_SEGMENT_RE.test(n),
        ),
      };
    })
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  return {
    ...readBase(
      reports.length > 0,
      reports.length === 0 ? "no watchme report has been written yet" : null,
      REPORT_VERB,
    ),
    reports,
  };
};

/**
 * `GET /api/h/:id/memory/watchme/reports/:stamp` — one rendered report, read
 * through the per-file containment check and masked as prose.
 */
export const watchmeReport: M3Handler = (ctx) => {
  const stamp = ctx.params["stamp"] ?? "";
  const dir = containedPath(ctx, [".crewhaus", "watchme", "reports", stamp]);
  if (dir === undefined || !existsSync(dir)) {
    return {
      ...readBase(false, "no watchme report with that stamp", REPORT_VERB),
      stamp,
      body: "",
      summary: null,
      report: null,
      files: [],
      truncated: false,
      maxBytes: MAX_TEXT_BYTES,
    };
  }
  const md = readProse(containedPath(ctx, [".crewhaus", "watchme", "reports", stamp, "report.md"]));
  const json = readJsonSafe(
    containedPath(ctx, [".crewhaus", "watchme", "reports", stamp, "report.json"]),
  );
  return {
    ...readBase(md !== null || json !== undefined, null, REPORT_VERB),
    stamp,
    // A report quotes the sessions it analyzed — prose, so it is masked as
    // prose on top of the dispatcher's key-based pass.
    body: md?.text ?? "",
    truncated: md?.truncated ?? false,
    summary: md === null ? null : reportSummaryOf(md.text),
    report: maskDeep(json ?? null),
    files: listDirSafe(dir).filter((n) => SAFE_SEGMENT_RE.test(n)),
    maxBytes: MAX_TEXT_BYTES,
  };
};

/**
 * `GET /api/h/:id/memory/watchme/intents` — the intent-cluster ranking.
 *
 * The `crewhaus watchme intents` view for this harness: clusters, counts,
 * and representative sessions returned as ids the console deep-links into
 * the session viewer. Cluster keys are redacted upstream (the store never
 * holds raw request text), and are masked again on the way out.
 */
export const watchmeIntents: M3Handler = (ctx) => {
  const { observations, aggregates, truncated } = readWatchme(ctx);
  // NOTE the field name: a payload key called `key` is redacted wholesale by
  // the dispatcher's credential-key masker, which would blank every cluster
  // label. `cluster` is the same datum under a name that is not a credential.
  const clusters = new Map<
    string,
    { cluster: string; count: number; sessions: string[]; lastSeen: number | null }
  >();
  for (const obs of observations) {
    for (const key of obs.intentKeys ?? []) {
      const fold = clusters.get(key) ?? { cluster: key, count: 0, sessions: [], lastSeen: null };
      fold.count += 1;
      if (fold.sessions.length < 10 && typeof obs.sessionId === "string") {
        fold.sessions.push(obs.sessionId);
      }
      const ts = typeof obs.ts === "number" ? obs.ts : null;
      if (ts !== null && (fold.lastSeen === null || ts > fold.lastSeen)) fold.lastSeen = ts;
      clusters.set(key, fold);
    }
  }
  // Compacted sessions survive only as aggregate intent counters.
  for (const agg of aggregates) {
    for (const [key, count] of Object.entries(agg.intents ?? {})) {
      const fold = clusters.get(key) ?? { cluster: key, count: 0, sessions: [], lastSeen: null };
      fold.count += typeof count === "number" ? count : 0;
      clusters.set(key, fold);
    }
  }
  const intents = [...clusters.values()]
    .map((c) => ({
      cluster: maskText(c.cluster),
      count: c.count,
      sessions: c.sessions,
      lastSeen: c.lastSeen === null ? null : new Date(c.lastSeen).toISOString(),
    }))
    .sort((a, b) => b.count - a.count || a.cluster.localeCompare(b.cluster));
  return {
    ...readBase(
      intents.length > 0,
      intents.length === 0
        ? "no intent clusters yet — a report is what mines recurring requests"
        : null,
      "crewhaus watchme intents",
    ),
    intents,
    truncated,
  };
};

// ---------------------------------------------------------------------------
// the spec write path (the toggle + the synthesize apply share it)
// ---------------------------------------------------------------------------

/** Segments of a `diffSpecYaml` path (`agent.model_pool.candidates[0].id`). */
export function diffPathSegments(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const part of path.split(".")) {
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (m === null) {
      out.push(part);
      continue;
    }
    if ((m[1] ?? "") !== "") out.push(m[1] as string);
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

/** True when a path is inside this target's `OPTIMIZABLE_PATHS` whitelist. */
export function isAutoTunable(target: string, segments: ReadonlyArray<string | number>): boolean {
  const paths = (OPTIMIZABLE_PATHS as Record<string, ReadonlyArray<ReadonlyArray<string>>>)[target];
  if (paths === undefined) return false;
  return paths.some((allowed) => allowed.every((seg, i) => String(segments[i] ?? "") === seg));
}

/**
 * The live spec's EXACT bytes, through the containment closure. Unmasked on
 * purpose: masking is an OUTPUT concern, and an edit has to round-trip the
 * file it rewrites. A spec past the read cap is refused rather than
 * truncated — writing back a half-read spec would delete the rest of it.
 */
function liveSpec(ctx: M3Context): { path: string; text: string } {
  const path = ctx.contain(["crewhaus.yaml"]);
  if (!existsSync(path)) throw new HttpError(409, "this harness has no crewhaus.yaml to edit");
  const { text, truncated } = readTextCapped(path, MAX_TEXT_BYTES);
  if (truncated) {
    throw new HttpError(409, "crewhaus.yaml is past the read cap — edit it with the CLI");
  }
  return { path, text };
}

/** Write the spec back atomically: temp file in the SAME dir, then rename. */
function writeSpec(path: string, text: string): void {
  const tmp = `${path}.hangar-watchme-tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

type EditOutcome = {
  ok: boolean;
  applied: boolean;
  code?: string;
  diff: ReturnType<typeof diffSpecYaml>;
  note: string;
};

/**
 * Apply spec edits, or PROPOSE them.
 *
 * Human-owned paths (everything outside `OPTIMIZABLE_PATHS` — and every
 * `watchme.*` path is deliberately outside it) need the typed confirmation.
 * Without one this returns the credential-redacted diff and writes nothing:
 * a proposal, which is the fallback the write covenant names. Rendering a
 * proposal is never applying it.
 */
function applyOrPropose(
  ctx: M3Context,
  edits: readonly SpecEdit[],
  opts: { confirmed: boolean; restrict: boolean },
): EditOutcome {
  let spec: { path: string; text: string };
  try {
    spec = liveSpec(ctx);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    return {
      ok: false,
      applied: false,
      code: "spec_unreadable",
      diff: [],
      note: describeFailure(err),
    };
  }
  let next: string;
  try {
    next = applySpecEdits(
      spec.text,
      edits,
      opts.restrict ? { restrictToOptimizable: true } : {},
    ).yaml;
  } catch (err) {
    return {
      ok: false,
      applied: false,
      code: "spec_edit_refused",
      diff: [],
      note: describeFailure(err),
    };
  }
  // `diffSpecYaml` redacts credential-carrying values itself — this is the
  // interstitial's data source, and it must never quote a secret.
  const diff = diffSpecYaml(spec.text, next);
  if (!opts.confirmed) {
    return {
      ok: true,
      applied: false,
      code: "needs_typed_confirm",
      diff,
      note: "this path is human-owned — nothing was written; re-send with confirmName set to the spec name, or route it through crewhaus propose",
    };
  }
  if (diff.length === 0) {
    return {
      ok: true,
      applied: false,
      code: "no_change",
      diff,
      note: "the spec already says this",
    };
  }
  writeSpec(spec.path, next);
  return { ok: true, applied: true, diff, note: "spec written; recompile to make the change live" };
}

/**
 * `POST /api/h/:id/memory/watchme/toggle` — watch on/off.
 *
 * Body: `{ watching, confirm, confirmName? }`. `watchme:` is a HUMAN-OWNED
 * spec path, so this is a confirm-gated spec edit through `applySpecEdits`,
 * not a write to `watchme/state.json`. Without the typed `confirmName` the
 * route answers with the diff it WOULD write and changes nothing.
 */
export const watchmeToggle: M3Handler = (ctx) => {
  const watching = requireBoolean(ctx.body, "watching");
  if (requireBoolean(ctx.body, "confirm") !== true) {
    throw new HttpError(409, 'toggling watchme needs "confirm": true');
  }
  const specName = harnessSpecName(ctx);
  const confirmed = ctx.body["confirmName"] === specName;
  const outcome = applyOrPropose(
    ctx,
    [
      {
        path: ["watchme", "enabled"],
        value: watching,
        rationale: `hangar: operator turned watchme ${watching ? "on" : "off"}`,
      },
    ],
    // watchme.* is human-owned by design (the observer must not be tuned by
    // the loop it observes), so the restricted surface would refuse it.
    { confirmed, restrict: false },
  );
  return {
    ...outcome,
    watching,
    specName,
    confirmName: specName,
    stateFile:
      ".crewhaus/watchme/state.json (owned by `crewhaus watchme start/stop` — not written here)",
  };
};

// ---------------------------------------------------------------------------
// synthesize — advisory proposals, applied edit by edit
// ---------------------------------------------------------------------------

type Proposal = {
  stamp: string;
  path: string;
  yaml: string;
};

function readProposal(ctx: M3Context, stamp: string): Proposal | null {
  if (!SAFE_SEGMENT_RE.test(stamp)) return null;
  for (const name of [`${stamp}.yaml`, `${stamp}.yml`]) {
    const path = containedPath(ctx, [".crewhaus", "watchme", "synthesized", name]);
    if (path === undefined || !existsSync(path)) continue;
    const doc = readProse(path);
    if (doc === null) continue;
    return { stamp, path: join(".crewhaus", "watchme", "synthesized", name), yaml: doc.text };
  }
  return null;
}

/** The proposal's edits vs the live spec, each classified by trust tier. */
function proposalEdits(
  ctx: M3Context,
  proposalYaml: string,
): { edits: Array<Record<string, unknown>>; error: string | null } {
  let liveText = "";
  try {
    liveText = liveSpec(ctx).text;
  } catch {
    return { edits: [], error: "this harness has no readable crewhaus.yaml to compare against" };
  }
  const target = specTarget(ctx);
  let diff: ReturnType<typeof diffSpecYaml>;
  try {
    diff = diffSpecYaml(liveText, proposalYaml);
  } catch (err) {
    return { edits: [], error: describeFailure(err) };
  }
  return {
    edits: diff.map((entry) => {
      const segments = diffPathSegments(entry.path);
      const auto = isAutoTunable(target, segments);
      return {
        path: entry.path,
        kind: entry.kind,
        // `diffSpecYaml` already redacts credential-carrying values.
        before: entry.before ?? null,
        after: entry.after ?? null,
        tier: auto ? "auto-tunable" : "human-owned",
        // The learned fact behind the edit, as the synthesizer states it.
        rationale: auto
          ? "inside OPTIMIZABLE_PATHS — the optimizer may write this path, so applying it needs only a confirm"
          : "human-owned path — applying it needs the typed confirmation (or crewhaus propose)",
      };
    }),
    error: null,
  };
}

/**
 * `GET /api/h/:id/memory/watchme/synthesized` — proposed mimic specs.
 *
 * `watchme/synthesized/<name>.yaml` entries — whole candidate specs the
 * synthesizer wrote as NEW files (it never touches a live spec). Each is
 * rendered as the per-edit diff against this harness's spec, with every edit
 * already classified auto-tunable vs human-owned, so the review UI shows
 * what applying would actually cost.
 */
export const watchmeSynthesized: M3Handler = (ctx) => {
  const dir = containedPath(ctx, [".crewhaus", "watchme", "synthesized"]);
  const names = listDirSafe(dir).filter((n) => n.endsWith(".yaml") || n.endsWith(".yml"));
  const proposals: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const stamp = name.replace(/\.ya?ml$/, "");
    const proposal = readProposal(ctx, stamp);
    if (proposal === null) continue;
    const { edits, error } = proposalEdits(ctx, proposal.yaml);
    proposals.push({
      stamp,
      path: proposal.path,
      edits,
      error,
      autoTunable: edits.filter((e) => e["tier"] === "auto-tunable").length,
      humanOwned: edits.filter((e) => e["tier"] === "human-owned").length,
      // The proposal is a whole spec; showing it is not applying it.
      yaml: proposal.yaml,
    });
  }
  return {
    ...readBase(
      proposals.length > 0,
      proposals.length === 0 ? "no synthesized proposal has been written yet" : null,
      "crewhaus watchme synthesize",
    ),
    proposals,
    advisory: true,
    note: "advisory only — reading a proposal is not applying it; apply picks edits one by one and goes back through the spec write path",
  };
};

/**
 * `POST /api/h/:id/memory/watchme/synthesized/:stamp/apply` — apply a
 * proposal, edit by edit.
 *
 * Body: `{ edits: string[], confirm, confirmName? }` — the operator picks
 * WHICH edit paths. They are applied through the spec write path with the
 * same restriction and the same propose fallback a hand edit gets: a
 * proposal never earns a privileged channel.
 */
export const watchmeApply: M3Handler = (ctx) => {
  const stamp = ctx.params["stamp"] ?? "";
  if (requireBoolean(ctx.body, "confirm") !== true) {
    throw new HttpError(409, 'applying synthesized edits needs "confirm": true');
  }
  const raw = ctx.body["edits"];
  const wanted = Array.isArray(raw) ? raw.filter((e): e is string => typeof e === "string") : [];
  if (Array.isArray(raw) && raw.length !== wanted.length) {
    throw new HttpError(400, '"edits" must be an array of edit paths');
  }
  const proposal = readProposal(ctx, stamp);
  if (proposal === null) {
    return {
      ok: false,
      code: "no_such_proposal",
      stamp,
      applied: false,
      edits: [],
      skipped: wanted,
      note: "no synthesized proposal with that name",
    };
  }
  if (wanted.length === 0) {
    return {
      ok: true,
      applied: false,
      code: "no_edits_selected",
      stamp,
      edits: [],
      diff: [],
      note: "nothing was selected, so nothing was applied — a proposal is advisory until an edit is picked",
    };
  }

  // The proposal's VALUES come from its own parsed spec: a diff line is a
  // truncated rendering, never a value to write back.
  let proposed: Record<string, unknown>;
  try {
    proposed = parseSpec(proposal.yaml) as unknown as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      code: "proposal_unreadable",
      stamp,
      applied: false,
      edits: [],
      skipped: wanted,
      note: `the proposal does not validate against this manager's schema — apply it with the CLI instead (${describeFailure(err)})`,
    };
  }

  const specName = harnessSpecName(ctx);
  const target = specTarget(ctx);
  const edits: SpecEdit[] = [];
  const skipped: Array<{ path: string; why: string }> = [];
  let allAutoTunable = true;
  for (const path of wanted) {
    const segments = diffPathSegments(path);
    const value = valueAt(proposed, segments);
    if (value === undefined) {
      skipped.push({ path, why: "the proposal carries no value at that path" });
      continue;
    }
    if (!isAutoTunable(target, segments)) allAutoTunable = false;
    edits.push({
      path: segments,
      value,
      rationale: `hangar: applied from watchme proposal ${stamp}`,
    });
  }
  if (edits.length === 0) {
    return {
      ok: false,
      applied: false,
      code: "nothing_applicable",
      stamp,
      edits: [],
      skipped,
      note: "none of the selected paths carry a value in the proposal",
    };
  }
  // The same two tiers a hand edit gets: an auto-tunable batch needs only the
  // confirm already checked above and runs under the OPTIMIZER's own
  // restriction; anything human-owned needs the typed confirmation, or it
  // comes back as a proposal.
  const outcome = applyOrPropose(ctx, edits, {
    confirmed: allAutoTunable || ctx.body["confirmName"] === specName,
    restrict: allAutoTunable,
  });
  return {
    ...outcome,
    stamp,
    tier: allAutoTunable ? "auto-tunable" : "human-owned",
    edits: edits.map((e) => e.path.map(String).join(".")),
    skipped,
    confirmName: specName,
  };
};

/** The live spec's `target:`, read leniently (a spec that fails validation
 *  still has one, and the trust table is keyed on it). */
function specTarget(ctx: M3Context): string {
  const m = readSpecYaml(harnessDirOf(ctx)).match(/^target:\s*(\S+)/m);
  return m === null ? "" : (m[1] as string);
}

/** Read a value out of a parsed spec by path segments. */
function valueAt(root: unknown, segments: ReadonlyArray<string | number>): unknown {
  let current: unknown = root;
  for (const seg of segments) {
    if (typeof seg === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[seg];
      continue;
    }
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * `POST /api/h/:id/memory/watchme/publish` — publish findings to the wiki.
 *
 * Body: `{ dryRun }`, defaulting to a dry run. The preview names the three
 * co-learning articles the verb upserts and whether each would be created or
 * updated (with the version a write would carry) — publishing writes into
 * the memory fabric, so a preview is the difference between a review and a
 * surprise.
 *
 * The real run goes through the CLI verb on the job queue. The article
 * BODIES are distilled and redacted by that verb; re-deriving them here
 * would fork the redaction that makes sharing safe, so the manager gates and
 * previews the publish rather than composing it.
 */
export const watchmePublish: M3Handler = (ctx) => {
  const dryRun = isDryRun(ctx.body);
  const specName = harnessSpecName(ctx);
  if (!dryRun) requireTypedConfirm(ctx.body, specName);
  const shareBlock = specBlock(readSpecYaml(harnessDirOf(ctx)), ["watchme"]);
  const share = shareBlock !== undefined && specScalar(shareBlock, "share") === "true";

  const targets = PUBLISH_SLUGS.map((slug) => {
    const scoped = containedPath(ctx, [".crewhaus", "wiki", specName, "articles", `${slug}.md`]);
    const flat = containedPath(ctx, [".crewhaus", "wiki", "articles", `${slug}.md`]);
    const path = scoped !== undefined && existsSync(scoped) ? scoped : flat;
    const exists = path !== undefined && existsSync(path);
    return { slug, action: exists ? "update" : "create" };
  });

  const argv = dryRun ? ["watchme", "publish", "--dry-run"] : ["watchme", "publish"];
  const job = ctx.submitJob(`watchme publish${dryRun ? " (dry run)" : ""}`, argv);
  return {
    ok: true,
    dryRun,
    job: maskDeep(job),
    targets,
    share,
    note: dryRun
      ? "dry run queued — it prints the articles it would upsert and writes nothing"
      : "publish queued — each article is a versioned upsert carrying expectedVersion, like every other wiki write",
  };
};
