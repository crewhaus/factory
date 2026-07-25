/**
 * Item 4 (§59) — `crewhaus export claude-plugin <spec> [--out <dir>]`. Wraps
 * `@crewhaus/target-claude-plugin`'s pure `emitClaudePlugin` (which returns an
 * in-memory bundle of files) with the CLI's disk-writing + a post-emit SMOKE
 * TEST that the emitted directory is a well-formed Anthropic plugin: the
 * required `.claude-plugin/plugin.json` parses and carries `name` /
 * `description` / `author.name`, and — the part specs with `mcp_servers` care
 * about — any emitted `.mcp.json` is valid JSON.
 *
 * Mostly pure helpers (author/out-dir resolution + the smoke checker), so they
 * unit-test without touching disk; the entry file `index.ts` calls
 * `emitClaudePlugin`, writes the files, and runs the smoke check. The one I/O
 * helper is {@link collectHarnessPluginAssets}, which reads the harness's
 * AUTHORED `.crewhaus/skills/**` + `.crewhaus/commands/*.md` off disk so the
 * (pure) emitter can carry them into the plugin — the emitter itself still
 * never touches the filesystem.
 */

import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { SkillParseError, parseSkillFile } from "@crewhaus/skills-registry";

/** One emitted plugin file (structural mirror of `target-claude-plugin`'s `PluginFile`). */
export type ExportPluginFile = {
  readonly path: string;
  readonly content: string;
};

/** Default author name stamped into `plugin.json` when `--author` is omitted —
 *  Anthropic's minimal schema requires a non-empty author. */
export const DEFAULT_CLAUDE_PLUGIN_AUTHOR = "CrewHaus";

/**
 * Resolve the plugin author from `--author` / `--author-email` (both optional).
 * `plugin.json`'s schema requires an author name, so an omitted `--author`
 * falls back to {@link DEFAULT_CLAUDE_PLUGIN_AUTHOR}. An empty `--author-email`
 * is treated as absent (never emitted as `"email": ""`).
 */
export function resolveClaudePluginAuthor(
  nameFlag: string | undefined,
  emailFlag: string | undefined,
): { readonly name: string; readonly email?: string } {
  const name =
    typeof nameFlag === "string" && nameFlag.trim() !== ""
      ? nameFlag.trim()
      : DEFAULT_CLAUDE_PLUGIN_AUTHOR;
  const email =
    typeof emailFlag === "string" && emailFlag.trim() !== "" ? emailFlag.trim() : undefined;
  return email !== undefined ? { name, email } : { name };
}

/**
 * Resolve the output directory the plugin is written to: `--out <dir>`
 * (absolute, or relative to `cwd`) when given, else `<cwd>/<pluginName>` — the
 * plugin dir is conventionally named after the (already sanitized) IR name.
 */
export function resolveExportOutDir(
  outFlag: string | undefined,
  cwd: string,
  pluginName: string,
): string {
  if (typeof outFlag === "string" && outFlag.trim() !== "") {
    const p = outFlag.trim();
    return isAbsolute(p) ? p : resolve(cwd, p);
  }
  return resolve(cwd, pluginName);
}

/**
 * Smoke-test an emitted Claude-plugin bundle: returns the list of problems
 * (empty = well-formed). Verifies the REQUIRED `.claude-plugin/plugin.json`
 * exists, parses, and carries a non-empty `name`, `description`, and
 * `author.name`; that a `README.md` was emitted; and — only when the spec had
 * `mcp_servers`, so the emitter wrote one — that `.mcp.json` is a valid JSON
 * object. A well-formed bundle also needs at least one SKILL.md / agent .md so
 * Claude Code has something to load.
 */
export function smokeCheckClaudePluginBundle(files: ReadonlyArray<ExportPluginFile>): string[] {
  const issues: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  const pluginJsonRaw = byPath.get(".claude-plugin/plugin.json");
  if (pluginJsonRaw === undefined) {
    issues.push("missing required .claude-plugin/plugin.json");
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pluginJsonRaw);
    } catch (err) {
      issues.push(`.claude-plugin/plugin.json is not valid JSON: ${(err as Error).message}`);
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const obj = parsed as { name?: unknown; description?: unknown; author?: unknown };
      if (typeof obj.name !== "string" || obj.name.trim() === "") {
        issues.push(".claude-plugin/plugin.json is missing a non-empty name");
      }
      if (typeof obj.description !== "string" || obj.description.trim() === "") {
        issues.push(".claude-plugin/plugin.json is missing a non-empty description");
      }
      const author = obj.author as { name?: unknown } | undefined;
      if (author === null || typeof author !== "object" || typeof author.name !== "string") {
        issues.push(".claude-plugin/plugin.json is missing author.name");
      }
    }
  }

  if (!byPath.has("README.md")) {
    issues.push("missing README.md");
  }

  const mcpRaw = byPath.get(".mcp.json");
  if (mcpRaw !== undefined) {
    let mcp: unknown;
    try {
      mcp = JSON.parse(mcpRaw);
    } catch (err) {
      issues.push(`.mcp.json is not valid JSON: ${(err as Error).message}`);
      mcp = undefined;
    }
    if (mcp !== undefined && (mcp === null || typeof mcp !== "object" || Array.isArray(mcp))) {
      issues.push(".mcp.json is not a JSON object of server configs");
    }
  }

  const hasSurface = files.some(
    (f) => f.path.endsWith("SKILL.md") || (f.path.startsWith("agents/") && f.path.endsWith(".md")),
  );
  if (!hasSurface) {
    issues.push("no SKILL.md or agents/*.md — the plugin has nothing for Claude Code to load");
  }

  return issues;
}

/** Harness workspace subdirectory holding hand-authored skills. */
const HARNESS_SKILLS_DIR = join(".crewhaus", "skills");
/** Harness workspace subdirectory holding hand-authored slash commands. */
const HARNESS_COMMANDS_DIR = join(".crewhaus", "commands");
/** A skill directory is only a skill when it carries this file (skills-registry's rule). */
const SKILL_FILE = "SKILL.md";

/**
 * Item 14 — what a harness's `.crewhaus/` workspace contributes to an export.
 * `files` are plugin-relative and ready to hand to `emitClaudePlugin`'s
 * `assets`; `skipped` names files deliberately left behind (binary payloads,
 * which a text-only `PluginFile` cannot carry); `issues` are hard errors the
 * caller should fail the export on — an authored SKILL.md that Claude Code
 * would refuse to load is worse shipped than not shipped.
 */
export type HarnessPluginAssets = {
  readonly files: ExportPluginFile[];
  readonly skipped: string[];
  readonly issues: string[];
};

/**
 * Read the harness's AUTHORED plugin surface out of `<harnessDir>/.crewhaus/`
 * and map it onto Anthropic's plugin layout:
 *
 *   `.crewhaus/skills/<name>/**`  →  `skills/<name>/**`
 *   `.crewhaus/commands/<name>.md`  →  `commands/<name>.md`
 *
 * Copied VERBATIM: the two formats are already the same markdown-with-YAML
 * -frontmatter shape (`skills-registry` deliberately parses a superset of
 * Anthropic's SKILL.md, and `slash-commands` shares Claude Code's `$ARGUMENTS`
 * convention), so re-rendering could only lose fields the author wrote.
 * Everything under a skill directory travels — `references/`, `agents/`, and
 * the other Anthropic vertical-pack conventions — not just SKILL.md, because
 * a skill body that references a sibling file is broken without it.
 *
 * Deliberately scoped to the HARNESS: `discoverSkills`/`loadCommands` would
 * also merge `~/.crewhaus/**` and the shipped builtins, which would bake the
 * exporting operator's personal skills into a plugin meant for distribution.
 *
 * Only regular files are read (a `Dirent` for a symlink is neither
 * `isFile()` nor `isDirectory()`, so symlinked entries are skipped and the
 * walk cannot cycle). Entries are sorted for a deterministic bundle.
 */
export function collectHarnessPluginAssets(harnessDir: string): HarnessPluginAssets {
  const files: ExportPluginFile[] = [];
  const skipped: string[] = [];
  const issues: string[] = [];

  const skillsRoot = join(harnessDir, HARNESS_SKILLS_DIR);
  for (const dir of sortedDirNames(skillsRoot)) {
    const skillDir = join(skillsRoot, dir);
    if (!isReadableFile(join(skillDir, SKILL_FILE))) continue;
    for (const rel of walkRelativeFiles(skillDir)) {
      const abs = join(skillDir, ...rel);
      const read = readTextFile(abs);
      if (read === undefined) {
        skipped.push(abs);
        continue;
      }
      if (rel.length === 1 && rel[0] === SKILL_FILE) {
        const problem = skillFrontmatterProblem(read);
        if (problem !== undefined) {
          issues.push(`${abs}: ${problem}`);
          continue;
        }
      }
      files.push({ path: `skills/${dir}/${rel.join("/")}`, content: read });
    }
  }

  const commandsRoot = join(harnessDir, HARNESS_COMMANDS_DIR);
  for (const entry of sortedFileNames(commandsRoot)) {
    if (!entry.endsWith(".md")) continue;
    const name = basename(entry, ".md");
    if (name.length === 0) continue;
    const abs = join(commandsRoot, entry);
    const read = readTextFile(abs);
    if (read === undefined) {
      skipped.push(abs);
      continue;
    }
    files.push({ path: `commands/${name}.md`, content: read });
  }

  return { files, skipped, issues };
}

/**
 * Why an authored SKILL.md would not load, or `undefined` when it is fine.
 * Delegated to `skills-registry`'s own `parseSkillFile` — the package that
 * OWNS the format — so the export gate and the runtime loader can never
 * disagree about what a valid SKILL.md is (both require the `---` block plus
 * a non-empty `name` + `description`, which is also Claude Code's contract).
 */
function skillFrontmatterProblem(content: string): string | undefined {
  try {
    parseSkillFile(content);
    return undefined;
  } catch (err) {
    return err instanceof SkillParseError
      ? err.message
      : `SKILL.md could not be parsed: ${(err as Error).message}`;
  }
}

/** Read a file as UTF-8, or `undefined` when it is unreadable or binary. */
function readTextFile(path: string): string | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return undefined;
  }
  // A NUL byte is git's binary heuristic; a text-only `PluginFile` would
  // mangle such a payload into replacement characters, so leave it behind.
  if (buf.includes(0)) return undefined;
  return buf.toString("utf-8");
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sortedDirNames(root: string): string[] {
  return sortedEntries(root)
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function sortedFileNames(root: string): string[] {
  return sortedEntries(root)
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

function sortedEntries(root: string): Dirent[] {
  try {
    // Code-unit order, not `localeCompare` — the emitted bundle must be
    // byte-identical across locales/ICU builds (and it puts `SKILL.md` ahead
    // of a skill's lowercase `references/` sibling, which reads better).
    return readdirSync(root, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  } catch {
    return [];
  }
}

/** Every regular file under `root`, as path segments relative to `root`. */
function walkRelativeFiles(root: string, prefix: ReadonlyArray<string> = []): string[][] {
  const out: string[][] = [];
  for (const entry of sortedEntries(join(root, ...prefix))) {
    const next = [...prefix, entry.name];
    if (entry.isFile()) out.push(next);
    else if (entry.isDirectory()) out.push(...walkRelativeFiles(root, next));
  }
  return out;
}
