/**
 * The executable UI↔server contract. Imports the hangar-ui console's route
 * map (`assets/js/routes.js` — the SAME pure-data module `api.js` builds
 * every request from) and drives EVERY route in it against a live fixture
 * server:
 *
 *   - writes must answer 2xx AND their effect must be visible on re-read;
 *   - reads must answer 2xx AND carry every field the corresponding view
 *     actually reads (the VIEW_READS table below, kept in lockstep with
 *     the views by review).
 *
 * A route the server does not implement, a body key it rejects, or a
 * payload field it stopped emitting fails HERE — this test is the alarm
 * that prevents the M1 "every write 405s / every column is em-dash" class
 * of contract drift from recurring. A route added to routes.js without a
 * driver below fails the completeness check.
 *
 * ---------------------------------------------------------------------------
 * M3 — how a frozen contract stays honest while its handlers are stubs
 * ---------------------------------------------------------------------------
 * The M3 detail surface (every route carrying a `group`) is driven too, and
 * each one must answer one of exactly two things:
 *
 *   501 `not implemented (M3): …`  the handler is still a stub. The route
 *       exists, its guards ran, its client wrapper reached it.
 *   2xx                            the handler is REAL — and then, for a
 *       read, `VIEW_READS` must carry its table and every field in it must
 *       be present.
 *
 * Nothing else passes. A 404 means the dispatch table and the route map
 * disagree; a 500 means a guard threw. So an implementer's whole job is:
 * make the handler return real data, add the `VIEW_READS` entry, and add an
 * effect assertion for a write. No edit to this file's driving loop, and no
 * edit to `routes.js` — which is what lets six areas be built in parallel.
 *
 * The server's own dispatch table is asserted equal to the map's grouped
 * entries, so all three files (routes.js, m3-routes.ts, this test) are held
 * to one truth.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logLine, makeFixtureHarness } from "./fixture";
import { M3_ROUTES } from "./m3-routes";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

type RouteDef = {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly stream?: string;
  /** Set on every M3 route; names the area module that owns it. */
  readonly group?: string;
};

/** The client's route map, loaded from the sibling package's asset file.
 *  Dynamic import by URL: the asset is a browser ES module, not part of
 *  this package's TS program. */
async function loadRoutes(): Promise<Record<string, RouteDef>> {
  const url = new URL("../../hangar-ui/assets/js/routes.js", import.meta.url).href;
  const mod = (await import(url)) as { ROUTES: Record<string, RouteDef> };
  return mod.ROUTES;
}

// ---------------------------------------------------------------------------
// VIEW_READS — for each read route (key = route key, or `memory:<area>` for
// the area-parameterized route, `harnesses:cold` for the un-hydrated feed),
// the payload fields the hangar-ui views dereference, as
// [path, type] pairs. Path grammar: dot-separated keys; a `[]` suffix
// descends into every element of a NON-EMPTY array. Types may union with
// `|` ("string|null").
// ---------------------------------------------------------------------------

const VIEW_READS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  // app.js loadVersion
  version: [
    ["hangar", "string"],
    ["protocolV", "number"],
  ],
  // util.js normalizeRows ← library.js fleet table (cold: cache may be empty)
  "harnesses:cold": [
    ["harnesses[].id", "string"],
    ["harnesses[].dir", "string"],
    ["harnesses[].specName", "string"],
    ["harnesses[].target", "string"],
    ["harnesses[].model", "string|null"],
    ["harnesses[].groups", "array"],
    ["harnesses[].tags", "array"],
    ["harnesses[].pinned", "boolean"],
    ["harnesses[].notes", "string"],
    ["harnesses[].missingSince", "string|null"],
    ["harnesses[].lastSeen", "string"],
    ["harnesses[].capabilities", "array"],
    ["harnesses[].evalHealthy", "boolean|null"],
    ["harnesses[].cachedAt", "string|null"],
    ["harnesses[].rollup", "object|null"],
    ["harnesses[].supervision", "string|null"],
    ["harnesses[].pendingApprovals", "number"],
  ],
  // …and hydrated: the nested rollup the table's columns come from
  harnesses: [
    ["harnesses[].capabilities[]", "string"],
    ["harnesses[].evalHealthy", "boolean"],
    ["harnesses[].cachedAt", "string"],
    ["harnesses[].rollup.sessionCount", "number"],
    ["harnesses[].rollup.spend7d", "number"],
    ["harnesses[].rollup.cachedAt", "string"],
    ["harnesses[].rollup.lastEval.datasetName", "string"],
    ["harnesses[].rollup.lastEval.passRate", "number"],
    ["harnesses[].rollup.lastEval.ts", "string"],
  ],
  // app.js harnessHeader + overview.js health/memory cards
  harness: [
    ["entry.id", "string"],
    ["entry.dir", "string"],
    ["entry.specName", "string"],
    ["entry.target", "string"],
    ["entry.missingSince", "string|null"],
    ["entry.pinned", "boolean"],
    ["missing", "boolean"],
    ["inventory.specName", "string"],
    ["inventory.header", "object"],
    ["health.registered", "boolean"],
    ["health.evalHealthy", "boolean"],
    ["health.evalNote", "string"],
    ["health.openIncidents", "number"],
    ["health.hasAudit", "boolean"],
    ["health.pinnedEnvs", "array"],
    ["badges", "object"],
    ["preflight.ok", "boolean"],
    ["preflight.blocking", "number"],
    ["preflight.warn", "number"],
    ["preflight.info", "number"],
    ["envFiles", "array"],
    ["memory.facts", "number"],
    ["memory.articles", "number"],
    ["rollup", "object"],
  ],
  // views/spec.js
  spec: [
    ["yaml", "string"],
    ["specName", "string"],
    ["target", "string"],
    ["issues", "array"],
    ["envRefs[].key", "string"],
    ["envRefs[].set", "boolean"],
    ["badges", "object"],
  ],
  // views/overview.js preflightCard
  preflight: [
    ["report.ok", "boolean"],
    ["report.items[].level", "string"],
    ["report.items[].message", "string"],
    ["envFiles", "array"],
  ],
  // views/sessions.js list
  sessions: [
    ["sessionRoot", "object"],
    ["pins", "array"],
    ["sessions[].id", "string"],
    ["sessions[].name", "string"],
    ["sessions[].model", "string"],
    ["sessions[].updatedAt", "string"],
    ["sessions[].lastTurnIndex", "number"],
    ["sessions[].evicted", "boolean"],
  ],
  // views/sessions.js transcript (via util.interleaveTranscript)
  session: [
    ["id", "string"],
    ["evicted", "boolean"],
    ["turns[].role", "string"],
    ["turns[].text", "string"],
    ["turns[].line", "number"],
    ["tools[].name", "string"],
    ["tools[].line", "number"],
    ["tools[].isError", "boolean"],
    ["gutter[].kind", "string"],
    ["gutter[].line", "number"],
    ["otherKinds", "object"],
    ["truncated", "boolean"],
    ["lineCount", "number"],
    ["tornCount", "number"],
  ],
  // views/evals.js history
  evals: [
    ["runs[].runId", "string"],
    ["runs[].datasetName", "string"],
    ["runs[].passRate", "number"],
    ["runs[].meanScore", "number"],
    ["runs[].sampleCount", "number"],
    ["runs[].ts", "string"],
    ["baselines", "object"],
  ],
  // views/evals.js run drill-down
  evalRun: [
    ["runId", "string"],
    ["summary", "object"],
    ["sampleIds[]", "string"],
  ],
  // views/evals.js sample drill-down
  evalSample: [
    ["runId", "string"],
    ["sampleId", "string"],
    ["grades", "object"],
    ["meta", "object"],
    ["transcript", "array"],
    ["transcriptTruncated", "boolean"],
  ],
  // views/memory.js cards
  "memory:facts": [
    ["files[].specName", "string"],
    ["files[].live", "number"],
    ["files[].superseded", "number"],
    ["files[].expired", "number"],
    ["files[].truncated", "boolean"],
    ["files[].items[].id", "string"],
    ["files[].items[].text", "string"],
    ["files[].items[].status", "string"],
    ["files[].items[].tags", "array"],
  ],
  "memory:wiki": [
    ["index", "object|null"],
    ["articles[]", "string"],
  ],
  "memory:state": [
    ["focus", "string|null"],
    ["goals", "string|null"],
    ["plans", "array"],
  ],
  "memory:dream": [
    ["specs[].specName", "string"],
    ["specs[].state", "object"],
  ],
  "memory:watchme": [
    ["state", "object"],
    ["observationsTail", "array"],
    ["judgmentsTail", "array"],
  ],
  wikiArticle: [
    ["slug", "string"],
    ["body", "string"],
    ["truncated", "boolean"],
  ],
  // ---- M2 ---------------------------------------------------------------
  // views/proc.js — the Start/Stop/Drain card
  proc: [
    ["id", "string"],
    ["target", "string"],
    ["runClass", "string"],
    ["state", "string"],
    ["adopted", "boolean"],
    ["draining", "boolean"],
    ["restartsInWindow", "number"],
    ["runfile", "object|null"],
    ["control.port", "number|null"],
    ["control.available", "boolean"],
    ["control.reason", "string|null"],
    ["bundle.present", "boolean"],
    ["bundle.freshness.state", "string"],
    ["bundle.freshness.exact", "boolean"],
    ["bundle.freshness.label", "string"],
    ["launch.mode", "string|null"],
    ["launch.canResume", "boolean"],
    ["launch.cliTwin", "string|null"],
    ["launch.error", "object|null"],
    ["recentRuns", "array"],
  ],
  // views/runs.js — the run-history table
  runs: [
    ["runs[].runId", "string"],
    ["runs[].kind", "string"],
    ["runs[].startedAt", "string"],
    ["runs[].logFile", "string"],
    ["truncated", "boolean"],
  ],
  // views/runs.js — one run's drill-down
  run: [
    ["runId", "string"],
    ["entry", "object|null"],
    ["live", "boolean"],
    ["events", "array"],
    ["eventsTruncated", "boolean"],
    ["proseTail", "array"],
  ],
  // views/control.js — the wake/drain card. ALWAYS a typed envelope.
  controlStatus: [
    ["ok", "boolean"],
    ["code", "string"],
    ["reason", "string"],
    ["retryable", "boolean"],
    ["expected", "boolean"],
  ],
  // views/schedulers.js — the four-lane timeline
  schedulers: [
    ["lanes[].lane", "string"],
    ["lanes[].armed", "boolean"],
    ["lanes[].cadence", "string|null"],
    ["lanes[].cadenceSource", "string"],
    ["lanes[].lastFiredAt", "string|null"],
    ["lanes[].nextDueAt", "string|null"],
    ["lanes[].pokeable", "boolean"],
    ["lanes[].pokeReason", "string|null"],
    ["controlReachable", "boolean"],
    ["controlReason", "string|null"],
    ["draining", "boolean"],
  ],
  // views/approvals.js — the fleet inbox
  approvals: [
    ["approvals[].id", "string"],
    ["approvals[].harnessId", "string"],
    ["approvals[].specName", "string"],
    ["approvals[].toolName", "string"],
    ["approvals[].inputHash", "string"],
    ["approvals[].surface", "string"],
    ["approvals[].createdAt", "string"],
    ["approvals[].status", "string"],
    ["approvals[].decidedBy", "string|null"],
    ["approvals[].parkedRun.harnessId", "string"],
    ["approvals[].parkedRun.runId", "string"],
    ["approvals[].parkedRun.sessionId", "string"],
    ["pending", "number"],
    ["truncatedHarnesses", "array"],
  ],
  // views/review.js — the fleet review queue
  review: [
    ["items[].id", "string"],
    ["items[].kind", "string"],
    ["items[].status", "string"],
    ["items[].ts", "string"],
    ["items[].harnessId", "string"],
    ["items[].specName", "string"],
    ["items[].adjudicable", "boolean"],
    ["items[].sourceRef", "object"],
    ["open", "number"],
  ],
  // views/activity.js — the digest
  activity: [
    ["since", "string"],
    ["truncated", "boolean"],
    ["items[].kind", "string"],
    ["items[].harnessId", "string"],
    ["items[].specName", "string"],
    ["items[].at", "string"],
    ["items[].label", "string"],
  ],
  // views/jobs.js — the queue. `recent` is not decoration: a job the queue
  // RESTORED as `interrupted` (mutating work a dead manager abandoned) never
  // re-enters pending/running, so the ledger fold is the only place it can
  // ever be seen — as is every job the moment it finishes.
  jobs: [
    ["pending", "array"],
    ["running[].jobId", "string"],
    ["running[].kind", "string"],
    ["running[].harnessDir", "string"],
    ["running[].state", "string"],
    ["running[].mutating", "boolean"],
    ["recent[].jobId", "string"],
    ["recent[].state", "string"],
  ],
  // views/deploy.js — F-6, read-only + honest empty state
  deployments: [
    ["present", "boolean"],
    ["deployments", "array"],
    ["error", "string|null"],
    ["path", "string"],
    ["note", "string|null"],
  ],
  // views/costs.js + overview.js costCard
  costs: [
    ["id", "string"],
    ["costs.totalUsdMicros", "number"],
    ["costs.calls", "number"],
    ["costs.spend7dUsdMicros", "number"],
    ["costs.truncatedFiles", "number"],
    ["costs.byModel[].provider", "string"],
    ["costs.byModel[].modelId", "string"],
    ["costs.byModel[].calls", "number"],
    ["costs.byModel[].usdMicros", "number"],
    ["costs.byModel[].inputTokens", "number"],
    ["costs.byModel[].outputTokens", "number"],
    ["costs.days[].day", "string"],
    ["costs.days[].usdMicros", "number"],
    ["costs.days[].calls", "number"],
  ],

  // ---- M4 --------------------------------------------------------------
  // views/health.js healthScoreCard — the score is never rendered alone, so
  // the deduction fields ARE the contract.
  health: [
    ["id", "string"],
    ["health.score", "number"],
    ["health.band", "string"],
    ["health.summary", "string"],
    ["health.deductions", "array"],
    ["health.unknowns", "array"],
    ["health.deductions[].id", "string"],
    ["health.deductions[].points", "number"],
    ["health.deductions[].label", "string"],
    ["health.deductions[].detail", "string"],
    ["health.deductions[].screen", "string"],
  ],
  // views/health.js renderHealthBoard
  fleetHealth: [
    ["harnesses[].id", "string"],
    ["harnesses[].specName", "string"],
    ["harnesses[].health.score", "number"],
    ["harnesses[].health.band", "string"],
    ["harnesses[].health.deductions", "array"],
  ],
  // views/onboarding.js
  onboarding: [
    ["firstBoot", "boolean"],
    ["harnessCount", "number"],
    ["scanRootCount", "number"],
    ["suggestions", "array"],
    ["suggestions[].dir", "string"],
    ["suggestions[].exists", "boolean"],
    ["suggestions[].why", "string"],
    ["demo.available", "boolean"],
    ["demo.source", "string|null"],
    ["demo.starters", "array"],
    ["demo.reason", "string|null"],
    ["demo.remedy", "string|null"],
    ["completedAt", "string|null"],
    ["cliTwins", "object"],
  ],
  // omnibox.js omniRows
  search: [
    ["query", "string"],
    ["entries", "array"],
    ["actions", "array"],
    ["indexed", "number"],
    ["size", "number"],
    ["entries[].kind", "string"],
    ["entries[].id", "string"],
    ["entries[].title", "string"],
    ["entries[].subtitle", "string"],
    ["entries[].href", "string"],
    ["entries[].harnessId", "string|null"],
  ],
  // views/settings.js notificationCard + app.js nav badge
  notifications: [
    ["rules", "array"],
    ["rules[].kind", "string"],
    ["rules[].enabled", "boolean"],
    ["rules[].sinks", "array"],
    ["rules[].mutedGroups", "array"],
    ["quietHours.enabled", "boolean"],
    ["quietHours.startHour", "number"],
    ["quietHours.endHour", "number"],
    ["quietHours.utcOffsetMinutes", "number"],
    ["mutedGroups", "array"],
    ["webhookUrl", "string|null"],
    ["delivered", "array"],
    ["suppressed", "array"],
    ["inApp", "array"],
    ["badge", "number"],
  ],
  // views/settings.js readOnlyCard + app.js banner
  readOnly: [
    ["enabled", "boolean"],
    ["locked", "boolean"],
    ["exempt", "array"],
    ["note", "string"],
  ],
  // views/settings.js pluginCard
  plugins: [
    ["pluginsDir", "string"],
    ["plugins", "array"],
    ["wired", "array"],
    ["deferred", "object"],
  ],
  // views/panes.js paneCard
  pluginPane: [
    ["plugin", "string"],
    ["paneId", "string"],
    ["title", "string"],
    ["doc", "string"],
    ["sandbox", "string"],
    ["csp", "string"],
    ["truncated", "boolean"],
  ],
  // views/panes.js renderPanes
  panes: [
    ["id", "string"],
    ["panes", "array"],
    ["traceObservers", "array"],
    ["deferred", "object"],
  ],
};

// ---------------------------------------------------------------------------
// M3 — the read envelope, and the per-area target tables
// ---------------------------------------------------------------------------

/**
 * The three fields EVERY M3 read answers, whatever else it carries.
 *
 * They are not decoration: they are the arguments the console's empty state
 * already takes. `emptyState(message, verb)` renders "nothing yet" plus the
 * CLI verb that would create the data, and this surface is full of screens
 * whose normal state is empty — a harness with no datasets, no redteam runs,
 * no Thredz key, no compliance bundles. Without `present`/`note`/`verb` each
 * of those renders as either a blank panel or an error, and both are lies.
 *
 *   present  is there anything to show (on disk, or upstream)
 *   note     why it is empty, when it is  (null when it is not)
 *   verb     the CLI verb that creates it (null when there is none)
 */
const M3_READ_BASE: ReadonlyArray<readonly [string, string]> = [
  ["present", "boolean"],
  ["note", "string|null"],
  ["verb", "string|null"],
];

/** Compose the baseline with a route's own fields. */
function m3Read(
  ...extra: Array<readonly [string, string]>
): ReadonlyArray<readonly [string, string]> {
  return [...M3_READ_BASE, ...extra];
}

/**
 * TARGET shapes for the M3 reads, one section per implementer area.
 *
 * These are NOT enforced while a handler is a stub — the drive below accepts
 * a 501 and skips the check. They become enforced the instant a route
 * answers 2xx, which is exactly when they should. Each area's implementer
 * owns their own section: refine the `extra` fields as the payload firms up,
 * and add the ones their view actually dereferences. Keeping the sections
 * separate is deliberate — six people editing one table is a merge conflict,
 * six people editing six blocks is not.
 */
const M3_VIEW_READS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  // ---- M3 · spec (owner: the Spec implementer) --------------------------
  // `schemaSource` is load-bearing, not decoration: it says whether the
  // harness's OWN @crewhaus/spec answered or the manager's bundled copy did,
  // which is the difference between "your spec is wrong" and "this manager
  // is a version behind yours". `effective` is the declared-vs-defaulted
  // table — the viewer that replaces echoing raw YAML.
  specSchema: m3Read(
    ["specName", "string"],
    ["target", "string|null"],
    ["schemaSource", "string"],
    ["schemaVersion", "string|null"],
    ["effective", "array"],
    ["effectiveNote", "string|null"],
    ["declaredCount", "number"],
    ["defaultedCount", "number"],
    ["issues", "array"],
    ["warnings", "array"],
    ["warningsVerb", "string"],
    ["hash", "string"],
  ),
  // Every declared path, badged. The reason travels with the badge so the
  // editor never shows a lock without saying who holds the key.
  specTrust: m3Read(
    ["specName", "string"],
    ["target", "string|null"],
    ["paths", "array"],
    ["paths[].path", "string"],
    ["paths[].tier", "string"],
    ["paths[].securitySurface", "boolean"],
    ["paths[].reason", "string"],
    ["autoTunableCount", "number"],
    ["humanOwnedCount", "number"],
    ["confirmName", "string"],
  ),
  specVersions: m3Read(
    ["specName", "string"],
    ["registryName", "string"],
    ["dir", "string"],
    ["versions", "array"],
    ["pins", "object"],
    ["tenants", "array"],
    ["changelog", "string|null"],
    ["current", "object"],
    ["confirmName", "string"],
  ),
  specVersion: m3Read(
    ["version", "string"],
    ["yaml", "string|null"],
    ["provenance", "object|null"],
    ["isCurrent", "boolean"],
  ),
  specVersionDiff: m3Read(
    ["version", "string"],
    ["against", "string"],
    ["entries", "array"],
    ["diff", "string"],
  ),
  wizardTemplates: m3Read(
    ["templates", "array"],
    ["templates[].id", "string"],
    ["templates[].title", "string"],
    ["templates[].target", "string"],
    ["templates[].summary", "string"],
    ["templates[].scaffolds", "array"],
    ["templates[].fields", "array"],
    ["templates[].preview", "string"],
  ),
  mcpCatalog: m3Read(
    ["connectors", "array"],
    ["connectors[].id", "string"],
    ["connectors[].title", "string"],
    ["connectors[].transport", "string"],
    ["connectors[].summary", "string"],
  ),
  graderCatalog: m3Read(
    ["path", "string"],
    ["graders", "array"],
    ["yaml", "string|null"],
    ["hash", "string|null"],
    ["cardVerb", "string"],
  ),
  datasetBuilder: m3Read(["state", "string|null"], ["events", "array"]),
  // No field here may carry an env VALUE: `servers[].envRefs` is names +
  // presence, and the lint names the variable, never its contents.
  mcpConnectors: m3Read(
    ["specName", "string"],
    ["block", "string"],
    ["servers", "array"],
    ["findings", "array"],
    ["confirmName", "string"],
  ),

  // ---- M3 · memory (owner: the Memory implementer) ----------------------
  // The fabric's screens are mostly EMPTY in a young harness, so every field
  // here is present whatever is on disk. Three of them are the invariants
  // this area exists to keep visible and would be the first casualties of a
  // half-built handler: a fact's folded `status` + `provenance` (tombstones
  // and the session join), the wiki's `currentVersion` (the optimistic
  // concurrency token), and watchme's `unpriced` bucket (a measurement gap
  // that must never render as $0).
  memoryFacts: m3Read(
    ["specName", "string"],
    ["specs", "array"],
    ["counts", "object"],
    ["items", "array"],
    ["items[].status", "string"],
    ["items[].provenance", "object|null"],
    ["items[].expiresInMs", "number|null"],
    ["items[].supersededBy", "string|null"],
  ),
  continuity: m3Read(
    ["specName", "string"],
    ["focus", "object|null"],
    ["plans", "array"],
    ["goals", "array"],
    ["trash", "object"],
    ["degraded", "string|null"],
  ),
  continuityTrash: m3Read(["snapshots", "array"], ["purgeAfterDays", "number"]),
  learning: m3Read(
    ["declared", "boolean"],
    ["enabled", "boolean"],
    ["sources", "array"],
    ["study", "object"],
    ["gaps", "object"],
  ),
  knowledge: m3Read(
    ["share", "boolean"],
    ["sharedDir", "string|null"],
    ["candidates", "array"],
    ["counts", "object"],
    ["manifest", "array"],
  ),
  dreamScaffold: m3Read(
    ["declared", "boolean"],
    ["cadence", "string|null"],
    ["specs", "array"],
    ["overdue", "boolean"],
    ["cron", "string"],
    ["workflow", "string"],
  ),
  wikiVersions: m3Read(
    ["slug", "string"],
    ["versions", "array"],
    ["currentVersion", "number|null"],
  ),
  wikiVersion: m3Read(
    ["slug", "string"],
    ["version", "string"],
    ["body", "string"],
    ["diff", "string"],
    ["currentVersion", "number|null"],
  ),
  wikiLinks: m3Read(
    ["slug", "string"],
    ["links", "array"],
    ["outbound", "number"],
    ["backlinks", "number"],
    ["indexStale", "boolean"],
  ),
  wikiReflect: m3Read(
    ["articles", "array"],
    ["total", "number"],
    ["stale", "number"],
    ["filters", "object"],
    ["thresholdSource", "string"],
    ["sourcesGate", "boolean"],
  ),
  watchmeAnalytics: m3Read(
    ["watching", "boolean"],
    ["sessions", "number"],
    ["models", "array"],
    ["unpriced", "object"],
    ["tools", "array"],
    ["observedFeedback", "object"],
    ["judgments", "object"],
    ["asOf", "string|null"],
  ),
  watchmeReports: m3Read(["reports", "array"]),
  watchmeReport: m3Read(
    ["stamp", "string"],
    ["body", "string"],
    ["summary", "string|null"],
    ["files", "array"],
  ),
  watchmeIntents: m3Read(["intents", "array"]),
  watchmeSynthesized: m3Read(["proposals", "array"], ["advisory", "boolean"]),

  // ---- M3 · evals + data + feedback (owner: the Evals+Data implementer) -
  // Every field below is present WHATEVER the harness holds — the normal
  // state of most of these screens is "nothing yet", and the fields that
  // explain an empty screen (the classified crash, the join's reason, the
  // sessionKey caveat, the dataset-precedence shadow) are exactly the ones a
  // stub would have quietly dropped.
  evalMatrix: m3Read(["cells", "array"], ["roots", "array"]),
  evalMatrixCell: m3Read(["cell", "string"]),
  evalSuites: m3Read(["suites", "array"]),
  evalTrends: m3Read(
    ["series", "array"],
    // agent vs judge spend stay SEPARATE: one blended number hides which of
    // the two an operator would actually cut.
    ["spend.agentUsd", "number"],
    ["spend.judgeUsd", "number"],
  ),
  judgeCalibration: m3Read(["specs", "array"]),
  graderCards: m3Read(["graders", "array"], ["instrumentCount", "number"]),
  redteam: m3Read(["runs", "array"], ["dataset", "object|null"]),
  evalCoverage: m3Read(["gaps", "array"], ["handoff", "string"]),
  sentinel: m3Read(["baseline", "object|null"], ["attribution", "object|null"]),
  voiceEvals: m3Read(["applicable", "boolean"], ["target", "string"]),
  optimizer: m3Read(["runs", "array"], ["acceptance", "string"]),
  optimizerArtifacts: m3Read(["optRunId", "string"], ["files", "array"]),
  flywheel: m3Read(
    ["workflows", "array"],
    ["datasetPrecedence.shadowing", "boolean"],
    ["datasetPrecedence.note", "string"],
  ),
  experiments: m3Read(["experiments", "array"], ["boundary", "string"]),
  // F-7 is reported, never faked: how many annotations exist, how many the
  // (sessionId, turnNumber) join can reach, and what would fix the rest.
  annotations: m3Read(
    ["annotations", "array"],
    ["join.total", "number"],
    ["join.resolvable", "number"],
    ["join.reason", "string"],
    ["join.upstreamFix", "string"],
  ),
  datasets: m3Read(["datasets", "array"], ["root", "string"]),
  dataset: m3Read(["name", "string"], ["versions", "array"], ["autoMaintained", "string|null"]),
  datasetStatus: m3Read(["datasets", "array"]),
  datasetQuarantine: m3Read(["entries", "array"], ["files", "array"]),
  feedback: m3Read(
    ["items", "array"],
    // The watermark and the unprocessed count travel together — "N new
    // ratings" without the timestamp it counts from is a guess.
    ["watermark.present", "boolean"],
    ["watermark.unprocessed", "number"],
    ["balance.total", "number"],
  ),
  fewshot: m3Read(["entries", "array"], ["poolForSpec", "string"]),
  faq: m3Read(["files", "array"], ["path", "string"]),
  lessons: m3Read(["preferences", "array"]),
  advice: m3Read(["proposals", "array"], ["advisory", "boolean"]),
  reactions: m3Read(
    ["reactions", "array"],
    ["declared", "boolean"],
    ["collecting", "boolean"],
    // `sessionKeyMode`, not `sessionKey`: the dispatch site's credential
    // masker redacts any `*Key` property, and this one carries a routing
    // mode ("thread" / "channel" / "user"), never a secret.
    ["sessionKeyMode", "string|null"],
    ["caveat", "string|null"],
  ),
  feedbackFleet: m3Read(["harnesses", "array"], ["scope", "string"]),

  // ---- M3 · creds + channels + security (owner: that implementer) -------
  // Credential reads answer PRESENCE only; there is no field here that
  // could ever hold a value, and there must never be one. Note what is
  // ABSENT from every row: no `key` field. `maskDeep` redacts anything under
  // a key literally named `key`, so a credential NAME served under that
  // field would come back `[redacted]` — the grid columns are `name`.
  //
  // Every array below is asserted as an array, never with a `[]` element
  // path: the shared fixture's `agent.model` sits outside the model-router
  // grammar (see `fixture.ts`), so the credential-derived arrays are
  // legitimately EMPTY here. The populated shapes are covered against a
  // fixture this area controls in `creds-channels-security.test.ts`.
  env: m3Read(
    ["keys", "array"],
    ["ambient", "array"],
    ["counts", "object"],
    ["files", "array"],
    ["editTarget", "string"],
    ["anthropic", "object"],
    ["orphanStubs", "array"],
  ),
  credentialsMatrix: m3Read(
    ["harnesses", "array"],
    ["keys", "array"],
    ["asOf", "string"],
    ["valuesNote", "string"],
  ),
  doctor: m3Read(
    ["checks", "array"],
    ["counts", "object"],
    ["anthropic", "object"],
    ["lastRun", "object|null"],
    ["probeNote", "string"],
    ["fixNote", "string"],
  ),
  secrets: m3Read(["names", "array"], ["backend", "string"], ["looseModes", "array"]),
  secretsDoctor: m3Read(
    ["backend", "string"],
    ["reachable", "boolean"],
    ["stored", "array"],
    ["unresolved", "array"],
  ),
  mcpLint: m3Read(["findings", "array"], ["servers", "array"], ["counts", "object"]),
  channels: m3Read(
    ["channels", "array"],
    ["routing", "object"],
    ["heartbeat", "object"],
    ["liveChannels", "array|null"],
    ["statusSource", "string"],
    ["statusReason", "string|null"],
    ["compileErrors", "array"],
    ["target", "string"],
  ),
  channelProvision: m3Read(
    ["platform", "string"],
    ["plan", "object"],
    ["baseUrl", "string"],
    ["baseUrlSupplied", "boolean"],
    ["executes", "boolean"],
  ),
  gateway: m3Read(
    ["declared", "boolean"],
    ["port", "number|null"],
    ["ui", "boolean"],
    ["status", "object|null"],
    ["statusReason", "string|null"],
    ["channels", "array"],
    ["dashboardUrl", "string|null"],
  ),
  audit: m3Read(
    ["records", "array"],
    ["kinds", "array"],
    ["truncated", "boolean"],
    ["tornLines", "number"],
    ["encryption", "object"],
    ["rawFilesNote", "string"],
  ),
  egress: m3Read(
    ["decisions", "array"],
    ["open", "number"],
    ["payloadNote", "string"],
    ["truncated", "boolean"],
  ),
  pii: m3Read(
    ["policy", "object|null"],
    ["allowEntries", "number"],
    ["hitCounts", "null"],
    ["hitCountsNote", "string"],
    ["valuesNote", "string"],
  ),
  justification: m3Read(
    ["config", "object|null"],
    ["records", "array"],
    ["byTool", "array"],
    ["linkNote", "string"],
  ),
  securityCorpus: m3Read(
    ["cases", "number"],
    ["candidateRules", "number"],
    ["builtAt", "string|null"],
    ["lastCheck", "object|null"],
    ["payloadNote", "string"],
  ),
  sandboxDoctor: m3Read(
    ["declared", "boolean"],
    ["backends", "array"],
    ["wouldHappen", "string"],
    ["probeNote", "string"],
  ),
  onchain: m3Read(
    ["shapeGated", "boolean"],
    ["target", "string"],
    ["transactionPolicy", "object|null"],
    ["approvalMode", "string|null"],
    ["receipts", "array"],
    ["keyNote", "string"],
  ),
  onchainSentinel: m3Read(
    ["watches", "object"],
    ["baselines", "array"],
    ["receipts", "number"],
    ["note", "string"],
  ),
  compliance: m3Read(["bundles", "array"], ["frameworks", "array"], ["retireNote", "string"]),
  retention: m3Read(
    ["pins", "array"],
    ["malformed", "boolean"],
    ["fromFile", "boolean"],
    ["sessionMaxAgeDays", "number|null"],
    ["auditWindows", "array"],
    ["auditChainNote", "string"],
  ),
  slo: m3Read(
    ["declared", "boolean"],
    ["targets", "array"],
    ["windowSeconds", "number"],
    ["ladder", "array"],
    ["ladderState", "string"],
    ["alerts", "array"],
    ["mitigations", "array"],
    ["sessions", "number"],
    ["observedAt", "string|null"],
    ["exporters", "object"],
  ),

  // ---- M3 · thredz (owner: the Thredz implementer) ----------------------
  // No field here may ever hold key material: the proxy reads the key
  // server-side and the browser never sees one. `keyPresent` is a BOOLEAN and
  // `keySource` a provenance label for exactly that reason — there is no
  // field on this surface that could carry a value, and there must never be.
  //
  // Every read additionally carries the proxy envelope the views branch on:
  // `ok` (did the workspace answer), `upstream` (the typed refusal, with the
  // UPSTREAM status and its verbatim message), `backend` (local vs thredz),
  // `workspace`, and `fetchedAt` for the as-of chip.
  thredzStatus: m3Read(
    ["ok", "boolean"],
    ["backend", "string"],
    ["keyPresent", "boolean"],
    ["keySource", "string|null"],
    ["workspace", "string"],
    ["defaultVisibility", "string"],
    ["fetchedAt", "string"],
    ["upstream", "object|null"],
    ["spec", "object"],
    ["reachable", "boolean|null"],
    ["tier", "string|null"],
    ["probes", "array"],
  ),
  thredzWiki: m3Read(
    ["articles", "array"],
    ["ok", "boolean"],
    ["mode", "string"],
    ["fetchedAt", "string"],
    ["upstream", "object|null"],
  ),
  thredzWikiArticle: m3Read(
    ["ok", "boolean"],
    ["slug", "string"],
    ["article", "object|null"],
    ["backlinks", "array"],
    ["comments", "array"],
    ["related", "array"],
    ["fetchedAt", "string"],
  ),
  thredzWikiVersions: m3Read(
    ["versions", "array"],
    ["ok", "boolean"],
    ["slug", "string"],
    ["fetchedAt", "string"],
  ),
  thredzRecords: m3Read(
    ["records", "array"],
    ["ok", "boolean"],
    ["softDeleted", "number"],
    ["fetchedAt", "string"],
  ),
  thredzRecord: m3Read(
    ["ok", "boolean"],
    ["recordId", "string"],
    ["record", "object|null"],
    ["history", "array"],
    ["softDeleted", "boolean"],
  ),
  thredzSchemas: m3Read(["schemas", "array"], ["ok", "boolean"], ["fetchedAt", "string"]),
  thredzGoals: m3Read(
    ["goals", "array"],
    ["ok", "boolean"],
    ["mirrored", "boolean"],
    // Goal filters are SINGULAR — the array form is card grammar only. The
    // field is `filterParam`, not `filterKey`, because `maskDeep` redacts
    // every field whose NAME ends in `Key`.
    ["filterParam", "string"],
  ),
  thredzTasks: m3Read(
    ["tasks", "array"],
    ["ok", "boolean"],
    ["studyQueue", "number"],
    ["filterParam", "string"],
  ),
  thredzViews: m3Read(["views", "array"], ["ok", "boolean"], ["filterKeys", "object"]),
  thredzDashboards: m3Read(
    ["dashboards", "array"],
    ["ok", "boolean"],
    ["cardGrammar", "object"],
    ["cardGrammar.cardTypes", "array"],
    ["cardGrammar.kpiRequires", "array"],
    ["filterKeys", "object"],
  ),
  thredzDashboard: m3Read(
    ["ok", "boolean"],
    ["dashboardId", "string"],
    ["dashboard", "object|null"],
    ["cards", "array"],
    ["dataResolved", "boolean"],
    ["dataError", "string|null"],
  ),
  thredzListeners: m3Read(
    ["listeners", "array"],
    ["ok", "boolean"],
    ["quota", "object|null"],
    ["quotaLocked", "boolean"],
    ["events", "array"],
  ),
  thredzWebhooks: m3Read(
    ["webhooks", "array"],
    ["ok", "boolean"],
    ["deliveries", "array"],
    ["failedDeliveries", "number"],
  ),
  thredzConnectors: m3Read(["connectors", "array"], ["ok", "boolean"], ["fetchedAt", "string"]),
  thredzActivity: m3Read(
    ["items", "array"],
    ["ok", "boolean"],
    ["fetchedAt", "string"],
    // The wiki's separate audit log rides with the feed — the frozen map has
    // no route of its own for it.
    ["wikiAudit", "array"],
  ),
  thredzKeys: m3Read(
    ["keys", "array"],
    ["ok", "boolean"],
    ["grants", "array"],
    ["tier", "string|null"],
  ),
  thredzGlobal: m3Read(
    ["ok", "boolean"],
    ["harnesses", "array"],
    ["wired", "number"],
    ["keyPresent", "boolean"],
    ["reachable", "boolean|null"],
    ["counts", "object|null"],
  ),

  // ---- M3 · inspect + runtime (owner: that implementer) -----------------
  // The exclusions are DATA, not a UI decision: `excluded[]` is what makes
  // `secrets/`, the raw audit files and `.env*` read as a policy rather than
  // as a gap, and `unmodelled` is what keeps "inspect ALL captured data"
  // honest about the stores this manager version has no rich view for.
  inspectIndex: m3Read(
    ["root", "string"],
    ["stores", "array"],
    ["stores[].store", "string"],
    ["stores[].kind", "string"],
    ["stores[].path", "string"],
    ["stores[].present", "boolean"],
    ["stores[].entries", "number|null"],
    ["stores[].what", "string"],
    ["stores[].verb", "string|null"],
    ["excluded", "array"],
    ["excluded[].path", "string"],
    ["excluded[].reason", "string"],
    ["excluded[].where", "string"],
    ["unmodelled", "array"],
  ),
  inspectStore: m3Read(
    ["store", "string"],
    ["kind", "string"],
    ["path", "string"],
    ["entries", "array"],
    ["truncated", "boolean"],
    ["document", "object|array|null"],
    ["text", "string|null"],
    ["parseError", "string|null"],
  ),
  inspectEntry: m3Read(
    ["store", "string"],
    ["name", "string"],
    ["path", "string"],
    ["files", "array"],
    ["document", "object|array|null"],
    ["text", "string|null"],
    ["truncated", "boolean"],
  ),
  inspectRaw: m3Read(
    ["path", "string"],
    ["kind", "string|null"],
    ["modelled", "string|null"],
    ["modelledNote", "string"],
    ["entries", "array"],
    ["document", "object|array|null"],
    ["text", "string|null"],
    ["truncated", "boolean"],
  ),
  // Both runtime reads carry `supervision`, which is how the console knows
  // whether Stop is a button or a disabled control with a reason.
  mcpServers: m3Read(
    ["target", "string"],
    ["projection", "string"],
    ["projectionNote", "string"],
    ["running", "boolean"],
    ["runId", "string|null"],
    ["transport", "string|null"],
    ["port", "number|null"],
    ["health.checked", "boolean"],
    ["health.note", "string"],
    ["runs", "array"],
    ["ledger", "array"],
    ["supervision.stoppable", "boolean"],
    ["supervision.reason", "string|null"],
    ["cliTwin", "string|null"],
  ),
  dev: m3Read(
    ["running", "boolean"],
    ["mode", "string|null"],
    ["runId", "string|null"],
    ["watching", "array"],
    ["cwd", "string"],
    ["cwdNote", "string"],
    ["stateRoots", "array"],
    ["stateRoots[].name", "string"],
    ["stateRoots[].anchored", "boolean"],
    ["lastCompile", "object|null"],
    ["blocked", "boolean"],
    ["blockedReason", "string|null"],
    ["runs", "array"],
    ["supervision.stoppable", "boolean"],
    ["cliTwin", "string|null"],
  ),
};

/** Every read table, M1/M2 and M3 alike. */
const ALL_VIEW_READS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  ...VIEW_READS,
  ...M3_VIEW_READS,
};

/**
 * A value for every `:param` the M3 templates use, chosen to satisfy the
 * dispatcher's guards so the drive reaches the handler and sees its 501
 * rather than a 400.
 */
const M3_PARAMS: Record<string, string> = {
  runId: "run_00000000000000aa",
  optRunId: "run_00000000000000aa",
  sampleId: "s1",
  version: "1.0.0",
  name: "smoke",
  spec: "contract-harness",
  slug: "how-to-deploy",
  stamp: "20260803T000000Z",
  cell: "m-alpha",
  adviceId: "adv_1",
  key: "CONTRACT_VAR",
  channel: "slack",
  decisionId: "egr_1",
  recordId: "rec_1",
  taskId: "task_1",
  viewId: "view_1",
  dashboardId: "dash_1",
  keyId: "key_1",
  store: "settings",
};

/**
 * Request bodies for the M3 writes. They document each write's shape (which
 * is what a stub cannot), and they are what the drive will send the day the
 * handler is real — so a body key an implementer decides to require lands
 * here rather than being discovered in the browser.
 */
const M3_BODIES: Record<string, unknown> = {
  specEdit: { edits: [], confirmName: "contract-harness" },
  specPatch: { edit: { path: "agent.instructions", value: "be concise" } },
  specDiff: { edits: [] },
  specPin: { env: "prod", version: "1.0.0", confirmName: "contract-harness" },
  specRollback: { env: "prod", version: "1.0.0", confirmName: "contract-harness" },
  specPropose: { edits: [], title: "tune instructions" },
  wizardCreate: { dir: "/nonexistent", template: "cli", answers: {} },
  graderWrite: { graders: [] },
  datasetBuilderStep: { event: "start" },
  mcpConnectorWrite: { name: "files", command: "bunx", args: [] },
  memoryForget: { factId: "mem_0000000000000001", reason: "superseded by policy", confirm: true },
  memorySweep: { dryRun: true },
  memoryRecall: { query: "what is the deploy step" },
  memoryMigrate: { dryRun: true },
  continuityRestore: { stamp: "20260803T000000Z", confirm: true },
  knowledgeSync: { direction: "pull", dryRun: true },
  wikiWrite: { body: "# Deploy\nsteps\n", expectedVersion: 1 },
  wikiSignals: { verified: true },
  wikiArchive: { archived: true, confirm: true },
  watchmeToggle: { watching: false, confirm: true },
  watchmeApply: { edits: [], confirm: true },
  watchmePublish: { dryRun: true },
  evalLaunch: { dataset: "smoke" },
  evalSuiteRun: { suite: "eval/suite.yaml", tier: "fast" },
  evalPlan: { targetDelta: 0.05 },
  judgeCalibrate: {},
  gradersSuggest: {},
  gradersTest: { golden: true },
  redteamGenerate: {},
  sentinelRun: {},
  optimizerRun: { mutator: "rule-based" },
  flywheelRun: {},
  experimentRecord: { action: "record", name: "exp1", variant: "a" },
  annotateSample: { verdict: "fail", note: "missed the constraint" },
  datasetVerify: { name: "smoke" },
  datasetAudit: {},
  datasetLint: {},
  datasetMine: { name: "smoke", dryRun: true },
  datasetSynthesize: { name: "smoke", dryRun: true },
  datasetRefreshGoldens: { name: "smoke", dryRun: true },
  distillRun: {},
  fewshotHarvest: {},
  faqDistill: {},
  lessonsUpdate: {},
  adviceRun: {},
  adviceApply: { confirm: true },
  // A NAME and a placeholder — never a realistic credential literal. The
  // repo's push protection rejects those in fixtures, and rightly.
  envSet: { key: "CONTRACT_VAR", value: "placeholder-not-a-credential" },
  credentialsSetAcross: {
    key: "CONTRACT_VAR",
    value: "placeholder-not-a-credential",
    harnessIds: [],
    confirmName: "contract-harness",
  },
  doctorRun: {},
  secretsRotate: { value: "placeholder-not-a-credential", confirmName: "contract-harness" },
  channelVerify: { offline: true },
  channelProvisionRun: { confirm: true },
  channelProbe: {},
  channelSynthetic: { confirm: true },
  auditVerify: {},
  egressReview: { verdict: "allow" },
  piiTune: { policy: {}, dryRun: true },
  justificationCalibrate: {},
  justificationPreflight: { tool: "Fetch" },
  securityCorpusCheck: {},
  onchainTune: { policy: {}, dryRun: true },
  complianceEvidence: { framework: "soc2" },
  retentionSweep: { dryRun: true },
  retentionPurge: { dryRun: true },
  thredzWikiWrite: { body: "# Deploy\n", expectedVersion: 1, visibility: "private" },
  thredzWikiRollback: { version: 1, confirm: true },
  thredzRecordCreate: { schema: "note", fields: {} },
  thredzRecordRestore: {},
  thredzTaskUpdate: { status: "done" },
  thredzViewExecute: { params: {} },
  thredzCardCreate: { title: "KPI", display: { aggregation: "sum", aggregationField: "amount" } },
  thredzListenerCreate: { event: "record.created" },
  thredzTraverse: { start: "rec_1", depth: 1 },
  thredzKeyCreate: { label: "hangar" },
  thredzKeyRotate: { confirm: true },
  settingsWrite: { settings: {}, confirmName: "contract-harness" },
  mcpServerStart: { transport: "stdio" },
  mcpServerStop: {},
  devStart: { checkOnly: true },
  devStop: {},
};

// ---------------------------------------------------------------------------
// field checker
// ---------------------------------------------------------------------------

function valuesAt(routeKey: string, payload: unknown, path: string): unknown[] {
  let current: unknown[] = [payload];
  for (const seg of path.split(".")) {
    const isArray = seg.endsWith("[]");
    const key = isArray ? seg.slice(0, -2) : seg;
    const next: unknown[] = [];
    for (const value of current) {
      const v =
        key === ""
          ? value
          : typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)[key]
            : undefined;
      if (isArray) {
        if (!Array.isArray(v)) {
          throw new Error(`${routeKey} ${path}: expected an array at "${seg}", got ${typeof v}`);
        }
        if (v.length === 0) {
          throw new Error(`${routeKey} ${path}: fixture produced an EMPTY array at "${seg}"`);
        }
        next.push(...v);
      } else {
        next.push(v);
      }
    }
    current = next;
  }
  return current;
}

function typeOk(expected: string, v: unknown): boolean {
  return expected.split("|").some((t) => {
    switch (t) {
      case "null":
        return v === null;
      case "array":
        return Array.isArray(v);
      case "object":
        return typeof v === "object" && v !== null && !Array.isArray(v);
      case "string":
        return typeof v === "string";
      case "number":
        return typeof v === "number";
      case "boolean":
        return typeof v === "boolean";
      default:
        throw new Error(`unknown VIEW_READS type "${t}"`);
    }
  });
}

function assertViewReads(routeKey: string, payload: unknown): void {
  const table = ALL_VIEW_READS[routeKey];
  if (table === undefined) throw new Error(`no VIEW_READS table for read route "${routeKey}"`);
  for (const [path, type] of table) {
    for (const v of valuesAt(routeKey, payload, path)) {
      if (!typeOk(type, v)) {
        throw new Error(
          `${routeKey} ${path}: view reads ${type}, server sent ${JSON.stringify(v)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// fixture — every store the routes read, populated so no VIEW_READS array
// comes back empty
// ---------------------------------------------------------------------------

/** A run id the fixture seeds captured artifacts for. */
const SEEDED_RUN = "run_00000000000000bb";

function contractHarness(t: TestServer): string {
  return makeFixtureHarness(join(t.harnessesRoot, "contract"), {
    specName: "contract-harness",
    specExtra: [
      "memory:",
      "  recall: true",
      "  dream:",
      "    every: 24h",
      "heartbeat:",
      "  every: 60s",
      "  instructions: check in",
      "schedule:",
      "  kind: cron",
      '  cron: "0 */6 * * *"',
      "budget:",
      "  usd: 10",
      "notify_env: $CONTRACT_VAR",
    ].join("\n"),
    // A compiled bundle, F-5-stamped with a hash that does NOT match the
    // spec above — so the freshness verdict is the EXACT "stale" answer
    // rather than the approximate mtime one.
    bundle: { entry: "agent.ts", specHash: `sha256:${"0".repeat(64)}`, compiledWith: "0.5.0" },
    runLedger: [
      {
        runId: SEEDED_RUN,
        kind: "daemon",
        argv: ["bun", "dist/daemon.ts"],
        startedAt: iso(NOW - DAY),
        logFile: `logs/${SEEDED_RUN}.log`,
      },
      { runId: SEEDED_RUN, endedAt: iso(NOW - DAY + 1000), exitCode: 0 },
    ],
    runLogs: [
      {
        runId: SEEDED_RUN,
        log: "booting\n[control] crewhaus.control.v1 listening on http://127.0.0.1:41234 (token: .crewhaus/run/control-token)\ndone\n",
        events: [{ kind: "run_started", runId: SEEDED_RUN, sessionId: "sess_00000000000000aa" }],
      },
    ],
    approvals: [
      {
        id: "appr_00000000000000a1",
        toolName: "SendMessage",
        inputHash: "h1",
        input: { channel: "ops", text: "ship it" },
        runId: SEEDED_RUN,
        sessionId: "sess_00000000000000aa",
        surface: "daemon",
        createdAt: iso(NOW - DAY),
      },
      {
        id: "appr_00000000000000a2",
        toolName: "Fetch",
        inputHash: "h2",
        input: { url: "https://example.invalid/x" },
        runId: SEEDED_RUN,
        sessionId: "sess_00000000000000aa",
        surface: "daemon",
        createdAt: iso(NOW - DAY),
      },
    ],
    reviewQueue: [
      {
        schemaVersion: 1,
        id: "rev_quarantine_smoke_s1",
        kind: "quarantine",
        sourceRef: { dataset: "smoke", sampleId: "s1" },
        ts: iso(NOW - DAY),
        status: "open",
        context: "[low-confidence] a hard case",
      },
    ],
    deployments: {
      deployments: [{ env: "prod", version: "1.2.3", at: iso(NOW - DAY), provider: "fly" }],
    },
    incidents: ["2026-08-02-crash"],
    specChangelogs: { "contract-harness": "# Changelog\n- 1.0.0\n" },
    envLines: ["CONTRACT_VAR=set-in-harness-env"],
    sessions: [
      {
        id: "sess_00000000000000aa",
        updatedAt: iso(NOW - DAY),
        lastTurnIndex: 2,
        log: [
          logLine("user_message", { content: "what's the weather" }, iso(NOW - DAY)),
          logLine(
            "assistant_message",
            {
              content: [
                { type: "text", text: "checking now" },
                { type: "tool_use", id: "tu_1", name: "search", input: { q: "weather" } },
              ],
            },
            iso(NOW - DAY),
          ),
          logLine(
            "user_message",
            { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "sunny" }] },
            iso(NOW - DAY),
          ),
          logLine(
            "cost_accrual",
            {
              provider: "anthropic",
              modelId: "m-alpha",
              costUsdMicros: 1500,
              inputTokens: 10,
              outputTokens: 5,
            },
            iso(NOW - DAY),
          ),
        ],
      },
    ],
    memories: {
      "contract-harness": [
        {
          id: "mem_0000000000000001",
          text: "a live fact",
          tags: ["contract"],
          createdAt: iso(NOW - DAY),
        },
        {
          id: "mem_0000000000000002",
          text: "an old fact",
          tags: [],
          createdAt: iso(NOW - 2 * DAY),
        },
        { tombstone: "superseded", target: "mem_0000000000000002", at: iso(NOW - DAY) },
      ],
    },
    wikiIndex: { "how-to-deploy": { title: "How to deploy", tags: ["ops"] } },
    wikiArticles: { "how-to-deploy": "# Deploy\nsteps\n" },
    focus: "current focus\n",
    goals: "- id: g1\n  title: ship\n",
    dreamState: { "contract-harness": { lastRunAt: iso(NOW - DAY) } },
    watchmeState: { schemaVersion: 1, watching: true },
    watchmeObservations: [{ sessionId: "sess_00000000000000aa", digest: "d1" }],
    evalIndex: [
      {
        runId: "run_00000000000000aa",
        specName: "contract-harness",
        specHash: "h",
        datasetName: "smoke",
        datasetHash: "d",
        passRate: 0.5,
        meanScore: 0.5,
        sampleCount: 1,
        ts: iso(NOW - DAY),
        outDir: "/gone",
      },
    ],
    baselines: {
      "contract-harness::smoke": {
        specName: "contract-harness",
        datasetName: "smoke",
        runId: "run_00000000000000aa",
        outDir: "/gone",
        datasetHash: "d",
        ts: iso(NOW - DAY),
      },
    },
    evalRuns: [
      {
        runId: "run_00000000000000aa",
        results: { passRate: 0.5, sampleCount: 1, results: [{ sampleId: "s1", pass: false }] },
        samples: {
          s1: {
            grades: { pass: false, rationale: "missed" },
            meta: { latencyMs: 9 },
            transcript: [{ kind: "user_message", payload: { content: "q" } }],
          },
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// the drive
// ---------------------------------------------------------------------------

describe("UI route contract", () => {
  test("every route in the console's map answers with what its view reads (and writes take effect)", async () => {
    const ROUTES = await loadRoutes();
    // The plugin fixture lives beside the workspace the server creates, so
    // it is written after boot and picked up on the first read (discovery is
    // per-request — nothing is cached at boot).
    const pluginsDir = mkdtempSync(join(tmpdir(), "hangar-contract-plugins-"));
    const t = bootTestServer({
      now: () => NOW,
      pluginsDir,
      // `doctor` runs to completion (so the ledger has a terminal job);
      // anything else parks, so the queue also has a live one.
      runJob: (job) =>
        job.kind === "doctor"
          ? Promise.resolve({ exitCode: 0 })
          : new Promise<{ exitCode?: number }>(() => {}),
    });
    const driven = new Set<string>();
    try {
      const dir = contractHarness(t);
      const fill = (template: string, params: Record<string, string>): string =>
        template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_m, name: string) => {
          const v = params[name];
          if (v === undefined) throw new Error(`missing param ${name} for ${template}`);
          return encodeURIComponent(v);
        });
      const drive = async (
        key: string,
        params: Record<string, string> = {},
        opts: { body?: unknown; query?: string; expectStatus?: number; readsKey?: string } = {},
      ): Promise<Record<string, unknown>> => {
        const route = ROUTES[key];
        if (route === undefined) throw new Error(`route "${key}" missing from routes.js`);
        driven.add(key);
        const { status, body } = await t.api(`${fill(route.path, params)}${opts.query ?? ""}`, {
          method: route.method,
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        });
        if (status !== (opts.expectStatus ?? 200)) {
          throw new Error(
            `${key} ${route.method} ${route.path}: expected ${opts.expectStatus ?? 200}, got ${status} ${JSON.stringify(body)}`,
          );
        }
        if (opts.readsKey !== undefined) assertViewReads(opts.readsKey, body);
        return body;
      };

      /** Drive a `stream: "sse"` route: the body is text/event-stream, so
       *  it is read as TEXT and asserted on its frame grammar. */
      const driveSse = async (key: string, params: Record<string, string>): Promise<string> => {
        const route = ROUTES[key];
        if (route === undefined) throw new Error(`route "${key}" missing from routes.js`);
        if (route.stream !== "sse") throw new Error(`route "${key}" is not marked stream:"sse"`);
        driven.add(key);
        const { status, text } = await t.apiText(fill(route.path, params), {
          method: route.method,
        });
        if (status !== 200) throw new Error(`${key}: expected 200, got ${status}`);
        return text;
      };

      // -- registration (write + effect) ----------------------------------
      const added = await drive("addHarness", {}, { body: { dir }, expectStatus: 201 });
      const id = (added["entry"] as { id: string }).id;
      const feed = await drive("harnesses", {}, { readsKey: "harnesses:cold" });
      expect((feed["harnesses"] as Array<{ dir: string }>).some((r) => r.dir === dir)).toBe(true);

      // -- fleet feed: cold first paint, then hydrate ----------------------
      await drive("harnesses", {}, { query: "?hydrate=1", readsKey: "harnesses" });

      // -- per-harness reads -----------------------------------------------
      await drive("version", {}, { readsKey: "version" });
      await drive("harness", { id }, { readsKey: "harness" });
      await drive("spec", { id }, { readsKey: "spec" });
      await drive("preflight", { id }, { readsKey: "preflight" });
      await drive("sessions", { id }, { readsKey: "sessions" });
      await drive("session", { id, sess: "sess_00000000000000aa" }, { readsKey: "session" });
      await drive("evals", { id }, { readsKey: "evals" });
      await drive("evalRun", { id, runId: "run_00000000000000aa" }, { readsKey: "evalRun" });
      await drive(
        "evalSample",
        { id, runId: "run_00000000000000aa", sampleId: "s1" },
        { readsKey: "evalSample" },
      );
      for (const area of ["facts", "wiki", "state", "dream", "watchme"]) {
        await drive("memory", { id, area }, { readsKey: `memory:${area}` });
      }
      await drive("wikiArticle", { id, slug: "how-to-deploy" }, { readsKey: "wikiArticle" });
      await drive("costs", { id }, { readsKey: "costs" });

      // -- registry writes: each 2xx + effect visible on re-read -----------
      await drive("setPin", { id }, { body: { pinned: true } });
      await drive("setTags", { id }, { body: { tags: ["blue", "canary"] } });
      await drive("setNotes", { id }, { body: { notes: "contract note" } });

      const groupBody = await drive("addGroup", {}, { body: { name: "prod" }, expectStatus: 201 });
      expect((groupBody["group"] as { name: string }).name).toBe("prod");
      const groups = await drive("groups", {});
      expect((groups["groups"] as Array<{ name: string }>).map((g) => g.name)).toContain("prod");

      await drive("setGroups", { id }, { body: { groups: ["prod"] } });
      const afterWrites = (await t.api(`/api/h/${id}`)).body["entry"] as Record<string, unknown>;
      expect(afterWrites["pinned"]).toBe(true);
      expect(afterWrites["tags"]).toEqual(["blue", "canary"]);
      expect(afterWrites["notes"]).toBe("contract note");
      expect(afterWrites["groups"]).toEqual(["prod"]);

      // -- M2 reads ---------------------------------------------------------
      const proc0 = await drive("proc", { id }, { readsKey: "proc" });
      expect(proc0["state"]).toBe("stopped");
      // The F-5 stamp is present and does NOT match the spec, so the answer
      // is the EXACT one — never the mtime approximation.
      expect(
        (proc0["bundle"] as { freshness: { state: string; exact: boolean } }).freshness,
      ).toMatchObject({ state: "stale", exact: true });
      const runsBody = await drive("runs", { id }, { readsKey: "runs" });
      expect((runsBody["runs"] as Array<{ runId: string }>)[0]?.runId).toBe(SEEDED_RUN);
      const runBody = await drive("run", { id, runId: SEEDED_RUN }, { readsKey: "run" });
      expect(runBody["live"]).toBe(false);
      await drive("schedulers", { id }, { readsKey: "schedulers" });
      await drive("deployments", { id }, { readsKey: "deployments" });
      await drive("approvals", {}, { query: "?all=1", readsKey: "approvals" });
      await drive("review", {}, { readsKey: "review" });
      await drive("activity", {}, { query: "?since=30d", readsKey: "activity" });

      // A closed run's stream replays its durable history and terminates.
      const sse = await driveSse("runEvents", { id, runId: SEEDED_RUN });
      expect(sse).toContain("event: replay");
      expect(sse.trimEnd().endsWith("}")).toBe(true);
      expect(sse).toContain("event: done");

      // -- M2 process control (write + observable state change) -------------
      const started = await drive("procStart", { id }, { body: {} });
      expect(started["ok"]).toBe(true);
      expect(((await drive("proc", { id })) as { state: string }).state).toBe("running");
      await drive("procRestart", { id }, { body: { force: true } });
      expect(((await drive("proc", { id })) as { state: string }).state).toBe("running");
      // Drain with no control plane degrades to the signal path, honestly.
      const drained = await drive("procDrain", { id }, { body: {} });
      expect(drained["viaSignal"]).toBe(true);
      await drive("procStart", { id }, { body: {} });
      const stopped = await drive("procStop", { id }, { body: {} });
      expect(stopped["stopped"]).toBe(true);
      expect(((await drive("proc", { id })) as { state: string }).state).toBe("stopped");

      // -- M2 control.v1 proxy: no port ⇒ typed unavailable, not an error ---
      const controlCases: ReadonlyArray<readonly [string, unknown]> = [
        ["controlStatus", undefined],
        ["controlWake", { lane: "heartbeat" }],
        ["controlDrain", {}],
      ];
      for (const [key, body] of controlCases) {
        const answer = await drive(
          key,
          { id },
          { ...(body !== undefined ? { body } : {}), readsKey: "controlStatus" },
        );
        expect(answer["ok"]).toBe(false);
        expect(answer["code"]).toBe("no_control_port");
        expect(answer["expected"]).toBe(true);
      }

      // -- M2 inboxes: grant + deny + adjudicate, each visible on re-read ---
      await drive("grantApproval", { id, apprId: "appr_00000000000000a1" }, { body: {} });
      await drive("denyApproval", { id, apprId: "appr_00000000000000a2" }, { body: {} });
      const settled = (await drive("approvals", {}, { query: "?all=1" }))["approvals"] as Array<{
        id: string;
        status: string;
      }>;
      expect(settled.find((a) => a.id === "appr_00000000000000a1")?.status).toBe("granted");
      expect(settled.find((a) => a.id === "appr_00000000000000a2")?.status).toBe("denied");

      await drive(
        "adjudicateReview",
        { id, itemId: "rev_quarantine_smoke_s1" },
        { body: { verdict: "pass", note: "reviewed" } },
      );
      const reviewAfter = (await drive("review", {}, { query: "?all=1" }))["items"] as Array<{
        id: string;
        status: string;
      }>;
      expect(reviewAfter.find((i) => i.id === "rev_quarantine_smoke_s1")?.status).toBe("resolved");

      // -- M2 action faces --------------------------------------------------
      await drive("pinSession", { id, sess: "sess_00000000000000aa" }, { body: { pinned: true } });
      const sessionsAfter = await drive("sessions", { id });
      expect(sessionsAfter["pins"]).toEqual(["sess_00000000000000aa"]);

      await drive("pinBaseline", { id }, { body: { runId: "run_00000000000000aa" } });
      const evalsAfter = await drive("evals", { id });
      expect(
        (evalsAfter["baselines"] as Record<string, { runId: string }>)["contract-harness::smoke"]
          ?.runId,
      ).toBe("run_00000000000000aa");

      // -- M2 jobs: submit through the queue, visible in the queue view ------
      // One job that FINISHES and one that is still going, because the panel
      // has two halves and the contract must cover both: `recent` is the
      // only surface a completed — or `interrupted` — job ever appears on.
      const job = await drive("submitJob", { id }, { body: { kind: "doctor" }, expectStatus: 202 });
      expect((job["job"] as { kind: string }).kind).toBe("doctor");
      await t.server.processes.jobs.idle();
      await drive("submitJob", { id }, { body: { kind: "eval" }, expectStatus: 202 });
      const queue = await drive("jobs", {}, { readsKey: "jobs" });
      expect((queue["recent"] as Array<{ kind: string }>).some((j) => j.kind === "doctor")).toBe(
        true,
      );

      // -- M3: the whole detail surface, driven ------------------------------
      // Each route must answer 501 (a stub) or 2xx (real, and then its
      // VIEW_READS table is enforced). A 404 would mean the server's dispatch
      // table and the console's map have drifted apart; a 500 would mean a
      // guard threw. Both fail here, loudly, which is the entire point.
      const m3Keys = Object.keys(ROUTES).filter((key) => ROUTES[key]?.group !== undefined);
      expect(m3Keys.length).toBeGreaterThanOrEqual(150);
      for (const key of m3Keys) {
        const route = ROUTES[key] as RouteDef;
        const params: Record<string, string> = { id };
        for (const m of route.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)) {
          const name = m[1] as string;
          if (name === "id") continue;
          const value = M3_PARAMS[name];
          if (value === undefined) {
            throw new Error(`no M3_PARAMS value for ":${name}" (route ${key} ${route.path})`);
          }
          params[name] = value;
        }
        const writes = route.method === "POST" || route.method === "PUT";
        if (writes && M3_BODIES[key] === undefined) {
          throw new Error(`no M3_BODIES entry for write route "${key}" (${route.path})`);
        }
        driven.add(key);
        const { status, body } = await t.api(fill(route.path, params), {
          method: route.method,
          ...(writes ? { body: JSON.stringify(M3_BODIES[key]) } : {}),
        });
        if (status === 501) {
          expect(`${key}:${String(body["error"] ?? "")}`).toContain("not implemented (M3)");
          continue;
        }
        if (status < 200 || status >= 300) {
          throw new Error(
            `${key} ${route.method} ${route.path}: expected 501 (stub) or 2xx (implemented), got ${status} ${JSON.stringify(body)}`,
          );
        }
        // Implemented. A read must now carry every field its view derefs; a
        // write must additionally get an effect assertion in its area's
        // section above — this loop proves it answered, not that it worked.
        if (route.method === "GET") assertViewReads(key, body);
      }

      // -- M4: health, onboarding, ⌘K, notifications, read-only, plugins ---
      // Every one is a REAL handler (no `group`, so no 501 is acceptable);
      // each read must carry the fields its view dereferences.
      const health = await drive("health", { id }, { readsKey: "health" });
      const score = (health["health"] as { score: number; deductions: unknown[] }).score;
      // The invariant the item exists for: a score under 100 is never a bare
      // number — the deductions that produced it travel with it.
      if (score < 100) {
        expect((health["health"] as { deductions: unknown[] }).deductions.length).toBeGreaterThan(
          0,
        );
      }
      await drive("fleetHealth", {}, { readsKey: "fleetHealth" });

      const onboarding = await drive("onboarding", {}, { readsKey: "onboarding" });
      // A registered harness means this is not first boot.
      expect(onboarding["firstBoot"]).toBe(false);
      // With no demos checkout configured the refusal names the remedy.
      const demoRefusal = await drive(
        "demoInstall",
        {},
        {
          body: { starter: "cli-quickstart", dir: join(t.workspace, "demo-target") },
          expectStatus: 409,
        },
      );
      expect(demoRefusal["reason"]).toBe("no-demos-checkout");
      expect(String(demoRefusal["remedy"])).toContain("crewhaus/demos");

      const found = await drive("search", {}, { query: "?q=contract-harness", readsKey: "search" });
      expect((found["entries"] as Array<{ id: string }>).some((e) => e.id === id)).toBe(true);

      const notifications = await drive("notifications", {}, { readsKey: "notifications" });
      expect((notifications["rules"] as Array<{ kind: string }>).length).toBeGreaterThan(5);
      await drive("setNotifications", {}, { body: { mutedGroups: ["prod"] } });
      expect((await drive("notifications", {}))["mutedGroups"]).toEqual(["prod"]);
      await drive("clearNotifications", {}, { body: {} });
      expect((await drive("notifications", {}))["badge"]).toBe(0);

      const readOnly = await drive("readOnly", {}, { readsKey: "readOnly" });
      expect(readOnly["enabled"]).toBe(false);
      // Engaged and lifted again, with the effect visible on re-read — the
      // toggle must not strand this test in a mode where nothing else works.
      await drive("setReadOnly", {}, { body: { enabled: true } });
      expect((await drive("readOnly", {}))["enabled"]).toBe(true);
      expect((await t.api("/api/scan", { method: "POST", body: "{}" })).status).toBe(403);
      await drive("setReadOnly", {}, { body: { enabled: false } });
      expect((await drive("readOnly", {}))["enabled"]).toBe(false);

      // The plugin fabric: one installed plugin whose read glob covers this
      // server's harness root, so it draws a pane and observes traces.
      mkdirSync(join(pluginsDir, "cost-lens"), { recursive: true });
      writeFileSync(
        join(pluginsDir, "cost-lens", "plugin.json"),
        JSON.stringify({
          name: "cost-lens",
          version: "1.0.0",
          onTraceEvent: true,
          onSpecLoad: true,
          panes: [{ id: "spend", title: "Spend", file: "spend.html" }],
          permissions: { fs: [`read:${t.harnessesRoot}/**`] },
        }),
      );
      writeFileSync(join(pluginsDir, "cost-lens", "spend.html"), "<p>spend</p>");
      const inventory = await drive("plugins", {}, { readsKey: "plugins" });
      expect(inventory["wired"]).toEqual(["onTraceEvent", "panes"]);
      const pane = await drive(
        "pluginPane",
        { plugin: "cost-lens", pane: "spend" },
        { readsKey: "pluginPane" },
      );
      // The containment travels WITH the document, always.
      expect(pane["sandbox"]).toBe("allow-scripts");
      expect(String(pane["csp"])).toContain("connect-src 'none'");
      const panes = await drive("panes", { id }, { readsKey: "panes" });
      expect((panes["panes"] as Array<{ id: string }>).map((p) => p.id)).toEqual(["spend"]);
      expect(panes["traceObservers"]).toEqual(["cost-lens"]);

      // -- scan root + scan (effect: the root is scanned, entries refresh) --
      await drive("addScanRoot", {}, { body: { dir: t.harnessesRoot }, expectStatus: 201 });
      const scanned = await drive("scan", {}, { body: {} });
      expect(scanned["roots"]).toBe(1);
      expect(scanned["discovered"]).toBeGreaterThanOrEqual(1);

      // -- relocate (effect: entry.dir moves), then remove (404 after) -----
      const newDir = join(t.workspace, "relocated-contract");
      mkdirSync(newDir, { recursive: true });
      const relocated = await drive("relocate", { id }, { body: { newDir } });
      expect((relocated["entry"] as { dir: string }).dir).toBe(newDir);
      const removed = await drive("removeHarness", { id });
      expect(removed["removed"]).toBe(true);
      expect((await t.api(`/api/h/${id}`)).status).toBe(404);

      // -- completeness: the map holds nothing this test did not drive -----
      expect([...driven].sort()).toEqual(Object.keys(ROUTES).sort());
    } finally {
      await t.stop();
      rmSync(pluginsDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("the server's M3 dispatch table IS the console's grouped route map", async () => {
    // Three files, one truth: `routes.js` (what the client calls),
    // `m3-routes.ts` (what the server dispatches), and this test (what CI
    // proves). Any two of them agreeing while the third drifts is exactly
    // the failure mode that shipped a console of dead buttons twice.
    const ROUTES = await loadRoutes();
    const mapped = Object.entries(ROUTES)
      .filter(([, def]) => def.group !== undefined)
      .map(([key, def]) => `${key} ${def.method} ${def.path} ${def.group}`)
      .sort();
    const dispatched = M3_ROUTES.map(
      (route) => `${route.key} ${route.method} ${route.path} ${route.group}`,
    ).sort();
    expect(dispatched).toEqual(mapped);
  });

  test("every M3 read route declares the fields its view will dereference", async () => {
    // A read with no VIEW_READS table is a screen nobody has designed yet.
    // Catching that HERE — while the handler is still a stub — is the whole
    // reason the contract is frozen before the implementations start.
    const ROUTES = await loadRoutes();
    const missing = Object.entries(ROUTES)
      .filter(([, def]) => def.group !== undefined && def.method === "GET")
      .map(([key]) => key)
      .filter((key) => ALL_VIEW_READS[key] === undefined);
    expect(missing).toEqual([]);
  });
});
