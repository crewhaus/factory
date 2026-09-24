/**
 * provider-limits#0 — the run's tool list against the per-request limit of
 * every model that can be sent it, checked at boot before any model call.
 *
 * On 0.7.0 an OpenAI model sent more than 128 tools (one `all-code` roll-up
 * is enough) answered every call with a 400, which the loop retried and then
 * reported as "tombstone budget exhausted"; a fallback over the limit showed
 * only as "breaker open". The compiler now refuses the builtin list; this is
 * the check that also sees the loop's own tools, MCP tools and a `--model`
 * override.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProviderAdapter,
  ProviderFeatures,
  ProviderId,
  ProviderRequest,
  StreamEvent,
} from "@crewhaus/adapter-anthropic";
import { PROVIDER_TOOL_LIMITS } from "@crewhaus/cost-tracker";
import { ConfigError } from "@crewhaus/errors";
import { parseModelString } from "@crewhaus/model-router";
import { openScoreboard } from "@crewhaus/routing-store";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import type { ModelRouteEvent, TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { type RunChatLoopOptions, runChatLoop } from "./index";
import { type ServingModel, checkServingToolLimits } from "./tool-limit";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-tool-limit-tests-"));
const TMP: string[] = [];
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
  for (const d of TMP) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The pure verdict
// ---------------------------------------------------------------------------

const serving = (model: string, toolCount: number, role: ServingModel["role"] = "serves") =>
  ({ model, toolCount, role, label: `"${model}"`, whenOver: "it is skipped" }) as const;

describe("checkServingToolLimits", () => {
  test("every serving model over its limit is fatal, naming each one", () => {
    const v = checkServingToolLimits([serving("openai/gpt-5", 141), serving("groq/x", 141)]);
    expect(v.fatal).toContain(
      '141 tools (the run\'s tools) exceed the 128-tool limit OpenAI puts on one request, so every call to model "openai/gpt-5" is refused; 141 tools',
    );
    expect(v.fatal).toContain('limit Groq puts on one request, so every call to model "groq/x"');
    expect(v.warnings).toEqual([]);
  });

  test("a degrade rung within its limit does not rescue a run no serving model can start", () => {
    const v = checkServingToolLimits([
      serving("openai/gpt-5", 141),
      serving("claude-haiku-4-5", 141, "degrade"),
    ]);
    expect(v.fatal).toBeDefined();
  });

  test("some over: one warning per model over, and the run starts", () => {
    const v = checkServingToolLimits([
      serving("claude-sonnet-4-6", 600),
      serving("openai/gpt-4o", 600),
      serving("gemini/gemini-2.5-pro", 600, "degrade"),
    ]);
    expect(v.fatal).toBeUndefined();
    expect(v.warnings.map((w) => w.slice(0, w.indexOf(":")))).toEqual([
      '"openai/gpt-4o"',
      '"gemini/gemini-2.5-pro"',
    ]);
    expect(v.warnings[0]).toContain("; it is skipped. Narrow the tools");
  });

  test("within every limit, or on routes with none: nothing to say", () => {
    expect(
      checkServingToolLimits([serving("openai/gpt-5", 128), serving("local/llama3", 9000)]),
    ).toEqual({ warnings: [] });
  });
});

describe("every limit row is a route the model router serves", () => {
  test("each prefix parses to the adapter whose API has that limit", () => {
    const rows = Object.keys(PROVIDER_TOOL_LIMITS);
    expect(rows.length).toBe(6);
    for (const prefix of rows) {
      const parsed = parseModelString(`${prefix}${prefix.endsWith("-") ? "" : "m"}x`);
      const want = PROVIDER_TOOL_LIMITS[prefix]?.maxTools === 128 ? "openai" : "gemini";
      expect({ prefix, provider: parsed.providerId }).toEqual({ prefix, provider: want });
    }
  });
});

// ---------------------------------------------------------------------------
// The boot check, through runChatLoop
// ---------------------------------------------------------------------------

const FULL: ProviderFeatures = {
  caching: false,
  tool_use: true,
  vision: false,
  thinking: false,
  web_search: false,
};

/** An adapter that answers "done" and records every request it was sent. */
function recordingAdapter(text = "done"): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    providerId: "openai" as ProviderId,
    features: FULL,
    estimateTokens: () => 0,
    stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      requests.push(req);
      return (async function* () {
        yield { kind: "message_start", usage: { input: 1, output: 0 } };
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
        yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        yield { kind: "content_block_stop", index: 0 };
        yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 1, output: 1 } };
        yield { kind: "message_stop" };
      })();
    },
  };
}

/** `count` distinct tools, named `prefix0…`; the loop adds ListTools to them. */
function tools(count: number, prefix = "Tool"): RegisteredTool[] {
  return Array.from({ length: count }, (_, i) =>
    buildTool({
      name: `${prefix}${i}`,
      description: "a tool",
      inputSchema: z.object({}).strict(),
      readOnly: true,
      destructive: false,
      concurrencySafe: true,
      execute: async () => "ok",
    }),
  );
}

async function boot(opts: Partial<RunChatLoopOptions> & Pick<RunChatLoopOptions, "model">) {
  const runContext = createRunContext();
  const events: TraceEvent[] = [];
  runContext.eventBus.subscribe((e) => events.push(e));
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const text = await runChatLoop({
      instructions: "tool limit test",
      runContext,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
      permissionMode: "bypass",
      installSigintHandler: false,
      spinner: false,
      stdout: () => {},
      settingsDir: null,
      ...opts,
    });
    return { text, events, stderr: stderr.join("") };
  } finally {
    process.stderr.write = write;
  }
}

describe("runChatLoop refuses a run no model can accept, before any call", () => {
  test("OpenAI with 130 tools: 131 with ListTools, a ConfigError, and no request sent", async () => {
    const adapter = recordingAdapter();
    const run = boot({ model: "openai/gpt-5", _adapter: adapter, tools: tools(130) });
    await expect(run).rejects.toBeInstanceOf(ConfigError);
    await expect(run).rejects.toThrow(
      '131 tools (the run\'s tools) exceed the 128-tool limit OpenAI puts on one request, so every call to model "openai/gpt-5" is refused',
    );
    expect(adapter.requests).toHaveLength(0);
  });

  test("MCP tools count: 118 tools plus 10 from a server go over", async () => {
    const adapter = recordingAdapter();
    const run = boot({
      model: "openai/gpt-5",
      _adapter: adapter,
      tools: [...tools(118), ...tools(10, "mcp__srv__t")],
    });
    await expect(run).rejects.toThrow(/129 tools/);
    expect(adapter.requests).toHaveLength(0);
  });

  test("control: exactly 128 with ListTools is sent, all 128", async () => {
    const adapter = recordingAdapter();
    const { text } = await boot({ model: "openai/gpt-5", _adapter: adapter, tools: tools(127) });
    expect(text).toBe("done");
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.tools?.length).toBe(128);
  });

  test("control: a route with no known limit is not checked", async () => {
    const adapter = recordingAdapter();
    const { text } = await boot({ model: "local/llama3", _adapter: adapter, tools: tools(300) });
    expect(text).toBe("done");
    expect(adapter.requests[0]?.tools?.length).toBe(301);
  });
});

describe("a model over its limit beside one within it", () => {
  test("a fallback over the limit: the run starts on the primary, and boot names the fallback", async () => {
    const primary = recordingAdapter("primary");
    const fallback = recordingAdapter("fallback");
    const { text, stderr } = await boot({
      model: "claude-sonnet-4-6",
      _adapter: primary,
      modelFallbacks: ["openai/gpt-4o"],
      _failoverAdapters: new Map([["openai/gpt-4o", fallback]]),
      tools: tools(140),
    });
    expect(text).toBe("primary");
    const lines = stderr.split("\n").filter((l) => l.startsWith("[tools] "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      '[tools] model_fallbacks[0] "openai/gpt-4o": 141 tools (the run\'s tools) exceed the 128-tool limit OpenAI',
    );
  });

  test("a pool candidate over the limit is left out of routing, and the next one serves", async () => {
    const wide = recordingAdapter("wide");
    const strong = recordingAdapter("strong");
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-tool-limit-sb-"));
    TMP.push(dir);
    const { text, events, stderr } = await boot({
      model: "claude-sonnet-4-6",
      _adapter: recordingAdapter("primary"),
      tools: tools(140),
      // Static policy: the first declared candidate is the pick, so the
      // limit is what moves the call.
      modelPool: {
        policy: "static",
        candidates: [
          { model: "openai/gpt-5", tags: ["cheap"] },
          { model: "claude-opus-4-8", tags: ["strong"] },
        ],
      },
      _poolAdapters: new Map([
        ["openai/gpt-5", wide],
        ["claude-opus-4-8", strong],
      ]),
      _scoreboard: openScoreboard(dir, { now: () => 1_700_000_000_000 }),
    });
    expect(text).toBe("strong");
    expect(wide.requests).toHaveLength(0);
    const route = events.find((e): e is ModelRouteEvent => e.kind === "model_route");
    expect(route?.eligible).toEqual(["claude-opus-4-8"]);
    expect(route?.reason).toContain("openai/gpt-5 ineligible (tool-limit)");
    expect(stderr).toContain(
      '[tools] model_pool candidate "openai/gpt-5": 141 tools (the run\'s tools) exceed the 128-tool limit OpenAI puts on one request, so every call to model "openai/gpt-5" is refused; routing leaves it out.',
    );
  });

  test("a pool whose every candidate is over its limit cannot start", async () => {
    const a = recordingAdapter();
    const b = recordingAdapter();
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-tool-limit-sb-"));
    TMP.push(dir);
    const run = boot({
      model: "openai/gpt-5",
      _adapter: recordingAdapter(),
      tools: tools(140),
      modelPool: {
        policy: "static",
        candidates: [
          { model: "openai/gpt-5", tags: ["cheap"] },
          { model: "azure/big", tags: ["strong"] },
        ],
      },
      _poolAdapters: new Map([
        ["openai/gpt-5", a],
        ["azure/big", b],
      ]),
      _scoreboard: openScoreboard(dir, { now: () => 1_700_000_000_000 }),
    });
    await expect(run).rejects.toBeInstanceOf(ConfigError);
    expect(a.requests.length + b.requests.length).toBe(0);
  });
});
