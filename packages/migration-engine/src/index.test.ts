/**
 * Section 28 — `migration-engine` tests:
 *  - T1 round-trip per registered migration
 *  - T4 fixture corpus replay
 */
import { describe, expect, test } from "bun:test";
import {
  MIGRATION_1_TO_2,
  MigrationEngine,
  MigrationError,
  MigrationIrreversibleError,
  NOOP_0_TO_1,
  createDefaultEngine,
  findModelPools,
} from "./index";

describe("migration-engine — T1 single-step migrations", () => {
  test("0 → 1 NOOP migrates and stamps version", () => {
    const e = createDefaultEngine();
    const out = e.migrate({ name: "x", target: "cli" }, 1);
    expect(out.version).toBe(1);
  });

  test("up + down round-trip", () => {
    const e = createDefaultEngine();
    const original = { name: "x", target: "cli", version: 0 };
    const up = e.migrate(original, 1);
    expect(up.version).toBe(1);
    const back = e.migrate(up, 0);
    expect(back.version).toBe(0);
  });

  test("from === to is a no-op", () => {
    const e = createDefaultEngine();
    const spec = { version: 0 };
    expect(e.migrate(spec, 0)).toBe(spec);
  });

  test("missing version step throws", () => {
    const e = new MigrationEngine();
    expect(() => e.migrate({ version: 0 }, 1)).toThrow(MigrationError);
  });

  test("registering same key twice throws", () => {
    const e = new MigrationEngine();
    e.register(NOOP_0_TO_1);
    expect(() => e.register(NOOP_0_TO_1)).toThrow(MigrationError);
  });

  test("registering same-version migration throws", () => {
    const e = new MigrationEngine();
    expect(() =>
      e.register({
        from: 0,
        to: 0,
        up: (s) => s,
        down: (s) => s,
      }),
    ).toThrow(MigrationError);
  });

  test("registering >1-step migration throws", () => {
    const e = new MigrationEngine();
    expect(() =>
      e.register({
        from: 0,
        to: 2,
        up: (s) => s,
        down: (s) => s,
      }),
    ).toThrow(MigrationError);
  });
});

describe("migration-engine — T4 multi-step chain replay", () => {
  test("0 → 2 walks 0→1 then 1→2", () => {
    const e = new MigrationEngine();
    e.register({
      from: 0,
      to: 1,
      up: (s) => ({ ...s, version: 1, addedAt1: true }),
      down: (s) => ({ ...s, version: 0 }),
    });
    e.register({
      from: 1,
      to: 2,
      up: (s) => ({ ...s, version: 2, addedAt2: true }),
      down: (s) => ({ ...s, version: 1 }),
    });
    const out = e.migrate({ version: 0 }, 2);
    expect(out.version).toBe(2);
    expect((out as { addedAt1?: boolean }).addedAt1).toBe(true);
    expect((out as { addedAt2?: boolean }).addedAt2).toBe(true);
  });

  test("2 → 0 walks 1→2.down then 0→1.down", () => {
    const e = new MigrationEngine();
    e.register({
      from: 0,
      to: 1,
      up: (s) => ({ ...s, version: 1 }),
      down: (s) => ({ ...s, version: 0, removedAt0: true }),
    });
    e.register({
      from: 1,
      to: 2,
      up: (s) => ({ ...s, version: 2 }),
      down: (s) => ({ ...s, version: 1, removedAt1: true }),
    });
    const out = e.migrate({ version: 2 }, 0);
    expect(out.version).toBe(0);
    expect((out as { removedAt0?: boolean }).removedAt0).toBe(true);
    expect((out as { removedAt1?: boolean }).removedAt1).toBe(true);
  });

  test("list returns sorted migration keys", () => {
    const e = new MigrationEngine();
    e.register({
      from: 1,
      to: 2,
      up: (s) => s,
      down: (s) => s,
    });
    e.register(NOOP_0_TO_1);
    expect(e.list()).toEqual(["0→1", "1→2"]);
  });

  test("clear empties the registry", () => {
    const e = createDefaultEngine();
    expect(e.list()).toEqual(["0→1", "1→2"]);
    e.clear();
    expect(e.list()).toEqual([]);
    // After clearing, the previously-registered step is gone.
    expect(() => e.migrate({ version: 0 }, 1)).toThrow(MigrationError);
  });
});

describe("migration-engine — additional coverage", () => {
  test("NOOP_0_TO_1.up stamps version 1 and preserves other keys", () => {
    const out = NOOP_0_TO_1.up({ name: "x", version: 0 });
    expect(out).toEqual({ name: "x", version: 1 });
  });

  test("NOOP_0_TO_1.down stamps version 0 and preserves other keys", () => {
    const out = NOOP_0_TO_1.down({ name: "x", version: 1 });
    expect(out).toEqual({ name: "x", version: 0 });
  });

  test("migrate treats a spec with no version field as version 0", () => {
    const e = createDefaultEngine();
    // No `version` key at all -> fromVersion defaults to 0, so 0 -> 1 runs.
    const out = e.migrate({ name: "no-version" }, 1);
    expect(out.version).toBe(1);
  });

  test("downgrade throws when the needed step is not registered", () => {
    const e = new MigrationEngine();
    // Walking down from 1 to 0 needs the 0→1 step's down(); none registered.
    expect(() => e.migrate({ version: 1 }, 0)).toThrow(MigrationError);
  });

  test("MigrationError carries the config code and an optional cause", () => {
    const cause = new Error("root");
    const err = new MigrationError("boom", cause);
    expect(err).toBeInstanceOf(MigrationError);
    expect(err.name).toBe("MigrationError");
    expect(err.cause).toBe(cause);
  });
});

describe("latestVersion (#43 — the current spec-schema version)", () => {
  test("empty engine → 0 (nothing to upgrade to)", () => {
    expect(new MigrationEngine().latestVersion()).toBe(0);
  });

  test("the default engine's latest is 2 (NOOP 0→1 then MIGRATION_1_TO_2)", () => {
    expect(createDefaultEngine().latestVersion()).toBe(2);
  });

  test("is the max `to` across registered migrations", () => {
    const e = new MigrationEngine();
    e.register(NOOP_0_TO_1);
    e.register({
      from: 1,
      to: 2,
      up: (s) => ({ ...s, version: 2 }),
      down: (s) => ({ ...s, version: 1 }),
    });
    expect(e.latestVersion()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 0.6.0 §9.2 — MIGRATION_1_TO_2, the edits seam, the irreversible guard
// ---------------------------------------------------------------------------

const LEARNED_POOL_SPEC = {
  name: "p",
  target: "cli",
  version: 1,
  agent: {
    model: "claude-sonnet-4-5",
    instructions: "hi",
    model_pool: {
      candidates: [
        { model: "claude-haiku-4-5", tags: ["cheap"] },
        { model: "claude-opus-4-8", tags: ["strong"] },
      ],
      policy: "learned",
    },
  },
};

describe("MIGRATION_1_TO_2 (0.6.0 §9.2)", () => {
  test("stamps version: 2 and touches nothing else on a pool-less spec", () => {
    const out = MIGRATION_1_TO_2.up({
      name: "x",
      target: "cli",
      version: 1,
      agent: { model: "m" },
    });
    expect(out).toEqual({ name: "x", target: "cli", version: 2, agent: { model: "m" } });
    expect(MIGRATION_1_TO_2.edits?.({ name: "x", version: 1 })).toEqual([
      { path: ["version"], value: 2, rationale: "schema version stamp (1 → 2)" },
    ]);
  });

  test("a LEARNED pool gets reward.quality_source: none made explicit — up() and edits() agree", () => {
    const up = MIGRATION_1_TO_2.up(LEARNED_POOL_SPEC);
    const pool = (up as typeof LEARNED_POOL_SPEC).agent.model_pool as Record<string, unknown>;
    expect(pool["reward"]).toEqual({ quality_source: "none" });
    expect(up.version).toBe(2);
    // The rest of the pool is untouched.
    expect(pool["policy"]).toBe("learned");
    expect(pool["candidates"]).toEqual(LEARNED_POOL_SPEC.agent.model_pool.candidates);

    const edits = MIGRATION_1_TO_2.edits?.(LEARNED_POOL_SPEC) ?? [];
    expect(edits.map((e) => [e.path, e.value])).toEqual([
      [["version"], 2],
      [["agent", "model_pool", "reward", "quality_source"], "none"],
    ]);
  });

  test("a heuristic / static pool is left alone (the default is only made visible where it steers)", () => {
    const spec = {
      ...LEARNED_POOL_SPEC,
      agent: {
        ...LEARNED_POOL_SPEC.agent,
        model_pool: { ...LEARNED_POOL_SPEC.agent.model_pool, policy: "heuristic" },
      },
    };
    const up = MIGRATION_1_TO_2.up(spec);
    expect(
      (up.agent as { model_pool: Record<string, unknown> }).model_pool["reward"],
    ).toBeUndefined();
    expect(MIGRATION_1_TO_2.edits?.(spec)).toHaveLength(1);
  });

  test("an already-explicit quality_source is respected; a reward block missing it is completed in place", () => {
    const explicit = {
      ...LEARNED_POOL_SPEC,
      agent: {
        ...LEARNED_POOL_SPEC.agent,
        model_pool: {
          ...LEARNED_POOL_SPEC.agent.model_pool,
          reward: { quality_source: "shadow" },
        },
      },
    };
    expect(MIGRATION_1_TO_2.edits?.(explicit)).toHaveLength(1);
    const partial = {
      ...LEARNED_POOL_SPEC,
      agent: {
        ...LEARNED_POOL_SPEC.agent,
        model_pool: {
          ...LEARNED_POOL_SPEC.agent.model_pool,
          reward: { priors: "eval" },
        },
      },
    };
    const up = MIGRATION_1_TO_2.up(partial);
    expect((up.agent as { model_pool: Record<string, unknown> }).model_pool["reward"]).toEqual({
      priors: "eval",
      quality_source: "none",
    });
  });

  test("every pool site is visited: sub-agents, workflow steps, graph nodes, crew roles", () => {
    const pool = { candidates: [], policy: "learned" };
    const spec = {
      version: 1,
      agent: { model: "m", model_pool: pool, sub_agents: { helper: { model_pool: pool } } },
      steps: [{ name: "a" }, { name: "b", model_pool: pool }],
      nodes: { plan: { model_pool: pool } },
      roles: { writer: { model_pool: pool } },
    };
    expect(findModelPools(spec).map((s) => s.path)).toEqual([
      ["agent", "model_pool"],
      ["agent", "sub_agents", "helper", "model_pool"],
      ["steps", 1, "model_pool"],
      ["nodes", "plan", "model_pool"],
      ["roles", "writer", "model_pool"],
    ]);
    type Pooled = { model_pool: { reward?: unknown } };
    const up = MIGRATION_1_TO_2.up(spec) as unknown as {
      agent: { sub_agents: { helper: Pooled } };
      steps: [{ name: string }, Pooled];
      nodes: { plan: Pooled };
      roles: { writer: Pooled };
    };
    expect(up.steps[1].model_pool.reward).toEqual({ quality_source: "none" });
    expect(up.steps[0]).toEqual({ name: "a" });
    expect(up.nodes.plan.model_pool.reward).toEqual({ quality_source: "none" });
    expect(up.roles.writer.model_pool.reward).toEqual({ quality_source: "none" });
    expect(up.agent.sub_agents.helper.model_pool.reward).toEqual({ quality_source: "none" });
    expect(MIGRATION_1_TO_2.edits?.(spec)).toHaveLength(6);
  });

  test("down() un-stamps to v1 and is NOT irreversible (a stamp plus one explicit default)", () => {
    expect(MIGRATION_1_TO_2.irreversible).toBeUndefined();
    const back = createDefaultEngine().migrate({ name: "x", version: 2 }, 1);
    expect(back.version).toBe(1);
  });

  test("the default engine walks 0 → 2 through both steps", () => {
    const out = createDefaultEngine().migrate({ name: "x", target: "cli" }, 2);
    expect(out.version).toBe(2);
  });
});

describe("planUp — the edits seam", () => {
  test("reports every step's edits and marks the walk editsComplete when all steps declare them", () => {
    const plan = createDefaultEngine().planUp({ name: "x", target: "cli" }, 2);
    expect(plan.editsComplete).toBe(true);
    expect(plan.steps.map((s) => [s.from, s.to])).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(plan.steps[0]?.edits).toEqual([
      { path: ["version"], value: 1, rationale: "schema version stamp (0 → 1)" },
    ]);
    expect(plan.steps[1]?.spec.version).toBe(2);
    expect(plan.spec.version).toBe(2);
  });

  test("a step without edits() leaves the walk editsComplete: false", () => {
    const e = new MigrationEngine();
    e.register(NOOP_0_TO_1);
    e.register({
      from: 1,
      to: 2,
      up: (s) => ({ ...s, version: 2 }),
      down: (s) => ({ ...s, version: 1 }),
    });
    const plan = e.planUp({ version: 0 }, 2);
    expect(plan.editsComplete).toBe(false);
    expect(plan.steps[1]?.edits).toBeUndefined();
  });

  test("a missing step throws; a target below the spec's version is refused", () => {
    const e = new MigrationEngine();
    e.register(NOOP_0_TO_1);
    expect(() => e.planUp({ version: 0 }, 2)).toThrow(MigrationError);
    expect(() => e.planUp({ version: 2 }, 1)).toThrow(/downgrades go through migrate\(\)/);
  });
});

describe("irreversible steps (0.6.0 §9.2)", () => {
  function engineWithLossyStep(): MigrationEngine {
    const e = new MigrationEngine();
    e.register(NOOP_0_TO_1);
    e.register({
      from: 1,
      to: 2,
      irreversible: true,
      up: (s) => ({ ...s, version: 2 }),
      down: () => {
        throw new Error("down() must never be called across an irreversible step");
      },
    });
    return e;
  }

  test("down() across an irreversible step throws MigrationIrreversibleError before any step runs", () => {
    const e = engineWithLossyStep();
    let caught: unknown;
    try {
      e.migrate({ version: 2 }, 0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationIrreversibleError);
    expect(caught).toBeInstanceOf(MigrationError);
    const err = caught as MigrationIrreversibleError;
    expect(err.name).toBe("MigrationIrreversibleError");
    expect(err.from).toBe(1);
    expect(err.to).toBe(2);
    expect(err.message).toContain("irreversible");
  });

  test("the up direction is unaffected, and a down-walk that stops ABOVE the lossy step still works", () => {
    const e = engineWithLossyStep();
    expect(e.migrate({ version: 0 }, 2).version).toBe(2);
    // 1 → 0 crosses only the reversible NOOP step.
    expect(e.migrate({ version: 1 }, 0).version).toBe(0);
  });
});
