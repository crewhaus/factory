/**
 * "Watch me" §6.1 — the live capture tap (`attachWatchmeCapture`): gated on
 * CREWHAUS_WATCHME, writes bus-only TraceEvents (envelope included) to the
 * `sessions/<id>.events.jsonl` sibling, skips ephemeral + durably-mirrored
 * kinds (zero kind-overlap with the session `.jsonl` is a pinned invariant),
 * 0600 mode, and swallows every append failure.
 *
 * The fixture-run tests drive the real `runChatLoop` with stub adapters (the
 * advisor-persist.test.ts posture) and assert on the on-disk files.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { createRunContext } from "@crewhaus/run-context";
import { buildTool } from "@crewhaus/tool-builder";
import type { TraceEvent } from "@crewhaus/trace-event-bus";
import { z } from "zod";
import { runChatLoop } from "./index";
import { WATCHME_MIRRORED_KINDS, attachWatchmeCapture } from "./observability";

let sessionRoot: string;
const savedGate = process.env["CREWHAUS_WATCHME"];

beforeEach(() => {
  sessionRoot = mkdtempSync(join(tmpdir(), "crewhaus-watchme-capture-"));
});
afterEach(() => {
  rmSync(sessionRoot, { recursive: true, force: true });
  process.env["CREWHAUS_WATCHME"] = savedGate;
});

type CapturedLine = { kind: string } & Record<string, unknown>;

function readEventsFile(path: string): CapturedLine[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as CapturedLine);
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

const echoTool = () =>
  buildTool({
    name: "echo",
    description: "echoes",
    inputSchema: z.object({ msg: z.string() }),
    execute: async (input) => `echoed: ${input.msg}`,
  });

describe("attachWatchmeCapture gating", () => {
  test("returns undefined unless CREWHAUS_WATCHME is 1|true", () => {
    const runContext = createRunContext();
    for (const env of [{}, { CREWHAUS_WATCHME: "0" }, { CREWHAUS_WATCHME: "false" }]) {
      expect(
        attachWatchmeCapture(runContext.eventBus, sessionRoot, runContext.sessionId, env),
      ).toBeUndefined();
    }
    for (const on of ["1", "true"]) {
      const attached = attachWatchmeCapture(
        runContext.eventBus,
        sessionRoot,
        runContext.sessionId,
        {
          CREWHAUS_WATCHME: on,
        },
      );
      expect(attached).toBeDefined();
      attached?.unsubscribe();
    }
  });
});

describe("attachWatchmeCapture — sibling contents", () => {
  function attachOnFreshBus() {
    const runContext = createRunContext();
    const attached = attachWatchmeCapture(runContext.eventBus, sessionRoot, runContext.sessionId, {
      CREWHAUS_WATCHME: "1",
    });
    if (attached === undefined) throw new Error("unreachable: gate is on");
    const path = join(sessionRoot, `${runContext.sessionId}.events.jsonl`);
    return { runContext, bus: runContext.eventBus, attached, path };
  }

  test("bus-only kinds land as one JSON line each, envelope included", async () => {
    const { bus, attached, path, runContext } = attachOnFreshBus();
    bus.publish({
      ...bus.envelope(),
      kind: "model_request",
      model: "claude-sonnet-4-6",
      messageCount: 3,
      toolCount: 1,
      streaming: false,
    });
    bus.publish({
      ...bus.envelope(),
      kind: "model_response",
      model: "claude-sonnet-4-6",
      stopReason: "end_turn",
      usage: { input: 100, output: 10 },
      durationMs: 5,
    });
    await bus.flush();
    const lines = readEventsFile(path);
    expect(lines.map((l) => l.kind)).toEqual(["model_request", "model_response"]);
    for (const line of lines) {
      expect(line["sessionId"]).toBe(runContext.sessionId);
      expect(typeof line["runId"]).toBe("string");
      expect(typeof line["turnNumber"]).toBe("number");
      expect(typeof line["traceId"]).toBe("string");
      expect(typeof line["spanId"]).toBe("string");
      expect(typeof line["timestamp"]).toBe("string");
    }
    attached.unsubscribe();
  });

  test("ephemeral stream kinds and mirrored kinds never land", async () => {
    const { bus, attached, path } = attachOnFreshBus();
    bus.publish(
      { ...bus.envelope(), kind: "model_stream_token", chunkIndex: 0, deltaChars: 4 },
      { ephemeral: true },
    );
    bus.publish(
      {
        ...bus.envelope(),
        kind: "tool_stream_chunk",
        toolUseId: "tu_1",
        toolName: "bash",
        stream: "stdout",
        bytes: 12,
      },
      { ephemeral: true },
    );
    // Mirrored kinds — durable copies already land in the session .jsonl.
    bus.publish({
      ...bus.envelope(),
      kind: "cost_accrual",
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      inputTokens: 100,
      outputTokens: 10,
      cachedReadTokens: 0,
      costUsdMicros: 42,
    });
    bus.publish({
      ...bus.envelope(),
      kind: "model_route",
      routeKey: "hard",
      model: "claude-sonnet-4-6",
      policy: "static",
      reason: "test",
    });
    bus.publish({
      ...bus.envelope(),
      kind: "run_failed",
      class: "unknown",
      message: "boom",
      exitCode: 1,
    });
    // One bus-only kind so the file provably exists.
    bus.publish({ ...bus.envelope(), kind: "turn_start", turn: 1, messageCount: 1 });
    await bus.flush();
    expect(readEventsFile(path).map((l) => l.kind)).toEqual(["turn_start"]);
    attached.unsubscribe();
  });

  test("the sibling is created owner-only (0600)", async () => {
    const { bus, attached, path } = attachOnFreshBus();
    bus.publish({ ...bus.envelope(), kind: "turn_start", turn: 1, messageCount: 1 });
    await bus.flush();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    attached.unsubscribe();
  });

  test("append failures are swallowed and other subscribers still run", async () => {
    const runContext = createRunContext();
    // A sessionsDir that is a regular FILE makes every append throw ENOTDIR.
    const bogusDir = join(sessionRoot, "not-a-dir");
    writeFileSync(bogusDir, "x");
    const attached = attachWatchmeCapture(runContext.eventBus, bogusDir, runContext.sessionId, {
      CREWHAUS_WATCHME: "1",
    });
    expect(attached).toBeDefined();
    const seen: string[] = [];
    const unsubscribe = runContext.eventBus.subscribe((event: TraceEvent): void => {
      seen.push(event.kind);
    });
    expect(() => {
      runContext.eventBus.publish({
        ...runContext.eventBus.envelope(),
        kind: "turn_start",
        turn: 1,
        messageCount: 1,
      });
    }).not.toThrow();
    await runContext.eventBus.flush();
    expect(seen).toEqual(["turn_start"]);
    unsubscribe();
    attached?.unsubscribe();
  });
});

describe("watchme capture on a fixture run (zero kind-overlap invariant)", () => {
  async function runFixture(): Promise<{ sessionKinds: Set<string>; siblingKinds: Set<string> }> {
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
    const files = readdirSync(sessionRoot);
    const sessionKinds = new Set<string>();
    for (const f of files.filter((f) => f.endsWith(".jsonl") && !f.endsWith(".events.jsonl"))) {
      for (const line of readFileSync(join(sessionRoot, f), "utf-8").split("\n")) {
        if (line === "") continue;
        sessionKinds.add((JSON.parse(line) as CapturedLine).kind);
      }
    }
    const siblingKinds = new Set<string>();
    for (const f of files.filter((f) => f.endsWith(".events.jsonl"))) {
      for (const line of readEventsFile(join(sessionRoot, f))) {
        siblingKinds.add(line.kind);
      }
    }
    return { sessionKinds, siblingKinds };
  }

  test("CREWHAUS_WATCHME=1 writes the sibling; its kinds never overlap the session log's", async () => {
    process.env["CREWHAUS_WATCHME"] = "1";
    const { sessionKinds, siblingKinds } = await runFixture();
    // The tap captured the bus-only signal (exact model attribution rides
    // model_response's envelope turnNumber).
    expect(siblingKinds.has("model_request")).toBe(true);
    expect(siblingKinds.has("model_response")).toBe(true);
    // The transcript + advisor mirrors still landed in the session log.
    expect(sessionKinds.has("assistant_message")).toBe(true);
    expect(sessionKinds.has("model_meta")).toBe(true);
    // Pinned invariant: the two files' kind vocabularies are disjoint.
    for (const kind of siblingKinds) {
      expect(sessionKinds.has(kind)).toBe(false);
      expect(WATCHME_MIRRORED_KINDS.has(kind)).toBe(false);
    }
    // And the durable vocabulary is exactly what the tap refuses to duplicate.
    for (const kind of sessionKinds) {
      expect(WATCHME_MIRRORED_KINDS.has(kind)).toBe(true);
    }
  });

  test("gate off (CREWHAUS_WATCHME=0) → no sibling file, session log untouched", async () => {
    process.env["CREWHAUS_WATCHME"] = "0";
    const { sessionKinds, siblingKinds } = await runFixture();
    expect(siblingKinds.size).toBe(0);
    expect(readdirSync(sessionRoot).some((f) => f.endsWith(".events.jsonl"))).toBe(false);
    expect(sessionKinds.has("assistant_message")).toBe(true);
  });
});
