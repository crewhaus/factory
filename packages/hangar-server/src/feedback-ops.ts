/**
 * M3 · FEEDBACK — the growth loops: the ratings browser + distill watermark,
 * the few-shot pool, FAQ distill, lessons, advise, channel reactions, and
 * the cross-harness rollup.
 *
 * The review QUEUE and its adjudication (M2, `review.ts`) stay where they
 * are — this module is the other half: what the ratings turn INTO.
 *
 * The loop, and where each verb sits in it:
 *
 *   ratings (`.crewhaus/feedback/*.jsonl` + in-transcript `user_feedback`)
 *     → `distill`  → an eval dataset + graders (`--register` promotes them)
 *     → `fewshot harvest` → the golden few-shot pool
 *     → `faq distill`     → the auto-discovered FAQ skill
 *     → `lessons update`  → LESSONS.md + `.crewhaus/preferences/`
 *     → `advise`          → SpecPatches in `.crewhaus/advice/`
 *
 * Rules:
 *   - WRITES GO THROUGH THE FeedbackRecord WRITERS, the same path
 *     `crewhaus rate` uses. Nothing here appends to `feedback.jsonl` by hand.
 *   - THE WATERMARK IS THE TRUTH about what distill has consumed:
 *     `.crewhaus/feedback/.distill-state.json` plus the unprocessed count.
 *     Both are shown; "N new ratings" with no watermark is a guess.
 *   - ADVICE IS ADVISORY. `.crewhaus/advice/` holds proposals. Applying one
 *     goes through the spec write path, and any non-optimizable path is
 *     refused with the diff and routed to `crewhaus propose` — the advice
 *     feed gets no privileged channel into the spec.
 *   - CHANNEL REACTIONS HAVE A PRECONDITION. Reaction feedback only works
 *     when the channel's `sessionKey` is `channel` or `user`; a `thread`
 *     sessionKey silently collects nothing, and a panel that did not say so
 *     would lie by omission.
 *   - `autoDistill` is CLI-only in the shipped runtime. "Distill now" here
 *     RUNS THE VERB; it does not toggle a runtime behaviour.
 *
 * READS NEVER MUTATE: the ratings browser folds raw JSONL under the shared
 * caps and never calls a store `list()` that would evict or compact.
 */
import { readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FeedbackRecord,
  countUnprocessed,
  extractFeedbackRecords,
  mergeFeedback,
  normalizeRating,
  ratingsDatasetName,
  readDistillState,
} from "@crewhaus/feedback-distill";
import {
  OPTIMIZABLE_PATHS,
  applySpecEdits,
  diffSpecYaml,
  isOptimizable,
} from "@crewhaus/spec-patch";
import { MAX_JSONL_LINES, SESSION_JSONL_RE } from "./constants";
import {
  absent,
  asObject,
  found,
  isDirAt,
  isFileAt,
  listNames,
  mtimeIso,
  num,
  readJson,
  readProse,
  safeContain,
  str,
} from "./evals-ops";
import { HttpError } from "./http";
import { readJsonlCapped } from "./jsonl";
import type { M3Context, M3Handler, M3Harness } from "./m3";
import { jobArg } from "./m3";
import { maskDeep, maskSpecYaml, maskText } from "./mask";
import { resolveContained } from "./safety";
import { readSpecYaml } from "./schedulers";

const FEEDBACK_SEGMENTS: readonly string[] = [".crewhaus", "feedback"];
const WATERMARK_SEGMENTS: readonly string[] = [...FEEDBACK_SEGMENTS, ".distill-state.json"];

// ---------------------------------------------------------------------------
// Reading the rating corpus without mutating anything
// ---------------------------------------------------------------------------

type Corpus = {
  readonly records: readonly FeedbackRecord[];
  /** Sink files read, for the "where did this come from" line. */
  readonly sinks: readonly string[];
  readonly sessionsScanned: number;
  readonly truncated: boolean;
};

/**
 * Fold this harness's ratings from BOTH sinks, capped and torn-tolerant:
 *
 *   - `.crewhaus/feedback/*.jsonl` — the bare-record sink the web UI and the
 *     managed gateway write (no event-log handle there);
 *   - `<sessionRoot>/sess_*.jsonl` — in-transcript `user_feedback` events
 *     (the exit-rating prompt, `crewhaus rate`, channel reactions).
 *
 * Read RAW: no session-store `list()`, whose TTL eviction would DELETE the
 * transcripts this browser exists to show.
 */
function readCorpus(ctx: M3Context, sessionCap = 200): Corpus {
  const records: FeedbackRecord[] = [];
  const sinks: string[] = [];
  let truncated = false;

  for (const name of listNames(safeContain(ctx, FEEDBACK_SEGMENTS))) {
    if (!name.endsWith(".jsonl")) continue;
    // Per FILE: the directory listing yields names, and a name can be a
    // symlink pointing out of the harness tree.
    const path = safeContain(ctx, [...FEEDBACK_SEGMENTS, name]);
    if (path === undefined || !isFileAt(path)) continue;
    const read = readJsonlCapped(path, MAX_JSONL_LINES);
    truncated = truncated || read.truncated;
    records.push(...extractFeedbackRecords(read.objects));
    sinks.push(`${FEEDBACK_SEGMENTS.join("/")}/${name}`);
  }

  let sessionsScanned = 0;
  const sessionsDir = safeContain(ctx, [".crewhaus", "sessions"]);
  if (sessionsDir !== undefined) {
    let names: string[] = [];
    try {
      names = readdirSync(sessionsDir).filter((n) => SESSION_JSONL_RE.test(n));
    } catch {
      names = [];
    }
    // Newest transcripts first, capped: a rating browser must not become an
    // unbounded walk of every transcript a long-lived harness ever wrote.
    const ranked = names
      .map((name) => {
        const path = safeContain(ctx, [".crewhaus", "sessions", name]);
        let mtimeMs = 0;
        try {
          mtimeMs = path === undefined ? 0 : statSync(path).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { name, path, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, sessionCap);
    if (names.length > sessionCap) truncated = true;
    for (const entry of ranked) {
      if (entry.path === undefined) continue;
      const read = readJsonlCapped(entry.path, MAX_JSONL_LINES);
      truncated = truncated || read.truncated;
      sessionsScanned += 1;
      records.push(...extractFeedbackRecords(read.objects));
    }
  }
  return { records: mergeFeedback(records), sinks, sessionsScanned, truncated };
}

type Watermark = {
  readonly present: boolean;
  readonly lastProcessedTs: string | null;
  readonly processedCount: number | null;
  readonly lastRegistered: unknown;
  readonly unprocessed: number;
};

/**
 * The distill watermark beside the unprocessed count. Reporting one without
 * the other is a guess: "12 new ratings" means nothing unless you also know
 * the timestamp it is counting from, and a MISSING watermark means every
 * rating is unprocessed (which is a very different screen).
 */
function watermarkFor(ctx: M3Context, records: readonly FeedbackRecord[]): Watermark {
  const path = safeContain(ctx, WATERMARK_SEGMENTS);
  const state = path === undefined ? undefined : readDistillState(path);
  return {
    present: state !== undefined,
    lastProcessedTs: state?.lastProcessedTs ?? null,
    processedCount: state?.processedCount ?? null,
    lastRegistered: state?.lastRegistered ?? null,
    unprocessed: countUnprocessed(records, state?.lastProcessedTs),
  };
}

const specNameOf = (ctx: M3Context): string => ctx.entry?.specName ?? "spec";

// ---------------------------------------------------------------------------
// The ratings browser
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/feedback` — the ratings browser. */
export const feedback: M3Handler = (ctx) => {
  const corpus = readCorpus(ctx);
  const watermark = watermarkFor(ctx, corpus.records);
  const items = corpus.records
    .slice()
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    .map((r) => ({
      id: r.id,
      // Turn ordinals are kept so a rating deep-links to the exact turn in
      // the session viewer — a rating you cannot navigate back to is a number.
      sessionId: r.sessionId,
      turnNumber: r.turnNumber,
      runId: r.runId ?? null,
      modality: r.modality,
      score: normalizeRating(r) ?? null,
      thumbs: r.rating.thumbs ?? null,
      stars: r.rating.stars ?? null,
      comment: maskText(r.comment ?? ""),
      correction: maskText(r.correction ?? ""),
      source: r.source,
      rater: r.rater ?? null,
      adjudication: r.adjudication === true,
      ts: r.ts,
      unprocessed: watermark.lastProcessedTs === null ? true : r.ts > watermark.lastProcessedTs,
    }));
  const up = items.filter((i) => i.thumbs === "up" || (i.score ?? 0) > 0.5).length;
  if (items.length === 0) {
    return {
      ...absent("no ratings recorded on this harness yet", "crewhaus rate"),
      items,
      watermark,
      balance: { up: 0, down: 0, total: 0 },
      sinks: corpus.sinks,
      sessionsScanned: corpus.sessionsScanned,
      truncated: corpus.truncated,
    };
  }
  return {
    ...found(
      corpus.truncated
        ? "the rating corpus was read up to the transcript/line caps — counts are a floor"
        : null,
      "crewhaus distill",
    ),
    items,
    watermark,
    balance: { up, down: items.length - up, total: items.length },
    sinks: corpus.sinks,
    sessionsScanned: corpus.sessionsScanned,
    truncated: corpus.truncated,
  };
};

/**
 * `POST /api/h/:id/feedback/distill` — "Distill now".
 *
 * This RUNS the verb. It does not toggle `autoDistill`, which is CLI-only in
 * the shipped runtime — a button that claimed to turn on a daemon behaviour
 * that no daemon reads would be the worst kind of console lie.
 *
 * `--register` is a SEPARATE act from producing the dataset: it promotes the
 * result into the registry, where it can gate a release.
 */
export const distillRun: M3Handler = (ctx) => {
  const argv = ["distill"];
  if (ctx.body["judge"] === true) argv.push("--judge");
  const register = ctx.body["register"] === true;
  if (register) argv.push("--register");
  return {
    ...found(
      register
        ? `runs the verb AND promotes the result into the registry as ${ratingsDatasetName(specNameOf(ctx))}`
        : "runs the verb — the result is a dataset + graders on disk; promoting them into the registry is the separate --register act",
      "crewhaus distill",
    ),
    job: ctx.submitJob("distill", argv),
    argv,
    registers: register,
    runtimeNote:
      "this runs `crewhaus distill`; it does not enable the spec's autoDistill, which the shipped runtime honours only through the CLI",
  };
};

// ---------------------------------------------------------------------------
// The few-shot pool
// ---------------------------------------------------------------------------

const FEWSHOT_SEGMENTS: readonly string[] = [".crewhaus", "fewshot"];

/** `GET /api/h/:id/feedback/fewshot` — the golden few-shot pool. */
export const fewshot: M3Handler = (ctx) => {
  const files = listNames(safeContain(ctx, FEWSHOT_SEGMENTS)).filter((n) => n.endsWith(".jsonl"));
  const entries: Array<Record<string, unknown>> = [];
  let truncated = false;
  const inUse = `${specNameOf(ctx)}.jsonl`;
  for (const file of files) {
    const path = safeContain(ctx, [...FEWSHOT_SEGMENTS, file]);
    if (path === undefined || !isFileAt(path)) continue;
    const read = readJsonlCapped(path, MAX_JSONL_LINES);
    truncated = truncated || read.truncated;
    for (const raw of read.objects) {
      const row = asObject(raw);
      if (row === undefined) continue;
      const metadata = asObject(row["metadata"]);
      entries.push({
        file,
        // The pool file is named for the spec that injects it — that is what
        // "in use" means here, and it is a fact on disk, not a guess.
        inUse: file === inUse,
        input: maskText(str(row["input"]) ?? ""),
        output: maskText(str(row["expected_output"]) ?? str(row["output"]) ?? ""),
        score: num(row["score"]) ?? num(metadata?.["user_rating"]) ?? null,
        source: str(metadata?.["source"]) ?? null,
        sessionId: str(metadata?.["session_id"]) ?? str(row["sessionId"]) ?? null,
      });
    }
  }
  if (entries.length === 0) {
    return {
      ...absent("no golden few-shot pool on this harness", "crewhaus fewshot harvest"),
      entries,
      files,
      poolForSpec: inUse,
      truncated,
    };
  }
  return {
    ...found(truncated ? "the pool was read up to the line cap" : null, "crewhaus fewshot show"),
    entries,
    files,
    poolForSpec: inUse,
    truncated,
  };
};

/**
 * `POST /api/h/:id/feedback/fewshot` — `fewshot harvest`.
 *
 * Harvesting adds examples the agent will IMITATE, so the default is a
 * preview: the plan, the pool it writes, and the redaction the verb applies.
 */
export const fewshotHarvest: M3Handler = (ctx) => {
  const argv = ["fewshot", "harvest"];
  if (ctx.body["allSessions"] === true) argv.push("--all-sessions");
  const minScore = ctx.body["minScore"];
  if (minScore !== undefined) {
    if (typeof minScore !== "number" || minScore < 0 || minScore > 1) {
      throw new HttpError(400, '"minScore" must be a number in [0, 1]');
    }
    argv.push("--min-score", String(minScore));
  }
  const pool = `${FEWSHOT_SEGMENTS.join("/")}/${specNameOf(ctx)}.jsonl`;
  if (ctx.body["confirm"] !== true) {
    return {
      ...found(
        "preview — harvesting adds examples the agent will imitate; confirm to run it",
        "crewhaus fewshot harvest",
      ),
      preview: true,
      argv,
      writes: [pool],
      confirmWith: 'send "confirm": true to run it',
      currentPoolSize: poolSize(ctx),
    };
  }
  return {
    ...found(`queued — harvested examples land in ${pool}`, "crewhaus fewshot harvest"),
    preview: false,
    argv,
    writes: [pool],
    job: ctx.submitJob("fewshot harvest", argv),
  };
};

function poolSize(ctx: M3Context): number {
  const path = safeContain(ctx, [...FEWSHOT_SEGMENTS, `${specNameOf(ctx)}.jsonl`]);
  if (path === undefined || !isFileAt(path)) return 0;
  return readJsonlCapped(path, MAX_JSONL_LINES).objects.length;
}

// ---------------------------------------------------------------------------
// The auto-discovered FAQ skill
// ---------------------------------------------------------------------------

const FAQ_SEGMENTS: readonly string[] = [".crewhaus", "skills", "faq"];

/** `GET /api/h/:id/feedback/faq` — the generated FAQ skill, rendered, so it
 *  is inspectable rather than magic. */
export const faq: M3Handler = (ctx) => {
  const skill = readProse(ctx, [...FAQ_SEGMENTS, "SKILL.md"]);
  if (skill === undefined) {
    return {
      ...absent("no auto-discovered FAQ skill on this harness", "crewhaus faq distill"),
      skill: null,
      files: [],
      path: FAQ_SEGMENTS.join("/"),
    };
  }
  return {
    ...found(
      skill.truncated ? "the skill body was read up to the text cap" : null,
      "crewhaus faq distill",
    ),
    skill: skill.text,
    truncated: skill.truncated,
    files: listNames(safeContain(ctx, FAQ_SEGMENTS)),
    path: FAQ_SEGMENTS.join("/"),
    generatedAt: mtimeIso(safeContain(ctx, [...FAQ_SEGMENTS, "SKILL.md"])),
  };
};

/** `POST /api/h/:id/feedback/faq` — `faq distill`. The generated skill is a
 *  file the operator can read afterwards. */
export const faqDistill: M3Handler = (ctx) => {
  const argv = ["faq", "distill"];
  const sessions = ctx.body["sessions"];
  if (sessions !== undefined) argv.push("--sessions", jobArg("sessions", sessions));
  return {
    ...found(
      `queued — clusters recurring questions into ${FAQ_SEGMENTS.join("/")}/SKILL.md, which the skills registry auto-discovers`,
      "crewhaus faq distill",
    ),
    job: ctx.submitJob("faq distill", argv),
    argv,
    writes: [`${FAQ_SEGMENTS.join("/")}/SKILL.md`],
  };
};

// ---------------------------------------------------------------------------
// Lessons + preferences
// ---------------------------------------------------------------------------

/** `GET /api/h/:id/feedback/lessons` — `LESSONS.md` plus
 *  `.crewhaus/preferences/`, both rendered as prose and both MASKED: they are
 *  mined from real transcripts, which is exactly where a pasted credential
 *  ends up. */
export const lessons: M3Handler = (ctx) => {
  const lessonsDoc = readProse(ctx, ["LESSONS.md"]);
  const preferences = listNames(safeContain(ctx, [".crewhaus", "preferences"]))
    .filter((n) => n.endsWith(".md"))
    .map((file) => {
      const body = readProse(ctx, [".crewhaus", "preferences", file]);
      return {
        file,
        user: file.slice(0, -".md".length),
        body: body?.text ?? "",
        truncated: body?.truncated ?? false,
      };
    });
  if (lessonsDoc === undefined && preferences.length === 0) {
    return {
      ...absent(
        "no LESSONS.md and no per-user preferences on this harness",
        "crewhaus lessons update",
      ),
      lessons: null,
      preferences,
    };
  }
  return {
    ...found(
      "LESSONS.md is auto-loaded at run start; per-user preferences are injected when that user is known",
      "crewhaus lessons update",
    ),
    lessons: lessonsDoc?.text ?? null,
    lessonsTruncated: lessonsDoc?.truncated ?? false,
    lessonsUpdatedAt: mtimeIso(safeContain(ctx, ["LESSONS.md"])),
    preferences,
  };
};

/** `POST /api/h/:id/feedback/lessons` — `lessons update`. */
export const lessonsUpdate: M3Handler = (ctx) => {
  const argv = ["lessons", "update"];
  const sessions = ctx.body["sessions"];
  if (sessions !== undefined) argv.push("--sessions", jobArg("sessions", sessions));
  const before = readProse(ctx, ["LESSONS.md"]);
  if (ctx.body["confirm"] !== true) {
    return {
      ...found(
        "preview — LESSONS.md is auto-loaded into every run, so confirm before rewriting it",
        "crewhaus lessons update",
      ),
      preview: true,
      argv,
      writes: ["LESSONS.md", ".crewhaus/preferences/<user>.md"],
      currentLines: before === undefined ? 0 : before.text.split("\n").length,
      confirmWith: 'send "confirm": true to run it',
    };
  }
  return {
    ...found("queued — corrections and failures fold into LESSONS.md", "crewhaus lessons update"),
    preview: false,
    argv,
    writes: ["LESSONS.md", ".crewhaus/preferences/<user>.md"],
    job: ctx.submitJob("lessons update", argv),
  };
};

// ---------------------------------------------------------------------------
// The advisory feed
// ---------------------------------------------------------------------------

const ADVICE_SEGMENTS: readonly string[] = [".crewhaus", "advice"];

type AdviceProposal = {
  readonly adviceId: string;
  readonly severity: string | null;
  readonly summary: string;
  readonly path: readonly string[];
  readonly op: string;
  readonly target: string;
  readonly value: unknown;
  readonly rationale: string;
  /** Auto-tunable = inside OPTIMIZABLE_PATHS for this target. Everything else
   *  is human-owned and cannot be applied from this feed. */
  readonly tier: "auto-tunable" | "human-owned";
  readonly tierReason: string;
};

/** The same prefix rule `applySpecEdits({ restrictToOptimizable: true })`
 *  enforces on write, evaluated here so the feed can SHOW what applying
 *  would cost before the operator clicks. Enforced on the server either way —
 *  this is a label, not the gate. */
function tierFor(target: string, path: readonly string[]): AdviceProposal["tier"] {
  // spec-patch's own matcher (exact + wildcard + the structural rule), so the
  // label can never disagree with the gate.
  if (!(target in OPTIMIZABLE_PATHS)) return "human-owned";
  return isOptimizable(target as keyof typeof OPTIMIZABLE_PATHS, path)
    ? "auto-tunable"
    : "human-owned";
}

function readProposals(ctx: M3Context): AdviceProposal[] {
  const file = asObject(readJson(ctx, [...ADVICE_SEGMENTS, "suggestions.json"]));
  const raw = Array.isArray(file?.["suggestions"]) ? (file?.["suggestions"] as unknown[]) : [];
  const out: AdviceProposal[] = [];
  raw.forEach((entry, index) => {
    const row = asObject(entry);
    const patch = asObject(row?.["patch"]);
    if (row === undefined || patch === undefined) return;
    const path = (Array.isArray(patch["path"]) ? patch["path"] : []).map((p) => String(p));
    const target = str(patch["target"]) ?? "";
    const tier = tierFor(target, path);
    out.push({
      adviceId: str(row["findingId"]) ?? `adv_${index + 1}`,
      severity: str(row["severity"]) ?? null,
      summary: maskText(str(row["summary"]) ?? ""),
      path,
      op: str(patch["op"]) ?? "replace",
      target,
      value: maskDeep(patch["value"]),
      rationale: maskText(str(patch["rationale"]) ?? ""),
      tier,
      tierReason:
        tier === "auto-tunable"
          ? "inside OPTIMIZABLE_PATHS for this target — the console may write it directly"
          : "outside OPTIMIZABLE_PATHS — human-owned; applying routes to `crewhaus propose` instead of writing the spec",
    });
  });
  return out;
}

/** `GET /api/h/:id/feedback/advice` — the advisory feed. */
export const advice: M3Handler = (ctx) => {
  const proposals = readProposals(ctx);
  if (proposals.length === 0) {
    return {
      ...absent(
        isDirAt(safeContain(ctx, ADVICE_SEGMENTS))
          ? "an advice directory exists but holds no applicable SpecPatch proposals (advice-only findings are report-only)"
          : "no advice mined from this harness's sessions yet",
        "crewhaus advise",
      ),
      proposals,
      generatedAt: null,
      advisory: true,
    };
  }
  const file = asObject(readJson(ctx, [...ADVICE_SEGMENTS, "suggestions.json"]));
  return {
    ...found(
      "advisory only — rendering a proposal is not applying it; apply is a separate, explicit gesture that goes back through the spec write path",
      "crewhaus advise",
    ),
    proposals,
    generatedAt:
      str(file?.["generatedAt"]) ??
      mtimeIso(safeContain(ctx, [...ADVICE_SEGMENTS, "suggestions.json"])),
    sessionIds: Array.isArray(file?.["sessionIds"])
      ? (file?.["sessionIds"] as unknown[]).map((s) => String(s))
      : [],
    advisory: true,
  };
};

/** `POST /api/h/:id/feedback/advice` — run `crewhaus advise`. Produces
 *  PROPOSALS only; nothing it writes is applied by writing it. */
export const adviceRun: M3Handler = (ctx) => {
  const argv = ["advise"];
  const since = ctx.body["since"];
  if (since !== undefined) argv.push("--session", jobArg("since", since));
  else argv.push("--all");
  return {
    ...found(
      `queued — writes proposals to ${ADVICE_SEGMENTS.join("/")}/suggestions.json; applying one is a separate gesture`,
      "crewhaus advise",
    ),
    job: ctx.submitJob("advise", argv),
    argv,
    advisory: true,
  };
};

/**
 * `POST /api/h/:id/feedback/advice/:adviceId/apply` — apply one proposal.
 *
 * Goes through `applySpecEdits(..., { restrictToOptimizable: true })`, the
 * SAME restriction the optimizer runs under: the console can never write what
 * the machine may not. A non-optimizable path is refused with the
 * credential-redacted diff and `crewhaus propose` named in the refusal — not
 * silently dropped, and never quietly written.
 */
export const adviceApply: M3Handler = (ctx) => {
  const adviceId = ctx.params["adviceId"] as string;
  const proposal = readProposals(ctx).find((p) => p.adviceId === adviceId);
  if (proposal === undefined) {
    // A typed refusal, not a 404: nothing about the request was malformed,
    // and the feed renders "that proposal is gone" beside the id it lost.
    return {
      ...absent(
        `no advice proposal "${adviceId}" on this harness — re-run advise to refresh the feed`,
        "crewhaus advise",
      ),
      adviceId,
      applied: false,
    };
  }
  const specPath = ctx.contain(["crewhaus.yaml"]);
  const before = readSpecYaml(ctx.harnessDir ?? "");
  if (before === "") {
    return {
      ...absent("this harness has no readable crewhaus.yaml — nothing was written", null),
      adviceId,
      applied: false,
    };
  }

  const edit = {
    path: proposal.path,
    ...(proposal.op === "remove" ? {} : { value: proposal.value }),
    ...(proposal.rationale !== "" ? { rationale: proposal.rationale } : {}),
  };

  let applied: ReturnType<typeof applySpecEdits>;
  try {
    applied = applySpecEdits(before, [edit], { restrictToOptimizable: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The human-owned refusal is a FIRST-CLASS state: show what the edit
    // would have done, then name the route that CAN carry it.
    let diff: unknown = [];
    try {
      diff = diffSpecYaml(before, applySpecEdits(before, [edit]).yaml).map((d) => ({ ...d }));
    } catch {
      diff = [];
    }
    throw new HttpError(
      409,
      JSON.stringify({
        error: "this proposal touches a human-owned path — the advice feed cannot write it",
        adviceId,
        path: proposal.path,
        tier: proposal.tier,
        reason: message,
        route: "crewhaus propose",
        diff,
      }),
    );
  }

  if (ctx.body["confirm"] !== true) {
    return {
      ...found("preview — nothing was written", "crewhaus advise"),
      adviceId,
      applied: false,
      tier: proposal.tier,
      diff: diffSpecYaml(before, applied.yaml).map((d) => ({ ...d })),
      preview: maskSpecYaml(applied.yaml),
      confirmWith: 'send "confirm": true to write it',
    };
  }
  // Atomic: write beside the spec and rename, so a reader never sees half a
  // document. Written through the patch library's output — never a template.
  //
  // SEAM: this writes the working spec only. Recording a spec-registry
  // VERSION (and its CHANGELOG entry) belongs to the spec write path, which
  // owns that store; until this route can share that commit helper, an
  // advice-applied edit shows up in the file but not in version history, and
  // the response says so rather than implying otherwise.
  const tmp = `${specPath}.${process.pid}.tmp`;
  writeFileSync(tmp, applied.yaml, { mode: 0o600 });
  renameSync(tmp, specPath);
  return {
    ...found(
      "applied to crewhaus.yaml — this writes the working spec; register a version from the Spec tab to record it in version history",
      "crewhaus advise",
    ),
    adviceId,
    applied: true,
    tier: proposal.tier,
    edits: applied.applied,
    diff: diffSpecYaml(before, applied.yaml).map((d) => ({ ...d })),
  };
};

// ---------------------------------------------------------------------------
// Channel reactions
// ---------------------------------------------------------------------------

/** Read the spec's `sessionKey:` scalar leniently — a fleet console must
 *  render a spec one schema version ahead of this manager. */
function sessionKeyOf(specYaml: string): string | null {
  for (const line of specYaml.split("\n")) {
    const m = line.match(/^\s*sessionKey\s*:\s*(.+)$/);
    if (m === null) continue;
    const value = (m[1] ?? "").trim().replace(/^["']|["']$/g, "");
    if (value !== "" && !value.startsWith("#")) return value;
  }
  return null;
}

/** Does the spec declare a `feedback:` block at all? */
function hasFeedbackBlock(specYaml: string): boolean {
  return /^feedback\s*:/m.test(specYaml);
}

/**
 * `GET /api/h/:id/feedback/reactions` — channel reaction feedback state.
 *
 * WITH the precondition, always: reaction feedback needs the channel's
 * `sessionKey` to be `channel` or `user`. Under a `thread` sessionKey the
 * reaction has no session to attach to and the loop silently collects
 * nothing — a panel that showed "0 reactions" without saying why would be
 * indistinguishable from a quiet week.
 */
export const reactions: M3Handler = (ctx) => {
  const specYaml = readSpecYaml(ctx.harnessDir ?? "");
  const mode = sessionKeyOf(specYaml);
  const declared = hasFeedbackBlock(specYaml);
  const observed = readCorpus(ctx, 100).records.filter((r) => r.source === "channel");
  const collecting = mode === "channel" || mode === "user";
  const caveat =
    mode === null
      ? "this spec declares no channel sessionKey — reaction feedback needs `channel` or `user`"
      : collecting
        ? null
        : `sessionKey is "${mode}" — reaction feedback needs "channel" or "user"; under this key reactions collect NOTHING`;
  // The field is `sessionKeyMode`, NOT `sessionKey`: everything this server
  // serializes passes a credential masker that redacts any `*Key` property,
  // and this value is a routing MODE ("thread" / "channel" / "user"), not a
  // secret. Named `sessionKey` it would reach the console as "[redacted]".
  if (!declared && observed.length === 0) {
    return {
      ...absent(
        caveat ?? "this spec declares no feedback: block, so channel reactions are not wired",
        "add a feedback: block to crewhaus.yaml",
      ),
      declared,
      sessionKeyMode: mode,
      collecting: false,
      caveat,
      reactions: [],
    };
  }
  return {
    ...found(caveat, "crewhaus distill"),
    declared,
    sessionKeyMode: mode,
    collecting,
    caveat,
    reactions: observed.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      turnNumber: r.turnNumber,
      thumbs: r.rating.thumbs ?? null,
      ts: r.ts,
    })),
  };
};

// ---------------------------------------------------------------------------
// The fleet rollup
// ---------------------------------------------------------------------------

/**
 * `GET /api/feedback` — the cross-harness rollup.
 *
 * "Who is distill-ready" in one screen. Bounded on purpose: this folds each
 * harness's FEEDBACK SINK (a handful of small JSONL files) plus its
 * watermark, and does NOT open transcripts. Walking every transcript of every
 * harness on every poll is exactly the fleet-page cost this manager exists
 * not to pay — so the per-harness browser, which does scan transcripts under
 * a cap, is the place to get the fuller number, and this screen says so.
 */
export const feedbackFleet: M3Handler = (ctx) => {
  const rows = ctx.harnesses().map((harness) => foldOne(harness));
  const withRatings = rows.filter((r) => r.total > 0);
  if (withRatings.length === 0) {
    return {
      ...absent("no harness in the fleet has recorded ratings yet", "crewhaus rate"),
      harnesses: rows,
      scope: "feedback sinks only — transcripts are not opened on this screen",
    };
  }
  return {
    ...found(
      "counts fold the .crewhaus/feedback sinks only; in-transcript ratings are counted on each harness's own Feedback tab",
      "crewhaus distill",
    ),
    harnesses: rows,
    distillReady: rows.filter((r) => r.unprocessed >= 5).map((r) => r.id),
    scope: "feedback sinks only — transcripts are not opened on this screen",
  };
};

type FleetRow = {
  readonly id: string;
  readonly specName: string;
  readonly total: number;
  readonly up: number;
  readonly down: number;
  readonly unprocessed: number;
  readonly watermarkTs: string | null;
  readonly lastRatingTs: string | null;
};

function foldOne(harness: M3Harness): FleetRow {
  const dir = join(harness.dir, ".crewhaus", "feedback");
  const records: FeedbackRecord[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    names = [];
  }
  for (const name of names) {
    // Contained PER FILE against the harness's own directory: the fleet fold
    // reaches into many trees, and a sink name can be a symlink out of one.
    const path = resolveContained(dir, name);
    if (path === undefined) continue;
    records.push(...extractFeedbackRecords(readJsonlCapped(path, MAX_JSONL_LINES).objects));
  }
  const merged = mergeFeedback(records);
  const state = readDistillState(join(dir, ".distill-state.json"));
  const up = merged.filter((r) => (normalizeRating(r) ?? 0) > 0.5).length;
  let lastRatingTs: string | null = null;
  for (const r of merged) {
    if (lastRatingTs === null || r.ts > lastRatingTs) lastRatingTs = r.ts;
  }
  return {
    id: harness.id,
    specName: harness.specName,
    total: merged.length,
    up,
    down: merged.length - up,
    unprocessed: countUnprocessed(merged, state?.lastProcessedTs),
    watermarkTs: state?.lastProcessedTs ?? null,
    lastRatingTs,
  };
}

/** Exported for this area's tests. */
export { sessionKeyOf, tierFor };
