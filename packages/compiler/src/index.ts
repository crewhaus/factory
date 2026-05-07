import { assertNever } from "@crewhaus/infra-utils";
import type {
  Bundle,
  IrMcpServerConfig,
  IrMcpServers,
  IrNode,
  IrPermissions,
  IrV0,
  IrWorkflowV0,
} from "@crewhaus/ir";
import { type Spec, type SpecMcpServerConfig, parseSpec } from "@crewhaus/spec";
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

/**
 * Normalise mcp_servers from spec (where args/env/headers are optional) to
 * IR (where args is a required readonly array — env/headers stay optional).
 * The shape is otherwise identical so target codegen can JSON-stringify
 * the IR config directly into the emitted bundle.
 */
function lowerMcpServers(specMcp: Record<string, SpecMcpServerConfig> | undefined): IrMcpServers {
  if (specMcp === undefined) return Object.freeze({}) as IrMcpServers;
  const out: Record<string, IrMcpServerConfig> = {};
  for (const [name, cfg] of Object.entries(specMcp)) {
    if (cfg.transport === "stdio") {
      out[name] = {
        transport: "stdio",
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.env !== undefined ? { env: cfg.env } : {}),
      };
    } else {
      out[name] = {
        transport: "sse",
        url: cfg.url,
        ...(cfg.headers !== undefined ? { headers: cfg.headers } : {}),
      };
    }
  }
  return Object.freeze(out) as IrMcpServers;
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
        mcp_servers: lowerMcpServers(spec.mcp_servers),
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
        mcp_servers: lowerMcpServers(spec.mcp_servers),
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
