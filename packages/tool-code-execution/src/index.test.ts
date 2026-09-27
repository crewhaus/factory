import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Sandbox,
  type SandboxExecOptions,
  type SandboxExecResult,
  createSandbox,
} from "@crewhaus/sandbox";
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
  readonly execDefaults: { readonly timeoutMs: number } | undefined;
  constructor(opts: Partial<SandboxExecResult> = {}, defaultTimeoutMs?: number) {
    this.result = opts;
    this.execDefaults =
      defaultTimeoutMs === undefined ? undefined : { timeoutMs: defaultTimeoutMs };
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
      ...this.result,
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

describe("a run that did not finish on its own says so", () => {
  test("a cancelled run reads as cancelled, not as a normal exit", async () => {
    const stub = new StubSandbox({
      stdout: "partial",
      aborted: true,
      exitCode: 137,
      durationMs: 812,
    });
    registerCodeExecutionConfig({ sandbox: stub });
    const out = (await shell.execute({ code: "sleep 100" })) as string;
    expect(out.endsWith("[exit] 137 (cancelled after 812ms)")).toBe(true);
  });

  test("a container the sandbox could not confirm gone is named in the result", async () => {
    const stub = new StubSandbox({
      aborted: true,
      exitCode: -1,
      durationMs: 5_100,
      strayContainer: {
        name: "crewhaus-sbx-0123456789abcdef",
        reason: "docker rm -f did not answer within 5s",
      },
    });
    registerCodeExecutionConfig({ sandbox: stub });
    const out = String(await shell.execute({ code: "sleep 60" }));
    expect(out).toBe(
      [
        "[sandbox] container crewhaus-sbx-0123456789abcdef may still exist: docker rm -f did not answer within 5s. The sandbox retries the removal in the background.",
        "[exit] -1 (cancelled after 5100ms)",
      ].join("\n"),
    );
  });

  test("a drain cut short is flagged, not presented as the whole output", async () => {
    const stub = new StubSandbox({ stdout: "first line\n", outputComplete: false });
    registerCodeExecutionConfig({ sandbox: stub });
    const out = (await shell.execute({ code: "echo first line; sleep 100 &" })) as string;
    expect(out).toContain("first line\n[output incomplete:");
    expect(out).toContain("[exit] 0 (1ms)");
  });

  test("trailing newlines are trimmed in linear time", async () => {
    // `/\n+$/` backtracks over every run of newlines: 120 000 of them before
    // a final character took seconds. The loop takes microseconds.
    const stub = new StubSandbox({ stdout: `${"\n".repeat(120_000)}x\n\n`, stderr: "e\n" });
    registerCodeExecutionConfig({ sandbox: stub });
    const t0 = performance.now();
    const out = (await shell.execute({ code: "x" })) as string;
    expect(performance.now() - t0).toBeLessThan(1_500);
    expect(out.startsWith("\n".repeat(120_000))).toBe(true);
    expect(out.slice(120_000)).toBe("x\n[stderr]\ne\n[exit] 0 (1ms)");
  }, 20_000);
});

// security-12#4: the program's output reached the tool result whole.
describe("output is capped before it reaches the model", () => {
  test("a flood from the program comes back as its start, a count, and its end", async () => {
    registerCodeExecutionConfig({ backend: "noop" });
    const out = String(
      await shell.execute({ code: "head -c 3000000 /dev/zero | tr '\\0' a; echo; echo LAST" }),
    );
    expect(out.length).toBeLessThan(1_100_000);
    expect(out).toMatch(/\n\[stdout truncated: \d+ bytes dropped\]\n/);
    expect(out).toMatch(/\nLAST\n\[exit\] 0 \(\d+ms\)$/);
  }, 20_000);
});

// security-6#1, defence in depth: CREWHAUS_SANDBOX=noop means "code execution
// off". The floor denies these tools; a call that gets past it (bypass mode,
// a loop told a sandbox exists) must not run the code on the host.
describe("CREWHAUS_SANDBOX=noop turns code execution off", () => {
  const before = process.env["CREWHAUS_SANDBOX"];
  afterEach(() => {
    if (before === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SANDBOX");
    else process.env["CREWHAUS_SANDBOX"] = before;
  });

  for (const value of ["noop", "noop ", " NOOP\r"]) {
    test(`with CREWHAUS_SANDBOX=${JSON.stringify(value)} a call is refused and nothing runs`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "code-exec-noop-"));
      try {
        const marker = join(dir, "ran");
        process.env["CREWHAUS_SANDBOX"] = value;
        registerCodeExecutionConfig({});
        const refusal = shell.execute({ code: `touch ${marker}` });
        await expect(refusal).rejects.toThrow(
          /Shell refused: CREWHAUS_SANDBOX=noop turns code execution off/,
        );
        // A test suite that set the variable to run code in-process (0.7.0
        // allowed it) is told what to do instead.
        await expect(refusal).rejects.toThrow('registerCodeExecutionConfig({ backend: "noop" })');
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("trusted code that picks the noop backend itself still runs it (how tests use it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "code-exec-noop-"));
    try {
      const marker = join(dir, "ran");
      process.env["CREWHAUS_SANDBOX"] = "noop";
      registerCodeExecutionConfig({ backend: "noop" });
      const out = String(await shell.execute({ code: `touch ${marker}` }));
      expect(out).toContain("[exit] 0");
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// security-6#15: the model's `timeout` (up to 600 s) replaced the operator's
// default outright, and the operator had no maximum.
describe("max_timeout_ms caps every call", () => {
  test("a model timeout above the cap runs at the cap, and the result says so", async () => {
    const stub = new StubSandbox({ timedOut: true, exitCode: 137, durationMs: 1_000 });
    registerCodeExecutionConfig({
      sandbox: stub,
      default_timeout_ms: 1_000,
      max_timeout_ms: 1_000,
    });
    const out = (await python.execute({ code: "x", timeout: 600_000 })) as string;
    expect(stub.calls[0]?.timeoutMs).toBe(1_000);
    expect(out).toContain(
      "[exit] 137 (timed out after 1000ms; timeout capped at 1000ms by the operator's max_timeout_ms (asked for 600000ms))",
    );
  });

  test("below the cap the model's timeout is used as asked", async () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({
      sandbox: stub,
      default_timeout_ms: 1_000,
      maxTimeoutMs: 120_000,
    });
    await python.execute({ code: "x", timeout: 90_000 });
    await python.execute({ code: "x", timeout: 600_000 });
    await python.execute({ code: "x", timeout: 500 });
    expect(stub.calls.map((c) => c.timeoutMs)).toEqual([90_000, 120_000, 500]);
  });

  test("the operator's default is clamped too", async () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({
      sandbox: stub,
      default_timeout_ms: 5_000,
      max_timeout_ms: 1_000,
    });
    await python.execute({ code: "x" });
    expect(stub.calls[0]?.timeoutMs).toBe(1_000);
  });

  test("with no cap configured a model timeout is honoured as in 0.7.0", async () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({ sandbox: stub, default_timeout_ms: 1_000 });
    const out = (await python.execute({ code: "x", timeout: 600_000 })) as string;
    expect(stub.calls[0]?.timeoutMs).toBe(600_000);
    expect(out).not.toContain("capped");
  });

  test("a serving candidate's tool_config can lower the cap, never raise it", async () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({ sandbox: stub, max_timeout_ms: 5_000 });
    await python.execute(
      { code: "x", timeout: 600_000 },
      { toolConfig: { max_timeout_ms: 2_000 } },
    );
    await python.execute(
      { code: "x", timeout: 600_000 },
      { toolConfig: { max_timeout_ms: 9_000 } },
    );
    await python.execute({ code: "x" }, { toolConfig: { default_timeout_ms: 900_000 } });
    expect(stub.calls.map((c) => c.timeoutMs)).toEqual([2_000, 5_000, 5_000]);
  });

  test("a cap that cannot be read is refused at registration, not treated as no cap", () => {
    for (const bad of [0, -1, Number.NaN, "60000"]) {
      expect(() =>
        registerCodeExecutionConfig({ max_timeout_ms: bad as unknown as number }),
      ).toThrow(/max_timeout_ms must be a number of milliseconds > 0/);
      // Under either spelling, whatever the other one says.
      expect(() =>
        registerCodeExecutionConfig({
          maxTimeoutMs: 1_000,
          max_timeout_ms: bad as unknown as number,
        }),
      ).toThrow(/max_timeout_ms must be a number of milliseconds > 0/);
    }
  });

  // C169: `max_timeout_ms: 1000` next to `maxTimeoutMs: 600000` ran calls for
  // 600 s — the camelCase spelling won, and the operator's cap was gone.
  test("a cap written under both spellings holds at the smaller, in either order", async () => {
    for (const [camel, snake] of [
      [600_000, 1_000],
      [1_000, 600_000],
    ] as const) {
      const stub = new StubSandbox({});
      registerCodeExecutionConfig({ sandbox: stub, maxTimeoutMs: camel, max_timeout_ms: snake });
      await python.execute({ code: "x", timeout: 600_000 });
      expect(stub.calls[0]?.timeoutMs).toBe(1_000);
    }
  });

  test("a candidate's cap written under both spellings holds at the smaller", async () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({ sandbox: stub, max_timeout_ms: 60_000 });
    await python.execute(
      { code: "x", timeout: 600_000 },
      { toolConfig: { maxTimeoutMs: 30_000, max_timeout_ms: 2_000 } },
    );
    expect(stub.calls[0]?.timeoutMs).toBe(2_000);
  });

  test("the model is told the timeout can be capped", () => {
    const shape = (
      python.inputSchema as unknown as { shape: Record<string, { description?: string }> }
    ).shape;
    expect(shape["timeout"]?.description).toContain("The operator may cap it lower.");
  });

  // The description said "default 60000" whatever default_timeout_ms was set
  // to, so a model could plan on 60 s and be killed at 5.
  test("the model is not promised a default the operator may have changed", () => {
    for (const tool of allCodeExecutionTools) {
      const shape = (
        tool.inputSchema as unknown as { shape: Record<string, { description?: string }> }
      ).shape;
      const description = shape["timeout"]?.description ?? "";
      expect({ tool: tool.name, fixedDefault: /\(default \d+/.test(description) }).toEqual({
        tool: tool.name,
        fixedDefault: false,
      });
      expect(description).toContain("the operator's default applies (60000 unless configured)");
    }
  });

  // An injected sandbox's own default (60 s for the built-in backends) ran a
  // call with no timeout of its own past the cap: a 500 ms cap let `sleep 2`
  // finish after 2 s.
  test("a call with no timeout on an injected sandbox is capped at the sandbox's own default", async () => {
    const stub = new StubSandbox({}, 60_000);
    registerCodeExecutionConfig({ sandbox: stub, max_timeout_ms: 500 });
    await shell.execute({ code: "x" });
    expect(stub.calls[0]?.timeoutMs).toBe(500);
  });

  test("an injected sandbox whose default is under the cap keeps it", async () => {
    const stub = new StubSandbox({}, 200);
    registerCodeExecutionConfig({ sandbox: stub, max_timeout_ms: 500 });
    await shell.execute({ code: "x" });
    expect(stub.calls[0]?.timeoutMs).toBe(200);
  });

  test("an injected sandbox that does not say its default runs a capped call at the cap", async () => {
    const stub = new StubSandbox({});
    registerCodeExecutionConfig({ sandbox: stub, max_timeout_ms: 500 });
    await shell.execute({ code: "x" });
    expect(stub.calls[0]?.timeoutMs).toBe(500);
  });

  test.if(process.platform !== "win32")(
    "a real injected sandbox: sleep 5 under a 500 ms cap is stopped by the cap",
    async () => {
      registerCodeExecutionConfig({
        sandbox: createSandbox({ backend: "noop" }),
        max_timeout_ms: 500,
      });
      const out = String(await shell.execute({ code: "sleep 5; echo done" }));
      expect(out).not.toContain("done");
      expect(out).toMatch(/^\[exit\] -?\d+ \(timed out after \d+ms\)$/);
    },
    20_000,
  );
});
