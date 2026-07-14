/**
 * `@crewhaus/default-skills` — the skills and slash commands the product
 * ships by default (v0.3.0 design §2.6).
 *
 * Three skills:
 *
 *   - `continuity` — the session discipline: read the plan first, pin
 *     requirements verbatim as REQ entries, claimed-vs-proven status
 *     honesty, bias to action, accurate handoffs.
 *   - `learning-loop` — the expert demo's four modes (ANSWER / STUDY /
 *     REFLECT / EXAM), generalized. Its body carries `{{domain}}`,
 *     `{{curriculum}}`, and `{{sources}}` tokens that `renderSkill`
 *     substitutes at compile time from the spec's `learning:` block.
 *   - `dream` — the consolidation playbook consumed by scheduled dream
 *     ticks; not intended for the interactive skill listing.
 *
 * Eleven builtin slash commands (`commands/<name>.md`, the standard
 * `$ARGUMENTS` convention): /plan /focus /next /handoff /clear-plan
 * /clear-focus /forget /study /reflect /exam /dream.
 *
 * Dual representation, one source of truth: the checked-in
 * `skills/<name>/SKILL.md` and `commands/<name>.md` files are canonical.
 * This module parses them once at import and exports their bodies as
 * string constants — so target emitters can EMBED the text into compiled
 * bundles (bundle behavior never depends on the deploy machine's
 * node_modules), while the interpreter path can point `discoverSkills`'s
 * `builtinSkills` / `loadCommands`' `builtinDirs` at the very same files.
 *
 * Substitution tokens are used ONLY for learning-domain templating. Tool
 * names are written literally in the bodies — the Thredz backend presents
 * the same names via tool aliasing, so one vocabulary serves both
 * backends.
 *
 * Trust: nothing here is pre-trusted. Builtin frontmatter is classified at
 * discovery and builtin bodies at load, both at the `"skill"` TrustOrigin,
 * exactly like user- or project-provided skills (Pillar 3).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CrewhausError } from "@crewhaus/errors";
import { type LoadedSkill, parseSkillFile } from "@crewhaus/skills-registry";
import { type SlashCommand, parseCommandFile } from "@crewhaus/slash-commands";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Absolute path to the package's `skills/` directory — the builtin skills
 * root for disk-based discovery on the interpreter path.
 */
export const builtinSkillsDir: string = join(PKG_ROOT, "skills");

/**
 * Absolute path to the package's `commands/` directory — pass it in
 * `loadCommands({ builtinDirs: [builtinCommandsDir] })`. It is a flat
 * directory of `<name>.md` files, read as-is (no `.crewhaus` suffix).
 */
export const builtinCommandsDir: string = join(PKG_ROOT, "commands");

export class DefaultSkillsError extends CrewhausError {
  override readonly name = "DefaultSkillsError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

export const DEFAULT_SKILL_NAMES = ["continuity", "learning-loop", "dream"] as const;
export type DefaultSkillName = (typeof DEFAULT_SKILL_NAMES)[number];

export const BUILTIN_COMMAND_NAMES = [
  "plan",
  "focus",
  "next",
  "handoff",
  "clear-plan",
  "clear-focus",
  "forget",
  "study",
  "reflect",
  "exam",
  "dream",
] as const;
export type BuiltinCommandName = (typeof BUILTIN_COMMAND_NAMES)[number];

function loadSkill(name: DefaultSkillName): LoadedSkill {
  const filePath = join(builtinSkillsDir, name, "SKILL.md");
  const { frontmatter, body } = parseSkillFile(readFileSync(filePath, "utf8"));
  if (frontmatter.name !== name) {
    throw new DefaultSkillsError(
      `default skill directory "${name}" declares frontmatter name "${frontmatter.name}"`,
    );
  }
  return { ...frontmatter, filePath, body };
}

function loadCommand(name: BuiltinCommandName): SlashCommand {
  const filePath = join(builtinCommandsDir, `${name}.md`);
  const parsed = parseCommandFile(readFileSync(filePath, "utf8"));
  return {
    name,
    body: parsed.body,
    filePath,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
  };
}

/**
 * The shipped default skills, pre-parsed with bodies in memory — pass
 * directly as `discoverSkills({ builtinSkills: DEFAULT_SKILLS })`. They
 * merge at lowest precedence: any `~/.crewhaus/skills` or
 * `.crewhaus/skills` skill with the same name overrides (an empty-body
 * override disables the builtin).
 */
export const DEFAULT_SKILLS: ReadonlyArray<LoadedSkill> = DEFAULT_SKILL_NAMES.map(loadSkill);

/**
 * The builtin slash commands, pre-parsed — the same content
 * `loadCommands({ builtinDirs: [builtinCommandsDir] })` discovers from
 * disk, exported for compile-time embedding.
 */
export const DEFAULT_COMMANDS: ReadonlyArray<SlashCommand> = BUILTIN_COMMAND_NAMES.map(loadCommand);

function requireSkill(name: DefaultSkillName): LoadedSkill {
  const skill = DEFAULT_SKILLS.find((s) => s.name === name);
  if (!skill) throw new DefaultSkillsError(`default skill "${name}" missing from DEFAULT_SKILLS`);
  return skill;
}

/** Body of the `continuity` skill (no substitution tokens). */
export const CONTINUITY_SKILL_BODY: string = requireSkill("continuity").body;

/**
 * Body of the `learning-loop` skill. Contains `{{domain}}`,
 * `{{curriculum}}`, and `{{sources}}` tokens — render it with
 * `renderSkill("learning-loop", { domain, curriculum, sources })`.
 */
export const LEARNING_LOOP_SKILL_BODY: string = requireSkill("learning-loop").body;

/** Body of the `dream` consolidation playbook (no substitution tokens). */
export const DREAM_SKILL_BODY: string = requireSkill("dream").body;

// `{{token}}` — tokens are simple identifiers; anything else in doubled
// braces is left alone (and there is none in the shipped bodies).
const TOKEN_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

function bodyTokens(body: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of body.matchAll(TOKEN_RE)) {
    tokens.add(m[1] as string);
  }
  return tokens;
}

/**
 * Render a default skill's body with its `{{token}}` substitutions
 * applied. Strict in both directions so wiring bugs surface at compile
 * time instead of shipping a half-templated skill:
 *
 *   - every `{{token}}` in the body MUST have an entry in `substitutions`
 *     (a missing value would leave literal `{{domain}}` in the prompt);
 *   - every key in `substitutions` MUST occur in the body (a typo'd or
 *     misdirected key would silently drop the caller's value).
 *
 * Tokens exist ONLY for learning-domain templating (`{{domain}}`,
 * `{{curriculum}}`, `{{sources}}` in `learning-loop`); tool names are
 * literal text. Substituted values are spec-authored; the composed body
 * still passes the `"skill"`-origin boundary classification when loaded.
 */
export function renderSkill(name: string, substitutions: Record<string, string> = {}): string {
  const skill = DEFAULT_SKILLS.find((s) => s.name === name);
  if (!skill) {
    throw new DefaultSkillsError(
      `unknown default skill "${name}" (known: ${DEFAULT_SKILL_NAMES.join(", ")})`,
    );
  }
  const tokens = bodyTokens(skill.body);
  for (const token of tokens) {
    if (!(token in substitutions)) {
      throw new DefaultSkillsError(
        `skill "${name}" requires a substitution for {{${token}}} (expected keys: ${[...tokens].join(", ")})`,
      );
    }
  }
  for (const key of Object.keys(substitutions)) {
    if (!tokens.has(key)) {
      throw new DefaultSkillsError(
        `unknown substitution token "${key}" for skill "${name}" (body has ${
          tokens.size === 0 ? "no tokens" : [...tokens].join(", ")
        })`,
      );
    }
  }
  return skill.body.replace(TOKEN_RE, (_, token: string) => substitutions[token] as string);
}
