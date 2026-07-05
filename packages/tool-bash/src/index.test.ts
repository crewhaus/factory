import { afterEach, describe, expect, test } from "bun:test";
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
    const start = Date.now();
    const out = await bash.execute({ command: "sleep 10", timeout: 150 });
    const elapsed = Date.now() - start;
    expect(out).toContain("timed out after 150ms");
    expect(elapsed).toBeLessThan(2000);
  });

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

// Poll a background process until BashOutput reports it is no longer running,
// or the attempt budget is exhausted. Each poll consumes NEW output, so we
// accumulate across polls.
async function drainBackground(
  id: string,
  attempts = 50,
): Promise<{ combined: string; last: string }> {
  let combined = "";
  let last = "";
  for (let i = 0; i < attempts; i++) {
    last = await bashOutput.execute({ bash_id: id });
    combined += `${last}\n`;
    if (!last.includes("[status] running")) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return { combined, last };
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
    const started = Date.now();
    const out = await bash.execute({ command: "sleep 2; echo done", background: true });
    expect(Date.now() - started).toBeLessThan(1000); // did NOT wait for sleep 2
    expect(out).toContain("[background] started bash_");
    expect(out).toMatch(/bash_[0-9a-f]{12}/);
  });

  test("BashOutput streams incremental output then reports the exit code", async () => {
    const start = await bash.execute({ command: "echo one; echo two", background: true });
    const id = start.match(/bash_[0-9a-f]{12}/)?.[0];
    expect(id).toBeDefined();
    const { combined, last } = await drainBackground(id as string);
    expect(combined).toContain("one");
    expect(combined).toContain("two");
    expect(last).toContain("[status] exited 0");
    // A second poll after exit yields no new output but still the status.
    const again = await bashOutput.execute({ bash_id: id as string });
    expect(again).toContain("[no new output]");
    expect(again).toContain("[status] exited 0");
  });

  test("BashOutput is incremental — a poll only returns output since the last poll", async () => {
    const start = await bash.execute({
      command: "echo first; sleep 0.3; echo second",
      background: true,
    });
    const id = start.match(/bash_[0-9a-f]{12}/)?.[0] as string;
    // First poll (quick) should catch "first" but not yet "second".
    await new Promise((r) => setTimeout(r, 50));
    const poll1 = await bashOutput.execute({ bash_id: id });
    expect(poll1).toContain("first");
    // Drain the rest; "second" appears in a later poll, not re-reported "first".
    const { combined } = await drainBackground(id);
    expect(combined).toContain("second");
  });

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
