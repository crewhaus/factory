/**
 * A hook that cannot run denies the call it gates, and a deny another hook
 * returned in the same firing stands; a hook for an observational event that
 * cannot run never stops the turn.
 *
 * The live `runChatLoop` with the real hooks engine (no module mocks), a
 * scripted adapter, a temp harness per test, `permissionMode: "bypass"` so only
 * hooks can refuse. A hook "cannot be started" through a `Bun.spawn` spy that
 * throws for one marker command and delegates every other call to the real spawn.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { _clearEgressCache } from "@crewhaus/egress-classifier";
import type { HookDef } from "@crewhaus/hooks-engine";
import { type RunContext, createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { type RunChatLoopOptions, runChatLoop } from "./index";
import { _resetInputOriginForTest } from "./input-origin";
import { _resetRunLedgerForTest } from "./run-ledger";
import { RUN_STAMPS_ENV, _resetRunRecordsForTest } from "./run-records";

const ROOTS: string[] = [];
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "crewhaus-hook-fail-closed-")));
  ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
});

const ENV_KEYS = [
  RUN_STAMPS_ENV,
  "CREWHAUS_ADVISOR_EVENTS",
  "CREWHAUS_RUN_ID",
  "CREWHAUS_SESSION_DIR",
  "CREWHAUS_INPUT_ORIGIN",
  "CREWHAUS_WATCHME",
] as const;
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
  _resetRunRecordsForTest();
  _resetRunLedgerForTest();
  _resetInputOriginForTest();
  _clearEgressCache();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// A spawn that cannot start
// ---------------------------------------------------------------------------

/** A hook command the spawn spy refuses to start. */
const MARKER = "exit 0 # cannot-start";
const realSpawn = Bun.spawn.bind(Bun);
let spawnSpy: ReturnType<typeof spyOn> | undefined;
let throws = 0;

function spawnFailsForMarker(): void {
  throws = 0;
  spawnSpy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const first = args[0];
    if (Array.isArray(first) && first[2] === MARKER) {
      throws += 1;
      throw Object.assign(new Error("spawn failed"), { code: "EMFILE" });
    }
    return (realSpawn as (...a: unknown[]) => unknown)(...args);
  }) as unknown as typeof Bun.spawn);
}
afterEach(() => {
  spawnSpy?.mockRestore();
  spawnSpy = undefined;
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

const say = (text: string): Block => ({ type: "text", text });
const callTool = (id: string, name: string, input: unknown = {}): Block => ({
  type: "tool_use",
  id,
  name,
  input,
});

/** One script per model call (the last repeats). */
function scripted(
  scripts: ReadonlyArray<ReadonlyArray<Block>>,
): ProviderAdapter & { readonly reqs: ProviderRequest[] } {
  const reqs: ProviderRequest[] = [];
  let i = 0;
  return {
    reqs,
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: (req): AsyncIterable<StreamEvent> => {
      reqs.push(req);
      const content = scripts[Math.min(i, scripts.length - 1)] ?? [];
      i += 1;
      const hasToolUse = content.some((b) => b.type === "tool_use");
      return (async function* () {
        yield { kind: "message_start" } as const;
        for (const [idx, block] of content.entries()) {
          if (block.type === "text") {
            yield { kind: "content_block_start", index: idx, block: { type: "text", text: "" } };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: block.text },
            };
          } else {
            yield {
              kind: "content_block_start",
              index: idx,
              block: { type: "tool_use", id: block.id, name: block.name, input: {} },
            };
            yield {
              kind: "content_block_delta",
              index: idx,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
            };
          }
          yield { kind: "content_block_stop", index: idx };
        }
        yield {
          kind: "message_delta",
          stopReason: hasToolUse ? "tool_use" : "end_turn",
          usage: { input: 10, output: 5 },
        };
        yield { kind: "message_stop" };
      })();
    },
  };
}

function base(dir: string, out: string[]): RunChatLoopOptions {
  return {
    model: "test-model",
    instructions: "be brief",
    sessionRootDir: join(dir, "sessions"),
    runLedgerDir: dir,
    settingsDir: dir,
    permissionMode: "bypass",
    installSigintHandler: false,
    spinner: false,
    stdout: (c) => {
      out.push(c);
    },
    singleTurn: true,
    seedMessages: [{ role: "user", content: "go" }],
  };
}

/** A hook command answering `decision` (and `reason`). */
const hookAnswering = (decision: "allow" | "deny", reason?: string) =>
  `printf '${JSON.stringify({ decision, ...(reason !== undefined ? { reason } : {}) })}\\n'`;

const REASON = "guarded-by-policy";

/** A hook whose `matcher` cannot be read, so its firing fails before any hook runs. */
function unreadableMatcher(event: HookDef["event"]): HookDef {
  return {
    event,
    command: hookAnswering("allow"),
    get matcher(): string {
      throw new Error("matcher exploded");
    },
  };
}

/** One call of the `Guarded` tool under `hooks`, then a final `say("done")`. */
async function guardedRun(hooks: ReadonlyArray<HookDef>) {
  let executed = 0;
  const guarded = buildTool({
    name: "Guarded",
    description: "a hook guards it",
    inputSchema: z.object({}),
    readOnly: true,
    execute: async () => {
      executed += 1;
      return "ran";
    },
  });
  const ctx: RunContext = createRunContext();
  const warn = spyOn(ctx.logger, "warn");
  const events: TraceEvent[] = [];
  const off = ctx.eventBus.subscribe((e) => {
    events.push(e);
  });
  const adapter = scripted([[callTool("tu_g", "Guarded")], [say("done")]]);
  const out: string[] = [];
  const dir = tempDir();
  let caught: unknown;
  let result: string | undefined;
  try {
    try {
      result = await runChatLoop({
        ...base(dir, out),
        tools: [guarded],
        hooks: [...hooks],
        _adapter: adapter,
        runContext: ctx,
      });
    } catch (err) {
      caught = err;
    }
    const results = (adapter.reqs[1]?.messages ?? []).flatMap((m) =>
      typeof m.content === "string"
        ? []
        : m.content.filter(
            (b): b is Extract<(typeof m.content)[number], { type: "tool_result" }> =>
              b.type === "tool_result" && b.tool_use_id === "tu_g",
          ),
    );
    const warned = warn.mock.calls.map((c) => c[0]);
    const fired = events.filter(
      (e): e is Extract<TraceEvent, { kind: "hook_fired" }> => e.kind === "hook_fired",
    );
    return { caught, result, executed, results, warned, fired, reqs: adapter.reqs, out };
  } finally {
    off();
    warn.mockRestore();
  }
}

// ---------------------------------------------------------------------------
// Gating events
// ---------------------------------------------------------------------------

describe("a hook that cannot run denies the call it gates", () => {
  test("a printf deny hook alone refuses the tool call", async () => {
    const g = await guardedRun([
      { event: "pre-tool", matcher: "Guarded", command: hookAnswering("deny", REASON) },
    ]);
    expect(g.caught).toBeUndefined();
    expect(g.executed).toBe(0);
    expect(g.results).toHaveLength(1);
    expect(g.results[0]?.is_error).toBe(true);
    expect(g.results[0]?.content).toBe(`[blocked by hook] ${REASON}`);
  });

  test("a deny a hook wrote before it exited stands while its output pipe stays open", async () => {
    // The backgrounded `sleep` keeps the hook's stdout open past the hook's exit.
    const g = await guardedRun([
      {
        event: "pre-tool",
        matcher: "Guarded",
        command: `${hookAnswering("deny", REASON)}; sleep 2 &`,
      },
    ]);
    expect(g.caught).toBeUndefined();
    expect(g.executed).toBe(0);
    expect(g.results).toHaveLength(1);
    expect(g.results[0]?.is_error).toBe(true);
    expect(g.results[0]?.content).toBe(`[blocked by hook] ${REASON}`);
  });

  for (const order of ["deny first", "cannot-start first"] as const) {
    test(`a deny stands beside a hook that cannot be started (${order})`, async () => {
      spawnFailsForMarker();
      const deny: HookDef = {
        event: "pre-tool",
        matcher: "Guarded",
        command: hookAnswering("deny", REASON),
      };
      const cannot: HookDef = { event: "pre-tool", matcher: "Guarded", command: MARKER };
      const g = await guardedRun(order === "deny first" ? [deny, cannot] : [cannot, deny]);
      expect(throws).toBeGreaterThanOrEqual(1);
      expect(g.caught).toBeUndefined();
      expect(g.executed).toBe(0);
      expect(g.results).toHaveLength(1);
      expect(g.results[0]?.is_error).toBe(true);
      const content = String(g.results[0]?.content);
      expect(content.startsWith("[blocked by hook] ")).toBe(true);
      if (order === "deny first") expect(content).toBe(`[blocked by hook] ${REASON}`);
      else expect(content).toBe("[blocked by hook] hook could not run");
    });
  }

  test("a hook that cannot be started denies the tool call it gates", async () => {
    spawnFailsForMarker();
    const g = await guardedRun([{ event: "pre-tool", matcher: "Guarded", command: MARKER }]);
    expect(throws).toBeGreaterThanOrEqual(1);
    expect(g.caught).toBeUndefined();
    expect(g.executed).toBe(0);
    expect(g.results).toHaveLength(1);
    expect(g.results[0]?.is_error).toBe(true);
    expect(g.results[0]?.content).toBe("[blocked by hook] hook could not run");
  });

  test("a firing that fails before any hook runs denies the tool call", async () => {
    const g = await guardedRun([unreadableMatcher("pre-tool")]);
    expect(g.caught).toBeUndefined();
    expect(g.executed).toBe(0);
    expect(g.results).toHaveLength(1);
    expect(g.results[0]?.is_error).toBe(true);
    expect(g.results[0]?.content).toBe("[blocked by hook] hook firing failed");
    expect(g.warned).toContain("hook firing failed");
  });

  test("a pre-model hook that cannot be started refuses the model call", async () => {
    spawnFailsForMarker();
    const g = await guardedRun([{ event: "pre-model", command: MARKER }]);
    expect(throws).toBeGreaterThanOrEqual(1);
    expect(g.caught).toBeUndefined();
    expect(g.reqs).toHaveLength(0);
    expect(g.executed).toBe(0);
    expect(g.out.join("")).toContain("[blocked by hook] hook could not run");
  });
});

// ---------------------------------------------------------------------------
// Observational events
// ---------------------------------------------------------------------------

describe("an observational hook that cannot run never stops the turn", () => {
  test("post-tool and session-start hooks that cannot be started are recorded as not allowed", async () => {
    spawnFailsForMarker();
    const g = await guardedRun([
      { event: "post-tool", matcher: "Guarded", command: MARKER },
      { event: "session-start", command: MARKER },
    ]);
    expect(throws).toBeGreaterThanOrEqual(2);
    expect(g.caught).toBeUndefined();
    expect(g.executed).toBe(1);
    expect(g.results).toHaveLength(1);
    expect(g.results[0]?.is_error).not.toBe(true);
    expect(g.result).toBe("done");
    for (const event of ["post-tool", "session-start"]) {
      const fired = g.fired.filter((e) => e.event === event);
      expect(fired).toHaveLength(1);
      expect(fired[0]?.allowed).toBe(false);
      expect(fired[0]?.reason).toBe("hook could not run");
    }
  });

  test("a post-tool firing that fails is logged and the turn goes on", async () => {
    const g = await guardedRun([unreadableMatcher("post-tool")]);
    expect(g.caught).toBeUndefined();
    expect(g.executed).toBe(1);
    expect(g.results).toHaveLength(1);
    expect(g.results[0]?.is_error).not.toBe(true);
    expect(g.result).toBe("done");
    expect(g.warned).toContain("hook firing failed");
    expect(g.warned).not.toContain("post-tool hook denied");
  });
});
