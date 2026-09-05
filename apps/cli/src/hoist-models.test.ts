/**
 * 0.6.0 §9.2 — `crewhaus upgrade --hoist-models`.
 *
 * The load-bearing test is IR EQUALITY: the hoisted spec must lower to the
 * same IR as the source, modulo the provenance the registry adds (`models`
 * at the root, `modelProfile` on slots, `profile` on candidates). Profiles
 * are a lower-time macro, so anything else that differs is a planner bug.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lower } from "@crewhaus/compiler";
import { parseSpec } from "@crewhaus/spec";
import {
  countArmLines,
  enumerateHoistSlots,
  formatArmNotes,
  formatHoistPlan,
  planHoistModels,
  rewriteArmsFile,
} from "./hoist-models";

/** Strip the provenance-only keys a `models:` registry adds to the IR. */
function stripProvenance(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripProvenance);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "modelProfile" || k === "profile") continue;
      out[k] = stripProvenance(val);
    }
    return out;
  }
  return v;
}

function irModuloRegistry(yaml: string): unknown {
  const ir = lower(parseSpec(yaml)) as Record<string, unknown>;
  const { models: _registry, ...rest } = ir;
  return stripProvenance(rest);
}

const CLI_WITH_SUBAGENT = [
  "# keep me",
  "name: support",
  "target: cli",
  "agent:",
  "  model: claude-sonnet-4-5        # repeated below",
  "  thinking: { effort: low }",
  "  max_tokens: 4096",
  "  instructions: Help.",
  "  sub_agents:",
  "    helper:",
  "      description: a helper",
  "      instructions: help",
  "      model: claude-sonnet-4-5",
  "      thinking: { effort: low }",
  "      max_tokens: 4096",
  "    checker:",
  "      description: checks",
  "      instructions: check",
  "      model: claude-opus-4-8",
  "      max_tokens: 2048",
  "compaction:",
  "  model: claude-haiku-4-5",
  "",
].join("\n");

const WORKFLOW_TWO_TRIPLES = [
  "name: w",
  "target: workflow",
  "model: claude-haiku-4-5",
  "steps:",
  "  - name: draft",
  "    instructions: draft it",
  "    model: claude-haiku-4-5",
  "    max_tokens: 1024",
  "  - name: polish",
  "    instructions: polish it",
  "    model: claude-opus-4-8",
  "    thinking: { effort: high }",
  "  - name: redraft",
  "    instructions: again",
  "    model: claude-haiku-4-5",
  "    max_tokens: 1024",
  "  - name: final",
  "    instructions: finish",
  "    model: claude-opus-4-8",
  "    thinking: { effort: high }",
  "",
].join("\n");

const POOLED = [
  "name: pooled",
  "target: cli",
  "agent:",
  "  model: claude-opus-4-8",
  "  thinking: { effort: high }",
  "  instructions: Help.",
  "  model_pool:",
  "    candidates:",
  "      - { model: claude-haiku-4-5, tags: [cheap] }",
  "      - { model: claude-opus-4-8, tags: [strong], thinking: { effort: high } }",
  "    policy: learned",
  "",
].join("\n");

describe("planHoistModels — what gets hoisted", () => {
  test("a triple repeated on agent + a sub-agent becomes ONE profile; a one-off slot stays inline", () => {
    const plan = planHoistModels(CLI_WITH_SUBAGENT);
    expect(plan.action).toBe("hoist");
    expect(plan.profiles).toHaveLength(1);
    const [p] = plan.profiles;
    expect(p?.name).toBe("default");
    expect(p?.model).toBe("claude-sonnet-4-5");
    expect(p?.thinking).toEqual({ effort: "low" });
    expect(p?.max_tokens).toBe(4096);
    expect(p?.slots.map((s) => s.label)).toEqual(["agent", "agent.sub_agents.helper"]);
    // Comments survive, the one-off `checker` keeps its inline settings, the
    // aux compaction slot is untouched.
    expect(plan.yaml).toContain("# keep me");
    expect(plan.yaml).toMatch(/model: \$default +# repeated below/);
    expect(plan.yaml).toContain("      model: claude-opus-4-8\n      max_tokens: 2048");
    expect(plan.yaml).toContain("compaction:\n  model: claude-haiku-4-5");
    expect(plan.yaml).toContain("models:\n  default:\n    model: claude-sonnet-4-5");
    expect(plan.armRewrites).toEqual([]);
  });

  test("two repeated triples are named by price rank — fast is the cheaper one", () => {
    const plan = planHoistModels(WORKFLOW_TWO_TRIPLES);
    expect(plan.profiles.map((p) => [p.name, p.model])).toEqual([
      ["fast", "claude-haiku-4-5"],
      ["strong", "claude-opus-4-8"],
    ]);
    expect(plan.profiles[0]?.pricePer1M).toBeLessThan(plan.profiles[1]?.pricePer1M ?? 0);
    const parsed = parseSpec(plan.yaml) as unknown as {
      steps: Array<{ model?: string; max_tokens?: number; thinking?: unknown }>;
    };
    expect(parsed.steps.map((s) => s.model)).toEqual(["$fast", "$strong", "$fast", "$strong"]);
    expect(parsed.steps.every((s) => s.max_tokens === undefined && s.thinking === undefined)).toBe(
      true,
    );
  });

  test("the same model with DIFFERENT settings is two triples, not one", () => {
    const plan = planHoistModels(POOLED);
    // agent + strong candidate share {opus, effort high}; the cheap candidate is alone.
    expect(plan.profiles).toHaveLength(1);
    expect(plan.profiles[0]?.slots.map((s) => s.label)).toEqual([
      "agent",
      "agent.model_pool.candidates[1]",
    ]);
    // Hoisting a candidate changes its arm id — reported, never silent.
    expect(plan.armRewrites).toEqual([{ model: "claude-opus-4-8", profile: "default" }]);
    expect(plan.yaml).toContain("{ model: $default, tags: [ strong ] }");
  });

  test("nothing to hoist when no triple repeats, when a slot is already a $ref, or on a sentinel", () => {
    const single = "name: s\ntarget: cli\nagent:\n  model: claude-sonnet-4-5\n  instructions: hi\n";
    expect(planHoistModels(single).action).toBe("nothing-to-hoist");
    expect(planHoistModels(single).yaml).toBe(single);
    const refs = [
      "name: r",
      "target: cli",
      "models:",
      "  fast: { model: claude-haiku-4-5 }",
      "agent:",
      "  model: $fast",
      "  instructions: hi",
      "  sub_agents:",
      "    a: { description: d, instructions: i, model: $fast }",
      "",
    ].join("\n");
    expect(planHoistModels(refs).action).toBe("nothing-to-hoist");
    expect(
      enumerateHoistSlots({
        agent: { model: "cheapest", sub_agents: { a: { model: "$fast" } } },
      }).map((s) => s.label),
    ).toEqual([]);
  });

  test("a new profile never clobbers a declared one", () => {
    const declared = [
      "name: d",
      "target: cli",
      "models:",
      "  default: { model: claude-haiku-4-5 }",
      "agent:",
      "  model: claude-sonnet-4-5",
      "  instructions: hi",
      "  sub_agents:",
      "    a: { description: d, instructions: i, model: claude-sonnet-4-5 }",
      "",
    ].join("\n");
    const plan = planHoistModels(declared);
    expect(plan.profiles[0]?.name).toBe("default-2");
    const models = (parseSpec(plan.yaml) as unknown as { models: Record<string, unknown> }).models;
    expect(Object.keys(models).sort()).toEqual(["default", "default-2"]);
  });
});

describe("planHoistModels — IR equality (the contract)", () => {
  for (const [label, yaml] of [
    ["cli + sub-agents", CLI_WITH_SUBAGENT],
    ["workflow steps", WORKFLOW_TWO_TRIPLES],
    ["pooled agent + candidate", POOLED],
  ] as const) {
    test(`${label}: the hoisted spec lowers identically (modulo provenance)`, () => {
      const plan = planHoistModels(yaml);
      expect(plan.action).toBe("hoist");
      expect(irModuloRegistry(plan.yaml)).toEqual(irModuloRegistry(yaml));
      // And the provenance IS there — the hoist was real.
      const ir = lower(parseSpec(plan.yaml)) as { models?: Record<string, unknown> };
      expect(Object.keys(ir.models ?? {})).toEqual(plan.profiles.map((p) => p.name));
    });
  }

  test("a hoisted candidate keeps its tags and gains the profile as its arm identity", () => {
    const plan = planHoistModels(POOLED);
    const ir = lower(parseSpec(plan.yaml)) as unknown as {
      agent: {
        modelPool: { candidates: Array<{ model: string; tags: string[]; profile?: string }> };
      };
    };
    expect(ir.agent.modelPool.candidates[1]).toMatchObject({
      model: "claude-opus-4-8",
      tags: ["strong"],
      profile: "default",
    });
    expect(ir.agent.modelPool.candidates[0]?.profile).toBeUndefined();
  });
});

describe("formatHoistPlan", () => {
  test("names the profiles, their slots, the diff and the dry-run remedy", () => {
    const out = formatHoistPlan(planHoistModels(WORKFLOW_TWO_TRIPLES), false);
    expect(out).toContain("$fast: claude-haiku-4-5 (max_tokens: 1024)");
    expect(out).toContain('$strong: claude-opus-4-8 (thinking: {"effort":"high"})');
    expect(out).toContain("← steps[0]");
    expect(out).toContain("~ steps[0].model:");
    expect(out).toContain("dry-run");
    expect(formatHoistPlan(planHoistModels(WORKFLOW_TWO_TRIPLES), true)).toContain("applied");
  });

  test("nothing-to-hoist says why", () => {
    const out = formatHoistPlan(
      planHoistModels("name: s\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n"),
      false,
    );
    expect(out).toContain("nothing to hoist");
  });
});

describe("arms.jsonl handling — never silently orphaned", () => {
  const line = (m: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ v: 1, k: "hard", m, r: 0.5, s: 1, l: 10, ...extra });

  test("countArmLines counts delta and aggregate lines per model, tolerating junk", () => {
    const dir = mkdtempSync(join(tmpdir(), "hoist-arms-"));
    try {
      const path = join(dir, "arms.jsonl");
      writeFileSync(
        path,
        `${[line("claude-opus-4-8"), line("claude-haiku-4-5"), "not json", line("claude-opus-4-8", { agg: 1 })].join("\n")}\n`,
      );
      const counts = countArmLines(path, ["claude-opus-4-8", "claude-haiku-4-5", "other"]);
      expect(counts.get("claude-opus-4-8")).toBe(2);
      expect(counts.get("claude-haiku-4-5")).toBe(1);
      expect(counts.get("other")).toBe(0);
      expect(countArmLines(join(dir, "missing.jsonl"), ["x"]).get("x")).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rewriteArmsFile re-keys only the hoisted model, in place, via a tmp-then-rename swap", () => {
    const dir = mkdtempSync(join(tmpdir(), "hoist-arms-"));
    try {
      const path = join(dir, "arms.jsonl");
      writeFileSync(
        path,
        `${[line("claude-opus-4-8"), line("claude-haiku-4-5"), "garbage", line("claude-opus-4-8", { agg: 1, n: 3 })].join("\n")}\n`,
      );
      const result = rewriteArmsFile(path, [{ model: "claude-opus-4-8", profile: "default" }]);
      expect(result).toEqual({ total: 4, rewritten: 2 });
      const after = readFileSync(path, "utf-8").split("\n");
      expect(JSON.parse(after[0] ?? "")).toMatchObject({ k: "hard", m: "default", r: 0.5 });
      expect(JSON.parse(after[1] ?? "")).toMatchObject({ m: "claude-haiku-4-5" });
      expect(after[2]).toBe("garbage");
      expect(JSON.parse(after[3] ?? "")).toMatchObject({ m: "default", agg: 1, n: 3 });
      expect(after[4]).toBe("");
      // No leftover tmp file.
      expect(() => readFileSync(`${path}.tmp`)).toThrow();
      // Absent file: a no-op.
      expect(rewriteArmsFile(join(dir, "nope.jsonl"), [{ model: "a", profile: "b" }])).toEqual({
        total: 0,
        rewritten: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formatArmNotes prints the reset note without --rewrite-arms and the re-key line with it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hoist-arms-"));
    try {
      const path = join(dir, "arms.jsonl");
      writeFileSync(path, `${line("claude-opus-4-8")}\n`);
      const plan = planHoistModels(POOLED);
      const note = formatArmNotes(path, plan);
      expect(note).toContain("claude-opus-4-8 → $default");
      expect(note).toContain("(1 line(s) in");
      expect(note).toContain("learned-history");
      expect(note).toContain("--rewrite-arms");
      const applied = formatArmNotes(path, plan, { rewritten: 1 });
      expect(applied).toContain("re-keyed 1 arm line(s)");
      // No candidate hoisted → nothing to say.
      expect(formatArmNotes(path, planHoistModels(WORKFLOW_TWO_TRIPLES))).toBe("");
      // No arms recorded → the identity note only.
      expect(formatArmNotes(join(dir, "none.jsonl"), plan)).toContain("nothing to re-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
