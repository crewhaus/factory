import { assertNever } from "@crewhaus/infra-utils";
import type { Bundle, IrV0 } from "@crewhaus/ir";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { emitCli } from "@crewhaus/target-cli";

/**
 * Compile a YAML spec text into a deployable bundle.
 *
 * Pipeline (slice scope):
 *   parse → validate → lower → emit
 *
 * Future (per catalog F2 compiler-core): pluggable IR passes (dead-tool
 * elimination, profile pruning, prompt-cache prefix sorting), multi-target
 * dispatch, and a bundle-packager step.
 */
export function compile(yamlText: string): Bundle {
  const spec = parseSpec(yamlText);
  const ir = lower(spec);
  return emit(ir);
}

function lower(spec: Spec): IrV0 {
  return {
    version: 0,
    name: spec.name,
    target: spec.target,
    agent: {
      model: spec.agent.model,
      instructions: spec.agent.instructions,
    },
    tools: spec.tools ?? [],
  };
}

function emit(ir: IrV0): Bundle {
  switch (ir.target) {
    case "cli":
      return emitCli(ir);
    default:
      return assertNever(ir.target);
  }
}

export type { Bundle, IrV0 } from "@crewhaus/ir";
export { type Spec, parseSpec, SpecParseError } from "@crewhaus/spec";
