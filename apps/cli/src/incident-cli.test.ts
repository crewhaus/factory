/**
 * Item 32 — `crewhaus incident collect --session <id>` CLI surface. Seeds a
 * real session event-log + audit chain in a tmp cwd, runs the command, and
 * asserts the assembled bundle (files + index.html + audit-window join).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

let cwd = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "incident-cli-test-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

async function runCli(
  args: ReadonlyArray<string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** Seed a session event-log using the real @crewhaus/event-log writer. */
async function seedSession(sessionId: string): Promise<void> {
  const { openEventLog } = await import("@crewhaus/event-log");
  const log = await openEventLog(sessionId, { rootDir: join(cwd, ".crewhaus", "sessions") });
  await log.append({ kind: "user_message", payload: { text: "hi" } });
  await log.append({
    kind: "cost_accrual",
    payload: { modelId: "claude-sonnet-4-5", costUsdMicros: 2_000_000 },
  });
  await log.append({ kind: "assistant_message", payload: { text: "hello" } });
  await log.close();
}

/** Seed one audit record via the real @crewhaus/audit-log writer. */
async function seedAudit(): Promise<void> {
  const { openAuditLog } = await import("@crewhaus/audit-log");
  const audit = await openAuditLog({ rootDir: join(cwd, ".crewhaus", "audit") });
  await audit.append({ kind: "deployment_action", payload: { action: "promote", name: "x" } });
}

const SESSION_ID = "sess_00000000deadbeef";

describe("crewhaus incident collect", () => {
  test("--session required", async () => {
    const res = await runCli(["incident", "collect"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--session");
  });

  test("unknown action is rejected", async () => {
    const res = await runCli(["incident", "explode"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('must be "collect"');
  });

  test("assembles a bundle from a seeded session + audit", async () => {
    await seedSession(SESSION_ID);
    await seedAudit();
    const res = await runCli([
      "incident",
      "collect",
      "--session",
      SESSION_ID,
      "--kind",
      "circuit_open",
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("collected circuit_open");

    const incidentsRoot = join(cwd, ".crewhaus", "incidents");
    const dirs = readdirSync(incidentsRoot);
    expect(dirs).toHaveLength(1);
    const bundleDir = join(incidentsRoot, dirs[0] as string);
    expect(dirs[0]).toContain("-circuit_open");

    // All expected files present.
    for (const f of [
      "bundle.json",
      "events.jsonl",
      "transcript.jsonl",
      "audit.jsonl",
      "cost.json",
      "spec.json",
      "doctor.txt",
      "index.html",
    ]) {
      expect(existsSync(join(bundleDir, f))).toBe(true);
    }

    // Manifest carries the counts + the cost summary.
    const manifest = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf-8"));
    expect(manifest.kind).toBe("circuit_open");
    expect(manifest.counts.transcriptEntries).toBe(3);
    expect(manifest.cost.totalUsdMicros).toBe(2_000_000);

    // The audit record fell in the session window, so it joined.
    const auditLines = readFileSync(join(bundleDir, "audit.jsonl"), "utf-8").trim();
    expect(auditLines).not.toBe("");
    expect(auditLines).toContain("deployment_action");

    // index.html is the eval-report shell.
    const html = readFileSync(join(bundleDir, "index.html"), "utf-8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Incident — circuit_open");
  });

  test("rejects an unknown --kind", async () => {
    await seedSession(SESSION_ID);
    const res = await runCli(["incident", "collect", "--session", SESSION_ID, "--kind", "bogus"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--kind must be one of");
  });

  test("an empty/missing session fails cleanly", async () => {
    // No session seeded — openEventLog on a nonexistent session yields no events.
    mkdirSync(join(cwd, ".crewhaus", "sessions"), { recursive: true });
    const res = await runCli(["incident", "collect", "--session", SESSION_ID]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/no events|could not read/);
  });
});
