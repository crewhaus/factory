import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBounded } from "./spawn";

const scratch = mkdtempSync(join(tmpdir(), "tool-safety-spawn-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

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

/** Whether `signal` has aborted within `ms`, polled without adding a listener. */
async function firesWithin(signal: AbortSignal, ms: number): Promise<boolean> {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    if (signal.aborted) return true;
    await Bun.sleep(20);
  }
  return signal.aborted;
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

  test("a command that cannot start reports spawnError and its errno code, not an exit code", async () => {
    const r = await spawnBounded({
      cmd: ["/definitely/not/a/real/binary"],
      timeoutMs: 1_000,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
    });
    expect(typeof r.spawnError).toBe("string");
    expect(r.exitCode).toBeNull();
    // A missing backend reads differently from a failed one (tool-desktop).
    expect(r.spawnErrorCode).toBe("ENOENT");
    const onPath = await spawnBounded({
      cmd: ["definitely-not-a-command-xyz"],
      timeoutMs: 1_000,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
    });
    expect(onPath.spawnErrorCode).toBe("ENOENT");
    expect(onPath.spawnError).not.toContain("ENOENT");
  });

  test("a SIGTERM-ignoring member of the group still gets SIGKILL after the child itself exits", async () => {
    // The child execs `sleep`, which dies of the SIGTERM at once; the helper
    // it started ignores SIGTERM and holds stdout. SIGKILL used to be
    // cancelled the moment the child exited, and the helper lived on.
    const r = await spawnBounded({
      cmd: ["sh", "-c", `sh -c 'trap "" TERM; echo $$; while :; do sleep 1; done' & exec sleep 60`],
      timeoutMs: 300,
      maxStdoutBytes: 1_000,
      maxStderrBytes: 1_000,
      killGraceMs: 2_000,
      drainGraceMs: 200,
    });
    const helper = Number(r.stdout.trim());
    try {
      expect(r.timedOut).toBe(true);
      expect(r.signal).toBe("SIGTERM");
      expect(Number.isInteger(helper) && helper > 0).toBe(true);
      // spawnBounded returned once the child had exited, normally well within
      // the grace; SIGKILL still reaches the helper when the grace runs out.
      expect(await waitGone(helper, 15_000)).toBe(true);
    } finally {
      if (Number.isInteger(helper) && helper > 0 && alive(helper)) process.kill(helper, "SIGKILL");
    }
  }, 30_000);

  test("every limit is parsed first: NaN, zero or negative throws; Infinity means no timeout", async () => {
    const base = { cmd: ["true"], timeoutMs: 1_000, maxStdoutBytes: 10, maxStderrBytes: 10 };
    const bad: Array<Record<string, unknown>> = [
      { timeoutMs: Number.NaN },
      { timeoutMs: 0 },
      { timeoutMs: -5 },
      { maxStdoutBytes: Number.NaN },
      { maxStderrBytes: undefined },
      { tailBytes: -1 },
      { killGraceMs: Number.NaN },
      { drainGraceMs: Number.POSITIVE_INFINITY },
      { reapGraceMs: -1 },
    ];
    for (const change of bad) {
      await expect(spawnBounded({ ...base, ...change } as typeof base)).rejects.toThrow(RangeError);
    }
    const r = await spawnBounded({
      cmd: ["sh", "-c", "sleep 0.3; echo done"],
      timeoutMs: Number.POSITIVE_INFINITY,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
    });
    expect(r).toMatchObject({ timedOut: false, exitCode: 0, stdout: "done\n" });
  }, 20_000);

  test("the kept bytes come back raw, and the omitted count is exact", async () => {
    const r = await spawnBounded({
      cmd: ["sh", "-c", "printf '\\377\\376\\000\\001abcdefgh'"],
      timeoutMs: 10_000,
      maxStdoutBytes: 6,
      maxStderrBytes: 10,
      tailBytes: 2,
    });
    expect([...r.stdoutRaw]).toEqual([0xff, 0xfe, 0x00, 0x01]);
    expect([...(r.stdoutTailRaw ?? [])]).toEqual([0x67, 0x68]);
    expect(r.stdoutBytes).toBe(12);
    expect(r.stdoutOmittedBytes).toBe(12 - 4 - 2);
    expect(r.stdoutTruncated).toBe(true);
  }, 20_000);

  test("a caller's AbortSignal.timeout still fires after a call finished with it", async () => {
    const signal = AbortSignal.timeout(500);
    const quick = await spawnBounded({
      cmd: ["true"],
      timeoutMs: 10_000,
      maxStdoutBytes: 10,
      maxStderrBytes: 10,
      signal,
    });
    expect(typeof quick.aborted).toBe("boolean");
    expect(await firesWithin(signal, 15_000)).toBe(true);
  }, 30_000);

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

/**
 * The host process is a separate Bun process running this child script, so
 * its signals and exit can be driven without touching the test runner.
 */
describe.if(posix)("when the host goes away", () => {
  const spawnModule = join(import.meta.dir, "spawn.ts");

  async function host(mode: "sigint" | "exit" | "own-handler"): Promise<{
    host: ReturnType<typeof Bun.spawn>;
    sleeper: number;
  }> {
    const pidFile = join(scratch, `${mode}.pid`);
    const script = join(scratch, `${mode}-host.ts`);
    writeFileSync(
      script,
      [
        `import { spawnBounded } from ${JSON.stringify(spawnModule)};`,
        mode === "own-handler" ? `process.on("SIGINT", () => console.log("host handles it"));` : "",
        `void spawnBounded({ cmd: ["sh", "-c", ${JSON.stringify(`echo $$ > ${pidFile}; exec sleep 60`)}], timeoutMs: 120_000, maxStdoutBytes: 100, maxStderrBytes: 100 });`,
        mode === "exit"
          ? `const t = setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(pidFile)})) process.exit(0); }, 20);`
          : "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const proc = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
    const until = performance.now() + 15_000;
    while (!existsSync(pidFile) || readFileSync(pidFile, "utf8").trim() === "") {
      if (performance.now() > until) throw new Error("the host never started its command");
      await Bun.sleep(20);
    }
    return { host: proc, sleeper: Number(readFileSync(pidFile, "utf8").trim()) };
  }

  test("a Ctrl-C the host does not handle kills the command's group, and the host dies of it", async () => {
    const { host: h, sleeper } = await host("sigint");
    try {
      await Bun.sleep(100);
      h.kill("SIGINT");
      await h.exited;
      expect(h.signalCode).toBe("SIGINT");
      // The command leads its own group, so the SIGINT never reached it.
      expect(await waitGone(sleeper, 10_000)).toBe(true);
    } finally {
      if (alive(sleeper)) process.kill(sleeper, "SIGKILL");
    }
  }, 30_000);

  test("process.exit in the host kills the command's group", async () => {
    const { host: h, sleeper } = await host("exit");
    try {
      await h.exited;
      expect(h.exitCode).toBe(0);
      expect(await waitGone(sleeper, 10_000)).toBe(true);
    } finally {
      if (alive(sleeper)) process.kill(sleeper, "SIGKILL");
    }
  }, 30_000);

  test("a host with its own SIGINT handler keeps its policy: nothing is killed for it", async () => {
    const { host: h, sleeper } = await host("own-handler");
    try {
      await Bun.sleep(100);
      h.kill("SIGINT");
      await Bun.sleep(500);
      expect(h.exitCode).toBeNull();
      expect(alive(sleeper)).toBe(true);
    } finally {
      h.kill("SIGKILL");
      await h.exited;
      if (alive(sleeper)) process.kill(sleeper, "SIGKILL");
    }
  }, 30_000);
});
