/**
 * Integration tests for the Batch-G CLI commands added here — `crewhaus export
 * claude-plugin` (item 4) and `crewhaus serve --mcp` (item 1) — plus the item-10
 * default-registry help. The CLI is spawned as a child process (the entry file
 * runs an argv switch on import, so it cannot be called in-process), mirroring
 * `index.test.ts`. No model credentials are needed: `export` is pure emission,
 * and `serve` boots the projection + answers `initialize`/`tools/list` without
 * ever running an agent turn.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");
const VOICE_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-voice/crewhaus.yaml");

type RunResult = { exitCode: number; stdout: string; stderr: string };

/** Spawn the CLI, optionally feeding `stdin` (then EOF), and capture streams. */
async function runCli(
  args: ReadonlyArray<string>,
  opts: { cwd?: string; stdin?: string } = {},
): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

let tmp: string;
function freshTmp(): string {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-serve-export-test-"));
  return tmp;
}

describe("crewhaus export claude-plugin", () => {
  test("emits a well-formed plugin directory + reports the smoke check", async () => {
    const out = join(freshTmp(), "plugin");
    try {
      const r = await runCli([
        "export",
        "claude-plugin",
        CLI_SPEC,
        "--out",
        out,
        "--author",
        "Max",
      ]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("smoke check");
      expect(existsSync(join(out, ".claude-plugin/plugin.json"))).toBe(true);
      expect(existsSync(join(out, "README.md"))).toBe(true);
      expect(existsSync(join(out, "skills/hello/SKILL.md"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(out, ".claude-plugin/plugin.json"), "utf-8"));
      expect(manifest.name).toBe("hello");
      expect(manifest.author.name).toBe("Max");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite a non-empty out dir without --force", async () => {
    const out = join(freshTmp(), "plugin");
    try {
      expect((await runCli(["export", "claude-plugin", CLI_SPEC, "--out", out])).exitCode).toBe(0);
      const second = await runCli(["export", "claude-plugin", CLI_SPEC, "--out", out]);
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr + second.stdout).toContain("refusing to overwrite");
      const forced = await runCli(["export", "claude-plugin", CLI_SPEC, "--out", out, "--force"]);
      expect(forced.exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--help prints usage and exits 0", async () => {
    const r = await runCli(["export", "claude-plugin", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("export claude-plugin");
  });

  test("an unknown export target errors", async () => {
    const r = await runCli(["export", "nonsense"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("claude-plugin");
  });
});

describe("crewhaus serve --mcp", () => {
  test("--help prints usage and exits 0", async () => {
    const r = await runCli(["serve", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("serve --mcp");
  });

  test("requires --mcp", async () => {
    const r = await runCli(["serve", CLI_SPEC]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("--mcp");
  });

  test("rejects a non-cli target", async () => {
    const r = await runCli(["serve", "--mcp", VOICE_SPEC]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("supports target: cli");
  });

  test("errors on a missing spec path", async () => {
    const r = await runCli(["serve", "--mcp", join(REPO_ROOT, "does-not-exist.yaml")]);
    expect(r.exitCode).not.toBe(0);
  });

  test("boots stdio, answers initialize + tools/list on a clean stdout, exits on EOF", async () => {
    const requests = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    )}\n`;
    const r = await runCli(["serve", "--mcp", CLI_SPEC], { stdin: requests });
    expect(r.exitCode).toBe(0);

    // Every stdout line must be a valid JSON-RPC message — the agent's own
    // diagnostics ([memory]/[serve]/…) are redirected to stderr for stdio.
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const messages = lines.map((l) => JSON.parse(l));
    const init = messages.find((m) => m.id === 1);
    expect(init?.result?.serverInfo?.name).toBe("hello");
    const toolsList = messages.find((m) => m.id === 2);
    const toolNames: string[] = (toolsList?.result?.tools ?? []).map(
      (t: { name: string }) => t.name,
    );
    expect(toolNames).toContain("chat");

    // The serve diagnostics went to stderr, not the protocol channel.
    expect(r.stderr).toContain("[serve] MCP stdio server");
  });
});

describe("crewhaus run --plugins (item 3)", () => {
  // `--plugins <names>` reaches plugin activation before any model call: with no
  // trust anchors + allowUnsigned off (the clean-env default), the loader fails
  // CLOSED, which proves the override was threaded into activatePlugins (a spec
  // with no plugins: and no flag never constructs the loader).
  test("threads the override into activation (fails closed with no trust anchors)", async () => {
    const r = await runCli([
      "run",
      CLI_SPEC,
      "--plugins",
      "__definitely_not_installed__",
      "--prompt",
      "hi",
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("plugin-loader");
  });
});

describe("crewhaus plugins/templates default registry (item 10)", () => {
  // Bare `plugins` / `templates` (no action) prints the usage block.
  test("plugins usage documents the default public registry", async () => {
    const r = await runCli(["plugins"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("registry.crewhaus.ai/plugins");
  });
  test("templates usage documents the default public registry", async () => {
    const r = await runCli(["templates"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("registry.crewhaus.ai/templates");
  });
});
