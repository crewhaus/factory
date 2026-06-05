import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type BuildContextBundleOpts = {
  readonly docsRoot: string;
  readonly demosRoot: string;
  readonly factoryRoot: string;
  readonly bundledAt?: string;
};

export type ContextBundleSource = {
  readonly path: string;
  readonly bytes: number;
};

export type ContextBundle = {
  readonly markdown: string;
  readonly sources: readonly ContextBundleSource[];
};

const HEADER = `# CrewHaus Context Bundle

> A single-file orientation manifest for AI agents working with CrewHaus.
> CrewHaus is a meta-harness compiler: write one spec, emit many runtime shapes.
> Live docs: https://crewhaus.ai/docs · Source of truth for schema: \`packages/spec/src/index.ts\`
`;

const QUICKSTART = `## Quickstart

\`\`\`bash
crewhaus init my-agent
crewhaus compile my-agent/crewhaus.yaml -o ./dist
crewhaus run ./dist
\`\`\`

The \`target:\` field in \`crewhaus.yaml\` selects the runtime shape. Currently supported:

| target      | shape                                  |
|-------------|----------------------------------------|
| \`cli\`       | interactive coding-agent loop         |
| \`workflow\`  | sequence of steps                     |
| \`channel\`   | Slack/Discord/Telegram/iMessage daemon|
| \`graph\`     | stateful graph with HITL checkpoints  |
| \`managed\`   | Anthropic Managed Agents              |
| \`pipeline\`  | RAG / extract-transform pipeline      |
| \`crew\`      | multi-agent role-based crew           |
| \`research\`  | autonomous long-horizon research      |
| \`batch\`     | queue worker                          |
| \`voice\`     | voice agent                           |
| \`browser\`   | browser agent                         |
| \`eval\`      | eval harness bundle                   |
`;

export function buildContextBundle(opts: BuildContextBundleOpts): ContextBundle {
  const bundledAt = opts.bundledAt ?? new Date().toISOString();
  const sources: ContextBundleSource[] = [];

  const sections: string[] = [];
  sections.push(HEADER);
  sections.push(`> Bundled at: ${bundledAt}`);
  sections.push(QUICKSTART);

  sections.push(
    readSection("Spec schema (source of truth)", "ts", () =>
      readTracked(sources, resolve(opts.factoryRoot, "packages/spec/src/index.ts")),
    ),
  );

  sections.push(
    readSection("Picking a recipe — diagnostic decision tree", "md", () =>
      sliceDecisionTree(readTracked(sources, resolve(opts.demosRoot, "recipes/INDEX.md"))),
    ),
  );

  sections.push(`## Recipe index\n\n${listRecipes(opts.demosRoot, sources)}`);

  sections.push(
    readSection("Module catalog — layer index", "md", () =>
      extractHeadings(readTracked(sources, resolve(opts.docsRoot, "MODULE-CATALOG.md"))),
    ),
  );

  sections.push(
    readSection("Getting started", "md", () =>
      readTracked(sources, resolve(opts.docsRoot, "GETTING-STARTED.md")),
    ),
  );

  const markdown = `${sections.join("\n\n")}\n`;
  return { markdown, sources };
}

function readTracked(sources: ContextBundleSource[], path: string): string {
  const text = readFileSync(path, "utf-8");
  sources.push({ path, bytes: Buffer.byteLength(text, "utf-8") });
  return text;
}

function readSection(title: string, fence: "ts" | "md", body: () => string): string {
  const content = body();
  if (fence === "ts") {
    return `## ${title}\n\n\`\`\`ts\n${content}\n\`\`\``;
  }
  return `## ${title}\n\n${content}`;
}

export function sliceDecisionTree(indexMarkdown: string): string {
  const startMarker = "## Pick a recipe";
  const endMarker = "## Recipes by part";
  const start = indexMarkdown.indexOf(startMarker);
  if (start === -1) return indexMarkdown;
  const end = indexMarkdown.indexOf(endMarker, start);
  if (end === -1) return indexMarkdown.slice(start);
  return indexMarkdown.slice(start, end).trim();
}

export function sliceSpecSchemaExcerpt(specSource: string): string {
  const marker = specSource.indexOf("discriminatedUnion");
  if (marker === -1) return specSource.slice(0, 8000);
  const start = Math.max(0, marker - 800);
  const end = Math.min(specSource.length, marker + 5000);
  return specSource.slice(start, end);
}

function extractHeadings(catalog: string): string {
  const lines = catalog.split("\n");
  const headings = lines.filter((line) => /^#{1,3}\s/.test(line));
  return headings.join("\n");
}

function listRecipes(demosRoot: string, sources: ContextBundleSource[]): string {
  const recipesDir = resolve(demosRoot, "recipes");
  if (!existsSync(recipesDir)) return "_(recipes directory not found)_";
  const files = readdirSync(recipesDir)
    .filter((name) => name.endsWith(".md") && name !== "INDEX.md")
    .sort();
  const rows: string[] = [];
  for (const file of files) {
    const path = join(recipesDir, file);
    const text = readFileSync(path, "utf-8");
    sources.push({ path, bytes: Buffer.byteLength(text, "utf-8") });
    const title = firstHeading(text) ?? basename(file, ".md");
    rows.push(`- [${file}](demos/walkthroughs/${file}) — ${title}`);
  }
  return rows.join("\n");
}

function firstHeading(markdown: string): string | undefined {
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return undefined;
}

export type DiscoverRootsOpts = {
  readonly startDir?: string;
  readonly env?: NodeJS.ProcessEnv;
};

export type DiscoveredRoots = {
  readonly factoryRoot: string;
  readonly docsRoot: string;
  readonly demosRoot: string;
};

export function discoverRoots(opts: DiscoverRootsOpts = {}): DiscoveredRoots {
  const env = opts.env ?? process.env;
  const factoryRoot = resolveRoot(
    env["CREWHAUS_FACTORY_ROOT"],
    "factory",
    ["packages/spec/src/index.ts"],
    opts.startDir,
  );
  const docsRoot = resolveRoot(
    env["CREWHAUS_DOCS_ROOT"],
    "docs",
    ["GETTING-STARTED.md", "MODULE-CATALOG.md"],
    opts.startDir,
  );
  const demosRoot = resolveRoot(
    env["CREWHAUS_DEMOS_ROOT"],
    "demos",
    ["recipes/INDEX.md"],
    opts.startDir,
  );
  return { factoryRoot, docsRoot, demosRoot };
}

function resolveRoot(
  envValue: string | undefined,
  siblingName: string,
  markers: readonly string[],
  startDir: string | undefined,
): string {
  if (envValue !== undefined && envValue !== "") {
    const abs = resolve(envValue);
    assertMarkers(abs, markers, `${envValue} (from env)`);
    return abs;
  }
  const found = walkUpForSibling(startDir ?? process.cwd(), siblingName, markers);
  if (found !== undefined) return found;
  throw new Error(
    `Could not locate ${siblingName}/ with markers ${markers.join(", ")}. ` +
      `Set CREWHAUS_${siblingName.toUpperCase()}_ROOT or run from inside a CrewHaus checkout.`,
  );
}

function assertMarkers(root: string, markers: readonly string[], label: string): void {
  for (const marker of markers) {
    if (!existsSync(resolve(root, marker))) {
      throw new Error(`${label} is missing required file: ${marker}`);
    }
  }
}

function walkUpForSibling(
  from: string,
  siblingName: string,
  markers: readonly string[],
): string | undefined {
  let current = resolve(from);
  let parent = resolve(current, "..");
  for (; ; current = parent, parent = resolve(current, "..")) {
    const candidate = resolve(current, siblingName);
    if (existsSync(candidate) && markers.every((m) => existsSync(resolve(candidate, m)))) {
      return candidate;
    }
    if (parent === current) break;
  }
  return undefined;
}
