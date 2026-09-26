/**
 * 0.7.1 — the bridge's `specModels`: every model string the run was
 * configured with. The Task tool lets a `.crewhaus/sub-agents` definition run
 * only on these (or an inline sub-agent's), so a disk worker that names the
 * parent's `model_fallbacks` model keeps running on it, as it did on 0.7.0,
 * while a model id the spec never names (which can carry an endpoint) is not.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { runChatLoop, specModelsOf } from "./index";

/** One tool_use turn, then a text turn. */
function scriptedAdapter(toolName: string): ProviderAdapter {
  let call = 0;
  return {
    providerId: "anthropic",
    features: {
      caching: "explicit",
      tool_use: true,
      vision: true,
      thinking: true,
      web_search: true,
    },
    estimateTokens: () => 0,
    stream: () => {
      const first = call++ === 0;
      return (async function* () {
        yield { kind: "message_start" } as const;
        if (first) {
          yield {
            kind: "content_block_start",
            index: 0,
            block: { type: "tool_use", id: "tu_1", name: toolName, input: {} },
          } as const;
          yield {
            kind: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: "{}" },
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
        }
        yield { kind: "content_block_stop", index: 0 } as const;
        yield { kind: "message_delta", stopReason: first ? "tool_use" : "end_turn" } as const;
        yield { kind: "message_stop" } as const;
      })();
    },
  };
}

describe("specModelsOf", () => {
  test("collects every configured model slot, once each, primary first", () => {
    expect(
      specModelsOf({
        model: "claude-opus-5",
        modelFallbacks: ["claude-sonnet-5", "claude-opus-5"],
        modelTiers: { fast: "claude-haiku-4-5", default: "claude-opus-5" },
        modelPool: {
          policy: "static",
          candidates: [
            { model: "claude-sonnet-5", tags: ["a"], fallbacks: ["local/q@http://127.0.0.1:1/v1"] },
            { model: "openai/gpt-5", tags: ["b"] },
          ],
        },
        compactionModel: "claude-haiku-4-5-20251001",
        budget: { usdMicros: 1, onExceed: { kind: "degrade", model: "groq/llama-4" } },
      }),
    ).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "local/q@http://127.0.0.1:1/v1",
      "openai/gpt-5",
      "claude-haiku-4-5-20251001",
      "groq/llama-4",
    ]);
  });

  test("a bare run names only its primary; a stop budget names no model", () => {
    expect(
      specModelsOf({
        model: "claude-opus-5",
        budget: { usdMicros: 1, onExceed: { kind: "stop" } },
      }),
    ).toEqual(["claude-opus-5"]);
  });
});

describe("the runtime bridge carries specModels", () => {
  test("a tool sees the run's configured models on ctx.bridge", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "crewhaus-spec-models-"));
    try {
      const seen: unknown[] = [];
      const probe = buildTool({
        name: "bridge_probe",
        description: "captures the runtime bridge",
        inputSchema: z.object({}),
        execute: async (_input, ctx) => {
          seen.push((ctx?.bridge as { specModels?: unknown } | undefined)?.specModels);
          return "ok";
        },
      });
      await runChatLoop({
        model: "test-model",
        instructions: "t",
        _adapter: scriptedAdapter("bridge_probe"),
        // Injected, so the compaction model is not resolved against a provider.
        _compactionAdapter: scriptedAdapter("unused"),
        compactionModel: "claude-haiku-4-5",
        sessionRootDir: rootDir,
        singleTurn: true,
        seedMessages: [{ role: "user", content: "probe" }],
        tools: [probe],
        permissionMode: "bypass",
      });
      expect(seen).toEqual([["test-model", "claude-haiku-4-5"]]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
