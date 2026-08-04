import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { feedbackRecord, logLine, makeFixtureHarness } from "./fixture";
import { maskDeep, maskSpecYaml } from "./mask";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

// A fake-shaped credential BUILT FROM PARTS — never a contiguous literal in
// this repo (push protection) and never a real value anywhere.
const FAKE_KEY = ["sk-", "ant-", "api03-", "AbCdEf0123456789", "AbCdEf0123456789"].join("");
// A second fake with no `sk-` shape, caught by the contextual masker.
const FAKE_OPAQUE = ["Zz9", "Yy8", "Xx7", "Ww6"].join("").repeat(3);

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await (servers.pop() as TestServer).stop();
});

describe("credential hygiene (unit)", () => {
  test("maskSpecYaml redacts credential-keyed scalars but keeps $VAR references visible", () => {
    const yaml = [
      "name: demo",
      "channels:",
      "  slack:",
      `    botToken: ${FAKE_KEY}`,
      "    signingSecret: $SLACK_SIGNING_SECRET",
      `instructions: use key ${FAKE_KEY} carefully`,
    ].join("\n");
    const masked = maskSpecYaml(yaml);
    expect(masked).not.toContain(FAKE_KEY);
    // QUOTED: bare `[redacted]` is a YAML flow sequence, so an unquoted
    // redaction silently changed a scalar into a one-item list.
    expect(masked).toContain('botToken: "[redacted]"');
    expect(masked).not.toMatch(/botToken: \[redacted\]/);
    expect(masked).toContain("signingSecret: $SLACK_SIGNING_SECRET");

    // `sessionKey` ends in "Key" but selects a channel's session-routing
    // MODE, not a secret. Redacting it hid a routing decision from every
    // channel harness's spec view while protecting nothing.
    const routing = maskSpecYaml(
      ["channels:", "  slack:", "    routing:", "      sessionKey: thread"].join("\n"),
    );
    expect(routing).toContain("sessionKey: thread");
    expect(routing).not.toContain("[redacted]");
    expect(masked).toContain("name: demo");
  });

  test("maskDeep redacts values under credential keys and token shapes in strings", () => {
    const masked = maskDeep({
      api_key: FAKE_KEY,
      nested: { headers: { authorization: `Bearer ${FAKE_KEY}` } },
      prose: `the token ${FAKE_KEY} leaked`,
      fine: "ordinary text survives",
      n: 7,
    }) as Record<string, unknown>;
    expect(JSON.stringify(masked)).not.toContain(FAKE_KEY);
    expect(masked["api_key"]).toBe("[redacted]");
    expect(masked["fine"]).toBe("ordinary text survives");
    expect(masked["n"]).toBe(7);
  });
});

describe("credential hygiene (end-to-end)", () => {
  test("a fake-shaped key planted in .env + spec (+ transcript) never appears in ANY response body", async () => {
    const t = bootTestServer({ now: () => NOW });
    servers.push(t);
    const sess = "sess_00000000000000aa";
    const dir = makeFixtureHarness(join(t.harnessesRoot, "planted"), {
      specName: "planted",
      envLines: [
        `ANTHROPIC_API_KEY=${FAKE_KEY}`,
        `HELPER_TOKEN=${FAKE_OPAQUE}`,
        "PLAIN_SETTING=not-a-secret",
      ],
      specExtra: [
        "memory:",
        "  recall: true",
        "budget:",
        "  usd: 5",
        `# a pasted credential a lint may quote: ${FAKE_KEY}`,
        "mcp_servers:",
        "  helper:",
        "    command: bunx helper-mcp",
        "    env:",
        `      HELPER_TOKEN: ${FAKE_KEY}`,
      ].join("\n"),
      sessions: [
        {
          id: sess,
          updatedAt: iso(NOW - 3600_000),
          log: [
            logLine("user_message", { content: `my key is ${FAKE_KEY}` }),
            logLine("assistant_message", {
              content: [
                { type: "text", text: `never say ${FAKE_KEY} aloud` },
                { type: "tool_use", id: "tu_1", name: "web", input: { apiKey: FAKE_KEY } },
              ],
            }),
            logLine("user_message", {
              content: [{ type: "tool_result", tool_use_id: "tu_1", content: `body ${FAKE_KEY}` }],
            }),
            logLine("cost_accrual", { provider: "anthropic", modelId: "m", costUsdMicros: 5 }),
            logLine("user_feedback", feedbackRecord(sess, 1, "up", iso(NOW))),
          ],
        },
      ],
      // Every free-text memory-fabric surface carries a planted key: an agent
      // that saw a credential in a tool result can quote it into a fact, a
      // wiki body, or a continuity note, and none of those are spec YAML.
      wikiIndex: { note: { title: "note" } },
      wikiArticles: { note: `# notes\n\nthe helper key is ${FAKE_KEY}\n` },
      memories: {
        planted: [
          {
            id: "mem_0000000000000001",
            text: `the deploy key is ${FAKE_KEY}`,
            tags: [`tagged-${FAKE_KEY}`],
            createdAt: iso(NOW),
          },
        ],
      },
      sessionIndex: {
        sess_00000000000000bb: {
          summarizedAt: iso(NOW - 7200_000),
          summary: `wrapped up after rotating ${FAKE_KEY}`,
        },
      },
      evalIndex: [
        {
          runId: "run_00000000000000aa",
          specName: "planted",
          specHash: "h",
          datasetName: "d",
          datasetHash: "h",
          passRate: 1,
          meanScore: 1,
          sampleCount: 1,
          ts: iso(NOW),
          outDir: "/gone",
        },
      ],
      evalRuns: [
        {
          runId: "run_00000000000000aa",
          results: { passRate: 1 },
          samples: { s1: { grades: { pass: true }, meta: {}, transcript: [{ kind: "noop" }] } },
        },
      ],
      dreamState: { planted: { lastRunAt: iso(NOW) } },
      watchmeState: { schemaVersion: 1, watching: false },
      watchmeObservations: [{ sessionId: sess, digest: "clean" }],
      focus: `current focus: rotate ${FAKE_KEY} everywhere\n`,
      goals: `- id: g1\n  title: retire ${FAKE_KEY}\n  status: active\n`,
      // M2 surfaces. A captured daemon log is UNSCRUBBED on disk by
      // construction, an approval embeds the raw tool input a policy deemed
      // sensitive enough to need a human, and a review context is free text
      // — all three are exactly where a key ends up.
      runLedger: [
        {
          runId: "run_00000000000000cc",
          kind: "daemon",
          argv: ["bun", "dist/daemon.ts"],
          startedAt: iso(NOW - 3600_000),
          logFile: "logs/run_00000000000000cc.log",
        },
        { runId: "run_00000000000000cc", endedAt: iso(NOW), exitCode: 0 },
      ],
      runLogs: [
        {
          runId: "run_00000000000000cc",
          log: `booting with ANTHROPIC_API_KEY=${FAKE_KEY}\nready\n`,
          events: [
            { kind: "run_failed", runId: "run_00000000000000cc", error: `auth ${FAKE_KEY}` },
          ],
        },
      ],
      approvals: [
        {
          id: "appr_00000000000000c1",
          toolName: "Fetch",
          inputHash: "h",
          input: { url: "https://example.invalid", headers: { authorization: FAKE_KEY } },
          runId: "run_00000000000000cc",
          sessionId: sess,
          surface: "daemon",
          createdAt: iso(NOW),
        },
      ],
      reviewQueue: [
        {
          schemaVersion: 1,
          id: "rev_quarantine_d_s1",
          kind: "quarantine",
          sourceRef: { dataset: "d", sampleId: "s1" },
          ts: iso(NOW),
          status: "open",
          context: `sample quoted ${FAKE_KEY}`,
        },
      ],
      deployments: { deployments: [{ env: "prod", note: `deployed with ${FAKE_KEY}` }] },
      bundle: { entry: "daemon.ts" },
    });
    const { body: created } = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    const id = (created["entry"] as { id: string }).id;

    const paths = [
      "/api/version",
      "/api/harnesses",
      "/api/harnesses?hydrate=1",
      "/api/costs",
      "/api/registry/groups",
      "/api/registry/scan-roots",
      `/api/h/${id}`,
      `/api/h/${id}/spec`,
      `/api/h/${id}/preflight`,
      `/api/h/${id}/sessions`,
      `/api/h/${id}/sessions/${sess}`,
      `/api/h/${id}/sessions/${sess}?raw=1`,
      `/api/h/${id}/evals`,
      `/api/h/${id}/evals/run_00000000000000aa`,
      `/api/h/${id}/evals/run_00000000000000aa/s1`,
      `/api/h/${id}/memory/facts`,
      `/api/h/${id}/memory/wiki`,
      `/api/h/${id}/memory/wiki/note`,
      `/api/h/${id}/memory/state`,
      `/api/h/${id}/memory/dream`,
      `/api/h/${id}/memory/watchme`,
      `/api/h/${id}/costs`,
      // M2
      `/api/h/${id}/proc`,
      `/api/h/${id}/runs`,
      `/api/h/${id}/runs/run_00000000000000cc`,
      `/api/h/${id}/runs/run_00000000000000cc/events`,
      `/api/h/${id}/control/status`,
      `/api/h/${id}/schedulers`,
      `/api/h/${id}/deployments`,
      "/api/approvals?all=1",
      "/api/review?all=1",
      "/api/activity?since=30d",
      "/api/jobs",
    ];
    for (const path of paths) {
      const res = await t.fetchRaw(path, {
        headers: { authorization: `Bearer ${t.token}` },
      });
      const text = await res.text();
      expect(`${path}:${res.status}`).toBe(`${path}:200`);
      expect(text).not.toContain(FAKE_KEY);
      // .env VALUES are never serialized at all — not even non-token shapes.
      expect(text).not.toContain(FAKE_OPAQUE);
    }

    // A run detail's prose tail is the ONE payload built from the raw
    // capture file. Both layers must be on it, or the same response body
    // contradicts itself: the pump-extracted `events` masked, the same bytes
    // verbatim in `proseTail`.
    const detail = await t.api(`/api/h/${id}/runs/run_00000000000000cc`);
    const tail = (detail.body["proseTail"] as string[]).join("\n");
    expect(tail).not.toContain(FAKE_KEY);
    expect(tail).toContain("«ANTHROPIC_API_KEY»");

    // The spec view still names the env refs (presence only) …
    const spec = await t.api(`/api/h/${id}/spec`);
    const yaml = spec.body["yaml"] as string;
    expect(yaml).not.toContain(FAKE_KEY);
    expect(yaml).toContain('HELPER_TOKEN: "[redacted]"');
    // … and the transcript kept its shape while masking the values.
    const transcript = await t.api(`/api/h/${id}/sessions/${sess}`);
    const tools = transcript.body["tools"] as Array<Record<string, unknown>>;
    expect((tools[0] as { input: { apiKey: string } }).input.apiKey).toBe("[redacted]");
  });

  test("run history is scrubbed to the SAME standard as the live feed", async () => {
    // The two gaps a `.env`-only scrubber leaves, both reachable on the very
    // first daemon boot:
    //   1. a key exported in the shell that launched the manager. The spawn
    //      env layers the harness chain UNDER the process env, so the daemon
    //      inherits it and an MCP server echoing its env quotes it into the
    //      log — but no `.env` file has ever heard of it. Deliberately under
    //      32 chars and of no known shape, so ONLY the env scrubber can
    //      catch it.
    const EXPORTED = "orange-marmalade-42";
    //   2. a credential in no env file at all (an OAuth token a tool echoed
    //      back), which only the SHAPE masker can catch.
    const runId = "run_00000000000000dd";
    const t = bootTestServer({ now: () => NOW, env: { HELPER_API_KEY: EXPORTED } });
    servers.push(t);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "history-scrub"), {
      specName: "history-scrub",
      target: "channel",
      envLines: ["PLAIN_SETTING=not-a-secret"],
      bundle: { entry: "daemon.ts" },
      runLedger: [
        {
          runId,
          kind: "daemon",
          argv: ["bun", "dist/daemon.ts"],
          startedAt: iso(NOW - 3600_000),
          logFile: `logs/${runId}.log`,
        },
        { runId, endedAt: iso(NOW), exitCode: 0 },
      ],
      runLogs: [
        {
          runId,
          log: [
            `booting helper-mcp with HELPER_API_KEY=${EXPORTED}`,
            `provider 401 body: {"error":"invalid key ${FAKE_KEY}"}`,
            "",
          ].join("\n"),
          events: [{ kind: "run_started", runId }],
        },
      ],
    });
    const { body: created } = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    const id = (created["entry"] as { id: string }).id;

    const detail = await t.api(`/api/h/${id}/runs/${runId}`);
    const tail = (detail.body["proseTail"] as string[]).join("\n");
    // Named, not just hidden: the operator still learns WHICH variable the
    // log was talking about — which is the whole contract of the scrubber.
    expect(tail).toContain("«HELPER_API_KEY»");
    expect(tail).not.toContain(EXPORTED);
    expect(tail).not.toContain(FAKE_KEY);

    // …and the SSE `replay` frame ships the same bytes. It is the same
    // object; serving it through a second path must not serve it raw.
    const stream = await t.apiText(`/api/h/${id}/runs/${runId}/events`);
    expect(stream.status).toBe(200);
    expect(stream.text).toContain("event: replay");
    expect(stream.text).not.toContain(EXPORTED);
    expect(stream.text).not.toContain(FAKE_KEY);
  });
});
