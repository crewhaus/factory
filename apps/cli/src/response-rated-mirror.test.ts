/**
 * G59 — the `rate`/`feedback` capture surfaces mirror a `response_rated`
 * TraceEvent onto the session trace (the sibling of the durable `user_feedback`
 * record). Drives the real CLI over a seeded session in a tmp cwd and asserts
 * the mirror line lands (and does NOT for a comment-only record, which has no
 * rating).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

let cwd = "";
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rated-mirror-test-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

async function runCli(args: ReadonlyArray<string>): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr };
}

async function seedSession(sessionId: string): Promise<void> {
  const { openEventLog } = await import("@crewhaus/event-log");
  const log = await openEventLog(sessionId, { rootDir: join(cwd, ".crewhaus", "sessions") });
  await log.append({ kind: "user_message", payload: { content: "what is 2+2?" } });
  await log.append({ kind: "assistant_message", payload: { content: "4" } });
  await log.close();
}

function readSessionLines(sessionId: string): Array<{ kind?: string; payload?: unknown }> {
  const file = join(cwd, ".crewhaus", "sessions", `${sessionId}.jsonl`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { kind?: string; payload?: unknown });
}

describe("response_rated session-trace mirror", () => {
  test("rate --thumbs up appends a response_rated event with rating 'up'", async () => {
    const id = "sess_00000000cafe0001";
    await seedSession(id);
    const { exitCode } = await runCli(["rate", "--session", id, "--thumbs", "up"]);
    expect(exitCode).toBe(0);

    const lines = readSessionLines(id);
    // The durable user_feedback record is still there…
    expect(lines.some((l) => l.kind === "user_feedback")).toBe(true);
    // …plus the trace mirror.
    const rated = lines.filter((l) => l.kind === "response_rated");
    expect(rated).toHaveLength(1);
    const payload = rated[0]?.payload as {
      rating: unknown;
      turnNumber: unknown;
      source: unknown;
    };
    expect(payload.rating).toBe("up");
    expect(payload.turnNumber).toBe(1);
    expect(payload.source).toBe("cli");
  });

  test("rate --stars normalizes the rating into [0,1]", async () => {
    const id = "sess_00000000cafe0002";
    await seedSession(id);
    await runCli(["rate", "--session", id, "--stars", "4"]);
    const rated = readSessionLines(id).filter((l) => l.kind === "response_rated");
    expect(rated).toHaveLength(1);
    // 4 stars → (4-1)/4 = 0.75.
    expect((rated[0]?.payload as { rating: number }).rating).toBeCloseTo(0.75, 5);
  });

  test("comment-only feedback does NOT mirror a response_rated (no rating)", async () => {
    const id = "sess_00000000cafe0003";
    await seedSession(id);
    const { exitCode } = await runCli(["feedback", "--session", id, "--text", "be more concise"]);
    expect(exitCode).toBe(0);
    const lines = readSessionLines(id);
    expect(lines.some((l) => l.kind === "user_feedback")).toBe(true);
    expect(lines.some((l) => l.kind === "response_rated")).toBe(false);
  });

  test("the mirror is non-conversational — it doesn't disturb the transcript", async () => {
    const id = "sess_00000000cafe0004";
    await seedSession(id);
    await runCli(["rate", "--session", id, "--thumbs", "down", "--comment", "wrong"]);
    const lines = readSessionLines(id);
    // Original 2 conversational events survive unchanged.
    expect(lines.filter((l) => l.kind === "user_message")).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "assistant_message")).toHaveLength(1);
    const rated = lines.find((l) => l.kind === "response_rated");
    expect((rated?.payload as { rating: unknown; comment: unknown }).rating).toBe("down");
    expect((rated?.payload as { comment: unknown }).comment).toBe("wrong");
  });
});
