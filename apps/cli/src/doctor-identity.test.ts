/**
 * Loop contract 0.4 (Batch C, item 4) — `crewhaus doctor` surfaces this
 * project's agent identity fingerprint (the `agentId` stamped onto every trace
 * envelope + audit record). Read-only: doctor never mints one. Drives the real
 * CLI over a tmp cwd with/without/with-a-corrupt identity file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

let cwd = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "doctor-identity-test-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

async function runDoctor(): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, "doctor"], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, stdout };
}

function writeIdentity(contents: string): void {
  const dir = join(cwd, ".crewhaus");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "identity.json"), contents);
}

const AGENT_ID = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("crewhaus doctor — agent identity line", () => {
  test("shows the agentId fingerprint when the identity file exists", async () => {
    writeIdentity(
      JSON.stringify({
        schemaVersion: 1,
        agentId: AGENT_ID,
        algorithm: "ed25519",
        publicKey: "x",
        privateKey: "y",
        createdAt: "2026-07-17T00:00:00.000Z",
      }),
    );
    const { stdout } = await runDoctor();
    expect(stdout).toContain("agent identity:");
    expect(stdout).toContain(AGENT_ID);
    expect(stdout).toContain("ed25519");
  });

  test("reports 'not yet minted' when absent — and NEVER mints one (read-only)", async () => {
    const { stdout } = await runDoctor();
    expect(stdout).toContain("agent identity: not yet minted");
    // doctor must not have written an identity file.
    expect(existsSync(join(cwd, ".crewhaus", "identity.json"))).toBe(false);
  });

  test("flags a corrupt identity file", async () => {
    writeIdentity("{ not valid json");
    const { stdout } = await runDoctor();
    expect(stdout).toContain("agent identity:");
    expect(stdout).toContain("unreadable or malformed");
  });
});
