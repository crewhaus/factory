/**
 * 0.6.0 §4.4 — per-candidate `tool_config` for the code-execution family:
 * the ONLY knob a profile may declare (the spec's `toolConfigBlock`
 * superRefine rejects every sandbox-override key) is the default timeout, so
 * that is the only knob honoured per call. The sandbox boundary stays
 * process-global by design.
 */
import { describe, expect, test } from "bun:test";
import { resolveCallMaxTimeoutMs, resolveCallTimeoutMs } from "./index";

describe("resolveCallTimeoutMs (per-call tool_config override)", () => {
  test("reads default_timeout_ms / defaultTimeoutMs off an object override", () => {
    expect(resolveCallTimeoutMs({ default_timeout_ms: 5000 })).toBe(5000);
    expect(resolveCallTimeoutMs({ defaultTimeoutMs: 2500 })).toBe(2500);
    expect(resolveCallTimeoutMs({ defaultTimeoutMs: 1000, default_timeout_ms: 9 })).toBe(1000);
  });

  test("anything else is undefined — no override, the registered sandbox default applies", () => {
    expect(resolveCallTimeoutMs(undefined)).toBeUndefined();
    expect(resolveCallTimeoutMs(null)).toBeUndefined();
    expect(resolveCallTimeoutMs("5000")).toBeUndefined();
    expect(resolveCallTimeoutMs([5000])).toBeUndefined();
    expect(resolveCallTimeoutMs({})).toBeUndefined();
    expect(resolveCallTimeoutMs({ defaultTimeoutMs: 0 })).toBeUndefined();
    expect(resolveCallTimeoutMs({ defaultTimeoutMs: -1 })).toBeUndefined();
    expect(resolveCallTimeoutMs({ defaultTimeoutMs: Number.NaN })).toBeUndefined();
    // Sandbox-override keys are never read here (and the spec rejects them).
    expect(resolveCallTimeoutMs({ backend: "noop", images: { python: "x" } })).toBeUndefined();
  });
});

describe("resolveCallMaxTimeoutMs (a candidate's own cap)", () => {
  test("reads max_timeout_ms / maxTimeoutMs, and nothing else", () => {
    expect(resolveCallMaxTimeoutMs({ max_timeout_ms: 2000 })).toBe(2000);
    expect(resolveCallMaxTimeoutMs({ maxTimeoutMs: 3000, max_timeout_ms: 9 })).toBe(3000);
    expect(resolveCallMaxTimeoutMs({ default_timeout_ms: 2000 })).toBeUndefined();
    expect(resolveCallMaxTimeoutMs({ maxTimeoutMs: 0 })).toBeUndefined();
    expect(resolveCallMaxTimeoutMs("2000")).toBeUndefined();
  });
});
