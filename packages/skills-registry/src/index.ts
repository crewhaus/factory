/**
 * Catalog R9 `skills-registry` — directory-based SKILL.md catalog with
 * frontmatter parsing and a synthetic `Skill(name)` tool that lazily loads
 * each skill's body on first invocation.
 *
 * Discovery order (later entries override earlier by `name`):
 *   1. `~/.crewhaus/skills/<name>/SKILL.md`
 *   2. `<cwd>/.crewhaus/skills/<name>/SKILL.md`
 *   3. plugin-bundled directories (`opts.pluginDirs`)
 *
 * The lazy-load contract: `discoverSkills()` reads each file once just to
 * pull the frontmatter and stash the absolute path; the body stays on disk.
 * `formatSkillsForPrompt(skills)` produces a "Available skills:" block for
 * the system prompt that lists names + descriptions only. The model then
 * calls `Skill({ name })` to fetch a specific body — that's where the body
 * actually lands in the conversation.
 *
 * Frontmatter format mirrors Anthropic skills: a leading `---\n…\n---\n`
 * YAML block with required `name` (string) and `description` (string), plus
 * optional `triggers` (string[]) and `tools` (string[]). The `tools`
 * restriction is parsed into the `SkillRef` but NOT enforced at runtime in
 * v1 — runtime-core does not yet narrow the catalog while a skill is
 * "active".
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { classifyBoundary } from "@crewhaus/boundary-classifier";
import { CrewhausError } from "@crewhaus/errors";
import { type RunContext, tagContent } from "@crewhaus/run-context";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const SKILL_FILE = "SKILL.md";
const SKILLS_RELATIVE = ".crewhaus/skills";

/**
 * SKILL.md frontmatter. The required pair (`name`, `description`) matches
 * Anthropic's baseline. The optional fields extend toward the conventions
 * used in Anthropic's vertical packs (academic-research-skills,
 * claude-for-legal, financial-services) so packs from those repos can
 * drop into a CrewHaus skills directory without translation.
 *
 *  - `triggers` (CrewHaus original): keyword matchers the runtime can use
 *    to decide whether to surface the skill in the system prompt's
 *    "Available skills:" block.
 *  - `tools` (CrewHaus original): tool-name allow-list — when a skill is
 *    "active", runtime-core can narrow the tool catalog to this subset.
 *    v1 parses the field but does NOT enforce; that's a runtime follow-up.
 *  - `argument-hint` (Anthropic vertical packs, e.g. claude-for-legal): a
 *    slash-command-style argument summary, e.g. `"[subject] [--review |
 *    --drill]"`. Surfaced verbatim in the skill listing so the model
 *    knows the call shape without reading the body.
 *  - `metadata` (Anthropic academic-research-skills): version, status,
 *    task-type, and cross-skill linkage. Optional; the registry stores
 *    them on `SkillRef` for downstream consumers (Studio's skill
 *    explorer, eval datasets, plugin-marketplace listings).
 *
 * Schema-extensions follow-up: Anthropic vertical packs also ship
 * `agents/<name>.md` subdirectories and `references/*.schema.json`
 * envelopes. Those are filesystem conventions; this package detects them
 * via filesystem checks at discovery time, not via the frontmatter
 * schema. See docs/SKILLS-FORMAT.md.
 */
export type SkillFrontmatter = {
  readonly name: string;
  readonly description: string;
  readonly triggers?: ReadonlyArray<string>;
  readonly tools?: ReadonlyArray<string>;
  readonly argumentHint?: string;
  readonly metadata?: {
    readonly version?: string;
    readonly status?: "draft" | "active" | "deprecated";
    readonly taskType?: "open-ended" | "closed" | "hybrid";
    readonly relatedSkills?: ReadonlyArray<string>;
  };
};

export type SkillRef = SkillFrontmatter & {
  readonly filePath: string;
};

export type LoadedSkill = SkillRef & {
  readonly body: string;
};

export type DiscoverSkillsOptions = {
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly pluginDirs?: ReadonlyArray<string>;
};

export class SkillParseError extends CrewhausError {
  override readonly name = "SkillParseError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Split a SKILL.md into its frontmatter object and its remaining body. The
 * frontmatter must be wrapped in a leading `---` line and a closing `---`
 * line; anything else is rejected. The validator enforces the required
 * `name` and `description` fields and types the optional `triggers`/`tools`.
 */
export function parseSkillFile(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const trimmed = content.replace(/^﻿/, ""); // strip BOM if any
  if (!trimmed.startsWith("---")) {
    throw new SkillParseError("SKILL.md must start with a `---` frontmatter delimiter");
  }
  // Find the closing delimiter on a line of its own.
  const endIdx = findFrontmatterEnd(trimmed);
  if (endIdx === -1) {
    throw new SkillParseError("SKILL.md frontmatter never terminated (missing `---` closer)");
  }
  const fmRaw = trimmed.slice(trimmed.indexOf("\n") + 1, endIdx).trimEnd();
  const bodyStart = trimmed.indexOf("\n", endIdx + 3);
  const body = bodyStart === -1 ? "" : trimmed.slice(bodyStart + 1);
  let parsed: unknown;
  try {
    parsed = parseYaml(fmRaw);
  } catch (err) {
    throw new SkillParseError(`SKILL.md frontmatter is not valid YAML: ${(err as Error).message}`);
  }
  const fmSchema = z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    triggers: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    // Anthropic vertical-pack extensions. Both YAML key conventions are
    // accepted (`argument-hint` per Anthropic's slash-command convention,
    // and `argumentHint` per CrewHaus's camelCase preference) so packs
    // copied from Anthropic skill repos parse without translation.
    "argument-hint": z.string().optional(),
    argumentHint: z.string().optional(),
    metadata: z
      .object({
        version: z.string().optional(),
        status: z.enum(["draft", "active", "deprecated"]).optional(),
        task_type: z.enum(["open-ended", "closed", "hybrid"]).optional(),
        taskType: z.enum(["open-ended", "closed", "hybrid"]).optional(),
        related_skills: z.array(z.string()).optional(),
        relatedSkills: z.array(z.string()).optional(),
      })
      .optional(),
  });
  const result = fmSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const message = issue ? issue.message : "validation failed";
    throw new SkillParseError(`SKILL.md frontmatter ${path}: ${message}`);
  }
  const raw = result.data;
  // Normalize the dual key conventions (Anthropic kebab + CrewHaus camel)
  // into the canonical CrewHaus shape.
  const frontmatter: SkillFrontmatter = {
    name: raw.name,
    description: raw.description,
    ...(raw.triggers !== undefined ? { triggers: raw.triggers } : {}),
    ...(raw.tools !== undefined ? { tools: raw.tools } : {}),
    ...(raw["argument-hint"] !== undefined || raw.argumentHint !== undefined
      ? { argumentHint: raw.argumentHint ?? raw["argument-hint"] }
      : {}),
    ...(raw.metadata !== undefined
      ? {
          metadata: {
            ...(raw.metadata.version !== undefined ? { version: raw.metadata.version } : {}),
            ...(raw.metadata.status !== undefined ? { status: raw.metadata.status } : {}),
            ...(raw.metadata.taskType !== undefined || raw.metadata.task_type !== undefined
              ? { taskType: raw.metadata.taskType ?? raw.metadata.task_type }
              : {}),
            ...(raw.metadata.relatedSkills !== undefined ||
            raw.metadata.related_skills !== undefined
              ? { relatedSkills: raw.metadata.relatedSkills ?? raw.metadata.related_skills }
              : {}),
          },
        }
      : {}),
  };
  return { frontmatter, body };
}

function findFrontmatterEnd(content: string): number {
  // Search for `\n---` followed by a newline or EOF.
  let from = 3; // skip the opening `---`
  while (from < content.length) {
    const idx = content.indexOf("\n---", from);
    if (idx === -1) return -1;
    const after = content.charAt(idx + 4);
    if (after === "\n" || after === "" || after === "\r") return idx + 1; // point at line start of `---`
    from = idx + 4;
  }
  return -1;
}

/**
 * Walk every skill discovery root and return one `SkillRef` per `<dir>/SKILL.md`.
 * Project-level entries overwrite user-level entries by `name`; plugin-bundled
 * entries overwrite both. The body of each file is left on disk; only
 * frontmatter is parsed here.
 */
export async function discoverSkills(opts: DiscoverSkillsOptions = {}): Promise<SkillRef[]> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  const roots: string[] = [];
  const userRoot = join(home, SKILLS_RELATIVE);
  const projectRoot = join(cwd, SKILLS_RELATIVE);
  if (existsSync(userRoot)) roots.push(userRoot);
  if (projectRoot !== userRoot && existsSync(projectRoot)) roots.push(projectRoot);
  for (const dir of opts.pluginDirs ?? []) {
    if (existsSync(dir)) roots.push(dir);
  }
  const byName = new Map<string, SkillRef>();
  for (const root of roots) {
    for (const ref of readSkillsUnder(root)) {
      byName.set(ref.name, ref);
    }
  }
  // Pillar 3 boundary site — `formatSkillsForPrompt` and the `Skill` tool
  // surface each skill's `name` + `description` verbatim in the system prompt,
  // so classify the frontmatter at discovery (origin "skill") and drop any
  // skill whose metadata is malicious before it can reach the prompt (#154).
  // The body is separately classified in `loadSkillBody`.
  const safe: SkillRef[] = [];
  for (const ref of byName.values()) {
    const verdict = await classifyBoundary(`${ref.name}: ${ref.description}`, { origin: "skill" });
    if (verdict.action === "redact") continue;
    safe.push(ref);
  }
  return safe;
}

function readSkillsUnder(root: string): SkillRef[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: SkillRef[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const file = join(dir, SKILL_FILE);
    if (!existsSync(file)) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let parsed: { frontmatter: SkillFrontmatter; body: string };
    try {
      parsed = parseSkillFile(raw);
    } catch (err) {
      throw new SkillParseError(`failed to parse ${file}: ${(err as Error).message}`, err);
    }
    out.push({ ...parsed.frontmatter, filePath: file });
  }
  return out;
}

/**
 * Read the full body of a skill from disk. Called only when the model
 * invokes `Skill({ name })` — the lazy-load contract.
 *
 * Pillar 3 boundary site — a plugin-installed or attacker-planted
 * SKILL.md on disk is externally-controlled content. Classify the body
 * via `boundary-classifier` with `origin: "skill"` before handing it to
 * the model. The classifier's content-hash LRU cache means re-invoking
 * a healthy skill doesn't burn classification budget on repeated calls.
 * On a malicious verdict we return the redaction notice; the existing
 * §18 post-tool classifier in runtime-core remains a redundant safety
 * net (it'll detect any text that slipped through the cache eviction).
 *
 * Pillar 3 sink-side fabric (invariant #1) — a module that classifies
 * external content MUST also `tagContent` so the egress check sees its
 * provenance. After a non-redacted verdict the body is tagged under origin
 * `"skill"` when a `RunContext` is reachable, so the egress classifier can
 * attribute a later exfiltration to the skill boundary specifically. `ctx`
 * is optional: callers that can't reach the run context (e.g. a bare
 * `loadSkillBody(ref)` in a test) still get classification, just no tag.
 */
export async function loadSkillBody(ref: SkillRef, ctx?: RunContext): Promise<string> {
  const raw = readFileSync(ref.filePath, "utf8");
  const { body } = parseSkillFile(raw);
  const boundary = await classifyBoundary(body, { origin: "skill" });
  if (boundary.action === "redact" && boundary.redacted !== undefined) {
    // Malicious — the raw body never reaches the model, so there is nothing
    // for the egress fabric to track; do NOT tag lineage.
    return boundary.redacted;
  }
  if (ctx !== undefined) {
    tagContent(ctx, body, "skill");
  }
  return body;
}

/**
 * Render the system-prompt section that advertises available skills. Empty
 * input → empty string so callers can append unconditionally.
 */
export function formatSkillsForPrompt(skills: ReadonlyArray<SkillRef>): string {
  if (skills.length === 0) return "";
  const bullets = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  return `Available skills (call the \`Skill\` tool with \`{ "name": "<skill-name>" }\` to load full instructions):\n\n${bullets}`;
}

const skillToolSchema = z.object({ name: z.string().min(1) });

/**
 * Build the synthetic `Skill` tool that hands the model each skill body
 * on demand. The tool is read-only / concurrency-safe / non-destructive,
 * and exposes the available skill names in its description so the model
 * can pick from them without a second listing trip.
 */
export function createSkillTool(skills: ReadonlyArray<SkillRef>): RegisteredTool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const known = skills.map((s) => s.name).join(", ");
  const description =
    skills.length === 0
      ? "Load the full body of a named skill. (No skills are currently available.)"
      : `Load the full body of a named skill. The returned body contains step-by-step instructions you must follow. Available: ${known}.`;
  return {
    name: "Skill",
    description,
    inputSchema: skillToolSchema,
    execute: async (input, ctx) => {
      const parsed = skillToolSchema.parse(input);
      const ref = byName.get(parsed.name);
      if (!ref) {
        return `unknown skill "${parsed.name}". Available: ${known || "(none)"}.`;
      }
      // Thread the RunContext off the opaque runtime bridge (Section 13)
      // so loadSkillBody can tag the body's provenance into dataLineage.
      // The bridge is `unknown` to tool-catalog and only populated when the
      // runtime wires sub-agent / crew support; we read just `runContext`
      // structurally to avoid depending on agent-context-isolation. When
      // absent the body is still classified, just not tagged.
      const bridge = ctx?.bridge as { runContext?: RunContext } | undefined;
      return await loadSkillBody(ref, bridge?.runContext);
    },
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
    // Pillar 3: Skill bodies stay in-process; the Skill tool itself never
    // transmits to an external sink, so internal scope is correct. (The
    // skills-registry's boundary site for the skill body's content is
    // the `"skill"` origin in boundary-classifier; that's the source
    // side, separate from this sink-side declaration.)
    scope: "internal",
    requireJustification: false,
  };
}
