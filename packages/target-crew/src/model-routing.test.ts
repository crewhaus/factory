/**
 * Loop contract 0.4 (Batch G, item 9 / G37) — per-role model routing.
 *
 * A crew role's pooled model-routing config (`modelFallbacks`/
 * `circuitBreaker`/`modelTiers`/`modelPool`) is emitted onto the role's
 * `RoleDefinition` literal, mirroring the cli agent block. The crew
 * orchestrator forwards a RoleDefinition's config into this role's
 * `runChatLoop` turns (the cross-package forwarding — see the return notes),
 * so the PolicyRouter decision per role shares the `@crewhaus/routing-store`
 * scoreboard. Absent routing keeps the role file byte-identical.
 */
import { describe, expect, test } from "bun:test";
import type { IrCrewRole, IrCrewV0, IrModelPool } from "@crewhaus/ir";
import { emitCrew } from "./index.js";

const baseRole = { tools: [], toolConfigs: Object.freeze({}), subAgents: [] };

function crewWithEntryRole(extra: Partial<IrCrewRole>): IrCrewV0 {
  return {
    version: 0,
    name: "routed-crew",
    target: "crew",
    entry: "lead",
    roles: [
      {
        name: "lead",
        model: "claude-sonnet-4-6",
        instructions: "You are the lead.",
        ...baseRole,
        ...extra,
      },
      { name: "helper", model: "claude-sonnet-4-6", instructions: "Helper.", ...baseRole },
    ],
    mcp_servers: Object.freeze({}),
    permissions: { rules: [] },
    compaction: {},
  };
}

const POOL: IrModelPool = {
  candidates: [
    { model: "claude-haiku-4-5", tags: ["fast"] },
    { model: "claude-sonnet-4-5", tags: ["deep"] },
  ],
  policy: "learned",
};

function leadAgent(ir: IrCrewV0): string {
  return (
    emitCrew(ir, { readme: false }).files.find((f) => f.path === "agent_lead.ts")?.content ?? ""
  );
}

describe("emitCrew — per-role model routing (item 9)", () => {
  test("model_pool on a role emits modelPool on its RoleDefinition", () => {
    const c = leadAgent(crewWithEntryRole({ modelPool: POOL }));
    expect(c).toContain("modelPool:");
    expect(c).toContain('"policy":"learned"');
    expect(c).toContain('"model":"claude-haiku-4-5"');
  });

  test("model_fallbacks + circuit_breaker emit onto the RoleDefinition", () => {
    const c = leadAgent(
      crewWithEntryRole({
        modelFallbacks: ["openai/gpt-4o-mini", "groq/llama-3.3-70b"],
        circuitBreaker: { failureThreshold: 3, windowMs: 30_000, cooldownMs: 60_000 },
      }),
    );
    expect(c).toContain('modelFallbacks: ["openai/gpt-4o-mini", "groq/llama-3.3-70b"],');
    expect(c).toContain(
      'circuitBreaker: {"failureThreshold":3,"windowMs":30000,"cooldownMs":60000},',
    );
  });

  test("model_tiers emit onto the RoleDefinition", () => {
    const c = leadAgent(
      crewWithEntryRole({
        modelTiers: { fast: "claude-haiku-4-5", default: "claude-sonnet-4-5" },
      }),
    );
    expect(c).toContain('modelTiers: {"fast":"claude-haiku-4-5","default":"claude-sonnet-4-5"},');
  });

  test("routing rides alongside the existing per-role tuning fields", () => {
    const c = leadAgent(crewWithEntryRole({ maxTokens: 4096, modelPool: POOL }));
    expect(c).toContain("maxTokens: 4096,");
    expect(c).toContain("modelPool:");
  });

  test("a role without routing stays byte-identical", () => {
    const c = leadAgent(crewWithEntryRole({}));
    expect(c).not.toContain("modelPool:");
    expect(c).not.toContain("modelTiers:");
    expect(c).not.toContain("modelFallbacks:");
    expect(c).not.toContain("circuitBreaker:");
  });

  test("routing is per-role — a plain sibling role is untouched", () => {
    const ir = crewWithEntryRole({ modelPool: POOL });
    const helper =
      emitCrew(ir, { readme: false }).files.find((f) => f.path === "agent_helper.ts")?.content ??
      "";
    expect(helper).not.toContain("modelPool:");
  });
});
