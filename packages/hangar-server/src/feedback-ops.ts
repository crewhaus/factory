/**
 * M3 · FEEDBACK — the growth loops: the ratings browser + distill watermark,
 * the few-shot pool, FAQ distill, lessons, advise, channel reactions, and
 * the cross-harness rollup.
 *
 * STUBS. Owned by the Evals+Data implementer. The review QUEUE and its
 * adjudication (M2, `review.ts`) stay where they are — this module is the
 * other half: what the ratings turn INTO.
 *
 * The loop, and where each verb sits in it:
 *
 *   ratings (`.crewhaus/feedback/feedback.jsonl`)
 *     → `distill`  → an eval dataset + graders (`--register` promotes them)
 *     → `fewshot harvest` → the golden few-shot pool
 *     → `faq distill`     → the auto-discovered FAQ skill
 *     → `lessons update`  → LESSONS.md + `.crewhaus/preferences/`
 *     → `advise`          → SpecPatches in `.crewhaus/advice/`
 *
 * Rules:
 *   - WRITES GO THROUGH THE FeedbackRecord WRITERS, the same path
 *     `crewhaus rate` uses. Never append to `feedback.jsonl` by hand.
 *   - THE WATERMARK IS THE TRUTH about what distill has consumed:
 *     `.crewhaus/feedback/.distill-state.json` plus the unprocessed count.
 *     Show both; "N new ratings" with no watermark is a guess.
 *   - ADVICE IS ADVISORY. `.crewhaus/advice/` holds proposals. Applying one
 *     goes through the spec write path, and any non-optimizable path routes
 *     to `crewhaus propose` — the advice feed gets no privileged channel.
 *   - CHANNEL REACTIONS HAVE A PRECONDITION. Slack 👍/👎 reaction feedback
 *     only works when the channel's `sessionKey` is `channel` or `user`; a
 *     `thread` sessionKey silently collects nothing. Surface the caveat with
 *     the state, or the panel lies by omission.
 *   - `autoDistill` is CLI-only in the shipped runtime. If the console
 *     offers "distill now" it must say it is running the verb, not toggling
 *     a runtime behaviour.
 *
 * Implementation reuses `@crewhaus/feedback-distill` (already a dependency);
 * the pool/FAQ/lessons/advice stores are plain `.crewhaus/` subtrees read
 * with the usual caps + per-file containment.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/feedback` — the ratings browser.
 *
 * `feedback.jsonl` folded (ratings, adjudications, corrections) with the
 * distill watermark and the unprocessed count beside it. Turn ordinals are
 * kept so a rating deep-links to the exact turn in the session viewer.
 */
export const feedback: M3Handler = () => notImplemented("feedback browser");

/**
 * `POST /api/h/:id/feedback/distill` — "Distill now".
 *
 * Body: `{ judge?, register? }` → `crewhaus distill` through the job queue.
 * `--register` PROMOTES the result into the dataset registry, which is a
 * different act from producing it — make the flag explicit in the UI.
 */
export const distillRun: M3Handler = () => notImplemented("distill run");

/** `GET /api/h/:id/feedback/fewshot` — the golden few-shot pool
 *  (`.crewhaus/fewshot/`): entries, provenance, and which are in use. */
export const fewshot: M3Handler = () => notImplemented("fewshot pool");

/** `POST /api/h/:id/feedback/fewshot` — `fewshot harvest` through the job
 *  queue. Harvesting adds examples the agent will imitate: preview first. */
export const fewshotHarvest: M3Handler = () => notImplemented("fewshot harvest");

/** `GET /api/h/:id/feedback/faq` — the auto-discovered FAQ skill
 *  (`.crewhaus/skills/faq/`) rendered, so the generated skill is inspectable
 *  rather than magic. */
export const faq: M3Handler = () => notImplemented("faq view");

/** `POST /api/h/:id/feedback/faq` — `faq distill`: recurring questions →
 *  the FAQ skill. Job-queued; the generated skill is a file the operator can
 *  read afterwards (`inspect.ts` browses `skills/`). */
export const faqDistill: M3Handler = () => notImplemented("faq distill");

/** `GET /api/h/:id/feedback/lessons` — `LESSONS.md` plus
 *  `.crewhaus/preferences/`, both rendered as prose (masked). */
export const lessons: M3Handler = () => notImplemented("lessons view");

/** `POST /api/h/:id/feedback/lessons` — `lessons update`: corrections and
 *  failures → lessons + preferences. Job-queued, diff previewed. */
export const lessonsUpdate: M3Handler = () => notImplemented("lessons update");

/**
 * `GET /api/h/:id/feedback/advice` — the advisory feed.
 *
 * `.crewhaus/advice/` SpecPatches mined from session logs, each already
 * classified auto-tunable vs human-owned so the review UI shows what
 * applying would cost before the operator clicks.
 */
export const advice: M3Handler = () => notImplemented("advice feed");

/** `POST /api/h/:id/feedback/advice` — run `crewhaus advise`. Body:
 *  `{ since?, limit? }` through the job queue. Produces proposals only. */
export const adviceRun: M3Handler = () => notImplemented("advise run");

/**
 * `POST /api/h/:id/feedback/advice/:adviceId/apply` — apply one proposal.
 *
 * Body: `{ confirm }`. Goes through the spec write path with
 * `restrictToOptimizable`; a non-optimizable path is refused with the diff
 * and the `crewhaus propose` route named in the refusal.
 */
export const adviceApply: M3Handler = () => notImplemented("advice apply");

/**
 * `GET /api/h/:id/feedback/reactions` — channel reaction feedback state.
 *
 * The spec's `feedback:` block plus the reaction events observed, WITH the
 * sessionKey caveat: reactions need a `channel` or `user` sessionKey. A
 * `thread` sessionKey means the panel must say "collecting nothing, and
 * here is why".
 */
export const reactions: M3Handler = () => notImplemented("channel reactions");

/**
 * `GET /api/feedback` — the cross-harness rollup (fleet-wide).
 *
 * Ratings volume and balance per harness, plus each harness's unprocessed
 * count, so "who is distill-ready" is one screen. Folded through the same
 * digest-keyed cache the fleet feed uses — never by walking every
 * transcript on every poll.
 */
export const feedbackFleet: M3Handler = () => notImplemented("fleet feedback rollup");
