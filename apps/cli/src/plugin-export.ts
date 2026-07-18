/**
 * Item 4 (§59) — `crewhaus export claude-plugin <spec> [--out <dir>]`. Wraps
 * `@crewhaus/target-claude-plugin`'s pure `emitClaudePlugin` (which returns an
 * in-memory bundle of files) with the CLI's disk-writing + a post-emit SMOKE
 * TEST that the emitted directory is a well-formed Anthropic plugin: the
 * required `.claude-plugin/plugin.json` parses and carries `name` /
 * `description` / `author.name`, and — the part specs with `mcp_servers` care
 * about — any emitted `.mcp.json` is valid JSON.
 *
 * Pure helpers only (author/out-dir resolution + the smoke checker), so they
 * unit-test without touching disk; the entry file `index.ts` calls
 * `emitClaudePlugin`, writes the files, and runs the smoke check.
 */

import { isAbsolute, resolve } from "node:path";

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
