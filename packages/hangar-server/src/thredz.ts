/**
 * M3 · THREDZ — the server-side proxied explorer: wiki, records + schemas,
 * goals/tasks, views, dashboards + cards, listeners, webhooks, connectors,
 * activity, traverse, and API-key administration.
 *
 * STUBS. Owned by the Thredz implementer; this is the only module in the
 * area.
 *
 * ---------------------------------------------------------------------------
 * KEY CUSTODY — the rule the whole module exists to protect
 * ---------------------------------------------------------------------------
 * A Thredz API key lives in the HARNESS's `.env`/spec and nowhere else. Every
 * request here is proxied SERVER-SIDE: the key is read at request time from
 * the harness's own environment, attached to the upstream call, and dropped.
 * It is never:
 *   - returned to the browser (the client calls `/api/h/:id/thredz/*`, never
 *     the Thredz API directly),
 *   - persisted into manager state, the registry, or the rollup cache,
 *   - written into a log line or an error message,
 *   - placed in a URL or query string.
 * The harness-LESS global explorer (`GET /api/thredz`) may use
 * `CREWHAUS_THREDZ_KEY` from the MANAGER's own process environment — still
 * never persisted to manager config. A harness with no key configured is an
 * honest empty state ("no key in this harness"), not an error.
 *
 * ---------------------------------------------------------------------------
 * OTHER CONTRACTS THAT ARE EASY TO BREAK
 * ---------------------------------------------------------------------------
 *   - SOFT DELETE ONLY. Every Thredz delete is soft with a restore path. The
 *     manager ships no hard-delete affordance for any Thredz object.
 *   - VISIBILITY IS ALWAYS EXPLICIT. Hangar sets `visibility` on every write,
 *     defaulting to PRIVATE — the API's shared-by-default behaviour is a
 *     foot-gun the manager neutralizes rather than inherits.
 *   - WIKI WRITES CARRY `expectedVersion` and use the same
 *     `stale_article_version` re-read-retry UX as the local wiki
 *     (`wiki-ops.ts`). Identical, deliberately.
 *   - THE `## Sources` GATE IS LOCAL-ONLY. Do not display it as a Thredz
 *     rule.
 *   - DASHBOARD CARD GRAMMAR IS VALIDATED UPSTREAM AND IT IS FUSSY: KPI
 *     cards require both `display.aggregation` AND `display.aggregationField`;
 *     record filters take a `tags` ARRAY (AND semantics) while task/goal
 *     filters take a SINGULAR `tag`; graph cards are line|bar|pie|dot.
 *     Surface the API's validation messages VERBATIM — paraphrasing them
 *     makes a fixable card look broken.
 *   - FREE-PLAN QUOTAS ARE REAL (3 goals; listeners are plan-quota'd).
 *     Render the quota refusal as a fact, not a failure.
 *   - LISTENER INGEST IS IDEMPOTENCY-KEYED. Preserve the key when replaying.
 *   - THE LOCAL STORE STAYS AUTHORITATIVE. When a harness mirrors its wiki
 *     to Thredz, a degraded mirror is a BADGE — the local store is still the
 *     source of truth and the panel must say which backend it is showing.
 *
 * Upstream responses pass `maskDeep` on the way out like every other payload
 * (they are third-party content), and every failure is reported with the
 * upstream status so a 402/429 does not read as a manager bug.
 */
import type { M3Handler } from "./m3";
import { notImplemented } from "./m3";

/**
 * `GET /api/h/:id/thredz` — the harness's Thredz status.
 *
 * Key PRESENCE (never the key), the resolved workspace, the permission tier
 * the key carries, the wiki backend badge (local vs thredz), plan quotas,
 * and the mirror's degraded state if it has one.
 */
export const thredzStatus: M3Handler = () => notImplemented("thredz status");

/** `GET /api/h/:id/thredz/wiki` — the Thredz wiki list with tag/status
 *  filters and semantic search applied UPSTREAM (the manager forwards the
 *  query, it does not re-implement search). */
export const thredzWiki: M3Handler = () => notImplemented("thredz wiki list");

/** `GET /api/h/:id/thredz/wiki/:slug` — one article with its frontmatter,
 *  backlinks, comments and votes/signals. */
export const thredzWikiArticle: M3Handler = () => notImplemented("thredz wiki read");

/**
 * `PUT /api/h/:id/thredz/wiki/:slug` — write an article.
 *
 * Body: `{ body, title?, tags?, visibility?, expectedVersion }`.
 * `visibility` is ALWAYS sent, defaulting to private. A version conflict
 * answers 409 with the current version so the client runs the same
 * re-read-retry flow as the local wiki.
 */
export const thredzWikiWrite: M3Handler = () => notImplemented("thredz wiki write");

/** `GET /api/h/:id/thredz/wiki/:slug/versions` — version list + diffs. */
export const thredzWikiVersions: M3Handler = () => notImplemented("thredz wiki versions");

/** `POST /api/h/:id/thredz/wiki/:slug/rollback` — roll back to a version.
 *  Body: `{ version, confirm }`. A rollback creates a NEW version; it never
 *  removes the ones in between. */
export const thredzWikiRollback: M3Handler = () => notImplemented("thredz wiki rollback");

/** `GET /api/h/:id/thredz/records` — records with filters. Record `tags`
 *  filters are an ARRAY with AND semantics — pass them through unchanged. */
export const thredzRecords: M3Handler = () => notImplemented("thredz records");

/** `POST /api/h/:id/thredz/records` — create a record against a schema.
 *  Surface schema-validation messages verbatim. */
export const thredzRecordCreate: M3Handler = () => notImplemented("thredz record create");

/** `GET /api/h/:id/thredz/records/:recordId` — one record. */
export const thredzRecord: M3Handler = () => notImplemented("thredz record read");

/** `DELETE /api/h/:id/thredz/records/:recordId` — SOFT delete. The record
 *  becomes restorable; nothing is destroyed. */
export const thredzRecordDelete: M3Handler = () => notImplemented("thredz record soft-delete");

/** `POST /api/h/:id/thredz/records/:recordId/restore` — undo a soft delete.
 *  Its existence is what makes the delete affordance acceptable. */
export const thredzRecordRestore: M3Handler = () => notImplemented("thredz record restore");

/** `GET /api/h/:id/thredz/schemas` — record schemas, so the record forms and
 *  the view builder can be generated rather than hand-written. */
export const thredzSchemas: M3Handler = () => notImplemented("thredz schemas");

/** `GET /api/h/:id/thredz/goals` — goals. Free-plan workspaces cap at three;
 *  render the quota refusal as a fact. Goal filters use a SINGULAR `tag`. */
export const thredzGoals: M3Handler = () => notImplemented("thredz goals");

/** `GET /api/h/:id/thredz/tasks` — tasks. The `knowledge-gap` tag is the
 *  learning subsystem's study queue — label it that way (see
 *  `memory-ops.ts`'s learning panel). Task filters use a SINGULAR `tag`. */
export const thredzTasks: M3Handler = () => notImplemented("thredz tasks");

/** `POST /api/h/:id/thredz/tasks/:taskId` — update one task (status,
 *  assignee, tags). */
export const thredzTaskUpdate: M3Handler = () => notImplemented("thredz task update");

/** `GET /api/h/:id/thredz/views` — saved views. */
export const thredzViews: M3Handler = () => notImplemented("thredz views");

/** `POST /api/h/:id/thredz/views/:viewId/execute` — run a view (`/execute`)
 *  and return its rows. Body carries the view's parameters. */
export const thredzViewExecute: M3Handler = () => notImplemented("thredz view execute");

/** `GET /api/h/:id/thredz/dashboards` — dashboards. */
export const thredzDashboards: M3Handler = () => notImplemented("thredz dashboards");

/** `GET /api/h/:id/thredz/dashboards/:dashboardId` — one dashboard with its
 *  cards and their rendered data. */
export const thredzDashboard: M3Handler = () => notImplemented("thredz dashboard");

/**
 * `POST /api/h/:id/thredz/dashboards/:dashboardId/cards` — add a card.
 *
 * The card grammar is validated upstream and is fussy: KPI cards need BOTH
 * `display.aggregation` and `display.aggregationField`; graph cards are
 * line|bar|pie|dot. Forward the API's validation message verbatim.
 */
export const thredzCardCreate: M3Handler = () => notImplemented("thredz card create");

/** `GET /api/h/:id/thredz/listeners` — event-driven automations, with their
 *  plan quota and Idempotency-Key ingest state. */
export const thredzListeners: M3Handler = () => notImplemented("thredz listeners");

/** `POST /api/h/:id/thredz/listeners` — create a listener. Preserve the
 *  Idempotency-Key semantics on ingest. */
export const thredzListenerCreate: M3Handler = () => notImplemented("thredz listener create");

/** `GET /api/h/:id/thredz/webhooks` — webhook registrations and their
 *  delivery state. */
export const thredzWebhooks: M3Handler = () => notImplemented("thredz webhooks");

/** `GET /api/h/:id/thredz/connectors` — configured connectors and their
 *  health. */
export const thredzConnectors: M3Handler = () => notImplemented("thredz connectors");

/** `GET /api/h/:id/thredz/activity` — the workspace activity feed, distinct
 *  from the manager's own `/api/activity` digest. */
export const thredzActivity: M3Handler = () => notImplemented("thredz activity");

/** `POST /api/h/:id/thredz/traverse` — the graph traversal endpoint. Body
 *  carries the start node + traversal spec; a POST because the spec is
 *  structured, not because it writes. */
export const thredzTraverse: M3Handler = () => notImplemented("thredz traverse");

/** `GET /api/h/:id/thredz/keys` — key administration (admin-tier keys only).
 *  Lists key METADATA and grants — never key material. */
export const thredzKeys: M3Handler = () => notImplemented("thredz keys");

/** `POST /api/h/:id/thredz/keys` — create a key (`POST /keys` +
 *  `/wiki/access` grants). The created key is shown ONCE to the operator and
 *  never stored by the manager. */
export const thredzKeyCreate: M3Handler = () => notImplemented("thredz key create");

/** `POST /api/h/:id/thredz/keys/:keyId/rotate` — rotate a key. Same
 *  show-once rule; typed-confirm, because rotation breaks anything still
 *  holding the old value. */
export const thredzKeyRotate: M3Handler = () => notImplemented("thredz key rotate");

/**
 * `GET /api/thredz` — the harness-less global explorer (fleet-wide).
 *
 * Uses `CREWHAUS_THREDZ_KEY` from the MANAGER's own process environment when
 * one is set — never persisted to manager config, and absent is an honest
 * empty state that points at the per-harness explorers instead.
 */
export const thredzGlobal: M3Handler = () => notImplemented("thredz global explorer");
