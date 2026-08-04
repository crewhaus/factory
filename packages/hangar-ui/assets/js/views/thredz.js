/**
 * Thredz — the explorer: wiki, records and schemas, goals and tasks, views,
 * dashboards and cards, listeners, webhooks, connectors, activity, traverse,
 * and API-key administration. Plus the harness-less global explorer.
 *
 * EVERY REQUEST IS PROXIED. The browser never holds a Thredz key: it calls
 * `/api/h/:id/thredz/*`, and the server reads the harness's key at request
 * time. That is why this view has no key field and no "connect" button.
 *
 * Things the screen must present faithfully rather than smooth over:
 *   - deletes are SOFT, with restore. There is no hard-delete affordance.
 *   - visibility is always set explicitly, defaulting to private.
 *   - a wiki write carries `expectedVersion` and gets the same
 *     re-read-retry flow as the local wiki.
 *   - card-grammar validation messages are shown VERBATIM (KPI cards need
 *     both `display.aggregation` and `display.aggregationField`; record
 *     filters take a `tags` array, task/goal filters a singular `tag`).
 *   - free-plan quotas (three goals, listener limits) are facts, not errors.
 *   - the local store stays authoritative; a degraded mirror is a badge.
 */

import { renderPendingSurface } from "../pending.js";

/** The per-harness Thredz tab. */
export async function renderThredz(root, _ctx) {
  renderPendingSurface(root, {
    group: "thredz",
    title: "Thredz",
    blurb:
      "Wiki with versions and rollback, records and schemas, goals and tasks (the knowledge-gap tag is the study queue), views, dashboards and cards, listeners, webhooks, connectors, activity, traverse and key admin — all server-side proxied.",
  });
}

/** The harness-less global explorer (`#/thredz`). */
export async function renderThredzGlobal(root) {
  renderPendingSurface(root, {
    group: "thredz",
    title: "Thredz explorer",
    blurb:
      "The workspace explorer using the manager's own CREWHAUS_THREDZ_KEY when one is set — never persisted to manager config, and an honest empty state when it is absent.",
  });
}
