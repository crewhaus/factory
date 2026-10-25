/**
 * 0.8.0 (design/0.8.0-provability-release.md §8) — the read-only provability
 * seam on the runtime bridge. A tool call sees `bridge.provability` — the
 * floor and the skill text, nothing else — exactly when the run was given a
 * gate, so the Task tool's `projectParentHandle` can hand a child its
 * guidance while the verifier, the retry policy and the bundle store stay
 * with the parent (only the parent's final text is gated).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { buildTool } from "@crewhaus/tool-builder";
import { z } from "zod";
import { type RunProvability, runChatLoop } from "./index";

/** First call: the Probe tool; then a plain answer. */
function scripted(): ProviderAdapter {
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
            block: { type: "tool_use", id: "tu_probe", name: "Probe", input: {} },
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
  } as unknown as ProviderAdapter;
}

function gate(skill?: string): RunProvability {
  return {
    level: "grounded",
    onFail: "note",
    maxRetries: 0,
    threshold: 1,
    render: "none",
    nudge: () => "cite",
    ...(skill !== undefined ? { skill } : {}),
    verify: async (turn) => ({
      version: 1,
      level: "grounded",
      verdict: "pass",
      score: 1,
      threshold: 1,
      achieved: "grounded",
      claims: [],
      claimCount: 0,
      met: 0,
      unmet: 0,
      assumptions: 0,
      sources: 0,
      judgeWaived: 0,
      retryIndex: turn.retryIndex,
      createdAt: "2026-10-22T12:00:00.000Z",
      bundleHash: `sha256:${"0".repeat(64)}`,
    }),
  };
}

async function bridgeSeen(
  provability: RunProvability | undefined,
): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "runtime-provability-bridge-"));
  let seen: Record<string, unknown> = {};
  try {
    const probe = buildTool({
      name: "Probe",
      description: "records the bridge it was handed",
      inputSchema: z.object({}).strict(),
      readOnly: true,
      concurrencySafe: true,
      execute: async (_input, ctx) => {
        seen = (ctx?.bridge ?? {}) as Record<string, unknown>;
        return "ok";
      },
    });
    await runChatLoop({
      model: "test-model",
      instructions: "probe",
      _adapter: scripted(),
      sessionRootDir: root,
      singleTurn: true,
      seedMessages: [{ role: "user", content: "go" }],
      tools: [probe],
      permissionMode: "bypass",
      installSigintHandler: false,
      stdout: () => {},
      ...(provability !== undefined ? { provability } : {}),
    });
    return seen;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the runtime bridge — the read-only provability seam (0.8.0 §8)", () => {
  test("a gated run: the floor and the skill text, and nothing of the gate itself", async () => {
    const seen = await bridgeSeen(gate("cite with [n] and a definitions block"));
    expect(seen["provability"]).toEqual({
      level: "grounded",
      skill: "cite with [n] and a definitions block",
    });
  });

  test("a gated run without a skill: the floor alone", async () => {
    const seen = await bridgeSeen(gate());
    expect(seen["provability"]).toEqual({ level: "grounded" });
  });

  test("an ungated run: no provability key on the bridge at all", async () => {
    const seen = await bridgeSeen(undefined);
    expect(seen["runContext"]).toBeDefined();
    expect("provability" in seen).toBe(false);
  });
});
