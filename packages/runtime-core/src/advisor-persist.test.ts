/**
 * Advisor groundwork (item 14) — persistence of trace-bus-only signals into
 * the session JSONL: `recovery`, `tool_stats`, `permission` (with the ask
 * RESOLUTION), and `model_meta`.
 *
 * These tests drive the real `runChatLoop` with stub adapters (the
 * cost-persist.test.ts posture) and assert on the on-disk JSONL: the new
 * lines appear by default, disappear under CREWHAUS_ADVISOR_EVENTS=0, and
 * never disturb `--resume` (replayMessageHistory skips them).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { openEventLog } from "@crewhaus/event-log";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { replayMessageHistory, runChatLoop } from "./index";
import { attachAdvisorPersistence } from "./observability";

let sessionRoot: string;
const savedGate = process.env["CREWHAUS_ADVISOR_EVENTS"];

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "crewhaus-advisor-persist-"));
});
afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
  process.env["CREWHAUS_ADVISOR_EVENTS"] = savedGate;
});

type LoggedLine = { kind: string; payload?: Record<string, unknown> };

function readLines(): LoggedLine[] {
  const out: LoggedLine[] = [];
  for (const file of readdirSync(sessionRoot).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(sessionRoot, file), "utf-8").split("\n")) {
      if (line === "") continue;
      out.push(JSON.parse(line) as LoggedLine);
    }
  }
  return out;
}

function linesOf(kind: string): LoggedLine[] {
  return readLines().filter((l) => l.kind === kind);
}

/** Text-only adapter: one clean end_turn response. */
function makeTextAdapter(): ProviderAdapter {
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: () =>
      (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } } as const;
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: 100, output: 10 },
        } as const;
        yield { kind: "message_stop" } as const;
      })(),
  };
}

/** First turn calls `echo`, second turn answers with text. */
function makeToolAdapter(): ProviderAdapter {
  let i = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: () => {
      const first = i === 0;
      i += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } } as const;
        if (first) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "tu_1", name: "echo", input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify({ msg: "hi" }) },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "tool_use",
            usage: { input: 100, output: 20 },
          } as const;
        } else {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "text", text: "" },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "done" },
          } as const;
          yield { kind: "content_block_stop", index: 0 } as const;
          yield {
            kind: "message_delta",
            stopReason: "end_turn",
            usage: { input: 150, output: 10 },
          } as const;
        }
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

/** First response is cut off (`max_tokens`), the continue-retry completes. */
function makeTruncatedThenOkAdapter(): ProviderAdapter {
  let i = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: false,
      web_search: false,
    },
    estimateTokens: () => 0,
    stream: () => {
      const first = i === 0;
      i += 1;
      return (async function* () {
        yield { kind: "message_start", usage: { input: 100, output: 0 } } as const;
        yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } } as const;
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: first ? "partial" : "rest" },
        } as const;
        yield { kind: "content_block_stop", index: 0 } as const;
        yield {
          kind: "message_delta",
          stopReason: first ? "max_tokens" : "end_turn",
          usage: { input: 100, output: 10 },
        } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

const echoTool = () =>
  buildTool({
    name: "echo",
    description: "echoes",
    inputSchema: z.object({ msg: z.string() }),
    execute: async (input) => `echoed: ${input.msg}`,
  });

describe("attachAdvisorPersistence gating", () => {
  test("attaches on an empty env (default-on) and detaches under 0/false", async () => {
    const runContext = createRunContext();
    const log = await openEventLog(runContext.sessionId, { rootDir: sessionRoot });
    const attached = attachAdvisorPersistence(runContext.eventBus, log, runContext, {});
    expect(attached).toBeDefined();
    attached?.unsubscribe();
    for (const off of ["0", "false"]) {
      expect(
        attachAdvisorPersistence(runContext.eventBus, log, runContext, {
          CREWHAUS_ADVISOR_EVENTS: off,
        }),
      ).toBeUndefined();
    }
    await log.close();
  });
});

describe("in-run digest tally (item 14)", () => {
  async function attachOnFreshLog() {
    const runContext = createRunContext();
    const log = await openEventLog(runContext.sessionId, { rootDir: sessionRoot });
    const attached = attachAdvisorPersistence(runContext.eventBus, log, runContext, {});
    if (attached === undefined) throw new Error("unreachable: empty env attaches");
    return { runContext, log, attached };
  }

  test("no events → no digest line", async () => {
    const { attached, log } = await attachOnFreshLog();
    expect(attached.digestLine()).toBeUndefined();
    attached.unsubscribe();
    await log.close();
  });

  test("a failing tool at the threshold (5 calls, 50% errors) trips one finding", async () => {
    const { runContext, attached, log } = await attachOnFreshLog();
    const bus = runContext.eventBus;
    for (let i = 0; i < 5; i++) {
      bus.publish({
        ...bus.envelope(),
        kind: "tool_call_end",
        toolUseId: `tu_${i}`,
        toolName: "Fetch",
        isError: i < 3, // 3/5 = 60% ≥ 50%
        outputBytes: 1,
        durationMs: 5,
      });
    }
    await bus.flush();
    expect(attached.digestLine()).toBe(
      `advisor: 1 finding — run \`crewhaus advise --session ${runContext.sessionId}\``,
    );
    attached.unsubscribe();
    await log.close();
  });

  test("below-threshold activity stays silent; multiple trips pluralize", async () => {
    const { runContext, attached, log } = await attachOnFreshLog();
    const bus = runContext.eventBus;
    // 4 calls (below the 5-call floor) → silent even at 100% errors.
    for (let i = 0; i < 4; i++) {
      bus.publish({
        ...bus.envelope(),
        kind: "tool_call_end",
        toolUseId: `tu_${i}`,
        toolName: "Bash",
        isError: true,
        outputBytes: 1,
        durationMs: 5,
      });
    }
    await bus.flush();
    expect(attached.digestLine()).toBeUndefined();
    // Trip two independent categories: truncation continues + compaction thrash.
    for (let i = 0; i < 2; i++) {
      bus.publish({
        ...bus.envelope(),
        kind: "error_recovered",
        action: "continue",
        errorName: "MaxTokensError",
        depth: i + 1,
      });
    }
    for (let i = 0; i < 3; i++) {
      bus.publish({
        ...bus.envelope(),
        kind: "compaction_fired",
        subKind: "snip",
        before: 40,
        after: 20,
        phase: "pre-turn",
      });
    }
    await bus.flush();
    expect(attached.digestLine()).toBe(
      `advisor: 2 findings — run \`crewhaus advise --session ${runContext.sessionId}\``,
    );
    attached.unsubscribe();
    await log.close();
  });

  test("permission churn (3 asks, all approved) and stop anomalies each trip", async () => {
    const { runContext, attached, log } = await attachOnFreshLog();
    const bus = runContext.eventBus;
    for (let i = 0; i < 3; i++) {
      bus.publish({
        ...bus.envelope(),
        kind: "permission_decision",
        toolName: "Write",
        decision: "ask",
        mode: "default",
        askOutcome: "approved",
      });
    }
    for (let i = 0; i < 4; i++) {
      bus.publish({
        ...bus.envelope(),
        kind: "model_response",
        model: "m",
        stopReason: i === 0 ? "max_tokens" : "end_turn", // 1/4 = 25% ≥ 25%
        usage: { input: 1, output: 1 },
        durationMs: 1,
      });
    }
    await bus.flush();
    expect(attached.digestLine()).toMatch(/^advisor: 2 findings — /);
    attached.unsubscribe();
    await log.close();
  });

  test("a denied ask breaks the 100%-approved churn condition", async () => {
    const { runContext, attached, log } = await attachOnFreshLog();
    const bus = runContext.eventBus;
    for (let i = 0; i < 3; i++) {
      bus.publish({
        ...bus.envelope(),
        kind: "permission_decision",
        toolName: "Write",
        decision: "ask",
        mode: "default",
        askOutcome: i === 0 ? "denied" : "approved",
      });
    }
    await bus.flush();
    expect(attached.digestLine()).toBeUndefined();
    attached.unsubscribe();
    await log.close();
  });
});

describe("advisor signal persistence (item 14 groundwork)", () => {
  test("model_meta persists per model_response by default (gate unset)", async () => {
    // Any value other than "0"/"false" (including the unset default) keeps
    // the subscriber attached; "1" stands in for the unset default because
    // biome's noDelete rule forbids actually unsetting the var here.
    process.env["CREWHAUS_ADVISOR_EVENTS"] = "1";
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      _adapter: makeTextAdapter(),
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "hello" }],
      sessionRootDir: sessionRoot,
    });
    const meta = linesOf("model_meta");
    expect(meta.length).toBe(1);
    expect(meta[0]?.payload).toEqual({ stopReason: "end_turn", model: "test-model" });
  });

  test("CREWHAUS_ADVISOR_EVENTS=0 disables all advisor lines", async () => {
    process.env["CREWHAUS_ADVISOR_EVENTS"] = "0";
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      _adapter: makeToolAdapter(),
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [echoTool()],
      permissionMode: "bypass",
      sessionRootDir: sessionRoot,
    });
    for (const kind of ["model_meta", "tool_stats", "permission", "recovery"]) {
      expect(linesOf(kind).length).toBe(0);
    }
    // The ordinary transcript still landed.
    expect(linesOf("assistant_message").length).toBeGreaterThan(0);
  });

  test("tool_stats persists one line per tool call with rounded durationMs", async () => {
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      _adapter: makeToolAdapter(),
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [echoTool()],
      permissionMode: "bypass",
      sessionRootDir: sessionRoot,
    });
    const stats = linesOf("tool_stats");
    expect(stats.length).toBe(1);
    expect(stats[0]?.payload?.["toolName"]).toBe("echo");
    expect(stats[0]?.payload?.["isError"]).toBe(false);
    const duration = stats[0]?.payload?.["durationMs"];
    expect(typeof duration).toBe("number");
    expect(Number.isInteger(duration)).toBe(true);
  });

  test("single-turn ask (no prompter) persists the collapsed-to-deny resolution", async () => {
    // default mode + no rules: `echo` decides "ask"; single-turn mode has no
    // interactive surface, so the ask collapses to a deny — the resolution
    // line must record askOutcome "denied" (and only ONE ask line persists:
    // the pre-prompt publish is skipped).
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      _adapter: makeToolAdapter(),
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [echoTool()],
      permissionMode: "default",
      sessionRootDir: sessionRoot,
    });
    const asks = linesOf("permission").filter((l) => l.payload?.["decision"] === "ask");
    expect(asks.length).toBe(1);
    expect(asks[0]?.payload).toEqual({
      toolName: "echo",
      decision: "ask",
      askOutcome: "denied",
    });
    // The denied call still produced a tool_stats line (isError true).
    expect(linesOf("tool_stats")[0]?.payload?.["isError"]).toBe(true);
  });

  test("REPL ask answered y persists askOutcome approved", async () => {
    // Reactively feed the approval answer when the prompt actually appears
    // (the index-coverage.test.ts REPL-ask posture) — pre-queued lines are
    // lost to readline while no question is pending, and ending the stream
    // early loses the ask to the close-signal race (closed stdin ⇒ deny).
    const input = new PassThrough();
    let answered = false;
    let finished = false;
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      const s = String(chunk);
      if (!answered && s.includes("approve echo")) {
        answered = true;
        queueMicrotask(() => input.write("y\n"));
      }
      if (answered && !finished && s.includes("done")) {
        finished = true;
        queueMicrotask(() => {
          input.write("exit\n");
          input.end();
        });
      }
      return true;
    }) as typeof process.stdout.write);
    input.write("run it\n");
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "test",
        _adapter: makeToolAdapter(),
        runContext: createRunContext(),
        input,
        tools: [echoTool()],
        permissionMode: "default",
        sessionRootDir: sessionRoot,
      });
    } finally {
      spy.mockRestore();
    }
    expect(answered).toBe(true);
    const asks = linesOf("permission").filter((l) => l.payload?.["decision"] === "ask");
    expect(asks.length).toBe(1);
    expect(asks[0]?.payload?.["askOutcome"]).toBe("approved");
    // Approved → the tool actually ran cleanly.
    expect(linesOf("tool_stats")[0]?.payload?.["isError"]).toBe(false);
  });

  test("allow decisions persist with askOutcome null", async () => {
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      _adapter: makeToolAdapter(),
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [echoTool()],
      permissionMode: "bypass",
      sessionRootDir: sessionRoot,
    });
    const perms = linesOf("permission");
    expect(perms.length).toBe(1);
    expect(perms[0]?.payload).toEqual({ toolName: "echo", decision: "allow", askOutcome: null });
  });

  test("max_tokens truncation persists a recovery line (action continue) and both stop reasons", async () => {
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      _adapter: makeTruncatedThenOkAdapter(),
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "write a lot" }],
      sessionRootDir: sessionRoot,
    });
    const recoveries = linesOf("recovery");
    expect(recoveries.length).toBe(1);
    expect(recoveries[0]?.payload).toEqual({
      errorName: "MaxTokensError",
      action: "continue",
      depth: 1,
    });
    const stops = linesOf("model_meta").map((l) => l.payload?.["stopReason"]);
    expect(stops).toEqual(["max_tokens", "end_turn"]);
  });

  test("a log carrying advisor kinds still replays to messages only (resume-safe)", async () => {
    await runChatLoop({
      model: "test-model",
      instructions: "test",
      _adapter: makeToolAdapter(),
      runContext: createRunContext(),
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [echoTool()],
      permissionMode: "bypass",
      sessionRootDir: sessionRoot,
    });
    // The run above persisted tool_stats/permission/model_meta alongside the
    // transcript; replay must surface ONLY the conversational events.
    const file = readdirSync(sessionRoot).find((f) => f.endsWith(".jsonl"));
    expect(file).toBeDefined();
    const sessionId = (file as string).replace(/\.jsonl$/, "");
    const log = await openEventLog(sessionId, { rootDir: sessionRoot });
    const replayed = await replayMessageHistory(log);
    await log.close();
    expect(replayed.length).toBeGreaterThanOrEqual(3); // user, assistant(tool_use), user(tool_result), assistant(text)
    for (const m of replayed) {
      expect(m.role === "user" || m.role === "assistant").toBe(true);
    }
  });
});
