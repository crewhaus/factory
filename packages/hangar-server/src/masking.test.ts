import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feedbackRecord, logLine, makeFixtureHarness } from "./fixture";
import { inspectStore } from "./inspect";
import type { M3Context } from "./m3";
import { maskDeep, maskKeyedText, maskSpecYaml, maskText } from "./mask";
import { runDetail, safeSpawnEnvScrubber, specCredentialValues } from "./runs";
import { type TestServer, bootTestServer } from "./testkit";

const NOW = Date.parse("2026-08-03T00:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

// A fake-shaped credential BUILT FROM PARTS — never a contiguous literal in
// this repo (push protection) and never a real value anywhere.
const FAKE_KEY = ["sk-", "ant-", "api03-", "AbCdEf0123456789", "AbCdEf0123456789"].join("");
// A second fake with no `sk-` shape, caught by the contextual masker.
const FAKE_OPAQUE = ["Zz9", "Yy8", "Xx7", "Ww6"].join("").repeat(3);

/**
 * The needle for the OPAQUE case, and the one thing about it that matters:
 * it is 24 characters, which is under the 32 every opaque-token rule in the
 * shape masker requires, and it carries no `sk-`/`ghp_`/`xox`/`AKIA` prefix
 * and no key-ish neighbour. NOTHING but the harness's own env scrubber can
 * reach it — which is exactly the point, and exactly the case that leaked
 * from twenty routes while a whole masking suite stayed green.
 */
const PLANTED = ["Zz9Yy8", "Xx7Ww6", "Vv5Uu4", "Tt3Ss2"].join("");
/** What the scrubber leaves behind: the NAME, so the operator still learns
 *  which variable the payload was talking about. */
const PLANTED_MARK = "«PLANTED_SECRET»";

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

  test("key-aware TEXT masking closes the gap between the spec view and the raw browser", () => {
    // The inline-literal case the compiler explicitly models: a credential
    // written into the spec rather than referenced from `.env`. SHORT — under
    // 32 characters — so every opaque-token rule is out of reach and only
    // reading the KEY off the line can catch it. That is how the raw browser
    // came to serve in cleartext what `/spec` redacted.
    const inline = ["2a3b", "4c5d", "6e7f", "8a9b"].join("");
    expect(maskKeyedText(`    signingSecret: ${inline}`)).toBe('    signingSecret: "[redacted]"');
    // …and the SAME literal in the compiled bundle, which `lowerCredential`
    // bakes in as `{kind:"literal"}`. A per-extension `.yaml` rule would have
    // left this one fully exposed.
    expect(maskKeyedText(`  signingSecret: "${inline}" ?? "",`)).not.toContain(inline);
    // Inline, not at the head of a line, where the line rule sees no key: the
    // camel-case widening of the contextual rule is what reaches it, and
    // `CONTEXTUAL_OPAQUE_RE`'s leading `\b` is why the original could not.
    const long = `${inline}0c1d2e3f4a5b6c7d`;
    expect(maskKeyedText(`{"signingSecret":"${long}"}`)).not.toContain(long);
    // A REFERENCE is a name, not a value — both spellings stay readable.
    expect(maskKeyedText("  signingSecret: $SLACK_SIGNING_SECRET")).toContain(
      "$SLACK_SIGNING_SECRET",
    );
    expect(maskKeyedText('  botToken: process.env["SLACK_BOT_TOKEN"] ?? "",')).toContain(
      "SLACK_BOT_TOKEN",
    );
    // `monkey` ends in "key" and must survive: the camel rule demands a
    // CAPITAL, which is the whole reason `isCredentialKey` has one.
    expect(maskKeyedText(`the monkey ${long} eats`)).toContain(long);
    // And an ordinary key keeps its ordinary value — a masker that chews up
    // every line is a document nobody can read.
    expect(maskKeyedText("  model: claude-opus-5")).toBe("  model: claude-opus-5");
  });

  test("maskDeep masks a credential in a URL path and behind an argv flag", () => {
    // Two shapes no key-name and no adjacency rule can see: a hosted MCP
    // server's key lives in a URL PATH SEGMENT under the innocent field name
    // `url`, and a stdio connector's key is a SEPARATE array element from the
    // `--api-key` that names it.
    const key = ["kZ8bQ2mN", "4pR7tV1x", "Y3aC6eG9", "hJ0lO5sU"].join("");
    const masked = maskDeep({
      url: `https://eth-mainnet.g.alchemy.com/v2/${key}`,
      args: ["-y", "@acme/mcp", "--api-key", key],
      userinfo: "https://ops:hunter2please@self-hosted.invalid/mcp",
    }) as Record<string, unknown>;
    expect(JSON.stringify(masked)).not.toContain(key);
    expect(masked["url"]).toBe("https://eth-mainnet.g.alchemy.com/v2/***");
    expect(masked["args"]).toEqual(["-y", "@acme/mcp", "--api-key", "[redacted]"]);
    expect(masked["userinfo"]).toBe("https://ops:***@self-hosted.invalid/mcp");
    // …and the same hole in the YAML scanner, where the connector is written.
    expect(maskSpecYaml(`    url: https://h/v2/${key}`)).not.toContain(key);
  });

  test("maskDeep takes the env scrubber, so an OPAQUE value is replaced by its NAME", () => {
    const scrub = (text: string): string => text.split(PLANTED).join(PLANTED_MARK);
    const masked = maskDeep({ body: `the runbook says ${PLANTED} works` }, scrub) as Record<
      string,
      unknown
    >;
    expect(masked["body"]).toBe(`the runbook says ${PLANTED_MARK} works`);
    // Without the scrubber nothing can catch it — which is why it has to be
    // applied at the dispatch site rather than remembered per handler.
    expect(maskDeep({ body: PLANTED })).toEqual({ body: PLANTED });
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

/**
 * The two seams the server-level sweep can no longer observe, now that the
 * dispatch site scrubs everything on the way out — and exactly the reason to
 * pin them HERE instead of deleting them. `runDetail` is exported and driven
 * by the `crewhaus daemon` verbs, and `inspectStore` is a handler; neither is
 * entitled to assume a caller that masks. Both leaked a `.env`-held value
 * once, in payloads whose siblings did not.
 */
describe("credential hygiene (the seams, below the dispatcher)", () => {
  const scratch: string[] = [];
  afterEach(() => {
    while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
  });

  const seamHarness = (opts: Parameters<typeof makeFixtureHarness>[1]): string => {
    const root = mkdtempSync(join(tmpdir(), "hangar-mask-seam-"));
    scratch.push(root);
    return makeFixtureHarness(join(root, "seam"), opts);
  };

  test("runDetail scrubs its EVENTS, not only its prose tail", () => {
    const runId = "run_00000000000000e1";
    const dir = seamHarness({
      specName: "seam",
      envLines: [`PLANTED_SECRET=${PLANTED}`],
      runLedger: [
        {
          runId,
          kind: "daemon",
          argv: ["bun", "dist/daemon.ts"],
          startedAt: iso(NOW - 1000),
          logFile: `logs/${runId}.log`,
        },
      ],
      runLogs: [
        {
          runId,
          log: `boot PLANTED_SECRET=${PLANTED}\n`,
          events: [{ kind: "run_failed", runId, error: `auth rejected ${PLANTED}` }],
        },
      ],
    });
    const detail = runDetail(dir, runId, { env: { HOME: "/tmp" } });
    // The contradiction this closes: the SAME response served the tail as
    // `«NAME»` and the events verbatim, because the scrubber was built inside
    // the `proseTail` expression and nowhere else.
    expect(JSON.stringify(detail?.events)).not.toContain(PLANTED);
    expect(JSON.stringify(detail?.events)).toContain(PLANTED_MARK);
    expect((detail?.proseTail ?? []).join("\n")).toContain(PLANTED_MARK);
  });

  test("the inspect reader scrubs the PARSED branch, not only the text fallback", () => {
    const dir = seamHarness({
      specName: "seam",
      envLines: [`PLANTED_SECRET=${PLANTED}`],
    });
    writeFileSync(
      join(dir, ".crewhaus", "environments.json"),
      `${JSON.stringify({ protected: ["prod"], note: PLANTED })}\n`,
    );
    // A parsed document is not a safer document: key-based redaction cannot
    // see an opaque value under `note`, and no shape rule can either.
    const body = inspectStore({
      params: { store: "environments" },
      harnessDir: dir,
      env: { HOME: "/tmp" },
      contain: (segments: readonly string[]) => join(dir, ...segments),
    } as unknown as M3Context) as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain(PLANTED);
    expect(JSON.stringify(body)).toContain(PLANTED_MARK);
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

  test("an OPAQUE credential planted in EVERY store never appears in ANY response body", async () => {
    // WHY THIS TEST EXISTS, AND WHY THE OLD ONE COULD NOT HAVE CAUGHT IT.
    // Its predecessor stated exactly this intent, and planted its opaque
    // needle ONLY in `.env` — where no route ever serializes a value — so it
    // passed vacuously while twenty routes echoed the same class of
    // credential verbatim. The needle here is planted in every store a
    // harness carries, and the sweep asserts BOTH halves: that the value is
    // nowhere, and that the scrubbed NAME is somewhere, so a store that
    // silently stopped being served cannot make this pass by returning
    // nothing.
    const sess = "sess_00000000000000a1";
    const evicted = "sess_00000000000000a2";
    const runId = "run_00000000000000b1";
    const evalRun = "run_00000000000000c1";
    const t = bootTestServer({ now: () => NOW });
    servers.push(t);
    const dir = makeFixtureHarness(join(t.harnessesRoot, "opaque"), {
      specName: "opaque",
      // The manager HOLDS this value — that is what makes the scrubber able
      // to catch it, and what makes echoing it a leak rather than an unknown.
      envLines: [`PLANTED_SECRET=${PLANTED}`, "PLAIN_SETTING=ordinary"],
      specExtra: [
        "memory:",
        "  recall: true",
        "mcp_servers:",
        "  helper:",
        "    command: bunx helper-mcp",
        "    env:",
        `      HELPER_TOKEN: ${PLANTED}`,
      ].join("\n"),
      sessions: [
        {
          id: sess,
          updatedAt: iso(NOW - 3600_000),
          log: [
            logLine("user_message", { content: `deploy with ${PLANTED}` }),
            logLine("assistant_message", {
              content: [
                { type: "text", text: `noted ${PLANTED}` },
                { type: "tool_use", id: "tu_1", name: "web", input: { note: PLANTED } },
              ],
            }),
            logLine("user_message", {
              content: [{ type: "tool_result", tool_use_id: "tu_1", content: `body ${PLANTED}` }],
            }),
            logLine("user_feedback", feedbackRecord(sess, 1, "up", iso(NOW))),
          ],
        },
      ],
      sessionIndex: { [evicted]: { summarizedAt: iso(NOW), summary: `rotated ${PLANTED}` } },
      memories: {
        opaque: [
          {
            id: "mem_0000000000000001",
            text: `the deploy value is ${PLANTED}`,
            tags: [`tag-${PLANTED}`],
            createdAt: iso(NOW),
          },
        ],
      },
      wikiIndex: { note: { title: "note" } },
      wikiArticles: { note: `# notes\n\nthe helper value is ${PLANTED}\n` },
      focus: `current focus: rotate ${PLANTED}\n`,
      goals: `- id: g1\n  title: retire ${PLANTED}\n  status: active\n`,
      evalIndex: [
        {
          runId: evalRun,
          specName: "opaque",
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
          runId: evalRun,
          results: { passRate: 1 },
          samples: {
            s1: {
              grades: { pass: true, rationale: `saw ${PLANTED}` },
              meta: { input: `use ${PLANTED}` },
              transcript: [{ kind: "note", text: `quoted ${PLANTED}` }],
            },
          },
        },
      ],
      runLedger: [
        {
          runId,
          kind: "daemon",
          // The LEDGER ROW carries it too. That is the half `runDetail` does
          // not scrub for itself, so the SSE `replay` frame — the one payload
          // that never passes the JSON seam — has something of its own to
          // hide, and its scrubber cannot be quietly dropped.
          argv: ["bun", "dist/daemon.ts", "--note", PLANTED],
          startedAt: iso(NOW - 3600_000),
          logFile: `logs/${runId}.log`,
        },
        { runId, endedAt: iso(NOW), exitCode: 0 },
      ],
      runLogs: [
        {
          runId,
          log: `booting with PLANTED_SECRET=${PLANTED}\nready\n`,
          events: [{ kind: "run_failed", runId, error: `auth ${PLANTED}` }],
        },
      ],
      approvals: [
        {
          id: "appr_00000000000000d1",
          toolName: "Fetch",
          inputHash: "h",
          input: { url: "https://example.invalid", note: PLANTED },
          runId,
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
          context: `sample quoted ${PLANTED}`,
        },
      ],
      deployments: { deployments: [{ env: "prod", note: `deployed with ${PLANTED}` }] },
      // The compiled bundle is where `lowerCredential` bakes an inline spec
      // credential in as a literal, and the raw browser serves it as TEXT.
      bundle: { entry: "daemon.ts", body: `const helperToken = "${PLANTED}";\n` },
    });

    // The stores the fixture does not model, written where their readers look.
    const ch = join(dir, ".crewhaus");
    const write = (rel: string, body: string): void => {
      mkdirSync(join(ch, rel, ".."), { recursive: true });
      writeFileSync(join(ch, rel), body);
    };
    write("environments.json", `${JSON.stringify({ protected: ["prod"], note: PLANTED })}\n`);
    write(
      "settings.json",
      `${JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: [{ event: "PreToolUse", command: `curl -H "x: ${PLANTED}" https://x.invalid` }],
      })}\n`,
    );
    write(
      "advice/suggestions.json",
      `${JSON.stringify({
        generatedAt: iso(NOW),
        sessionIds: [sess],
        suggestions: [
          {
            findingId: "adv_1",
            severity: "low",
            summary: `raise the timeout, seen beside ${PLANTED}`,
            patch: {
              op: "replace",
              target: "cli",
              path: ["agent", "instructions"],
              value: `mention ${PLANTED}`,
              rationale: `because ${PLANTED}`,
            },
          },
        ],
      })}\n`,
    );
    write(
      "experiments/rollout.jsonl",
      `${JSON.stringify({ version: `v-${PLANTED}`, outcome: "success", source: PLANTED })}\n`,
    );
    write(
      "audit/2026-08-03.jsonl",
      `${JSON.stringify({
        seq: 1,
        at: iso(NOW),
        kind: "tool_call",
        payload: { detail: `used ${PLANTED}` },
        hash: "h",
        prevHash: null,
      })}\n`,
    );

    const { body: created } = await t.api("/api/harnesses", {
      method: "POST",
      body: JSON.stringify({ dir }),
    });
    const id = (created["entry"] as { id: string }).id;

    const raw = (p: string): string => `/api/h/${id}/inspect/raw?path=${encodeURIComponent(p)}`;
    const paths = [
      "/api/harnesses",
      "/api/harnesses?hydrate=1",
      "/api/approvals",
      "/api/approvals?all=1",
      "/api/review?all=1",
      "/api/activity?since=30d",
      `/api/h/${id}`,
      `/api/h/${id}/spec`,
      `/api/h/${id}/spec/schema`,
      `/api/h/${id}/spec/trust`,
      `/api/h/${id}/preflight`,
      `/api/h/${id}/sessions`,
      `/api/h/${id}/sessions/${sess}`,
      `/api/h/${id}/sessions/${sess}?raw=1`,
      `/api/h/${id}/sessions/${evicted}`,
      `/api/h/${id}/evals`,
      `/api/h/${id}/evals/${evalRun}`,
      `/api/h/${id}/evals/${evalRun}/s1`,
      `/api/h/${id}/evals/experiments`,
      `/api/h/${id}/memory/facts`,
      `/api/h/${id}/memory/facts/opaque`,
      `/api/h/${id}/memory/wiki`,
      `/api/h/${id}/memory/wiki/note`,
      `/api/h/${id}/memory/state`,
      `/api/h/${id}/memory/continuity`,
      `/api/h/${id}/feedback/advice`,
      `/api/h/${id}/audit`,
      `/api/h/${id}/runs`,
      `/api/h/${id}/runs/${runId}`,
      `/api/h/${id}/deployments`,
      `/api/h/${id}/inspect`,
      `/api/h/${id}/inspect/environments`,
      `/api/h/${id}/inspect/settings`,
      raw(".crewhaus/environments.json"),
      raw(".crewhaus/settings.json"),
      raw(".crewhaus/advice/suggestions.json"),
      raw(".crewhaus/memories/opaque.jsonl"),
      raw(".crewhaus/experiments/rollout.jsonl"),
      raw("crewhaus.yaml"),
      raw("dist/daemon.ts"),
    ];

    let marked = 0;
    for (const path of paths) {
      const res = await t.fetchRaw(path, { headers: { authorization: `Bearer ${t.token}` } });
      const text = await res.text();
      expect(`${path}:${res.status}`).toBe(`${path}:200`);
      expect(`${path}:${text.includes(PLANTED)}`).toBe(`${path}:false`);
      if (text.includes(PLANTED_MARK)) marked += 1;
    }
    // The SSE stream is the one payload that does not leave through the JSON
    // seam, so it is swept separately or it is swept by nothing.
    const stream = await t.apiText(`/api/h/${id}/runs/${runId}/events`);
    expect(stream.status).toBe(200);
    expect(stream.text).not.toContain(PLANTED);
    expect(stream.text).toContain(PLANTED_MARK);
    // …and so is the one POST on the list.
    const recall = await t.api(`/api/h/${id}/memory/recall`, {
      method: "POST",
      body: JSON.stringify({ query: "deploy" }),
    });
    expect(JSON.stringify(recall.body)).not.toContain(PLANTED);

    // ANTI-VACUITY. The value is absent above; this proves it was absent
    // because it was SCRUBBED and not because the stores were never served.
    expect(marked).toBeGreaterThanOrEqual(12);
    for (const path of [
      `/api/h/${id}/memory/facts/opaque`,
      `/api/h/${id}/memory/wiki/note`,
      `/api/h/${id}/memory/continuity`,
      `/api/h/${id}/sessions/${sess}`,
      `/api/h/${id}/sessions/${sess}?raw=1`,
      `/api/h/${id}/evals/${evalRun}/s1`,
      `/api/h/${id}/audit`,
      `/api/h/${id}/runs/${runId}`,
      `/api/h/${id}/inspect/environments`,
      `/api/h/${id}/feedback/advice`,
      "/api/approvals?all=1",
      raw(".crewhaus/memories/opaque.jsonl"),
      raw("dist/daemon.ts"),
    ]) {
      const res = await t.fetchRaw(path, { headers: { authorization: `Bearer ${t.token}` } });
      const text = await res.text();
      expect(`${path}:${text.includes(PLANTED_MARK)}`).toBe(`${path}:true`);
    }
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

describe("credentials the manager can identify from the SPEC, not just .env", () => {
  test("an inline spec credential is scrubbed wherever it is quoted, not only under its key", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "hangar-spec-scrub-")), "h");
    mkdirSync(dir, { recursive: true });
    // Short enough to miss every shape rule, and NOT in .env — so the only
    // reason the manager can know it is a credential is that it read the
    // spec and saw the key it sits under.
    const inline = ["a1b2", "c3d4", "e5f6", "g7h8"].join("");
    writeFileSync(
      join(dir, "crewhaus.yaml"),
      [
        "name: leaky",
        "target: channel",
        "channels:",
        "  slack:",
        `    signingSecret: ${inline}`,
        "agent:",
        "  model: claude-opus-5",
        "  instructions: |",
        `    the signing secret is ${inline}`,
        "",
      ].join("\n"),
    );
    expect(specCredentialValues(dir)["signingSecret"]).toBe(inline);

    // …and the scrubber built for that harness replaces it in PROSE, where
    // key-based redaction cannot reach.
    const scrub = safeSpawnEnvScrubber(dir, {});
    expect(scrub(`a note quoting ${inline} in passing`)).not.toContain(inline);

    // A `$VAR` reference is a NAME the operator needs to see, never a value.
    writeFileSync(
      join(dir, "crewhaus.yaml"),
      ["name: x", "channels:", "  slack:", "    botToken: $SLACK_BOT_TOKEN", ""].join("\n"),
    );
    expect(specCredentialValues(dir)["botToken"]).toBeUndefined();
  });

  test("an argv credential flag masks its value in TEXT, as it already did in a parsed array", () => {
    const key = ["Hy3n", "Ts8d", "Q5wF", "2gV6"].join("");
    // The parsed shape was already covered; this is the same list rendered as
    // spec text, where the `", "` separator's COMMA defeated every keyed rule.
    expect(maskText(`args: ["-y", "@acme/mcp", "--api-key", "${key}"]`)).not.toContain(key);
    expect(maskText(`--secret=${key}`)).not.toContain(key);
    // Benign flags must survive, or the console redacts its own output.
    expect(maskText("bun run dev --port 3000")).toContain("3000");
    expect(maskText("a --keyboard shortcut")).toContain("--keyboard");
  });
});
