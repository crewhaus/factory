import { describe, expect, test } from "bun:test";
import { CrewhausError } from "@crewhaus/errors";
import type { IrManagedV0 } from "@crewhaus/ir";
import { TargetEmitError, emitManaged } from "./index";

const ir: IrManagedV0 = {
  version: 0,
  name: "hello-managed",
  target: "managed",
  agent: {
    model: "claude-sonnet-4-6",
    instructions: "You are a managed-daemon agent.",
  },
  tenants: [
    {
      id: "tenant-a",
      budget: { maxInputTokens: 100_000, maxOutputTokens: 20_000 },
    },
    {
      id: "tenant-b",
      budget: { maxInputTokens: 50_000, maxOutputTokens: 10_000 },
    },
  ],
  permissions: { rules: [] },
  compaction: {},
};

describe("emitManaged", () => {
  test("returns agent.ts + daemon.ts", () => {
    const bundle = emitManaged(ir);
    const paths = bundle.files.map((f) => f.path).sort();
    expect(paths).toEqual(["agent.ts", "daemon.ts"]);
  });

  test("daemon.ts wires gateway-server with JWT secret env check", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content).toContain("CREWHAUS_GATEWAY_JWT_SECRET");
    expect(daemon?.content).toContain("createGatewayServer");
    expect(daemon?.content).toContain("Refusing to start");
  });

  test("daemon.ts emits per-tenant overrides for both tenants", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content).toContain('"tenant-a"');
    expect(daemon?.content).toContain('"tenant-b"');
    expect(daemon?.content).toContain("100000");
    expect(daemon?.content).toContain("50000");
  });

  test("daemon.ts wires graceful SIGTERM/SIGINT handlers", () => {
    const bundle = emitManaged(ir);
    const daemon = bundle.files.find((f) => f.path === "daemon.ts");
    expect(daemon?.content).toContain("SIGTERM");
    expect(daemon?.content).toContain("SIGINT");
  });

  test("agent.ts has runOneTurn signature with tenantId + sessionId + input", () => {
    const bundle = emitManaged(ir);
    const agent = bundle.files.find((f) => f.path === "agent.ts");
    expect(agent?.content).toContain("runOneTurn");
    expect(agent?.content).toContain("tenantId");
    expect(agent?.content).toContain("sessionId");
  });

  test("includes the standard generated header", () => {
    const bundle = emitManaged(ir);
    for (const f of bundle.files) {
      expect(f.content).toContain("DO NOT EDIT");
    }
  });
});

describe("TargetEmitError", () => {
  test("is a compiler-coded CrewhausError carrying message and cause", () => {
    const cause = new Error("underlying");
    const err = new TargetEmitError("emit failed", cause);
    expect(err).toBeInstanceOf(TargetEmitError);
    expect(err).toBeInstanceOf(CrewhausError);
    expect(err.name).toBe("TargetEmitError");
    expect(err.code).toBe("compiler");
    expect(err.message).toBe("emit failed");
    expect(err.cause).toBe(cause);
  });

  test("constructs without a cause", () => {
    const err = new TargetEmitError("emit failed");
    expect(err.name).toBe("TargetEmitError");
    expect(err.code).toBe("compiler");
    expect(err.cause).toBeUndefined();
    // Serializes through the CrewhausError contract.
    expect(err.toJSON()).toEqual({
      name: "TargetEmitError",
      code: "compiler",
      message: "emit failed",
      cause: undefined,
    });
  });
});
