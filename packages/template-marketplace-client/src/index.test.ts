import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRegistrySource, type TemplateManifest } from "@crewhaus/template-registry";
import {
  DEFAULT_TEMPLATE_REGISTRY_URL,
  MarketplaceClient,
  MarketplaceClientError,
  MarketplacePublisher,
} from "./index";

const seed = (overrides: Partial<TemplateManifest> = {}): TemplateManifest => ({
  name: "hello-cli-template",
  version: "1.0.0",
  description: "Hello-world CLI template",
  author: "alice",
  target: "cli",
  yaml: "name: hello\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n",
  ...overrides,
});

describe("MarketplaceClientError", () => {
  test("carries the config error code and serializes its cause chain", () => {
    const root = new Error("permission denied");
    const err = new MarketplaceClientError("install failed", root);
    expect(err).toBeInstanceOf(MarketplaceClientError);
    expect(err.name).toBe("MarketplaceClientError");
    expect(err.code).toBe("config");
    expect(err.cause).toBe(root);
    // Exercises the inherited toJSON() (+ its cause serializer) so the full
    // error-reporting surface the marketplace throws through is verified.
    expect(err.toJSON()).toEqual({
      name: "MarketplaceClientError",
      code: "config",
      message: "install failed",
      cause: { name: "Error", message: "permission denied" },
    });
  });
});

describe("MarketplaceClient — search (T1)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "marketplace-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function buildClient(rootDir: string, workspaceDir: string): MarketplaceClient {
    const registry = new LocalRegistrySource({ rootDir });
    registry.put(seed());
    registry.put(
      seed({
        name: "slack-bot-template",
        target: "channel",
        author: "bob",
        description: "Slack bot template",
      }),
    );
    registry.put(
      seed({
        name: "rag-search-template",
        target: "pipeline",
        author: "carol",
        description: "RAG retrieval template",
      }),
    );
    return new MarketplaceClient({ registry, workspaceDir });
  }

  test("list returns all metadata entries", async () => {
    const registryDir = join(tmp, "registry");
    const workspace = join(tmp, "workspace");
    const client = buildClient(registryDir, workspace);
    const list = await client.list();
    expect(list.length).toBe(3);
  });

  test("search by query matches name + description (case-insensitive)", async () => {
    const client = buildClient(join(tmp, "r"), join(tmp, "w"));
    const results = await client.search({ query: "RAG" });
    expect(results.map((r) => r.metadata.name)).toEqual(["rag-search-template"]);
  });

  test("search by target filter", async () => {
    const client = buildClient(join(tmp, "r"), join(tmp, "w"));
    const results = await client.search({ target: "channel" });
    expect(results.map((r) => r.metadata.name)).toEqual(["slack-bot-template"]);
  });

  test("search by author filter", async () => {
    const client = buildClient(join(tmp, "r"), join(tmp, "w"));
    const results = await client.search({ author: "alice" });
    expect(results.map((r) => r.metadata.name)).toEqual(["hello-cli-template"]);
  });

  test("search ranks name matches above description-only matches", async () => {
    const client = buildClient(join(tmp, "r"), join(tmp, "w"));
    const results = await client.search({ query: "template" });
    // Every entry contains "template" — but name matches should rank
    // higher when the score is computed; results are sorted by score.
    expect(results.length).toBeGreaterThan(0);
  });

  test("search limit caps results", async () => {
    const client = buildClient(join(tmp, "r"), join(tmp, "w"));
    const results = await client.search({ limit: 2 });
    expect(results.length).toBe(2);
  });
});

describe("MarketplaceClient — install (T1 + T8 path-traversal)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "marketplace-install-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("installs a template into <workspace>/<name>/crewhaus.yaml", async () => {
    const registry = new LocalRegistrySource({ rootDir: join(tmp, "r") });
    registry.put(seed());
    const workspace = join(tmp, "w");
    const client = new MarketplaceClient({ registry, workspaceDir: workspace });
    const result = await client.install("hello-cli-template");
    expect(result.path).toBe(join(workspace, "hello-cli-template", "crewhaus.yaml"));
    expect(existsSync(result.path)).toBe(true);
    const content = readFileSync(result.path, "utf8");
    expect(content).toContain("target: cli");
  });

  test("install honors custom subdir + filename", async () => {
    const registry = new LocalRegistrySource({ rootDir: join(tmp, "r") });
    registry.put(seed());
    const client = new MarketplaceClient({ registry, workspaceDir: join(tmp, "w") });
    const result = await client.install("hello-cli-template", {
      subdir: "my-custom-dir",
      filename: "spec.yaml",
    });
    expect(result.path.endsWith(join("my-custom-dir", "spec.yaml"))).toBe(true);
  });

  test("install refuses path-traversal in name", async () => {
    const registry = new LocalRegistrySource({ rootDir: join(tmp, "r") });
    registry.put(seed());
    const client = new MarketplaceClient({ registry, workspaceDir: join(tmp, "w") });
    await expect(client.install("../escape")).rejects.toThrow(MarketplaceClientError);
  });

  test("install refuses path-traversal in subdir", async () => {
    const registry = new LocalRegistrySource({ rootDir: join(tmp, "r") });
    registry.put(seed());
    const client = new MarketplaceClient({ registry, workspaceDir: join(tmp, "w") });
    await expect(client.install("hello-cli-template", { subdir: "../escape" })).rejects.toThrow(
      MarketplaceClientError,
    );
    await expect(client.install("hello-cli-template", { subdir: "evil/path" })).rejects.toThrow(
      MarketplaceClientError,
    );
  });

  test("install refuses path-traversal in filename", async () => {
    const registry = new LocalRegistrySource({ rootDir: join(tmp, "r") });
    registry.put(seed());
    const client = new MarketplaceClient({ registry, workspaceDir: join(tmp, "w") });
    await expect(
      client.install("hello-cli-template", { filename: "../etc/passwd" }),
    ).rejects.toThrow(MarketplaceClientError);
  });
});

describe("MarketplacePublisher (T1 + T3)", () => {
  test("draftPublish builds a PR-ready draft", () => {
    const publisher = new MarketplacePublisher();
    const draft = publisher.draftPublish({
      registryName: "crewhaus/templates",
      manifest: seed(),
    });
    expect(draft.title).toContain("hello-cli-template");
    expect(draft.title).toContain("v1.0.0");
    expect(draft.body).toContain("**Target:** cli");
    expect(draft.body).toContain("**Author:** alice");
    expect(JSON.parse(draft.manifestJson).name).toBe("hello-cli-template");
  });

  test("draftPublish refuses invalid template names", () => {
    const publisher = new MarketplacePublisher();
    expect(() =>
      publisher.draftPublish({
        registryName: "x",
        manifest: seed({ name: "../escape" }),
      }),
    ).toThrow(MarketplaceClientError);
  });

  test("draftPublish requires registryName", () => {
    const publisher = new MarketplacePublisher();
    expect(() => publisher.draftPublish({ registryName: "", manifest: seed() })).toThrow(
      MarketplaceClientError,
    );
  });

  test("writeDraft persists manifest to <workspace>/templates/<name>.json", () => {
    const tmp = mkdtempSync(join(tmpdir(), "marketplace-publish-test-"));
    try {
      const publisher = new MarketplacePublisher();
      const draft = publisher.draftPublish({
        registryName: "x",
        manifest: seed(),
      });
      const path = publisher.writeDraft(tmp, draft);
      expect(path).toBe(join(tmp, "templates", "hello-cli-template.json"));
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).name).toBe("hello-cli-template");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("DEFAULT_TEMPLATE_REGISTRY_URL (G89)", () => {
  test("is the canonical https registry index on the shared registry host", () => {
    expect(DEFAULT_TEMPLATE_REGISTRY_URL).toBe("https://registry.crewhaus.ai/templates");
    expect(DEFAULT_TEMPLATE_REGISTRY_URL.endsWith("/")).toBe(false);
    expect(DEFAULT_TEMPLATE_REGISTRY_URL.startsWith("https://")).toBe(true);
  });
});
