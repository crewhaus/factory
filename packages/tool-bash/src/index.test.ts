import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetBackgroundProcsForTest, bash, bashOutput, killShell } from "./index";

describe("Bash tool metadata", () => {
  test("name + flags", () => {
    expect(bash.name).toBe("Bash");
    expect(bash.destructive).toBe(true);
    expect(bash.readOnly).toBe(false);
    expect(bash.concurrencySafe).toBe(false);
  });

  test("crosses a process boundary → external scope + process io-capability (#146)", () => {
    expect(bash.scope).toBe("external");
    expect(bash.ioCapability).toBe("process");
  });
});

describe("Bash tool execution", () => {
  test("captures stdout and exit code 0 on success", async () => {
    const out = await bash.execute({ command: "echo hello" });
    expect(out).toContain("hello");
    expect(out).toContain("[exit] 0");
    expect(out).not.toContain("timed out");
  });

  test("reports non-zero exit code", async () => {
    const out = await bash.execute({ command: "exit 7" });
    expect(out).toContain("[exit] 7");
  });

  test("captures stderr separately from stdout", async () => {
    const out = await bash.execute({ command: ">&2 echo oops" });
    expect(out).toContain("[stderr]");
    expect(out).toContain("oops");
  });

  test("captures both streams and shows them in order", async () => {
    const out = await bash.execute({
      command: "echo out; >&2 echo err; exit 1",
    });
    expect(out).toContain("out");
    expect(out).toContain("[stderr]");
    expect(out).toContain("err");
    expect(out).toContain("[exit] 1");
  });

  test("kills the process and reports timeout when exceeded", async () => {
    // The command outlasts this test's budget, so only the kill at the
    // timeout can end the call in time; a call that waited for it fails here
    // at the budget. Nothing is timed: a 2 s bound on the call (about 0.65 s
    // on CI) raced the runner. `exec`, so the kill reaches the sleep itself.
    const out = await bash.execute({ command: "exec sleep 120", timeout: 150 });
    expect(out).toContain("timed out after 150ms");
  }, 20_000);

  test("does not time out when command finishes within budget", async () => {
    const out = await bash.execute({ command: "echo fast", timeout: 5000 });
    expect(out).not.toContain("timed out");
    expect(out).toContain("fast");
    expect(out).toContain("[exit] 0");
  });

  test("rejects timeouts above the cap via schema", () => {
    const result = bash.inputSchema.safeParse({
      command: "echo",
      timeout: 999_999_999,
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty command via schema", () => {
    const result = bash.inputSchema.safeParse({ command: "" });
    expect(result.success).toBe(false);
  });
});

/**
 * Poll a background process until what its polls returned, together,
 * satisfies `done`, and return that. Ends on the output, not on a count of
 * polls a slow runner could exhaust; `hangStopMs` only stops a wait for
 * output that never comes, and the assertions after it then fail.
 */
async function pollUntil(
  id: string,
  done: (seen: string) => boolean,
  hangStopMs = 10_000,
): Promise<string> {
  const began = performance.now();
  let seen = "";
  for (;;) {
    seen += `${await bashOutput.execute({ bash_id: id })}\n`;
    if (done(seen) || performance.now() - began > hangStopMs) return seen;
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("background Bash + BashOutput + KillShell", () => {
  afterEach(() => {
    __resetBackgroundProcsForTest();
  });

  test("metadata: BashOutput internal/serial, KillShell destructive", () => {
    expect(bashOutput.name).toBe("BashOutput");
    expect(bashOutput.destructive).toBe(false);
    expect(bashOutput.concurrencySafe).toBe(false); // advances a read cursor → serial
    expect(killShell.name).toBe("KillShell");
    expect(killShell.destructive).toBe(true);
  });

  test("background:true returns a bash_id immediately without blocking", async () => {
    // The command waits for a file this test creates only after the call has
    // returned, so a call that waited for the command would never return (the
    // budget stops it), and it is still running once the call has. Nothing is
    // timed: "under 1 s, against a 2 s sleep" raced the runner.
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-bash-gate-"));
    const gate = join(dir, "release");
    try {
      const out = await bash.execute({
        command: `while [ ! -f '${gate}' ]; do sleep 0.01; done; echo done`,
        background: true,
      });
      expect(out).toContain("[background] started bash_");
      expect(out).toMatch(/bash_[0-9a-f]{12}/);
      const id = out.match(/bash_[0-9a-f]{12}/)?.[0] as string;
      expect(await bashOutput.execute({ bash_id: id })).toContain("[status] running");
      writeFileSync(gate, "");
      const after = await pollUntil(
        id,
        (seen) => seen.includes("done") && seen.includes("[status] exited"),
      );
      expect(after).toContain("done");
      expect(after).toContain("[status] exited 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("BashOutput streams incremental output then reports the exit code", async () => {
    const start = await bash.execute({ command: "echo one; echo two", background: true });
    const id = start.match(/bash_[0-9a-f]{12}/)?.[0];
    expect(id).toBeDefined();
    // Ends on the output and the exit, not after a fixed 50 polls (about a
    // second), which a child slow to start ran out: it then saw only
    // "[status] running". Wait for both, as the sibling below does.
    const seen = await pollUntil(
      id as string,
      (polled) => polled.includes("two") && polled.includes("[status] exited"),
    );
    expect(seen).toContain("one");
    expect(seen).toContain("two");
    expect(seen).toContain("[status] exited 0");
    // A second poll after exit yields no new output but still the status.
    const again = await bashOutput.execute({ bash_id: id as string });
    expect(again).toContain("[no new output]");
    expect(again).toContain("[status] exited 0");
  }, 30_000);

  test("BashOutput is incremental — a poll only returns output since the last poll", async () => {
    // The second line waits for a file this test creates once it has polled
    // the first, so the order is caused, not hoped for: a fixed 50 ms sleep
    // before the first poll raced the shell's start, and a slow start left
    // the poll empty. Each wait ends on what it waits for; 10 s only stops
    // one that never comes.
    const dir = mkdtempSync(join(tmpdir(), "crewhaus-bash-gate-"));
    const gate = join(dir, "release-second");
    try {
      const start = await bash.execute({
        command: `echo first; while [ ! -f '${gate}' ]; do sleep 0.01; done; echo second`,
        background: true,
      });
      const id = start.match(/bash_[0-9a-f]{12}/)?.[0] as string;
      const before = await pollUntil(id, (seen) => seen.includes("first"));
      expect(before).toContain("first");
      expect(before).not.toContain("second");
      expect(before).toContain("[status] running");

      writeFileSync(gate, "");
      // The rest: "second" and the exit, with "first" not reported again.
      // Wait for both: Bun settles the exit apart from the stdout pump, so a
      // poll can report the exit before the last chunk has been appended.
      const after = await pollUntil(
        id,
        (seen) => seen.includes("second") && seen.includes("[status] exited"),
      );
      expect(after).toContain("second");
      expect(after).not.toContain("first");
      expect(after).toContain("[status] exited 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("KillShell stops a long-running background process", async () => {
    const start = await bash.execute({ command: "sleep 30", background: true });
    const id = start.match(/bash_[0-9a-f]{12}/)?.[0] as string;
    const killed = await killShell.execute({ bash_id: id });
    expect(killed).toContain("SIGKILL");
    const status = await bashOutput.execute({ bash_id: id });
    expect(status).toContain("[status] killed");
    // Killing again is a no-op, not an error.
    const again = await killShell.execute({ bash_id: id });
    expect(again).toContain("already killed");
  });

  test("BashOutput / KillShell on an unknown id return a clean error, not a throw", async () => {
    const o = await bashOutput.execute({ bash_id: "bash_deadbeef0000" });
    expect(o).toContain("no background process");
    const k = await killShell.execute({ bash_id: "bash_deadbeef0000" });
    expect(k).toContain("no background process");
  });

  test("foreground path is unchanged when background is omitted", async () => {
    const out = await bash.execute({ command: "echo fg" });
    expect(out).toContain("fg");
    expect(out).toContain("[exit] 0");
  });
});
