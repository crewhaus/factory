/**
 * Batch G (keystone) — the spec→IR lowering the keystone lands for the
 * downstream emitter/runtime agents:
 *   - Item 1 (G30): `expose:` → `IrExpose` (tools default resolved to "chat").
 *   - Item 3 (G32): `plugins:` → `ir.plugins` (carried only when non-empty).
 *   - Item 5 (G44): `thredz.messaging` → `IrThredz.messaging` (default-off).
 *   - Item 2 (G31): `sub_agents.<n>.federation` → `IrSubAgentDefinition.federation`.
 *   - Item 9 (G37): per-role/step model routing via `lowerModelFailover`.
 *   - The compile-warnings table: none of the above warn (wired this batch).
 */
import { describe, expect, test } from "bun:test";
import type { IrChannelV0, IrCrewV0, IrManagedV0, IrV0, IrWorkflowV0 } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { type CompileWarning, compile, lower } from "./index";

const paths = (w: ReadonlyArray<CompileWarning>): string[] => w.map((x) => x.path).sort();

const cli = (extra: string): IrV0 => {
  const ir = lower(
    parseSpec(
      ["name: c", "target: cli", "agent:", "  model: m", "  instructions: i", extra].join("\n"),
    ),
  );
  if (ir.target !== "cli") throw new Error("unexpected target");
  return ir;
};

const channel = (extra: string): IrChannelV0 => {
  const ir = lower(
    parseSpec(
      [
        "name: c",
        "target: channel",
        "agent: { model: m, instructions: i }",
        "channels: { slack: { botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET } }",
        "routing: { sessionKey: thread }",
        extra,
      ].join("\n"),
    ),
  );
  if (ir.target !== "channel") throw new Error("unexpected target");
  return ir;
};

const managed = (extra: string): IrManagedV0 => {
  const ir = lower(
    parseSpec(
      [
        "name: m",
        "target: managed",
        "agent: { model: m, instructions: i }",
        "tenants:",
        "  - id: t1",
        "    budget: { maxInputTokens: 1, maxOutputTokens: 1 }",
        extra,
      ].join("\n"),
    ),
  );
  if (ir.target !== "managed") throw new Error("unexpected target");
  return ir;
};

describe("Item 1 (G30) — lowerExpose", () => {
  test("cli lowers expose.mcp with tools defaulted to chat", () => {
    expect(cli("expose:\n  mcp:\n    transport: stdio").expose).toEqual({
      mcp: { transport: "stdio", tools: "chat" },
    });
  });

  test("explicit tools value is carried verbatim (channel, sse)", () => {
    expect(channel("expose:\n  mcp:\n    transport: sse\n    tools: chat").expose).toEqual({
      mcp: { transport: "sse", tools: "chat" },
    });
  });

  test("managed lowers expose (sse endpoint)", () => {
    expect(managed("expose:\n  mcp:\n    transport: sse").expose).toEqual({
      mcp: { transport: "sse", tools: "chat" },
    });
  });

  test("absent expose leaves the field undefined (byte-identical bundles)", () => {
    expect(cli("permissions: { mode: auto }").expose).toBeUndefined();
  });

  test("expose: {} without mcp lowers to no exposure", () => {
    expect(cli("expose: {}").expose).toBeUndefined();
  });
});

describe("Item 3 (G32) — lowerPlugins", () => {
  test("cli carries a non-empty plugin list in declared order", () => {
    expect(cli("plugins:\n  - acme-tools\n  - reporter").plugins).toEqual([
      "acme-tools",
      "reporter",
    ]);
  });

  test("channel carries plugins", () => {
    expect(channel("plugins:\n  - acme-tools").plugins).toEqual(["acme-tools"]);
  });

  test("absent plugins leaves the field undefined", () => {
    expect(cli("permissions: { mode: auto }").plugins).toBeUndefined();
  });

  test("an empty plugin list is dropped (byte-identical bundles)", () => {
    expect(cli("plugins: []").plugins).toBeUndefined();
  });
});

describe("Item 5 (G44) — thredz.messaging lowering", () => {
  test("messaging: true lowers to messaging on IrThredz", () => {
    const ir = cli("thredz:\n  api_key: $THREDZ_API_KEY\n  messaging: true");
    expect(ir.thredz?.messaging).toBe(true);
  });

  test("messaging is ABSENT when omitted (default-off, byte-identical thredz)", () => {
    const ir = cli("thredz: true");
    expect(ir.thredz).toEqual({
      apiKey: { kind: "env", name: "THREDZ_API_KEY" },
      visibility: "private",
      goals: true,
    });
    expect(ir.thredz && "messaging" in ir.thredz).toBe(false);
  });

  test("messaging: false is treated as off (not carried)", () => {
    const ir = cli("thredz:\n  api_key: $THREDZ_API_KEY\n  messaging: false");
    expect(ir.thredz && "messaging" in ir.thredz).toBe(false);
  });
});

describe("Item 2 (G31) — sub_agents.federation lowering", () => {
  test("federation.url lowers onto the sub-agent definition", () => {
    const ir = cli(
      [
        "  sub_agents:",
        "    peer:",
        "      description: a remote peer",
        "      instructions: delegate",
        "      federation:",
        "        url: https://peer.example.com",
      ].join("\n"),
    );
    const peer = ir.subAgents.find((s) => s.name === "peer");
    expect(peer?.federation).toEqual({ url: "https://peer.example.com" });
  });

  test("a local sub-agent has no federation field", () => {
    const ir = cli(
      ["  sub_agents:", "    helper:", "      description: helps", "      instructions: help"].join(
        "\n",
      ),
    );
    const helper = ir.subAgents.find((s) => s.name === "helper");
    expect(helper && "federation" in helper).toBe(false);
  });
});

describe("Item 9 (G37) — per-role / per-step model routing", () => {
  test("crew role lowers a model_pool via lowerModelFailover", () => {
    const ir = lower(
      parseSpec(
        [
          "name: cr",
          "target: crew",
          "model: base-model",
          "entry: lead",
          "roles:",
          "  lead:",
          "    instructions: lead it",
          "    model_pool:",
          "      candidates:",
          "        - model: claude-haiku-4-5",
          "          tags: [cheap]",
          "        - model: claude-opus-4-8",
          "          tags: [strong]",
          "      policy: learned",
        ].join("\n"),
      ),
    ) as IrCrewV0;
    const lead = ir.roles.find((r) => r.name === "lead");
    expect(lead?.modelPool?.policy).toBe("learned");
    expect(lead?.modelPool?.candidates.map((c) => c.model)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-8",
    ]);
    // The crew fallback model still resolves for the role's primary slot.
    expect(lead?.model).toBe("base-model");
  });

  test("crew role lowers model_tiers + model_fallbacks + circuit_breaker", () => {
    const ir = lower(
      parseSpec(
        [
          "name: cr",
          "target: crew",
          "model: base-model",
          "entry: lead",
          "roles:",
          "  lead:",
          "    instructions: lead it",
          "    model_fallbacks: [claude-haiku-4-5]",
          "    circuit_breaker:",
          "      cooldownMs: 5000",
        ].join("\n"),
      ),
    ) as IrCrewV0;
    const lead = ir.roles.find((r) => r.name === "lead");
    expect(lead?.modelFallbacks).toEqual(["claude-haiku-4-5"]);
    expect(lead?.circuitBreaker).toEqual({ cooldownMs: 5000 });
  });

  test("a role without routing has none of the routing fields (byte-identical)", () => {
    const ir = lower(
      parseSpec(
        [
          "name: cr",
          "target: crew",
          "model: base-model",
          "entry: lead",
          "roles:",
          "  lead:",
          "    instructions: lead it",
        ].join("\n"),
      ),
    ) as IrCrewV0;
    const lead = ir.roles.find((r) => r.name === "lead");
    expect(lead && "modelPool" in lead).toBe(false);
    expect(lead && "modelTiers" in lead).toBe(false);
    expect(lead && "modelFallbacks" in lead).toBe(false);
  });

  test("workflow step lowers a model_pool via lowerModelFailover", () => {
    const ir = lower(
      parseSpec(
        [
          "name: w",
          "target: workflow",
          "model: base-model",
          "steps:",
          "  - name: s",
          "    instructions: do it",
          "    model_pool:",
          "      candidates:",
          "        - model: claude-haiku-4-5",
          "          tags: [cheap]",
          "        - model: claude-opus-4-8",
          "          tags: [strong]",
          "      policy: heuristic",
        ].join("\n"),
      ),
    ) as IrWorkflowV0;
    const step = ir.steps[0];
    expect(step?.modelPool?.policy).toBe("heuristic");
    expect(step?.model).toBe("base-model");
  });

  test("a judge step carries no model routing (gate runs no agent turn)", () => {
    const ir = lower(
      parseSpec(
        [
          "name: w",
          "target: workflow",
          "model: base-model",
          "steps:",
          "  - name: s1",
          "    instructions: draft",
          "  - name: gate",
          "    kind: judge",
          "    judge:",
          "      criteria: is it good",
        ].join("\n"),
      ),
    ) as IrWorkflowV0;
    const gate = ir.steps.find((s) => s.name === "gate");
    expect(gate?.kind).toBe("judge");
    expect(gate && "modelPool" in gate).toBe(false);
  });
});

describe("Batch G keys never warn (wired this batch)", () => {
  test("cli expose + plugins + federation + thredz.messaging produce no warnings", () => {
    const result = compile(
      [
        "name: c",
        "target: cli",
        "agent:",
        "  model: m",
        "  instructions: i",
        "  sub_agents:",
        "    peer:",
        "      description: remote",
        "      instructions: delegate",
        "      federation:",
        "        url: https://peer.example.com",
        "expose:",
        "  mcp:",
        "    transport: stdio",
        "    tools: per-subagent",
        "plugins:",
        "  - acme-tools",
        "thredz:",
        "  api_key: $THREDZ_API_KEY",
        "  messaging: true",
      ].join("\n"),
    );
    expect(result.warnings).toEqual([]);
  });

  test("channel expose + plugins produce no warnings", () => {
    const result = compile(
      [
        "name: c",
        "target: channel",
        "agent: { model: m, instructions: i }",
        "channels: { slack: { botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET } }",
        "routing: { sessionKey: thread }",
        "expose: { mcp: { transport: sse } }",
        "plugins: [acme-tools]",
      ].join("\n"),
    );
    expect(paths(result.warnings)).toEqual([]);
  });
});
