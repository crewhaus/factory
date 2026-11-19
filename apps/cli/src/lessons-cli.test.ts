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

async function runCli(
  args: ReadonlyArray<string>,
  cwd: string,
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

const S1 = "sess_00000000000000f1";

// A credential-shaped token built at RUNTIME from parts (GitHub push-protection
// blocks committing a literal secret, even a fake one). Matches
// SECRET_KEY_DETECTOR's `sk-…` rule, so redaction masks it.
const FAKE_SECRET = ["sk", "-", "A".repeat(40)].join("");

/** A session with a correction (from rater "max") + a runtime error signal that
 *  carries a pasted credential in its message (#56 F3 — must be redacted). */
function writeSession(root: string): void {
  const sessionsDir = join(root, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const lines = [
    { kind: "user_message", payload: { content: "how do I deploy?" } },
    { kind: "assistant_message", payload: { content: [{ type: "text", text: "wrong" }] } },
    {
      kind: "error",
      payload: { name: "Error", message: `connection refused using key ${FAKE_SECRET}` },
    },
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
    // The failure lesson comes from the session's runtime error, not a rating.
    const first = await runCli(["lessons", "update", "--sessions", "all", "--yes"], root);
    expect(first.exitCode).toBe(0);

    const lessonsFile = join(root, "LESSONS.md");
    expect(existsSync(lessonsFile)).toBe(true);
    const md1 = readFileSync(lessonsFile, "utf-8");
    expect(md1).toContain("crewhaus deploy"); // correction lesson
    // #56 F3 — the failure-fix reason is auto-injected into future prompts, so
    // a pasted credential in the raw error message is redacted, not written raw.
    expect(md1).toContain("runtime error"); // failure-fix lesson still present
    expect(md1).not.toContain(FAKE_SECRET); // the credential is masked
    expect(md1).toContain("[REDACTED:secret]");
    expect(md1).toContain("<!-- crewhaus:lessons -->");

    // Per-user prefs for rater "max".
    const prefsFile = join(root, ".crewhaus", "preferences", "max.md");
    expect(existsSync(prefsFile)).toBe(true);
    expect(readFileSync(prefsFile, "utf-8")).toContain("crewhaus deploy");

    // Re-running produces a byte-identical LESSONS.md (idempotent merge).
    const second = await runCli(["lessons", "update", "--sessions", "all", "--yes"], root);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(lessonsFile, "utf-8")).toBe(md1);
  }, 20_000);

  test("preserves a human-authored preamble across updates", async () => {
    const root = newTempRoot();
    writeSession(root);
    writeMinimalSpec(root);
    // Seed a LESSONS.md with a hand-written preamble above the marker.
    writeFileSync(
      join(root, "LESSONS.md"),
      "# LESSONS\n\nHand-written intro that must survive.\n\n<!-- crewhaus:lessons -->\n",
    );
    const result = await runCli(["lessons", "update", "--sessions", "all", "--yes"], root);
    expect(result.exitCode).toBe(0);
    const md = readFileSync(join(root, "LESSONS.md"), "utf-8");
    expect(md).toContain("Hand-written intro that must survive.");
    expect(md).toContain("crewhaus deploy");
  }, 20_000);
});

const S2 = "sess_00000000000000f2";

/** A session holding one exchange and, when given, the operator's own correction on it. */
function writeRatedSession(root: string, correction?: string): void {
  const sessionsDir = join(root, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const lines: unknown[] = [
    { kind: "user_message", payload: { content: "which branch do releases come from?" } },
    { kind: "assistant_message", payload: { content: [{ type: "text", text: "develop" }] } },
  ];
  if (correction !== undefined) {
    lines.push({
      kind: "user_feedback",
      payload: {
        schemaVersion: 1,
        id: "fb_op",
        sessionId: S2,
        turnNumber: 1,
        modality: "comment",
        rating: {},
        correction,
        rater: "ops",
        source: "cli",
        ts: "2026-07-01T00:00:01.000Z",
      },
    });
  }
  writeFileSync(
    join(sessionsDir, `${S2}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

/** A `.crewhaus/feedback` record. */
function writeFiledRecord(root: string, correction: string): void {
  const dir = join(root, ".crewhaus", "feedback");
  mkdirSync(dir, { recursive: true });
  const record = {
    schemaVersion: 1,
    id: "fb_filed",
    sessionId: S2,
    turnNumber: 1,
    modality: "comment",
    rating: {},
    correction,
    rater: "guest",
    source: "cli",
    ts: "2026-07-01T00:00:02.000Z",
  };
  writeFileSync(join(dir, "ui.jsonl"), `${JSON.stringify(record)}\n`);
}

describe("crewhaus lessons update shows what it writes, and asks for --yes", () => {
  test("a candidate from a feedback-file record is printed, nothing is written, and the twin is named", async () => {
    const root = newTempRoot();
    writeMinimalSpec(root);
    writeRatedSession(root);
    writeFiledRecord(root, "releases come from the main branch");
    const result = await runCli(["lessons", "update", "--sessions", "all"], root);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("lessons update refused");
    expect(result.stderr).toContain("Nothing was written");
    expect(result.stderr).toContain("crewhaus lessons update --yes");
    // Every new lesson and preference note is shown exactly as it would be written.
    expect(result.stdout).toContain(
      '- For "which branch do releases come from?": prefer this answer — releases come from the main branch',
    );
    expect(result.stdout).toContain("- prefers answers like: releases come from the main branch");
    expect(existsSync(join(root, "LESSONS.md"))).toBe(false);
    expect(existsSync(join(root, ".crewhaus", "preferences"))).toBe(false);
    expect(existsSync(join(root, ".crewhaus", "lessons"))).toBe(false);
  }, 20_000);

  test("with --yes the same candidates are written", async () => {
    const root = newTempRoot();
    writeMinimalSpec(root);
    writeRatedSession(root);
    writeFiledRecord(root, "releases come from the main branch");
    const result = await runCli(["lessons", "update", "--sessions", "all", "--yes"], root);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(root, "LESSONS.md"), "utf-8")).toContain(
      "releases come from the main branch",
    );
    expect(existsSync(join(root, ".crewhaus", "preferences", "guest.md"))).toBe(true);
  }, 20_000);

  test("the operator's own session-log rating is written without --yes", async () => {
    const root = newTempRoot();
    writeMinimalSpec(root);
    writeRatedSession(root, "releases come from the main branch");
    const result = await runCli(["lessons", "update", "--sessions", "all"], root);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
    expect(result.stdout).toContain("[lessons] new in");
    expect(readFileSync(join(root, "LESSONS.md"), "utf-8")).toContain(
      "releases come from the main branch",
    );
    expect(existsSync(join(root, ".crewhaus", "preferences", "ops.md"))).toBe(true);
  }, 20_000);
});
