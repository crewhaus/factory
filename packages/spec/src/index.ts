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

export const Spec = z.discriminatedUnion("target", [
  cliSchema,
  workflowSchema,
  channelSchema,
  graphSchema,
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
  return result.data;
}
