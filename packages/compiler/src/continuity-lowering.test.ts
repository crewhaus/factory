/**
 * v0.3.0 PR 11 — lowering semantics for the `continuity:` block and the
 * `memory:` extensions (design §2.1, §2.7, §3.1, §9, §14.5):
 *
 *   - default-on: an ABSENT key lowers to the fully-resolved default
 *     IrContinuity (plan/ledger/handoff true, proof "ladder") on the five
 *     agent-loop shapes;
 *   - `scope: auto` resolves per shape (cli/research/crew/managed → spec,
 *     channel → session); explicit `session` is rejected off-channel;
 *   - memory extensions: `backend` carried verbatim, `ttl` parsed via the
 *     duration grammar (now with `d`) into `ttlMs` with a 1h floor, `wiki`
 *     spread field-by-field (declared-fields-only).
 */
import { describe, expect, test } from "bun:test";
import { CompilerError } from "@crewhaus/errors";
import type { IrContinuity, IrMemory } from "@crewhaus/ir";
import { parseSpec } from "@crewhaus/spec";
import { lower } from "./index";

/** The memory-fabric slice shared by the carrying variants — the union
 *  itself doesn't expose the optional fields, so tests read through this
 *  structural view (runtime shape is what the pins assert anyway). */
type FabricSlice = {
  readonly target: string;
  readonly memory?: IrMemory;
  readonly continuity?: IrContinuity;
};

function lowerYaml(yaml: string): FabricSlice {
  return lower(parseSpec(yaml)) as FabricSlice;
}

const CLI = `name: c
target: cli
agent:
  model: m
  instructions: i
`;

const CHANNEL = `name: ch
target: channel
agent:
  model: m
  instructions: i
channels:
  slack:
    botToken: $T
    signingSecret: $S
routing:
  sessionKey: thread
`;

const MANAGED = `name: mg
target: managed
agent:
  model: m
  instructions: i
tenants:
  - id: t1
    budget:
      maxInputTokens: 1000
      maxOutputTokens: 100
`;

const RESEARCH = `name: rs
target: research
agent:
  model: m
  instructions: i
goal: g
`;

const CREW = `name: cw
target: crew
model: m
entry: a
roles:
  a:
    instructions: do a
`;

const WORKFLOW = `name: wf
target: workflow
model: m
steps:
  - name: s1
    instructions: i
`;

describe("lowerContinuity — default-on + per-shape auto scope (§2.7/§14.5)", () => {
  const DEFAULT_SPEC_SCOPE = {
    plan: true,
    proof: "ladder",
    ledger: true,
    handoff: true,
    scope: "spec",
  };

  test("cli: absent key lowers to the default-on config, spec scope", () => {
    expect(lowerYaml(CLI).continuity).toEqual(DEFAULT_SPEC_SCOPE);
  });

  test("channel: auto resolves to SESSION scope (per-conversation stores)", () => {
    expect(lowerYaml(CHANNEL).continuity).toEqual({ ...DEFAULT_SPEC_SCOPE, scope: "session" });
  });

  test("managed/research/crew: auto resolves to spec scope", () => {
    for (const spec of [MANAGED, RESEARCH, CREW]) {
      expect(lowerYaml(spec).continuity).toEqual(DEFAULT_SPEC_SCOPE);
    }
  });

  test("continuity: true (shorthand) lowers identically to absent", () => {
    expect(lowerYaml(`${CLI}continuity: true\n`).continuity).toEqual(DEFAULT_SPEC_SCOPE);
  });

  test("continuity: false / {enabled: false} lower to NO key at all", () => {
    expect("continuity" in lowerYaml(`${CLI}continuity: false\n`)).toBe(false);
    expect("continuity" in lowerYaml(`${CLI}continuity:\n  enabled: false\n`)).toBe(false);
  });

  test("declared fields override the defaults; the rest resolve", () => {
    const ir = lowerYaml(
      `${CLI}continuity:\n  plan: false\n  proof: require\n  focusMaxChars: 2048\n`,
    );
    expect(ir.continuity).toEqual({
      plan: false,
      proof: "require",
      ledger: true,
      handoff: true,
      scope: "spec",
      focusMaxChars: 2048,
    });
  });

  test("explicit scope: spec on channel overrides auto's session resolution", () => {
    expect(lowerYaml(`${CHANNEL}continuity:\n  scope: spec\n`).continuity).toEqual(
      DEFAULT_SPEC_SCOPE,
    );
  });

  test("explicit scope: session is accepted on channel", () => {
    expect(lowerYaml(`${CHANNEL}continuity:\n  scope: session\n`).continuity).toEqual({
      ...DEFAULT_SPEC_SCOPE,
      scope: "session",
    });
  });

  test("explicit scope: session is REJECTED on shapes without a session router", () => {
    for (const spec of [CLI, MANAGED, RESEARCH, CREW, WORKFLOW]) {
      expect(() => lowerYaml(`${spec}continuity:\n  scope: session\n`)).toThrow(CompilerError);
    }
  });

  test("carried shapes: absent lowers to NO key (no default-on)", () => {
    expect("continuity" in lowerYaml(WORKFLOW)).toBe(false);
  });

  test("carried shapes: declared continuity lowers resolved (spec scope)", () => {
    expect(lowerYaml(`${WORKFLOW}continuity: true\n`).continuity).toEqual(DEFAULT_SPEC_SCOPE);
  });
});

describe("lowerMemory — v0.3.0 extensions (backend/ttl/wiki, §9)", () => {
  test("declared fields carry through; autoRecall/autoCapture resolve (G46)", () => {
    // Batch E (G46): with the block present, autoCapture defaults to true and
    // autoRecall to true ("session-start", not carried); every OTHER field
    // keeps the declared-fields-only discipline.
    const ir = lowerYaml(`${CLI}memory:\n  autoRecall: true\n  recallK: 4\ncontinuity: false\n`);
    expect(ir.memory).toEqual({ autoCapture: true, autoRecall: true, recallK: 4 });
  });

  test("backend + ttl + wiki lower verbatim/parsed (ttl → ttlMs)", () => {
    const ir = lowerYaml(
      `${CLI}memory:\n  backend: file\n  ttl: 90d\n  wiki:\n    enabled: true\n    recallK: 6\n    embedder: mock/deterministic\n    autoRecall: true\n    requireSources: true\n`,
    );
    expect(ir.memory).toEqual({
      backend: "file",
      ttlMs: 90 * 24 * 60 * 60 * 1000,
      // Batch E (G46) — resolved auto-recall/capture defaults.
      autoCapture: true,
      autoRecall: true,
      wiki: {
        enabled: true,
        recallK: 6,
        embedder: "mock/deterministic",
        autoRecall: true,
        requireSources: true,
      },
    });
  });

  test("duration grammar: h/m units still parse; d is new (§9 ttl: 90d)", () => {
    expect(lowerYaml(`${CLI}memory:\n  ttl: 12h\n`).memory?.ttlMs).toBe(12 * 60 * 60 * 1000);
    expect(lowerYaml(`${CLI}memory:\n  ttl: 1d\n`).memory?.ttlMs).toBe(24 * 60 * 60 * 1000);
  });

  test("ttl below the 1h floor is rejected at compile time", () => {
    expect(() => lowerYaml(`${CLI}memory:\n  ttl: 30m\n`)).toThrow(CompilerError);
    expect(() => lowerYaml(`${CLI}memory:\n  ttl: 59m\n`)).toThrow(CompilerError);
    expect(() => lowerYaml(`${CLI}memory:\n  ttl: 1h\n`)).not.toThrow();
  });

  test("heartbeat.every accepts the extended d unit and lowers to ms", () => {
    const ir = lower(parseSpec(`${CHANNEL}heartbeat:\n  every: 1d\n  instructions: tick\n`));
    if (ir.target !== "channel") throw new Error("expected channel");
    expect(ir.heartbeat?.everyMs).toBe(24 * 60 * 60 * 1000);
  });

  test("crew now carries memory (emit-wired in 0.3.0)", () => {
    const ir = lower(parseSpec(`${CREW}memory:\n  autoRecall: true\n`));
    if (ir.target !== "crew") throw new Error("expected crew");
    // Batch E (G46) — autoCapture resolves to true alongside autoRecall.
    expect(ir.memory).toEqual({ autoCapture: true, autoRecall: true });
  });
});

describe("lowerMemory — dream (v0.3.0 PR 14, §6/§9)", () => {
  test("dream lowers with every → everyMs and mode resolved to its default", () => {
    const ir = lowerYaml(`${CLI}memory:\n  dream:\n    every: 24h\n`);
    expect(ir.memory).toEqual({
      // Batch E (G46) — resolved auto-recall/capture defaults ride alongside.
      autoCapture: true,
      autoRecall: true,
      dream: { everyMs: 24 * 60 * 60 * 1000, mode: "full" },
    });
  });

  test("full dream block lowers verbatim (budget_usd → budgetUsd)", () => {
    const ir = lowerYaml(
      `${CLI}memory:\n  dream:\n    every: 1d\n    mode: deterministic\n    budget_usd: 0.5\n    instructions: consolidate gently\n`,
    );
    expect(ir.memory?.dream).toEqual({
      everyMs: 24 * 60 * 60 * 1000,
      mode: "deterministic",
      budgetUsd: 0.5,
      instructions: "consolidate gently",
    });
  });

  test("dream.every below the 5m floor is rejected at compile time", () => {
    expect(() => lowerYaml(`${CLI}memory:\n  dream:\n    every: 4m\n`)).toThrow(CompilerError);
    expect(() => lowerYaml(`${CLI}memory:\n  dream:\n    every: 30s\n`)).toThrow(
      /below the 5m floor/,
    );
    expect(() => lowerYaml(`${CLI}memory:\n  dream:\n    every: 5m\n`)).not.toThrow();
  });

  test("dream.every is required and typo'd sub-keys fail the strict schema", () => {
    expect(() => lowerYaml(`${CLI}memory:\n  dream:\n    mode: full\n`)).toThrow();
    expect(() =>
      lowerYaml(`${CLI}memory:\n  dream:\n    every: 24h\n    budgetUsd: 0.5\n`),
    ).toThrow();
  });

  test("dream is carried on every memory-bearing shape (channel here)", () => {
    const ir = lower(
      parseSpec(`${CHANNEL}memory:\n  dream:\n    every: 12h\n    budget_usd: 0.25\n`),
    );
    if (ir.target !== "channel") throw new Error("expected channel");
    expect(ir.memory?.dream).toEqual({
      everyMs: 12 * 60 * 60 * 1000,
      mode: "full",
      budgetUsd: 0.25,
    });
  });

  test("a memory block without dream lowers with no dream key (declared-fields-only)", () => {
    const ir = lowerYaml(`${CLI}memory:\n  autoRecall: true\ncontinuity: false\n`);
    // Batch E (G46) — autoCapture resolves to true; dream stays absent.
    expect(ir.memory).toEqual({ autoCapture: true, autoRecall: true });
    expect(ir.memory && "dream" in ir.memory).toBe(false);
  });
});
