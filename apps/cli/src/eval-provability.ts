/**
 * 0.8.0 (design/0.8.0-provability-release.md §9.1, §3; review I39) — the block
 * `crewhaus eval --provability <level>` measures when the spec PARKS its
 * `provability:` block at `level: off`.
 *
 * §3 accepts `level: off` with other keys (an "inert block" warning, never a
 * silent drop): it is how a team writes its allowlist, threshold and
 * `on_fail` before adopting a rung — and §9.1 makes `--provability` the way
 * to "measure the cost of a rung before adopting it". But the compiler lowers
 * a parked block to NO IR block, so the runner's `withProvabilityFloor` would
 * fall back to the shorthand's defaults: threshold 1, `on_fail: retry`, an
 * open `sources` list — a different instrument from the one declared, under a
 * notice that said the spec declared none.
 *
 * So the spec is re-validated with only its level replaced, through
 * `parseSpec` (a hand-patched spec object would skip the cross-field rules a
 * rung brings — `on_fail: escalate` without `agent.model_pool` is fine
 * parked and a parse error at a rung), and that lowered block is the one the
 * runner re-levels. Side-effect-free, so the unit tests drive it directly.
 */
import { lower, provabilityOf } from "@crewhaus/compiler";
import type { IrProvability } from "@crewhaus/ir";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { parse as parseYaml } from "yaml";

/** The rungs `--provability` takes (`off` is refused before this runs). */
export type EvalProvabilityLevel = Exclude<IrProvability["level"], "off">;

/**
 * The lowered block `--provability <level>` should measure for a spec whose
 * object-form block is parked at `level: off`, or undefined when the spec
 * declares no block, the shorthand `provability: off`, or a block that is not
 * parked (the runner re-levels a declared block itself). Throws the spec
 * parser's `SpecParseError` when the parked block does not hold at `level`.
 */
export function parkedProvabilityBlock(
  yamlText: string,
  spec: Spec,
  level: EvalProvabilityLevel,
): IrProvability | undefined {
  const block = (spec as { readonly provability?: unknown }).provability;
  if (typeof block !== "object" || block === null) return undefined;
  if ((block as { readonly level?: unknown }).level !== "off") return undefined;
  const raw = parseYaml(yamlText) as Record<string, unknown>;
  const declared = raw["provability"] as Record<string, unknown>;
  // JSON is YAML: the same document, only the level moved, parsed as any spec is.
  const atLevel = parseSpec(JSON.stringify({ ...raw, provability: { ...declared, level } }));
  return provabilityOf(lower(atLevel));
}
