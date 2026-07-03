/**
 * CLI integration test for `crewhaus lessons update` (#56). Asserts on exit
 * codes + on-disk LESSONS.md / preference-file state and idempotent re-runs.
 * No model / credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-lessons-"));
  TMP_ROOTS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TMP_ROOTS) rmSync(dir, { recursive: true, force: true });
});

async function runCli(args: ReadonlyArray<string>, cwd: string): Promise<{ exitCode: number }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: await proc.exited };
}

const S1 = "sess_00000000000000f1";

/** A session with a correction (from rater "max") + a runtime error signal. */
function writeSession(root: string): void {
  const sessionsDir = join(root, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const lines = [
    { kind: "user_message", payload: { content: "how do I deploy?" } },
    { kind: "assistant_message", payload: { content: [{ type: "text", text: "wrong" }] } },
    { kind: "error", payload: { name: "Error", message: "boom happened" } },
    {
      kind: "user_feedback",
      payload: {
        schemaVersion: 1,
        id: "fb_1",
        sessionId: S1,
        turnNumber: 1,
        modality: "comment",
        rating: {},
        correction: "use crewhaus deploy",
        rater: "max",
        source: "cli",
        ts: "2026-07-01T00:00:01.000Z",
      },
    },
  ];
  writeFileSync(
    join(sessionsDir, `${S1}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

function writeMinimalSpec(root: string): void {
  writeFileSync(
    join(root, "crewhaus.yaml"),
    "name: lessons-demo\ntarget: cli\nagent:\n  model: m\n  instructions: be helpful\n",
  );
}

describe("crewhaus lessons update (#56)", () => {
  test("writes a deduped LESSONS.md + per-user prefs; re-run is idempotent", async () => {
    const root = newTempRoot();
    writeSession(root);
    writeMinimalSpec(root);
    const first = await runCli(["lessons", "update", "--sessions", "all"], root);
    expect(first.exitCode).toBe(0);

    const lessonsFile = join(root, "LESSONS.md");
    expect(existsSync(lessonsFile)).toBe(true);
    const md1 = readFileSync(lessonsFile, "utf-8");
    expect(md1).toContain("crewhaus deploy"); // correction lesson
    expect(md1).toContain("boom happened"); // failure-fix lesson
    expect(md1).toContain("<!-- crewhaus:lessons -->");

    // Per-user prefs for rater "max".
    const prefsFile = join(root, ".crewhaus", "preferences", "max.md");
    expect(existsSync(prefsFile)).toBe(true);
    expect(readFileSync(prefsFile, "utf-8")).toContain("crewhaus deploy");

    // Re-running produces a byte-identical LESSONS.md (idempotent merge).
    const second = await runCli(["lessons", "update", "--sessions", "all"], root);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(lessonsFile, "utf-8")).toBe(md1);
  });

  test("preserves a human-authored preamble across updates", async () => {
    const root = newTempRoot();
    writeSession(root);
    writeMinimalSpec(root);
    // Seed a LESSONS.md with a hand-written preamble above the marker.
    writeFileSync(
      join(root, "LESSONS.md"),
      "# LESSONS\n\nHand-written intro that must survive.\n\n<!-- crewhaus:lessons -->\n",
    );
    const result = await runCli(["lessons", "update", "--sessions", "all"], root);
    expect(result.exitCode).toBe(0);
    const md = readFileSync(join(root, "LESSONS.md"), "utf-8");
    expect(md).toContain("Hand-written intro that must survive.");
    expect(md).toContain("crewhaus deploy");
  });
});
