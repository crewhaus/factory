import { SpecParseError } from "@crewhaus/errors";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * v0 spec schema — a discriminated union over `target`.
 *
 * - `cli`: a single streaming-chat agent (Section 1–5).
 * - `workflow`: a sequence of named steps run in order, threading the prior
 *   step's final assistant text into the next step's user message (Section 6).
 * - `channel`: a long-running daemon that listens for inbound channel events
 *   (Slack today, more channels later) and runs one agent turn per inbound
 *   message, threaded by the routing key. Section 12.
 *
 * Will grow into the full catalog spec (eval, deploy) — see
 * docs/MODULE-CATALOG.md PART A Layer F1.
 */

// Permissions block (Section 7). SECURITY: `mode: "bypass"` is intentionally
// absent from the enum — bypass can only enter the system via the CLI flag.
// Defense in depth: parse-time and runtime checks both reject it.
const permissionRuleSchema = z
  .object({
    type: z.enum(["alwaysAllow", "alwaysDeny", "alwaysAsk"]),
    pattern: z.string().min(1),
  })
  .strict();

const permissionsBlock = z
  .object({
    mode: z.enum(["default", "plan", "auto"]).optional(),
    rules: z.array(permissionRuleSchema).optional(),
  })
  .strict()
  .optional();

// MCP servers block (Section 9). Discriminated on `transport` so unknown
// configs surface as a clear "Invalid literal value" error rather than a
// confusing union-of-rejections.
const stdioMcpConfig = z
  .object({
    transport: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .strict();

const sseMcpConfig = z
  .object({
    transport: z.literal("sse"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

const mcpServerConfigSchema = z.discriminatedUnion("transport", [stdioMcpConfig, sseMcpConfig]);

const mcpServersBlock = z.record(z.string().min(1), mcpServerConfigSchema).optional();

// Section 13 — sub-agent definitions. Inline on the agent block (cli +
// channel today; workflow has no agent block). The map's key is the
// `subagent_type` users pass to the Task tool. Permissions field mirrors
// the runtime's resolution shape.
const subAgentDefinitionSchema = z
  .object({
    description: z.string().min(1),
    instructions: z.string().min(1),
    tools: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    permissions: z
      .union([
        z.enum(["inherit", "scoped"]),
        z
          .object({
            allow: z.array(z.string().min(1)),
            deny: z.array(z.string().min(1)),
          })
          .strict(),
      ])
      .optional(),
    inherit_bypass: z.boolean().optional(),
  })
  .strict();

const subAgentsBlock = z.record(z.string().min(1), subAgentDefinitionSchema).optional();

/**
 * Section 14 — per-tool runtime config map. Tool-specific schemas live
 * inside each tool package; the spec layer treats every value as opaque
 * `unknown` and forwards it verbatim to the IR. The codegen layer emits
 * an init call (e.g. `registerFetchConfig({ ... })`) for tools whose
 * BUILTIN_TOOL_MAP entry declares an `initSymbol`.
 */
const toolConfigBlock = z.record(z.string().min(1), z.unknown()).optional();

/**
 * Section 17 — optional override for the model used by
 * `compaction-autocompact` when summarising long conversations. Defaults
 * to the agent's primary model when omitted, but you can target a
 * cheaper/faster model (or a different provider) for compaction.
 */
const compactionBlock = z
  .object({
    model: z.string().min(1).optional(),
  })
  .strict()
  .optional();

const cliSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("cli"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
        sub_agents: subAgentsBlock,
      })
      .strict(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

const workflowStepSchema = z
  .object({
    name: z.string().min(1),
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
  })
  .strict();

const workflowSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("workflow"),
    model: z.string().min(1),
    steps: z.array(workflowStepSchema).min(1),
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

// Channel target (Section 12). Secret fields (botToken/signingSecret/appToken)
// are kept as plain strings here; the compiler's `lower()` rewrites strings
// matching `$VAR_NAME` into env-var references in the IR so the compiled
// bundle reads `process.env.VAR_NAME` at runtime instead of embedding secrets.
const slackChannelSchema = z
  .object({
    botToken: z.string().min(1),
    signingSecret: z.string().min(1),
    appToken: z.string().min(1).optional(),
  })
  .strict();

const channelsBlock = z
  .object({
    slack: slackChannelSchema.optional(),
  })
  .strict()
  .refine((c) => c.slack !== undefined, {
    message: "channels block requires at least one channel (slack)",
  });

const routingBlock = z
  .object({
    sessionKey: z.enum(["thread", "user", "channel"]),
  })
  .strict();

const channelAgentSchema = z
  .object({
    model: z.string().min(1),
    instructions: z.string().min(1),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    sub_agents: subAgentsBlock,
  })
  .strict();

const channelSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("channel"),
    agent: channelAgentSchema,
    channels: channelsBlock,
    routing: routingBlock,
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

// Graph target (Section 19) — stateful DAG runtime. Nodes are LLM-backed
// invocations; edges link nodes; HITL pauses interrupt the run on
// `requestApproval()`. Each node may have its own model + tools.
const graphNodeSchema = z
  .object({
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    /**
     * When true, the node calls `ctx.requestApproval(prompt)` before
     * returning. The engine pauses, persists a checkpoint, and waits for
     * `resume(checkpointId, decision)` from the operator/CLI.
     */
    hitl: z
      .object({
        prompt: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const graphEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

const graphSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("graph"),
    model: z.string().min(1),
    entry: z.string().min(1),
    nodes: z.record(z.string().min(1), graphNodeSchema),
    edges: z.array(graphEdgeSchema).default([]),
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

// Managed daemon target (Section 20). Multi-tenant gateway with
// per-tenant budgets + policy overrides; emitted bundle is daemon.ts +
// agent.ts. Authentication is HS256 JWT — the signing secret enters
// via env at boot, not via the spec.
const managedTenantSchema = z
  .object({
    id: z.string().min(1),
    budget: z
      .object({
        maxInputTokens: z.number().int().positive(),
        maxOutputTokens: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const managedAgentSchema = z
  .object({
    model: z.string().min(1),
    instructions: z.string().min(1),
  })
  .strict();

const managedSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("managed"),
    agent: managedAgentSchema,
    tenants: z.array(managedTenantSchema).min(1),
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

// Pipeline / RAG target (Section 21). Carries the embedder + vector-store
// config, an indexing pipeline, and a chat agent that uses Retrieve.
const pipelineDocumentSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const pipelineSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("pipeline"),
    agent: z
      .object({
        model: z.string().min(1),
        instructions: z.string().min(1),
      })
      .strict(),
    retrieve: z
      .object({
        embedderModel: z.string().min(1),
        vectorBackend: z.enum(["in-memory"]).default("in-memory"),
        defaultK: z.number().int().positive().max(50).default(5),
      })
      .strict(),
    indexing: z
      .object({
        chunkStrategy: z.enum(["fixed", "semantic", "markdown"]).default("fixed"),
        chunkSize: z.number().int().positive().default(400),
        chunkOverlap: z.number().int().nonnegative().default(0),
        documents: z.array(pipelineDocumentSchema).min(1),
      })
      .strict(),
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();

// Crew target (Section 22). Multi-role agent runtime; each role is an
// `agent`-shaped block (model + instructions + tools); `entry` names the
// first-active role; optional `routing` block carries either `match`
// rules or `llm` directive (lower-time placeholder for an LLM-backed
// router; runtime falls back to "no router" when the target shape lands
// on the codegen path).
const crewRoleSchema = z
  .object({
    instructions: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    tool_config: toolConfigBlock,
    sub_agents: subAgentsBlock,
  })
  .strict();

const crewRoutingMatchEntrySchema = z
  .object({
    contains: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

const crewRoutingSchema = z
  .object({
    kind: z.enum(["match", "llm"]),
    match: z.record(z.string().min(1), z.array(crewRoutingMatchEntrySchema).min(1)).optional(),
  })
  .strict();

const crewSchema = z
  .object({
    name: z.string().min(1),
    target: z.literal("crew"),
    /** Crew-wide model fallback used by any role that omits `role.model`. */
    model: z.string().min(1),
    entry: z.string().min(1),
    roles: z.record(z.string().min(1), crewRoleSchema),
    routing: crewRoutingSchema.optional(),
    mcp_servers: mcpServersBlock,
    permissions: permissionsBlock,
    compaction: compactionBlock,
  })
  .strict();
// `.refine()` on a discriminatedUnion member would change the type from
// ZodObject to ZodEffects (incompatible with the union); the
// "entry-in-roles" + "non-empty roles" cross-field checks live in
// `parseSpec` below as a post-parse pass.

export const Spec = z.discriminatedUnion("target", [
  cliSchema,
  workflowSchema,
  channelSchema,
  graphSchema,
  managedSchema,
  pipelineSchema,
  crewSchema,
]);

export type Spec = z.infer<typeof Spec>;
export type SpecCli = z.infer<typeof cliSchema>;
export type SpecWorkflow = z.infer<typeof workflowSchema>;
export type SpecWorkflowStep = z.infer<typeof workflowStepSchema>;
export type SpecChannel = z.infer<typeof channelSchema>;
export type SpecChannelAgent = z.infer<typeof channelAgentSchema>;
export type SpecSlackChannel = z.infer<typeof slackChannelSchema>;
export type SpecGraph = z.infer<typeof graphSchema>;
export type SpecGraphNode = z.infer<typeof graphNodeSchema>;
export type SpecGraphEdge = z.infer<typeof graphEdgeSchema>;
export type SpecManaged = z.infer<typeof managedSchema>;
export type SpecManagedTenant = z.infer<typeof managedTenantSchema>;
export type SpecPipeline = z.infer<typeof pipelineSchema>;
export type SpecPipelineDocument = z.infer<typeof pipelineDocumentSchema>;
export type SpecCrew = z.infer<typeof crewSchema>;
export type SpecCrewRole = z.infer<typeof crewRoleSchema>;
export type SpecCrewRouting = z.infer<typeof crewRoutingSchema>;
export type SpecMcpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type SpecSubAgentDefinition = z.infer<typeof subAgentDefinitionSchema>;
export type SpecCompactionBlock = z.infer<typeof compactionBlock>;

export { SpecParseError };

export function parseSpec(yamlText: string): Spec {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new SpecParseError("invalid YAML", err);
  }

  // Friendly early-rejection for `permissions.mode: bypass` so the error
  // message names the actual security policy rather than a Zod enum mismatch.
  // The Zod schema also excludes "bypass" from its enum (defense in depth).
  if (typeof raw === "object" && raw !== null && "permissions" in raw) {
    const perms = (raw as { permissions?: unknown }).permissions;
    if (typeof perms === "object" && perms !== null && "mode" in perms) {
      const mode = (perms as { mode?: unknown }).mode;
      if (mode === "bypass") {
        throw new SpecParseError(
          "permissions.mode: bypass is rejected — bypass mode is only available via the --permission-mode CLI flag, never from a spec file",
        );
      }
    }
  }

  const result = Spec.safeParse(raw);
  if (!result.success) {
    throw new SpecParseError(
      `spec validation failed:\n${result.error.issues
        .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n")}`,
      result.error,
    );
  }
  // Section 22 — crew cross-field invariants. Kept here rather than as
  // `.refine()`s on the schema so the discriminated-union member stays
  // a plain ZodObject (Zod's discriminatedUnion rejects ZodEffects).
  const data = result.data;
  if (data.target === "crew") {
    const roleNames = Object.keys(data.roles);
    if (roleNames.length === 0) {
      throw new SpecParseError("crew target requires at least one role");
    }
    if (!roleNames.includes(data.entry)) {
      throw new SpecParseError(
        `crew.entry "${data.entry}" must name one of crew.roles (got: ${roleNames.join(", ")})`,
      );
    }
    if (data.routing !== undefined && data.routing.kind === "match" && data.routing.match) {
      for (const [from, rules] of Object.entries(data.routing.match)) {
        if (!roleNames.includes(from)) {
          throw new SpecParseError(`crew.routing.match["${from}"]: source role not in crew.roles`);
        }
        for (const rule of rules) {
          if (!roleNames.includes(rule.to)) {
            throw new SpecParseError(
              `crew.routing.match["${from}"].to = "${rule.to}" — target role not in crew.roles`,
            );
          }
        }
      }
    }
  }
  return data;
}
