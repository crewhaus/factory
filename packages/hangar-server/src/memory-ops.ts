/**
 * M3 · MEMORY — facts, recall, continuity, learning, knowledge sync, and the
 * memory schema migration.
 *
 * STUBS. Owned by the Memory implementer together with `wiki-ops.ts` and
 * `watchme-ops.ts`. `memory.ts` (M1) stays the READ side for the five
 * allowlisted area views and must not be edited here.
 *
 * ---------------------------------------------------------------------------
 * THE ONE INVARIANT: NO HARD DELETE, ANYWHERE
 * ---------------------------------------------------------------------------
 * The memory fabric is append-only with tombstones. Hangar ships no
 * affordance that unlinks a memory file, truncates a JSONL, or removes a
 * fact line:
 *
 *   forget a fact      → append a `superseded` tombstone with the operator's
 *                        RECORDED REASON. Confirm-gated (a dialog).
 *   expire a fact      → the store's own TTL sweep; the manager renders the
 *                        countdown, it does not shortcut it.
 *   clear continuity   → move to `state/<spec>/trash/<ts>/`, restorable by
 *                        timestamp. Never `rm`.
 *   compact / sweep    → mirrors the CLI posture exactly, dry-run first, and
 *                        still writes tombstones rather than dropping lines.
 *
 * Reads fold tombstones (live / superseded / expired) and never rewrite the
 * file they folded. The stores take advisory locks correctly — wait ~2 s,
 * then steal only a STALE lock, and never hold one across user think-time:
 * an editor open in a browser tab is user think-time, so the lock is taken
 * at save, not at open.
 *
 * Provenance is the point of the facts browser: every fact carries its
 * `sessionId` and evidence `toolUseId`s, and both must come back as links
 * into the session viewer. That join is what makes a memory auditable.
 *
 * Implementation needs `@crewhaus/memory-store` (fold + `.recall`) and
 * `@crewhaus/continuity-store` added to this package's dependencies +
 * tsconfig references.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/memory/facts/:spec` — one `memories/<spec>.jsonl`, folded.
 *
 * Beyond the M1 summary: TTL expiry countdowns, `supersededBy` chains, and
 * provenance (`sessionId` + evidence `toolUseId`s) resolved into deep links.
 * Capped and torn-line tolerant like every other JSONL reader here.
 */
export const memoryFacts: M3Handler = () => notImplemented("facts browser");

/**
 * `POST /api/h/:id/memory/facts/:spec/forget` — supersede a fact.
 *
 * Body: `{ factId, reason, confirm: true }`. Writes a `superseded` tombstone
 * through the memory store with `reason` recorded. NEVER removes the
 * original line — the fold is what makes it disappear from the live view.
 */
export const memoryForget: M3Handler = () => notImplemented("forget fact");

/**
 * `POST /api/h/:id/memory/facts/:spec/sweep` — the expiry/compaction pass.
 *
 * Body: `{ dryRun }` — and `dryRun` DEFAULTS TO TRUE. Mirrors the CLI verb's
 * posture: show the plan, then run it as a second gesture.
 */
export const memorySweep: M3Handler = () => notImplemented("memory sweep");

/**
 * `POST /api/h/:id/memory/recall` — the recall playground.
 *
 * Body: `{ query, k? }`. Runs the store's own `.recall` (BM25/hybrid, the
 * same call the agent makes) and shows EXACTLY what would be recalled, with
 * scores. A POST because the query is free text and free text does not
 * belong in a URL. A read: it must not touch access counters or the file.
 */
export const memoryRecall: M3Handler = () => notImplemented("recall playground");

/**
 * `POST /api/h/:id/memory/migrate` — `crewhaus migrate memories`.
 *
 * The v1 → v2 fact-store backfill that stamps `.crewhaus/meta.json`. Through
 * the job queue, dry-run first, with the mixed-version fleet sweep rendered
 * from each harness's `meta.json` so an operator can see who is behind.
 */
export const memoryMigrate: M3Handler = () => notImplemented("memory schema migration");

/**
 * `GET /api/h/:id/memory/continuity` — the continuity panel.
 *
 * `state/<spec>/`: `focus.md` rendered with the REQ ledger highlighted,
 * plans with the proof ladder (open → in_progress → claimed → proven) and
 * evidence `toolUseId`s resolved into session links, `goals.yaml`, and
 * `handoff.md`. Read through `@crewhaus/continuity-store`, masked as prose.
 */
export const continuity: M3Handler = () => notImplemented("continuity panel");

/**
 * `GET /api/h/:id/memory/continuity/trash` — the trash browser.
 *
 * `state/<spec>/trash/<ts>/` snapshots. This directory is the reason
 * "clear" is safe; surfacing it is what makes the promise visible.
 */
export const continuityTrash: M3Handler = () => notImplemented("continuity trash");

/**
 * `POST /api/h/:id/memory/continuity/restore` — restore by timestamp.
 *
 * Body: `{ stamp, confirm }`. Restores a trash snapshot through the
 * continuity store. Restoring over live state is itself confirm-gated.
 */
export const continuityRestore: M3Handler = () => notImplemented("continuity restore");

/**
 * `GET /api/h/:id/memory/learning` — the learning subsystem panel.
 *
 * For specs with a `learning:` block: curriculum progress, the living
 * `exam{dataset, graders}` results (read from the eval index — the exam RUNS
 * through the eval launcher, not from here), study-rotation state
 * (`study.on_heartbeat` / `on_dream`), and the local knowledge-gap queue
 * (plus the Thredz `knowledge-gap` task tag, labelled as the study queue).
 */
export const learning: M3Handler = () => notImplemented("learning panel");

/**
 * `GET /api/h/:id/memory/knowledge` — knowledge-sync status.
 *
 * The `.crewhaus-shared/` fleet store: what this harness has pulled/pushed,
 * the provenance manifest, and the share opt-in state from
 * `.crewhaus/knowledge.json`. Read-only; the verb is below.
 */
export const knowledge: M3Handler = () => notImplemented("knowledge sync status");

/**
 * `POST /api/h/:id/memory/knowledge/sync` — `crewhaus knowledge sync`.
 *
 * Body: `{ direction: "pull" | "push", dryRun }`. Through the job queue.
 * A PUSH redacts on the way out and must show what it redacted BEFORE
 * running — sharing is the one direction that can leak.
 */
export const knowledgeSync: M3Handler = () => notImplemented("knowledge sync");

/**
 * `GET /api/h/:id/memory/dream/scaffold` — the nightly-cron scaffold.
 *
 * PRINT-ONLY: renders what `dream init` would generate (workflow/cron text)
 * so an operator can paste or PR it. Firing a dream is NOT here — it goes
 * through the M2 job queue (`POST /api/h/:id/jobs {kind:"dream-run"}`),
 * which is window-idempotent and `run.lock`-serialized, so it can never
 * double-fire against the daemon's janitor or a CI cron.
 */
export const dreamScaffold: M3Handler = () => notImplemented("dream cron scaffold");
