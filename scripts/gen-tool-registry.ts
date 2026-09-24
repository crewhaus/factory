/**
 * Regenerate `packages/tool-registry-manifest/src/generated.ts` — the
 * data-only description of every builtin tool.
 *
 * Why this has to be generated rather than written:
 *
 *   Nothing already in the tree lets a compiled bundle say "here is a tool
 *   you are not running, and this is what it does". The builtin table
 *   (`BUILTIN_TOOLS` in packages/tool-categories) carries a package, an
 *   export and a name, and no prose.
 *   `@crewhaus/tool-categories` is forbidden from importing a tool package,
 *   because the compiler imports it and codegen must stay offline, so it
 *   carries one title per CATEGORY and nothing per tool. The descriptions and
 *   the flags live only on the `RegisteredTool` objects themselves, which are
 *   reachable only by importing all 74 tool packages — something `loadToolMap`
 *   in apps/cli does and no `packages/*` may.
 *
 * So the prose is baked into TypeScript source, the way
 * `scripts/gen-dockerfile-bodies.ts` bakes the Dockerfile bodies, and for the
 * same reason: one artifact every path can read identically.
 *
 * The KEY SET is every builtin the cli shape compiles, read from the builtin
 * table — never hand-written. That is what keeps this from becoming another
 * list to keep in sync: it is a projection of the table. `apps/cli/src/tool-registry.test.ts` re-runs this
 * projection and fails when the checked-in data no longer matches, so adding
 * or reworded a builtin without re-running this script fails CI rather than
 * silently shipping a stale answer to "what am I missing".
 *
 * This is a script, so importing from `apps/cli` for the keyword table is
 * fine — the layering rule it would otherwise break applies to packages.
 *
 *   bun run scripts/gen-tool-registry.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeToolNames } from "../apps/cli/src/runtime-tool-names";
import { TOOL_KEYWORDS } from "../apps/cli/src/tools-cli";
import {
  BUILTIN_TOOLS,
  builtinToolsFor,
  categoriesForTool,
} from "../packages/tool-categories/src/index";
import {
  type RegistryOperativeArg,
  projectRegistryEntry,
  projectToolFlags,
} from "../packages/tool-registry-manifest/src/types";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(REPO_ROOT, "packages", "tool-registry-manifest", "src", "generated.ts");
const FLAGS_OUT = join(REPO_ROOT, "packages", "tool-registry-manifest", "src", "flags.ts");

/** The version stamped into the manifest: the `crewhaus` CLI's own. */
const version = (
  JSON.parse(readFileSync(join(REPO_ROOT, "apps", "cli", "package.json"), "utf-8")) as {
    version: string;
  }
).version;

const keys = [...builtinToolsFor("cli")].sort();
if (keys.length === 0)
  throw new Error("the builtin table has no cli tools — refusing to write an empty manifest");

// The generated file says MCP tools "cannot be added". Make that true of the
// generator rather than only of the tests that read its output: nothing about
// the table's type stops an `mcp__` key being put there, and one such row
// would turn "this is the builtin set" into "this is the set".
const mcpKeys = keys.filter((k) => k.startsWith("mcp__"));
if (mcpKeys.length > 0) {
  throw new Error(
    `the builtin table has mcp__ keys, which this manifest cannot describe — a spec declares an MCP server, not its tools: ${mcpKeys.join(", ")}`,
  );
}

type ToolLike = {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly scope: string;
  readonly ioCapability?: string;
  readonly requiresSandbox: boolean;
  readonly requireJustification: boolean;
  readonly operativeArgs?: ReadonlyArray<RegistryOperativeArg>;
};

const rows: string[] = [];
const flagRows: string[] = [];
const builtinNames = new Set<string>();
for (const key of keys) {
  const entry = BUILTIN_TOOLS[key];
  if (entry === undefined) throw new Error(`no builtin table entry for ${key}`);
  // Workspace deps are linked per package, not hoisted to the root, so a
  // bare `@crewhaus/tool-fs` specifier does not resolve from `scripts/`.
  // Resolve to the checkout instead — the same module either way.
  const entryFile = join(
    REPO_ROOT,
    "packages",
    entry.package.replace("@crewhaus/", ""),
    "src",
    "index.ts",
  );
  const mod = (await import(entryFile)) as Record<string, unknown>;
  const tool = mod[entry.export] as ToolLike | undefined;
  if (tool === undefined || typeof tool.name !== "string") {
    throw new Error(`${entry.package} does not export a RegisteredTool named "${entry.export}"`);
  }
  const projected = projectRegistryEntry({
    key,
    tool,
    categories: categoriesForTool(key),
    package: entry.package,
    keywords: TOOL_KEYWORDS[key] ?? [],
  });
  builtinNames.add(tool.name);
  rows.push(`  ${JSON.stringify(key)}: ${JSON.stringify(projected)},`);
  flagRows.push(`  ${JSON.stringify(key)}: ${JSON.stringify(projectToolFlags(projected))},`);
}

writeFileSync(
  OUT,
  `// GENERATED by scripts/gen-tool-registry.ts — do not edit by hand.
// Re-run that script after adding, renaming or rewording a builtin tool;
// apps/cli/src/tool-registry.test.ts re-projects every entry and fails when
// the data below no longer matches the tools themselves.
/**
 * Every builtin tool this release ships, as data.
 *
 * A harness reads this to describe a tool it is NOT running — the thing it
 * cannot ask the live catalog, which by definition only knows what is bound.
 * It describes; it decides nothing. A harness that can write files can change
 * its own \`crewhaus.yaml\` with or without this file.
 *
 * MCP tools are absent on purpose and cannot be added: a spec declares an MCP
 * SERVER, and the server's tool list is only known once it is connected, so
 * "which MCP tools exist that I lack" has no offline answer.
 */
import type { RegistryEntry } from "./types";

/**
 * The \`crewhaus\` version this file was generated from. It is a stamp of when
 * the data was last projected, NOT the version of the process reading it — a
 * bundle compiled three releases ago carries whatever was stamped then, which
 * is exactly the skew an operator wants to see.
 */
export const REGISTRY_VERSION = ${JSON.stringify(version)};

export const TOOL_REGISTRY: Readonly<Record<string, RegistryEntry>> = {
${rows.join("\n")}
};
`,
);

writeFileSync(
  FLAGS_OUT,
  `// GENERATED by scripts/gen-tool-registry.ts — do not edit by hand.
// The same projection as generated.ts, less the prose: see ToolFlags in
// types.ts. apps/cli/src/tool-registry.test.ts checks the two agree.
/**
 * How every builtin tool is gated, as data: its spec key, its registered
 * name, its safety flags and the field(s) a permission rule's argument
 * pattern is about.
 *
 * Import it from \`@crewhaus/tool-registry-manifest/flags\`, which does not
 * pull in the descriptions — a bundle that reasons about permissions does not
 * need to carry every tool's prose.
 */
import type { ToolFlags } from "./types";

export const TOOL_FLAGS: Readonly<Record<string, ToolFlags>> = {
${flagRows.join("\n")}
};

/** {@link TOOL_FLAGS} keyed by registered name (\`HttpRequest\`) instead of spec key. */
export const TOOL_FLAGS_BY_NAME: ReadonlyMap<string, ToolFlags> = new Map(
  Object.values(TOOL_FLAGS).map((flags) => [flags.name, flags]),
);

/**
 * The other tools this release defines: ones the runtime registers without a
 * spec listing them (\`Skill\`, \`ListTools\`, \`Task\`, the browser shape's
 * \`Type\`, the memory and plan tools, \`Consult\`, …). Names only — how
 * each is gated depends on how the runtime builds it. A permission rule
 * naming one of these names a real tool, even though no builtin has the name.
 *
 * Read from the source by \`apps/cli/src/runtime-tool-names.ts\`, not written
 * out; \`apps/cli/src/tool-registry.test.ts\` fails when it is stale.
 */
export const RUNTIME_TOOL_NAMES: ReadonlyArray<string> = ${JSON.stringify(runtimeToolNames(REPO_ROOT, builtinNames))};
`,
);

// Biome formats these files like any other source file, so format them here
// rather than leaving `bun run lint` to fail on a freshly generated tree.
const fmt = Bun.spawnSync(["bunx", "biome", "format", "--write", OUT, FLAGS_OUT], {
  cwd: REPO_ROOT,
});
if (fmt.exitCode !== 0) {
  throw new Error(`biome format failed on ${OUT}: ${new TextDecoder().decode(fmt.stderr)}`);
}

const bytes = readFileSync(OUT).byteLength;
console.log(
  `wrote ${OUT} (${keys.length} tools, ${bytes} bytes / ${(bytes / 1024).toFixed(1)} KB)`,
);
