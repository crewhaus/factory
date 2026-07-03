/**
 * CLI integration test for `crewhaus sessions summarize` (#57). Asserts on exit
 * codes + on-disk index state, including the summarize-before-evict path
 * (`--evicted`) where an expiring session is indexed the instant before it is
 * unlinked. No model / credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-sessions-"));
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

function writeSession(root: string, id: string): void {
  const sessionsDir = join(root, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  // The session store's TTL sweep is keyed on the `.json` mtime, so create it.
  writeFileSync(
    join(sessionsDir, `${id}.json`),
    JSON.stringify({
      id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      name: "s",
      target: "cli",
      model: "m",
      lastTurnIndex: 1,
    }),
  );
  const events = [
    { kind: "user_message", payload: { content: "list the files" } },
    {
      kind: "assistant_message",
      payload: {
        content: [
          { type: "tool_use", name: "Bash" },
          { type: "text", text: "listed 3 files" },
        ],
      },
    },
    { kind: "user_feedback", payload: { rating: { thumbs: "up" } } },
  ];
  writeFileSync(
    join(sessionsDir, `${id}.jsonl`),
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
}

const S = "sess_00000000000000e7";

describe("crewhaus sessions summarize (#57)", () => {
  test("on-demand: writes a durable index entry", async () => {
    const root = newTempRoot();
    writeSession(root, S);
    const result = await runCli(["sessions", "summarize"], root);
    expect(result.exitCode).toBe(0);
    const indexFile = join(root, ".crewhaus", "sessions-index", `${S}.json`);
    expect(existsSync(indexFile)).toBe(true);
    const summary = JSON.parse(readFileSync(indexFile, "utf-8"));
    expect(summary.sessionId).toBe(S);
    expect(summary.toolsUsed).toEqual(["Bash"]);
    expect(summary.outcome).toBe("listed 3 files");
    expect(summary.ratings.positive).toBe(1);
  });

  test("--evicted: indexes the session BEFORE unlinking it", async () => {
    const root = newTempRoot();
    writeSession(root, S);
    const sessionsDir = join(root, ".crewhaus", "sessions");
    // Backdate the .json mtime past the 30-day TTL so it is evicted.
    const backdated = new Date(Date.now() - 40 * 86_400_000);
    utimesSync(join(sessionsDir, `${S}.json`), backdated, backdated);

    const result = await runCli(["sessions", "summarize", "--evicted"], root);
    expect(result.exitCode).toBe(0);
    // The raw transcript is gone…
    expect(existsSync(join(sessionsDir, `${S}.json`))).toBe(false);
    expect(existsSync(join(sessionsDir, `${S}.jsonl`))).toBe(false);
    // …but its durable index entry survives.
    const indexFile = join(root, ".crewhaus", "sessions-index", `${S}.json`);
    expect(existsSync(indexFile)).toBe(true);
    expect(JSON.parse(readFileSync(indexFile, "utf-8")).outcome).toBe("listed 3 files");
  });

  test("--evicted leaves a fresh session (and its transcript) untouched", async () => {
    const root = newTempRoot();
    writeSession(root, S);
    const result = await runCli(["sessions", "summarize", "--evicted"], root);
    expect(result.exitCode).toBe(0);
    // Fresh → not evicted → not indexed.
    expect(existsSync(join(root, ".crewhaus", "sessions", `${S}.json`))).toBe(true);
    expect(existsSync(join(root, ".crewhaus", "sessions-index", `${S}.json`))).toBe(false);
  });
});
