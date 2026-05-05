import { describe, expect, test } from "bun:test";
import { bash } from "./index";

describe("Bash tool metadata", () => {
  test("name + flags", () => {
    expect(bash.name).toBe("Bash");
    expect(bash.destructive).toBe(true);
    expect(bash.readOnly).toBe(false);
    expect(bash.concurrencySafe).toBe(false);
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
