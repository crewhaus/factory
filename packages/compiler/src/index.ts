import { assertNever } from "@crewhaus/infra-utils";
import type { Bundle, IrNode, IrPermissions, IrV0, IrWorkflowV0 } from "@crewhaus/ir";
import { type Spec, parseSpec } from "@crewhaus/spec";
import { emitCli } from "@crewhaus/target-cli";
import { emitWorkflow } from "@crewhaus/target-workflow";

/**
 * Compile a YAML spec text into a deployable bundle.
 *
 * Pipeline (slice scope):
 *   parse → validate → lower → emit
 *
 * Future (per catalog F2 compiler-core): pluggable IR passes (dead-tool
 * elimination, profile pruning, prompt-cache prefix sorting), and a
 * bundle-packager step.
 */
export function compile(yamlText: string): Bundle {
  const spec = parseSpec(yamlText);
  const ir = lower(spec);
  return emit(ir);
}

function lowerPermissions(spec: Spec): IrPermissions {
  const p = spec.permissions;
  if (p === undefined) return { rules: [] };
  return {
    mode: p.mode,
    rules: (p.rules ?? []).map((r) => ({ type: r.type, pattern: r.pattern })),
  };
}

export function lower(spec: Spec): IrNode {
  switch (spec.target) {
    case "cli":
      return {
        version: 0,
        name: spec.name,
        target: "cli",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
        },
        tools: spec.tools ?? [],
        permissions: lowerPermissions(spec),
      } satisfies IrV0;
    case "workflow":
      return {
        version: 0,
        name: spec.name,
        target: "workflow",
        steps: spec.steps.map((s) => ({
          name: s.name,
          instructions: s.instructions,
          model: s.model ?? spec.model,
          tools: s.tools ?? [],
        })),
        permissions: lowerPermissions(spec),
      } satisfies IrWorkflowV0;
    default:
      return assertNever(spec);
  }
}

function emit(ir: IrNode): Bundle {
  switch (ir.target) {
    case "cli":
      return emitCli(ir);
    case "workflow":
      return emitWorkflow(ir);
    default:
      return assertNever(ir);
  }
}

export type { Bundle, IrV0, IrWorkflowV0, IrNode } from "@crewhaus/ir";
export { type Spec, parseSpec, SpecParseError } from "@crewhaus/spec";
