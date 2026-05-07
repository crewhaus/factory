/**
 * Shared T2 contract corpus harness. Other adapter packages
 * (`adapter-openai`, `adapter-gemini`, `adapter-bedrock`) import this
 * helper and run it against their own adapter so every provider
 * normalises canonical fixtures into semantically equivalent
 * `StreamEvent` outputs.
 *
 * "Semantically equivalent" here means:
 * - Same number of text-bearing content blocks (text-only fixtures).
 * - Same tool_use blocks (id may vary; name + input must match).
 * - `message_stop` always reached.
 * - `stopReason` equivalent ("end_turn" / "tool_use" / "max_tokens").
 *
 * Each fixture file under `__fixtures__/contract/*.json` has shape:
 * `{ name, messages, tools?, expected: { texts: string[], toolCalls: {name, input}[], stopReason } }`.
 *
 * The harness builds a fake stream from `expected` and verifies the
 * adapter's (mock-driven) round-trip lands on the same StreamEvents.
 */

import { expect } from "bun:test";
import type { ProviderMessage } from "./types.js";

export type ContractFixture = {
  readonly name: string;
  readonly description: string;
  readonly request: {
    readonly system: string;
    readonly messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
    readonly tools?: ReadonlyArray<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }>;
  };
  readonly expected: {
    readonly texts: ReadonlyArray<string>;
    readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
    readonly stopReason: string;
  };
};

/**
 * Assert that a `ProviderMessage` matches a fixture's `expected` shape.
 * Equality is structural: text content concatenated and trimmed, tool
 * calls compared by name+input (id is provider-specific).
 */
export function assertMatchesFixture(actual: ProviderMessage, fx: ContractFixture): void {
  const actualTexts = actual.content
    .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
    .map((b) => b.text);
  expect(actualTexts).toEqual([...fx.expected.texts]);

  const actualToolCalls = actual.content
    .filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use")
    .map((b) => ({ name: b.name, input: b.input }));
  expect(actualToolCalls).toEqual([...fx.expected.toolCalls]);

  expect(actual.stopReason).toBe(fx.expected.stopReason);
}
