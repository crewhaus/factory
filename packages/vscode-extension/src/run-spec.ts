/**
 * @crewhaus/vscode-extension/run-spec — Section 35
 *
 * "CrewHaus: Run Spec" command. Consumes the active editor's
 * `crewhaus.yaml`, shells to the configured CLI binary, and renders
 * the live trace timeline in an embedded Studio webview pointed at
 * `crewhaus.studioUrl` (Section 31's studio-server).
 *
 * Pure helpers exported here so tests can validate the argv shape and
 * sub-agent resolution without spinning up a VS Code extension host.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Resolve the frontmatter for a sub-agent definition file. Used by
 * the hover provider — when the user hovers `subagent_type: "code-reviewer"`
 * we surface the resolved frontmatter from `.crewhaus/sub-agents/code-reviewer.md`.
 */
export function resolveSubAgentDefinition(args: {
  workspaceRoot: string;
  subAgentName: string;
}): SubAgentDefinitionResolution | null {
  const safeName = args.subAgentName.replace(/[^a-zA-Z0-9_-]/g, "");
  if (safeName.length === 0) return null;
  const path = resolve(args.workspaceRoot, ".crewhaus", "sub-agents", `${safeName}.md`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const fm = parseFrontmatter(text);
  return {
    path,
    frontmatter: fm.frontmatter,
    body: fm.body,
  };
}

export type SubAgentDefinitionResolution = {
  readonly path: string;
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
};

/**
 * Build the argv the "Run Spec" command shells to. Matches the
 * signature of `crewhaus run <spec.yaml>`. Defaults to spec relative
 * to the spec file's directory.
 */
export function buildRunSpecArgv(args: {
  cliPath: string;
  specPath: string;
  modelOverride?: string;
}): readonly string[] {
  if (!args.cliPath || /[\s\n\r]/.test(args.cliPath)) {
    throw new Error(`invalid cliPath: ${JSON.stringify(args.cliPath)}`);
  }
  if (!args.specPath) {
    throw new Error("specPath is required");
  }
  const argv: string[] = [args.cliPath, "run", args.specPath];
  if (args.modelOverride) {
    argv.push("--model", args.modelOverride);
  }
  return argv;
}

/**
 * Compute the Studio webview URL for the active spec run.
 */
export function studioWebviewUrl(args: {
  studioUrl: string;
  specPath: string;
  workspaceRoot: string;
}): string {
  const base = args.studioUrl.replace(/\/+$/, "");
  const rel = relative(args.workspaceRoot, args.specPath);
  const params = new URLSearchParams({ spec: rel });
  return `${base}/#/run?${params.toString()}`;
}

function relative(from: string, to: string): string {
  const fromParts = from.split("/");
  const toParts = to.split("/");
  let i = 0;
  while (i < fromParts.length && fromParts[i] === toParts[i]) i++;
  const up = "../".repeat(fromParts.length - i);
  return `${up}${toParts.slice(i).join("/")}`;
}

// ─── frontmatter parser ────────────────────────────────────────────────────

function parseFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const fmText = m[1] ?? "";
  const body = m[2] ?? "";
  const fm: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const kv = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv?.[1] && kv[2] !== undefined) {
      fm[kv[1]] = kv[2].trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return { frontmatter: fm, body };
}

/** Used by tests to assert workspace root resolution against a fixture. */
export function _testFixturePath(): string {
  return join(dirname(new URL(import.meta.url).pathname), "..", "test-fixtures");
}
