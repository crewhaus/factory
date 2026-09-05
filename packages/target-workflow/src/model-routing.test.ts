/**
 * Loop contract 0.4 (Batch G, item 9 / G37) — per-step model routing.
 *
 * Each non-judge step's `runChatLoop` call carries the pooled model-routing
 * fields (`modelFallbacks`/`circuitBreaker`/`modelTiers`/`modelPool`) exactly
 * as the cli agent block does, so a PolicyRouter decision per step rides the
 * shared `@crewhaus/routing-store` scoreboard. Judge steps carry NONE (they
 * score through eval-judge on their own resolved model, never the loop).
 */
import { describe, expect, test } from "bun:test";
import type { IrModelPool, IrWorkflowStep, IrWorkflowV0 } from "@crewhaus/ir";
import { emitWorkflow } from "./index";

function wf(steps: IrWorkflowStep[]): IrWorkflowV0 {
  return {
    version: 0,
    name: "routed",
    target: "workflow",
    steps,
    mcp_servers: {},
    permissions: { rules: [] },
    compaction: {},
  };
}

const POOL: IrModelPool = {
  candidates: [
    { model: "claude-haiku-4-5", tags: ["fast"] },
    { model: "claude-sonnet-4-5", tags: ["deep"] },
  ],
  policy: "heuristic",
};

function agentOf(ir: IrWorkflowV0): string {
  return emitWorkflow(ir, { readme: false }).files[0]?.content ?? "";
}

describe("emitWorkflow — per-step model routing (item 9)", () => {
  test("model_pool on a step emits a modelPool field on that step's runChatLoop", () => {
    const c = agentOf(
      wf([
        {
          name: "draft",
          instructions: "draft",
          model: "claude-sonnet-4-5",
          tools: [],
          toolConfigs: {},
          modelPool: POOL,
        },
      ]),
    );
    expect(c).toContain('"policy":"heuristic"');
    expect(c).toContain("modelPool:");
    expect(c).toContain('"model":"claude-haiku-4-5"');
  });

  test("model_fallbacks + circuit_breaker emit onto the step call", () => {
    const c = agentOf(
      wf([
        {
          name: "draft",
          instructions: "draft",
          model: "claude-sonnet-4-5",
          tools: [],
          toolConfigs: {},
          modelFallbacks: ["openai/gpt-4o-mini"],
          circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
        },
      ]),
    );
    expect(c).toContain('modelFallbacks: ["openai/gpt-4o-mini"],');
    expect(c).toContain('circuitBreaker: {"failureThreshold":2,"cooldownMs":60000},');
  });

  test("model_tiers emit onto the step call", () => {
    const c = agentOf(
      wf([
        {
          name: "draft",
          instructions: "draft",
          model: "claude-sonnet-4-5",
          tools: [],
          toolConfigs: {},
          modelTiers: { fast: "claude-haiku-4-5", default: "claude-sonnet-4-5" },
        },
      ]),
    );
    expect(c).toContain('modelTiers: {"fast":"claude-haiku-4-5","default":"claude-sonnet-4-5"},');
  });

  test("0.6.0 PR 9a — a pooled step's blob is stamped with `scope: <step name>` when the spec pinned none; a declared scope wins", () => {
    const stamped = agentOf(
      wf([
        {
          name: "draft",
          instructions: "draft",
          model: "claude-sonnet-4-5",
          tools: [],
          toolConfigs: {},
          modelPool: POOL,
        },
      ]),
    );
    expect(stamped).toContain(
      '\n    modelPool: {"candidates":[{"model":"claude-haiku-4-5","tags":["fast"]},{"model":"claude-sonnet-4-5","tags":["deep"]}],"policy":"heuristic","scope":"draft"},\n',
    );
    const declared = agentOf(
      wf([
        {
          name: "draft",
          instructions: "draft",
          model: "claude-sonnet-4-5",
          tools: [],
          toolConfigs: {},
          modelPool: { ...POOL, scope: "my-arms" },
        },
      ]),
    );
    expect(declared).toContain('"policy":"heuristic","scope":"my-arms"},');
    expect(declared).not.toContain('"scope":"draft"');
  });

  test("0.6.0 PR 9a — a step-level temperature renders beside the tuning fields", () => {
    const c = agentOf(
      wf([
        {
          name: "draft",
          instructions: "draft",
          model: "m",
          tools: [],
          toolConfigs: {},
          temperature: 0.4,
        },
      ]),
    );
    expect(c).toContain("\n    temperature: 0.4,");
  });

  test("a step without routing stays byte-identical (no modelPool/tiers/fallbacks)", () => {
    const c = agentOf(
      wf([{ name: "draft", instructions: "draft", model: "m", tools: [], toolConfigs: {} }]),
    );
    expect(c).not.toContain("modelPool:");
    expect(c).not.toContain("modelTiers:");
    expect(c).not.toContain("modelFallbacks:");
    expect(c).not.toContain("circuitBreaker:");
  });

  test("a judge step carries NO model routing (scores on its own model)", () => {
    // The judge's own model routing is meaningless — a judge cannot legally
    // carry these in the spec, and the emitter must never surface them on the
    // scoring pass. Only the gated (plain) step routes.
    const c = agentOf(
      wf([
        {
          name: "draft",
          instructions: "write something",
          model: "claude-sonnet-4-5",
          tools: [],
          toolConfigs: {},
          modelPool: POOL,
        },
        {
          name: "grade",
          instructions: "grade it",
          model: "claude-opus-4-5",
          tools: [],
          toolConfigs: {},
          kind: "judge",
          judge: { criteria: "is it good", threshold: 0.6, onFail: "continue", maxRetries: 0 },
        },
      ]),
    );
    // The pool appears exactly once — on the gated step, not the judge pass.
    const poolMatches = c.match(/modelPool:/g) ?? [];
    expect(poolMatches.length).toBe(1);
    // The judge scoring pass runs through __judgeGate, not a modelPool call.
    expect(c).toContain("[step 2/2: grade (judge)]");
  });

  test("model routing threads onto a judge-GATED (retry_previous) step closure", () => {
    const c = agentOf(
      wf([
        {
          name: "draft",
          instructions: "write",
          model: "claude-sonnet-4-5",
          tools: [],
          toolConfigs: {},
          modelFallbacks: ["openai/gpt-4o-mini"],
        },
        {
          name: "grade",
          instructions: "grade",
          model: "claude-opus-4-5",
          tools: [],
          toolConfigs: {},
          kind: "judge",
          judge: { criteria: "good", threshold: 0.7, onFail: "retry_previous", maxRetries: 2 },
        },
      ]),
    );
    // The gated step is emitted as a re-invocable closure; its routing rides
    // the same runChatLoop options as a plain step.
    expect(c).toContain("const __runStep1 = async (__nudge: string)");
    expect(c).toContain('modelFallbacks: ["openai/gpt-4o-mini"],');
  });
});

describe("0.6.0 PR 9d — side-call strategies on a step", () => {
  const COMMITTEE: IrModelPool = {
    ...POOL,
    strategy: { committee: { members: ["fast", "deep"], judge: "claude-opus-4-8" } },
  };
  const step = (modelPool?: IrModelPool): IrWorkflowStep => ({
    name: "draft",
    instructions: "draft",
    model: "claude-sonnet-4-5",
    tools: [],
    toolConfigs: {},
    ...(modelPool !== undefined ? { modelPool } : {}),
  });

  test("a step whose pool declares a committee renders the wireSideCalls spread after modelPool and imports the composition root", () => {
    const c = agentOf(wf([step(COMMITTEE)]));
    expect(c).toContain('import { wireSideCalls } from "@crewhaus/model-service";');
    const pool = JSON.stringify({ ...COMMITTEE, scope: "draft" });
    expect(c).toContain(
      `\n    modelPool: ${pool},\n    ...wireSideCalls(${pool}, { sessionName: "routed" }),\n`,
    );
    expect((c.match(/wireSideCalls\(/g) ?? []).length).toBe(1);
  });

  test("a judge-gated step renders it on its re-invocable closure too", () => {
    const c = agentOf(
      wf([
        step(COMMITTEE),
        {
          name: "gate",
          instructions: "",
          model: "claude-sonnet-4-5",
          tools: [],
          toolConfigs: {},
          kind: "judge",
          judge: {
            criteria: "c",
            model: "claude-sonnet-4-5",
            threshold: 0.7,
            onFail: "retry_previous",
            maxRetries: 1,
          },
        } as IrWorkflowStep,
      ]),
    );
    expect(c).toContain("const __runStep1 = async (__nudge: string)");
    expect(c).toContain("...wireSideCalls(");
  });

  test("byte-identity: a pooled step without a side-call strategy renders neither the spread nor the import", () => {
    const c = agentOf(wf([step(POOL)]));
    expect(c).not.toContain("wireSideCalls");
    expect(c).not.toContain("@crewhaus/model-service");
    expect(agentOf(wf([step()]))).not.toContain("wireSideCalls");
  });
});
