#!/usr/bin/env bun
/**
 * Section 40 template-marketplace-client smoke.
 *
 * Probes:
 *   A) seed a local registry, search by query/target/author, get
 *      ranked results
 *   B) install a template into the workspace at <workspaceDir>/<name>/
 *      crewhaus.yaml; honors custom subdir+filename
 *   C) T8 — install refuses path-traversal in name / subdir / filename
 *   D) publish draft: draftPublish + writeDraft persist to
 *      <workspace>/templates/<name>.json
 *   E) end-to-end install-then-compile (verifying the YAML actually
 *      compiles via the §1 compiler is out of scope for this smoke;
 *      we only verify the file landed and is readable as YAML-shaped
 *      text).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketplaceClient, MarketplacePublisher } from "@crewhaus/template-marketplace-client";
import { LocalRegistrySource } from "@crewhaus/template-registry";

const log = (s: string) => process.stdout.write(`[section-40-marketplace] ${s}\n`);
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  if (ok) log(`✓ ${name}`);
  else {
    log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const tmp = mkdtempSync(join(tmpdir(), "section-40-marketplace-smoke-"));
const registryDir = join(tmp, "registry");
const workspace = join(tmp, "workspace");

const seed = (
  overrides: { name: string; target?: string; author?: string; description?: string } & {
    yaml?: string;
  },
) => ({
  name: overrides.name,
  version: "1.0.0",
  description: overrides.description ?? `${overrides.name} description`,
  author: overrides.author ?? "alice",
  target: overrides.target ?? "cli",
  yaml:
    overrides.yaml ??
    `name: ${overrides.name}\ntarget: ${overrides.target ?? "cli"}\nagent:\n  model: claude-sonnet-4-6\n`,
});

const registry = new LocalRegistrySource({ rootDir: registryDir });
registry.put(seed({ name: "hello-cli", description: "Hello-world CLI agent" }));
registry.put(
  seed({ name: "slack-bot", target: "channel", author: "bob", description: "Slack channel agent" }),
);
registry.put(
  seed({
    name: "rag-search",
    target: "pipeline",
    author: "carol",
    description: "RAG retrieval pipeline",
  }),
);

const client = new MarketplaceClient({ registry, workspaceDir: workspace });

// ── Probe A: search ──────────────────────────────────────────────────────
log("probe A: search by query / target / author");
{
  const byQuery = await client.search({ query: "RAG" });
  check(
    "query 'RAG' matches rag-search",
    byQuery.length === 1 && byQuery[0]?.metadata.name === "rag-search",
  );
  const byTarget = await client.search({ target: "channel" });
  check(
    "target=channel matches slack-bot",
    byTarget.length === 1 && byTarget[0]?.metadata.name === "slack-bot",
  );
  const byAuthor = await client.search({ author: "alice" });
  check(
    "author=alice matches hello-cli",
    byAuthor.length === 1 && byAuthor[0]?.metadata.name === "hello-cli",
  );
}

// ── Probe B: install ─────────────────────────────────────────────────────
log("probe B: install into workspace at <name>/crewhaus.yaml");
{
  const result = await client.install("hello-cli");
  check(
    "install path is <workspace>/hello-cli/crewhaus.yaml",
    result.path === join(workspace, "hello-cli", "crewhaus.yaml"),
  );
  check("file exists on disk", existsSync(result.path));
  const content = readFileSync(result.path, "utf8");
  check("YAML contains target: cli", content.includes("target: cli"));
}
{
  const result = await client.install("slack-bot", { subdir: "my-bot", filename: "spec.yaml" });
  check("custom subdir+filename honored", result.path.endsWith(join("my-bot", "spec.yaml")));
}

// ── Probe C: T8 path-traversal refusal ───────────────────────────────────
log("probe C: T8 — install refuses path-traversal");
{
  let traversedName = false;
  try {
    await client.install("../escape");
  } catch {
    traversedName = true;
  }
  check("name with .. is refused", traversedName);
  let traversedSubdir = false;
  try {
    await client.install("hello-cli", { subdir: "../escape" });
  } catch {
    traversedSubdir = true;
  }
  check("subdir with .. is refused", traversedSubdir);
  let traversedFilename = false;
  try {
    await client.install("hello-cli", { filename: "../passwd" });
  } catch {
    traversedFilename = true;
  }
  check("filename with .. is refused", traversedFilename);
}

// ── Probe D: publish draft ──────────────────────────────────────────────
log("probe D: publish draft + writeDraft persistence");
{
  const publisher = new MarketplacePublisher();
  const draft = publisher.draftPublish({
    registryName: "crewhaus/templates",
    manifest: {
      name: "my-new-template",
      version: "1.0.0",
      description: "A new template",
      author: "smoke",
      target: "cli",
      yaml: "name: my-new\ntarget: cli\n",
    },
  });
  check(
    "draft title contains template name + version",
    draft.title.includes("my-new-template") && draft.title.includes("v1.0.0"),
  );
  check("draft body has Author: line", draft.body.includes("**Author:** smoke"));
  check("manifestJson is parseable", JSON.parse(draft.manifestJson).name === "my-new-template");
  const path = publisher.writeDraft(workspace, draft);
  check(
    "writeDraft persists to <workspace>/templates/<name>.json",
    path === join(workspace, "templates", "my-new-template.json"),
  );
  check("draft file exists", existsSync(path));
}

rmSync(tmp, { recursive: true, force: true });

if (failed === 0) {
  log("ALL PROBES PASSED");
  process.exit(0);
}
log(`FAILED: ${failed} probe(s)`);
process.exit(1);
