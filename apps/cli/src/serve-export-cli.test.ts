/**
 * Integration tests for the Batch-G CLI commands added here — `crewhaus export
 * claude-plugin` (item 4) and `crewhaus serve --mcp` (item 1) — plus the item-10
 * default-registry help. The CLI is spawned as a child process (the entry file
 * runs an argv switch on import, so it cannot be called in-process), mirroring
 * `index.test.ts`. No model credentials are needed: `export` is pure emission,
 * and `serve` boots the projection + answers `initialize`/`tools/list` without
 * ever running an agent turn.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");
const VOICE_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-voice/crewhaus.yaml");

type RunResult = { exitCode: number; stdout: string; stderr: string };

/**
 * Default spawn cwd. `serve --mcp` opens an audit chain under
 * `<cwd>/.crewhaus/audit`, so defaulting to the repo root wrote into the
 * operator's checkout — invisibly, since `.gitignore` hides `.crewhaus/`.
 * Nothing here reads the cwd otherwise: specs are passed as absolute paths and
 * authored assets resolve beside the SPEC, not beside the process.
 */
const SPAWN_CWD = mkdtempSync(join(tmpdir(), "crewhaus-serve-export-cwd-"));
afterAll(() => {
  rmSync(SPAWN_CWD, { recursive: true, force: true });
});

/** Spawn the CLI, optionally feeding `stdin` (then EOF), and capture streams. */
async function runCli(
  args: ReadonlyArray<string>,
  opts: { cwd?: string; stdin?: string } = {},
): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: opts.cwd ?? SPAWN_CWD,
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

  /**
   * Item 14 — a harness that ships hand-written skills + slash commands used to
   * export a strictly SMALLER agent than itself: the only skill emitted was the
   * one synthesized from `agent.instructions`, and no `commands/` dir existed.
   * The assets are resolved beside the SPEC (the standalone-harness convention),
   * not from the process cwd — which is why the CLI here can run from the
   * default sandbox cwd and still find them.
   */
  describe("authored .crewhaus/ assets", () => {
    const SKILL = "---\nname: research-topic\ndescription: corroborate claims\n---\n\nCite two.\n";
    const COMMAND =
      "---\ndescription: browse the web\nargument-hint: <topic>\n---\n/browse $ARGUMENTS\n";

    /** A throwaway harness dir: spec + authored skills/commands beside it. */
    function freshHarness(extra: Record<string, string> = {}): string {
      const dir = join(freshTmp(), "harness");
      const files: Record<string, string> = {
        "crewhaus.yaml":
          "name: hello\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: Be helpful.\n",
        ".crewhaus/skills/research-topic/SKILL.md": SKILL,
        ".crewhaus/skills/research-topic/references/checklist.md": "- [ ] two sources\n",
        ".crewhaus/commands/browse.md": COMMAND,
        ...extra,
      };
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      return dir;
    }

    test("authored skills and commands travel into the exported plugin", async () => {
      const harness = freshHarness();
      const out = join(tmp, "plugin");
      try {
        const r = await runCli([
          "export",
          "claude-plugin",
          join(harness, "crewhaus.yaml"),
          "-o",
          out,
        ]);
        expect(r.exitCode).toBe(0);
        // The projection of agent.instructions still ships…
        expect(existsSync(join(out, "skills/hello/SKILL.md"))).toBe(true);
        // …and so does everything the harness author wrote, byte-for-byte.
        expect(readFileSync(join(out, "skills/research-topic/SKILL.md"), "utf-8")).toBe(SKILL);
        expect(
          readFileSync(join(out, "skills/research-topic/references/checklist.md"), "utf-8"),
        ).toBe("- [ ] two sources\n");
        expect(readFileSync(join(out, "commands/browse.md"), "utf-8")).toBe(COMMAND);
        expect(r.stdout).toContain("1 authored skill + 1 authored command");
        expect(readFileSync(join(out, "README.md"), "utf-8")).toContain("## Authored assets");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    test("--no-assets emits the spec projection alone", async () => {
      const harness = freshHarness();
      const out = join(tmp, "plugin");
      try {
        const r = await runCli([
          "export",
          "claude-plugin",
          join(harness, "crewhaus.yaml"),
          "-o",
          out,
          "--no-assets",
        ]);
        expect(r.exitCode).toBe(0);
        expect(existsSync(join(out, "skills/hello/SKILL.md"))).toBe(true);
        expect(existsSync(join(out, "commands"))).toBe(false);
        expect(existsSync(join(out, "skills/research-topic"))).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    test("an authored SKILL.md Claude Code could not load fails the export", async () => {
      const harness = freshHarness({ ".crewhaus/skills/broken/SKILL.md": "no frontmatter here\n" });
      const out = join(tmp, "plugin");
      try {
        const r = await runCli([
          "export",
          "claude-plugin",
          join(harness, "crewhaus.yaml"),
          "-o",
          out,
        ]);
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr + r.stdout).toContain("unusable authored asset");
        expect(r.stderr + r.stdout).toContain("--no-assets");
        // Nothing is written when the export refuses.
        expect(existsSync(out)).toBe(false);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
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
