import { describe, expect, test } from "bun:test";
import { spawnBounded } from "./spawn";

/**
 * POSIX only: these drive `sh`, `yes`, `sleep` and process groups. The
 * Windows branch of the group kill (`taskkill /T`) is best-effort and not
 * exercised here.
 */
const posix = process.platform !== "win32";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, budgetMs: number): Promise<boolean> {
  const until = performance.now() + budgetMs;
  while (performance.now() < until) {
    if (!alive(pid)) return true;
    await Bun.sleep(20);
  }
  return !alive(pid);
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

describe.if(posix)("spawnBounded", () => {
  test("stdin in, stdout out, a clean exit reads as complete", async () => {
    const r = await spawnBounded({
      cmd: ["cat"],
      stdin: "hello",
      timeoutMs: 10_000,
      maxStdoutBytes: 1_000,
      maxStderrBytes: 1_000,
    });
    expect(r).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: "hello",
      stdoutTruncated: false,
      timedOut: false,
      aborted: false,
      outputComplete: true,
    });
  }, 20_000);

  test("security-8#7: a flood is capped as it arrives and reported truncated, not empty", async () => {
    const r = await spawnBounded({
      cmd: ["yes"],
      timeoutMs: 300,
      maxStdoutBytes: 64 * 1024,
      maxStderrBytes: 1_024,
    });
    expect(r.timedOut).toBe(true);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.length).toBe(64 * 1024);
    expect(r.stdout.startsWith("y\ny\n")).toBe(true);
    expect(r.stdoutBytes).toBeGreaterThan(64 * 1024);
    expect(r.exitCode).toBeNull();
    expect(r.signal).not.toBeNull();
  }, 30_000);

  test("onOverflow kill stops the producer at the cap instead of at the deadline", async () => {
    const r = await spawnBounded({
      cmd: ["yes"],
      timeoutMs: 60_000,
      maxStdoutBytes: 4_096,
      maxStderrBytes: 1_024,
      onOverflow: "kill",
    });
    expect(r.killedForOverflow).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.length).toBe(4_096);
    expect(r.durationMs).toBeLessThan(30_000);
  }, 60_000);

  test("tailBytes keeps the end of a truncated stream", async () => {
    const r = await spawnBounded({
      cmd: ["sh", "-c", "i=0; while [ $i -lt 2000 ]; do echo line$i; i=$((i+1)); done; echo LAST"],
      timeoutMs: 20_000,
      maxStdoutBytes: 200,
      maxStderrBytes: 100,
      tailBytes: 50,
    });
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.startsWith("line0\nline1\n")).toBe(true);
    expect(r.stdoutTail?.endsWith("LAST\n")).toBe(true);
    expect(r.outputComplete).toBe(true);
  }, 30_000);

  test("security-8#8: a grandchild holding the pipe yields the output that arrived, marked incomplete", async () => {
    const r = await spawnBounded({
      cmd: ["sh", "-c", "echo 'line the caller needs'; sleep 5 &"],
      timeoutMs: 20_000,
      maxStdoutBytes: 1_000,
      maxStderrBytes: 1_000,
      drainGraceMs: 300,
    });
    try {
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("line the caller needs\n");
      // Not "ok with empty output": the text is there, and it says it may not be all.
      expect(r.outputComplete).toBe(false);
      expect(r.durationMs).toBeLessThan(4_000);
    } finally {
      killGroup(r.pid);
    }
  }, 30_000);

  test("a timeout kills the whole process group, not just the child", async () => {
    const r = await spawnBounded({
      cmd: ["sh", "-c", "sleep 30 & echo $!; wait"],
      timeoutMs: 500,
      maxStdoutBytes: 1_000,
      maxStderrBytes: 1_000,
      killGraceMs: 500,
    });
    const grandchild = Number(r.stdout.trim());
    try {
      expect(r.timedOut).toBe(true);
      expect(Number.isInteger(grandchild) && grandchild > 0).toBe(true);
      expect(await waitGone(grandchild, 10_000)).toBe(true);
    } finally {
      if (Number.isInteger(grandchild) && grandchild > 0 && alive(grandchild)) {
        process.kill(grandchild, "SIGKILL");
      }
    }
  }, 30_000);

  test("an abort kills the group and says so", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const r = await spawnBounded({
      cmd: ["sleep", "30"],
      timeoutMs: 60_000,
      maxStdoutBytes: 1_000,
      maxStderrBytes: 1_000,
      signal: controller.signal,
    });
    expect(r.aborted).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.durationMs).toBeLessThan(20_000);
  }, 30_000);

  test("an already-aborted signal starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await spawnBounded({
      cmd: ["sh", "-c", "echo should-not-run"],
      timeoutMs: 1_000,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
      signal: controller.signal,
    });
    expect(r).toMatchObject({ aborted: true, stdout: "", exitCode: null });
    expect(r.pid).toBeUndefined();
  });

  test("a command that cannot start reports spawnError, not an exit code", async () => {
    const r = await spawnBounded({
      cmd: ["/definitely/not/a/real/binary"],
      timeoutMs: 1_000,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
    });
    expect(typeof r.spawnError).toBe("string");
    expect(r.exitCode).toBeNull();
  });

  test("stderr has its own cap", async () => {
    const r = await spawnBounded({
      cmd: [
        "sh",
        "-c",
        "printf 'out'; i=0; while [ $i -lt 500 ]; do printf 'e' >&2; i=$((i+1)); done",
      ],
      timeoutMs: 20_000,
      maxStdoutBytes: 1_000,
      maxStderrBytes: 10,
    });
    expect(r.stdout).toBe("out");
    expect(r.stdoutTruncated).toBe(false);
    expect(r.stderr).toBe("e".repeat(10));
    expect(r.stderrTruncated).toBe(true);
    expect(r.stderrBytes).toBe(500);
  }, 30_000);
});
