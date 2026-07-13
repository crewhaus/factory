/**
 * Catalog R9 `slash-commands` — markdown-templated user-input shortcuts
 * loaded from three kinds of roots, lowest precedence first (later roots
 * override earlier ones by command name):
 *
 *   0. builtin directories (`opts.builtinDirs`) — shipped defaults, e.g.
 *      `@crewhaus/default-skills`' `commands/` dir. Each entry is used as
 *      the commands directory itself (it is NOT suffixed with
 *      `.crewhaus/commands`).
 *   1. `~/.crewhaus/commands/<name>.md` — user-level commands.
 *   2. `<cwd>/.crewhaus/commands/<name>.md` — project commands.
 *
 * A user or project command with a builtin's name replaces it wholesale, so
 * builtins are overridable (and, with an empty body, effectively disabled).
 *
 * Each file is a markdown body with optional YAML frontmatter:
 *
 *     ---
 *     description: explain X in two sentences
 *     argument-hint: "<topic>"
 *     ---
 *     Explain $ARGUMENTS in two sentences.
 *
 * The basename (without `.md`) is the command name. When the user types
 * `/<name> <args...>`, `expand()` replaces every literal `$ARGUMENTS` token
 * with whatever followed the command name. Substitution is non-recursive
 * and uses `String.prototype.replaceAll` (string form), so args containing
 * `$ARGUMENTS`, regex specials, or newlines pass through untouched.
 *
 * `expand` returns `{ handled: false, expanded: input }` when:
 *   - input does not start with `/`
 *   - the command name is not in the loaded map
 * Otherwise: `{ handled: true, expanded, command, arguments }`.
 *
 * Hook integration (`pre-slash`) fires in `runtime-core`, not here. This
 * package is pure: filesystem read + string templating, no I/O elsewhere.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { CrewhausError } from "@crewhaus/errors";
import { parse as parseYaml } from "yaml";

const COMMANDS_RELATIVE = ".crewhaus/commands";
const COMMAND_PLACEHOLDER = "$ARGUMENTS";

export type SlashCommand = {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly body: string;
  readonly filePath: string;
};

export type LoadCommandsOptions = {
  readonly cwd?: string;
  /** Home directory override for the user-level root (tests). */
  readonly homeDir?: string;
  /**
   * Builtin command directories, merged at LOWEST precedence. Each entry is
   * read as a flat directory of `<name>.md` files (no `.crewhaus/commands`
   * suffix is appended). User (`~/.crewhaus/commands`) and project
   * (`<cwd>/.crewhaus/commands`) commands override builtins by name.
   */
  readonly builtinDirs?: ReadonlyArray<string>;
};

export type ExpandResult = {
  readonly handled: boolean;
  readonly expanded: string;
  readonly command?: SlashCommand;
  readonly arguments?: string;
};

export class SlashCommandError extends CrewhausError {
  override readonly name = "SlashCommandError";
  constructor(message: string, cause?: unknown) {
    super("config", message, cause);
  }
}

/**
 * Read every `.md` file directly under each command root — builtin dirs
 * first, then `~/.crewhaus/commands/`, then `<cwd>/.crewhaus/commands/` —
 * so later roots override earlier ones by name. Each file's basename (sans
 * extension) becomes its key in the returned map. Subdirectories are not
 * currently walked (v1 keeps the namespace flat).
 */
export async function loadCommands(
  opts: LoadCommandsOptions = {},
): Promise<Map<string, SlashCommand>> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeDir ?? homedir();
  const userRoot = join(home, COMMANDS_RELATIVE);
  const projectRoot = join(cwd, COMMANDS_RELATIVE);
  const roots: string[] = [...(opts.builtinDirs ?? []), userRoot];
  if (projectRoot !== userRoot) roots.push(projectRoot);
  const out = new Map<string, SlashCommand>();
  for (const root of roots) {
    readCommandsUnder(root, out);
  }
  return out;
}

/** Read one commands root into `out` (later writers override by name). */
function readCommandsUnder(root: string, out: Map<string, SlashCommand>): void {
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const file = join(root, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const name = basename(entry, ".md");
    if (name.length === 0) continue;
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      throw new SlashCommandError(`failed to read ${file}: ${(err as Error).message}`, err);
    }
    let parsed: ParsedCommand;
    try {
      parsed = parseCommandFile(raw);
    } catch (err) {
      throw new SlashCommandError(`failed to parse ${file}: ${(err as Error).message}`, err);
    }
    out.set(name, {
      name,
      body: parsed.body,
      filePath: file,
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {}),
    });
  }
}

type ParsedCommand = {
  description?: string;
  argumentHint?: string;
  body: string;
};

/**
 * Split a slash-command markdown file into its optional frontmatter and
 * its body. Frontmatter is optional — files without a leading `---` are
 * treated as all-body, and the description / argumentHint stay undefined.
 *
 * Exported for tests. Mirrors `parseSkillFile` from `skills-registry` but
 * scoped to slash-command frontmatter shape.
 */
export function parseCommandFile(content: string): ParsedCommand {
  const trimmed = content.replace(/^﻿/, "");
  if (!trimmed.startsWith("---")) {
    return { body: trimmed };
  }
  const endIdx = findFrontmatterEnd(trimmed);
  if (endIdx === -1) {
    // No closing delimiter — treat as a plain body (don't throw; users may
    // legitimately put a `---` horizontal rule at the top of a free-form
    // command body without intending it as frontmatter).
    return { body: trimmed };
  }
  const fmRaw = trimmed.slice(trimmed.indexOf("\n") + 1, endIdx).trimEnd();
  const bodyStart = trimmed.indexOf("\n", endIdx + 3);
  const body = bodyStart === -1 ? "" : trimmed.slice(bodyStart + 1);
  let parsed: unknown;
  try {
    parsed = parseYaml(fmRaw);
  } catch {
    return { body };
  }
  if (typeof parsed !== "object" || parsed === null) return { body };
  const v = parsed as Record<string, unknown>;
  const description = typeof v["description"] === "string" ? v["description"] : undefined;
  const hintRaw = v["argument-hint"] ?? v["argumentHint"];
  const argumentHint = typeof hintRaw === "string" ? hintRaw : undefined;
  return {
    body,
    ...(description !== undefined ? { description } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
  };
}

function findFrontmatterEnd(content: string): number {
  let from = 3;
  while (from < content.length) {
    const idx = content.indexOf("\n---", from);
    if (idx === -1) return -1;
    const after = content.charAt(idx + 4);
    if (after === "\n" || after === "" || after === "\r") return idx + 1;
    from = idx + 4;
  }
  return -1;
}

/**
 * Try to interpret `input` as a slash-command invocation. Returns
 * `{ handled: false, expanded: input }` when there's no leading slash or
 * the command name doesn't resolve. Substitution is `replaceAll` with the
 * literal placeholder — no recursive interpretation of args.
 */
export function expand(input: string, commands: ReadonlyMap<string, SlashCommand>): ExpandResult {
  if (commands.size === 0) return { handled: false, expanded: input };
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return { handled: false, expanded: input };
  const m = trimmed.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (m === null) return { handled: false, expanded: input };
  const name = m[1] ?? "";
  const args = m[2] ?? "";
  const command = commands.get(name);
  if (!command) return { handled: false, expanded: input };
  const expanded = command.body.split(COMMAND_PLACEHOLDER).join(args);
  return { handled: true, expanded, command, arguments: args };
}
