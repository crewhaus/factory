/**
 * M3 · MEMORY — watch-me: analytics, the reports browser, the intents
 * ranking, the watch toggle, and the synthesize review flow.
 *
 * STUBS. Owned by the Memory implementer. The M1 `watchmeView` read stays in
 * `memory.ts`.
 *
 * Three properties of this subsystem the manager must preserve rather than
 * paper over:
 *
 *   1. JUDGMENTS ARE NOT FEEDBACK. `watchme/judgments.jsonl` (what the judge
 *      thought) and `.crewhaus/feedback/feedback.jsonl` (what a human said)
 *      are separate stores BY DESIGN. Render them in visually separate
 *      surfaces; never sum them into one "quality" number.
 *   2. SYNTHESIZE IS ADVISORY. `watchme/synthesized/` holds PROPOSED mimic
 *      specs with per-edit rationale. Reading one is not applying it —
 *      applying is a separate, explicit gesture that goes through the spec
 *      write path (`spec-edit.ts`), with the human-owned/auto-tunable split
 *      enforced exactly as it is for a hand edit.
 *   3. UNPRICED COST IS ITS OWN BUCKET. The `{agg:1}` Welford aggregates
 *      carry an UNKNOWN-unpriced model bucket; folding it into "$0" turns a
 *      measurement gap into a false zero. Show it as unpriced.
 *
 * `watchme:` is a human-owned spec block, so the watch toggle is a
 * confirm-gated spec edit — not a side-channel flag file.
 *
 * Publishing to the wiki must offer `--dry-run` FIRST: it writes articles
 * into the memory fabric, and a preview is the difference between a review
 * and a surprise.
 *
 * Implementation needs `@crewhaus/watchme-store` (`openWatchmeStore`) added
 * to this package's dependencies + tsconfig references.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/memory/watchme/analytics` — the charts.
 *
 * From `watchme/observations.jsonl` plus the `{agg:1}` Welford aggregate
 * lines: turns, per-model cost (with the UNKNOWN-unpriced bucket kept
 * distinct), tool error rates, feedback ±, and the continuity/factuality
 * scores. Capped and torn-line tolerant.
 */
export const watchmeAnalytics: M3Handler = () => notImplemented("watchme analytics");

/**
 * `GET /api/h/:id/memory/watchme/reports` — the reports index.
 *
 * `watchme/reports/<ts>/` directories, newest first, with each report's
 * summary line. Directory names are validated as safe segments before use.
 */
export const watchmeReports: M3Handler = () => notImplemented("watchme reports");

/** `GET /api/h/:id/memory/watchme/reports/:stamp` — one rendered report,
 *  read through the per-file containment check and masked as prose. */
export const watchmeReport: M3Handler = () => notImplemented("watchme report");

/**
 * `GET /api/h/:id/memory/watchme/intents` — the intent-cluster ranking.
 *
 * The `crewhaus watchme intents --json` view for this harness: clusters,
 * counts, and representative sessions deep-linked into the session viewer.
 */
export const watchmeIntents: M3Handler = () => notImplemented("watchme intents");

/**
 * `POST /api/h/:id/memory/watchme/toggle` — watch on/off.
 *
 * Body: `{ watching, confirm }`. `watchme:` is a HUMAN-OWNED spec path, so
 * this is a confirm-gated spec edit through `applySpecEdits`, not a write to
 * `watchme/state.json`.
 */
export const watchmeToggle: M3Handler = () => notImplemented("watchme toggle");

/**
 * `GET /api/h/:id/memory/watchme/synthesized` — proposed mimic specs.
 *
 * `watchme/synthesized/` entries with their per-edit rationale, each edit
 * already classified auto-tunable vs human-owned so the review UI can show
 * what applying would actually cost.
 */
export const watchmeSynthesized: M3Handler = () => notImplemented("synthesize review");

/**
 * `POST /api/h/:id/memory/watchme/synthesized/:stamp/apply` — apply a
 * proposal, edit by edit.
 *
 * Body: `{ edits: string[], confirm }` — the operator picks WHICH edits.
 * Applies through the spec write path with the same restriction and the same
 * propose fallback; a proposal never gets a privileged channel.
 */
export const watchmeApply: M3Handler = () => notImplemented("synthesize apply");

/**
 * `POST /api/h/:id/memory/watchme/publish` — publish findings to the wiki.
 *
 * Body: `{ dryRun }`, defaulting to a dry run. The preview lists the
 * articles that would be created/updated; the real run goes through the wiki
 * store with `expectedVersion` like any other write.
 */
export const watchmePublish: M3Handler = () => notImplemented("watchme publish");
