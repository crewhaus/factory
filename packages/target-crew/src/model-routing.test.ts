/**
 * Loop contract 0.4 (Batch G, item 9 / G37) — per-role model routing.
 *
 * A crew role's pooled model-routing config (`modelFallbacks`/
 * `circuitBreaker`/`modelTiers`/`modelPool`) is emitted onto the role's
 * `RoleDefinition` literal, mirroring the cli agent block. The crew
 * orchestrator forwards a RoleDefinition's config into this role's
 * `runChatLoop` turns (0.6.0 PR 3 — `@crewhaus/crew-orchestrator`'s
 * `composeLoopTuning`, covered by its own `index.test.ts` "per-role model
 * routing" suite, which drives a pooled role end to end and reads the
 * `model_route` line back), so the PolicyRouter decision per role shares the
 * `@crewhaus/routing-store` scoreboard. This file pins the EMIT half: the
 * four field names rendered here are the cross-package contract with
 * `RoleDefinition`. Absent routing keeps the role file byte-identical.
 *
 * 0.6.0 PR 7b (§4.2, §7.7, §7.9) — `modelPool` is the WIDENED `IrModelPool`:
 * per-candidate profile settings, the hybrid siblings and a declared `scope`
 * ride the literal verbatim (the orchestrator's `RoleModelPool` accepts that
 * shape — pinned at compile time in `@crewhaus/compiler`), while a pool
 * without any 0.6.0 key is byte-identical to the 0.5.x blob. The emitter
 * never stamps `scope`; the orchestrator defaults it to the role name.
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

describe("emitCrew — per-candidate profile enrichment on roles (0.6.0 PR 7b)", () => {
  const ENRICHED: IrModelPool = {
    candidates: [
      {
        model: "claude-haiku-4-5",
        tags: ["cheap"],
        profile: "fast",
        maxTokens: 4096,
        thinking: { effort: "low" },
        overlay: "You are the fast lane.",
        tools: ["read", "grep"],
      },
      {
        model: "claude-opus-4-8",
        tags: ["strong"],
        profile: "strong",
        thinking: { budgetTokens: 4096 },
        enabled: false,
      },
    ],
    policy: "heuristic",
  };

  test("per-candidate profile settings ride the role literal verbatim, model then tags first", () => {
    const c = leadAgent(crewWithEntryRole({ modelPool: ENRICHED }));
    expect(c).toContain(`modelPool: ${JSON.stringify(ENRICHED)},`);
    expect(c).toContain(
      '{"model":"claude-haiku-4-5","tags":["cheap"],"profile":"fast","maxTokens":4096,"thinking":{"effort":"low"},"overlay":"You are the fast lane.","tools":["read","grep"]}',
    );
    expect(c).toContain('"enabled":false');
    // The emitter never stamps a scope — the orchestrator does, per role, at runtime.
    expect(c).not.toContain('"scope"');
  });

  test("a declared scope and the hybrid siblings ride the role literal verbatim", () => {
    const scoped: IrModelPool = {
      ...POOL,
      directives: false,
      rules: [{ id: "code-goes-strong", when: { message_matches: "refactor" }, use: "deep" }],
      scope: "lead-arms",
    };
    const c = leadAgent(crewWithEntryRole({ modelPool: scoped }));
    expect(c).toContain('"directives":false');
    expect(c).toContain(
      '"rules":[{"id":"code-goes-strong","when":{"message_matches":"refactor"},"use":"deep"}]',
    );
    expect(c).toContain('"scope":"lead-arms"}');
  });

  test("a pool without 0.6.0 keys is the 0.5.x blob byte-for-byte (byte-identity)", () => {
    const c = leadAgent(crewWithEntryRole({ modelPool: POOL }));
    expect(c).toContain(
      '\n    modelPool: {"candidates":[{"model":"claude-haiku-4-5","tags":["fast"]},{"model":"claude-sonnet-4-5","tags":["deep"]}],"policy":"learned"},\n',
    );
  });
});
