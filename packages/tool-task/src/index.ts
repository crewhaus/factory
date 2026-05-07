/**
 * Catalog R4 `tool-task` — Section 13.
 *
 * The `Task(description, prompt, subagent_type?)` tool. When invoked, it
 * resolves the named sub-agent definition, builds the child's tool catalog,
 * resolves child permissions, and dispatches `bridge.spawnSubAgent`.
 * Returns the child's final assistant text as the tool result so the parent
 * model can react to the child's verdict.
 *
 * Resolution order for `subagent_type`:
 *   1. `opts.subAgents.get(name)` — inline spec map (codegen-supplied).
 *   2. `<opts.subAgentDir or cwd/.crewhaus/sub-agents>/<name>.md` — frontmatter
 *      file on disk. Format mirrors SKILL.md: leading `---` YAML block, body
 *      becomes `instructions`.
 *   3. Built-in `general-purpose` fallback.
 *
 * Concurrency: marked `concurrencySafe: true` because parallel sub-agents
 * are independent — each gets its own IsolatedContext. T7 in
 * sub-agent-spawner exercises 10-way parallelism end-to-end.
 *
 * The bridge is opaque from `tool-catalog`'s perspective; we cast inside
 * `execute` so ordinary tools (which never touch `ctx.bridge`) keep their
 * unchanged shape. If the bridge is missing the `Task` tool returns a
 * clean error result rather than crashing the turn — that case only
 * occurs when callers wire `Task` into a `runChatLoop` invocation that
 * doesn't pass `spawnSubAgent`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeBridge, SubAgentDefinition } from "@crewhaus/agent-context-isolation";
import { CrewhausError } from "@crewhaus/errors";
import { resolveChildPermissions } from "@crewhaus/sub-agent-permission-inheritance";
import { buildTool } from "@crewhaus/tool-builder";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export class SubAgentResolutionError extends CrewhausError {
  override readonly name = "SubAgentResolutionError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export const BUILTIN_GENERAL_PURPOSE: SubAgentDefinition = {
  name: "general-purpose",
  description:
    "General-purpose sub-agent. Pass it a task and it will use the parent's tools (filtered by inherited permissions) to complete it and return a single summary.",
  instructions:
    "You are a sub-agent invoked by another agent via the Task tool. Complete the user's task using whatever tools you have. When you have an answer, respond with a single concise final message — your reply is what the parent agent will see.",
  // Tools list undefined → child inherits parent's full tool catalog (subject to permissions).
  permissions: "inherit",
};

const taskInputSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe("Short label for the sub-task (e.g. 'review the auth flow')."),
  prompt: z.string().min(1).describe("Full instructions/context the sub-agent should act on."),
  subagent_type: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Name of the sub-agent definition to spawn. Falls back to 'general-purpose' if omitted.",
    ),
});

export type TaskInput = z.infer<typeof taskInputSchema>;

const FRONTMATTER_SCHEMA = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string().min(1)).optional(),
  model: z.string().min(1).optional(),
  permissions: z
    .union([
      z.enum(["inherit", "scoped"]),
      z.object({ allow: z.array(z.string()), deny: z.array(z.string()) }).strict(),
    ])
    .optional(),
  inherit_bypass: z.boolean().optional(),
});

/**
 * Parse a `<dir>/<name>.md` sub-agent file. Same shape as SKILL.md: a
 * leading `---` frontmatter block; the body is the agent instructions.
 */
export function parseSubAgentFile(content: string, fallbackName?: string): SubAgentDefinition {
  const trimmed = content.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) {
    throw new SubAgentResolutionError("sub-agent file must start with `---` frontmatter delimiter");
  }
  const firstNl = trimmed.indexOf("\n");
  if (firstNl === -1) {
    throw new SubAgentResolutionError("sub-agent file frontmatter never terminated");
  }
  const closer = trimmed.indexOf("\n---", firstNl);
  if (closer === -1) {
    throw new SubAgentResolutionError("sub-agent file frontmatter never terminated");
  }
  const fmRaw = trimmed.slice(firstNl + 1, closer).trimEnd();
  const bodyStart = trimmed.indexOf("\n", closer + 4);
  const body = bodyStart === -1 ? "" : trimmed.slice(bodyStart + 1).trim();

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(fmRaw);
  } catch (err) {
    throw new SubAgentResolutionError(
      `sub-agent frontmatter is not valid YAML: ${(err as Error).message}`,
    );
  }
  const parsed = FRONTMATTER_SCHEMA.safeParse(parsedYaml);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const message = issue ? issue.message : "validation failed";
    throw new SubAgentResolutionError(`sub-agent frontmatter ${path}: ${message}`);
  }
  if (body.length === 0) {
    throw new SubAgentResolutionError("sub-agent file has empty body — instructions required");
  }
  const def: SubAgentDefinition = {
    name: parsed.data.name || fallbackName || "(unnamed)",
    description: parsed.data.description,
    instructions: body,
    ...(parsed.data.tools !== undefined ? { tools: parsed.data.tools } : {}),
    ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
    ...(parsed.data.permissions !== undefined ? { permissions: parsed.data.permissions } : {}),
    ...(parsed.data.inherit_bypass !== undefined
      ? { inherit_bypass: parsed.data.inherit_bypass }
      : {}),
  };
  return def;
}

function loadSubAgentFromDisk(name: string, dir: string): SubAgentDefinition | null {
  const filePath = join(dir, `${name}.md`);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, "utf-8");
  return parseSubAgentFile(content, name);
}

export type CreateTaskToolOptions = {
  /** Inline spec-supplied sub-agent definitions (highest priority). */
  readonly subAgents?: ReadonlyMap<string, SubAgentDefinition>;
  /** Filesystem fallback dir. Defaults to `<cwd>/.crewhaus/sub-agents`. */
  readonly subAgentDir?: string;
};

/** Resolve a sub-agent name to a definition using the documented order. */
export function resolveSubAgentDefinition(
  name: string | undefined,
  opts: CreateTaskToolOptions,
): SubAgentDefinition {
  const resolveName = name ?? "general-purpose";
  if (opts.subAgents !== undefined) {
    const inline = opts.subAgents.get(resolveName);
    if (inline !== undefined) return inline;
  }
  const dir = opts.subAgentDir ?? join(process.cwd(), ".crewhaus", "sub-agents");
  const onDisk = loadSubAgentFromDisk(resolveName, dir);
  if (onDisk !== null) return onDisk;
  if (resolveName === "general-purpose") return BUILTIN_GENERAL_PURPOSE;
  throw new SubAgentResolutionError(
    `unknown subagent_type "${resolveName}" — not in spec sub_agents map, not on disk at ${dir}, and no built-in by that name`,
  );
}

/**
 * Build the child catalog by filtering the parent catalog to the
 * tool-name allowlist on the definition. Undefined `def.tools` (with
 * `permissions: "inherit"`) → the child inherits the parent's full
 * catalog. Undefined `def.tools` with any other permission mode → empty
 * child catalog (the user has implicitly opted out).
 */
function buildChildCatalog(
  parentTools: ReadonlyArray<RegisteredTool>,
  def: SubAgentDefinition,
): ReadonlyArray<RegisteredTool> {
  const allowed = def.tools;
  if (allowed === undefined) {
    return def.permissions === undefined || def.permissions === "inherit" ? parentTools : [];
  }
  const allowlist = new Set(allowed);
  return parentTools.filter((t) => allowlist.has(t.name));
}

export function createTaskTool(opts: CreateTaskToolOptions = {}): RegisteredTool {
  const knownNames = opts.subAgents !== undefined ? [...opts.subAgents.keys()] : [];
  const description =
    knownNames.length === 0
      ? "Spawn a sub-agent to handle a delegated task. Pass a `description` (label) and a `prompt` (the task instructions). The sub-agent runs in an isolated context and returns a single final message."
      : `Spawn a sub-agent to handle a delegated task. Pass a \`description\` (label), a \`prompt\` (the task instructions), and optionally a \`subagent_type\` to pick a specialist. Available subagent_type values: ${knownNames.join(", ")}. The sub-agent runs in an isolated context and returns a single final message.`;

  return buildTool({
    name: "Task",
    description,
    inputSchema: taskInputSchema,
    concurrencySafe: true,
    readOnly: false,
    destructive: false,
    execute: async (input, ctx) => {
      const bridge = ctx?.bridge as RuntimeBridge | undefined;
      if (bridge === undefined) {
        return "[Task error] runtime bridge is not available — Task can only be invoked from runChatLoop with sub-agent support enabled.";
      }
      let def: SubAgentDefinition;
      try {
        def = resolveSubAgentDefinition(input.subagent_type, opts);
      } catch (err) {
        return `[Task error] ${(err as Error).message}`;
      }

      const childTools = buildChildCatalog(bridge.tools, def);
      const childPerms = resolveChildPermissions(
        { mode: bridge.permissionMode, rules: bridge.permissionRules },
        def,
      );

      const parentHandle = {
        runContext: bridge.runContext,
        eventLog: bridge.eventLog,
        permissionMode: bridge.permissionMode,
        permissionRules: bridge.permissionRules,
        tools: bridge.tools,
        model: bridge.model,
        maxTokens: bridge.maxTokens,
        ...(bridge.sessionRootDir !== undefined ? { sessionRootDir: bridge.sessionRootDir } : {}),
      };

      const result = await bridge.spawnSubAgent(parentHandle, {
        def,
        prompt: input.prompt,
        permissionMode: childPerms.mode,
        permissionRules: childPerms.rules,
        childTools,
        ...(bridge.sessionRootDir !== undefined ? { sessionRootDir: bridge.sessionRootDir } : {}),
      });

      return result.finalMessage;
    },
  });
}
