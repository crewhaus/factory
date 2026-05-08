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
import { CrewhausError } from "@crewhaus/errors";
import type { RegisteredTool } from "@crewhaus/tool-catalog";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const SKILL_FILE = "SKILL.md";
const SKILLS_RELATIVE = ".crewhaus/skills";

export type SkillFrontmatter = {
  readonly name: string;
  readonly description: string;
  readonly triggers?: ReadonlyArray<string>;
  readonly tools?: ReadonlyArray<string>;
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
  });
  const result = fmSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const message = issue ? issue.message : "validation failed";
    throw new SkillParseError(`SKILL.md frontmatter ${path}: ${message}`);
  }
  return { frontmatter: result.data, body };
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
  return [...byName.values()];
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
 */
export async function loadSkillBody(ref: SkillRef): Promise<string> {
  const raw = readFileSync(ref.filePath, "utf8");
  const { body } = parseSkillFile(raw);
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
    execute: async (input) => {
      const parsed = skillToolSchema.parse(input);
      const ref = byName.get(parsed.name);
      if (!ref) {
        return `unknown skill "${parsed.name}". Available: ${known || "(none)"}.`;
      }
      return await loadSkillBody(ref);
    },
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    requiresSandbox: false,
    classifyOutput: true,
  };
}
