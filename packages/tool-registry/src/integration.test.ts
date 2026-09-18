/**
 * The tools driven the way the runtime drives them, and the loop they exist
 * to close: ask the registry what is newest, write one answer back into the
 * manifest, ask again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { REGISTRY_TOOLS, _setRegistryFetch } from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

function serve(routes: Record<string, unknown>): void {
  _setRegistryFetch(async (req) => {
    const route = routes[req.url];
    return route === undefined
      ? new Response(`{"message":"not found"}`, { status: 404 })
      : new Response(JSON.stringify(route), { status: 200 });
  });
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of REGISTRY_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-registry-int-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
  _setRegistryFetch(undefined);
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(REGISTRY_TOOLS.length);
  });

  test("the catalog refuses a second registration of the same name", () => {
    // The whole reason RegistryOutdated is not called DependencyOutdated: the
    // catalog throws on the second one, at boot, for every harness.
    expect(() => catalog.register(REGISTRY_TOOLS[0] as RegisteredTool)).toThrow();
  });
});

describe("dispatch through executeTool", () => {
  test("every tool can be dispatched with a minimal valid input", async () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { a: "^1.0.0" } }),
    );
    serve({
      "https://registry.npmjs.org/a": {
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { version: "1.0.0" } },
      },
      "https://registry.npmjs.org/-/v1/search?text=a&size=10": { total: 0, objects: [] },
    });
    const inputs: Record<string, unknown> = {
      RegistryPackageInfo: { ecosystem: "npm", name: "a" },
      RegistrySearch: { ecosystem: "npm", query: "a" },
      RegistryOutdated: {},
      ManifestDependencySet: {
        manifest: "package.json",
        edits: [{ name: "a", spec: "1.0.0" }],
        dryRun: true,
      },
    };
    for (const tool of REGISTRY_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });

  test("an input the schema rejects never reaches the tool", async () => {
    const result = await executeTool(
      lookup("RegistryPackageInfo"),
      { ecosystem: "maven", name: "junit" },
      { toolUseId: "bad-ecosystem" },
    );
    expect(result.isError).toBe(true);
  });

  test("a path outside the workspace comes back as an error result", async () => {
    const result = await executeTool(
      lookup("ManifestDependencySet"),
      { manifest: "../../etc/package.json", edits: [{ name: "a", spec: "1.0.0" }] },
      { toolUseId: "escape" },
    );
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("escapes the workspace root");
  });
});

describe("the loop these exist to close", () => {
  const cargo = `[package]
name = "demo"
version = "0.1.0"

[dependencies]
# anyhow is here for the error type, not for anything clever.
anyhow = "^1.0.75"
serde = { version = "1.0.190", features = ["derive"] }
`;

  test("find the drift, write one version back, and find nothing the second time", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), cargo);
    serve({
      "https://crates.io/api/v1/crates/anyhow": {
        crate: { name: "anyhow", max_stable_version: "1.0.86" },
        versions: [
          { num: "1.0.86", yanked: false, created_at: "2026-05-01T00:00:00Z" },
          { num: "1.0.75", yanked: false },
        ],
      },
      "https://crates.io/api/v1/crates/serde": {
        crate: { name: "serde", max_stable_version: "1.0.190" },
        versions: [{ num: "1.0.190", yanked: false }],
      },
    });

    // 1. What is behind?
    const before = await executeTool(lookup("RegistryOutdated"), {}, { toolUseId: "o1" });
    expect(before.isError).toBe(false);
    const drift = JSON.parse(String(before.content)) as Record<string, unknown>;
    expect(drift).toMatchObject({ ecosystem: "crates", checked: 2, outdatedCount: 0 });
    // `^1.0.75` still admits 1.0.86, so nothing is OUTDATED — but `wanted`
    // says an install would move, which is the actionable part.
    const anyhow = (drift["rows"] as Array<Record<string, unknown>>).find(
      (row) => row["name"] === "anyhow",
    );
    expect(anyhow).toMatchObject({ current: "^1.0.75", wanted: "1.0.86", latest: "1.0.86" });

    // 2. Write the floor forward, keeping the caret the author chose.
    const write = await executeTool(
      lookup("ManifestDependencySet"),
      { manifest: "Cargo.toml", edits: [{ name: "anyhow", spec: "1.0.86" }] },
      { toolUseId: "w1" },
    );
    expect(write.isError).toBe(false);
    const report = JSON.parse(String(write.content)) as Record<string, unknown>;
    expect((report["edits"] as Array<Record<string, unknown>>)[0]).toMatchObject({
      from: "^1.0.75",
      to: "^1.0.86",
      stylePreserved: true,
      spelling: "tomlString",
    });

    // 3. The file changed by exactly one version string.
    const after = readFileSync(join(workspace, "Cargo.toml"), "utf-8");
    expect(after).toBe(cargo.replace('anyhow = "^1.0.75"', 'anyhow = "^1.0.86"'));
    expect(after).toContain("# anyhow is here for the error type");

    // 4. Asking again agrees with the manifest.
    const again = await executeTool(lookup("RegistryOutdated"), {}, { toolUseId: "o2" });
    const settled = JSON.parse(String(again.content)) as Record<string, unknown>;
    const row = (settled["rows"] as Array<Record<string, unknown>>).find(
      (r) => r["name"] === "anyhow",
    );
    expect(row).toMatchObject({ current: "^1.0.86", wanted: "1.0.86", upToDate: true });
  });

  test("a refusal is a result the caller can read, not a thrown error", async () => {
    const before = `[dependencies]\nmine = { git = "https://example.invalid/mine" }\n`;
    writeFileSync(join(workspace, "Cargo.toml"), before);
    const result = await executeTool(
      lookup("ManifestDependencySet"),
      { manifest: "Cargo.toml", edits: [{ name: "mine", spec: "2.0.0" }] },
      { toolUseId: "refuse" },
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain("refused the whole edit");
    expect(readFileSync(join(workspace, "Cargo.toml"), "utf-8")).toBe(before);
  });
});
