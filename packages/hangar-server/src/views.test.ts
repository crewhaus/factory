import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { logLine, makeFixtureHarness } from "./fixture";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();
const DAY = 86_400_000;

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});
function boot(opts: Parameters<typeof bootTestServer>[0] = {}): TestServer {
  const t = bootTestServer({ now: () => NOW, ...opts });
  servers.push(t);
  return t;
}

async function register(t: TestServer, dir: string): Promise<string> {
  const { body } = await t.api("/api/harnesses", {
    method: "POST",
    body: JSON.stringify({ dir }),
  });
  return (body["entry"] as { id: string }).id;
}

function richHarness(t: TestServer): string {
  return makeFixtureHarness(join(t.harnessesRoot, "rich"), {
    specName: "rich",
    specExtra: [
      "memory:",
      "  recall: true",
      "wiki: {}",
      "budget:",
      "  usd: 10",
      "feedback:",
      "  capture: true",
    ].join("\n"),
    envLines: ["SOME_FLAG=1"],
    sessions: [
      {
        id: "sess_00000000000000aa",
        updatedAt: iso(NOW - DAY),
        log: [logLine("user_message", { content: "hi" })],
      },
    ],
    memories: {
      rich: [
        { id: "mem_0000000000000001", text: "live fact", tags: ["a"], createdAt: iso(NOW - DAY) },
        { id: "mem_0000000000000002", text: "old fact", tags: [], createdAt: iso(NOW - 2 * DAY) },
        {
          tombstone: "superseded",
          target: "mem_0000000000000002",
          at: iso(NOW - DAY),
          schemaVersion: 2,
        },
        {
          id: "mem_0000000000000003",
          text: "short-lived",
          tags: [],
          createdAt: iso(NOW - 2 * DAY),
          expiresAt: NOW - DAY,
        },
        '{"id":"mem_torn', // torn line tolerated
      ],
    },
    wikiIndex: {
      "how-to-deploy": { title: "How to deploy", tags: ["ops"] },
    },
    wikiArticles: { "how-to-deploy": "---\ntitle: How to deploy\n---\n# Deploy\nsteps\n" },
    focus: "<!-- crewhaus:focus -->\ncurrent focus text\n",
    goals: "- id: g1\n  title: ship hangar\n  status: active\n",
    dreamState: { rich: { lastRunAt: iso(NOW - DAY), window: "daily" } },
    watchmeState: { schemaVersion: 1, watching: true },
    watchmeObservations: [{ sessionId: "sess_00000000000000aa", digest: "d1" }],
    evalIndex: [
      {
        runId: "run_00000000000000aa",
        specName: "rich",
        specHash: "h1",
        datasetName: "smoke",
        datasetHash: "d",
        passRate: 0.9,
        meanScore: 0.9,
        sampleCount: 2,
        ts: iso(NOW - 2 * DAY),
        outDir: "/gone",
      },
      {
        runId: "run_00000000000000ab",
        specName: "rich",
        specHash: "h2",
        datasetName: "smoke",
        datasetHash: "d",
        passRate: 0.5,
        meanScore: 0.5,
        sampleCount: 2,
        ts: iso(NOW - 1 * DAY),
        outDir: "/gone",
      },
    ],
    baselines: {
      "rich::smoke": {
        specName: "rich",
        datasetName: "smoke",
        runId: "run_00000000000000aa",
        outDir: "/gone",
        datasetHash: "d",
        ts: iso(NOW - 2 * DAY),
      },
    },
    evalRuns: [
      {
        runId: "run_00000000000000ab",
        results: { passRate: 0.5, results: [{ sampleId: "s1", pass: false }] },
        samples: {
          s1: {
            grades: { pass: false, rationale: "missed the point" },
            meta: { latencyMs: 12 },
            transcript: [{ kind: "user_message", payload: { content: "q" } }],
          },
        },
      },
    ],
  });
}

describe("detail card", () => {
  test("entry + inventory + health + preflight counts + capability badges + rollup", async () => {
    const t = boot();
    const dir = richHarness(t);
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}`);
    expect(status).toBe(200);
    expect(body["missing"]).toBe(false);

    const inventory = body["inventory"] as Record<string, unknown>;
    expect(inventory["specName"]).toBe("rich");
    expect(inventory["sessionCount"]).toBe(1);

    const health = body["health"] as Record<string, unknown>;
    // The newest run (50%) is below the pinned baseline run (90%).
    expect(health["evalHealthy"]).toBe(false);
    expect(String(health["evalNote"])).toContain("below baseline");

    const badges = body["badges"] as Record<string, boolean>;
    expect(badges).toEqual({
      memory: true,
      wiki: true,
      dream: false,
      thredz: false,
      watchme: false,
      feedback: true,
      budget: true,
    });

    const preflight = body["preflight"] as Record<string, unknown>;
    expect(typeof preflight["ok"]).toBe("boolean");
    expect(typeof preflight["blocking"]).toBe("number");
    expect(typeof preflight["warn"]).toBe("number");
    expect(typeof preflight["info"]).toBe("number");

    const rollup = body["rollup"] as Record<string, unknown>;
    expect(rollup["sessionCount"]).toBe(1);
    expect(body["envFiles"]).toEqual([".env"]);
  });
});

describe("spec view", () => {
  test("masked yaml + issues + envRefs presence + badges", async () => {
    const t = boot({ env: { MANAGER_ONLY_VAR: "set-by-manager" } });
    const dir = makeFixtureHarness(join(t.harnessesRoot, "spec"), {
      specName: "spec-demo",
      specExtra: [
        "channels:",
        "  slack:",
        "    botToken: $SLACK_BOT_TOKEN",
        "    signingSecret: $SLACK_SIGNING_SECRET",
        "memory:",
        "  recall: true",
      ].join("\n"),
      envLines: ["SLACK_BOT_TOKEN=xoxb-not-a-real-part"],
    });
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/spec`);
    expect(status).toBe(200);
    expect(body["specName"]).toBe("spec-demo");
    expect(body["target"]).toBe("cli");
    expect(Array.isArray(body["issues"])).toBe(true);
    expect((body["yaml"] as string).length).toBeGreaterThan(0);
    expect(body["yaml"] as string).toContain("botToken: $SLACK_BOT_TOKEN");
    const refs = body["envRefs"] as Array<{ key: string; set: boolean }>;
    expect(refs).toEqual([
      { key: "SLACK_BOT_TOKEN", set: true }, // set in the harness .env
      { key: "SLACK_SIGNING_SECRET", set: false },
    ]);
    const badges = body["badges"] as Record<string, boolean>;
    expect(badges["memory"]).toBe(true);
    expect(badges["budget"]).toBe(false);
  });
});

describe("preflight route", () => {
  test("returns the typed report evaluated against process env merged UNDER the harness .env", async () => {
    const t = boot({ env: { FROM_MANAGER: "manager", SHARED: "manager-wins?" } });
    const dir = makeFixtureHarness(join(t.harnessesRoot, "pf"), {
      specName: "pf",
      envLines: ["SHARED=harness-wins"],
    });
    const id = await register(t, dir);
    const { status, body } = await t.api(`/api/h/${id}/preflight`);
    expect(status).toBe(200);
    const report = body["report"] as Record<string, unknown>;
    expect(typeof report["ok"]).toBe("boolean");
    const items = report["items"] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    // The spec area ran (fixture spec parses cleanly or reports issues).
    expect(items.some((i) => i["area"] === "spec")).toBe(true);
    expect(body["envFiles"]).toEqual([".env"]);
  });
});

describe("memory areas", () => {
  test("facts fold is tombstone-aware; wiki/state/dream/watchme render; other areas 404", async () => {
    const t = boot();
    const dir = richHarness(t);
    const id = await register(t, dir);

    const facts = await t.api(`/api/h/${id}/memory/facts`);
    expect(facts.status).toBe(200);
    const file = (facts.body["files"] as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >;
    expect(file["specName"]).toBe("rich");
    expect(file["live"]).toBe(1);
    expect(file["superseded"]).toBe(1);
    expect(file["expired"]).toBe(1);
    const items = file["items"] as Array<Record<string, unknown>>;
    expect(items.map((i) => `${i["id"]}:${i["status"]}`)).toEqual([
      "mem_0000000000000001:live",
      "mem_0000000000000002:superseded",
      "mem_0000000000000003:expired",
    ]);

    const wiki = await t.api(`/api/h/${id}/memory/wiki`);
    expect(wiki.status).toBe(200);
    expect(wiki.body["articles"]).toEqual(["how-to-deploy"]);
    const article = await t.api(`/api/h/${id}/memory/wiki/how-to-deploy`);
    expect(article.status).toBe(200);
    expect(article.body["body"]).toContain("# Deploy");

    const state = await t.api(`/api/h/${id}/memory/state`);
    expect(state.status).toBe(200);
    expect(String(state.body["focus"])).toContain("current focus text");
    expect(String(state.body["goals"])).toContain("ship hangar");

    const dream = await t.api(`/api/h/${id}/memory/dream`);
    expect(dream.status).toBe(200);
    const specs = dream.body["specs"] as Array<Record<string, unknown>>;
    expect(specs.length).toBe(1);
    expect((specs[0] as { specName: string }).specName).toBe("rich");

    const watchme = await t.api(`/api/h/${id}/memory/watchme`);
    expect(watchme.status).toBe(200);
    expect((watchme.body["state"] as Record<string, unknown>)["watching"]).toBe(true);
    expect((watchme.body["observationsTail"] as unknown[]).length).toBe(1);

    for (const area of ["secrets", "audit", "sessions", "env", "anything"]) {
      expect((await t.api(`/api/h/${id}/memory/${area}`)).status).toBe(404);
    }
  });
});

describe("eval routes", () => {
  test("history rows newest-first + baselines; run view; per-sample artifacts", async () => {
    const t = boot();
    const dir = richHarness(t);
    const id = await register(t, dir);

    const evals = await t.api(`/api/h/${id}/evals`);
    expect(evals.status).toBe(200);
    const runs = evals.body["runs"] as Array<Record<string, unknown>>;
    expect(runs.map((r) => r["runId"])).toEqual(["run_00000000000000ab", "run_00000000000000aa"]);
    expect(Object.keys(evals.body["baselines"] as Record<string, unknown>)).toEqual([
      "rich::smoke",
    ]);

    const run = await t.api(`/api/h/${id}/evals/run_00000000000000ab`);
    expect(run.status).toBe(200);
    expect(run.body["sampleIds"]).toEqual(["s1"]);
    expect((run.body["summary"] as Record<string, unknown>)["passRate"]).toBe(0.5);

    const sample = await t.api(`/api/h/${id}/evals/run_00000000000000ab/s1`);
    expect(sample.status).toBe(200);
    expect((sample.body["grades"] as Record<string, unknown>)["pass"]).toBe(false);
    expect((sample.body["meta"] as Record<string, unknown>)["latencyMs"]).toBe(12);
    expect((sample.body["transcript"] as unknown[]).length).toBe(1);

    expect((await t.api(`/api/h/${id}/evals/run_00000000000000ff`)).status).toBe(404);
    expect((await t.api(`/api/h/${id}/evals/run_00000000000000ab/nope`)).status).toBe(404);
  });
});
