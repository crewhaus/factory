/**
 * `@crewhaus/default-skills` — the skills and slash commands the product
 * ships by default (v0.3.0 design §2.6).
 *
 * Four skills:
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
 *   - `provability` — how to answer under the 0.8.0 proof gate
 *     (design/0.8.0-provability-release.md §11): cite with `[n]` and a
 *     definitions block, read before citing, cite computations and proofs
 *     by id, declare assumptions, preflight the draft. Its body carries the
 *     settings that change what the gate accepts — `{{level}}` (the floor),
 *     `{{checkers}}`, `{{on_fail}}`, `{{window}}`, `{{assumptions}}`,
 *     `{{independent}}` — and a `{{#proofs}}` section, all filled from the
 *     lowered `provability:` block, so the text says exactly what THIS gate
 *     verifies. Registered only for a spec that declares the block — see
 *     `@crewhaus/evaluation-service`'s `provabilitySkills`.
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
 * Substitution tokens carry spec configuration only — the learning domain
 * and the provability gate's settings. Tool names are written literally in the bodies
 * — the Thredz backend presents the same names via tool aliasing, so one
 * vocabulary serves both backends.
 *
 * Trust: nothing here is pre-trusted. Builtin frontmatter is classified at
 * discovery and builtin bodies at load, both at the `"skill"` TrustOrigin,
 * exactly like user- or project-provided skills (Pillar 3).
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CrewhausError } from "@crewhaus/errors";
import { type LoadedSkill, parseSkillFile } from "@crewhaus/skills-registry";
import { type SlashCommand, parseCommandFile } from "@crewhaus/slash-commands";
import { COMMAND_BODIES, SKILL_BODIES } from "./embedded";

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

export const DEFAULT_SKILL_NAMES = ["continuity", "learning-loop", "dream", "provability"] as const;
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
  // `filePath` is a stable identifier only — the body comes from the
  // compile-time-embedded text (`./embedded`), never a runtime disk read, so
  // this resolves inside a `bun build --compile` binary where the on-disk
  // `skills/` tree is absent. See `./embedded` for why.
  const filePath = join(builtinSkillsDir, name, "SKILL.md");
  const source = SKILL_BODIES[name];
  if (source === undefined) {
    throw new DefaultSkillsError(`default skill "${name}" has no embedded body`);
  }
  const { frontmatter, body } = parseSkillFile(source);
  if (frontmatter.name !== name) {
    throw new DefaultSkillsError(
      `default skill directory "${name}" declares frontmatter name "${frontmatter.name}"`,
    );
  }
  return { ...frontmatter, filePath, body };
}

function loadCommand(name: BuiltinCommandName): SlashCommand {
  // `filePath` is a stable identifier only; the body is embedded at compile
  // time (`./embedded`) rather than read from disk, so builtin commands
  // survive inside a compiled binary.
  const filePath = join(builtinCommandsDir, `${name}.md`);
  const source = COMMAND_BODIES[name];
  if (source === undefined) {
    throw new DefaultSkillsError(`builtin command "${name}" has no embedded body`);
  }
  const parsed = parseCommandFile(source);
  return {
    name,
    body: parsed.body,
    filePath,
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
  };
}

/**
 * The shipped default skills, pre-parsed with bodies in memory — for
 * `discoverSkills({ builtinSkills })`. They merge at lowest precedence: any
 * `~/.crewhaus/skills` or `.crewhaus/skills` skill with the same name
 * overrides (an empty-body override disables the builtin). The bodies here
 * are UNRENDERED: a templated skill (`learning-loop`, `provability`) goes
 * through {@link renderSkill} first, and each composition root registers a
 * skill only when the feature it teaches is on — an advertised skill for a
 * feature the harness lacks would strand the model.
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

/**
 * Body of the `provability` skill. Its tokens are the lowered block's
 * settings that change what the gate accepts — `{{level}}` (the floor),
 * `{{checkers}}` (the `formal.checkers` preference order), `{{on_fail}}`,
 * `{{window}}`, `{{assumptions}}`, `{{independent}}` — and one section,
 * `{{#proofs}}…{{/proofs}}`, kept only where the gate wires the proof tools.
 * `@crewhaus/evaluation-service`'s `provabilitySkills` computes every value
 * from the block; render through it rather than by hand.
 */
export const PROVABILITY_SKILL_BODY: string = requireSkill("provability").body;

// `{{token}}` — a value; `{{#token}}…{{/token}}` — a section. Names are
// simple identifiers; anything else in doubled braces is left alone (and
// there is none in the shipped bodies).
const TOKEN_RE = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const NAME_RE = /\{\{[#/]?([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const OPEN_RE = /\{\{#([A-Za-z][A-Za-z0-9_]*)\}\}/;
const STRAY_MARKER_RE = /\{\{[#/][A-Za-z][A-Za-z0-9_]*\}\}/;

/**
 * Every name {@link renderSkill} requires a substitution for in `body`: its
 * `{{token}}`s and its `{{#section}}`s. A caller computing values from
 * configuration passes only these — the renderer refuses any other key.
 */
export function skillTokens(body: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const m of body.matchAll(NAME_RE)) {
    tokens.add(m[1] as string);
  }
  return tokens;
}

/**
 * Resolve `{{#name}}…{{/name}}` sections: kept (markers removed) when the
 * substitution for `name` is non-empty, dropped whole when it is `""` — the
 * Mustache rule, so a section's value can also print inside it as
 * `{{name}}`. A marker alone on its line takes its line break with it, so a
 * dropped block section leaves no blank line. Sections may nest under
 * different names; an unbalanced marker throws.
 */
function renderSections(
  skillName: string,
  body: string,
  substitutions: Record<string, string>,
): string {
  let out = body;
  for (let open = OPEN_RE.exec(out); open !== null; open = OPEN_RE.exec(out)) {
    const section = open[1] as string;
    const closeMarker = `{{/${section}}}`;
    const openStart = open.index;
    const openEnd = openStart + open[0].length;
    const closeStart = out.indexOf(closeMarker, openEnd);
    if (closeStart === -1) {
      throw new DefaultSkillsError(
        `skill "${skillName}": section {{#${section}}} has no closing ${closeMarker}`,
      );
    }
    const closeEnd = closeStart + closeMarker.length;
    const lineStart = (at: number): boolean => at === 0 || out[at - 1] === "\n";
    // A marker on a line of its own: its line break goes with it.
    const innerStart = lineStart(openStart) && out[openEnd] === "\n" ? openEnd + 1 : openEnd;
    const tailStart = lineStart(closeStart) && out[closeEnd] === "\n" ? closeEnd + 1 : closeEnd;
    const keep = substitutions[section] !== "";
    out =
      out.slice(0, openStart) +
      (keep ? out.slice(innerStart, closeStart) : "") +
      out.slice(tailStart);
  }
  const stray = STRAY_MARKER_RE.exec(out);
  if (stray !== null) {
    throw new DefaultSkillsError(`skill "${skillName}": unbalanced section marker ${stray[0]}`);
  }
  return out;
}

/**
 * Render a default skill's body with its `{{token}}` substitutions
 * applied and its `{{#section}}…{{/section}}` blocks resolved (kept for a
 * non-empty value, dropped for `""`). Strict in both directions so wiring
 * bugs surface at compile time instead of shipping a half-templated skill:
 *
 *   - every token and section name in the body MUST have an entry in
 *     `substitutions` — a token inside a dropped section included (a missing
 *     value would leave literal `{{domain}}` in the prompt);
 *   - every key in `substitutions` MUST occur in the body (a typo'd or
 *     misdirected key would silently drop the caller's value).
 *
 * Tokens carry spec configuration only: `{{domain}}`, `{{curriculum}}`,
 * `{{sources}}` in `learning-loop`; the gate's settings in `provability`
 * (see {@link PROVABILITY_SKILL_BODY}). Tool names are literal text.
 * Substituted values are spec-authored; the composed body still passes the
 * `"skill"`-origin boundary classification when loaded.
 */
export function renderSkill(name: string, substitutions: Record<string, string> = {}): string {
  const skill = DEFAULT_SKILLS.find((s) => s.name === name);
  if (!skill) {
    throw new DefaultSkillsError(
      `unknown default skill "${name}" (known: ${DEFAULT_SKILL_NAMES.join(", ")})`,
    );
  }
  return renderSkillText(skill.body, substitutions, name);
}

/**
 * {@link renderSkill} over any skill body — the same template rules and the
 * same strictness — for a body that is not one of the shipped skills (a
 * test's, or an override's). `name` labels the errors.
 */
export function renderSkillText(
  body: string,
  substitutions: Record<string, string> = {},
  name = "skill",
): string {
  const tokens = skillTokens(body);
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
  return renderSections(name, body, substitutions).replace(
    TOKEN_RE,
    (_, token: string) => substitutions[token] as string,
  );
}
