import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * The tools driven the way the runtime drives them: registered in a catalog,
 * dispatched through `executeTool`, which validates the input against the
 * declared schema and checks the permission patterns before calling execute.
 *
 * A tool that works when called directly but fails here is a tool the
 * runtime cannot actually use, which is why this file exists separately.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RegisteredTool, ToolCatalog } from "@crewhaus/tool-catalog";
import { executeTool } from "@crewhaus/tool-executor";
import { PKG_TOOLS } from "./index";

const originalCwd = process.cwd();
let catalog: ToolCatalog;
let workspace: string;

function lookup(name: string): RegisteredTool {
  const tool = catalog.get(name);
  if (!tool) throw new Error(`expected tool "${name}" to be registered`);
  return tool;
}

beforeEach(() => {
  catalog = new ToolCatalog();
  for (const tool of PKG_TOOLS) catalog.register(tool);
  workspace = mkdtempSync(join(tmpdir(), "crewhaus-pkg-int-"));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

describe("registration", () => {
  test("every tool registers without a name collision", () => {
    expect(catalog.list().length).toBe(PKG_TOOLS.length);
  });

  test("the catalog can find each one by name", () => {
    for (const tool of PKG_TOOLS) expect(catalog.has(tool.name)).toBe(true);
  });
});

describe("dispatch through executeTool", () => {
  test("a valid call returns a non-error result", async () => {
    const result = await executeTool(
      lookup("SemverResolve"),
      { range: "^1.0.0", versions: ["1.1.0", "2.0.0"] },
      { toolUseId: "t1" },
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("1.1.0");
  });

  test("input is validated before execute, so a bad type never reaches the tool", async () => {
    const result = await executeTool(
      lookup("SemverResolve"),
      { range: 42, versions: ["1.0.0"] },
      { toolUseId: "t2" },
    );
    expect(result.isError).toBe(true);
  });

  test("an empty version list is rejected by the schema", async () => {
    const result = await executeTool(
      lookup("SemverResolve"),
      { range: "^1.0.0", versions: [] },
      { toolUseId: "t3" },
    );
    expect(result.isError).toBe(true);
  });

  test("a containment escape is an error result, not a crash", async () => {
    const result = await executeTool(
      lookup("PackageTarballInspect"),
      { file: "../../etc/passwd" },
      { toolUseId: "t4" },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes the workspace");
  });

  test("every tool can be dispatched with a minimal valid input", async () => {
    writeFileSync(join(workspace, "package.json"), '{"name":"p","version":"1.0.0"}');
    writeFileSync(join(workspace, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}');
    mkdirSync(join(workspace, "package"), { recursive: true });
    writeFileSync(join(workspace, "package", "package.json"), "{}");
    execFileSync("tar", ["czf", join(workspace, "p.tgz"), "-C", workspace, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    mkdirSync(join(workspace, "node_modules", "x"), { recursive: true });
    writeFileSync(
      join(workspace, "node_modules", "x", "package.json"),
      '{"name":"x","version":"1.0.0","license":"MIT"}',
    );

    const inputs: Record<string, unknown> = {
      SemverResolve: { range: "*", versions: ["1.0.0"] },
      LockfileDiff: { before: "package-lock.json", after: "package-lock.json" },
      LicenseAggregate: {},
      PackageTarballInspect: { file: "p.tgz" },
      PackagePublishPreflight: {},
    };
    for (const tool of PKG_TOOLS) {
      const result = await executeTool(lookup(tool.name), inputs[tool.name], {
        toolUseId: `min-${tool.name}`,
      });
      expect({ name: tool.name, isError: result.isError }).toEqual({
        name: tool.name,
        isError: false,
      });
    }
  });
});

describe("the release check these exist for", () => {
  test("preflight passes a package whose tarball then turns out to be empty", async () => {
    // The two tools answer different questions, and this is why both exist.
    // Preflight reads the manifest and the tree; only the tarball knows what
    // was actually packed.
    mkdirSync(join(workspace, "dist"), { recursive: true });
    writeFileSync(join(workspace, "dist", "index.js"), "export {};");
    writeFileSync(join(workspace, "README.md"), "# p");
    writeFileSync(join(workspace, "LICENSE"), "MIT");
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        license: "MIT",
        main: "dist/index.js",
        files: ["dist"],
        repository: "git+https://example.invalid/p",
      }),
    );

    const pre = await executeTool(lookup("PackagePublishPreflight"), {}, { toolUseId: "r1" });
    expect(JSON.parse(pre.content).ok).toBe(true);

    // Now pack WITHOUT dist, the way a build that did not run would.
    mkdirSync(join(workspace, "package"), { recursive: true });
    writeFileSync(join(workspace, "package", "package.json"), "{}");
    execFileSync("tar", ["czf", join(workspace, "p.tgz"), "-C", workspace, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    const packed = await executeTool(
      lookup("PackageTarballInspect"),
      { file: "p.tgz", expect: ["package/dist"] },
      { toolUseId: "r2" },
    );
    expect(JSON.parse(packed.content).missing).toEqual(["package/dist"]);
  });
});
