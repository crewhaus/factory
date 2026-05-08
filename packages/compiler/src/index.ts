import { assertNever } from "@crewhaus/infra-utils";
import type {
  Bundle,
  IrChannelV0,
  IrChannels,
  IrCompaction,
  IrCrewRole,
  IrCrewV0,
  IrGraphV0,
  IrManagedV0,
  IrMcpServerConfig,
  IrMcpServers,
  IrNode,
  IrPermissions,
  IrPipelineV0,
  IrResearchV0,
  IrSecretRef,
  IrSlackConfig,
  IrSubAgentDefinition,
  IrV0,
  IrWorkflowV0,
} from "@crewhaus/ir";
import {
  type Spec,
  type SpecChannel,
  type SpecCrewRole,
  type SpecMcpServerConfig,
  type SpecSlackChannel,
  type SpecSubAgentDefinition,
  parseSpec,
} from "@crewhaus/spec";
import { emitChannelBot } from "@crewhaus/target-channel-bot";
import { emitCli } from "@crewhaus/target-cli";
import { emitCrew } from "@crewhaus/target-crew";
import { emitGraph } from "@crewhaus/target-graph";
import { emitManaged } from "@crewhaus/target-managed";
import { emitPipeline } from "@crewhaus/target-pipeline";
import { emitResearchBundle } from "@crewhaus/target-research-bundle";
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

/**
 * Section 13 — convert a spec sub_agents map to a deterministic IR array.
 * The map key becomes the `name` field. Defaults applied at lower-time:
 *   - permissions ?? "inherit"
 *   - inherit_bypass ?? false
 *   - tools ?? []  (codegen treats "no tools" as "no allowed tools" when
 *                   permissions !== "inherit"; tool-task itself encodes
 *                   the same fallback for runtime resolution.)
 */
function lowerSubAgents(
  map: Record<string, SpecSubAgentDefinition> | undefined,
): IrSubAgentDefinition[] {
  if (map === undefined) return [];
  // Stable order: sort by name so generated bundles diff cleanly.
  const entries = Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([name, def]) => ({
    name,
    description: def.description,
    instructions: def.instructions,
    tools: def.tools ?? [],
    ...(def.model !== undefined ? { model: def.model } : {}),
    permissions: def.permissions ?? "inherit",
    inheritBypass: def.inherit_bypass ?? false,
  }));
}

/**
 * Section 14 — freeze a spec `tool_config` map into the IR shape. Empty
 * default (`{}`) so codegen never needs `?? {}` guards.
 */
function lowerToolConfigs(
  raw: Record<string, unknown> | undefined,
): Readonly<Record<string, unknown>> {
  if (raw === undefined) return Object.freeze({});
  return Object.freeze({ ...raw });
}

/**
 * Section 17 — normalise the optional `compaction` block. Always produce
 * an object so codegen can read `ir.compaction.model` safely. When the
 * spec omits the block entirely, the IR carries an empty object — runtime
 * resolves to "use the agent's primary model" in that case.
 */
function lowerCompaction(spec: Spec): IrCompaction {
  const c = spec.compaction;
  if (c === undefined) return {};
  return c.model !== undefined ? { model: c.model } : {};
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
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents),
        compaction: lowerCompaction(spec),
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
          toolConfigs: lowerToolConfigs(s.tool_config),
        })),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
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
        toolConfigs: lowerToolConfigs(spec.agent.tool_config),
        channels: lowerChannels(spec.channels),
        routing: { sessionKey: spec.routing.sessionKey },
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        subAgents: lowerSubAgents(spec.agent.sub_agents),
        compaction: lowerCompaction(spec),
      } satisfies IrChannelV0;
    case "graph":
      return {
        version: 0,
        name: spec.name,
        target: "graph",
        entry: spec.entry,
        // Preserve YAML insertion order — nodes appear in the bundle in
        // the same order the spec author wrote them.
        nodes: Object.entries(spec.nodes).map(([name, node]) => ({
          name,
          instructions: node.instructions,
          model: node.model ?? spec.model,
          tools: node.tools ?? [],
          toolConfigs: lowerToolConfigs(node.tool_config),
          ...(node.hitl !== undefined ? { hitlPrompt: node.hitl.prompt } : {}),
        })),
        edges: spec.edges.map((e) => ({ from: e.from, to: e.to })),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
      } satisfies IrGraphV0;
    case "managed":
      return {
        version: 0,
        name: spec.name,
        target: "managed",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
        tenants: spec.tenants.map((t) => ({
          id: t.id,
          budget: {
            maxInputTokens: t.budget.maxInputTokens,
            maxOutputTokens: t.budget.maxOutputTokens,
          },
        })),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
      } satisfies IrManagedV0;
    case "pipeline":
      return {
        version: 0,
        name: spec.name,
        target: "pipeline",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
        retrieve: {
          embedderModel: spec.retrieve.embedderModel,
          vectorBackend: spec.retrieve.vectorBackend,
          defaultK: spec.retrieve.defaultK,
        },
        indexing: {
          chunkStrategy: spec.indexing.chunkStrategy,
          chunkSize: spec.indexing.chunkSize,
          chunkOverlap: spec.indexing.chunkOverlap,
          documents: spec.indexing.documents.map((d) => ({
            id: d.id,
            text: d.text,
            ...(d.metadata !== undefined ? { metadata: d.metadata } : {}),
          })),
        },
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
      } satisfies IrPipelineV0;
    case "crew":
      return {
        version: 0,
        name: spec.name,
        target: "crew",
        entry: spec.entry,
        // Stable order: sort by role name so generated bundles diff cleanly.
        roles: Object.entries(spec.roles)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, role]) => lowerCrewRole(name, role, spec.model)),
        ...(spec.routing !== undefined
          ? {
              routing: {
                kind: spec.routing.kind,
                ...(spec.routing.match !== undefined ? { match: spec.routing.match } : {}),
              },
            }
          : {}),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
      } satisfies IrCrewV0;
    case "research":
      return {
        version: 0,
        name: spec.name,
        target: "research",
        agent: { model: spec.agent.model, instructions: spec.agent.instructions },
        goal: spec.goal,
        branchingFactor: spec.branchingFactor,
        maxDurationMs: spec.maxDurationMs,
        retrieve: {
          allowedOrigins: [...spec.retrieve.allowedOrigins],
          allowedFileRoots: [...spec.retrieve.allowedFileRoots],
          ...(spec.retrieve.vectorBackend !== undefined
            ? { vectorBackend: spec.retrieve.vectorBackend }
            : {}),
        },
        tools: spec.tools ?? [],
        toolConfigs: lowerToolConfigs(spec.tool_config),
        mcp_servers: lowerMcpServers(spec.mcp_servers),
        permissions: lowerPermissions(spec),
        compaction: lowerCompaction(spec),
      } satisfies IrResearchV0;
    default:
      return assertNever(spec);
  }
}

function lowerCrewRole(name: string, role: SpecCrewRole, fallbackModel: string): IrCrewRole {
  return {
    name,
    model: role.model ?? fallbackModel,
    instructions: role.instructions,
    tools: role.tools ?? [],
    toolConfigs: lowerToolConfigs(role.tool_config),
    subAgents: lowerSubAgents(role.sub_agents),
  };
}

function emit(ir: IrNode): Bundle {
  switch (ir.target) {
    case "cli":
      return emitCli(ir);
    case "workflow":
      return emitWorkflow(ir);
    case "channel":
      return emitChannelBot(ir);
    case "graph":
      return emitGraph(ir);
    case "managed":
      return emitManaged(ir);
    case "pipeline":
      return emitPipeline(ir);
    case "crew":
      return emitCrew(ir);
    case "research":
      return emitResearchBundle(ir);
    default:
      return assertNever(ir);
  }
}

export type { Bundle, IrV0, IrWorkflowV0, IrChannelV0, IrNode } from "@crewhaus/ir";
export { type Spec, parseSpec, SpecParseError } from "@crewhaus/spec";
