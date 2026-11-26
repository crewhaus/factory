/**
 * The model walk (`@crewhaus/ir/slots`) is complete at the string level: for
 * every shape, fixtures put a distinct sentinel model id in every
 * model-bearing field the schema has (the leaves named `model`, `models`,
 * `judges`, `candidates`, `grade_with` and `fallbacks`, enumerated from
 * `specJsonSchema()`), and every sentinel that reaches the lowered IR must be
 * one the walk reports. A model the harness can call that the walk misses is
 * a model no audit, credential list or price check would see.
 *
 * The leaf count is pinned: a new model-bearing field fails here until a
 * fixture covers it. The fixtures also carry the fields with other names
 * (`model_fallbacks`, `model_tiers`, `shadow.candidate`, `committee.judge`,
 * `grounding_model`, a federation peer) so those reach the walk too.
 *
 * In `@crewhaus/compile-service`, not `@crewhaus/ir`: the fixtures are lowered
 * by the compiler, which ir's own tests may not import.
 */
import { describe, expect, test } from "bun:test";
import { lower, lowerWithWarnings } from "@crewhaus/compiler";
import { JUSTIFICATION_JUDGE_DEFAULT_MODEL, enumerateModelSlots } from "@crewhaus/ir/slots";
import { type Spec, parseSpec, specJsonSchema } from "@crewhaus/spec";
import { ABSENT_CORPUS } from "../../compiler/src/absent-corpus";

type Shape = Spec["target"];
type Json = Record<string, unknown>;

const LEAF_NAMES = new Set(["model", "models", "judges", "candidates", "grade_with", "fallbacks"]);

/** Every model-bearing leaf of one shape's schema (see {@link schemaPaths}). */
function schemaLeaves(shape: Shape): string[] {
  return schemaPaths(shape).filter((path) => LEAF_NAMES.has(path.split(".").at(-1) as string));
}

/**
 * Every property path of one shape's schema, as a dotted pattern: `*` is any
 * key of a record, `[]` any index of a list.
 */
function schemaPaths(shape: Shape): string[] {
  const schema = specJsonSchema() as Json;
  const resolve = (node: unknown): Json | undefined => {
    let current = node as Json | undefined;
    for (let hops = 0; hops < 50 && typeof current?.["$ref"] === "string"; hops++) {
      let target: unknown = schema;
      for (const part of (current["$ref"] as string).replace(/^#\//, "").split("/")) {
        target = (target as Json | undefined)?.[decodeURIComponent(part)];
      }
      current = target as Json | undefined;
    }
    return current;
  };
  const out = new Set<string>();
  const walk = (node: unknown, path: string[], seen: ReadonlySet<unknown>): void => {
    const n = resolve(node);
    if (n === undefined || typeof n !== "object" || seen.has(n) || path.length > 30) return;
    const next = new Set(seen).add(n);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      for (const branch of (n[key] as unknown[] | undefined) ?? []) walk(branch, path, next);
    }
    for (const [key, value] of Object.entries((n["properties"] as Json | undefined) ?? {})) {
      out.add([...path, key].join("."));
      walk(value, [...path, key], next);
    }
    const extra = n["additionalProperties"];
    if (typeof extra === "object" && extra !== null) walk(extra, [...path, "*"], next);
    const items = n["items"];
    for (const item of Array.isArray(items) ? items : items !== undefined ? [items] : []) {
      walk(item, [...path, "[]"], next);
    }
  };
  walk((schema["definitions"] as Json)[shape], [], new Set());
  return [...out].sort();
}

/** Whether `value` holds something at a path matching `pattern`. */
function covers(value: unknown, pattern: ReadonlyArray<string>): boolean {
  if (pattern.length === 0) return value !== undefined && value !== null;
  const [head, ...rest] = pattern as [string, ...string[]];
  if (head === "[]") return Array.isArray(value) && value.some((v) => covers(v, rest));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Json;
  if (head === "*") return Object.values(record).some((v) => covers(v, rest));
  return covers(record[head], rest);
}

/** Distinct sentinel model ids, one per call. */
function sentinels(): () => string {
  let n = 0;
  return () => `claude-sentinel-${String(++n).padStart(3, "0")}`;
}
const SENTINEL_RE = /claude-sentinel-\d{3}/g;

function corpus(shape: Shape): Json {
  return Bun.YAML.parse(ABSENT_CORPUS[shape]) as Json;
}

/** A model pool with a candidate failover chain, a guide and a shadow arm. */
function strategyPool(s: () => string): Json {
  return {
    candidates: [
      { model: s(), tags: ["cheap"], fallbacks: [s()] },
      { model: s(), tags: ["strong"] },
    ],
    strategy: {
      guide: { model: s() },
      shadow: { candidate: s(), grade_with: s(), sample_rate: 0.2 },
    },
  };
}

/** A model pool routed by a classifier model. */
function classifierPool(s: () => string): Json {
  return {
    candidates: [
      { model: s(), tags: ["cheap"] },
      { model: s(), tags: ["strong"] },
    ],
    policy: "classifier",
    classifier: { model: s(), labels: { cheap: "easy", strong: "hard" } },
  };
}

/** A model pool with a judged committee. */
function committeePool(s: () => string): Json {
  return {
    candidates: [
      { model: s(), tags: ["cheap"] },
      { model: s(), tags: ["strong"] },
    ],
    strategy: { committee: { members: ["cheap", "strong"], judge: s() } },
  };
}

/** A profile with a failover chain, for a slot to name as `$first`. */
function profiles(s: () => string): Json {
  return { first: { model: s(), fallbacks: [s(), s()] } };
}

/** Sub-agents: one with its own model, pool and allowed profiles; one federated. */
function subAgents(s: () => string, pool: Json): Json {
  return {
    helper: {
      description: "helps",
      instructions: "help",
      model: s(),
      model_pool: pool,
      allowed_profiles: ["$second"],
    },
    peer: {
      description: "a remote peer",
      instructions: "delegate",
      federation: { url: "https://peer.example.com" },
    },
  };
}

/** The blocks beside the agent a shape's schema carries, each with a sentinel. */
function auxBlocks(shape: Shape, s: () => string): Json {
  const leaves = new Set(schemaLeaves(shape));
  return {
    ...(leaves.has("compaction.model") ? { compaction: { model: s() } } : {}),
    ...(leaves.has("evaluation.grader.model")
      ? {
          evaluation: {
            grader: { type: "llm_judge", criteria: "good?", model: s() },
            threshold: 0.7,
          },
        }
      : {}),
    ...(leaves.has("budget.on_exceed.model")
      ? { budget: { usd: 5, on_exceed: { action: "degrade", model: s() } } }
      : {}),
    ...(leaves.has("provability.judge.model")
      ? { provability: { level: "cited", judge: { model: s() } } }
      : {}),
    ...(leaves.has("security.justification.model")
      ? { security: { justification: { judge: "claude", model: s() } } }
      : {}),
    ...(leaves.has("watchme.judge.model") ? { watchme: { judge: { model: s() } } } : {}),
  };
}

/** The fixtures for one shape: the corpus spec with sentinels merged in. */
function fixturesFor(shape: Shape): Json[] {
  const s = sentinels();
  const base = corpus(shape);
  const leaves = new Set(schemaLeaves(shape));
  const withAgent = (agent: Json, extra: Json = {}): Json => ({
    ...base,
    ...extra,
    agent: { ...(base["agent"] as Json), ...agent },
  });
  const paths = new Set(schemaPaths(shape));
  const pooled = leaves.has("agent.model_pool.candidates");
  const subAgented = leaves.has("agent.sub_agents.*.model");
  switch (shape) {
    case "workflow":
      return [
        {
          ...base,
          model: s(),
          ...auxBlocks(shape, s),
          steps: [
            { name: "a", instructions: "one", model: s(), model_pool: strategyPool(s) },
            { name: "b", instructions: "two", model: s(), model_pool: classifierPool(s) },
            { name: "c", instructions: "three", model: s(), model_pool: committeePool(s) },
            { name: "d", kind: "judge", judge: { criteria: "good?", model: s() } },
            { name: "e", kind: "judge", judge: { criteria: "good?", judges: [s(), s()] } },
            { name: "f", instructions: "on the default model" },
          ],
        },
        { ...base, models: profiles(s), model: "$first" },
      ];
    case "graph":
      return [
        {
          ...base,
          model: s(),
          ...auxBlocks(shape, s),
          nodes: {
            classify: { instructions: "one", model: s(), model_pool: strategyPool(s) },
            b: { instructions: "two", model: s(), model_pool: classifierPool(s) },
            c: { instructions: "three", model: s(), model_pool: committeePool(s) },
            d: { kind: "judge", judge: { criteria: "good?", model: s() } },
            e: { kind: "judge", judge: { criteria: "good?", judges: [s(), s()] } },
            f: { instructions: "on the default model" },
          },
          edges: [
            { from: "classify", to: "b" },
            { from: "b", to: "c" },
            { from: "c", to: "d" },
            { from: "d", to: "e" },
            { from: "e", to: "f" },
          ],
        },
        { ...base, models: profiles(s), model: "$first" },
      ];
    case "crew":
      return [
        {
          ...base,
          model: s(),
          models: { second: { model: s() } },
          ...auxBlocks(shape, s),
          roles: {
            editor: {
              instructions: "assign",
              model: s(),
              model_pool: strategyPool(s),
              sub_agents: subAgents(s, strategyPool(s)),
            },
            writer: {
              instructions: "write",
              model_pool: classifierPool(s),
              sub_agents: {
                helper: {
                  description: "helps",
                  instructions: "help",
                  model_pool: classifierPool(s),
                },
              },
            },
            critic: { instructions: "critique", model_pool: committeePool(s) },
          },
          routing: { kind: "llm", model: s() },
        },
        { ...base, models: profiles(s), model: "$first" },
      ];
    default:
      return [
        withAgent(
          {
            model: s(),
            ...(pooled ? { model_pool: strategyPool(s) } : {}),
            ...(subAgented ? { sub_agents: subAgents(s, strategyPool(s)) } : {}),
          },
          { ...(subAgented ? { models: { second: { model: s() } } } : {}), ...auxBlocks(shape, s) },
        ),
        ...(pooled
          ? [
              withAgent(
                {
                  model: s(),
                  model_pool: classifierPool(s),
                  ...(subAgented
                    ? {
                        sub_agents: {
                          helper: {
                            description: "helps",
                            instructions: "help",
                            model_pool: classifierPool(s),
                          },
                        },
                      }
                    : {}),
                },
                leaves.has("evaluation.grader.judges")
                  ? {
                      evaluation: {
                        grader: { type: "llm_judge", criteria: "good?", judges: [s(), s()] },
                        threshold: 0.7,
                      },
                    }
                  : {},
              ),
            ]
          : []),
        ...(paths.has("agent.model_tiers.fast")
          ? [withAgent({ model: s(), model_tiers: { fast: s(), default: s() } })]
          : []),
        ...(paths.has("agent.model_fallbacks")
          ? [withAgent({ model: s(), model_fallbacks: [s()] })]
          : []),
        withAgent({ model: "$first" }, { models: profiles(s) }),
      ];
  }
}

const SHAPES = Object.keys(ABSENT_CORPUS) as Shape[];

/**
 * Where each sentinel sits in a fixture: the concrete dotted path (list
 * indexes as segments, `models.first.fallbacks.0`), for the sentinels in `ids`.
 */
function placements(fixture: unknown, ids: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === "string" && ids.has(value)) out.set(value, path.join("."));
    else if (Array.isArray(value)) value.forEach((v, i) => visit(v, [...path, String(i)]));
    else if (typeof value === "object" && value !== null) {
      for (const [k, v] of Object.entries(value)) visit(v, [...path, k]);
    }
  };
  visit(fixture, []);
  return out;
}

/**
 * The spec paths the lowering says it ignores on this fixture's shape or slot
 * (`model-plan-ignored-on-shape`, `model-plan-ignored-on-slot`). A profile's
 * failover chain, for one, is carried onto the slot that names the profile
 * only where that slot serves a chain; elsewhere the compiler warns that it is
 * ignored, the chain stays in the `models:` registry, and nothing calls it.
 */
function ignoredPaths(text: string): string[] {
  return lowerWithWarnings(parseSpec(text))
    .warnings.filter(
      (w) => w.code === "model-plan-ignored-on-shape" || w.code === "model-plan-ignored-on-slot",
    )
    .map((w) => w.path);
}

describe("the model walk reports every model a harness can call", () => {
  test("the schema's model-bearing leaves are counted, per shape", () => {
    const counts = Object.fromEntries(SHAPES.map((shape) => [shape, schemaLeaves(shape).length]));
    // A new count means a new model-bearing field: cover it in fixturesFor.
    expect(counts).toEqual({
      batch: 12,
      browser: 12,
      channel: 23,
      cli: 24,
      crew: 22,
      eval: 4,
      graph: 15,
      managed: 16,
      onchain: 5,
      "onchain-game": 5,
      pipeline: 11,
      research: 13,
      voice: 5,
      workflow: 15,
    });
  });

  for (const shape of SHAPES) {
    test(`${shape}: the fixtures cover every leaf, and every sentinel in the IR is walked`, () => {
      const fixtures = fixturesFor(shape);
      const uncovered = schemaLeaves(shape).filter(
        (leaf) => !fixtures.some((f) => covers(f, leaf.split("."))),
      );
      expect(uncovered).toEqual([]);
      const placed = new Set<string>();
      const walkedAll = new Set<string>();
      for (const fixture of fixtures) {
        const text = JSON.stringify(fixture);
        for (const m of text.match(SENTINEL_RE) ?? []) placed.add(m);
        const ir = lower(parseSpec(text));
        const walked = new Set(enumerateModelSlots(ir).map((s) => s.model));
        for (const m of walked) walkedAll.add(m);
        // The `models:` registry is provenance only: no emitter reads it, a
        // profile no slot names is called by nothing, and a slot that names
        // one carries its model.
        const { models: _registry, ...served } = ir as unknown as Json;
        const inIr = new Set(JSON.stringify(served).match(SENTINEL_RE) ?? []);
        expect(inIr.size).toBeGreaterThan(0);
        expect([...inIr].filter((m) => !walked.has(m))).toEqual([]);
      }
      // Every sentinel placed reaches a walked slot, except where the compiler
      // says it ignores the field that holds it.
      const idle = new Set([...placed].filter((m) => !walkedAll.has(m)));
      const unexplained: string[] = [];
      let ignored = 0;
      for (const fixture of fixtures) {
        const skipped = ignoredPaths(JSON.stringify(fixture));
        for (const [id, at] of placements(fixture, idle)) {
          if (skipped.some((p) => at === p || at.startsWith(`${p}.`))) ignored += 1;
          else unexplained.push(`${id} at ${at}`);
        }
      }
      expect(unexplained).toEqual([]);
      expect(ignored).toBe(idle.size);
      expect(placed.size - idle.size).toBeGreaterThan(0);
    });
  }

  test("the slots the walk adds are named with their kinds", () => {
    const [fixture] = fixturesFor("cli");
    const slots = enumerateModelSlots(lower(parseSpec(JSON.stringify(fixture))));
    const kinds = (label: string) => slots.filter((s) => s.label === label).map((s) => s.kind);
    expect(kinds("agent.model_pool.strategy.shadow.candidate")).toEqual(["candidate"]);
    expect(kinds("sub_agents.helper.allowed_profiles[0]")).toEqual(["candidate"]);
    expect(kinds("sub_agents.peer.federation.url")).toEqual(["federation"]);
    expect(slots.find((s) => s.kind === "federation")?.model).toBe("https://peer.example.com");
    const defaulted = enumerateModelSlots(
      lower(parseSpec(`${ABSENT_CORPUS.cli}security:\n  justification: { judge: claude }\n`)),
    );
    expect(defaulted.find((s) => s.label === "security.justification.model")).toMatchObject({
      model: JUSTIFICATION_JUDGE_DEFAULT_MODEL,
      kind: "judge",
    });
  });
});
