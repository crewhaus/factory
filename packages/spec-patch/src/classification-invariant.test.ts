/**
 * 0.6.0 plan §10.3 — the verdict table's CLOSING INVARIANT, as a test:
 * "every key introduced in §11.1 appears in exactly one row".
 *
 * The test does not trust a hand-written list of new keys. It walks the zod
 * `Spec` union (every one of the 14 shapes), enumerates every LEAF path under
 * the blocks the 0.6.0 spec delta touched (`models`, `model_pool`,
 * `temperature`, the judge gates, `evaluation.grader` / `on_fail` /
 * `allow_self_judge`, `budget`, `sub_agents`, `mcp_servers.*.tool_flags`, the
 * crew `routing.model`, `observability.slo`), and requires each leaf to be
 * classified EXACTLY ONCE — admitted by `isOptimizable` (the whitelist, with
 * its wildcard and structural rules) XOR matched by a `HUMAN_OWNED_PATHS`
 * row. A leaf that is neither is UNCLASSIFIED (the table drifted behind the
 * schema); a leaf that is both is CLAIMED TWICE (the table contradicts
 * itself). Either fails here, not in a user's optimize run.
 *
 * Anchors deliberately over-approximate the delta: pre-0.6.0 keys inside the
 * same blocks (`model_pool.policy`, `budget.usd`, `evaluation.grader.criteria`)
 * are classified too, which is exactly the 0.3.0 discipline — explicit
 * verdicts rather than the whitelist's default-deny.
 */
import { describe, expect, test } from "bun:test";
import { Spec } from "@crewhaus/spec";
import type { ZodTypeAny } from "zod";
import { STRUCTURAL_SEGMENTS, WILDCARD_SEGMENT, humanOwnedReason, isOptimizable } from "./index";

type Path = ReadonlyArray<string>;

/** Unwrap the zod wrappers that carry no path segment of their own. */
function unwrap(schema: ZodTypeAny): ZodTypeAny {
  let cur: ZodTypeAny = schema;
  while (true) {
    const def = cur._def as {
      typeName?: string;
      innerType?: ZodTypeAny;
      schema?: ZodTypeAny;
      type?: ZodTypeAny;
    };
    switch (def.typeName) {
      case "ZodOptional":
      case "ZodNullable":
      case "ZodDefault":
      case "ZodCatch":
      case "ZodReadonly":
        cur = def.innerType as ZodTypeAny;
        continue;
      case "ZodBranded":
        cur = def.type as ZodTypeAny;
        continue;
      case "ZodEffects":
        cur = def.schema as ZodTypeAny;
        continue;
      case "ZodLazy":
        cur = (cur._def as { getter: () => ZodTypeAny }).getter();
        continue;
      case "ZodPipeline":
        cur = (cur._def as { in: ZodTypeAny }).in;
        continue;
      default:
        return cur;
    }
  }
}

/** Every leaf path of a schema, `"*"` standing for an array index or a record key. */
function leaves(schema: ZodTypeAny, prefix: Path, out: Set<string>, depth = 0): void {
  if (depth > 40) throw new Error(`schema recursion too deep at ${prefix.join(".")}`);
  const s = unwrap(schema);
  const def = s._def as {
    typeName: string;
    shape?: () => Record<string, ZodTypeAny>;
    type?: ZodTypeAny;
    valueType?: ZodTypeAny;
    options?: ZodTypeAny[] | Map<unknown, ZodTypeAny>;
    left?: ZodTypeAny;
    right?: ZodTypeAny;
    items?: ZodTypeAny[];
  };
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, ZodTypeAny>)();
      for (const [key, child] of Object.entries(shape)) {
        leaves(child, [...prefix, key], out, depth + 1);
      }
      return;
    }
    case "ZodArray":
      leaves(def.type as ZodTypeAny, [...prefix, WILDCARD_SEGMENT], out, depth + 1);
      return;
    case "ZodRecord":
      leaves(def.valueType as ZodTypeAny, [...prefix, WILDCARD_SEGMENT], out, depth + 1);
      return;
    case "ZodTuple":
      for (const item of def.items ?? []) {
        leaves(item, [...prefix, WILDCARD_SEGMENT], out, depth + 1);
      }
      return;
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = def.options instanceof Map ? [...def.options.values()] : (def.options ?? []);
      // A union of a scalar and an object (e.g. `use: tag | { requires }`)
      // is a leaf AND a subtree — record both.
      for (const option of options) leaves(option, prefix, out, depth + 1);
      return;
    }
    case "ZodIntersection":
      leaves(def.left as ZodTypeAny, prefix, out, depth + 1);
      leaves(def.right as ZodTypeAny, prefix, out, depth + 1);
      return;
    default:
      if (prefix.length > 0) out.add(prefix.join(" "));
  }
}

/** A leaf is in the 0.6.0 delta when it sits under one of these anchors. */
const ANCHORS: ReadonlyArray<{ readonly at: "root" | "anywhere"; readonly segments: Path }> = [
  { at: "root", segments: ["models"] },
  { at: "anywhere", segments: ["model_pool"] },
  { at: "anywhere", segments: ["temperature"] },
  { at: "root", segments: ["steps", WILDCARD_SEGMENT, "judge"] },
  { at: "root", segments: ["nodes", WILDCARD_SEGMENT, "judge"] },
  { at: "root", segments: ["evaluation", "grader"] },
  { at: "root", segments: ["evaluation", "on_fail"] },
  { at: "root", segments: ["evaluation", "allow_self_judge"] },
  { at: "root", segments: ["budget"] },
  { at: "anywhere", segments: ["sub_agents"] },
  // §11.1 "graph nodes NEW": the pre-pool routing blocks land on `nodes.<n>`
  // (and `sub_agents.<n>`) in 0.6.0. Anchored ANYWHERE so the same verdict is
  // stated once for every positional host (`steps[i]`, `roles.<r>`) and for
  // `agent` — the `["nodes"]` / `["steps"]` / `["roles"]` whole-block entries
  // reached these by prefix until the structural rule named them.
  { at: "anywhere", segments: ["model_tiers"] },
  { at: "anywhere", segments: ["model_fallbacks"] },
  { at: "anywhere", segments: ["circuit_breaker"] },
  { at: "root", segments: ["mcp_servers", WILDCARD_SEGMENT, "tool_flags"] },
  { at: "root", segments: ["routing", "model"] },
  { at: "root", segments: ["observability", "slo"] },
];

function matchesAt(path: Path, segments: Path, start: number): boolean {
  if (start + segments.length > path.length) return false;
  return segments.every((seg, i) => seg === WILDCARD_SEGMENT || seg === path[start + i]);
}

function inDelta(path: Path): boolean {
  return ANCHORS.some((anchor) =>
    anchor.at === "root"
      ? matchesAt(path, anchor.segments, 0)
      : path.some((_, i) => matchesAt(path, anchor.segments, i)),
  );
}

/** Substitute a concrete key for every wildcard so the matcher sees a real patch path. */
function concrete(path: Path): string[] {
  return path.map((seg, i) => (seg === WILDCARD_SEGMENT ? `k${i}` : seg));
}

/**
 * A LEAF is optimizer-reachable when the optimizer can write it: either the
 * leaf path itself is admitted, or a whitelisted ANCESTOR block can be
 * replaced wholesale and the tail from that ancestor to the leaf crosses no
 * structural segment. The second clause is how `["agent","model_pool","routing"]`
 * (exact, whitelisted wholesale) reaches `routing.strongTag`, and why
 * `["steps"]` does NOT reach `steps[i].model_pool.candidates[j].model` — the
 * structural rule stops whole-block reach at the `model_pool` boundary, which
 * is exactly the leak §10.3 closes.
 */
function reachable(target: Spec["target"], path: Path): boolean {
  const real = concrete(path);
  for (let len = real.length; len >= 1; len--) {
    const tail = real.slice(len);
    if (tail.some((seg) => STRUCTURAL_SEGMENTS.includes(seg))) break;
    if (isOptimizable(target, real.slice(0, len))) return true;
  }
  return false;
}

function targetOf(shape: ZodTypeAny): Spec["target"] {
  const fields = (unwrap(shape)._def as { shape: () => Record<string, ZodTypeAny> }).shape();
  const literal = unwrap(fields["target"] as ZodTypeAny);
  return (literal._def as { value: Spec["target"] }).value;
}

describe("§10.3 closing invariant — every 0.6.0 spec leaf is classified exactly once", () => {
  const shapes = Spec.options as ReadonlyArray<ZodTypeAny>;

  test("the walk sees all 14 shapes and a healthy number of delta leaves", () => {
    expect(shapes.length).toBe(14);
    const all = new Set<string>();
    for (const shape of shapes) leaves(shape, [], all);
    const delta = [...all].map((k) => k.split(" ")).filter(inDelta);
    // The delta is large (every profile field on every host); a collapse here
    // means the walker stopped descending, which would make the invariant vacuous.
    expect(delta.length).toBeGreaterThan(300);
    const joined = new Set(delta.map((p) => p.join(".")));
    expect(joined.has("models.*.max_tokens")).toBe(true);
    expect(joined.has("agent.model_pool.rules.*.enabled")).toBe(true);
    expect(joined.has("steps.*.judge.escalate_to")).toBe(true);
    expect(joined.has("observability.slo.floor_block_rate")).toBe(true);
    expect(joined.has("nodes.*.circuit_breaker.failureThreshold")).toBe(true);
    expect(joined.has("nodes.*.model_tiers.fast")).toBe(true);
    expect(joined.has("nodes.*.model_fallbacks.*")).toBe(true);
  });

  for (const shape of shapes) {
    const target = targetOf(shape);
    test(`${target}: no delta leaf is unclassified, none is claimed twice`, () => {
      const all = new Set<string>();
      leaves(shape, [], all);
      const unclassified: string[] = [];
      const twice: string[] = [];
      for (const key of all) {
        const path = key.split(" ");
        if (!inDelta(path)) continue;
        const optimizable = reachable(target, path);
        const excluded = humanOwnedReason(concrete(path)) !== undefined;
        if (optimizable && excluded) twice.push(path.join("."));
        if (!optimizable && !excluded) unclassified.push(path.join("."));
      }
      expect(unclassified, "UNCLASSIFIED — add a whitelist entry or an exclusion row").toEqual([]);
      expect(twice, "CLAIMED TWICE — a whitelist entry and an exclusion row both match").toEqual(
        [],
      );
    });
  }

  test("the anchors are real: each names at least one leaf on some shape", () => {
    const all = new Set<string>();
    for (const shape of shapes) leaves(shape, [], all);
    const paths = [...all].map((k) => k.split(" "));
    for (const anchor of ANCHORS) {
      const hit = paths.some((path) =>
        anchor.at === "root"
          ? matchesAt(path, anchor.segments, 0)
          : path.some((_, i) => matchesAt(path, anchor.segments, i)),
      );
      expect(hit, `anchor [${anchor.segments.join(", ")}] names no leaf — stale`).toBe(true);
    }
  });
});
