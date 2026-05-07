/**
 * Catalog R9 `slash-commands` — markdown-templated user-input shortcuts
 * loaded from `<cwd>/.crewhaus/commands/<name>.md`.
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
 * Read every `.md` file directly under `<cwd>/.crewhaus/commands/`. Each
 * file's basename (sans extension) becomes its key in the returned map.
 * Subdirectories are not currently walked (v1 keeps the namespace flat).
 */
export async function loadCommands(
  opts: LoadCommandsOptions = {},
): Promise<Map<string, SlashCommand>> {
  const cwd = opts.cwd ?? process.cwd();
  const root = join(cwd, COMMANDS_RELATIVE);
  if (!existsSync(root)) return new Map();
  const out = new Map<string, SlashCommand>();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
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
  return out;
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
