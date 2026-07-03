/**
 * CLI integration test for `crewhaus faq distill` (#55). Asserts on exit codes
 * + on-disk SKILL.md state and that the emitted skill is auto-discoverable.
 * No model / credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, parseSkillFile } from "@crewhaus/skills-registry";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-faq-"));
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

function upFb(sessionId: string, n: number) {
  return {
    kind: "user_feedback",
    payload: {
      schemaVersion: 1,
      id: `fb_${sessionId}_${n}`,
      sessionId,
      turnNumber: n,
      modality: "binary",
      rating: { thumbs: "up" },
      source: "cli",
      ts: `2026-07-01T00:00:0${n}.000Z`,
    },
  };
}

/** Two sessions each asking the same "deploy" question (recurring) → one FAQ. */
function writeSessions(root: string): void {
  const sessionsDir = join(root, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const s1 = "sess_00000000000000c1";
  const s2 = "sess_00000000000000c2";
  const log1 = [
    { kind: "user_message", payload: { content: "how do I deploy my agent?" } },
    {
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "Run crewhaus deploy." }] },
    },
    upFb(s1, 1),
  ];
  const log2 = [
    { kind: "user_message", payload: { content: "how do I deploy the agent" } },
    {
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "Use crewhaus deploy." }] },
    },
    upFb(s2, 1),
  ];
  writeFileSync(
    join(sessionsDir, `${s1}.jsonl`),
    `${log1.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  writeFileSync(
    join(sessionsDir, `${s2}.jsonl`),
    `${log2.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

function writeMinimalSpec(root: string): void {
  writeFileSync(
    join(root, "crewhaus.yaml"),
    "name: faq-demo\ntarget: cli\nagent:\n  model: m\n  instructions: be helpful\n",
  );
}

describe("crewhaus faq distill (#55)", () => {
  test("emits an auto-discoverable FAQ SKILL.md from recurring questions", async () => {
    const root = newTempRoot();
    writeSessions(root);
    writeMinimalSpec(root);
    const result = await runCli(["faq", "distill", "--sessions", "all"], root);
    expect(result.exitCode).toBe(0);
    const skillFile = join(root, ".crewhaus", "skills", "faq", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    const md = readFileSync(skillFile, "utf-8");
    const { frontmatter, body } = parseSkillFile(md);
    expect(frontmatter.name).toBe("faq");
    expect(body.toLowerCase()).toContain("deploy");
    // Auto-discovered from the cwd skills dir.
    const home = mkdtempSync(join(tmpdir(), "faq-home-"));
    TMP_ROOTS.push(home);
    const skills = await discoverSkills({ cwd: root, homeDir: home });
    expect(skills.map((s) => s.name)).toContain("faq");
  });

  test("exits non-zero when no question recurs", async () => {
    const root = newTempRoot();
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const s1 = "sess_00000000000000d1";
    const log = [
      { kind: "user_message", payload: { content: "a unique one-off question" } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "an answer" }] } },
      upFb(s1, 1),
    ];
    writeFileSync(
      join(sessionsDir, `${s1}.jsonl`),
      `${log.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    writeMinimalSpec(root);
    const result = await runCli(["faq", "distill", "--sessions", "all"], root);
    expect(result.exitCode).not.toBe(0);
  });
});
