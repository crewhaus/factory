import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildContextBundle, discoverRoots, sliceSpecSchemaExcerpt } from "./index";

function makeFixtureTree(): {
  factoryRoot: string;
  docsRoot: string;
  demosRoot: string;
  monorepoRoot: string;
} {
  const monorepoRoot = join(
    tmpdir(),
    `crewhaus-context-bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const factoryRoot = join(monorepoRoot, "factory");
  const docsRoot = join(monorepoRoot, "docs");
  const demosRoot = join(monorepoRoot, "demos");

  mkdirSync(join(factoryRoot, "packages/spec/src"), { recursive: true });
  mkdirSync(docsRoot, { recursive: true });
  mkdirSync(join(demosRoot, "recipes"), { recursive: true });

  writeFileSync(
    join(factoryRoot, "packages/spec/src/index.ts"),
    "export const SPEC_VERSION = 0;\nconst _x = z.discriminatedUnion('target', []);\n",
  );
  writeFileSync(
    join(docsRoot, "GETTING-STARTED.md"),
    "# Getting started\n\nWelcome to the fixture.\n",
  );
  writeFileSync(
    join(docsRoot, "MODULE-CATALOG.md"),
    "# Module catalog\n\n## Layer A — Foundations\n\nbody\n\n### A1 — IR\n\nbody\n",
  );
  writeFileSync(
    join(demosRoot, "recipes/INDEX.md"),
    [
      "# Recipes",
      "",
      "preamble paragraph",
      "",
      "## Pick a recipe — diagnostic decision tree",
      "",
      "1. First option",
      "2. Second option",
      "",
      "## Recipes by part",
      "",
      "more content here",
    ].join("\n"),
  );
  writeFileSync(join(demosRoot, "recipes/01-cli-coding-agent.md"), "# CLI Coding Agent\n\nbody\n");
  writeFileSync(
    join(demosRoot, "recipes/02-sequential-workflow.md"),
    "# Sequential Workflow\n\nbody\n",
  );

  return { factoryRoot, docsRoot, demosRoot, monorepoRoot };
}

describe("buildContextBundle", () => {
  test("produces a bundle with the major sections", () => {
    const { factoryRoot, docsRoot, demosRoot } = makeFixtureTree();
    const { markdown, sources } = buildContextBundle({
      factoryRoot,
      docsRoot,
      demosRoot,
      bundledAt: "2026-05-21T00:00:00Z",
    });

    expect(markdown).toContain("# CrewHaus Context Bundle");
    expect(markdown).toContain("Bundled at: 2026-05-21T00:00:00Z");
    expect(markdown).toContain("## Quickstart");
    expect(markdown).toContain("## Spec schema");
    expect(markdown).toContain("z.discriminatedUnion('target', [])");
    expect(markdown).toContain("## Picking a recipe");
    expect(markdown).toContain("1. First option");
    expect(markdown).not.toContain("more content here");
    expect(markdown).toContain("## Recipe index");
    expect(markdown).toContain("01-cli-coding-agent.md");
    expect(markdown).toContain("CLI Coding Agent");
    expect(markdown).toContain("## Module catalog — layer index");
    expect(markdown).toContain("## Layer A — Foundations");
    expect(markdown).not.toContain("body\n");
    expect(markdown).toContain("## Getting started");
    expect(markdown).toContain("Welcome to the fixture");

    const paths = sources.map((s) => s.path);
    expect(paths.some((p) => p.endsWith("packages/spec/src/index.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("recipes/INDEX.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("GETTING-STARTED.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("MODULE-CATALOG.md"))).toBe(true);
  });

  test("is deterministic for a fixed bundledAt and tree", () => {
    const { factoryRoot, docsRoot, demosRoot } = makeFixtureTree();
    const first = buildContextBundle({
      factoryRoot,
      docsRoot,
      demosRoot,
      bundledAt: "2026-05-21T00:00:00Z",
    });
    const second = buildContextBundle({
      factoryRoot,
      docsRoot,
      demosRoot,
      bundledAt: "2026-05-21T00:00:00Z",
    });
    expect(first.markdown).toBe(second.markdown);
  });
});

describe("discoverRoots", () => {
  test("walks up to find sibling factory/docs/demos directories", () => {
    const { factoryRoot, docsRoot, demosRoot, monorepoRoot } = makeFixtureTree();
    const nested = join(monorepoRoot, "factory/packages/spec/src");

    const roots = discoverRoots({ startDir: nested, env: {} });

    expect(roots.factoryRoot).toBe(resolve(factoryRoot));
    expect(roots.docsRoot).toBe(resolve(docsRoot));
    expect(roots.demosRoot).toBe(resolve(demosRoot));
  });

  test("env overrides take precedence", () => {
    const { factoryRoot, docsRoot, demosRoot } = makeFixtureTree();

    const roots = discoverRoots({
      startDir: "/tmp",
      env: {
        CREWHAUS_FACTORY_ROOT: factoryRoot,
        CREWHAUS_DOCS_ROOT: docsRoot,
        CREWHAUS_DEMOS_ROOT: demosRoot,
      },
    });

    expect(roots.factoryRoot).toBe(resolve(factoryRoot));
    expect(roots.docsRoot).toBe(resolve(docsRoot));
    expect(roots.demosRoot).toBe(resolve(demosRoot));
  });

  test("throws when roots cannot be located", () => {
    expect(() => discoverRoots({ startDir: tmpdir(), env: {} })).toThrow(/Could not locate/);
  });

  test("throws when an env-provided root is missing a required marker", () => {
    const { factoryRoot, docsRoot } = makeFixtureTree();
    // Point the demos root at a directory that exists but lacks recipes/INDEX.md.
    const emptyDemos = join(
      tmpdir(),
      `crewhaus-context-bundle-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(emptyDemos, { recursive: true });

    expect(() =>
      discoverRoots({
        startDir: "/tmp",
        env: {
          CREWHAUS_FACTORY_ROOT: factoryRoot,
          CREWHAUS_DOCS_ROOT: docsRoot,
          CREWHAUS_DEMOS_ROOT: emptyDemos,
        },
      }),
    ).toThrow(/missing required file: recipes\/INDEX\.md/);
  });
});

describe("recipe heading fallback", () => {
  test("falls back to the file basename when a recipe has no top-level heading", () => {
    const { factoryRoot, docsRoot, demosRoot } = makeFixtureTree();
    // A recipe whose only headings are deeper than h1 (no "# " line) must
    // fall back to its basename in the recipe index.
    writeFileSync(
      join(demosRoot, "recipes/99-no-top-heading.md"),
      "## Subheading only\n\nbody without an h1\n",
    );

    const { markdown } = buildContextBundle({
      factoryRoot,
      docsRoot,
      demosRoot,
      bundledAt: "2026-05-21T00:00:00Z",
    });

    expect(markdown).toContain(
      "- [99-no-top-heading.md](demos/walkthroughs/99-no-top-heading.md) — 99-no-top-heading",
    );
  });
});

describe("sliceSpecSchemaExcerpt", () => {
  test("centers the excerpt on the discriminatedUnion marker", () => {
    const before = "A".repeat(2000);
    const after = "B".repeat(6000);
    const source = `${before}discriminatedUnion${after}`;

    const excerpt = sliceSpecSchemaExcerpt(source);

    // Starts 800 chars before the marker and runs up to 5000 chars past it.
    const markerIndex = source.indexOf("discriminatedUnion");
    expect(excerpt).toBe(source.slice(markerIndex - 800, markerIndex + 5000));
    expect(excerpt).toContain("discriminatedUnion");
    expect(excerpt.length).toBe(800 + 5000);
  });

  test("clamps the window to the source bounds when the marker is near the edges", () => {
    const source = "discriminatedUnion then a short tail";

    const excerpt = sliceSpecSchemaExcerpt(source);

    // marker - 800 clamps to 0 and marker + 5000 clamps to source.length.
    expect(excerpt).toBe(source);
  });

  test("falls back to the first 8000 chars when no marker is present", () => {
    const source = "C".repeat(10000);

    const excerpt = sliceSpecSchemaExcerpt(source);

    expect(excerpt.length).toBe(8000);
    expect(excerpt).toBe(source.slice(0, 8000));
  });
});
