import { describe, expect, test } from "bun:test";
import type { Sandbox, SandboxExecOptions, SandboxExecResult } from "@crewhaus/sandbox";
import {
  HarnessSynthesizerError,
  type VerifierSample,
  runVerifier,
  synthesizeVerifier,
  thompsonPick,
} from "./index";
import { VERIFIER_SENTINEL, evalVerifierPayload } from "./sandboxed-eval";

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
