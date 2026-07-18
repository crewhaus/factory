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

// Loop contract 0.4 (Batch B, G53) — `sessions export --format trajectories`.
describe("crewhaus sessions export --format trajectories (G53)", () => {
  /** A session with a full tool round, a rating, and (optionally) a sibling
   *  trace-events file carrying the eval_graded reward signal. */
  function writeTrajectorySession(
    root: string,
    id: string,
    opts: { thumbs?: "up" | "down"; evalGradedScore?: number } = {},
  ): void {
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const events: unknown[] = [
      { kind: "user_message", payload: { content: "list the files" } },
      {
        kind: "assistant_message",
        payload: {
          content: [
            { type: "text", text: "Let me look." },
            { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
          ],
        },
      },
      { kind: "tool_use", payload: { id: "tu_1", name: "bash", input: { command: "ls" } } },
      { kind: "tool_result", payload: { toolUseId: "tu_1", content: "a.txt", isError: false } },
      { kind: "assistant_message", payload: { content: [{ type: "text", text: "One file." }] } },
    ];
    if (opts.thumbs !== undefined) {
      events.push({
        kind: "user_feedback",
        payload: {
          schemaVersion: 1,
          id: "fb_1",
          sessionId: id,
          turnNumber: 1,
          modality: "binary",
          rating: { thumbs: opts.thumbs },
          source: "cli",
          ts: "2026-01-01T00:00:10.000Z",
        },
      });
    }
    writeFileSync(
      join(sessionsDir, `${id}.jsonl`),
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
    if (opts.evalGradedScore !== undefined) {
      writeFileSync(
        join(sessionsDir, `${id}.events.jsonl`),
        `${JSON.stringify({
          kind: "eval_graded",
          score: opts.evalGradedScore,
          threshold: 0.7,
          verdict: opts.evalGradedScore >= 0.7 ? "pass" : "fail",
          graderType: "llm_judge",
          retryIndex: 0,
        })}\n`,
      );
    }
  }

  const A = "sess_00000000000000aa";
  const B = "sess_00000000000000bb";

  test("--out writes (state, action, observation, reward) JSONL with the reward ladder applied", async () => {
    const root = newTempRoot();
    // A: eval_graded (via sibling trace events) outranks the thumbs-down.
    writeTrajectorySession(root, A, { thumbs: "down", evalGradedScore: 0.9 });
    // B: rating only.
    writeTrajectorySession(root, B, { thumbs: "up" });
    const outFile = join(root, "trajectories.jsonl");
    const result = await runCli(
      ["sessions", "export", "--format", "trajectories", "--out", outFile],
      root,
    );
    expect(result.exitCode).toBe(0);
    const lines = readFileSync(outFile, "utf-8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // Two sessions × two assistant actions each.
    expect(lines).toHaveLength(4);

    const aSteps = lines.filter((l) => l["sessionId"] === A);
    const bSteps = lines.filter((l) => l["sessionId"] === B);
    expect(aSteps).toHaveLength(2);
    expect(bSteps).toHaveLength(2);

    // Tuple shape: step 0 acts on the user prompt, observes the tool result.
    const a0 = aSteps[0] as {
      step: number;
      state: Array<Record<string, unknown>>;
      action: { text?: string; toolCalls?: Array<{ tool: string }> };
      observation: { results: Array<{ tool?: string; text: string; isError: boolean }> };
      reward: number | null;
    };
    expect(a0.step).toBe(0);
    expect(a0.state).toEqual([{ role: "user", text: "list the files" }]);
    expect(a0.action.toolCalls?.[0]?.tool).toBe("bash");
    expect(a0.observation.results[0]).toEqual({ tool: "bash", text: "a.txt", isError: false });
    expect(a0.reward).toBeNull();

    // Terminal rewards: eval_graded beats the rating on A; rating rung on B.
    const aLast = aSteps[1] as Record<string, unknown>;
    expect(aLast["reward"]).toBe(0.9);
    expect(aLast["rewardSource"]).toBe("eval_graded");
    const bLast = bSteps[1] as Record<string, unknown>;
    expect(bLast["reward"]).toBe(1); // thumbs up → 1 (distill convention)
    expect(bLast["rewardSource"]).toBe("user_rating");
  });

  test("a session with no reward signal exports reward: null on its terminal step", async () => {
    const root = newTempRoot();
    writeTrajectorySession(root, A);
    const outFile = join(root, "t.jsonl");
    const result = await runCli(
      ["sessions", "export", "--format", "trajectories", "--out", outFile],
      root,
    );
    expect(result.exitCode).toBe(0);
    const lines = readFileSync(outFile, "utf-8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.["reward"]).toBeNull();
    expect("rewardSource" in (lines[1] as object)).toBe(false);
  });

  test("rejects an unsupported --format and a missing one", async () => {
    const root = newTempRoot();
    writeTrajectorySession(root, A);
    expect((await runCli(["sessions", "export", "--format", "parquet"], root)).exitCode).toBe(1);
    expect((await runCli(["sessions", "export"], root)).exitCode).toBe(1);
  });

  test("fails loudly when there are no sessions to export", async () => {
    const root = newTempRoot();
    const result = await runCli(["sessions", "export", "--format", "trajectories"], root);
    expect(result.exitCode).toBe(1);
  });

  test("unknown sessions action names both supported ones", async () => {
    const root = newTempRoot();
    const result = await runCli(["sessions", "purge"], root);
    expect(result.exitCode).toBe(1);
  });

  test("sessions --help exits 0 (documents the G53 posture)", async () => {
    const root = newTempRoot();
    const result = await runCli(["sessions", "--help"], root);
    expect(result.exitCode).toBe(0);
  });
});
