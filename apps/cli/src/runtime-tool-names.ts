/**
 * The names of the tools this repository defines, read from the source.
 *
 * `scripts/gen-tool-registry.ts` writes the ones that are not builtins into
 * `RUNTIME_TOOL_NAMES` (`@crewhaus/tool-registry-manifest/flags`), and
 * `tool-registry.test.ts` re-runs this scan to fail when that list is stale.
 * Generator and test only: it reads `packages/` from the checkout, which a
 * published CLI does not have, and nothing in the CLI imports it.
 *
 * WHY. The permission-rule checker says a rule "matches no tool" when it
 * names nothing it knows and is a near miss of a builtin. The runtime
 * registers tools a spec never lists — `Skill`, `ListTools`, `Task`, the
 * browser shape's `Type` and `Click`, the memory and plan tools, `Consult` —
 * and a check that only knew the builtins told the operator to replace
 * `alwaysAllow Skill` with `Shell`. The set of such tools is whatever the code
 * defines, so it is read from the code rather than written out.
 *
 * WHAT COUNTS AS A DEFINITION. A tool's name, written as a string literal or
 * as a constant defined in the same file as one, in either shape a tool is
 * built in this repository:
 *
 * - `buildTool({ name: … })` (optionally with a type argument), or
 * - an object literal that carries `name`, then an `inputSchema` and an
 *   `execute` before it closes — the hand-built `RegisteredTool` shape of
 *   `createSkillTool` and `buildListToolsTool`.
 *
 * A name computed at run time (`mcp__<server>__<tool>`, a contract gateway's
 * `<id>__<fn>`) is not a fixed name and is skipped.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** One tool definition the scan found. */
export type ToolDefinitionSite = {
  readonly name: string;
  /** `packages/<pkg>/src/<file>`, relative to the repository root. */
  readonly file: string;
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__fixtures__" || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(path);
    }
  }
  return out;
}

const STRING_CONSTANT = /\bconst ([A-Za-z_][A-Za-z0-9_]*)(?::\s*string)?\s*=\s*"([^"\\]+)"/g;
const BUILD_TOOL_NAME =
  /\bbuildTool(?:<[^>(]*>)?\(\{\s*(?:\/\/[^\n]*\n\s*)*name:\s*(?:"([^"\\]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*,/g;
const OBJECT_NAME = /\{\s*name:\s*(?:"([^"\\]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*,/g;

/**
 * Does the object literal that opens just before `from` carry an
 * `inputSchema:` and an `execute` before it closes? Braces are counted, and
 * string literals are not parsed — a heuristic that the hit-count assertions
 * in `tool-registry.test.ts` hold to the real shapes.
 */
function looksLikeToolObject(text: string, from: number): boolean {
  let depth = 1;
  let sawSchema = false;
  let sawExecute = false;
  for (let i = from; i < text.length && depth > 0; i++) {
    const ch = text.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 1) {
      if (text.startsWith("inputSchema", i)) sawSchema = true;
      else if (text.startsWith("execute", i)) sawExecute = true;
    }
  }
  return sawSchema && sawExecute;
}

/** Every tool definition under `<repoRoot>/packages/<pkg>/src`, in file order. */
export function scanToolDefinitions(repoRoot: string): ToolDefinitionSite[] {
  const packagesDir = join(repoRoot, "packages");
  const out: ToolDefinitionSite[] = [];
  for (const pkg of readdirSync(packagesDir).sort()) {
    const src = join(packagesDir, pkg, "src");
    if (!existsSync(src)) continue;
    for (const file of sourceFiles(src).sort()) {
      const text = readFileSync(file, "utf-8");
      const constants = new Map<string, string>();
      for (const m of text.matchAll(STRING_CONSTANT)) {
        constants.set(m[1] as string, m[2] as string);
      }
      const rel = file.slice(repoRoot.length + 1);
      const resolve = (literal: string | undefined, ident: string | undefined) =>
        literal ?? (ident !== undefined ? constants.get(ident) : undefined);
      const seenAt = new Set<number>();
      for (const m of text.matchAll(BUILD_TOOL_NAME)) {
        const name = resolve(m[1], m[2]);
        if (name === undefined) continue;
        out.push({ name, file: rel });
        seenAt.add((m.index ?? 0) + m[0].indexOf("{"));
      }
      for (const m of text.matchAll(OBJECT_NAME)) {
        const open = m.index ?? 0;
        if (seenAt.has(open)) continue;
        const name = resolve(m[1], m[2]);
        if (name === undefined) continue;
        if (!looksLikeToolObject(text, open + 1)) continue;
        out.push({ name, file: rel });
      }
    }
  }
  return out;
}

/**
 * The names from {@link scanToolDefinitions} that are not in `builtinNames`,
 * sorted and de-duplicated — the data behind `RUNTIME_TOOL_NAMES`.
 */
export function runtimeToolNames(
  repoRoot: string,
  builtinNames: ReadonlySet<string>,
): readonly string[] {
  const names = new Set<string>();
  for (const site of scanToolDefinitions(repoRoot)) {
    if (!builtinNames.has(site.name)) names.add(site.name);
  }
  return [...names].sort();
}
