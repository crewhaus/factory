import { assertNever } from "@crewhaus/infra-utils";
import type {
  Bundle,
  IrChannelV0,
  IrChannels,
  IrMcpServerConfig,
  IrMcpServers,
  IrNode,
  IrPermissions,
  IrSecretRef,
  IrSlackConfig,
  IrV0,
  IrWorkflowV0,
} from "@crewhaus/ir";
import {
  type Spec,
  type SpecChannel,
  type SpecMcpServerConfig,
  type SpecSlackChannel,
  parseSpec,
} from "@crewhaus/spec";
import { emitChannelBot } from "@crewhaus/target-channel-bot";
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

/**
 * Section 12 — convert a spec secret string into an IrSecretRef. Strings of
 * the form `$VAR_NAME` (where VAR_NAME matches `[A-Z_][A-Z0-9_]*`) become
 * env-var references; everything else is treated as a literal. Done at
 * lower-time, NOT spec-parse-time, so the env lookup happens in the
 * compiled bundle's `process.env` at runtime — keeping real secrets out
 * of compiled artifacts checked into git.
 */
const ENV_REF_RE = /^\$([A-Z_][A-Z0-9_]*)$/;
function lowerSecret(raw: string): IrSecretRef {
  const m = raw.match(ENV_REF_RE);
  if (m && typeof m[1] === "string") {
    return { kind: "env", name: m[1] };
  }
  return { kind: "literal", value: raw };
}

function lowerSlack(slack: SpecSlackChannel): IrSlackConfig {
  return {
    botToken: lowerSecret(slack.botToken),
    signingSecret: lowerSecret(slack.signingSecret),
    ...(slack.appToken !== undefined ? { appToken: lowerSecret(slack.appToken) } : {}),
  };
}

function lowerChannels(channels: SpecChannel["channels"]): IrChannels {
  return {
    ...(channels.slack !== undefined ? { slack: lowerSlack(channels.slack) } : {}),
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
    case "channel":
      return {
        version: 0,
        name: spec.name,
        target: "channel",
        agent: {
          model: spec.agent.model,
          instructions: spec.agent.instructions,
        },
        tools: spec.agent.tools ?? [],
        channels: lowerChannels(spec.channels),
        routing: { sessionKey: spec.routing.sessionKey },
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
      } satisfies IrChannelV0;
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
    case "channel":
      return emitChannelBot(ir);
    default:
      return assertNever(ir);
  }
}

export type { Bundle, IrV0, IrWorkflowV0, IrChannelV0, IrNode } from "@crewhaus/ir";
export { type Spec, parseSpec, SpecParseError } from "@crewhaus/spec";
