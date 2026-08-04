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
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { logLine, makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

type RouteDef = {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
  readonly stream?: string;
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
  // views/jobs.js — the queue
  jobs: [
    ["pending", "array"],
    ["running[].jobId", "string"],
    ["running[].kind", "string"],
    ["running[].harnessDir", "string"],
    ["running[].state", "string"],
    ["running[].mutating", "boolean"],
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
  const table = VIEW_READS[routeKey];
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
    const t = bootTestServer({ now: () => NOW });
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
      const job = await drive("submitJob", { id }, { body: { kind: "doctor" }, expectStatus: 202 });
      expect((job["job"] as { kind: string }).kind).toBe("doctor");
      await drive("jobs", {}, { readsKey: "jobs" });

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
    }
  }, 30_000);
});
