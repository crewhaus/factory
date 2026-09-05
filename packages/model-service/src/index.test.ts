/**
 * 0.6.0 PR 8a — the composition root wraps today's routing fragments
 * byte-identically (plan §13 row 8a, §17):
 *
 *   (a) `wireModels` is spread-return-`{}`: an empty fragment wires nothing;
 *   (b) every routing key is carried by reference, in the emitters' key
 *       order, and `--model` drops exactly the chain / tiers / pool;
 *   (c) `renderModelWiringFields` reproduces the retired per-emitter strings
 *       for every indent the ten emitters use;
 *   (d) parsing the rendered fields back yields the same object `wireModels`
 *       returns — the bundle and the interpreter are one code path;
 *   (e) one NEW key per level (profile → candidate → pool) is observable on
 *       the option object handed to `runChatLoop`, so a later PR cannot
 *       silently drop a key between the IR and the loop;
 *   (f) the option object is assignable to runtime-core's `RunChatLoopOptions`
 *       (the `@crewhaus/memory-service` test pin — runtime-core is a
 *       devDependency here, never imported from `src/`).
 */
import { describe, expect, test } from "bun:test";
import type { IrModelPool, IrSubAgentDefinition } from "@crewhaus/ir";
import type { RunChatLoopOptions } from "@crewhaus/runtime-core";
import {
  MODEL_WIRING_KEYS,
  type ModelWiringFragment,
  type ModelWiringRunOptions,
  modelWiringFragmentFromIr,
  renderModelWiringFields,
  renderSubAgentDef,
  wireModels,
} from "./index";

const POOL: IrModelPool = {
  candidates: [
    { model: "claude-haiku-4-5", tags: ["cheap"] },
    { model: "claude-opus-4-8", tags: ["strong"] },
  ],
  policy: "heuristic",
};

const TIERS = { fast: "claude-haiku-4-5", default: "claude-sonnet-4-6" } as const;
const BREAKER = { failureThreshold: 2, cooldownMs: 60_000 } as const;
const FALLBACKS = ["openai/gpt-4o-mini", 'quoted"model'] as const;

/**
 * The plan's §17 fixture: one new IR key at each level. `temperature` is a
 * PROFILE field (`IrModelProfile`) riding the candidate, `enabled: false` is
 * the CANDIDATE-level key, `rules` and `scope` are POOL-level keys.
 */
const NEW_KEYS_POOL: IrModelPool = {
  candidates: [
    { model: "claude-haiku-4-5", tags: ["cheap"], profile: "fast", temperature: 0.2 },
    { model: "claude-sonnet-4-6", tags: ["mid"], enabled: false },
    { model: "claude-opus-4-8", tags: ["strong"] },
  ],
  policy: "heuristic",
  rules: [{ id: "images-need-vision", when: { has_images: true }, use: "strong" }],
  scope: "main",
};

/**
 * Read rendered object-literal fields back into the object they build. The
 * fields are JSON values by construction (validated spec values through
 * `JSON.stringify` / `escapeJsonString`), so quoting the field names and
 * dropping the trailing commas turns the fragment into a JSON document — a
 * stricter oracle than evaluating it, since it also proves the literal is
 * plain data.
 */
function parseFields(rendered: string, indent: string): unknown {
  const body = rendered
    .split(`\n${indent}`)
    .filter((field) => field.length > 0)
    .map((field) => field.replace(/^([A-Za-z]+): /, '"$1": ').replace(/,$/, ""))
    .join(",");
  return JSON.parse(`{${body}}`);
}

describe("modelWiringFragmentFromIr — the slice the retired renderers read", () => {
  test("an unrelated block yields an empty fragment (nothing to wire)", () => {
    expect(modelWiringFragmentFromIr({})).toEqual({});
    expect(
      modelWiringFragmentFromIr({
        model: "m",
        instructions: "i",
        tools: [],
      } as ModelWiringFragment),
    ).toEqual({});
  });

  test("an EMPTY modelFallbacks is treated as absent (the emitters' length > 0 guard)", () => {
    expect(modelWiringFragmentFromIr({ modelFallbacks: [] })).toEqual({});
    expect("modelFallbacks" in modelWiringFragmentFromIr({ modelFallbacks: [] })).toBe(false);
  });

  test("every declared key is carried by reference", () => {
    const frag = modelWiringFragmentFromIr({
      modelFallbacks: FALLBACKS,
      circuitBreaker: BREAKER,
      modelTiers: TIERS,
      modelPool: POOL,
    });
    expect(frag.modelFallbacks).toBe(FALLBACKS);
    expect(frag.circuitBreaker).toBe(BREAKER);
    expect(frag.modelTiers).toBe(TIERS);
    expect(frag.modelPool).toBe(POOL);
  });
});

describe("wireModels — spread-return-{} and the --model override", () => {
  test("an empty fragment wires NOTHING (no keys at all, not undefined values)", () => {
    const wired = wireModels({}, {});
    expect(wired).toEqual({});
    expect(Object.keys(wired)).toEqual([]);
  });

  test("keys come out in the emitters' order, values by reference", () => {
    const wired = wireModels(
      { modelFallbacks: FALLBACKS, circuitBreaker: BREAKER, modelTiers: TIERS, modelPool: POOL },
      {},
    );
    expect(Object.keys(wired)).toEqual([...MODEL_WIRING_KEYS]);
    expect(wired.modelFallbacks).toBe(FALLBACKS);
    expect(wired.circuitBreaker).toBe(BREAKER);
    expect(wired.modelTiers).toBe(TIERS);
    expect(wired.modelPool).toBe(POOL);
  });

  test("a single declared key yields exactly that key", () => {
    expect(wireModels({ modelPool: POOL }, {})).toEqual({ modelPool: POOL });
    expect(wireModels({ modelTiers: TIERS }, {})).toEqual({ modelTiers: TIERS });
    expect(wireModels({ circuitBreaker: BREAKER }, {})).toEqual({ circuitBreaker: BREAKER });
    expect(wireModels({ modelFallbacks: FALLBACKS }, {})).toEqual({ modelFallbacks: FALLBACKS });
  });

  test("an empty modelFallbacks wires no chain", () => {
    expect(wireModels({ modelFallbacks: [] }, {})).toEqual({});
  });

  test("--model drops the chain, tiers and pool (authored against the spec's primary) but keeps the breaker", () => {
    const wired = wireModels(
      { modelFallbacks: FALLBACKS, circuitBreaker: BREAKER, modelTiers: TIERS, modelPool: POOL },
      { modelOverride: "claude-opus-4-8" },
    );
    expect(wired).toEqual({ circuitBreaker: BREAKER });
  });

  test("a non-string override (absent flag) is not an override", () => {
    expect(wireModels({ modelPool: POOL }, { modelOverride: undefined })).toEqual({
      modelPool: POOL,
    });
  });
});

describe("renderModelWiringFields — the codegen twin, byte-identical to the retired renderers", () => {
  test("an empty fragment renders nothing (pre-existing bundles stay byte-identical)", () => {
    expect(renderModelWiringFields({}, "  ")).toBe("");
    expect(renderModelWiringFields({ modelFallbacks: [] }, "  ")).toBe("");
  });

  test("target-cli's two-space top-level call: every field, in order, escapeJsonString on model strings", () => {
    const rendered = renderModelWiringFields(
      { modelFallbacks: FALLBACKS, circuitBreaker: BREAKER, modelTiers: TIERS, modelPool: POOL },
      "  ",
    );
    expect(rendered).toBe(
      `\n  modelFallbacks: ["openai/gpt-4o-mini", "quoted\\"model"],` +
        `\n  circuitBreaker: {"failureThreshold":2,"cooldownMs":60000},` +
        `\n  modelTiers: {"fast":"claude-haiku-4-5","default":"claude-sonnet-4-6"},` +
        `\n  modelPool: {"candidates":[{"model":"claude-haiku-4-5","tags":["cheap"]},{"model":"claude-opus-4-8","tags":["strong"]}],"policy":"heuristic"},`,
    );
  });

  test("the pooled single-agent shapes' pool-only field at the caller's indent", () => {
    expect(renderModelWiringFields({ modelPool: POOL }, "        ")).toBe(
      `\n        modelPool: ${JSON.stringify(POOL)},`,
    );
    expect(renderModelWiringFields({ modelPool: POOL }, "    ")).toBe(
      `\n    modelPool: ${JSON.stringify(POOL)},`,
    );
  });

  test("the rendered string is exactly what a per-emitter renderer produced (the legacy oracle)", () => {
    // The retired renderer, verbatim, for every indent the ten emitters use.
    function legacy(block: ModelWiringFragment, indent: string): string {
      const pieces: string[] = [];
      const fallbacks = block.modelFallbacks;
      if (fallbacks !== undefined && fallbacks.length > 0) {
        pieces.push(
          `\n${indent}modelFallbacks: [${fallbacks.map((m) => JSON.stringify(m)).join(", ")}],`,
        );
      }
      if (block.circuitBreaker !== undefined) {
        pieces.push(`\n${indent}circuitBreaker: ${JSON.stringify(block.circuitBreaker)},`);
      }
      if (block.modelTiers !== undefined) {
        pieces.push(`\n${indent}modelTiers: ${JSON.stringify(block.modelTiers)},`);
      }
      if (block.modelPool !== undefined) {
        pieces.push(`\n${indent}modelPool: ${JSON.stringify(block.modelPool)},`);
      }
      return pieces.join("");
    }
    const fragments: ModelWiringFragment[] = [
      {},
      { modelPool: POOL },
      { modelTiers: TIERS },
      { modelFallbacks: FALLBACKS, circuitBreaker: BREAKER },
      { circuitBreaker: BREAKER },
      { modelFallbacks: [], modelPool: POOL },
      { modelPool: NEW_KEYS_POOL },
    ];
    for (const indent of ["  ", "    ", "        "]) {
      for (const frag of fragments) {
        expect(renderModelWiringFields(frag, indent)).toBe(legacy(frag, indent));
      }
    }
  });
});

describe("wireModels ≡ renderModelWiringFields — one code path, not a mirror", () => {
  const fragments: ReadonlyArray<[string, ModelWiringFragment]> = [
    ["empty", {}],
    ["pool", { modelPool: POOL }],
    ["tiers", { modelTiers: TIERS }],
    ["chain + breaker", { modelFallbacks: FALLBACKS, circuitBreaker: BREAKER }],
    ["breaker alone", { circuitBreaker: BREAKER }],
    [
      "everything",
      { modelFallbacks: FALLBACKS, circuitBreaker: BREAKER, modelTiers: TIERS, modelPool: POOL },
    ],
    ["new keys at every level", { modelPool: NEW_KEYS_POOL }],
  ];
  for (const [label, frag] of fragments) {
    test(`${label}: the rendered fields parse back to the wired options`, () => {
      const wired = wireModels(frag, {});
      const parsed = parseFields(renderModelWiringFields(frag, "  "), "  ");
      expect(parsed).toEqual(wired);
      // Key ORDER is part of the byte contract, not only the key set.
      expect(Object.keys(parsed as object)).toEqual(Object.keys(wired));
    });
  }
});

describe("one new IR key per level is observable at the runtime consumer (plan §17)", () => {
  test("profile-level (temperature), candidate-level (enabled), pool-level (rules, scope) all reach the option object", () => {
    const wired = wireModels(modelWiringFragmentFromIr({ modelPool: NEW_KEYS_POOL }), {});
    // The blob is the IR pool itself — nothing between the IR and the loop
    // allow-lists it (the runtime's option type admits the extra keys).
    expect(wired.modelPool).toBe(NEW_KEYS_POOL);
    const pool = wired.modelPool as unknown as Record<string, unknown>;
    const candidates = pool["candidates"] as ReadonlyArray<Record<string, unknown>>;
    expect(candidates[0]?.["temperature"]).toBe(0.2);
    expect(candidates[0]?.["profile"]).toBe("fast");
    expect(candidates[1]?.["enabled"]).toBe(false);
    expect(pool["rules"]).toEqual([
      { id: "images-need-vision", when: { has_images: true }, use: "strong" },
    ]);
    expect(pool["scope"]).toBe("main");
  });

  test("…and the SAME keys survive the codegen twin into an emitted bundle literal", () => {
    const rendered = renderModelWiringFields({ modelPool: NEW_KEYS_POOL }, "  ");
    expect(rendered).toContain('"temperature":0.2');
    expect(rendered).toContain('"profile":"fast"');
    expect(rendered).toContain('"enabled":false');
    expect(rendered).toContain('"rules":[{"id":"images-need-vision"');
    expect(rendered).toContain('"scope":"main"');
    // The key-order byte contract: `model` then `tags` first, 0.6.0 keys after.
    expect(rendered).toContain('{"model":"claude-haiku-4-5","tags":["cheap"],"profile":"fast"');
    expect(parseFields(rendered, "  ")).toEqual({ modelPool: NEW_KEYS_POOL });
  });
});

describe("runtime-core assignability pin", () => {
  test("wireModels(...) spreads into RunChatLoopOptions under runtime-core's own option names", () => {
    const wired = wireModels(
      { modelFallbacks: FALLBACKS, circuitBreaker: BREAKER, modelTiers: TIERS, modelPool: POOL },
      {},
    );
    // The load-bearing assertions are the ASSIGNMENTS typechecking: the
    // structural mirror this package exports must stay assignable to
    // runtime-core's option types, and every key it names must be a
    // `runChatLoop` option (the `Pick` constraint). `tsc -b` excludes test
    // files, so the build-time twin of this pin is `ModelRoutingRunOptions`
    // in the cli's `loop-contract.ts`, where runtime-core is a dependency.
    const opts: RunChatLoopOptions = { model: "claude-sonnet-4-6", instructions: "pin", ...wired };
    const picked: Pick<RunChatLoopOptions, keyof ModelWiringRunOptions> = wired;
    const roundTrip: RunChatLoopOptions["modelPool"] = wired.modelPool;
    expect(opts.modelPool).toBe(POOL);
    expect(picked.modelTiers).toBe(TIERS);
    expect(roundTrip).toBe(POOL);
    expect(Object.keys(wired)).toEqual([...MODEL_WIRING_KEYS]);
  });
});

// 0.6.0 PR 11 (§7.7) — the ONE sub-agent literal renderer the three Task-tool
// emitters (cli, channel-bot, crew) share.
describe("renderSubAgentDef — one renderer for the three __subAgents literals", () => {
  const legacy: IrSubAgentDefinition = {
    name: "digger",
    description: "Deep-dive researcher",
    instructions: "Dig deep.",
    tools: ["read", "grep"],
    permissions: "inherit",
    inheritBypass: false,
  };

  test("today's fields render EXACTLY the retired per-emitter string (the byte oracle)", () => {
    expect(renderSubAgentDef(legacy)).toBe(
      '{ name: "digger", description: "Deep-dive researcher", instructions: "Dig deep.", tools: ["read","grep"], permissions: "inherit", inherit_bypass: false }',
    );
    expect(
      renderSubAgentDef({
        ...legacy,
        model: "claude-haiku-4-5",
        permissions: { allow: ["Read"], deny: ["Bash(*)"] },
        inheritBypass: true,
      }),
    ).toBe(
      '{ name: "digger", description: "Deep-dive researcher", instructions: "Dig deep.", tools: ["read","grep"], model: "claude-haiku-4-5", permissions: { allow: ["Read"], deny: ["Bash(*)"] }, inherit_bypass: true }',
    );
  });

  test("every 0.6.0 key is appended AFTER the legacy fields, only when present, under the runtime names", () => {
    const pool = { candidates: [{ model: "a", tags: ["cheap"] }], policy: "static" as const };
    const rendered = renderSubAgentDef({
      ...legacy,
      model: "claude-sonnet-4-6",
      modelProfile: "mid",
      thinking: { effort: "low" },
      maxTokens: 512,
      temperature: 0.2,
      modelFallbacks: ["claude-haiku-4-5"],
      circuitBreaker: { failureThreshold: 2 },
      modelTiers: { fast: "a", default: "b" },
      modelPool: pool,
      budgetShare: 0.25,
      inheritRouting: true,
      allowedProfiles: [{ profile: "fast", model: "a", overlay: "Be quick." }],
    });
    expect(rendered).toBe(
      '{ name: "digger", description: "Deep-dive researcher", instructions: "Dig deep.", tools: ["read","grep"], model: "claude-sonnet-4-6", permissions: "inherit", inherit_bypass: false, modelProfile: "mid", thinking: {"effort":"low"}, maxTokens: 512, temperature: 0.2, modelFallbacks: ["claude-haiku-4-5"], circuitBreaker: {"failureThreshold":2}, modelTiers: {"fast":"a","default":"b"}, modelPool: {"candidates":[{"model":"a","tags":["cheap"]}],"policy":"static"}, budgetShare: 0.25, inheritRouting: true, allowedProfiles: [{"profile":"fast","model":"a","overlay":"Be quick."}] }',
    );
    // An EMPTY modelFallbacks is treated as absent (the emitters' length guard).
    expect(renderSubAgentDef({ ...legacy, modelFallbacks: [] })).toBe(renderSubAgentDef(legacy));
  });
});
