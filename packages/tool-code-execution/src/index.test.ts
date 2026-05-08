import { afterEach, describe, expect, test } from "bun:test";
import type { Sandbox, SandboxExecOptions, SandboxExecResult } from "@crewhaus/sandbox";
import {
  _resetCodeExecutionConfig,
  allCodeExecutionTools,
  javascript,
  python,
  registerCodeExecutionConfig,
  shell,
} from "./index";

class StubSandbox implements Sandbox {
  readonly backend = "noop" as const;
  readonly calls: SandboxExecOptions[] = [];
  result: Partial<SandboxExecResult> = {};
  constructor(opts: Partial<SandboxExecResult> = {}) {
    this.result = opts;
  }
  async exec(opts: SandboxExecOptions): Promise<SandboxExecResult> {
    this.calls.push(opts);
    if (opts.onStdoutChunk !== undefined && (this.result.stdout ?? "").length > 0) {
      opts.onStdoutChunk(this.result.stdout ?? "");
    }
    if (opts.onStderrChunk !== undefined && (this.result.stderr ?? "").length > 0) {
      opts.onStderrChunk(this.result.stderr ?? "");
    }
    return {
      stdout: this.result.stdout ?? "",
      stderr: this.result.stderr ?? "",
      exitCode: this.result.exitCode ?? 0,
      timedOut: this.result.timedOut ?? false,
      durationMs: this.result.durationMs ?? 1.0,
    };
  }
  async close(): Promise<void> {}
}

afterEach(() => {
  _resetCodeExecutionConfig();
});

describe("tool flag declarations", () => {
  test("Python tool flags", () => {
    expect(python.name).toBe("Python");
    expect(python.requiresSandbox).toBe(true);
    expect(python.destructive).toBe(true);
    expect(python.readOnly).toBe(false);
    expect(python.classifyOutput).toBe(true);
  });
  test("JavaScript tool flags", () => {
    expect(javascript.name).toBe("JavaScript");
    expect(javascript.requiresSandbox).toBe(true);
    expect(javascript.destructive).toBe(true);
  });
  test("Shell tool flags", () => {
    expect(shell.name).toBe("Shell");
    expect(shell.requiresSandbox).toBe(true);
    expect(shell.destructive).toBe(true);
  });
  test("allCodeExecutionTools is the three tools", () => {
    expect(allCodeExecutionTools).toEqual([python, javascript, shell]);
  });
});

describe("Python tool — sandbox dispatch", () => {
  test("calls sandbox with python:3.13-slim image and python3 -c argv", async () => {
    const stub = new StubSandbox({ stdout: "hi" });
    registerCodeExecutionConfig({ sandbox: stub });
    const out = await python.execute({ code: "print('hi')" });
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.image).toBe("python:3.13-slim");
    expect(stub.calls[0]?.argv).toEqual(["python3", "-c", "print('hi')"]);
    expect(typeof out).toBe("string");
    expect(out as string).toContain("hi");
    expect(out as string).toContain("[exit] 0");
  });

  test("propagates per-call timeout to sandbox", async () => {
    const stub = new StubSandbox({ stdout: "" });
    registerCodeExecutionConfig({ sandbox: stub });
    await python.execute({ code: "x", timeout: 5_000 });
    expect(stub.calls[0]?.timeoutMs).toBe(5_000);
  });
});

describe("JavaScript tool — sandbox dispatch", () => {
  test("calls sandbox with node:22-alpine image and node -e argv", async () => {
    const stub = new StubSandbox({ stdout: "ok" });
    registerCodeExecutionConfig({ sandbox: stub });
    await javascript.execute({ code: "console.log('ok')" });
    expect(stub.calls[0]?.image).toBe("node:22-alpine");
    expect(stub.calls[0]?.argv).toEqual(["node", "-e", "console.log('ok')"]);
  });
});

describe("Shell tool — sandbox dispatch", () => {
  test("calls sandbox with alpine:3.19 image and sh -c argv", async () => {
    const stub = new StubSandbox({ stdout: "ok" });
    registerCodeExecutionConfig({ sandbox: stub });
    await shell.execute({ code: "echo ok" });
    expect(stub.calls[0]?.image).toBe("alpine:3.19");
    expect(stub.calls[0]?.argv).toEqual(["sh", "-c", "echo ok"]);
  });
});

describe("output formatting", () => {
  test("includes stderr block when stderr is non-empty", async () => {
    const stub = new StubSandbox({ stdout: "out", stderr: "warn", exitCode: 1 });
    registerCodeExecutionConfig({ sandbox: stub });
    const result = (await python.execute({ code: "x" })) as string;
    expect(result).toContain("out");
    expect(result).toContain("[stderr]");
    expect(result).toContain("warn");
    expect(result).toContain("[exit] 1");
  });

  test("indicates timeout in the exit line", async () => {
    const stub = new StubSandbox({ stdout: "", timedOut: true, exitCode: -9, durationMs: 60_000 });
    registerCodeExecutionConfig({ sandbox: stub });
    const result = (await shell.execute({ code: "sleep 1000" })) as string;
    expect(result).toContain("timed out");
  });
});

describe("streaming forwarding", () => {
  test("forwards stdout chunks via ctx.onStreamChunk", async () => {
    const stub = new StubSandbox({ stdout: "abcdef" });
    registerCodeExecutionConfig({ sandbox: stub });
    const captured: Array<[string, string]> = [];
    await python.execute(
      { code: "x" },
      {
        onStreamChunk: (s, c) => captured.push([s, c]),
      },
    );
    expect(captured).toContainEqual(["stdout", "abcdef"]);
  });

  test("forwards stderr chunks via ctx.onStreamChunk", async () => {
    const stub = new StubSandbox({ stderr: "warning" });
    registerCodeExecutionConfig({ sandbox: stub });
    const captured: Array<[string, string]> = [];
    await shell.execute(
      { code: "x" },
      {
        onStreamChunk: (s, c) => captured.push([s, c]),
      },
    );
    expect(captured).toContainEqual(["stderr", "warning"]);
  });
});

describe("config", () => {
  test("registerCodeExecutionConfig accepts snake_case keys", () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({
      sandbox: stub,
      allowed_images: ["my:image"],
      mount_whitelist: ["/srv"],
      default_timeout_ms: 12_345,
    });
    // No throw — the call applies snake_case keys.
  });

  test("custom image override is honoured", async () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({
      sandbox: stub,
      images: {
        python:
          "python:3.13-slim@sha256:abc1234567890123456789012345678901234567890123456789012345678901",
      },
    });
    await python.execute({ code: "x" });
    expect(stub.calls[0]?.image).toBe(
      "python:3.13-slim@sha256:abc1234567890123456789012345678901234567890123456789012345678901",
    );
  });

  test("mounts from config are forwarded to sandbox", async () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({
      sandbox: stub,
      mounts: { "/host/path": "/work" },
    });
    await shell.execute({ code: "x" });
    expect(stub.calls[0]?.mounts).toEqual([{ src: "/host/path", dst: "/work", readonly: true }]);
  });
});

describe("input schema", () => {
  test("inputSchema rejects empty code at the validator layer", () => {
    const result = python.inputSchema.safeParse({ code: "" });
    expect(result.success).toBe(false);
  });
  test("inputSchema rejects negative timeout", () => {
    const result = python.inputSchema.safeParse({ code: "x", timeout: -1 });
    expect(result.success).toBe(false);
  });
  test("inputSchema accepts well-formed input", () => {
    const result = python.inputSchema.safeParse({ code: "print('ok')", timeout: 5000 });
    expect(result.success).toBe(true);
  });
});
