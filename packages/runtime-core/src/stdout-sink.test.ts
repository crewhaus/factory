/**
 * Item 20 — `RunChatLoopOptions.stdout`, the seam that lets a caller running
 * several loops at once give each one its own output sink.
 *
 * Without it, every concurrent run writes its token deltas to the same file
 * descriptor and the terminal splices them mid-word — the `crewhaus eval` /
 * `crewhaus optimize` symptom:
 *
 *   "agent> TheThe capital of Brazil is **Brasília**. …capital of Japan is…"
 *
 * These tests drive the REAL loop (scripted adapters, single turn) and assert
 * (a) the sink receives the whole human-facing surface, (b) process.stdout
 * receives none of it while a sink is installed, and (c) omitting the option
 * still writes to process.stdout — the default must not silently go mute.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "@crewhaus/adapter-anthropic";
import { runChatLoop } from "./index";

const SESSION_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-stdout-sink-tests-"));
beforeAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = SESSION_ROOT;
});
afterAll(() => {
  process.env["CREWHAUS_SESSION_DIR"] = undefined;
  rmSync(SESSION_ROOT, { recursive: true, force: true });
});

/** Streams `deltas` as separate text_delta events — the multi-chunk shape
 *  that makes concurrent runs splice on a shared stdout. */
function scriptedAdapter(deltas: readonly string[]): ProviderAdapter {
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
        yield { kind: "message_start" } as const;
        yield {
          kind: "content_block_start",
          index: 0,
          block: { type: "text", text: "" },
        } as const;
        for (const text of deltas) {
          // Yield between deltas so two concurrent runs really interleave.
          await new Promise((r) => setTimeout(r, 0));
          yield { kind: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
        }
        yield { kind: "content_block_stop", index: 0 } as const;
        yield { kind: "message_delta", stopReason: "end_turn" } as const;
        yield { kind: "message_stop" } as const;
      })(),
  };
}

function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe("runChatLoop — stdout sink (item 20)", () => {
  test("concurrent runs keep their output in their own sinks, not on stdout", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const stdout = captureStdout();
    try {
      await Promise.all([
        runChatLoop({
          model: "test-model",
          instructions: "test",
          _adapter: scriptedAdapter(["The", " capital of Brazil is ", "**Brasília**."]),
          singleTurn: true,
          seedMessages: [{ role: "user", content: "brazil?" }],
          stdout: (chunk) => a.push(chunk),
        }),
        runChatLoop({
          model: "test-model",
          instructions: "test",
          _adapter: scriptedAdapter(["The", " capital of Japan is ", "**Tokyo**."]),
          singleTurn: true,
          seedMessages: [{ role: "user", content: "japan?" }],
          stdout: (chunk) => b.push(chunk),
        }),
      ]);
    } finally {
      stdout.restore();
    }
    // Each sink saw its own turn whole — prefix, text, nothing from the other.
    // (A `[memory] loaded …` notice may precede it when the cwd carries
    // project memory files; it is human-facing loop output and rides the
    // same sink by design, so assert on the turn's tail.)
    expect(a.join("")).toEndWith("agent> The capital of Brazil is **Brasília**.\n");
    expect(b.join("")).toEndWith("agent> The capital of Japan is **Tokyo**.\n");
    expect(a.join("")).not.toContain("Tokyo");
    expect(b.join("")).not.toContain("Brasília");
    // …and none of it reached the shared file descriptor.
    expect(stdout.text()).not.toContain("Brasília");
    expect(stdout.text()).not.toContain("Tokyo");
    expect(stdout.text()).not.toContain("agent>");
  });

  test("without the option the loop still writes to process.stdout", async () => {
    const stdout = captureStdout();
    try {
      await runChatLoop({
        model: "test-model",
        instructions: "test",
        _adapter: scriptedAdapter(["plain ", "stdout"]),
        singleTurn: true,
        seedMessages: [{ role: "user", content: "go" }],
      });
    } finally {
      stdout.restore();
    }
    expect(stdout.text()).toContain("agent> plain stdout");
  });
});
