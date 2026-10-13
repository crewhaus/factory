/**
 * Importing the adapter never runs `claude --version`.
 *
 * The version probe ran at module load, and every `crewhaus` command loads
 * this package (the CLI reaches it through @crewhaus/runtime-core). So on a
 * machine without the claude CLI — CI's runners among them — `crewhaus
 * compile` and `crewhaus tools show` spent up to a second in the probe and
 * printed "[adapter-anthropic] could not detect installed claude CLI version"
 * ahead of their own output. The probe now runs the first time the OAuth
 * identity headers are read, once per process.
 *
 * Each case is a fresh process, so the module is really loaded for the first
 * time, and a fake `claude` on PATH counts every probe it serves.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const clientPath = join(import.meta.dir, "client.ts");
const scratch = mkdtempSync(join(tmpdir(), "adapter-anthropic-probe-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type ChildReport = {
  probesAtImport: number;
  probesAfterUse: number;
  userAgents: string[];
  warnings: { phase: string; message: string }[];
};

/** Load the module in a fresh process whose PATH is exactly `pathDir`. */
function loadInFreshProcess(pathDir: string, marker: string): ChildReport {
  const script = `
    import { existsSync, readFileSync } from "node:fs";
    const marker = ${JSON.stringify(marker)};
    const probes = () =>
      existsSync(marker) ? readFileSync(marker, "utf8").split("\\n").filter(Boolean).length : 0;
    let phase = "import";
    const warnings = [];
    console.warn = (...args) => warnings.push({ phase, message: String(args[0]) });
    const mod = await import(${JSON.stringify(clientPath)});
    const probesAtImport = probes();
    phase = "use";
    const userAgents = [
      mod.CLAUDE_CODE_HEADERS["user-agent"],
      mod.CLAUDE_CODE_HEADERS["user-agent"],
      { ...mod.CLAUDE_CODE_HEADERS }["user-agent"],
    ];
    console.log(JSON.stringify({ probesAtImport, probesAfterUse: probes(), userAgents, warnings }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], {
    env: { PATH: pathDir, HOME: scratch },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.toString();
  if (child.exitCode !== 0) {
    throw new Error(`child exited ${child.exitCode}: ${child.stderr.toString()}`);
  }
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as ChildReport;
}

describe("the claude CLI version is probed on first use, not at import", () => {
  test("an installed claude is asked once, when the headers are first read", () => {
    const bin = join(scratch, "with-claude");
    mkdirSync(bin);
    const marker = join(scratch, "with-claude.calls");
    const fake = join(bin, "claude");
    writeFileSync(fake, `#!/bin/sh\necho probe >> '${marker}'\necho '9.8.7 (Claude Code)'\n`);
    chmodSync(fake, 0o755);

    const report = loadInFreshProcess(bin, marker);
    expect(report.probesAtImport).toBe(0);
    expect(report.probesAfterUse).toBe(1);
    expect(report.userAgents).toEqual([
      "claude-cli/9.8.7 (external, cli)",
      "claude-cli/9.8.7 (external, cli)",
      "claude-cli/9.8.7 (external, cli)",
    ]);
    expect(report.warnings).toEqual([]);
  }, 20_000);

  test("with no claude installed, the import is silent and the fallback warns once, on use", () => {
    const bin = join(scratch, "without-claude");
    mkdirSync(bin);
    const report = loadInFreshProcess(bin, join(scratch, "without-claude.calls"));
    expect(report.warnings.filter((w) => w.phase === "import")).toEqual([]);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]?.phase).toBe("use");
    expect(report.warnings[0]?.message).toContain("could not detect installed claude CLI version");
    for (const ua of report.userAgents) {
      expect(ua).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
    }
  }, 20_000);
});
