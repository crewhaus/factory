/**
 * extension-path#1 end to end: a COMPILED cli bundle whose plugin contributes
 * a tool named after a first-party one boots, skips the plugin's tool, and
 * keeps the first-party definition.
 *
 * 0.7.0 registered plugin tools right after the extension boot — before
 * wireMemory registered continuity's FocusRead, PlanRead, … — so a plugin
 * tool named FocusRead made wireMemory's register throw "already registered"
 * and the bundle exit 1, while `crewhaus run` on the same spec skipped the
 * plugin tool as documented. The codegen order test in target-cli pins the
 * position; this one boots the bundle, so "boots" means it really did.
 *
 * Offline: stdin is closed, so the bundle boots, reads no line and exits
 * without a model call. Resolution follows the hybrid smoke: the pinned
 * package.json is removed and the in-tree packages are linked beside the
 * bundle, and bun runs with --no-install.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultPluginPaths } from "@crewhaus/plugin-loader";
import { createPluginRegistry } from "@crewhaus/plugin-registry";
import { type PluginManifest, entrypointDigest } from "@crewhaus/plugin-sdk";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_PATH = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// Two tools named after first-party ones the bundle registers AFTER the
// extension boot: continuity's FocusRead (wireMemory) and the sub-agent Task.
const ENTRY = `const tool = (name) => ({ name, description: "plugin " + name, jsonSchema: { type: "object", properties: {} }, inputSchema: { safeParse: (v) => ({ success: true, data: v }), parse: (v) => v }, execute: async () => "plugin" });
export default { contributions: { tools: [tool("FocusRead"), tool("Task")] } };\n`;

/** Install an unsigned plugin under `home` the way `crewhaus plugins install` would. */
async function installClash(home: string): Promise<void> {
  const { pluginsDir, registryPath } = defaultPluginPaths(home);
  const dir = join(pluginsDir, "clash");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.js"), ENTRY);
  const manifest: PluginManifest = {
    name: "clash",
    version: "1.0.0",
    entrypointDigest: entrypointDigest(new TextEncoder().encode(ENTRY)),
  };
  const sourcePath = join(dir, "plugin.json");
  writeFileSync(sourcePath, JSON.stringify(manifest));
  await createPluginRegistry({ registryPath, allowUnsigned: true }).register({
    manifest,
    sourcePath,
  });
}

function linkWorkspacePackages(bundleDir: string): void {
  for (const entry of readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(REPO_ROOT, "packages", entry.name);
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (name === undefined || !name.startsWith("@crewhaus/")) continue;
    const dest = join(bundleDir, "node_modules", name);
    mkdirSync(dirname(dest), { recursive: true });
    if (!existsSync(dest)) symlinkSync(dir, dest, "dir");
  }
}

const SPEC = [
  "name: plugin-clash",
  "target: cli",
  "agent:",
  // Never called: stdin is closed, so the bundle reads no turn.
  "  model: local/stub@http://127.0.0.1:9/v1",
  "  instructions: be helpful",
  "  sub_agents:",
  "    helper:",
  "      description: helps",
  "      instructions: help",
  "plugins:",
  "  - clash",
  "",
].join("\n");

describe("a compiled cli bundle whose plugin reuses a first-party tool name (extension-path#1)", () => {
  test("boots, skips the plugin's FocusRead and Task, and exits 0", async () => {
    const home = tmp("crewhaus-plugin-clash-home-");
    await installClash(home);
    writeFileSync(join(home, "crewhaus.yaml"), SPEC);
    const env = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      CREWHAUS_NO_REGISTRY: "1",
      CREWHAUS_PLUGIN_ALLOW_UNSIGNED: "1",
      CREWHAUS_SESSION_DIR: join(home, "sessions"),
    };
    const out = tmp("crewhaus-plugin-clash-out-");
    const compiled = Bun.spawnSync(
      [process.execPath, CLI_PATH, "compile", "crewhaus.yaml", "--no-register", "-o", out],
      { cwd: home, env },
    );
    expect(compiled.stderr.toString()).not.toContain("error");
    expect(compiled.exitCode).toBe(0);
    // The fixture exercises the continuity path (default on): FocusRead is
    // wireMemory's, and Task is the sub-agent tool.
    const agentTs = readFileSync(join(out, "agent.ts"), "utf8");
    expect(agentTs).toContain("await wireMemory(");
    expect(agentTs).toContain("createTaskTool(");

    rmSync(join(out, "package.json"), { force: true });
    linkWorkspacePackages(out);
    const proc = Bun.spawn([process.execPath, "--no-install", join(out, "agent.ts")], {
      cwd: home,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).not.toContain("already registered\n    at");
    expect(stderr).not.toContain("ToolCatalogError");
    expect(stderr).toContain(
      '[plugins] tool "FocusRead" already registered — plugin contribution skipped',
    );
    expect(stderr).toContain(
      '[plugins] tool "Task" already registered — plugin contribution skipped',
    );
    expect(exitCode).toBe(0);
  }, 120_000);
});
