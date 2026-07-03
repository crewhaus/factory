/**
 * CLI integration tests for `crewhaus fewshot harvest|show` (#54). Follows
 * datasets-cli.test.ts's posture: assert on exit codes + on-disk pool state
 * (Bun 1.3.x spawn-pipe capture is unreliable under `bun test`). No model /
 * credentials needed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isFewShotExample } from "./fewshot";

const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");

const TMP_ROOTS: string[] = [];
function newTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "crewhaus-cli-fewshot-"));
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

/** runCli variant that also returns captured stderr (the few-shot write-back
 *  notice is on stderr and reliably flushed before the process exits). */
async function runCliCapture(
  args: ReadonlyArray<string>,
  cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { PATH: process.env["PATH"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stderr };
}

const SESSION = "sess_0123456789abcdef";

/** One rated up + one rated down turn → one qualifying few-shot example. */
function writeSession(root: string): void {
  const sessionsDir = join(root, ".crewhaus", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const fb = (n: number, thumbs: "up" | "down") => ({
    kind: "user_feedback",
    payload: {
      schemaVersion: 1,
      id: `fb_${n}`,
      sessionId: SESSION,
      turnNumber: n,
      modality: "binary",
      rating: { thumbs },
      source: "cli",
      ts: `2026-07-01T00:00:0${n}.000Z`,
    },
  });
  const lines = [
    { kind: "user_message", payload: { content: "how do I deploy?" } },
    {
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "Run crewhaus deploy." }] },
    },
    { kind: "user_message", payload: { content: "what is a spec?" } },
    {
      kind: "assistant_message",
      payload: { content: [{ type: "text", text: "A crewhaus.yaml file." }] },
    },
    fb(1, "up"),
    fb(2, "down"),
  ];
  writeFileSync(
    join(sessionsDir, `${SESSION}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

function writeMinimalSpec(root: string): void {
  writeFileSync(
    join(root, "crewhaus.yaml"),
    "name: fewshot-demo\ntarget: cli\nagent:\n  model: m\n  instructions: be helpful\n",
  );
}

describe("crewhaus fewshot harvest (#54)", () => {
  test("harvests the up-rated turn into the default pool file", async () => {
    const root = newTempRoot();
    writeSession(root);
    writeMinimalSpec(root);
    const result = await runCli(["fewshot", "harvest", "--all-sessions"], root);
    expect(result.exitCode).toBe(0);
    const poolFile = join(root, ".crewhaus", "fewshot", "fewshot-demo.jsonl");
    expect(existsSync(poolFile)).toBe(true);
    const pool = readFileSync(poolFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
    expect(pool).toHaveLength(1);
    expect(pool.every(isFewShotExample)).toBe(true);
    expect(pool[0].input).toBe("how do I deploy?");
    expect(pool[0].output).toBe("Run crewhaus deploy.");
    expect(pool[0].id).toBe(`${SESSION}_t1`);
  });

  test("re-harvesting is idempotent (dedupes by id)", async () => {
    const root = newTempRoot();
    writeSession(root);
    writeMinimalSpec(root);
    await runCli(["fewshot", "harvest", "--all-sessions"], root);
    const second = await runCli(["fewshot", "harvest", "--all-sessions"], root);
    expect(second.exitCode).toBe(0);
    const poolFile = join(root, ".crewhaus", "fewshot", "fewshot-demo.jsonl");
    const pool = readFileSync(poolFile, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(pool).toHaveLength(1);
  });

  test("harvest into a custom -o file, then `show` prints the block", async () => {
    const root = newTempRoot();
    writeSession(root);
    writeMinimalSpec(root);
    const out = join(root, "pool.jsonl");
    const harvest = await runCli(["fewshot", "harvest", "--all-sessions", "-o", out], root);
    expect(harvest.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    const show = await runCli(["fewshot", "show", "-o", out], root);
    expect(show.exitCode).toBe(0);
  });

  test("exits non-zero when there is no feedback", async () => {
    const root = newTempRoot();
    const sessionsDir = join(root, ".crewhaus", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${SESSION}.jsonl`),
      `${JSON.stringify({ kind: "user_message", payload: { content: "hi" } })}\n`,
    );
    writeMinimalSpec(root);
    const result = await runCli(["fewshot", "harvest", "--all-sessions"], root);
    expect(result.exitCode).not.toBe(0);
  });
});

describe("optimize --few-shot is patch-only (#54 F8)", () => {
  test("--few-shot with --write-back never mutates the tracked spec + prints the notice", async () => {
    const root = newTempRoot();
    writeSession(root);
    writeMinimalSpec(root);
    // Harvest a real pool so `optimize --few-shot auto` has examples to inject.
    const harvest = await runCli(["fewshot", "harvest", "--all-sessions"], root);
    expect(harvest.exitCode).toBe(0);

    // Minimal dataset + graders so optimize's arg handling reaches the few-shot
    // block (dataset resolution runs before it and dies otherwise). No model is
    // needed to reach the notice — it prints during arg handling.
    const dataset = join(root, "dataset.jsonl");
    writeFileSync(dataset, `${JSON.stringify({ id: "s1", input: "hi", expected_output: "ok" })}\n`);
    const graders = join(root, "graders.yaml");
    writeFileSync(graders, "graders:\n  - name: g\n    type: contains\n    substring: 'ok'\n");

    // Snapshot the tracked spec BEFORE the optimize run.
    const specFile = join(root, "crewhaus.yaml");
    const before = readFileSync(specFile, "utf-8");

    // Run optimize with BOTH --few-shot and --write-back. The few-shot path
    // forces writeBack:false: the augmented spec is written to a temp outDir,
    // never the source. (The run itself may exit non-zero for lack of a model —
    // the safety claim is about the on-disk spec + the stderr notice, both of
    // which happen during arg handling before any model call.)
    const r = await runCliCapture(
      [
        "optimize",
        specFile,
        "--dataset",
        dataset,
        "--graders",
        graders,
        "--few-shot",
        "auto",
        "--write-back",
        "--mutator",
        "rule-based",
        "--iterations",
        "1",
      ],
      root,
    );

    // 1) The tracked spec is byte-identical — the injected examples never
    //    landed in it (they'd double-inject on the next run).
    expect(readFileSync(specFile, "utf-8")).toBe(before);
    // 2) The safety notice was printed to stderr.
    expect(r.stderr).toContain("--write-back is ignored with --few-shot");
  });
});
