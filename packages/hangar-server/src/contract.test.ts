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

type RouteDef = { readonly method: string; readonly path: string; readonly body?: string };

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

function contractHarness(t: TestServer): string {
  return makeFixtureHarness(join(t.harnessesRoot, "contract"), {
    specName: "contract-harness",
    specExtra: [
      "memory:",
      "  recall: true",
      "budget:",
      "  usd: 10",
      "notify_env: $CONTRACT_VAR",
    ].join("\n"),
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
