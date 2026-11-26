/**
 * The compile service's `checkSpec` result reaches a reader through this
 * server's dispatch-site masker, which redacts by KEY NAME. Every key the
 * result can carry must therefore read as non-secret, or a slot, provider or
 * env name would silently arrive as `[redacted]`.
 */
import { describe, expect, test } from "bun:test";
import { type CheckSpecResult, checkSpec } from "@crewhaus/compile-service";
import { isCredentialKey } from "@crewhaus/spec-patch";
import { maskDeep } from "./mask";

const CLI = "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n";

/** One result per branch of the answer: model access, read-only, refusals and warnings. */
const RESULTS: ReadonlyArray<readonly [string, CheckSpecResult]> = [
  [
    "model access",
    checkSpec(
      [
        CLI,
        "compaction:",
        "  model: openai/gpt-4o-mini",
        "security:",
        "  justification: { judge: claude, model: gemini/gemini-2.5-flash }",
        "",
      ].join("\n"),
      { env: { OPENAI_API_KEY: "set" } },
    ),
  ],
  ["read-only", checkSpec(`${CLI}future_block: {}\n`)],
  ["newer version", checkSpec(`${CLI}version: 3\n`)],
  [
    "a Worker refusal",
    checkSpec(`${CLI}limits:\n  loop_detection:\n    escalation: justify\n`, {
      emitAs: "cf-worker",
    }),
  ],
  [
    "cross-field issues",
    checkSpec(
      `${CLI}models:\n  a: { model: cheapest, price: { input_per_1m: 1, output_per_1m: 2 } }\n`,
    ),
  ],
];

function keysOf(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) keysOf(v, out);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

describe("a checkSpec result through Home's masker", () => {
  test("no key the result carries is named like a credential", () => {
    const keys = new Set<string>();
    for (const [, result] of RESULTS) keysOf(result, keys);
    // The branches above reach every top-level key and the model-access row's.
    for (const k of ["modelAccess", "slot", "provider", "envNames", "present", "readOnly"]) {
      expect(keys.has(k), k).toBe(true);
    }
    expect([...keys].filter((k) => isCredentialKey(k))).toEqual([]);
  });

  test("the slot, provider and env names survive the masker", () => {
    const [, result] = RESULTS[0] as readonly [string, CheckSpecResult];
    expect(result.modelAccess.length).toBe(3);
    const masked = maskDeep(result) as CheckSpecResult;
    expect(masked.modelAccess).toEqual(result.modelAccess);
    expect(masked.modelAccess.map((row) => [row.slot, row.provider])).toEqual([
      ["agent.model", "anthropic"],
      ["compaction.model", "openai"],
      ["security.justification.model", "gemini"],
    ]);
    expect(masked.modelAccess[1]?.envNames).toContain("OPENAI_API_KEY");
    expect(masked.modelAccess[1]?.present).toBe(true);
    expect(JSON.stringify(masked)).not.toContain("[redacted]");
  });

  test("every branch reads the same after masking", () => {
    for (const [name, result] of RESULTS) {
      expect(maskDeep(result), name).toEqual(result);
    }
  });
});
