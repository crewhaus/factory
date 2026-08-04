/**
 * Hangar F-2 — end-to-end proof of `crewhaus fleet --group`: membership
 * comes from the machine-wide harness registry (managed via `crewhaus
 * harness group`), and the fleet views drop non-members. Drives the real
 * entry file so the harness verb dispatch and the fleet filter are covered
 * together. Registry roots are injected via env so nothing touches the real
 * `~/.crewhaus`; stdout is read concurrently with the exit (the
 * flywheel.test.ts pattern — the Bun 1.3.x capture regression bites only
 * read-after-exit stdout).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-fleet-group-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, stdout };
}

function seedHarness(root: string, rel: string, name: string): string {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "crewhaus.yaml"),
    `name: ${name}\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: help\n`,
  );
  return dir;
}

describe("fleet --group (Hangar F-2)", () => {
  test("list/status keep only harnesses whose registry entry carries the group", async () => {
    const work = newTempRoot();
    const fleetRoot = join(work, "fleet");
    const alpha = seedHarness(fleetRoot, "alpha", "alpha");
    seedHarness(fleetRoot, "beta", "beta");
    const env = {
      CREWHAUS_REGISTRY_ROOT: join(work, "registry-root"),
      CREWHAUS_WATCHME_ROOT: join(work, "watchme-root"),
    };

    expect((await runCli(["harness", "add", alpha], work, env)).exitCode).toBe(0);
    expect((await runCli(["harness", "group", "blue", "--add", alpha], work, env)).exitCode).toBe(
      0,
    );

    // Unfiltered control: both harnesses discovered.
    const all = await runCli(["fleet", "list", "--root", fleetRoot], work, env);
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain("2 harness(es)");
    expect(all.stdout).toContain("• alpha");
    expect(all.stdout).toContain("• beta");

    // Group-scoped: beta (registered in no group) drops out.
    const scoped = await runCli(
      ["fleet", "list", "--root", fleetRoot, "--group", "blue"],
      work,
      env,
    );
    expect(scoped.exitCode).toBe(0);
    expect(scoped.stdout).toContain("1 harness(es)");
    expect(scoped.stdout).toContain("• alpha");
    expect(scoped.stdout).not.toContain("• beta");

    const status = await runCli(
      ["fleet", "status", "--root", fleetRoot, "--group", "blue"],
      work,
      env,
    );
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("fleet health — 1 harness(es)");
    expect(status.stdout).toContain("alpha");
    expect(status.stdout).not.toContain("beta");
  }, 120000);

  test("a group filter that empties the discovery says so explicitly", async () => {
    const work = newTempRoot();
    const fleetRoot = join(work, "fleet");
    seedHarness(fleetRoot, "alpha", "alpha");
    const env = {
      CREWHAUS_REGISTRY_ROOT: join(work, "registry-root"),
      CREWHAUS_WATCHME_ROOT: join(work, "watchme-root"),
    };
    const out = await runCli(
      ["fleet", "list", "--root", fleetRoot, "--group", "ghosts"],
      work,
      env,
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain('are in group "ghosts" (1 discovered');
  }, 60000);
});
