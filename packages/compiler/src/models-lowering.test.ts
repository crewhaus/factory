/**
 * 0.6.0 PR 7 (design plan §4.2 / §4.3 / §11.3) — the `models:` registry and
 * `$profile` references LOWER: every model slot resolves through
 * `resolveModelRef` (the six that bypassed `resolveAuxModel` included), a
 * profile expands onto a single-model slot per the shape's contract, pool
 * candidates carry the merged profile inline, the hybrid pool siblings ride
 * the blob, `strongest` resolves roster-first, capability and sunset facts are
 * validated at compile time, and everything a slot cannot honour is a
 * field-precise warning. Absent config stays byte-identical — pinned here by
 * the key-order guard on a plain pool and by the no-new-keys sweep.
 */
import { describe, expect, test } from "bun:test";
import { CompilerError } from "@crewhaus/errors";
import type { IrV0 } from "@crewhaus/ir";
import { PROFILE_NAME_RE } from "@crewhaus/model-plan";
import { SPEC_PROFILE_NAME_RE, parseSpec, parseSpecIssues } from "@crewhaus/spec";
import { type CompileWarning, compile, lower, lowerWithWarnings } from "./index";

const TODAY = "2026-09-04";
const opts = { today: TODAY } as const;

const cli = (...blocks: string[]): string => ["name: hello", "target: cli", ...blocks].join("\n");

const REGISTRY = [
  "models:",
  "  fast:",
  "    model: claude-haiku-4-5",
  "    tags: [cheap]",
  "    max_tokens: 4096",
  "    thinking: { effort: low }",
  "    instructions: You are the fast lane.",
  "    limits: { model_call_timeout_ms: 20000 }",
  "    caching: prefer",
  "    requires: { tool_use: true, context_window_gte: 100000 }",
  "    fallbacks: [claude-sonnet-4-6]",
  "    circuit_breaker: { failureThreshold: 3 }",
  "  strong:",
  "    model: claude-opus-4-8",
  "    tags: [strong]",
  "    thinking: { budget_tokens: 4096 }",
  "  checker:",
  "    model: claude-sonnet-4-6",
  "    temperature: 0",
  "    max_tokens: 512",
  "    tools: []",
];

function codes(warnings: ReadonlyArray<CompileWarning>): string[] {
  return warnings.map((w) => w.code);
}

function cliIr(yaml: string): IrV0 {
  const ir = lower(parseSpec(yaml), opts);
  if (ir.target !== "cli") throw new Error("unexpected target");
  return ir;
}

describe("profile-name grammar parity", () => {
  test("the spec's SPEC_PROFILE_NAME_RE and model-plan's PROFILE_NAME_RE are the same literal", () => {
    expect(SPEC_PROFILE_NAME_RE.source).toBe(PROFILE_NAME_RE.source);
    expect(SPEC_PROFILE_NAME_RE.flags).toBe(PROFILE_NAME_RE.flags);
  });
});

describe("models: registry → IrModelProfiles", () => {
  test("lowers every profile field (snake_case → camelCase, cost → USD micros) onto ir.models", () => {
    const ir = cliIr(
      cli(
        ...REGISTRY,
        "  capped:",
        "    model: local/llama3@http://localhost:11434",
        "    cost: { max_usd: 0.5 }",
        "    rate_limits: { '*': { rpm: 60 } }",
        "    tool_config: { fetch: { timeoutMs: 8000 } }",
        "    permissions: { deny: ['Bash(*)'], ask: ['Edit(*)'] }",
        "    capabilities: { tool_use: true, vision: false, context_window: 32000 }",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: be helpful",
        "tools: [fetch]",
      ),
    );
    expect(ir.models?.fast).toEqual({
      profile: "fast",
      model: "claude-haiku-4-5",
      tags: ["cheap"],
      thinking: { effort: "low" },
      maxTokens: 4096,
      modelCallTimeoutMs: 20000,
      overlay: "You are the fast lane.",
      caching: "prefer",
      requires: { tool_use: true, contextWindowGte: 100000 },
      fallbacks: ["claude-sonnet-4-6"],
      circuitBreaker: { failureThreshold: 3 },
    });
    expect(ir.models?.capped).toEqual({
      profile: "capped",
      model: "local/llama3@http://localhost:11434",
      toolConfigs: { fetch: { timeoutMs: 8000 } },
      permissions: { deny: ["Bash(*)"], ask: ["Edit(*)"] },
      rateLimits: { "*": { rpm: 60 } },
      costCapUsdMicros: 500_000,
      capabilities: { tool_use: true, vision: false, contextWindow: 32000 },
    });
    expect(ir.models?.checker).toEqual({
      profile: "checker",
      model: "claude-sonnet-4-6",
      maxTokens: 512,
      temperature: 0,
      tools: [],
    });
    // Nothing in the IR ever carries a `$`.
    expect(JSON.stringify(ir)).not.toContain('"$');
  });

  test("the registry is ABSENT from the IR when the spec declares none, on every shape", () => {
    const ir = cliIr(cli("agent:", "  model: m", "  instructions: i"));
    expect("models" in ir).toBe(false);
  });

  test("a profile's own `strongest` resolves by price rank against the primary (circularity rule)", () => {
    const ir = cliIr(
      cli(
        "models:",
        "  big: { model: strongest, tags: [strong] }",
        "  small: { model: cheapest }",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
      ),
    );
    expect(ir.models?.big?.model).toMatch(/^claude-opus/);
    expect(ir.models?.small?.model).toBe("claude-haiku-4-5");
  });
});

describe("$profile on the serving agent slot (agent-full)", () => {
  const SPEC = cli(
    ...REGISTRY,
    "agent:",
    "  model: $fast",
    "  instructions: be helpful",
    "tools: [read]",
  );

  test("expands model / thinking / maxTokens + provenance, folds the overlay, inherits the failover chain", () => {
    const ir = cliIr(SPEC);
    expect(ir.agent).toEqual({
      model: "claude-haiku-4-5",
      instructions: "You are the fast lane.\n\nbe helpful",
      modelProfile: "fast",
      maxTokens: 4096,
      thinking: { effort: "low" },
      modelFallbacks: ["claude-sonnet-4-6"],
      circuitBreaker: { failureThreshold: 3 },
    });
  });

  test("slot-local fields override the profile field-by-field", () => {
    const ir = cliIr(
      cli(...REGISTRY, "agent:", "  model: $fast", "  instructions: i", "  max_tokens: 99"),
    );
    expect(ir.agent.maxTokens).toBe(99);
    expect(ir.agent.thinking).toEqual({ effort: "low" });
  });

  test("a slot-local temperature drops the profile's thinking (the pair is exclusive on one request)", () => {
    const ir = cliIr(
      cli(...REGISTRY, "agent:", "  model: $fast", "  instructions: i", "  temperature: 0.3"),
    );
    expect(ir.agent.temperature).toBe(0.3);
    expect("thinking" in ir.agent).toBe(false);
  });

  test("a profile temperature lands on the slot; a slot temperature is reported pending (PR 9a)", () => {
    const { ir, warnings } = lowerWithWarnings(
      parseSpec(
        cli(
          "models:",
          "  warm: { model: claude-sonnet-4-6, temperature: 0.7, max_tokens: 512 }",
          "agent:",
          "  model: $warm",
          "  instructions: i",
        ),
      ),
      opts,
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.agent.temperature).toBe(0.7);
    expect(ir.agent.maxTokens).toBe(512);
    // PR 9a — the runtime request build applies the slot temperature, so it
    // no longer pends (nothing else on this spec does either).
    const pending = warnings.filter((w) => w.code === "model-plan-pending-runtime");
    expect(pending).toEqual([]);
  });

  test("the profile's failover chain is ignored (field-precise) when the slot routes itself", () => {
    const { ir, warnings } = lowerWithWarnings(
      parseSpec(
        cli(
          ...REGISTRY,
          "agent:",
          "  model: $fast",
          "  instructions: i",
          "  model_pool:",
          "    candidates:",
          "      - { model: claude-haiku-4-5, tags: [cheap] }",
          "      - { model: claude-opus-4-8, tags: [strong] }",
        ),
      ),
      opts,
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect("modelFallbacks" in ir.agent).toBe(false);
    const ignored = warnings.filter((w) => w.code === "model-plan-ignored-on-slot");
    expect(ignored.map((w) => w.path).sort()).toEqual([
      "models.fast.circuit_breaker",
      "models.fast.fallbacks",
    ]);
    expect(ignored[0]?.message).toContain("declares its own model_pool");
  });

  test("the narrowing knobs (limits / caching) on a serving slot are reported pending, never dropped silently", () => {
    const { warnings } = lowerWithWarnings(
      parseSpec(cli(...REGISTRY, "agent:", "  model: $fast", "  instructions: i")),
      opts,
    );
    expect(warnings.map((w) => w.path).sort()).toEqual([
      "models.fast.caching",
      "models.fast.limits.model_call_timeout_ms",
    ]);
    for (const w of warnings) {
      expect(w.code).toBe("model-plan-pending-runtime");
      // PR 9a honours these on a POOL CANDIDATE; a single-model serving slot
      // has no per-candidate plan carrier in the IR yet.
      expect(w.message).toContain("single-model serving slot");
      expect(w.message).toContain("model_pool candidate");
    }
  });

  test("an unknown $ref is a CompilerError with a did-you-mean even when lower() is fed a hand-built spec", () => {
    const spec = parseSpec(cli(...REGISTRY, "agent:", "  model: $fast", "  instructions: i"));
    const tampered = { ...spec, agent: { ...spec.agent, model: "$fsat" } } as typeof spec;
    expect(() => lower(tampered, opts)).toThrow(CompilerError);
    expect(() => lower(tampered, opts)).toThrow(/did you mean "\$fast"/);
  });
});

describe("$profile on the other serving shapes (per-shape contract, §11.3)", () => {
  test("workflow step / graph node / crew role: full expansion; a step without `model` inherits the top-level slot's profile", () => {
    const wf = lower(
      parseSpec(
        [
          "name: w",
          "target: workflow",
          ...REGISTRY,
          "model: $fast",
          "steps:",
          "  - name: draft",
          "    instructions: write",
          "  - name: polish",
          "    instructions: polish",
          "    model: $strong",
        ].join("\n"),
      ),
      opts,
    );
    if (wf.target !== "workflow") throw new Error("unexpected target");
    expect(wf.steps[0]).toMatchObject({
      model: "claude-haiku-4-5",
      modelProfile: "fast",
      instructions: "You are the fast lane.\n\nwrite",
      maxTokens: 4096,
      thinking: { effort: "low" },
      modelFallbacks: ["claude-sonnet-4-6"],
    });
    expect(wf.steps[1]).toMatchObject({
      model: "claude-opus-4-8",
      modelProfile: "strong",
      thinking: { budgetTokens: 4096 },
    });

    const graph = lower(
      parseSpec(
        [
          "name: g",
          "target: graph",
          ...REGISTRY,
          "model: claude-sonnet-4-6",
          "entry: a",
          "nodes:",
          "  a: { instructions: x, model: $strong }",
        ].join("\n"),
      ),
      opts,
    );
    if (graph.target !== "graph") throw new Error("unexpected target");
    expect(graph.nodes[0]).toMatchObject({ model: "claude-opus-4-8", modelProfile: "strong" });

    const crew = lower(
      parseSpec(
        [
          "name: c",
          "target: crew",
          ...REGISTRY,
          "model: claude-sonnet-4-6",
          "entry: lead",
          "roles:",
          "  lead: { instructions: go, model: $fast }",
        ].join("\n"),
      ),
      opts,
    );
    if (crew.target !== "crew") throw new Error("unexpected target");
    expect(crew.roles[0]).toMatchObject({
      model: "claude-haiku-4-5",
      modelProfile: "fast",
      modelFallbacks: ["claude-sonnet-4-6"],
    });
  });

  test("research / batch / browser (agent-params): maxTokens + overlay honoured, thinking + failover warned ignored-on-shape", () => {
    const { ir, warnings } = lowerWithWarnings(
      parseSpec(
        [
          "name: r",
          "target: research",
          ...REGISTRY,
          "agent:",
          "  model: $fast",
          "  instructions: dig",
          "goal: find things",
        ].join("\n"),
      ),
      opts,
    );
    if (ir.target !== "research") throw new Error("unexpected target");
    expect(ir.agent).toMatchObject({
      model: "claude-haiku-4-5",
      modelProfile: "fast",
      maxTokens: 4096,
      instructions: "You are the fast lane.\n\ndig",
    });
    expect("thinking" in ir.agent).toBe(false);
    const shape = warnings.filter((w) => w.code === "model-plan-ignored-on-shape");
    expect(shape.map((w) => w.path).sort()).toEqual([
      "models.fast.circuit_breaker",
      "models.fast.fallbacks",
      "models.fast.thinking",
    ]);
    expect(shape[0]?.message).toContain("research shape");
  });

  test("voice / eval / onchain (agent-model): profile → model + provenance only; every other field warned per field", () => {
    const { ir, warnings } = lowerWithWarnings(
      parseSpec(
        [
          "name: v",
          "target: voice",
          "models:",
          "  fast:",
          "    model: claude-haiku-4-5",
          "    max_tokens: 4096",
          "    thinking: { effort: low }",
          "    tools: [read]",
          "    permissions: { deny: ['Bash(*)'] }",
          "agent:",
          "  model: $fast",
          "  instructions: speak",
          "voice:",
          "  provider: openai",
          "tools: [read]",
        ].join("\n"),
      ),
      opts,
    );
    if (ir.target !== "voice") throw new Error("unexpected target");
    expect(ir.agent).toEqual({
      model: "claude-haiku-4-5",
      instructions: "speak",
      modelProfile: "fast",
    });
    const shape = warnings.filter((w) => w.code === "model-plan-ignored-on-shape");
    expect(shape.map((w) => w.path).sort()).toEqual([
      "models.fast.max_tokens",
      "models.fast.permissions",
      "models.fast.thinking",
      "models.fast.tools",
    ]);
    expect(shape.find((w) => w.path === "models.fast.tools")?.message).toContain(
      "registers no tool catalog",
    );
    // No ACCEPTED_BUT_UNWIRED row for `models:` — the field-precise notices are the whole story.
    expect(compile(parseSpecYaml(ir), opts).warnings.map((w) => w.path)).not.toContain("models");
  });
});

/** Re-render a lowered voice IR's spec for the ACCEPTED_BUT_UNWIRED probe above. */
function parseSpecYaml(ir: { readonly target: string }): string {
  return [
    "name: v",
    `target: ${ir.target}`,
    "models:",
    "  fast: { model: claude-haiku-4-5 }",
    "agent:",
    "  model: $fast",
    "  instructions: speak",
    "voice:",
    "  provider: openai",
  ].join("\n");
}

describe("$profile / sentinels on every auxiliary slot (the six that bypassed resolveAuxModel, plus the judges)", () => {
  const AUX = cli(
    ...REGISTRY,
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: i",
    "  sub_agents:",
    "    helper: { description: helps, instructions: help, model: $fast, tools: [read] }",
    "tools: [read]",
    "compaction: { model: $checker }",
    "security: { justification: { judge: claude, model: $checker } }",
    "budget: { usd: 1, on_exceed: { action: degrade, model: $fast } }",
    "evaluation:",
    "  grader: { type: llm_judge, criteria: helpful, model: $checker }",
    "watchme: { judge: { model: $checker } }",
  );

  test("compaction / security / degrade / watchme / grader carry the resolved model, provenance and pinned params", () => {
    const { ir, warnings } = lowerWithWarnings(parseSpec(AUX), opts);
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.compaction).toEqual({
      model: "claude-sonnet-4-6",
      modelProfile: "checker",
      params: { maxTokens: 512, temperature: 0 },
    });
    expect(ir.security?.justification).toEqual({
      judge: "claude",
      model: "claude-sonnet-4-6",
      modelProfile: "checker",
      params: { maxTokens: 512, temperature: 0 },
    });
    expect(ir.budget?.onExceed).toEqual({
      kind: "degrade",
      model: "claude-haiku-4-5",
      modelProfile: "fast",
      params: { thinking: { effort: "low" }, maxTokens: 4096 },
    });
    expect(ir.watchme).toMatchObject({
      judgeModel: "claude-sonnet-4-6",
      judgeProfile: "checker",
      judgeParams: { maxTokens: 512, temperature: 0 },
    });
    // The grader folds the profile temperature onto its own pin and keeps the rest as params.
    expect(ir.evaluation?.grader).toEqual({
      type: "llm_judge",
      criteria: "helpful",
      model: "claude-sonnet-4-6",
      modelProfile: "checker",
      temperature: 0,
      params: { maxTokens: 512 },
    });
    // The sub-agent slot is a serving slot: full expansion — except the
    // overlay, which rides RAW: a Task call may pin an `allowed_profiles`
    // entry whose overlay replaces it, so the spawner folds, not the compiler.
    expect(ir.subAgents[0]).toMatchObject({
      name: "helper",
      model: "claude-haiku-4-5",
      modelProfile: "fast",
      instructions: "help",
      overlay: "You are the fast lane.",
      maxTokens: 4096,
      thinking: { effort: "low" },
      modelFallbacks: ["claude-sonnet-4-6"],
    });
    // A judge profile's `tools: []` is the documented no-op — no warning for it.
    expect(warnings.map((w) => w.path)).not.toContain("models.checker.tools");
    // The aux params are carried but pending their consumers.
    const pendingAux = warnings.filter(
      (w) => w.code === "model-plan-pending-runtime" && w.message.includes("pinned request params"),
    );
    expect(pendingAux.map((w) => w.path).sort()).toEqual([
      "budget.on_exceed.model",
      "compaction.model",
      "evaluation.grader.model",
      "security.justification.model",
      "watchme.judge.model",
    ]);
  });

  test("`cheapest` now works on the slots that bypassed it (degrade, security, watchme, sub-agent, grounding)", () => {
    const ir = cliIr(
      cli(
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  sub_agents:",
        "    helper: { description: helps, instructions: help, model: cheapest }",
        "security: { justification: { judge: claude, model: cheapest } }",
        "budget: { usd: 1, on_exceed: { action: degrade, model: cheapest } }",
        "watchme: { judge: { model: cheapest } }",
      ),
    );
    expect(ir.security?.justification?.model).toBe("claude-haiku-4-5");
    expect(ir.budget?.onExceed).toEqual({ kind: "degrade", model: "claude-haiku-4-5" });
    expect(ir.watchme?.judgeModel).toBe("claude-haiku-4-5");
    expect(ir.subAgents[0]?.model).toBe("claude-haiku-4-5");

    const browser = lower(
      parseSpec(
        [
          "name: b",
          "target: browser",
          "agent:",
          "  model: claude-sonnet-4-6",
          "  instructions: i",
          "groundingModel: cheapest",
        ].join("\n"),
      ),
      opts,
    );
    if (browser.target !== "browser") throw new Error("unexpected target");
    expect(browser.groundingModel).toBe("claude-haiku-4-5");
  });

  test("judge steps / nodes, judge panels and the watchme default stay byte-identical without profiles", () => {
    const ir = cliIr(cli("agent:", "  model: m", "  instructions: i", "watchme: {}"));
    expect(ir.watchme).toEqual({
      enabled: true,
      capture: "full",
      judgeModel: "claude-haiku-4-5",
      judgeSampleRate: 0.15,
      judgeBudgetUsd: 0,
      scope: "harness",
      share: false,
    });
  });

  test("workflow judge step: $profile judge model + panel fields lower; a $ref on judges[] resolves", () => {
    const { ir, warnings } = lowerWithWarnings(
      parseSpec(
        [
          "name: w",
          "target: workflow",
          ...REGISTRY,
          "model: claude-sonnet-4-6",
          "steps:",
          "  - name: draft",
          "    instructions: write",
          "  - name: gate",
          "    kind: judge",
          "    judge: { criteria: good, model: $checker, repeats: 3, target: transcript }",
          "  - name: panel",
          "    kind: judge",
          "    judge: { criteria: fair, judges: [$strong, claude-haiku-4-5], temperature: 0.1 }",
        ].join("\n"),
      ),
      opts,
    );
    if (ir.target !== "workflow") throw new Error("unexpected target");
    expect(ir.steps[1]).toMatchObject({
      kind: "judge",
      model: "claude-sonnet-4-6",
      judge: {
        criteria: "good",
        threshold: 0.7,
        onFail: "retry_previous",
        maxRetries: 1,
        modelProfile: "checker",
        repeats: 3,
        temperature: 0,
        target: "transcript",
        params: { maxTokens: 512 },
      },
    });
    expect(ir.steps[2]?.judge).toMatchObject({
      judges: ["claude-opus-4-8", "claude-haiku-4-5"],
      temperature: 0.1,
    });
    expect(codes(warnings)).toContain("model-plan-pending-runtime");
    expect(warnings.find((w) => w.path === "steps[1].judge.repeats")?.message).toContain(
      "judge-panel wiring",
    );
  });

  test("crew routing.model lowers and the llm router runs on it", () => {
    const yaml = [
      "name: c",
      "target: crew",
      ...REGISTRY,
      "model: claude-sonnet-4-6",
      "entry: lead",
      "roles:",
      "  lead: { instructions: go }",
      "  helper: { instructions: help }",
      "routing: { kind: llm, model: $strong }",
    ].join("\n");
    const ir = lower(parseSpec(yaml), opts);
    if (ir.target !== "crew") throw new Error("unexpected target");
    expect(ir.routing).toEqual({ kind: "llm", model: "claude-opus-4-8", modelProfile: "strong" });
    const orch = compile(yaml, opts).files.find((f) => f.path === "orchestrator.ts")?.content ?? "";
    expect(orch).toContain('model: "claude-opus-4-8",');
    // The router model is a `model-only` slot: the profile's request params
    // have no home on the fixed 128-token classify turn and say so.
    expect(orch).not.toContain("$strong");
  });

  // 0.6.0 PR 7b (§4.2, §7.7, §7.9) — the crew half that needs the widened IR:
  // a role's pool candidates carry their profile settings onto the role
  // literal, which `@crewhaus/crew-orchestrator` forwards into the role's
  // turns. The compiler stamps NO `scope` (the orchestrator defaults it to the
  // role name at runtime), so a pre-0.6.0 pooled role stays byte-identical.
  test("crew role model_pool: $profile candidates lower with their settings onto the role literal; the compiler stamps no scope", () => {
    const yaml = [
      "name: c",
      "target: crew",
      ...REGISTRY,
      "model: claude-sonnet-4-6",
      "entry: lead",
      "roles:",
      "  lead:",
      "    instructions: go",
      "    model_pool:",
      "      candidates:",
      "        - { model: $fast }",
      "        - { model: $strong, max_tokens: 2048 }",
      "        - { model: claude-sonnet-4-6, tags: [mid], enabled: false }",
      "      policy: heuristic",
      "  helper: { instructions: help }",
    ].join("\n");
    const { ir, warnings } = lowerWithWarnings(parseSpec(yaml), opts);
    if (ir.target !== "crew") throw new Error("unexpected target");
    const lead = ir.roles.find((r) => r.name === "lead");
    const pool = lead?.modelPool;
    expect(pool?.policy).toBe("heuristic");
    expect(pool?.scope).toBeUndefined();
    const [fast, strong, mid] = pool?.candidates ?? [];
    expect(fast).toMatchObject({
      model: "claude-haiku-4-5",
      tags: ["cheap"],
      profile: "fast",
      thinking: { effort: "low" },
      maxTokens: 4096,
      overlay: "You are the fast lane.",
      fallbacks: ["claude-sonnet-4-6"],
    });
    // model then tags FIRST — the premise of the role literal's byte-identity.
    expect(Object.keys(fast ?? {}).slice(0, 3)).toEqual(["model", "tags", "profile"]);
    // A slot-local pin overrides the profile's field.
    expect(strong).toEqual({
      model: "claude-opus-4-8",
      tags: ["strong"],
      profile: "strong",
      thinking: { budgetTokens: 4096 },
      maxTokens: 2048,
    });
    expect(mid).toEqual({ model: "claude-sonnet-4-6", tags: ["mid"], enabled: false });
    // The un-pooled sibling role is untouched.
    expect(ir.roles.find((r) => r.name === "helper")?.modelPool).toBeUndefined();
    // PR 9a — the per-candidate settings the plan table honours lower
    // silently; PR 10 consumed the candidate's failover chain / breaker, so
    // nothing on a candidate pends any more.
    const pending = warnings.filter((w) => w.code === "model-plan-pending-runtime");
    expect(pending.map((w) => w.path)).toEqual([]);

    // The role literal carries the widened pool verbatim (what the
    // orchestrator's RoleModelPool accepts) — and no `$` reaches the bundle.
    const files = compile(yaml, opts).files;
    const leadTs = files.find((f) => f.path === "agent_lead.ts")?.content ?? "";
    expect(leadTs).toContain(`modelPool: ${JSON.stringify(pool)},`);
    expect(leadTs).toContain(
      '{"model":"claude-opus-4-8","tags":["strong"],"profile":"strong","thinking":{"budgetTokens":4096},"maxTokens":2048}',
    );
    expect(leadTs).toContain('"enabled":false');
    expect(leadTs).not.toContain('"scope"');
    expect(leadTs).not.toContain("$fast");
    expect(files.find((f) => f.path === "agent_helper.ts")?.content ?? "").not.toContain(
      "modelPool",
    );
  });

  test("crew role model_pool without 0.6.0 keys emits the 0.5.x blob byte-for-byte; a declared scope rides verbatim", () => {
    const plain = [
      "name: c",
      "target: crew",
      "model: claude-sonnet-4-6",
      "entry: lead",
      "roles:",
      "  lead:",
      "    instructions: go",
      "    model_pool:",
      "      candidates:",
      "        - { model: claude-haiku-4-5, tags: [cheap] }",
      "        - { model: claude-opus-4-8, tags: [strong] }",
      "      policy: heuristic",
    ];
    const plainOut = compile(plain.join("\n"), opts);
    const leadTs = plainOut.files.find((f) => f.path === "agent_lead.ts")?.content ?? "";
    expect(leadTs).toContain(
      '\n    modelPool: {"candidates":[{"model":"claude-haiku-4-5","tags":["cheap"]},{"model":"claude-opus-4-8","tags":["strong"]}],"policy":"heuristic"},\n',
    );
    expect(plainOut.warnings).toEqual([]);

    const scoped = compile([...plain, "      scope: lead-arms"].join("\n"), opts);
    const scopedTs = scoped.files.find((f) => f.path === "agent_lead.ts")?.content ?? "";
    expect(scopedTs).toContain('"policy":"heuristic","scope":"lead-arms"}');
    // PR 9a consumes `scope` (stamped on `model_route.scope`), so a declared
    // scope no longer pends.
    expect(scoped.warnings).toEqual([]);
  });
});

describe("the strongest sentinel (§4.3)", () => {
  test("roster-first: the first strong-tagged profile wins, carrying its profile as provenance", () => {
    const ir = cliIr(
      cli(
        ...REGISTRY,
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "evaluation:",
        "  grader: { type: llm_judge, criteria: helpful, model: strongest }",
      ),
    );
    expect(ir.evaluation?.grader).toMatchObject({
      model: "claude-opus-4-8",
      modelProfile: "strong",
    });
  });

  test("roster-first: without a strong tag the LAST declared roster member wins (candidates count)", () => {
    const ir = cliIr(
      cli(
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "  model_pool:",
        "    candidates:",
        "      - { model: claude-haiku-4-5, tags: [a] }",
        "      - { model: openai/gpt-5, tags: [b] }",
        "compaction: { model: strongest }",
      ),
    );
    expect(ir.compaction.model).toBe("openai/gpt-5");
  });

  test("bare single-model spec: price rank, same provider as the primary", () => {
    const ir = cliIr(
      cli(
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: i",
        "compaction: { model: strongest }",
      ),
    );
    expect(ir.compaction.model).toMatch(/^claude-opus/);
  });

  test("a local primary with a hosted strong judge compiles, and the cross-provider hop is noted", () => {
    const { ir, warnings } = lowerWithWarnings(
      parseSpec(
        cli(
          "models:",
          "  strong: { model: claude-opus-4-8, tags: [strong] }",
          "agent:",
          "  model: local/llama3@http://localhost:11434",
          "  instructions: i",
          "compaction: { model: strongest }",
        ),
      ),
      opts,
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.compaction.model).toBe("claude-opus-4-8");
    const note = warnings.find((w) => w.code === "model-strongest-crosses-provider");
    expect(note?.path).toBe("compaction.model");
    expect(note?.message).toContain("second credential");
  });

  test("no roster and a non-table primary is a CompilerError naming the slot", () => {
    expect(() =>
      lower(
        parseSpec(
          cli(
            "agent:",
            "  model: local/llama3@http://localhost:11434",
            "  instructions: i",
            "compaction: { model: strongest }",
          ),
        ),
        opts,
      ),
    ).toThrow(/compaction\.model: "strongest" cannot be resolved/);
  });
});

describe("compile-time capability + sunset validation (§4.3)", () => {
  test("a requirement the capability table says the model lacks is a CompilerError naming the key", () => {
    expect(() =>
      lower(
        parseSpec(
          cli(
            "models:",
            "  blind: { model: bedrock/meta.llama3-1-8b, requires: { vision: true } }",
            "agent:",
            "  model: claude-sonnet-4-6",
            "  instructions: i",
          ),
        ),
        opts,
      ),
    ).toThrow(/models\.blind: model "bedrock\/meta\.llama3-1-8b" cannot satisfy requires\.vision/);
  });

  test("thinking on a model that cannot think is a CompilerError; tools on a declared no-tool-use model too", () => {
    expect(() =>
      lower(
        parseSpec(
          cli(
            "models:",
            "  llama: { model: bedrock/meta.llama3-1-8b, thinking: { effort: low } }",
            "agent:",
            "  model: claude-sonnet-4-6",
            "  instructions: i",
          ),
        ),
        opts,
      ),
    ).toThrow(/does not support extended thinking/);
    expect(() =>
      lower(
        parseSpec(
          cli(
            "models:",
            "  loc:",
            "    model: local/llama3@http://localhost:11434",
            "    capabilities: { tool_use: false }",
            "    tools: [read]",
            "agent:",
            "  model: claude-sonnet-4-6",
            "  instructions: i",
            "tools: [read]",
          ),
        ),
        { ...opts, allowRuntimePendingKeys: true },
      ),
    ).toThrow(/does not support tool use/);
  });

  test("a non-table model without capabilities: gets ONE warning that adapter.features is the only gate", () => {
    const { warnings } = lowerWithWarnings(
      parseSpec(
        cli(
          "models:",
          "  loc: { model: local/llama3@http://localhost:11434, requires: { tool_use: true } }",
          "agent:",
          "  model: claude-sonnet-4-6",
          "  instructions: i",
        ),
      ),
      opts,
    );
    expect(warnings.filter((w) => w.code === "model-capabilities-unknown")).toHaveLength(1);
    expect(warnings[0]?.path).toBe("models.loc");
  });

  test("a sunset family warns with its replacement; past retiresOn a profile is an ERROR, a bare candidate stays a warning", () => {
    const profileSpec = cli(
      "models:",
      "  old: { model: claude-3-5-haiku }",
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
    );
    const { warnings } = lowerWithWarnings(parseSpec(profileSpec), { today: "2026-09-04" });
    expect(warnings).toEqual([
      {
        code: "model-sunset",
        path: "models.old",
        message: expect.stringContaining("migrate to claude-haiku-4-5"),
      },
    ]);
    expect(() => lower(parseSpec(profileSpec), { today: "2026-10-02" })).toThrow(
      /models\.old: model "claude-3-5-haiku" was retired on 2026-10-01/,
    );
    const candidateSpec = cli(
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5, tags: [cheap] }",
      "      - { model: claude-opus-4-1, tags: [strong] }",
    );
    const result = compile(candidateSpec, { today: "2026-09-04" });
    expect(result.warnings.map((w) => [w.code, w.path])).toEqual([
      ["model-sunset", "agent.model_pool.candidates[1]"],
    ]);
    expect(result.warnings[0]?.message).toContain("was retired on 2026-08-05");
  });
});

describe("model_pool candidates carry the merged profile (key order is the byte contract)", () => {
  const PLAIN_POOL = cli(
    "agent:",
    "  model: claude-sonnet-4-6",
    "  instructions: i",
    "  model_pool:",
    "    policy: heuristic",
    "    candidates:",
    "      - { model: claude-haiku-4-5, tags: [cheap] }",
    "      - { model: claude-opus-4-8, tags: [strong] }",
    "    objective: { quality: 0.6 }",
    "    routing: { strongTag: strong }",
    "    learning: { minSamplesPerArm: 2 }",
  );

  test("KEY-ORDER GUARD: a 0.5.x pool stringifies to exactly its 0.5.x bytes", () => {
    const ir = cliIr(PLAIN_POOL);
    expect(JSON.stringify(ir.agent.modelPool)).toBe(
      '{"candidates":[{"model":"claude-haiku-4-5","tags":["cheap"]},{"model":"claude-opus-4-8","tags":["strong"]}],"policy":"heuristic","objective":{"quality":0.6},"routing":{"strongTag":"strong"},"learning":{"minSamplesPerArm":2}}',
    );
    expect(compile(PLAIN_POOL, opts).warnings).toEqual([]);
  });

  test("a $profile candidate merges the profile (defaults) with its inline fields (overrides); tags replace / inherit", () => {
    const { ir, warnings } = lowerWithWarnings(
      parseSpec(
        cli(
          ...REGISTRY,
          "agent:",
          "  model: claude-sonnet-4-6",
          "  instructions: i",
          "  model_pool:",
          "    candidates:",
          "      - { model: $fast, max_tokens: 1024 }",
          "      - { model: $strong, tags: [heavy, strong] }",
          "      - { model: claude-sonnet-4-6, tags: [mid], enabled: false }",
          "tools: [read]",
        ),
      ),
      opts,
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    const [fast, strong, mid] = ir.agent.modelPool?.candidates ?? [];
    expect(fast).toEqual({
      model: "claude-haiku-4-5",
      tags: ["cheap"],
      profile: "fast",
      thinking: { effort: "low" },
      maxTokens: 1024,
      modelCallTimeoutMs: 20000,
      overlay: "You are the fast lane.",
      caching: "prefer",
      requires: { tool_use: true, contextWindowGte: 100000 },
      fallbacks: ["claude-sonnet-4-6"],
      circuitBreaker: { failureThreshold: 3 },
    });
    // model then tags FIRST, every 0.6.0 key after.
    expect(Object.keys(fast ?? {}).slice(0, 3)).toEqual(["model", "tags", "profile"]);
    expect(strong).toEqual({
      model: "claude-opus-4-8",
      tags: ["heavy", "strong"],
      profile: "strong",
      thinking: { budgetTokens: 4096 },
    });
    expect(mid).toEqual({ model: "claude-sonnet-4-6", tags: ["mid"], enabled: false });
    // PR 9a — the plan table honours thinking / max_tokens / limits /
    // instructions / caching per candidate; PR 10 consumed the per-candidate
    // failover chain and breaker, so nothing on a candidate pends.
    const pending = warnings.filter((w) => w.code === "model-plan-pending-runtime");
    expect(pending.map((w) => w.path)).toEqual([]);
    // The compiled blob carries it all — every emitter writes the pool verbatim.
    const agentTs =
      compile(
        cli(
          ...REGISTRY,
          "agent:",
          "  model: claude-sonnet-4-6",
          "  instructions: i",
          "  model_pool:",
          "    candidates:",
          "      - { model: $fast }",
          "      - { model: $strong }",
        ),
        opts,
      ).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('"profile":"fast"');
    expect(agentTs).toContain('"overlay":"You are the fast lane."');
    expect(agentTs).not.toContain("$fast");
  });

  test("the hybrid siblings lower (camelCase, role slots → tag or arm id, model slots resolved) and ride the blob", () => {
    const yaml = cli(
      ...REGISTRY,
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  model_pool:",
      "    policy: classifier",
      "    directives: true",
      "    scope: chat",
      "    candidates:",
      "      - { model: $fast }",
      "      - { model: $strong }",
      "    rules:",
      "      - { id: pics, when: { has_images: true }, use: { requires: { vision: true } } }",
      "      - { id: code, when: { message_matches: refactor, turn_index_lt: 3 }, use: $strong, enabled: false }",
      "    classifier: { model: $checker, labels: { cheap: simple, strong: hard }, max_tokens: 16 }",
      "    strategy:",
      "      cascade: { draft: cheap, escalate_to: $strong, clean_prompt: true }",
      "      guide: { model: $strong, every: first_turn, max_tokens: 400, budget_usd: 0.2 }",
      "      shadow: { candidate: claude-sonnet-4-6, sample_rate: 0.1, grade_with: $checker }",
      "      model_directed: true",
      "      max_escalations: 1",
      "    reward:",
      "      quality_source: none",
      "      priors: eval",
      "      floor: { arm: strong, confidence: 0.9, tolerance: 0.02 }",
      "      reset_on_profile_change: true",
    );
    const { ir, warnings } = lowerWithWarnings(parseSpec(yaml), opts);
    if (ir.target !== "cli") throw new Error("unexpected target");
    const pool = ir.agent.modelPool;
    expect(pool?.policy).toBe("classifier");
    expect(pool?.directives).toBe(true);
    expect(pool?.scope).toBe("chat");
    expect(pool?.rules).toEqual([
      { id: "pics", when: { has_images: true }, use: { requires: { vision: true } } },
      {
        id: "code",
        when: { message_matches: "refactor", turn_index_lt: 3 },
        use: "strong",
        enabled: false,
      },
    ]);
    expect(pool?.classifier).toEqual({
      model: "claude-sonnet-4-6",
      modelProfile: "checker",
      labels: { cheap: "simple", strong: "hard" },
      maxTokens: 16,
    });
    expect(pool?.strategy).toEqual({
      cascade: { draft: "cheap", escalateTo: "strong", cleanPrompt: true },
      guide: {
        model: "claude-opus-4-8",
        modelProfile: "strong",
        every: "first_turn",
        maxTokens: 400,
        budgetUsd: 0.2,
      },
      shadow: {
        candidate: "claude-sonnet-4-6",
        sampleRate: 0.1,
        gradeWith: "claude-sonnet-4-6",
        gradeWithProfile: "checker",
      },
      modelDirected: true,
      maxEscalations: 1,
    });
    expect(pool?.reward).toEqual({
      qualitySource: "none",
      priors: "eval",
      floor: { arm: "strong", confidence: 0.9, tolerance: 0.02 },
      resetOnProfileChange: true,
    });
    const pendingPaths = warnings
      .filter((w) => w.code === "model-plan-pending-runtime")
      .map((w) => w.path);
    for (const key of ["policy", "directives", "rules", "classifier"]) {
      expect(pendingPaths).toContain(`agent.model_pool.${key}`);
    }
    // PR 10 consumes `reward` (quality fold, priors, floor, lineage reset).
    expect(pendingPaths).not.toContain("agent.model_pool.reward");
    // PR 9c consumes `strategy.cascade` + `max_escalations`; the side-call
    // closures (guide / shadow / committee) pend field-precisely on PR 9d.
    expect(pendingPaths).not.toContain("agent.model_pool.strategy");
    expect(pendingPaths).not.toContain("agent.model_pool.strategy.cascade");
    expect(pendingPaths).toContain("agent.model_pool.strategy.guide");
    expect(pendingPaths).toContain("agent.model_pool.strategy.shadow");
    // PR 9a consumes `scope` (stamped on `model_route.scope`): never pending.
    expect(pendingPaths).not.toContain("agent.model_pool.scope");
    // PR 8b landed the interpreter half of model_directed; the warning is
    // scoped to compiled targets until the emitters gain a boot-time
    // wireModels call (a later row — bundles cannot import model-service,
    // which depends on runtime-core) — it must not claim "the runtime"
    // ignores the key.
    const directedWarning = warnings.find(
      (w) => w.path === "agent.model_pool.strategy.model_directed",
    )?.message;
    expect(directedWarning).toContain("crewhaus run / serve interpreter");
    expect(directedWarning).toContain("compiled bundle does not register the tools yet");
    expect(directedWarning).toContain("wireModels");
    expect(directedWarning).not.toContain("the runtime does not honour it");
    const agentTs = compile(yaml, opts).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('"policy":"classifier"');
    expect(agentTs).toContain(
      '"cascade":{"draft":"cheap","escalateTo":"strong","cleanPrompt":true}',
    );
    expect(agentTs).not.toContain('"$');
  });
});

describe("graph nodes and sub-agents gain routing (§7.7)", () => {
  test("a node's model_pool lowers and is rendered onto that node's runChatLoop call", () => {
    const yaml = [
      "name: g",
      "target: graph",
      "model: claude-sonnet-4-6",
      "entry: a",
      "nodes:",
      "  a:",
      "    instructions: x",
      "    model_pool:",
      "      candidates:",
      "        - { model: claude-haiku-4-5, tags: [cheap] }",
      "        - { model: claude-opus-4-8, tags: [strong] }",
      "  b: { instructions: y, model_fallbacks: [claude-haiku-4-5], circuit_breaker: { failureThreshold: 2 } }",
      "edges: [{ from: a, to: b }]",
    ].join("\n");
    const ir = lower(parseSpec(yaml), opts);
    if (ir.target !== "graph") throw new Error("unexpected target");
    expect(ir.nodes[0]?.modelPool?.candidates.length).toBe(2);
    expect(ir.nodes[1]).toMatchObject({
      modelFallbacks: ["claude-haiku-4-5"],
      circuitBreaker: { failureThreshold: 2 },
    });
    const agentTs = compile(yaml, opts).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect((agentTs.match(/modelPool: \{/g) ?? []).length).toBe(1);
    expect(agentTs).toContain('modelFallbacks: ["claude-haiku-4-5"],');
    expect(agentTs).toContain('circuitBreaker: {"failureThreshold":2},');
  });

  test("a sub-agent's routing, params, budget_share, inherit_routing and RESOLVED allowed_profiles lower; nothing pends (PR 11 landed)", () => {
    const { ir, warnings } = lowerWithWarnings(
      parseSpec(
        cli(
          ...REGISTRY,
          "agent:",
          "  model: claude-sonnet-4-6",
          "  instructions: i",
          "  sub_agents:",
          "    helper:",
          "      description: helps",
          "      instructions: help",
          "      tools: [read]",
          "      model_tiers: { fast: $fast, default: $strong }",
          "      temperature: 0.2",
          "      budget_share: 0.25",
          "      inherit_routing: true",
          "      allowed_profiles: [$fast, $strong]",
          "tools: [read]",
        ),
      ),
      opts,
    );
    if (ir.target !== "cli") throw new Error("unexpected target");
    expect(ir.subAgents[0]).toMatchObject({
      modelTiers: { fast: "claude-haiku-4-5", default: "claude-opus-4-8" },
      temperature: 0.2,
      budgetShare: 0.25,
      inheritRouting: true,
    });
    // §7.7 — each allowed profile is the serving slot `model: $<profile>` would
    // lower to on this child: model, params, overlay (carried, not folded),
    // and the profile's failover chain. Nothing downstream ever sees a `$`.
    expect(ir.subAgents[0]?.allowedProfiles).toEqual([
      {
        profile: "fast",
        model: "claude-haiku-4-5",
        thinking: { effort: "low" },
        maxTokens: 4096,
        overlay: "You are the fast lane.",
        modelFallbacks: ["claude-sonnet-4-6"],
        circuitBreaker: { failureThreshold: 3 },
      },
      { profile: "strong", model: "claude-opus-4-8", thinking: { budgetTokens: 4096 } },
    ]);
    // The spawner consumes every one of these keys now: no pending warning.
    const pending = warnings.filter(
      (w) => w.code === "model-plan-pending-runtime" && w.path.startsWith("agent.sub_agents."),
    );
    expect(pending).toEqual([]);
    // …and the emitted bundle carries them into the `__subAgents` literal.
    const agentTs =
      compile(
        cli(
          ...REGISTRY,
          "agent:",
          "  model: claude-sonnet-4-6",
          "  instructions: i",
          "  sub_agents:",
          "    helper:",
          "      description: helps",
          "      instructions: help",
          "      tools: [read]",
          "      model_tiers: { fast: $fast, default: $strong }",
          "      budget_share: 0.25",
          "      inherit_routing: true",
          "      allowed_profiles: [$strong]",
          "tools: [read]",
        ),
        opts,
      ).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain(
      'modelTiers: {"fast":"claude-haiku-4-5","default":"claude-opus-4-8"}, budgetShare: 0.25, inheritRouting: true, allowedProfiles: [{"profile":"strong","model":"claude-opus-4-8","thinking":{"budgetTokens":4096}}] }',
    );
  });

  test("a sub-agent on `model: $<profile>` keeps its instructions RAW and carries the profile overlay separately, into the IR and the bundle", () => {
    const yaml = cli(
      ...REGISTRY,
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  sub_agents:",
      "    helper:",
      "      description: helps",
      "      instructions: help",
      "      tools: [read]",
      "      model: $fast",
      "      allowed_profiles: [$strong]",
      "tools: [read]",
    );
    const ir = cliIr(yaml);
    expect(ir.subAgents[0]?.instructions).toBe("help");
    expect(ir.subAgents[0]?.overlay).toBe("You are the fast lane.");
    // A profile with no `instructions` yields no `overlay` key at all.
    const strongOnly = cliIr(yaml.replace("model: $fast", "model: $strong"));
    expect(strongOnly.subAgents[0]?.instructions).toBe("help");
    expect("overlay" in (strongOnly.subAgents[0] ?? {})).toBe(false);
    // The emitted literal carries it right after the provenance key.
    const agentTs = compile(yaml, opts).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain(
      'instructions: "help", tools: ["read"], model: "claude-haiku-4-5", permissions: "inherit", inherit_bypass: false, modelProfile: "fast", overlay: "You are the fast lane.", thinking: {"effort":"low"}, maxTokens: 4096,',
    );
  });

  test("a sub-agent carrying only today's fields emits a byte-identical __subAgents literal (no 0.6.0 key leaks)", () => {
    const yaml = cli(
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  sub_agents:",
      "    helper:",
      "      description: helps",
      "      instructions: help",
      "      tools: [read]",
      "tools: [read]",
    );
    const agentTs = compile(yaml, opts).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain(
      '["helper", { name: "helper", description: "helps", instructions: "help", tools: ["read"], permissions: "inherit", inherit_bypass: false }],',
    );
  });
});

describe("in-loop evaluation (§6.2 / §7.3)", () => {
  test("judge panel fields + allow_self_judge lower; the judge-independence lint fires only on opted-in specs", () => {
    const base = [
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5, tags: [cheap] }",
      "      - { model: claude-sonnet-4-6, tags: [strong] }",
    ];
    // 0.5.x-shaped: the serving primary judges itself, and nothing warns.
    const legacy = compile(
      cli(...base, "evaluation:", "  grader: { type: llm_judge, criteria: helpful }"),
      opts,
    );
    expect(legacy.warnings).toEqual([]);
    // Opted in (a `models:` registry): an EXPLICIT self-judge is a warning …
    const optedIn = compile(
      cli(
        "models:",
        "  x: { model: claude-haiku-4-5 }",
        ...base,
        "evaluation:",
        "  grader: { type: llm_judge, criteria: helpful, model: claude-haiku-4-5, repeats: 3, target: output }",
      ),
      opts,
    );
    const selfJudge = optedIn.warnings.filter((w) => w.code === "model-plan-self-judge");
    expect(selfJudge).toHaveLength(1);
    expect(selfJudge[0]?.path).toBe("evaluation.grader.model");
    // … silenced by allow_self_judge, which is carried only when true.
    const waived = lowerWithWarnings(
      parseSpec(
        cli(
          "models:",
          "  x: { model: claude-haiku-4-5 }",
          ...base,
          "evaluation:",
          "  grader: { type: llm_judge, criteria: helpful, model: claude-haiku-4-5 }",
          "  allow_self_judge: true",
        ),
      ),
      opts,
    );
    if (waived.ir.target !== "cli") throw new Error("unexpected target");
    expect(waived.ir.evaluation?.allowSelfJudge).toBe(true);
    expect(codes(waived.warnings)).not.toContain("model-plan-self-judge");
    // Panel knobs are on the IR, pending the createJudgeGrader wiring.
    const lowered = lower(
      parseSpec(
        cli(
          ...base,
          "evaluation:",
          "  grader: { type: llm_judge, criteria: helpful, judges: [claude-opus-4-8], repeats: 3 }",
        ),
      ),
      opts,
    );
    if (lowered.target !== "cli") throw new Error("unexpected target");
    expect(lowered.evaluation?.grader).toEqual({
      type: "llm_judge",
      criteria: "helpful",
      judges: ["claude-opus-4-8"],
      repeats: 3,
    });
    expect("allowSelfJudge" in (lowered.evaluation ?? {})).toBe(false);
  });

  test("the judge default flips to `strongest` ONLY on an opted-in spec (§6.2 / §14); the 0.5.x default is unchanged", () => {
    const pooled = [
      "agent:",
      "  model: claude-sonnet-4-6",
      "  instructions: i",
      "  model_pool:",
      "    candidates:",
      "      - { model: claude-haiku-4-5, tags: [cheap] }",
      "      - { model: claude-opus-4-8, tags: [strong] }",
    ];
    const grader = ["evaluation:", "  grader: { type: llm_judge, criteria: helpful }"];
    // 0.5.x-shaped: no judge model on the IR — the emitters keep defaulting
    // to `agent.model`, so the bundle is byte-identical.
    const legacy = lowerWithWarnings(parseSpec(cli(...pooled, ...grader)), opts);
    if (legacy.ir.target !== "cli") throw new Error("unexpected target");
    expect(legacy.ir.evaluation?.grader).toEqual({ type: "llm_judge", criteria: "helpful" });
    expect(legacy.warnings).toEqual([]);
    // Opted in via a `models:` registry: the default is the strongest ROSTER
    // member — the strong-tagged profile, carrying its provenance.
    const viaRegistry = lowerWithWarnings(
      parseSpec(
        cli(
          "models:",
          "  strong: { model: claude-opus-4-8, tags: [strong] }",
          "agent:",
          "  model: claude-haiku-4-5",
          "  instructions: i",
          ...grader,
        ),
      ),
      opts,
    );
    if (viaRegistry.ir.target !== "cli") throw new Error("unexpected target");
    expect(viaRegistry.ir.evaluation?.grader).toEqual({
      type: "llm_judge",
      criteria: "helpful",
      model: "claude-opus-4-8",
      modelProfile: "strong",
    });
    // Opted in via a pool `strategy`: the strong-tagged candidate. The
    // compiler-chosen default is never reported as a self-judge, even though
    // it is also a serving arm of the pool.
    const viaStrategy = lowerWithWarnings(
      parseSpec(
        cli(
          ...pooled,
          "    strategy:",
          "      cascade: { draft: cheap, escalate_to: strong }",
          ...grader,
        ),
      ),
      opts,
    );
    if (viaStrategy.ir.target !== "cli") throw new Error("unexpected target");
    expect(viaStrategy.ir.evaluation?.grader).toMatchObject({ model: "claude-opus-4-8" });
    expect(codes(viaStrategy.warnings)).not.toContain("model-plan-self-judge");
    // The flip reaches the emitted bundle through the IR (interpreter parity).
    const agentTs =
      compile(
        cli(
          "models:",
          "  strong: { model: claude-opus-4-8, tags: [strong] }",
          "agent:",
          "  model: claude-haiku-4-5",
          "  instructions: i",
          ...grader,
        ),
        opts,
      ).files.find((f) => f.path === "agent.ts")?.content ?? "";
    expect(agentTs).toContain('"claude-opus-4-8"');
  });

  test("a workflow / graph judge step without `model` defaults to `strongest` on an opted-in spec, and to the top-level model otherwise", () => {
    const steps = [
      "steps:",
      "  - { name: draft, instructions: write it }",
      "  - { name: gate, kind: judge, judge: { criteria: c } }",
    ];
    const legacy = lower(
      parseSpec(["name: w", "target: workflow", "model: m", ...steps].join("\n")),
      opts,
    );
    if (legacy.target !== "workflow") throw new Error("unexpected target");
    expect(legacy.steps[1]?.model).toBe("m");
    expect(legacy.steps[1]?.judge?.modelProfile).toBeUndefined();

    const optedIn = lowerWithWarnings(
      parseSpec(
        [
          "name: w",
          "target: workflow",
          "models:",
          "  strong: { model: claude-opus-4-8, tags: [strong] }",
          "model: claude-haiku-4-5",
          ...steps,
        ].join("\n"),
      ),
      opts,
    );
    if (optedIn.ir.target !== "workflow") throw new Error("unexpected target");
    expect(optedIn.ir.steps[1]?.model).toBe("claude-opus-4-8");
    expect(optedIn.ir.steps[1]?.judge?.modelProfile).toBe("strong");
    expect(codes(optedIn.warnings)).not.toContain("model-plan-self-judge");

    const graph = lower(
      parseSpec(
        [
          "name: g",
          "target: graph",
          "models:",
          "  strong: { model: claude-opus-4-8, tags: [strong] }",
          "model: claude-haiku-4-5",
          "entry: a",
          "nodes:",
          "  a: { instructions: x }",
          "  gate: { kind: judge, judge: { criteria: c } }",
          "edges:",
          "  - { from: a, to: gate }",
        ].join("\n"),
      ),
      opts,
    );
    if (graph.target !== "graph") throw new Error("unexpected target");
    expect(graph.nodes.find((n) => n.name === "gate")).toMatchObject({
      model: "claude-opus-4-8",
      judge: { modelProfile: "strong" },
    });
  });
});

describe("absent config is byte-identical (design stance 3)", () => {
  const SHAPES: ReadonlyArray<string> = [
    cli("agent:", "  model: claude-sonnet-4-6", "  instructions: i", "tools: [read]"),
    [
      "name: w",
      "target: workflow",
      "model: m",
      "steps:",
      "  - { name: a, instructions: x }",
      "  - { name: gate, kind: judge, judge: { criteria: c } }",
    ].join("\n"),
    ["name: g", "target: graph", "model: m", "entry: a", "nodes:", "  a: { instructions: x }"].join(
      "\n",
    ),
    [
      "name: c",
      "target: crew",
      "model: m",
      "entry: lead",
      "roles:",
      "  lead: { instructions: go, sub_agents: { h: { description: d, instructions: i } } }",
      "routing: { kind: llm }",
    ].join("\n"),
    [
      "name: v",
      "target: voice",
      "agent: { model: m, instructions: i }",
      "voice: { provider: openai }",
    ].join("\n"),
  ];

  test("no 0.6.0 key ever appears in the IR of a 0.5.x-shaped spec, and compile() stays warning-free", () => {
    for (const yaml of SHAPES) {
      const json = JSON.stringify(lower(parseSpec(yaml), opts));
      for (const key of [
        "models",
        "modelProfile",
        "temperature",
        "profile",
        "params",
        "judges",
        "allowSelfJudge",
      ]) {
        expect(json).not.toContain(`"${key}":`);
      }
      const result = compile(yaml, opts);
      expect(result.warnings.filter((w) => w.code.startsWith("model-"))).toEqual([]);
    }
  });

  test("the spec surface parses every fixture above (a parse issue would mask a lowering hole)", () => {
    for (const yaml of SHAPES) expect(parseSpecIssues(yaml)).toEqual([]);
  });
});
