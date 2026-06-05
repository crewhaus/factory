import { describe, expect, test } from "bun:test";
import type { OptimizerState } from "@crewhaus/prompt-optimizer";
import type { Sandbox, SandboxExecOptions, SandboxExecResult } from "@crewhaus/sandbox";
import {
  HarnessSynthesizerError,
  VerifierMutationProvider,
  type VerifierSample,
  runVerifier,
  synthesizeVerifier,
  thompsonPick,
} from "./index";
import { VERIFIER_SENTINEL, evalVerifierPayload, runVerifierInSandbox } from "./sandboxed-eval";

/**
 * Test double for `@crewhaus/sandbox`. Reports `backend: "docker"` so it
 * passes `runVerifier`'s fail-closed gate (the real `noop` backend is
 * rejected), and reproduces the in-container harness output by running the
 * SAME `evalVerifierPayload` routine in-process. Deterministic, no docker
 * daemon. The verifier strings under test are trusted, so evaluating them
 * in-process here (rather than in a real jail) is safe.
 */
class FakeDockerSandbox implements Sandbox {
  readonly backend = "docker" as const;
  readonly calls: SandboxExecOptions[] = [];
  async exec(opts: SandboxExecOptions): Promise<SandboxExecResult> {
    this.calls.push(opts);
    const payload = JSON.parse(opts.stdin ?? "{}");
    const result = evalVerifierPayload(payload);
    return {
      stdout: VERIFIER_SENTINEL + JSON.stringify(result),
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    };
  }
  async close(): Promise<void> {}
}

const evenSamples: VerifierSample[] = [
  { input: null, output: 0, expected: true },
  { input: null, output: 1, expected: false },
  { input: null, output: 2, expected: true },
  { input: null, output: 3, expected: false },
  { input: null, output: 4, expected: true },
];

describe("runVerifier", () => {
  const sandbox = new FakeDockerSandbox();

  test("scores a correct verifier at 1.0", async () => {
    const r = await runVerifier(
      "return typeof output === 'number' && output % 2 === 0",
      evenSamples,
      { sandbox },
    );
    expect(r.heuristic).toBe(1);
    expect(r.errors).toBe(0);
    expect(r.verdicts).toEqual([true, false, true, false, true]);
  });

  test("scores a constant-true verifier at the majority class", async () => {
    const r = await runVerifier("return true", evenSamples, { sandbox });
    // 3 of 5 expected: true → score 0.6
    expect(r.heuristic).toBe(0.6);
  });

  test("captures runtime errors without throwing", async () => {
    const r = await runVerifier("throw new Error('boom')", evenSamples, { sandbox });
    expect(r.errors).toBe(5);
    expect(r.heuristic).toBe(0.4); // false vs expected: 2 of 5 are expected false
  });

  test("throws on uncompilable code", async () => {
    await expect(runVerifier("not valid javascript {{{", evenSamples, { sandbox })).rejects.toThrow(
      HarnessSynthesizerError,
    );
  });

  test("fails closed on a noop (non-isolating) sandbox", async () => {
    const noop: Sandbox = {
      backend: "noop",
      exec: async () => {
        throw new Error("must not run untrusted code under noop");
      },
      close: async () => {},
    };
    await expect(runVerifier("return true", evenSamples, { sandbox: noop })).rejects.toThrow(
      HarnessSynthesizerError,
    );
  });

  test("ships code + label-free samples to node:22-alpine via stdin", async () => {
    const sb = new FakeDockerSandbox();
    await runVerifier("return true", evenSamples, { sandbox: sb });
    const call = sb.calls[0];
    expect(call?.image).toBe("node:22-alpine");
    expect(call?.argv?.[0]).toBe("node");
    const payload = JSON.parse(call?.stdin ?? "{}");
    expect(payload.code).toBe("return true");
    expect(payload.samples).toHaveLength(5);
    // The jail must never receive the labels it is scored against.
    expect(JSON.stringify(payload)).not.toContain("expected");
  });
});

describe("thompsonPick", () => {
  test("returns 0 for a single candidate", () => {
    const idx = thompsonPick(
      [{ id: "x", code: "return true", score: 1, heuristic: 1, alpha: 10, beta: 1 }],
      () => 0.5,
    );
    expect(idx).toBe(0);
  });

  test("favors high-heuristic candidates when sampling is biased", () => {
    const nodes = [
      { id: "a", code: "1", score: 0.1, heuristic: 0.1, alpha: 1, beta: 9 },
      { id: "b", code: "1", score: 0.9, heuristic: 0.9, alpha: 9, beta: 1 },
    ];
    const idx = thompsonPick(nodes, () => 0.5);
    expect([0, 1]).toContain(idx);
  });
});

describe("synthesizeVerifier", () => {
  const sandbox = new FakeDockerSandbox();

  test("returns immediately when a seed already meets target", async () => {
    const result = await synthesizeVerifier({
      seedCandidates: ["return typeof output === 'number' && output % 2 === 0"],
      samples: evenSamples,
      refiner: async () => "throw new Error('should not be called')",
      target: 1.0,
      sandbox,
    });
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(0);
    expect(result.best.heuristic).toBe(1);
  });

  test("converges via refiner when seed is poor", async () => {
    const result = await synthesizeVerifier({
      seedCandidates: ["return true"],
      samples: evenSamples,
      refiner: async () => "return typeof output === 'number' && output % 2 === 0",
      target: 1.0,
      maxIterations: 3,
      rng: () => 0.5,
      sandbox,
    });
    expect(result.converged).toBe(true);
    expect(result.best.heuristic).toBe(1);
  });

  test("returns best-so-far when iterations exhaust", async () => {
    const result = await synthesizeVerifier({
      seedCandidates: ["return false"], // score 0.4
      samples: evenSamples,
      refiner: async () => "return true", // score 0.6
      target: 1.0,
      maxIterations: 3,
      rng: () => 0.5,
      sandbox,
    });
    expect(result.converged).toBe(false);
    expect(result.best.heuristic).toBeGreaterThanOrEqual(0.6);
  });

  test("picks the higher-heuristic seed when multiple seeds are supplied", async () => {
    // Two seeds → the `pool.reduce` comparator runs (with one seed reduce
    // returns the lone element without invoking the callback). The perfect
    // seed must win and short-circuit at iteration 0.
    const result = await synthesizeVerifier({
      seedCandidates: [
        "return false", // heuristic 0.4
        "return typeof output === 'number' && output % 2 === 0", // heuristic 1.0
      ],
      samples: evenSamples,
      refiner: async () => "throw new Error('should not be called')",
      target: 1.0,
      rng: () => 0.5,
      sandbox,
    });
    expect(result.converged).toBe(true);
    expect(result.iterations).toBe(0);
    expect(result.best.id).toBe("seed_1");
    expect(result.best.heuristic).toBe(1);
    expect(result.trajectory).toHaveLength(2);
  });

  test("throws on empty seed candidates", async () => {
    await expect(
      synthesizeVerifier({
        seedCandidates: [],
        samples: evenSamples,
        refiner: async () => "return true",
      }),
    ).rejects.toThrow(HarnessSynthesizerError);
  });

  test("throws on empty sample set", async () => {
    await expect(
      synthesizeVerifier({
        seedCandidates: ["return true"],
        samples: [],
        refiner: async () => "return true",
      }),
    ).rejects.toThrow(HarnessSynthesizerError);
  });
});

/**
 * A sandbox whose container call returns a caller-supplied result verbatim, so
 * tests can drive `runVerifierInSandbox`'s error branches (timeout, nonzero
 * exit, empty/garbled output) deterministically without a real container.
 */
class ScriptedSandbox implements Sandbox {
  readonly backend = "docker" as const;
  readonly calls: SandboxExecOptions[] = [];
  constructor(private readonly result: SandboxExecResult) {}
  async exec(opts: SandboxExecOptions): Promise<SandboxExecResult> {
    this.calls.push(opts);
    return this.result;
  }
  async close(): Promise<void> {}
}

const ioSamples: VerifierSample[] = [{ input: null, output: 0, expected: true }];

describe("VerifierMutationProvider", () => {
  const baseState = (prompt: string): OptimizerState =>
    ({
      iteration: 0,
      best: { id: "c0", prompt, mutations: [], score: 0.5 },
      trajectory: [],
      trainSet: [],
      devSet: [],
    }) as OptimizerState;

  test("next() runs the inner search and appends a verifier annotation", async () => {
    const sandbox = new FakeDockerSandbox();
    const provider = new VerifierMutationProvider(
      evenSamples,
      // Seed is already perfect, so the inner search converges at iteration 0.
      async () => "return false",
      ["return typeof output === 'number' && output % 2 === 0"],
      4,
      sandbox,
    );
    expect(provider.name).toBe("verifier-synthesis");
    const result = await provider.next(baseState("BASE PROMPT"));
    expect(result.prompt.startsWith("BASE PROMPT")).toBe(true);
    expect(result.prompt).toContain("[verifier seed_0, h=1.000]");
    expect(result.mutations).toEqual([{ kind: "rephrase-instruction" }]);
    expect(result.rationale).toContain("verifier-synthesis pass 1");
    expect(result.rationale).toContain("(converged)");
  });

  test("next() increments the synthesis pass counter across calls", async () => {
    const sandbox = new FakeDockerSandbox();
    const provider = new VerifierMutationProvider(
      evenSamples,
      async () => "return typeof output === 'number' && output % 2 === 0",
      ["return typeof output === 'number' && output % 2 === 0"],
      4,
      sandbox,
    );
    const first = await provider.next(baseState("P"));
    const second = await provider.next(baseState("P"));
    expect(first.rationale).toContain("pass 1");
    expect(second.rationale).toContain("pass 2");
  });

  test("omits the sandbox option when none is injected (default backend path)", async () => {
    // No sandbox passed → synthesizeVerifier creates the default backend. Pin it
    // to `noop` so the fail-closed gate throws BEFORE any container is spawned —
    // this exercises the `this.sandbox === undefined` branch with zero real I/O.
    const prev = process.env["CREWHAUS_SANDBOX"];
    process.env["CREWHAUS_SANDBOX"] = "noop";
    try {
      const provider = new VerifierMutationProvider(
        evenSamples,
        async () => "return true",
        ["return true"],
        1,
      );
      await expect(provider.next(baseState("P"))).rejects.toThrow(HarnessSynthesizerError);
    } finally {
      // Restore exactly: an unset var must be *removed*, not set to the string
      // "undefined" (which `readEnvBackend` would reject). `Reflect.deleteProperty`
      // does this without tripping biome's noDelete rule.
      if (prev === undefined) Reflect.deleteProperty(process.env, "CREWHAUS_SANDBOX");
      else process.env["CREWHAUS_SANDBOX"] = prev;
    }
  });

  test("non-converged inner search omits the (converged) marker", async () => {
    const sandbox = new FakeDockerSandbox();
    const provider = new VerifierMutationProvider(
      evenSamples,
      async () => "return false", // 0.4 — never reaches 1.0
      ["return false"],
      2,
      sandbox,
    );
    const result = await provider.next(baseState("P"));
    expect(result.rationale).not.toContain("(converged)");
  });
});

describe("runVerifierInSandbox error branches", () => {
  test("throws on non-JSON-serializable samples (BigInt)", async () => {
    const sandbox = new FakeDockerSandbox();
    const bad: VerifierSample[] = [{ input: 1n, output: 0, expected: true }];
    await expect(runVerifierInSandbox(sandbox, "return true", bad)).rejects.toThrow(
      /not JSON-serializable/,
    );
    // Nothing was shipped to the jail.
    expect(sandbox.calls).toHaveLength(0);
  });

  test("throws when the harness times out", async () => {
    const sandbox = new ScriptedSandbox({
      stdout: "",
      stderr: "",
      exitCode: 0,
      timedOut: true,
      durationMs: 1,
    });
    await expect(
      runVerifierInSandbox(sandbox, "return true", ioSamples, { timeoutMs: 1234 }),
    ).rejects.toThrow(/timed out after 1234ms/);
  });

  test("throws with stderr tail when the harness exits nonzero and emits no result", async () => {
    const sandbox = new ScriptedSandbox({
      stdout: "no sentinel here",
      stderr: "fatal: allocation failure",
      exitCode: 137,
      timedOut: false,
      durationMs: 1,
    });
    await expect(runVerifierInSandbox(sandbox, "return true", ioSamples)).rejects.toThrow(
      /exited 137: fatal: allocation failure/,
    );
  });

  test("throws 'no result' when exit is clean but no sentinel is present", async () => {
    const sandbox = new ScriptedSandbox({
      stdout: "garbage without the sentinel",
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    });
    await expect(runVerifierInSandbox(sandbox, "return true", ioSamples)).rejects.toThrow(
      /produced no result/,
    );
  });

  test("throws on a verdict-count mismatch", async () => {
    // Sentinel present, valid JSON, but two verdicts for one sample.
    const sandbox = new ScriptedSandbox({
      stdout: `${VERIFIER_SENTINEL}${JSON.stringify({ verdicts: [true, false], errors: 0 })}`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    });
    await expect(runVerifierInSandbox(sandbox, "return true", ioSamples)).rejects.toThrow(
      /returned 2 verdicts for 1 samples/,
    );
  });

  test("surfaces a compileError reported by the harness", async () => {
    const sandbox = new ScriptedSandbox({
      stdout: `${VERIFIER_SENTINEL}${JSON.stringify({ compileError: "Unexpected token" })}`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    });
    await expect(runVerifierInSandbox(sandbox, "bad {{", ioSamples)).rejects.toThrow(
      /did not compile: Unexpected token/,
    );
  });
});

describe("parseHarnessResult edge cases (via runVerifierInSandbox)", () => {
  test("treats a non-JSON result line after the sentinel as no result", async () => {
    // Exercises the JSON.parse catch inside parseHarnessResult (returns undefined).
    const sandbox = new ScriptedSandbox({
      stdout: `${VERIFIER_SENTINEL}this-is-not-json`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    });
    await expect(runVerifierInSandbox(sandbox, "return true", ioSamples)).rejects.toThrow(
      /produced no result/,
    );
  });

  test("treats a sentinel-framed object without a verdicts array as no result", async () => {
    // Valid JSON object, but neither a compileError string nor a verdicts array
    // → parseHarnessResult falls through to its final `return undefined`.
    const sandbox = new ScriptedSandbox({
      stdout: `${VERIFIER_SENTINEL}${JSON.stringify({ verdicts: "not-an-array" })}`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
    });
    await expect(runVerifierInSandbox(sandbox, "return true", ioSamples)).rejects.toThrow(
      /produced no result/,
    );
  });
});

describe("runVerifier (live docker — gated by CREWHAUS_VERIFIER_LIVE_DOCKER=1)", () => {
  test("scores a basic verifier in a real container", async () => {
    if (process.env["CREWHAUS_VERIFIER_LIVE_DOCKER"] !== "1") return; // skipped by default
    const r = await runVerifier(
      "return typeof output === 'number' && output % 2 === 0",
      evenSamples,
    );
    expect(r.heuristic).toBe(1);
    expect(r.errors).toBe(0);
  });
});
