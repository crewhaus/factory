/**
 * 0.6.0 §4.4 — the per-candidate plan table over the LIVE `runChatLoop` path
 * (plan §1's acceptance items that concern per-model tools and params, and
 * the volatile-region cache test).
 *
 *   - a `Bash` tool_use while `$fast` serves yields an `is_error` naming the
 *     profile — the dispatch SUBSET gate, not just a narrower advertisement;
 *   - `ListTools` under `$fast` lists only its tools;
 *   - the `#405 toolset` record is keyed on the UNION and does not re-fire on
 *     resume because a different candidate served;
 *   - `model_request` for each candidate carries its own maxTokens / thinking
 *     / temperature, plus `profile` / `paramsFingerprint` / `role` and the
 *     adapter's `effectiveParams` echo when it provides one;
 *   - the candidate overlay lands in the VOLATILE region after the continuity
 *     tail — never before the cache marker, never cache-marked itself;
 *   - `caching: off` strips every cache marker for that candidate;
 *   - per-candidate `permissions` narrow (a profile deny beats a yaml allow);
 *   - per-candidate `tool_config` and the serving model reach the tool's
 *     `ToolExecuteContext`;
 *   - a `vision: false` candidate is ineligible for an image turn and a
 *     vision-requiring tool is never advertised to it;
 *   - a spent per-profile `cost.max_usd` makes the candidate ineligible
 *     without ending the run;
 *   - the served wire models are written to the session's `models`;
 *   - a run WITHOUT a pool (and a pool of bare candidates) stays byte-identical
 *     on the request object and stamps nothing new.
 *
 * `policy: "static"` (always the first declared candidate) makes every
 * scenario deterministic: the candidate under test is declared first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type {
  EffectiveParams,
  ProviderAdapter,
  ProviderFeatures,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { emptyRuleSet } from "@crewhaus/permission-engine";
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { createSessionStore } from "@crewhaus/session-store";
import { buildTool } from "@crewhaus/tool-builder";
import type { ToolExecuteContext } from "@crewhaus/tool-catalog";
import type {
  ModelRequestEvent,
  ModelRouteEvent,
  ToolCallStartEvent,
  TraceEvent,
} from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { type RunChatLoopOptions, runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-plan-table-tests-"));
const TMP_ROOTS: string[] = [];
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
  for (const d of TMP_ROOTS) rmSync(d, { recursive: true, force: true });
});

const FULL: ProviderFeatures = {
  caching: "explicit",
  tool_use: true,
  vision: true,
  thinking: true,
  web_search: false,
};

type Step = { readonly tool: string; readonly input?: unknown } | { readonly text: string };

/** Scripted adapter: each call plays the next step; records every request. */
function scriptedAdapter(
  steps: ReadonlyArray<Step>,
  opts: { features?: ProviderFeatures; effectiveParams?: boolean } = {},
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  let call = 0;
  const adapter: ProviderAdapter & { requests: ProviderRequest[] } = {
    requests,
    providerId: "anthropic" as ProviderId,
    features: opts.features ?? FULL,
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      const step = steps[Math.min(call, steps.length - 1)] ?? { text: "done" };
      call++;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } };
        if ("tool" in step) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: `tu_${call}`, name: step.tool, input: {} },
          };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input ?? {}) },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield {
            kind: "message_delta",
            stopReason: "tool_use",
            usage: { input: 100, output: 10 },
          };
        } else {
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: step.text },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 100, output: 10 },
          };
        }
        yield { kind: "message_stop" };
      })();
    },
  };
  if (opts.effectiveParams) {
    adapter.effectiveParams = (req): EffectiveParams => ({
      model: req.model,
      maxTokens: req.maxTokens,
      ...(req.thinking !== undefined ? { thinking: req.thinking } : {}),
      ...(req.reasoningEffort !== undefined ? { reasoningEffort: req.reasoningEffort } : {}),
      // A "Claude 5" stub: temperature is silently dropped and reported.
      dropped: req.temperature !== undefined ? ["temperature"] : [],
    });
  }
  return adapter;
}

const FAST = "claude-haiku-4-5";
const STRONG = "claude-opus-4-8";

const bashCalls: unknown[] = [];
const cfgCalls: ToolExecuteContext[] = [];

const readTool = buildTool({
  name: "Read",
  description: "Read a file.",
  inputSchema: z.object({ path: z.string().optional() }).strict(),
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  execute: async () => "file contents",
});
const bashTool = buildTool({
  name: "Bash",
  description: "Run a shell command.",
  inputSchema: z.object({ command: z.string().optional() }).strict(),
  readOnly: false,
  destructive: true,
  concurrencySafe: false,
  execute: async (input) => {
    bashCalls.push(input);
    return "ran";
  },
});
/** A `tool_config`-bearing tool: records the execute context it receives. */
const cfgTool = buildTool({
  name: "Cfg",
  description: "Records its execute context.",
  inputSchema: z.object({}).strict(),
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  execute: async (_input, ctx) => {
    if (ctx !== undefined) cfgCalls.push(ctx);
    return "cfg ok";
  },
});
/** A vision-requiring tool (the `ReadImage` posture). */
const imageTool = buildTool({
  name: "ReadImage",
  description: "Return an image.",
  inputSchema: z.object({ path: z.string().optional() }).strict(),
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  requiresModelFeatures: { vision: true },
  execute: async () => "image",
});
const TOOLS = [readTool, bashTool, cfgTool, imageTool];

function tmpScoreboard() {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-plan-sb-"));
  TMP_ROOTS.push(dir);
  return openScoreboard(dir, { now: () => 1_700_000_000_000 });
}

type Candidate = NonNullable<RunChatLoopOptions["modelPool"]>["candidates"][number];

const FAST_PROFILE: Candidate = {
  model: FAST,
  tags: ["cheap"],
  profile: "fast",
  maxTokens: 4096,
  thinking: { effort: "low" },
  overlay: "You are the fast lane. Answer briefly.",
  tools: ["read", "cfg", "readImage"],
  toolConfigs: { cfg: { timeoutMs: 8000 } },
  permissions: { deny: ["Bash(*)"] },
};
const STRONG_PROFILE: Candidate = {
  model: STRONG,
  tags: ["strong"],
  profile: "strong",
  temperature: 0,
};

async function run(
  first: ProviderAdapter,
  second: ProviderAdapter,
  candidates: readonly Candidate[],
  extra: Partial<RunChatLoopOptions> = {},
  seed: Anthropic.MessageParam[] = [{ role: "user", content: "hello" }],
) {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const text = await runChatLoop({
    model: "claude-sonnet-4-6",
    instructions: "test harness",
    _adapter: scriptedAdapter([{ text: "primary" }]),
    tools: TOOLS,
    modelPool: { candidates, policy: "static" },
    _poolAdapters: new Map<string, ProviderAdapter>([
      [candidates[0]?.model ?? FAST, first],
      [candidates[1]?.model ?? STRONG, second],
    ]),
    _scoreboard: tmpScoreboard(),
    runContext,
    singleTurn: true,
    seedMessages: seed,
    permissionMode: "bypass",
    installSigintHandler: false,
    spinner: false,
    stdout: () => {},
    settingsDir: null,
    ...extra,
  });
  return { text, events, runContext };
}

/** The tool_result blocks the SECOND request carried (the first call's results). */
function toolResultsOf(req: ProviderRequest | undefined): Anthropic.ToolResultBlockParam[] {
  const last = req?.messages[req.messages.length - 1];
  if (last === undefined || typeof last.content === "string") return [];
  return (last.content as Anthropic.ContentBlockParam[]).filter(
    (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result",
  );
}
const resultText = (r: Anthropic.ToolResultBlockParam | undefined): string =>
  typeof r?.content === "string"
    ? r.content
    : ((r?.content ?? []) as Anthropic.ContentBlockParam[])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");

describe("plan table — per-candidate tools (§4.4 item 3, §5)", () => {
  test("a Bash tool_use while $fast serves yields an is_error naming the profile; Bash never runs", async () => {
    bashCalls.length = 0;
    const fast = scriptedAdapter([
      { tool: "Bash", input: { command: "rm -rf /" } },
      { text: "ok" },
    ]);
    const strong = scriptedAdapter([{ text: "strong" }]);
    const { events } = await run(fast, strong, [FAST_PROFILE, STRONG_PROFILE]);
    // The advertisement is the SUBSET (Read, Cfg, ReadImage, ListTools) — no Bash.
    const advertised = (fast.requests[0]?.tools ?? []).map((t) => t.name);
    expect(advertised).toEqual(["Read", "Cfg", "ReadImage", "ListTools"]);
    // ...and the dispatch gate refuses the unadvertised call, naming the profile.
    const results = toolResultsOf(fast.requests[1]);
    expect(results).toHaveLength(1);
    expect(results[0]?.is_error).toBe(true);
    expect(resultText(results[0])).toContain('tool "Bash" is not available');
    expect(resultText(results[0])).toContain('profile "fast"');
    expect(bashCalls).toEqual([]);
    // The tool events carry the serving model / profile (§5.6).
    const start = events.find((e): e is ToolCallStartEvent => e.kind === "tool_call_start");
    expect(start?.model).toBe(FAST);
    expect(start?.profile).toBe("fast");
  });

  test("ListTools under $fast lists only the profile's tools", async () => {
    const fast = scriptedAdapter([{ tool: "ListTools" }, { text: "ok" }]);
    const strong = scriptedAdapter([{ text: "strong" }]);
    await run(fast, strong, [FAST_PROFILE, STRONG_PROFILE]);
    const listing = resultText(toolResultsOf(fast.requests[1])[0]);
    expect(listing).toContain("4 tool(s)");
    expect(listing).toContain("- Read");
    expect(listing).toContain("- ListTools");
    expect(listing).not.toContain("- Bash");
  });

  test("the full toolset is advertised to the un-narrowed $strong candidate, and Bash runs there", async () => {
    bashCalls.length = 0;
    const strong = scriptedAdapter([{ tool: "Bash", input: { command: "ls" } }, { text: "ok" }]);
    const fast = scriptedAdapter([{ text: "fast" }]);
    await run(strong, fast, [STRONG_PROFILE, FAST_PROFILE]);
    const advertised = (strong.requests[0]?.tools ?? []).map((t) => t.name);
    expect(advertised).toEqual(["Read", "Bash", "Cfg", "ReadImage", "ListTools"]);
    expect(toolResultsOf(strong.requests[1])[0]?.is_error).not.toBe(true);
    expect(bashCalls).toEqual([{ command: "ls" }]);
  });

  test("the toolset record is keyed on the UNION and does not re-fire on resume; the subsets ride as `candidates`", async () => {
    const fast = scriptedAdapter([{ text: "first" }]);
    const strong = scriptedAdapter([{ text: "strong" }]);
    const { runContext } = await run(fast, strong, [FAST_PROFILE, STRONG_PROFILE]);
    const sessionId = runContext.sessionId;
    // Resume: the OTHER candidate serves (declared first now).
    const strong2 = scriptedAdapter([{ text: "resumed" }]);
    const fast2 = scriptedAdapter([{ text: "fast" }]);
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "test harness",
      _adapter: scriptedAdapter([{ text: "primary" }]),
      tools: TOOLS,
      modelPool: { candidates: [STRONG_PROFILE, FAST_PROFILE], policy: "static" },
      _poolAdapters: new Map<string, ProviderAdapter>([
        [STRONG, strong2],
        [FAST, fast2],
      ]),
      _scoreboard: tmpScoreboard(),
      runContext: createRunContext({ sessionId }),
      resume: { sessionId },
      singleTurn: true,
      seedMessages: [{ role: "user", content: "again" }],
      permissionMode: "bypass",
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
    });
    const lines = readFileSync(join(SESSION_ROOT, `${sessionId}.jsonl`), "utf-8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { kind: string; payload?: Record<string, unknown> });
    const toolsets = lines.filter((l) => l.kind === "toolset");
    expect(toolsets).toHaveLength(1);
    const payload = toolsets[0]?.payload as {
      toolNames: string[];
      candidates?: Record<string, string[]>;
    };
    expect(payload.toolNames).toEqual(["Bash", "Cfg", "ListTools", "Read", "ReadImage"]);
    expect(payload.candidates).toEqual({ fast: ["Cfg", "ListTools", "Read", "ReadImage"] });
    // No synthetic "toolset changed" marker was injected.
    expect(
      lines.some(
        (l) =>
          l.kind === "user_message" &&
          typeof l.payload?.["content"] === "string" &&
          (l.payload["content"] as string).includes("toolset changed"),
      ),
    ).toBe(false);
    // The resumed request still saw the strong candidate's full set.
    expect((strong2.requests[0]?.tools ?? []).map((t) => t.name)).toEqual([
      "Read",
      "Bash",
      "Cfg",
      "ReadImage",
      "ListTools",
    ]);
  });
});

describe("plan table — per-candidate request params (§4.4 item 1)", () => {
  test("model_request for each candidate carries its own maxTokens / thinking / temperature, profile, paramsFingerprint, role and effectiveParams", async () => {
    const fast = scriptedAdapter([{ text: "fast" }], { effectiveParams: true });
    const strong = scriptedAdapter([{ text: "strong" }], { effectiveParams: true });
    const a = await run(fast, strong, [FAST_PROFILE, STRONG_PROFILE], {
      thinking: { effort: "high" },
    });
    const fastReq = fast.requests[0];
    expect(fastReq?.maxTokens).toBe(4096);
    expect(fastReq?.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(fastReq?.reasoningEffort).toBe("low");
    expect(fastReq?.temperature).toBeUndefined();
    const fastEv = a.events.find((e): e is ModelRequestEvent => e.kind === "model_request");
    expect(fastEv?.profile).toBe("fast");
    expect(fastEv?.role).toBe("primary");
    expect(typeof fastEv?.paramsFingerprint).toBe("string");
    expect(fastEv?.toolCount).toBe(4);
    expect(fastEv?.effectiveParams).toEqual({
      model: FAST,
      maxTokens: 4096,
      thinking: { type: "enabled", budgetTokens: 2048 },
      reasoningEffort: "low",
      dropped: [],
    });

    const b = await run(strong, fast, [STRONG_PROFILE, FAST_PROFILE], {
      thinking: { effort: "high" },
    });
    const strongReq = strong.requests[0];
    // The candidate pins `temperature`, so the run's `thinking` is dropped
    // (the pair is exclusive on one request) and the run default ceiling applies.
    expect(strongReq?.temperature).toBe(0);
    expect(strongReq?.thinking).toBeUndefined();
    expect(strongReq?.reasoningEffort).toBeUndefined();
    expect(strongReq?.maxTokens).toBe(8192);
    const strongEv = b.events.find((e): e is ModelRequestEvent => e.kind === "model_request");
    expect(strongEv?.profile).toBe("strong");
    expect(strongEv?.effectiveParams?.dropped).toEqual(["temperature"]);
    expect(strongEv?.paramsFingerprint).not.toBe(fastEv?.paramsFingerprint);
  });

  test("a candidate without its own params inherits the run's thinking and the run's `temperature` option lands on a single-model run", async () => {
    const bare = scriptedAdapter([{ text: "bare" }]);
    const other = scriptedAdapter([{ text: "other" }]);
    await run(
      bare,
      other,
      [
        { model: FAST, tags: ["cheap"] },
        { model: STRONG, tags: ["strong"] },
      ],
      {
        thinking: { effort: "low" },
      },
    );
    expect(bare.requests[0]?.thinking).toEqual({ type: "enabled", budgetTokens: 2048 });
    expect(bare.requests[0]?.maxTokens).toBe(8192);

    const single = scriptedAdapter([{ text: "single" }]);
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "t",
      _adapter: single,
      temperature: 0.3,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hi" }],
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
    });
    expect(single.requests[0]?.temperature).toBe(0.3);
  });
});

describe("plan table — the volatile overlay and cache markers (§4.4)", () => {
  test("the overlay is the LAST system block, after the continuity tail, never cache-marked; the frozen prefix is untouched", async () => {
    const fast = scriptedAdapter([{ text: "fast" }]);
    const strong = scriptedAdapter([{ text: "strong" }]);
    await run(fast, strong, [FAST_PROFILE, STRONG_PROFILE]);
    const withOverlay = fast.requests[0]?.system ?? [];
    const last = withOverlay[withOverlay.length - 1];
    expect(last?.text).toBe("You are the fast lane. Answer briefly.");
    expect(last?.cache_control).toBeUndefined();
    expect(withOverlay[0]?.text).toBe("test harness");
    // Cache-marker regression: the prefix before the overlay is byte-identical
    // to the same run without an overlay, and the marker (which `manage()`
    // places on the LAST frozen block) sits at the same index in both — i.e.
    // strictly BEFORE the overlay, never on or after it.
    const plain = scriptedAdapter([{ text: "plain" }]);
    await run(plain, strong, [{ ...FAST_PROFILE, overlay: undefined }, STRONG_PROFILE]);
    const without = plain.requests[0]?.system ?? [];
    expect(withOverlay.slice(0, -1)).toEqual(without);
    const markers = (blocks: ReadonlyArray<{ cache_control?: unknown }>) =>
      blocks.map((b, i) => (b.cache_control !== undefined ? i : -1)).filter((i) => i >= 0);
    expect(markers(without)).toEqual([without.length - 1]);
    expect(markers(withOverlay)).toEqual([without.length - 1]);
  });

  test("caching: off strips every cache marker (system and transcript) for that candidate only", async () => {
    const off = scriptedAdapter([{ text: "off" }]);
    const strong = scriptedAdapter([{ text: "strong" }]);
    await run(off, strong, [{ ...FAST_PROFILE, caching: "off" }, STRONG_PROFILE]);
    for (const b of off.requests[0]?.system ?? []) expect(b.cache_control).toBeUndefined();
    const json = JSON.stringify(off.requests[0]?.messages);
    expect(json).not.toContain("cache_control");

    const on = scriptedAdapter([{ text: "on" }]);
    await run(on, strong, [FAST_PROFILE, STRONG_PROFILE]);
    expect((on.requests[0]?.system ?? []).some((b) => b.cache_control !== undefined)).toBe(true);
  });
});

describe("plan table — per-candidate permissions, tool_config, rate limits (§4.4)", () => {
  const yamlAllowBash = {
    ...emptyRuleSet,
    yaml: [{ type: "alwaysAllow" as const, pattern: "Bash", source: "yaml" as const }],
  };

  test("a profile deny narrows the run's rules at the evaluation site: an ARGUMENT-scoped deny beats the shape's yaml allow under $fast, not under $strong", async () => {
    bashCalls.length = 0;
    // `Bash(rm**)` keeps Bash ADVERTISED (only a whole-tool deny removes it
    // from the advertisement) — so this exercises `narrowRuleSet` at the
    // permission-evaluation site, not the dispatch gate.
    const fastDeny: Candidate = {
      ...FAST_PROFILE,
      tools: undefined,
      permissions: { deny: ["Bash(rm**)"] },
    };
    const fast = scriptedAdapter([
      { tool: "Bash", input: { command: "rm -rf /tmp/x" } },
      { text: "ok" },
    ]);
    const strong = scriptedAdapter([{ text: "strong" }]);
    await run(fast, strong, [fastDeny, STRONG_PROFILE], {
      permissionMode: "default",
      permissionRules: yamlAllowBash,
    });
    expect((fast.requests[0]?.tools ?? []).map((t) => t.name)).toContain("Bash");
    const denied = toolResultsOf(fast.requests[1])[0];
    expect(denied?.is_error).toBe(true);
    expect(resultText(denied)).toContain("denied");
    expect(bashCalls).toEqual([]);

    const strong2 = scriptedAdapter([
      { tool: "Bash", input: { command: "rm -rf /tmp/x" } },
      { text: "ok" },
    ]);
    await run(strong2, fast, [STRONG_PROFILE, fastDeny], {
      permissionMode: "default",
      permissionRules: yamlAllowBash,
    });
    expect(toolResultsOf(strong2.requests[1])[0]?.is_error).not.toBe(true);
    expect(bashCalls).toEqual([{ command: "rm -rf /tmp/x" }]);
  });

  test("the candidate's tool_config and the serving model reach the tool's execute context; a candidate without one hands the tool nothing", async () => {
    cfgCalls.length = 0;
    const fast = scriptedAdapter([{ tool: "Cfg" }, { text: "ok" }]);
    const strong = scriptedAdapter([{ text: "strong" }]);
    await run(fast, strong, [FAST_PROFILE, STRONG_PROFILE]);
    expect(cfgCalls).toHaveLength(1);
    expect(cfgCalls[0]?.toolConfig).toEqual({ timeoutMs: 8000 });
    expect(cfgCalls[0]?.model).toEqual({
      armId: "fast",
      wireModelId: FAST,
      specModel: FAST,
      profile: "fast",
    });

    cfgCalls.length = 0;
    const strong2 = scriptedAdapter([{ tool: "Cfg" }, { text: "ok" }]);
    await run(strong2, fast, [STRONG_PROFILE, FAST_PROFILE]);
    expect(cfgCalls[0]?.toolConfig).toBeUndefined();
    expect(cfgCalls[0]?.model?.armId).toBe("strong");
  });

  test("a candidate's rate_limits bucket paces its own tool calls (both Read calls complete under `tool:Read@fast`)", async () => {
    const limited: Candidate = {
      ...FAST_PROFILE,
      tools: undefined,
      rateLimits: { Read: { rpm: 600, burst: 1 } },
    };
    const fast = scriptedAdapter([{ tool: "Read" }, { tool: "Read" }, { text: "ok" }]);
    const strong = scriptedAdapter([{ text: "strong" }]);
    await run(fast, strong, [limited, STRONG_PROFILE]);
    expect(toolResultsOf(fast.requests[1])[0]?.is_error).not.toBe(true);
    expect(toolResultsOf(fast.requests[2])[0]?.is_error).not.toBe(true);
  });
});

describe("plan table — capability and cost eligibility (§4.4, §7.11)", () => {
  test("a vision:false candidate never gets ReadImage advertised and is ineligible for an image turn", async () => {
    const NO_VISION: ProviderFeatures = { ...FULL, vision: false };
    const blind = scriptedAdapter([{ text: "blind" }], { features: NO_VISION });
    const strong = scriptedAdapter([{ text: "strong" }]);
    // Text turn: the blind candidate serves, without ReadImage.
    const a = await run(blind, strong, [{ ...FAST_PROFILE, tools: undefined }, STRONG_PROFILE]);
    expect((blind.requests[0]?.tools ?? []).map((t) => t.name)).toEqual([
      "Read",
      "Cfg",
      "ListTools",
    ]);
    const routeA = a.events.find((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routeA?.model).toBe(FAST);
    expect(routeA?.eligible).toEqual(["fast", "strong"]);
    expect(typeof routeA?.toolsetFingerprint).toBe("string");

    // Image turn: the pick is ineligible → the strong candidate serves.
    const blind2 = scriptedAdapter([{ text: "blind" }], { features: NO_VISION });
    const strong2 = scriptedAdapter([{ text: "strong sees" }]);
    const b = await run(
      blind2,
      strong2,
      [{ ...FAST_PROFILE, tools: undefined }, STRONG_PROFILE],
      {},
      [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    );
    expect(b.text).toBe("strong sees");
    expect(blind2.requests).toHaveLength(0);
    const routeB = b.events.find((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routeB?.model).toBe(STRONG);
    expect(routeB?.eligible).toEqual(["strong"]);
    expect(routeB?.reason).toContain("fast ineligible (requires:vision)");
  });

  test("a spent per-profile cost cap makes the candidate ineligible for the next call without ending the run", async () => {
    // 1 micro-USD: any priced haiku call exceeds it, so the SECOND model call
    // of the same turn moves to the strong candidate.
    const capped: Candidate = { ...FAST_PROFILE, tools: undefined, costCapUsdMicros: 1 };
    const fast = scriptedAdapter([{ tool: "Read" }, { text: "fast again" }]);
    const strong = scriptedAdapter([{ text: "strong finishes" }]);
    const { text, events } = await run(fast, strong, [capped, STRONG_PROFILE]);
    expect(text).toBe("strong finishes");
    expect(fast.requests).toHaveLength(1);
    expect(strong.requests).toHaveLength(1);
    const routes = events.filter((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(routes.map((r) => r.model)).toEqual([FAST, STRONG]);
    expect(routes[1]?.reason).toContain("fast ineligible (cost-cap-spent)");
    expect(routes[1]?.eligible).toEqual(["strong"]);
  });
});

describe("plan table — session provenance and byte identity (§2 stance 3, design §8.1)", () => {
  test("the served wire models are written to the session's `models` in first-seen order", async () => {
    const capped: Candidate = { ...FAST_PROFILE, tools: undefined, costCapUsdMicros: 1 };
    const fast = scriptedAdapter([{ tool: "Read" }, { text: "x" }]);
    const strong = scriptedAdapter([{ text: "y" }]);
    const { runContext } = await run(fast, strong, [capped, STRONG_PROFILE]);
    const session = await createSessionStore({ rootDir: SESSION_ROOT }).get(runContext.sessionId);
    expect(session?.models).toEqual([FAST, STRONG]);
  });

  test("a run without a pool stamps nothing new: no profile / paramsFingerprint / role, no temperature, no overlay, no tool attribution", async () => {
    const single = scriptedAdapter([{ tool: "Read" }, { text: "done" }]);
    const runContext = createRunContext();
    const events: TraceEvent[] = [];
    runContext.eventBus.subscribe((e) => events.push(e));
    await runChatLoop({
      model: "claude-sonnet-4-6",
      instructions: "test harness",
      _adapter: single,
      tools: TOOLS,
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
      permissionMode: "bypass",
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
    });
    const req = single.requests[0];
    expect(req?.temperature).toBeUndefined();
    expect(req?.maxTokens).toBe(8192);
    expect(req?.system[0]?.text).toBe("test harness");
    // No overlay block: every system block is the frozen prefix (the last one
    // carries the cache marker `manage()` placed there).
    const sys = req?.system ?? [];
    expect(sys[sys.length - 1]?.cache_control).toEqual({ type: "ephemeral" });
    expect((req?.tools ?? []).map((t) => t.name)).toEqual([
      "Read",
      "Bash",
      "Cfg",
      "ReadImage",
      "ListTools",
    ]);
    const mreq = events.find((e): e is ModelRequestEvent => e.kind === "model_request");
    expect(mreq).toBeDefined();
    for (const key of ["profile", "paramsFingerprint", "role", "effectiveParams"]) {
      expect(key in (mreq as object)).toBe(false);
    }
    const tstart = events.find((e): e is ToolCallStartEvent => e.kind === "tool_call_start");
    expect(tstart).toBeDefined();
    expect("model" in (tstart as object)).toBe(false);
    expect("profile" in (tstart as object)).toBe(false);
    const lines = readFileSync(join(SESSION_ROOT, `${runContext.sessionId}.jsonl`), "utf-8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { kind: string; payload?: Record<string, unknown> });
    const toolset = lines.find((l) => l.kind === "toolset");
    expect(toolset?.payload).toEqual({
      toolNames: ["Bash", "Cfg", "ListTools", "Read", "ReadImage"],
    });
  });
});
