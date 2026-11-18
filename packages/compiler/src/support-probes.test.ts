/**
 * The support probes against the compiler's own reading of a spec: what
 * `@crewhaus/ir/support`'s `declaredFeatures` finds in a probe spec is what
 * `specDeclares` (the rule every accepted-but-unwired row uses) finds. Plus the
 * one lowering note the first generation asked for: a pool's `cascade` on a
 * shape where nothing escalates to it.
 */
import { describe, expect, test } from "bun:test";
import { SUPPORT_MANIFEST, declaredFeatures } from "@crewhaus/ir/support";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { CORPUS_TODAY } from "./__fixtures__/delta-090/regenerate";
import { ABSENT_CORPUS } from "./absent-corpus";
import { compile, specDeclares } from "./index";
import { FEATURE_PROBES, type FeatureProbe, type ProbePlacement } from "./support-probes";

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `over` laid over `under`, as the generator merges a probe into a spec. */
function merge(under: unknown, over: unknown): unknown {
  if (isMapping(under) && isMapping(over)) {
    const out: Record<string, unknown> = { ...under };
    for (const [k, v] of Object.entries(over)) out[k] = merge(under[k], v);
    return out;
  }
  if (Array.isArray(under) && Array.isArray(over)) {
    const out = [...under];
    over.forEach((v, i) => {
      out[i] = merge(under[i], v);
    });
    return out;
  }
  return over;
}

const placement = (probe: FeatureProbe, shape: string): ProbePlacement =>
  probe.place?.(shape) ?? {
    path: probe.feature,
    snippet: probe.snippet,
    ...(probe.base !== undefined ? { base: probe.base } : {}),
  };

/** The probe's spec on a shape, when it parses there. */
function probeSpec(
  probe: FeatureProbe,
  shape: Spec["target"],
): Record<string, unknown> | undefined {
  const at = placement(probe, shape);
  const corpus = Bun.YAML.parse(ABSENT_CORPUS[shape]);
  const spec = merge(merge(corpus, at.base ?? {}), at.snippet) as Record<string, unknown>;
  try {
    parseSpec(JSON.stringify(spec));
  } catch {
    return undefined;
  }
  return spec;
}

describe("declaredFeatures reads a probe spec as specDeclares does", () => {
  const shapes = Object.keys(ABSENT_CORPUS) as Spec["target"][];
  for (const probe of FEATURE_PROBES) {
    // A feature declared at one fixed path is the case specDeclares reads; a
    // `*` path (a list item's key, as `plugins.*.tools`) is not.
    const at = probe.at ?? [probe.feature];
    const fixed = at.length === 1 && !(at[0] as string).includes("*");
    if (!fixed) continue;
    test(probe.feature, () => {
      let checked = 0;
      for (const shape of shapes) {
        const spec = probeSpec(probe, shape);
        if (spec === undefined) continue;
        const declared = declaredFeatures(spec, SUPPORT_MANIFEST).some(
          (d) => d.feature === probe.feature,
        );
        expect(`${shape}: ${declared}`).toBe(
          `${shape}: ${specDeclares(spec as unknown as Spec, probe.feature)}`,
        );
        expect(declared, shape).toBe(true);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(0);
    });
  }

  test("a spec with none of them declares none, by either reading", () => {
    for (const shape of shapes) {
      const corpus = Bun.YAML.parse(ABSENT_CORPUS[shape]) as Record<string, unknown>;
      const found = declaredFeatures(corpus, SUPPORT_MANIFEST).map((d) => d.feature);
      const declares = FEATURE_PROBES.filter((p) => specDeclares(corpus as never, p.feature)).map(
        (p) => p.feature,
      );
      expect(found.sort(), shape).toEqual(declares.sort());
    }
  });
});

describe("strategy.cascade where nothing escalates to it", () => {
  const POOL = {
    candidates: [
      { model: "claude-haiku-4-5", tags: ["cheap"] },
      { model: "claude-opus-4-8", tags: ["strong"] },
    ],
    strategy: { cascade: { draft: "cheap", escalate_to: "strong" } },
  };
  const at = (shape: Spec["target"]): { path: string; fragment: Record<string, unknown> } => {
    if (shape === "workflow")
      return { path: "steps[0]", fragment: { steps: [{ model_pool: POOL }] } };
    if (shape === "graph") {
      return { path: "nodes.classify", fragment: { nodes: { classify: { model_pool: POOL } } } };
    }
    if (shape === "crew") {
      return { path: "roles.editor", fragment: { roles: { editor: { model_pool: POOL } } } };
    }
    return { path: "agent", fragment: { agent: { model_pool: POOL } } };
  };
  const notes = (shape: Spec["target"]) => {
    const { fragment } = at(shape);
    const spec = merge(Bun.YAML.parse(ABSENT_CORPUS[shape]), fragment);
    return compile(JSON.stringify(spec), { readme: false, today: CORPUS_TODAY })
      .warnings.filter((w) => w.path.endsWith("strategy.cascade"))
      .map((w) => [w.code, w.path]);
  };

  for (const shape of ["pipeline", "crew", "research", "batch", "browser"] as const) {
    test(`${shape} says nothing escalates to it`, () => {
      expect(notes(shape)).toEqual([
        ["model-plan-ignored-on-shape", `${at(shape).path}.model_pool.strategy.cascade`],
      ]);
    });
  }

  for (const shape of ["cli", "workflow", "channel", "graph", "managed"] as const) {
    test(`${shape} has a gate that escalates, and says nothing`, () => {
      expect(notes(shape)).toEqual([]);
    });
  }
});
