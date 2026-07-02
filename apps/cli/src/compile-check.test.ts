import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Unit coverage for the `compile --check` core (item 33). Everything that
 * would spawn a subprocess goes through an injected `CheckStepRunner`, so
 * no test touches the network, bun's registry, or a real boot.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShapeAssertion } from "@crewhaus/smoke-harness";
import {
  BOOT_GATE_PATTERNS,
  type CheckRunResult,
  type CheckStepRunner,
  buildBundlePackageJson,
  buildVerdict,
  classifyBootOutcome,
  collectCrewhausDeps,
  resolveBootEntry,
  runCompileCheck,
} from "./compile-check";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-compile-check-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const run = (over: Partial<CheckRunResult> = {}): CheckRunResult => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  ...over,
});

describe("collectCrewhausDeps", () => {
  test("collects, dedupes, and sorts @crewhaus imports across files", () => {
    const files = [
      {
        path: "agent.ts",
        content:
          'import { runChatLoop } from "@crewhaus/runtime-core";\n' +
          'import { read } from "@crewhaus/tool-fs";\n' +
          'const dyn = await import("@crewhaus/runtime-core");\n',
      },
      { path: "daemon.ts", content: "import '@crewhaus/gateway-server';" },
    ];
    expect(collectCrewhausDeps(files)).toEqual([
      "@crewhaus/gateway-server",
      "@crewhaus/runtime-core",
      "@crewhaus/tool-fs",
    ]);
  });

  test("ignores non-code files and non-@crewhaus specifiers", () => {
    const files = [
      { path: "README.md", content: '"@crewhaus/should-not-count"' },
      { path: "agent.ts", content: 'import { z } from "zod";' },
    ];
    expect(collectCrewhausDeps(files)).toEqual([]);
  });
});

describe("buildBundlePackageJson", () => {
  test("emits a private module manifest with latest-pinned deps", () => {
    const manifest = JSON.parse(buildBundlePackageJson(["@crewhaus/runtime-core"]));
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.dependencies).toEqual({ "@crewhaus/runtime-core": "latest" });
  });
});

describe("resolveBootEntry", () => {
  test("daemon.ts beats agent.ts; agent.ts is the fallback; else undefined", () => {
    const f = (...paths: string[]) => paths.map((p) => ({ path: p, content: "" }));
    expect(resolveBootEntry(f("agent.ts", "daemon.ts", "gateway.ts"))).toBe("daemon.ts");
    expect(resolveBootEntry(f("agent.ts"))).toBe("agent.ts");
    expect(resolveBootEntry(f("worker.ts", "package.json"))).toBeUndefined();
  });
});

describe("classifyBootOutcome", () => {
  test("clean exit and daemon-alive-at-window-end are both ok", () => {
    expect(classifyBootOutcome(run()).status).toBe("ok");
    expect(classifyBootOutcome(run({ exitCode: 137, timedOut: true })).status).toBe("ok");
  });

  test("every known first-boot gate classifies as gated (green)", () => {
    // Real messages captured by booting each fixture bundle credential-free.
    const gates = [
      "ProviderAuthError: no Anthropic credentials found: set ANTHROPIC_AUTH_TOKEN",
      "error: missing required env var SMOKE_BASE_RPC",
      "[crew] no input on stdin",
      "[voice-daemon] no --smoke <pcm-path> provided.",
      "[browser-driver] no prompt (pass --prompt <text> or pipe stdin)",
      'eval bundle error: DatasetRegistryError: dataset "smoke-eval@v1" not found at /x',
    ];
    for (const stderr of gates) {
      const outcome = classifyBootOutcome(run({ exitCode: 1, stderr }));
      expect(outcome.status).toBe("gated");
      expect(outcome.detail).toContain("gate");
    }
    // Sanity: the table drives the classification.
    expect(BOOT_GATE_PATTERNS.length).toBeGreaterThanOrEqual(6);
  });

  test("structural breakage matches no gate and stays red with a stderr tail", () => {
    const outcome = classifyBootOutcome(
      run({
        exitCode: 1,
        stderr: "SyntaxError: Export named 'createJanitor' not found in module 'x'.\n",
      }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("SyntaxError");
  });
});

describe("buildVerdict", () => {
  test("all ok → GREEN; gated/skipped stay green; any failed → RED", () => {
    expect(
      buildVerdict([
        { step: "assertion", status: "ok" },
        { step: "install", status: "ok" },
        { step: "boot", status: "gated", detail: "needs creds" },
      ]),
    ).toEqual({
      green: true,
      line: "compile --check: GREEN — assertion ok; install ok; boot gated (needs creds)",
    });
    const red = buildVerdict([
      { step: "assertion", status: "failed", detail: "missing anchor" },
      { step: "install", status: "ok" },
      { step: "boot", status: "skipped" },
    ]);
    expect(red.green).toBe(false);
    expect(red.line).toStartWith("compile --check: RED — ");
  });
});

describe("runCompileCheck", () => {
  const CLI_ASSERTION: ShapeAssertion = {
    shape: "cli",
    expectedFiles: ["agent.ts"],
    anchors: [
      { in: "agent.ts", contains: "runChatLoop" },
      { in: "agent.ts", contains: "fixture-only-content", fixtureOnly: true },
    ],
  };

  const CLI_BUNDLE = {
    files: [
      {
        path: "agent.ts",
        content: 'import { runChatLoop } from "@crewhaus/runtime-core";\nawait runChatLoop();\n',
      },
    ],
  };

  function scriptedRunner(script: {
    install?: CheckRunResult;
    boot?: CheckRunResult;
  }): { runner: CheckStepRunner; calls: Array<{ argv: readonly string[]; cwd: string }> } {
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    const runner: CheckStepRunner = async ({ argv, cwd }) => {
      calls.push({ argv, cwd });
      if (argv[1] === "install") return script.install ?? run();
      return script.boot ?? run();
    };
    return { runner, calls };
  }

  test("green path: assertion ok, synthesized manifest installed, boot gated", async () => {
    const { runner, calls } = scriptedRunner({
      boot: run({ exitCode: 1, stderr: "no Anthropic credentials found: set ..." }),
    });
    const result = await runCompileCheck({
      target: "cli",
      bundle: CLI_BUNDLE,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
    });
    expect(result.green).toBe(true);
    expect(result.line).toContain("GREEN");
    expect(result.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "assertion:ok",
      "install:ok",
      "boot:gated",
    ]);
    // fixtureOnly anchor excluded from the applied count.
    expect(result.steps[0]?.detail).toBe("1 anchors");
    // The synthesized manifest landed in the out-dir with the scanned dep.
    const manifest = JSON.parse(readFileSync(join(tmp, "package.json"), "utf-8"));
    expect(manifest.dependencies).toEqual({ "@crewhaus/runtime-core": "latest" });
    // install ran in the out-dir, then the boot spawned the entrypoint.
    expect(calls[0]?.argv).toEqual(["bun", "install"]);
    expect(calls[0]?.cwd).toBe(tmp);
    expect(calls[1]?.argv).toEqual(["bun", "agent.ts"]);
  });

  test("assertion failure is red but later steps still run and report", async () => {
    const { runner } = scriptedRunner({});
    const hollow = { files: [{ path: "agent.ts", content: "// nothing here" }] };
    const result = await runCompileCheck({
      target: "cli",
      bundle: hollow,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
    });
    expect(result.green).toBe(false);
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[0]?.detail).toContain("runChatLoop");
    expect(result.steps[1]?.status).toBe("ok");
  });

  test("unknown target skips the assertion without going red", async () => {
    const { runner } = scriptedRunner({});
    const result = await runCompileCheck({
      target: "mystery-shape",
      bundle: CLI_BUNDLE,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
    });
    expect(result.steps[0]?.status).toBe("skipped");
    expect(result.green).toBe(true);
  });

  test("install failure goes red and boot is skipped", async () => {
    const { runner, calls } = scriptedRunner({
      install: run({ exitCode: 1, stderr: "error: registry unreachable" }),
    });
    const result = await runCompileCheck({
      target: "cli",
      bundle: CLI_BUNDLE,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
    });
    expect(result.green).toBe(false);
    expect(result.steps[1]?.status).toBe("failed");
    expect(result.steps[1]?.detail).toContain("registry unreachable");
    expect(result.steps[2]?.status).toBe("skipped");
    expect(calls.length).toBe(1); // no boot spawn after a failed install
  });

  test("a bundle-provided package.json is not overwritten by the synthesizer", async () => {
    const { runner } = scriptedRunner({});
    const bundle = {
      files: [
        { path: "package.json", content: '{ "name": "emitted-by-target" }' },
        { path: "worker.ts", content: "export default {};" },
      ],
    };
    const result = await runCompileCheck({
      target: "mystery-shape",
      bundle,
      outDir: tmp,
      assertions: [],
      runner,
    });
    // No synthesized manifest written (the emitter's file on disk is respected;
    // this orchestrator only writes when the bundle lacks one).
    expect(existsSync(join(tmp, "package.json"))).toBe(false);
    // And no bootable entrypoint → boot skipped.
    expect(result.steps[2]?.status).toBe("skipped");
    expect(result.steps[2]?.detail).toContain("no agent.ts/daemon.ts");
  });

  test("daemon bundles boot daemon.ts and an alive daemon is ok", async () => {
    const { runner, calls } = scriptedRunner({
      boot: run({ exitCode: 137, timedOut: true }),
    });
    const bundle = {
      files: [
        { path: "agent.ts", content: "// agent" },
        { path: "daemon.ts", content: 'import "@crewhaus/gateway-server";' },
      ],
    };
    const result = await runCompileCheck({
      target: "managed",
      bundle,
      outDir: tmp,
      assertions: [],
      runner,
      bootTimeoutMs: 5,
    });
    expect(result.steps[2]?.status).toBe("ok");
    expect(result.steps[2]?.detail).toContain("alive");
    expect(calls[1]?.argv).toEqual(["bun", "daemon.ts"]);
  });

  test("structural boot breakage is red", async () => {
    const { runner } = scriptedRunner({
      boot: run({ exitCode: 1, stderr: "SyntaxError: Unexpected token" }),
    });
    const result = await runCompileCheck({
      target: "cli",
      bundle: CLI_BUNDLE,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
    });
    expect(result.green).toBe(false);
    expect(result.steps[2]?.status).toBe("failed");
    expect(result.line).toContain("RED");
  });
});
