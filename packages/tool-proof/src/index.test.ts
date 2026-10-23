/**
 * The package-wide contract (the tool-text precedent): every tool's safety
 * flags are what the runtime relies on, every schema refuses a wrong shape
 * and every oversized field, and the factory refuses a bad configuration
 * when it is built rather than on every call.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBuiltinChecker } from "@crewhaus/proof-checker";
import {
  SHAPE_TOOL_PROFILES,
  type ToolShape,
  builtinToolsFor,
  expandToolSelectors,
  toolsInCategory,
} from "@crewhaus/tool-categories";
import {
  DEFAULT_FLOOR,
  DRAFT_CHARS,
  PROOF_INPUT_LIMITS,
  PROOF_TOOLS,
  createProofTools,
  defaultProvabilityConfig,
  proofCheck,
  proofCheckers,
  provabilityPreflight,
} from "./index";
import { config, tempDirs } from "./test-helpers";

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe("package-wide contract", () => {
  test("the three builtin instances are exported, in PROOF_TOOLS, with their registered names", () => {
    expect(PROOF_TOOLS.map((t) => t.name)).toEqual([
      "ProofCheckers",
      "ProofCheck",
      "ProvabilityPreflight",
    ]);
    expect(PROOF_TOOLS).toEqual([proofCheckers, proofCheck, provabilityPreflight]);
  });

  test("every tool is internal, needs no sandbox, crosses no boundary and asks no justification", () => {
    for (const t of PROOF_TOOLS) {
      expect({ name: t.name, scope: t.scope }).toEqual({ name: t.name, scope: "internal" });
      expect({ name: t.name, sandbox: t.requiresSandbox }).toEqual({
        name: t.name,
        sandbox: false,
      });
      expect({ name: t.name, io: t.ioCapability }).toEqual({ name: t.name, io: undefined });
      expect({ name: t.name, justify: t.requireJustification }).toEqual({
        name: t.name,
        justify: false,
      });
      // Their output reaches the model; the runtime classifies it like any tool's.
      expect({ name: t.name, classify: t.classifyOutput }).toEqual({
        name: t.name,
        classify: true,
      });
    }
  });

  test("ProofCheckers and ProvabilityPreflight are read-only and concurrency-safe", () => {
    for (const t of [proofCheckers, provabilityPreflight]) {
      expect({ name: t.name, readOnly: t.readOnly, destructive: t.destructive }).toEqual({
        name: t.name,
        readOnly: true,
        destructive: false,
      });
      expect({ name: t.name, safe: t.concurrencySafe }).toEqual({ name: t.name, safe: true });
    }
  });

  test("ProofCheck writes (one artifact per call), so it is destructive and not read-only", () => {
    expect(proofCheck.readOnly).toBe(false);
    expect(proofCheck.destructive).toBe(true);
    // Each call writes its own uniquely named file and shares no state.
    expect(proofCheck.concurrencySafe).toBe(true);
  });

  test("every tool that is not read-only declares operativeArgs; ProofCheck's is the checker", () => {
    // apps/cli/src/operative-args.test.ts holds every builtin to this; the
    // checker id is what a scoped rule reads: `alwaysAllow ProofCheck(builtin)`
    // allows the sandbox-free checker alone.
    for (const t of PROOF_TOOLS) {
      if (t.readOnly) continue;
      expect({ name: t.name, declared: t.operativeArgs !== undefined }).toEqual({
        name: t.name,
        declared: true,
      });
    }
    expect(proofCheck.operativeArgs).toEqual([{ field: "checker", kind: "id" }]);
  });

  test("names are unique and PascalCase; descriptions say what they are for and fit every provider", () => {
    const names = PROOF_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of PROOF_TOOLS) {
      expect(t.name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
      expect(t.description).toContain("Use ");
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.description.length).toBeLessThanOrEqual(1024);
    }
  });

  test("every schema rejects a wholly wrong input shape", () => {
    for (const t of PROOF_TOOLS) {
      expect({ name: t.name, ok: t.inputSchema.safeParse(42).success }).toEqual({
        name: t.name,
        ok: false,
      });
    }
  });
});

describe("bounded inputs", () => {
  const valid = { checker: "builtin", claim: "2 + 2 is 4.", statement: "2 + 2 = 4", proof: "eval" };

  test("ProofCheck accepts a valid call and refuses each field empty, missing or over its bound", () => {
    expect(proofCheck.inputSchema.safeParse(valid).success).toBe(true);
    const over = {
      checker: PROOF_INPUT_LIMITS.checkerChars,
      claim: PROOF_INPUT_LIMITS.claimChars,
      statement: PROOF_INPUT_LIMITS.statementChars,
      proof: PROOF_INPUT_LIMITS.proofChars,
    } as const;
    for (const [field, limit] of Object.entries(over)) {
      const at = { ...valid, [field]: "x".repeat(limit) };
      const past = { ...valid, [field]: "x".repeat(limit + 1) };
      const empty = { ...valid, [field]: "" };
      const { [field as keyof typeof valid]: _gone, ...missing } = valid;
      expect({ field, at: proofCheck.inputSchema.safeParse(at).success }).toEqual({
        field,
        at: true,
      });
      expect({ field, past: proofCheck.inputSchema.safeParse(past).success }).toEqual({
        field,
        past: false,
      });
      expect({ field, empty: proofCheck.inputSchema.safeParse(empty).success }).toEqual({
        field,
        empty: false,
      });
      expect({ field, missing: proofCheck.inputSchema.safeParse(missing).success }).toEqual({
        field,
        missing: false,
      });
    }
  });

  test("the proof bound is the largest any shipped checker accepts", () => {
    // BUILTIN_LIMITS: statement 20 000, proof 1 000 000 — the schema never
    // refuses what the builtin checker would take.
    expect(PROOF_INPUT_LIMITS.statementChars).toBe(20_000);
    expect(PROOF_INPUT_LIMITS.proofChars).toBe(1_000_000);
  });

  test("ProvabilityPreflight needs a non-empty draft within DRAFT_CHARS", () => {
    expect(provabilityPreflight.inputSchema.safeParse({ draft: "x" }).success).toBe(true);
    expect(
      provabilityPreflight.inputSchema.safeParse({ draft: "x".repeat(DRAFT_CHARS) }).success,
    ).toBe(true);
    expect(
      provabilityPreflight.inputSchema.safeParse({ draft: "x".repeat(DRAFT_CHARS + 1) }).success,
    ).toBe(false);
    expect(provabilityPreflight.inputSchema.safeParse({ draft: "" }).success).toBe(false);
    expect(provabilityPreflight.inputSchema.safeParse({}).success).toBe(false);
  });

  test("ProofCheckers takes no arguments", () => {
    expect(proofCheckers.inputSchema.safeParse({}).success).toBe(true);
  });
});

describe("createProofTools", () => {
  test("building the tools creates nothing: no directory, no sandbox, no log read", () => {
    const root = dirs.make();
    const tools = createProofTools({ workspaceRoot: root, specName: "support-bot" });
    expect(tools.all.map((t) => t.name)).toEqual([
      "ProofCheckers",
      "ProofCheck",
      "ProvabilityPreflight",
    ]);
    expect(existsSync(join(root, ".crewhaus"))).toBe(false);
  });

  test("a config with no valid floor is refused at construction", () => {
    expect(() =>
      createProofTools({ config: { ...config("grounded"), level: "off" as never } }),
    ).toThrow(/config\.level must be one of/);
  });

  test("an invalid spec name is refused at construction, not on every call", () => {
    expect(() => createProofTools({ specName: "../escape" })).toThrow(/invalid spec name/);
    expect(() => createProofTools({ specName: ".." })).toThrow(/invalid spec name/);
  });

  test("two checkers under one id are refused at construction", () => {
    expect(() =>
      createProofTools({ checkers: [createBuiltinChecker(), createBuiltinChecker()] }),
    ).toThrow(/registered twice/);
  });
});

describe("the default configuration", () => {
  test("is the compiler's lowered defaults at the grounded floor", () => {
    const c = defaultProvabilityConfig();
    expect(DEFAULT_FLOOR).toBe("grounded");
    expect(c).toMatchObject({
      level: "grounded",
      onFail: "retry",
      maxRetries: 1,
      threshold: 1,
      scope: "session",
      assumptions: "allow",
      render: "footer",
      sources: { allow: [], deny: [], bibliographic: false, resolve: "off" },
      grounded: { coverage: 0.8, windowTokens: 60, independent: 1 },
      execution: { replay: true, maxReplays: 20 },
      formal: {
        checkers: ["builtin", "smt"],
        forbid: ["sorry", "axiom", "native_decide"],
        timeoutMs: 30_000,
      },
    });
    expect(c.maxAssumptions).toBeUndefined();
    expect(c.judge).toBeUndefined();
  });

  test("execution.allow is the expansion of all-compute + all-verify, concrete keys only", () => {
    const allow = defaultProvabilityConfig().execution.allow;
    expect(allow).toEqual([...expandToolSelectors(["all-compute", "all-verify"]).tools]);
    expect(allow.length).toBeGreaterThan(20);
    expect(allow.some((k) => k.startsWith("all-"))).toBe(false);
    expect(allow).toContain("factCrossCheck");
    // Bash is never in the default allowlist (design §6.3).
    expect(allow).not.toContain("bash");
  });
});

describe("wiring", () => {
  test("the proof category holds the three tools and rolls up under safety", () => {
    expect([...toolsInCategory("proof")].sort()).toEqual(
      ["proofCheck", "proofCheckers", "provabilityPreflight"].sort(),
    );
    const safety = toolsInCategory("safety");
    for (const key of ["proofCheck", "proofCheckers", "provabilityPreflight"]) {
      expect(safety).toContain(key);
    }
    // The verify leaf (and so the default execution allowlist) is untouched.
    expect(toolsInCategory("verify")).not.toContain("proofCheck");
  });

  test("every shape that runs a host tool catalog carries them; the others carry none", () => {
    const shapes = Object.keys(SHAPE_TOOL_PROFILES) as ToolShape[];
    const host = shapes.filter((shape) => SHAPE_TOOL_PROFILES[shape].runtime === "host");
    // The sweep's own count: a profile table that lost its host shapes passes nothing.
    expect(host.length).toBeGreaterThanOrEqual(10);
    expect(host).toEqual(expect.arrayContaining(["cli", "channel", "managed", "research", "crew"]));
    for (const shape of shapes) {
      const carried = builtinToolsFor(shape);
      for (const key of ["proofCheck", "proofCheckers", "provabilityPreflight"]) {
        // No tool catalog (pipeline, voice, onchain) or an edge worker
        // (cf-worker, no filesystem for the artifacts): none of them.
        const expected = SHAPE_TOOL_PROFILES[shape].runtime === "host";
        expect({ shape, key, carried: carried.includes(key) }).toEqual({
          shape,
          key,
          carried: expected,
        });
      }
    }
  });
});
