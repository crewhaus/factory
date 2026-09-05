import { describe, expect, test } from "bun:test";
import type { HookDef } from "@crewhaus/hooks-engine";
import type { IrModelPool } from "@crewhaus/ir";
import { modelWiringFragmentFromIr, wireModels } from "@crewhaus/model-service";
import type { RunEvaluation } from "@crewhaus/runtime-core";
import { TraceEventBus } from "@crewhaus/trace-event-bus";
import {
  evaluationRunOptions,
  formatCompileWarning,
  isValidAskMode,
  loopContractRunOptions,
  mergeSpecHooks,
  modelRoutingRunOptions,
  resolveAskMode,
  resolveStreaming,
} from "./loop-contract";

describe("evaluationRunOptions (0.6.0 PR 8b — interpreter parity for the in-loop evaluation block)", () => {
  const bus = new TraceEventBus({ runId: "run_test", sessionId: "sess_0123456789abcdef" });
  const turn = (finalText: string) => ({
    finalText,
    messages: [],
    usage: { input: 0, output: 0 },
    bus,
  });

  test("a spec without evaluation: spreads NOTHING", () => {
    expect(evaluationRunOptions({ agent: { model: "m" } })).toEqual({});
    expect(Object.keys(evaluationRunOptions({ agent: { model: "m" } }))).toEqual([]);
  });

  test("contains: pure grader, threshold 1, resolved onFail / maxRetries threaded verbatim", async () => {
    const out = evaluationRunOptions({
      agent: { model: "m" },
      evaluation: { grader: { type: "contains", value: "DONE" }, onFail: "halt", maxRetries: 2 },
    });
    const ev = out.evaluation as RunEvaluation;
    expect(ev.graderType).toBe("contains");
    expect(ev.threshold).toBe(1);
    expect(ev.onFail).toBe("halt");
    expect(ev.maxRetries).toBe(2);
    expect(await ev.evaluate(turn("all DONE here"))).toEqual({
      score: 1,
      rationale: 'output contains "DONE"',
    });
    expect(await ev.evaluate(turn("nope"))).toEqual({
      score: 0,
      rationale: 'output missing "DONE"',
    });
  });

  test("regex: lastIndex is reset per call so a global flag cannot flip verdicts", async () => {
    const out = evaluationRunOptions({
      agent: { model: "m" },
      evaluation: { grader: { type: "regex", value: "ok" }, onFail: "note", maxRetries: 1 },
    });
    const ev = out.evaluation as RunEvaluation;
    expect(ev.graderType).toBe("regex");
    expect((await ev.evaluate(turn("ok"))).score).toBe(1);
    expect((await ev.evaluate(turn("ok"))).score).toBe(1);
    expect((await ev.evaluate(turn("ko"))).rationale).toBe("output does not match /ok/");
  });

  test("llm_judge: graderType, resolved threshold and onFail (escalate included) mirror the bundle", () => {
    const out = evaluationRunOptions({
      agent: { model: "claude-haiku-4-5" },
      evaluation: {
        grader: { type: "llm_judge", criteria: "is it correct?" },
        threshold: 0.8,
        onFail: "escalate",
        maxRetries: 1,
      },
    });
    const ev = out.evaluation as RunEvaluation;
    expect(ev.graderType).toBe("llm_judge");
    expect(ev.threshold).toBe(0.8);
    expect(ev.onFail).toBe("escalate");
    expect(typeof ev.evaluate).toBe("function");
    // The lower-time default the bundle also falls back to.
    const defaulted = evaluationRunOptions({
      agent: { model: "m" },
      evaluation: {
        grader: { type: "llm_judge", criteria: "c" },
        onFail: "retry",
        maxRetries: 1,
      },
    });
    expect((defaulted.evaluation as RunEvaluation).threshold).toBe(0.7);
  });

  test("0.6.0 PR 9c — the cascade's lower-time escalateTo is threaded verbatim under on_fail: escalate, and absent otherwise", () => {
    for (const type of ["llm_judge", "contains", "regex"] as const) {
      const grader =
        type === "llm_judge"
          ? ({ type, criteria: "c" } as const)
          : ({ type, value: "ok" } as const);
      const escalated = evaluationRunOptions({
        agent: { model: "m" },
        evaluation: { grader, onFail: "escalate", maxRetries: 1, escalateTo: "strong" },
      }).evaluation as RunEvaluation;
      expect(escalated.onFail).toBe("escalate");
      expect(escalated.escalateTo).toBe("strong");
      const plain = evaluationRunOptions({
        agent: { model: "m" },
        evaluation: { grader, onFail: "retry", maxRetries: 1 },
      }).evaluation as RunEvaluation;
      expect("escalateTo" in plain).toBe(false);
    }
  });
});

describe("modelRoutingRunOptions (0.6.0 PR 8a — the interpreter's wireModels call)", () => {
  const POOL: IrModelPool = {
    candidates: [
      { model: "claude-haiku-4-5", tags: ["cheap"], temperature: 0.2 },
      { model: "claude-sonnet-4-6", tags: ["mid"], enabled: false },
      { model: "claude-opus-4-8", tags: ["strong"] },
    ],
    policy: "heuristic",
    rules: [{ id: "r1", when: { has_images: true }, use: "strong" }],
  };
  const TIERS = { fast: "claude-haiku-4-5", default: "claude-sonnet-4-6" } as const;
  const BREAKER = { failureThreshold: 2 } as const;

  test("an agent block without routing spreads NOTHING", () => {
    expect(modelRoutingRunOptions({ model: "m", instructions: "i" } as never, undefined)).toEqual(
      {},
    );
    expect(modelRoutingRunOptions({ modelFallbacks: [] }, undefined)).toEqual({});
  });

  test("it IS the composition root's call — same object as wireModels over the same fragment", () => {
    const agent = {
      modelFallbacks: ["openai/gpt-4o-mini"],
      circuitBreaker: BREAKER,
      modelTiers: TIERS,
      modelPool: POOL,
    };
    expect(modelRoutingRunOptions(agent, undefined)).toEqual(
      wireModels(modelWiringFragmentFromIr(agent), {}),
    );
    expect(Object.keys(modelRoutingRunOptions(agent, undefined))).toEqual([
      "modelFallbacks",
      "circuitBreaker",
      "modelTiers",
      "modelPool",
    ]);
  });

  test("the pool reaches the option object by reference, every 0.6.0 key intact (plan §17)", () => {
    const out = modelRoutingRunOptions({ modelPool: POOL }, undefined);
    expect(out.modelPool).toBe(POOL);
    const pool = out.modelPool as unknown as Record<string, unknown>;
    const candidates = pool["candidates"] as ReadonlyArray<Record<string, unknown>>;
    expect(candidates[0]?.["temperature"]).toBe(0.2);
    expect(candidates[1]?.["enabled"]).toBe(false);
    expect(pool["rules"]).toEqual([{ id: "r1", when: { has_images: true }, use: "strong" }]);
  });

  test("model_directed: true yields the Consult / Escalate tools and the latch through the same call", () => {
    const directed: IrModelPool = { ...POOL, strategy: { modelDirected: true, maxEscalations: 1 } };
    const out = modelRoutingRunOptions({ modelPool: directed }, undefined, { sessionName: "spec" });
    expect(Object.keys(out)).toEqual(["modelPool", "hybridTools", "escalation"]);
    expect(out.hybridTools?.map((t) => t.name)).toEqual(["Consult", "Escalate"]);
    expect(out.escalation?.pending()).toBeUndefined();
    // A --model override drops the pool and, with it, the hybrid pair.
    expect(modelRoutingRunOptions({ modelPool: directed }, "claude-opus-4-8")).toEqual({});
  });

  test("every call mints a FRESH latch — the per-run seam `crewhaus serve` spreads per message", async () => {
    // The latch's contract is "at most `max_escalations` per RUN". One serve
    // process hosts one run per inbound MCP message, so buildServeRuntime
    // calls this helper inside `invoke` rather than once per process; this
    // pins that two sequential calls do not share a latch (or a tool): the
    // first run exhausting its single escalation leaves the second run's
    // `Escalate` accepted, and nothing the first left pending leaks across.
    const directed: IrModelPool = { ...POOL, strategy: { modelDirected: true, maxEscalations: 1 } };
    const first = modelRoutingRunOptions({ modelPool: directed }, undefined, { sessionName: "s" });
    const second = modelRoutingRunOptions({ modelPool: directed }, undefined, { sessionName: "s" });
    expect(first.escalation).toBeDefined();
    expect(second.escalation).toBeDefined();
    expect(first.escalation).not.toBe(second.escalation);
    expect(first.hybridTools?.[1]).not.toBe(second.hybridTools?.[1]);

    const escalateOf = (o: typeof first) => o.hybridTools?.find((t) => t.name === "Escalate");
    const receipt = (raw: unknown) => JSON.parse(String(raw)) as { escalated: boolean };
    // Run 1 uses its one escalation (and leaves it pending — the turn aborts
    // before the next model call).
    expect(receipt(await escalateOf(first)?.execute({ reason: "hard" })).escalated).toBe(true);
    expect(receipt(await escalateOf(first)?.execute({ reason: "again" })).escalated).toBe(false);
    expect(first.escalation?.pending()).toBeDefined();
    // Run 2 starts clean: nothing pending, its own allowance intact.
    expect(second.escalation?.pending()).toBeUndefined();
    expect(second.escalation?.count).toBe(0);
    expect(receipt(await escalateOf(second)?.execute({ reason: "hard" })).escalated).toBe(true);
  });

  test("a --model string drops the chain, tiers and pool but keeps the breaker", () => {
    const agent = {
      modelFallbacks: ["openai/gpt-4o-mini"],
      circuitBreaker: BREAKER,
      modelTiers: TIERS,
      modelPool: POOL,
    };
    expect(modelRoutingRunOptions(agent, "claude-opus-4-8")).toEqual({ circuitBreaker: BREAKER });
  });

  test("a bare --model flag (parses as true) or an absent flag is NOT an override", () => {
    expect(modelRoutingRunOptions({ modelPool: POOL }, true)).toEqual({ modelPool: POOL });
    expect(modelRoutingRunOptions({ modelTiers: TIERS }, undefined)).toEqual({ modelTiers: TIERS });
  });
});

describe("resolveAskMode (loop contract 0.4, Batch C — G11)", () => {
  test('defaults to "pause" — the documented safe direction', () => {
    expect(resolveAskMode(undefined, undefined)).toBe("pause");
  });

  test("the spec's permissions.ask_mode is honoured when no flag is given", () => {
    expect(resolveAskMode(undefined, "deny")).toBe("deny");
    expect(resolveAskMode(undefined, "pause")).toBe("pause");
  });

  test("a valid flag beats the spec, mirroring --permission-mode precedence", () => {
    expect(resolveAskMode("deny", "pause")).toBe("deny");
    expect(resolveAskMode("pause", "deny")).toBe("pause");
  });

  test("a non-string flag (a bare --ask-mode parses as true) falls through to the spec", () => {
    expect(resolveAskMode(true, "deny")).toBe("deny");
  });

  test("validation is the caller's job — an invalid flag never silently wins", () => {
    // The CLI die()s on this before calling. If that guard were ever dropped,
    // falling through to the spec/default is the safe direction.
    expect(isValidAskMode("sometimes")).toBe(false);
    expect(resolveAskMode("sometimes", "pause")).toBe("pause");
    expect(resolveAskMode("sometimes", undefined)).toBe("pause");
  });
});

describe("loopContractRunOptions (loop contract 0.4, Batch A)", () => {
  test("an empty IR slice spreads NOTHING (runtime defaults stay authoritative)", () => {
    expect(loopContractRunOptions({})).toEqual({});
    expect(loopContractRunOptions({ limits: {}, compaction: {}, agent: {} })).toEqual({});
  });

  test("every limits field maps 1:1 onto the option contract", () => {
    const out = loopContractRunOptions({
      limits: {
        maxToolIterations: 25,
        maxConcurrentTools: 2,
        contextLimit: 120_000,
        deadlineMs: 600_000,
        turnTimeoutMs: 120_000,
        modelCallTimeoutMs: 60_000,
        loopDetection: { window: 12, threshold: 3, escalation: "abort" },
      },
    });
    expect(out).toEqual({
      maxToolIterations: 25,
      maxConcurrentTools: 2,
      contextLimit: 120_000,
      deadlineMs: 600_000,
      turnTimeoutMs: 120_000,
      modelCallTimeoutMs: 60_000,
      loopDetection: { window: 12, threshold: 3, escalation: "abort" },
    });
  });

  test("a partial limits block carries only the declared fields", () => {
    const out = loopContractRunOptions({ limits: { maxToolIterations: 40 } });
    expect(out).toEqual({ maxToolIterations: 40 });
    expect("maxConcurrentTools" in out).toBe(false);
    expect("loopDetection" in out).toBe(false);
  });

  test("0.6.0 PR 9a — agent.temperature is carried; absent when the IR leaves it unset", () => {
    expect(loopContractRunOptions({ agent: { temperature: 0.2 } })).toEqual({ temperature: 0.2 });
    expect("temperature" in loopContractRunOptions({ agent: {} })).toBe(false);
  });

  test("thinking is carried verbatim in both forms", () => {
    expect(loopContractRunOptions({ agent: { thinking: { budgetTokens: 2048 } } })).toEqual({
      thinking: { budgetTokens: 2048 },
    });
    expect(loopContractRunOptions({ agent: { thinking: { effort: "low" } } })).toEqual({
      thinking: { effort: "low" },
    });
  });

  test("rateLimits carries the per-tool record (incl. the * bucket); empty records are dropped", () => {
    expect(
      loopContractRunOptions({
        agent: { rateLimits: { bash: { rpm: 30, burst: 5 }, "*": { rpm: 120 } } },
      }),
    ).toEqual({ rateLimits: { bash: { rpm: 30, burst: 5 }, "*": { rpm: 120 } } });
    expect(loopContractRunOptions({ agent: { rateLimits: {} } })).toEqual({});
  });

  test("compaction tuning knobs land on the runtime option names", () => {
    expect(
      loopContractRunOptions({
        compaction: { threshold: 0.8, snipKeepHead: 6, snipKeepTail: 30 },
      }),
    ).toEqual({ compactionThreshold: 0.8, snipKeepHead: 6, snipKeepTail: 30 });
  });
});

describe("mergeSpecHooks (spec hooks BELOW settings.json priority)", () => {
  const settings: HookDef[] = [
    { event: "pre-tool", matcher: "Bash", command: "settings.sh" },
    { event: "stop", command: "user-stop.sh" },
  ];

  test("spec hooks come FIRST (lowest layer) and settings.json entries follow", () => {
    const merged = mergeSpecHooks(
      [{ event: "pre-tool", matcher: "Bash", command: "spec.sh", timeoutMs: 3000 }],
      settings,
    );
    expect(merged.map((h) => h.command)).toEqual(["spec.sh", "settings.sh", "user-stop.sh"]);
    // aggregateDecisions shallow-merges mutate later-wins, so the settings
    // layer (later) overrides the spec layer — "below settings.json priority".
  });

  test("no spec hooks returns the settings array unchanged (same reference)", () => {
    expect(mergeSpecHooks(undefined, settings)).toBe(settings);
    expect(mergeSpecHooks([], settings)).toBe(settings);
  });

  test("spec declaration order is preserved inside the spec layer", () => {
    const merged = mergeSpecHooks(
      [
        { event: "session-start", command: "a.sh" },
        { event: "session-start", command: "b.sh" },
      ],
      [],
    );
    expect(merged.map((h) => h.command)).toEqual(["a.sh", "b.sh"]);
  });
});

describe("resolveStreaming (--streaming flag > spec agent.streaming)", () => {
  test("the flag forces streaming on regardless of the spec", () => {
    expect(resolveStreaming(true, undefined)).toBe(true);
    expect(resolveStreaming(true, false)).toBe(true);
  });

  test("without the flag the spec's declared value is carried verbatim", () => {
    expect(resolveStreaming(false, true)).toBe(true);
    expect(resolveStreaming(false, false)).toBe(false);
  });

  test("neither flag nor spec → undefined (caller spreads nothing)", () => {
    expect(resolveStreaming(false, undefined)).toBeUndefined();
  });
});

describe("formatCompileWarning", () => {
  test("renders code + path + message on one line", () => {
    expect(
      formatCompileWarning({
        code: "accepted-but-unwired",
        path: "thredz",
        message: "thredz is accepted on the channel shape but its emitter does not wire it yet",
      }),
    ).toBe(
      "warning[accepted-but-unwired] thredz: thredz is accepted on the channel shape but its emitter does not wire it yet",
    );
  });
});
