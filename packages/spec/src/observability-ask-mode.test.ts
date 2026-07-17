/**
 * Loop contract 0.4 (Batch C) — parse-level tests for the two Batch-C spec
 * surfaces this keystone owns:
 *   - G11: `permissions.ask_mode: pause | deny` (default resolves downstream).
 *   - G26: the `observability:` control sub-blocks (trace / metrics / cost /
 *     alerts / incidents / otel), including crew joining the carrying shapes.
 *
 * The spec layer carries declared fields VERBATIM (with zod `.default()`
 * materialised on the toggles/level); the ABSENT-block defaults semantics
 * (cost/ring ON, opt-in features OFF) live in the compiler lowering + the
 * emitters, so these tests assert acceptance/rejection + the on-declaration
 * shape, not the absent-block behaviour.
 */
import { describe, expect, test } from "bun:test";
import { SpecParseError, parseSpec } from "./index";

const cliWith = (block: string): string =>
  ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", block].join("\n");

describe("permissions.ask_mode (G11)", () => {
  test("accepts pause", () => {
    const spec = parseSpec(cliWith("permissions:\n  ask_mode: pause"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.permissions?.ask_mode).toBe("pause");
  });

  test("accepts deny", () => {
    const spec = parseSpec(cliWith("permissions:\n  ask_mode: deny"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.permissions?.ask_mode).toBe("deny");
  });

  test("is optional — omitting it leaves ask_mode undefined (default resolves downstream)", () => {
    const spec = parseSpec(cliWith("permissions:\n  mode: auto"));
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.permissions?.ask_mode).toBeUndefined();
  });

  test("rejects an unknown ask_mode value", () => {
    expect(() => parseSpec(cliWith("permissions:\n  ask_mode: park"))).toThrow(SpecParseError);
  });

  test("coexists with mode + rules", () => {
    const spec = parseSpec(
      cliWith(
        [
          "permissions:",
          "  mode: plan",
          "  ask_mode: deny",
          "  rules:",
          "    - type: alwaysAllow",
          "      pattern: Read",
        ].join("\n"),
      ),
    );
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.permissions?.mode).toBe("plan");
    expect(spec.permissions?.ask_mode).toBe("deny");
    expect(spec.permissions?.rules).toHaveLength(1);
  });
});

describe("observability control sub-blocks (G26)", () => {
  test("trace.level accepts every level and materialises the ring default", () => {
    for (const level of ["off", "ring", "pretty", "json"]) {
      const spec = parseSpec(cliWith(`observability:\n  trace:\n    level: ${level}`));
      if (spec.target !== "cli") throw new Error("unexpected target");
      expect(spec.observability?.trace?.level).toBe(level as "off" | "ring" | "pretty" | "json");
    }
    // A bare `trace: {}` materialises the `.default("ring")`.
    const bare = parseSpec(cliWith("observability:\n  trace: {}"));
    if (bare.target !== "cli") throw new Error("unexpected target");
    expect(bare.observability?.trace?.level).toBe("ring");
  });

  test("rejects an unknown trace level", () => {
    expect(() => parseSpec(cliWith("observability:\n  trace:\n    level: verbose"))).toThrow(
      SpecParseError,
    );
  });

  test("toggles default enabled:true when declared bare, and honour explicit false", () => {
    const on = parseSpec(
      cliWith("observability:\n  metrics: {}\n  cost: {}\n  alerts: {}\n  incidents: {}"),
    );
    if (on.target !== "cli") throw new Error("unexpected target");
    expect(on.observability?.metrics?.enabled).toBe(true);
    expect(on.observability?.cost?.enabled).toBe(true);
    expect(on.observability?.alerts?.enabled).toBe(true);
    expect(on.observability?.incidents?.enabled).toBe(true);

    const off = parseSpec(cliWith("observability:\n  cost:\n    enabled: false"));
    if (off.target !== "cli") throw new Error("unexpected target");
    expect(off.observability?.cost?.enabled).toBe(false);
  });

  test("otel.endpoint is optional and carried verbatim", () => {
    const withEndpoint = parseSpec(
      cliWith("observability:\n  otel:\n    endpoint: http://localhost:4318"),
    );
    if (withEndpoint.target !== "cli") throw new Error("unexpected target");
    expect(withEndpoint.observability?.otel?.endpoint).toBe("http://localhost:4318");

    const bareOtel = parseSpec(cliWith("observability:\n  otel: {}"));
    if (bareOtel.target !== "cli") throw new Error("unexpected target");
    expect(bareOtel.observability?.otel?.endpoint).toBeUndefined();
  });

  test("rejects a typo'd observability sub-key (strict)", () => {
    expect(() => parseSpec(cliWith("observability:\n  traces:\n    level: ring"))).toThrow(
      SpecParseError,
    );
  });

  test("slo coexists with the new control sub-blocks", () => {
    const spec = parseSpec(
      cliWith(
        [
          "observability:",
          "  slo:",
          "    ttft_ms: 1400",
          "  trace:",
          "    level: json",
          "  cost:",
          "    enabled: false",
        ].join("\n"),
      ),
    );
    if (spec.target !== "cli") throw new Error("unexpected target");
    expect(spec.observability?.slo?.ttft_ms).toBe(1400);
    expect(spec.observability?.trace?.level).toBe("json");
    expect(spec.observability?.cost?.enabled).toBe(false);
  });

  test("crew accepts the observability block (Batch C joins it to the carrying shapes)", () => {
    const spec = parseSpec(
      [
        "name: cr",
        "target: crew",
        "model: m",
        "entry: lead",
        "roles:",
        "  lead:",
        "    instructions: lead it",
        "observability:",
        "  metrics:",
        "    enabled: true",
        "  otel:",
        "    endpoint: http://collector:4318",
      ].join("\n"),
    );
    if (spec.target !== "crew") throw new Error("unexpected target");
    expect(spec.observability?.metrics?.enabled).toBe(true);
    expect(spec.observability?.otel?.endpoint).toBe("http://collector:4318");
  });
});
