/**
 * Catalog R4 `tool-task` — Section 13.
 *
 * The `Task(description, prompt, subagent_type?, profile?)` tool. When
 * invoked, it resolves the named sub-agent definition, builds the child's tool
 * catalog, resolves child permissions, validates the optional `profile`
 * against the definition's allowlist (0.6.0 §7.7 — a model-filled model
 * argument that can never name a model outside the spec), and dispatches
 * `bridge.spawnSubAgent` with the ONE shared `projectParentHandle(bridge)`
 * projection. Returns the child's final assistant text as the tool result so
 * the parent model can react to the child's verdict.
 *
 * Resolution order for `subagent_type`:
 *   1. `opts.subAgents.get(name)` — inline spec map (codegen-supplied).
 *   2. `<opts.subAgentDir or cwd/.crewhaus/sub-agents>/<name>.md` — frontmatter
 *      file on disk. Format mirrors SKILL.md: leading `---` YAML block, body
 *      becomes `instructions`.
 *   3. Built-in `general-purpose` fallback.
 *
 * Concurrency: a Task dispatch runs in parallel with its siblings ONLY
 * when the specific sub-agent it spawns is itself entirely read-only —
 * that per-call decision can't be a static flag, so Task stays statically
 * `readOnly: false` (never eligible by flags) and supplies a
 * `concurrencyClassifier` that opts a call back in iff the resolved
 * sub-agent's whole effective tool catalog is read-only + concurrency-safe
 * + non-destructive. Each eligible spawn gets its own IsolatedContext
 * (fresh crypto-random sessionId/runId, own event log), and the parent's
 * append-only log serialises writes at the syscall, so concurrent spawns
 * don't collide. A child that can write/edit/bash, spawn its own Task, or
 * touch module-level tool state (TodoWrite, Remember) is excluded and
 * serialises. The runtime bounds how many run at once (see
 * `runChatLoop({ maxConcurrentTools })`, default 4).
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
import {
  type RuntimeBridge,
  type SubAgentDefinition,
  type SubAgentFailure,
  type SubAgentProfileOption,
  projectParentHandle,
  subAgentProfileAllowlist,
} from "@crewhaus/agent-context-isolation";
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

/**
 * v0.3.0 §7.1 — a NON-fatal classified child failure, rethrown by the Task
 * tool so `tool-executor` surfaces it as an `is_error: true` tool result
 * whose content is the structured `{isError, failureClass, report}` JSON —
 * the parent model sees an honest, classified failure instead of a bare
 * `[sub-agent error]` string. Fatal classes (billing/auth) never reach
 * here: the spawner rethrows `RunFailedError`, which tool-executor lets
 * propagate so the whole run halts with the child's report.
 */
export class SubAgentFailedError extends CrewhausError {
  override readonly name = "SubAgentFailedError";
  readonly failure: SubAgentFailure;
  constructor(failure: SubAgentFailure) {
    super(
      "tool",
      JSON.stringify({ isError: true, failureClass: failure.failureClass, report: failure.report }),
    );
    this.failure = failure;
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
  // 0.6.0 §7.7 — a model-filled MODEL argument. Validated in `execute` against
  // the definition's allowlist (`allowed_profiles`, else the child's own
  // model/profile) — never resolved, never passed through: it can only ever
  // name a model the spec already declared for that child (§10.1).
  profile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Model profile to run the sub-agent on. Must be one of the sub-agent's allowed profiles; omit to use its default model.",
    ),
});

export type TaskInput = z.infer<typeof taskInputSchema>;

/** Frontmatter mirror of a `thinking` block (spec grammar: exactly one of the two). */
const FRONTMATTER_THINKING = z.union([
  z.object({ budget_tokens: z.number().int().min(1024) }).strict(),
  z.object({ effort: z.enum(["low", "medium", "high"]) }).strict(),
]);
const FRONTMATTER_CIRCUIT_BREAKER = z
  .object({
    failureThreshold: z.number().int().positive().optional(),
    windowMs: z.number().int().positive().optional(),
    cooldownMs: z.number().int().positive().optional(),
  })
  .strict();
const FRONTMATTER_TIER_ROUTING = z
  .object({
    contextTokenThreshold: z.number().int().positive().optional(),
    toolsToDefault: z.boolean().optional(),
    firstTurnToDefault: z.boolean().optional(),
    priorToolDensityThreshold: z.number().nonnegative().optional(),
  })
  .strict();

/**
 * On-disk `<name>.md` frontmatter. Mirrors the spec's `sub_agents.<n>` keys
 * (0.6.0 §7.7 adds the routing quartet, the params, `budget_share`,
 * `inherit_routing` and `allowed_profiles`). Two honest differences from the
 * spec form, because a file on disk has no `models:` registry to resolve
 * against: `model` and every candidate are plain model strings (no `$ref`),
 * and `allowed_profiles` entries name their model explicitly —
 * `{ profile, model, thinking?, max_tokens?, temperature?, model_fallbacks?,
 * circuit_breaker? }` — the already-resolved shape the compiler produces for a
 * spec-declared sub-agent. `model_pool` is validated for its routing identity
 * (`candidates[].{model, tags}`, `policy`) and otherwise passed through: the
 * runtime owns the per-candidate settings grammar.
 */
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
  overlay: z.string().min(1).optional(),
  thinking: FRONTMATTER_THINKING.optional(),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  model_fallbacks: z.array(z.string().min(1)).min(1).optional(),
  circuit_breaker: FRONTMATTER_CIRCUIT_BREAKER.optional(),
  model_tiers: z
    .object({
      fast: z.string().min(1),
      default: z.string().min(1),
      routing: FRONTMATTER_TIER_ROUTING.optional(),
    })
    .strict()
    .optional(),
  model_pool: z
    .object({
      candidates: z
        .array(
          z.object({ model: z.string().min(1), tags: z.array(z.string().min(1)) }).passthrough(),
        )
        .min(1),
      policy: z.enum(["static", "heuristic", "learned", "classifier"]).optional(),
    })
    .passthrough()
    .optional(),
  budget_share: z.number().gt(0).max(1).optional(),
  inherit_routing: z.boolean().optional(),
  allowed_profiles: z
    .array(
      z
        .object({
          profile: z.string().min(1),
          model: z.string().min(1),
          thinking: FRONTMATTER_THINKING.optional(),
          max_tokens: z.number().int().positive().optional(),
          temperature: z.number().min(0).max(2).optional(),
          model_fallbacks: z.array(z.string().min(1)).min(1).optional(),
          circuit_breaker: FRONTMATTER_CIRCUIT_BREAKER.optional(),
        })
        .strict(),
    )
    .min(1)
    .optional(),
});

type FrontmatterThinking = z.infer<typeof FRONTMATTER_THINKING>;

/** Spec-spelled thinking block → the runtime `IrThinking` shape. */
function thinkingFromFrontmatter(
  t: FrontmatterThinking,
): NonNullable<SubAgentDefinition["thinking"]> {
  return "budget_tokens" in t ? { budgetTokens: t.budget_tokens } : { effort: t.effort };
}

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
    // 0.6.0 §7.7 — routing + params, spelled as the runtime definition holds
    // them (the IR's names). Every key is copied only when present. `overlay`
    // is the default-profile prompt prefix a pinned `allowed_profiles` entry
    // replaces (the spawner folds whichever applies; the body stays raw).
    ...(parsed.data.overlay !== undefined ? { overlay: parsed.data.overlay } : {}),
    ...(parsed.data.thinking !== undefined
      ? { thinking: thinkingFromFrontmatter(parsed.data.thinking) }
      : {}),
    ...(parsed.data.max_tokens !== undefined ? { maxTokens: parsed.data.max_tokens } : {}),
    ...(parsed.data.temperature !== undefined ? { temperature: parsed.data.temperature } : {}),
    ...(parsed.data.model_fallbacks !== undefined
      ? { modelFallbacks: parsed.data.model_fallbacks }
      : {}),
    ...(parsed.data.circuit_breaker !== undefined
      ? { circuitBreaker: parsed.data.circuit_breaker }
      : {}),
    ...(parsed.data.model_tiers !== undefined ? { modelTiers: parsed.data.model_tiers } : {}),
    ...(parsed.data.model_pool !== undefined
      ? { modelPool: parsed.data.model_pool as NonNullable<SubAgentDefinition["modelPool"]> }
      : {}),
    ...(parsed.data.budget_share !== undefined ? { budgetShare: parsed.data.budget_share } : {}),
    ...(parsed.data.inherit_routing !== undefined
      ? { inheritRouting: parsed.data.inherit_routing }
      : {}),
    ...(parsed.data.allowed_profiles !== undefined
      ? {
          allowedProfiles: parsed.data.allowed_profiles.map(
            (o): SubAgentProfileOption => ({
              profile: o.profile,
              model: o.model,
              ...(o.thinking !== undefined
                ? { thinking: thinkingFromFrontmatter(o.thinking) }
                : {}),
              ...(o.max_tokens !== undefined ? { maxTokens: o.max_tokens } : {}),
              ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
              ...(o.model_fallbacks !== undefined ? { modelFallbacks: o.model_fallbacks } : {}),
              ...(o.circuit_breaker !== undefined ? { circuitBreaker: o.circuit_breaker } : {}),
            }),
          ),
        }
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

/**
 * `subagent_type` is a model-filled tool argument and model output is
 * attacker-steerable (via any untrusted input). It becomes a filesystem path
 * segment in `loadSubAgentFromDisk` (`join(dir, `${name}.md`)`), and `join`
 * resolves `..` and path separators — so an unsanitized name like
 * `../../../tmp/evil` reads an arbitrary `.md` on the host and loads it as a
 * sub-agent definition. Reject anything that isn't a single safe path
 * component before it reaches the disk lookup. Inline spec-supplied names are
 * exact-key map lookups that never touch the filesystem, so they are resolved
 * first (above) and are unaffected.
 */
function isUnsafeSubAgentName(name: string): boolean {
  return (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name === "." ||
    name === ".."
  );
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
  // Guard the disk lookup against path traversal (the inline map above is an
  // exact-key lookup and is intentionally not gated).
  if (isUnsafeSubAgentName(resolveName)) {
    throw new SubAgentResolutionError(
      `invalid subagent_type "${resolveName}" — must not contain path separators, "..", ".", or NUL bytes`,
    );
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
  // 0.6.0 §7.7 — advertise the `profile` argument only when some definition
  // declares an allowlist, so a spec without `allowed_profiles` keeps the
  // exact description it had (the tool list sits in the cached prefix).
  const profileNote =
    opts.subAgents !== undefined &&
    [...opts.subAgents.values()].some((d) => d.allowedProfiles !== undefined)
      ? ` Pass \`profile\` to run a sub-agent on one of its allowed model profiles (${[
          ...opts.subAgents.values(),
        ]
          .filter((d) => d.allowedProfiles !== undefined)
          .map((d) => `${d.name}: ${(d.allowedProfiles ?? []).map((o) => o.profile).join("/")}`)
          .join("; ")}).`
      : "";
  const description =
    (knownNames.length === 0
      ? "Spawn a sub-agent to handle a delegated task. Pass a `description` (label) and a `prompt` (the task instructions). The sub-agent runs in an isolated context and returns a single final message."
      : `Spawn a sub-agent to handle a delegated task. Pass a \`description\` (label), a \`prompt\` (the task instructions), and optionally a \`subagent_type\` to pick a specialist. Available subagent_type values: ${knownNames.join(", ")}. The sub-agent runs in an isolated context and returns a single final message.`) +
    profileNote;

  return buildTool({
    name: "Task",
    description,
    inputSchema: taskInputSchema,
    concurrencySafe: true,
    readOnly: false,
    destructive: false,
    // Pillar 3 rule 6 (AGENTS.md): the sub-agent's `finalMessage` is already
    // classified and lineage-tagged at the spawner boundary (origin
    // "subagent"), so the runtime's post-tool pass at origin "tool" is
    // skipped here — a second pass would double-warn and burn the cache.
    // The rule documented this flag for years without a line setting it
    // (0.6.0 plan §7.5 noted the gap); this is that line.
    classifyOutput: false,
    // Per-call parallel eligibility (see the module header). A dispatch is
    // parallel-safe iff the resolved sub-agent's ENTIRE effective tool set
    // is read-only + concurrency-safe + non-destructive. Fail-closed: an
    // unresolvable/unsafe `subagent_type`, a malformed input, or an
    // inherit-the-whole-catalog child (which would include write/bash/Task)
    // all return false and route the call serial. `catalog` is the parent
    // tool set, from which `buildChildCatalog` derives the child's tools.
    concurrencyClassifier: (input, catalog) => {
      const parsed = taskInputSchema.safeParse(input);
      if (!parsed.success) return false;
      let def: SubAgentDefinition;
      try {
        def = resolveSubAgentDefinition(parsed.data.subagent_type, opts);
      } catch {
        return false;
      }
      const childTools = buildChildCatalog(catalog, def);
      // An empty child catalog is not provably safe (it means "inherit
      // nothing" or an unresolved filter) — require an explicit, non-empty,
      // uniformly-read-only tool set.
      if (childTools.length === 0) return false;
      return childTools.every((t) => t.concurrencySafe && t.readOnly && !t.destructive);
    },
    execute: async (input, ctx) => {
      const bridge = ctx?.bridge as RuntimeBridge | undefined;
      if (bridge === undefined || bridge.spawnSubAgent === undefined) {
        return "[Task error] runtime bridge is not available — Task can only be invoked from runChatLoop with sub-agent support enabled.";
      }
      const spawnSubAgent = bridge.spawnSubAgent;
      let def: SubAgentDefinition;
      try {
        def = resolveSubAgentDefinition(input.subagent_type, opts);
      } catch (err) {
        return `[Task error] ${(err as Error).message}`;
      }

      // 0.6.0 §7.7 / §10.1 — the model-filled `profile` argument is checked
      // against the definition's allowlist BEFORE anything is spawned. Thrown
      // (not returned) so tool-executor renders it `is_error: true`: the
      // parent model sees a refusal, not a result to build on.
      if (input.profile !== undefined) {
        const allowed = subAgentProfileAllowlist(def, bridge.model);
        if (!allowed.includes(input.profile)) {
          throw new SubAgentResolutionError(
            `profile "${input.profile}" is not allowed for sub-agent "${def.name}" — allowed: ${allowed.join(", ")}`,
          );
        }
      }

      const childTools = buildChildCatalog(bridge.tools, def);
      const childPerms = resolveChildPermissions(
        { mode: bridge.permissionMode, rules: bridge.permissionRules },
        def,
      );

      // 0.6.0 §10.2 — ONE shared projection replaces the field-by-field hand
      // copy this tool carried (and whose optional-seam omissions were the
      // mechanism of the G11 approval bug): `projectParentHandle` lives beside
      // `ParentRunHandle`, so a new handle field lands in the projection in
      // the same file. The routing projection (served arm, budget cap) rides
      // along for `inherit_routing` / `budget_share`.
      const parentHandle = projectParentHandle(bridge);

      // A fatal child failure (billing/auth) makes `spawnSubAgent` throw
      // `RunFailedError`; it propagates through here and through
      // tool-executor's carve-out so the whole run halts with the child's
      // report (§7.1: "a billing failure anywhere ends the run").
      const result = await spawnSubAgent(parentHandle, {
        def,
        prompt: input.prompt,
        permissionMode: childPerms.mode,
        permissionRules: childPerms.rules,
        childTools,
        ...(bridge.sessionRootDir !== undefined ? { sessionRootDir: bridge.sessionRootDir } : {}),
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
      });

      if (result.failure !== undefined) {
        // Non-fatal classified failure → an is_error tool result carrying
        // the structured {isError, failureClass, report} content. The run
        // continues; the parent model decides what to do next.
        throw new SubAgentFailedError(result.failure);
      }

      return result.finalMessage;
    },
  });
}
