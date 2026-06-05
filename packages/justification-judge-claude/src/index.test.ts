import { describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { CrewhausError } from "@crewhaus/errors";
import {
  ClaudeJustificationJudge,
  ClaudeJustificationJudgeError,
  createClaudeJustificationJudge,
} from "./index";

/**
 * Build a mock provider adapter whose `.stream()` yields the StreamEvent
 * sequence that produces a single text message with the given content.
 * Matches the canonical event protocol consumed by
 * `consumeStream`/`collectFinalMessage` — identical to the generator in
 * `prompt-optimizer-claude/src/index.test.ts`. No network: deterministic.
 */
function mockAdapter(
  content: string,
  usage: { input: number; output: number; cacheRead?: number } = { input: 0, output: 0 },
): ProviderAdapter {
  return {
    id: "mock",
    features: {
      caching: "none",
      thinking: false,
      multimodal: { input: false, output: false },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    stream(_params: any): AsyncIterable<any> {
      return (async function* () {
        yield {
          kind: "message_start",
          usage: {
            input: usage.input,
            output: 0,
            ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
          },
        };
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        };
        yield {
          kind: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: content },
        };
        yield { kind: "content_block_stop", index: 0 };
        yield {
          kind: "message_delta",
          stopReason: "end_turn",
          usage: { input: usage.input, output: usage.output },
        };
        yield { kind: "message_stop" };
      })();
    },
  } as unknown as ProviderAdapter;
}

/** An adapter whose stream throws before yielding anything. */
function throwingAdapter(message: string): ProviderAdapter {
  return {
    id: "mock",
    features: { caching: "none", thinking: false, multimodal: { input: false, output: false } },
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock
    stream(_params: any): AsyncIterable<any> {
      return (async function* () {
        throw new Error(message);
        // biome-ignore lint/correctness/noUnreachable: keep typed as async generator
        yield;
      })();
    },
  } as unknown as ProviderAdapter;
}

const GATE_INPUT = {
  toolName: "SendMessage",
  justification: "user asked me to acknowledge their ticket per the session goal",
  sessionGoal: "Acknowledge support tickets the user points you at.",
  input: { to: "user", body: "got it, looking into your ticket now" },
} as const;

describe("ClaudeJustificationJudge", () => {
  test("parses a clean allow verdict and records the judge identity", async () => {
    const adapter = mockAdapter(
      `{"allow": true, "reason": "justification matches the ticket-acknowledgement goal", "confidence": 0.9}`,
    );
    const judge = new ClaudeJustificationJudge({ adapter, model: "claude-haiku-4-5" });
    const verdict = await judge.judge(GATE_INPUT);
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toContain("acknowledgement");
    expect(verdict.confidence).toBe(0.9);
    // judge-identity recorded: judgeModel is the configured model id verbatim.
    expect(verdict.judgeModel).toBe("claude-haiku-4-5");
  });

  test("tolerates code-fence wrapping around the JSON verdict", async () => {
    const adapter = mockAdapter(
      "```json\n" +
        `{"allow": true, "reason": "consistent with goal", "confidence": 0.8}` +
        "\n```",
    );
    const judge = new ClaudeJustificationJudge({ adapter, model: "claude-haiku-4-5" });
    const verdict = await judge.judge(GATE_INPUT);
    expect(verdict.allow).toBe(true);
    expect(verdict.judgeModel).toBe("claude-haiku-4-5");
  });

  test("passes through a model-reasoned deny verdict (allow:false)", async () => {
    const adapter = mockAdapter(
      `{"allow": false, "reason": "justification pads goal vocabulary but the action exfiltrates data unrelated to the ticket", "confidence": 0.95}`,
    );
    const judge = new ClaudeJustificationJudge({ adapter, model: "claude-haiku-4-5" });
    const verdict = await judge.judge(GATE_INPUT);
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain("exfiltrates");
    // A model-REASONED denial keeps the clean model id (no "(error)" marker).
    expect(verdict.judgeModel).toBe("claude-haiku-4-5");
  });

  test("FAILS CLOSED on malformed (non-JSON) model output", async () => {
    const adapter = mockAdapter("I think this looks fine, allow it.");
    const judge = new ClaudeJustificationJudge({ adapter, model: "claude-haiku-4-5" });
    const verdict = await judge.judge(GATE_INPUT);
    // Security divergence from the optimizer's fail-open: deny on bad output.
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain("claude-judge-error");
    expect(verdict.judgeModel).toBe("claude-haiku-4-5 (error)");
  });

  test("FAILS CLOSED when the model stream throws", async () => {
    const judge = new ClaudeJustificationJudge({
      adapter: throwingAdapter("model unavailable"),
      model: "claude-haiku-4-5",
    });
    const verdict = await judge.judge(GATE_INPUT);
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain("claude-judge-error");
    expect(verdict.reason).toContain("model unavailable");
    expect(verdict.judgeModel).toBe("claude-haiku-4-5 (error)");
  });

  test("FAILS CLOSED on schema-invalid JSON (confidence out of range)", async () => {
    const adapter = mockAdapter(`{"allow": true, "reason": "ok", "confidence": 1.7}`);
    const judge = new ClaudeJustificationJudge({ adapter, model: "claude-haiku-4-5" });
    const verdict = await judge.judge(GATE_INPUT);
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain("claude-judge-error");
    expect(verdict.judgeModel).toBe("claude-haiku-4-5 (error)");
  });

  test("FAILS CLOSED on schema-invalid JSON (missing confidence field)", async () => {
    const adapter = mockAdapter(`{"allow": true, "reason": "ok"}`);
    const judge = new ClaudeJustificationJudge({ adapter, model: "claude-haiku-4-5" });
    const verdict = await judge.judge(GATE_INPUT);
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain("claude-judge-error");
  });

  test("createClaudeJustificationJudge returns a callable JustificationJudge yielding a verdict", async () => {
    const adapter = mockAdapter(`{"allow": true, "reason": "on-goal", "confidence": 0.5}`);
    // The factory's return type IS the JustificationJudge functional
    // interface (a function), not the class.
    const judge = createClaudeJustificationJudge({ adapter, model: "claude-haiku-4-5" });
    expect(typeof judge).toBe("function");
    const verdict = await judge(GATE_INPUT);
    // Assert the full JustificationVerdict shape.
    expect(verdict).toEqual({
      allow: true,
      reason: "on-goal",
      confidence: 0.5,
      judgeModel: "claude-haiku-4-5",
    });
  });

  test("the user message includes goal + tool + justification + stringified input", async () => {
    // Capture the request the judge sends to the model so we can prove the
    // compile-time anchor (sessionGoal) and the untrusted fields all reach it.
    let capturedUserContent = "";
    const capturingAdapter = {
      id: "mock",
      features: { caching: "none", thinking: false, multimodal: { input: false, output: false } },
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock
      stream(params: any): AsyncIterable<any> {
        capturedUserContent = String(params.messages?.[0]?.content ?? "");
        return (async function* () {
          yield { kind: "message_start", usage: { input: 0, output: 0 } };
          yield { kind: "content_block_start", index: 0, block: { type: "text", text: "" } };
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: `{"allow": true, "reason": "ok", "confidence": 1}` },
          };
          yield { kind: "content_block_stop", index: 0 };
          yield { kind: "message_delta", stopReason: "end_turn", usage: { input: 0, output: 0 } };
          yield { kind: "message_stop" };
        })();
      },
    } as unknown as ProviderAdapter;
    const judge = new ClaudeJustificationJudge({
      adapter: capturingAdapter,
      model: "claude-haiku-4-5",
    });
    await judge.judge(GATE_INPUT);
    expect(capturedUserContent).toContain(GATE_INPUT.sessionGoal);
    expect(capturedUserContent).toContain(GATE_INPUT.toolName);
    expect(capturedUserContent).toContain(GATE_INPUT.justification);
    expect(capturedUserContent).toContain(JSON.stringify(GATE_INPUT.input));
  });

  test("name is 'claude' for logging parity with the sibling provider", () => {
    const judge = new ClaudeJustificationJudge({
      adapter: mockAdapter(""),
      model: "claude-haiku-4-5",
    });
    expect(judge.name).toBe("claude");
  });
});

describe("ClaudeJustificationJudgeError", () => {
  // The judge surface fails *closed* by returning a deny verdict rather than
  // throwing, so this exported error type is the package's structured-error
  // escape hatch for callers that DO want to raise. Assert its full contract:
  // the typed `code`, the stable `name`, the message, cause chaining, and the
  // `toJSON()` serialization the logging layer relies on.
  test("carries the 'adapter' code, stable name, and message", () => {
    const err = new ClaudeJustificationJudgeError("judge backend unreachable");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err).toBeInstanceOf(ClaudeJustificationJudgeError);
    expect(err.name).toBe("ClaudeJustificationJudgeError");
    expect(err.code).toBe("adapter");
    expect(err.message).toBe("judge backend unreachable");
  });

  test("preserves the cause and serializes the chain via toJSON()", () => {
    const cause = new Error("socket hang up");
    const err = new ClaudeJustificationJudgeError("model call failed", cause);
    expect(err.cause).toBe(cause);
    expect(err.toJSON()).toEqual({
      name: "ClaudeJustificationJudgeError",
      code: "adapter",
      message: "model call failed",
      cause: { name: "Error", message: "socket hang up" },
    });
  });
});
