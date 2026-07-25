import { afterEach, beforeEach, describe, expect, test } from "bun:test";
/**
 * Unit coverage for the `compile --check` core (item 33). Everything that
 * would spawn a subprocess goes through an injected `CheckStepRunner`, so
 * no test touches the network, bun's registry, or a real boot.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShapeAssertion } from "@crewhaus/smoke-harness";
import {
  BOOT_GATE_PATTERNS,
  type CheckRunResult,
  type CheckStepRunner,
  bootArgvFor,
  buildBundlePackageJson,
  buildVerdict,
  classifyBootOutcome,
  collectCrewhausDeps,
  defaultCheckRunner,
  emptyEnvFile,
  resolveBootEntry,
  runCompileCheck,
  scrubbedEnv,
} from "./compile-check";
import { cliVersion } from "./version";

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
  test("pins deps to the given CLI version (lockstep-published contract — F5c)", () => {
    const manifest = JSON.parse(
      buildBundlePackageJson(["@crewhaus/runtime-core", "@crewhaus/tool-fs"], "0.1.8"),
    );
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.dependencies).toEqual({
      "@crewhaus/runtime-core": "0.1.8",
      "@crewhaus/tool-fs": "0.1.8",
    });
  });

  test("falls back to latest only when no version is resolvable", () => {
    const manifest = JSON.parse(buildBundlePackageJson(["@crewhaus/runtime-core"]));
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

  // ── Audit item 9 — a declared MCP env ref is a credential GATE, not a break ─
  test("an unset MCP server secret is gated (green), not a structural failure", () => {
    // Verbatim stderr of a `compile --check` boot of a bundle whose spec
    // declares `mcp_servers.probe.env.PROBE_API_KEY: $PROBE_API_KEY` —
    // @crewhaus/mcp-host resolves the ref at module scope, so Bun prints the
    // source excerpt, the ConfigError header, then the stack.
    const stderr = [
      '46 |         const where = opts.what !== undefined ? ` (required by ${opts.what})` : "";',
      "47 |         throw new ConfigError(`environment variable ${ref.name} is not set${where} …`);",
      "                   ^",
      'ConfigError: environment variable PROBE_API_KEY is not set (required by mcp server "probe" env PROBE_API_KEY) — export it before launching, e.g. `export PROBE_API_KEY=…`',
      ' code: "config"',
      "",
      "      at resolveSecretRef (/x/node_modules/@crewhaus/mcp-host/dist/resolve.js:47:15)",
      "      at /x/agent.ts:22:28",
      "",
      "Bun v1.3.14 (macOS arm64)",
    ].join("\n");
    const outcome = classifyBootOutcome(run({ exitCode: 1, stderr }));
    expect(outcome.status).toBe("gated");
    expect(outcome.detail).toContain("MCP server credentials");
  });

  // ── Audit item 16 — the verdict sentence must be grammatical ──────────────
  test("no gate phrase produces 'its a …' / 'needs live a …' (item 16)", () => {
    for (const { gate, needs } of BOOT_GATE_PATTERNS) {
      // `gate` sits after a possessive, so it must not open with an article…
      expect(gate).not.toMatch(/^(?:a|an|the) /);
      // …while `needs` is the standalone noun phrase and carries its own.
      expect(needs.length).toBeGreaterThan(0);
    }
    const dataset = classifyBootOutcome(
      run({ exitCode: 1, stderr: 'dataset "smoke-eval@v1" not found at /x' }),
    );
    expect(dataset.detail).toBe(
      "boot reached its eval dataset gate — full boot needs a registered eval dataset",
    );
    const prompt = classifyBootOutcome(
      run({ exitCode: 1, stderr: "[browser-driver] no prompt (pass --prompt <text>)" }),
    );
    expect(prompt.detail).toBe(
      "boot reached its --prompt gate — full boot needs an initial --prompt",
    );
  });

  test("a red boot names the error even when Bun buries it above the stack", () => {
    const stderr = [
      "1 | import { missing } from '@crewhaus/nope';",
      "SyntaxError: Export named 'createJanitor' not found in module 'x'.",
      "      at /x/agent.ts:3:10",
      "",
      "Bun v1.3.14 (macOS arm64)",
    ].join("\n");
    const outcome = classifyBootOutcome(run({ exitCode: 1, stderr }));
    expect(outcome.status).toBe("failed");
    // The old last-3-lines tail reported "at /x/agent.ts:3:10 | Bun v1.3.14".
    expect(outcome.detail).toContain("SyntaxError: Export named 'createJanitor'");
    expect(outcome.detail).not.toContain("Bun v1.3.14");
  });

  test("a bare-message failure with no error header still reports its tail", () => {
    const outcome = classifyBootOutcome(
      run({ exitCode: 3, stderr: "boom: the bundle gave up\nsecond line\n" }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("second line");
  });

  test("a gate printed to STDOUT still classifies as gated (F6 — combined-stream matching)", () => {
    const outcome = classifyBootOutcome(
      run({ exitCode: 1, stdout: "[crew] no input on stdin\n", stderr: "" }),
    );
    expect(outcome.status).toBe("gated");
    expect(outcome.detail).toContain("stdin input");
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

  type CapturedCall = {
    argv: readonly string[];
    cwd: string;
    env?: Readonly<Record<string, string>>;
    timeoutMs?: number;
  };

  function scriptedRunner(script: {
    install?: CheckRunResult;
    boot?: CheckRunResult;
  }): { runner: CheckStepRunner; calls: CapturedCall[] } {
    const calls: CapturedCall[] = [];
    const runner: CheckStepRunner = async ({ argv, cwd, env, timeoutMs }) => {
      calls.push({ argv, cwd, env, timeoutMs });
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
    // The synthesized manifest landed in the out-dir with the scanned dep,
    // pinned to the CLI's own version (lockstep publishing — F5c).
    const manifest = JSON.parse(readFileSync(join(tmp, "package.json"), "utf-8"));
    expect(manifest.dependencies).toEqual({ "@crewhaus/runtime-core": cliVersion() });
    // install ran in the out-dir (bounded — F5a), then the boot spawned the
    // entrypoint with the .env auto-load disabled (F4).
    expect(calls[0]?.argv).toEqual(["bun", "install"]);
    expect(calls[0]?.cwd).toBe(tmp);
    expect(calls[0]?.timeoutMs).toBe(120_000);
    expect(calls[1]?.argv[0]).toBe("bun");
    expect(calls[1]?.argv[1]).toStartWith("--env-file=");
    expect(calls[1]?.argv[2]).toBe("agent.ts");
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

  test("a user-authored package.json in the out-dir is kept, not clobbered", async () => {
    const { runner } = scriptedRunner({
      boot: run({ exitCode: 1, stderr: "no Anthropic credentials found: set ..." }),
    });
    const foreign = '{ "name": "my-harness", "dependencies": { "left-pad": "1.0.0" } }\n';
    writeFileSync(join(tmp, "package.json"), foreign);
    const result = await runCompileCheck({
      target: "cli",
      bundle: CLI_BUNDLE,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
    });
    // The check still runs (install verifies against the user's manifest),
    // but the synthesizer never overwrites a file it did not generate.
    expect(result.green).toBe(true);
    expect(readFileSync(join(tmp, "package.json"), "utf-8")).toBe(foreign);
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
    expect(calls[1]?.argv).toEqual(bootArgvFor("daemon.ts"));
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

  // ── F4 — the boot child must not see a .env colocated with the bundle ────
  test("a .env in the out-dir never reaches the boot child: env is scrubbed and --env-file disables Bun's auto-load", async () => {
    writeFileSync(join(tmp, ".env"), "ANTHROPIC_API_KEY=sk-fake-should-never-be-seen\n");
    const { runner, calls } = scriptedRunner({
      boot: run({ exitCode: 1, stderr: "no Anthropic credentials found: set ..." }),
    });
    const result = await runCompileCheck({
      target: "cli",
      bundle: CLI_BUNDLE,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
      env: { PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_API_KEY: "sk-real-secret" },
    });
    expect(result.green).toBe(true);
    const boot = calls[1];
    // The explicit env passed to the runner carries no credentials…
    expect(boot?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
    // …and the argv disables Bun's cwd .env auto-load, which would otherwise
    // re-inject the out-dir's keys UNDER the scrubbed env.
    expect(boot?.argv[1]).toStartWith("--env-file=");
    const envFile = (boot?.argv[1] ?? "").slice("--env-file=".length);
    expect(readFileSync(envFile, "utf-8")).toBe("");
  });

  test("REAL subprocess: the booted child cannot see a colocated .env, and without the flag it would (counterfactual)", async () => {
    writeFileSync(join(tmp, ".env"), "CREWHAUS_CHECK_FAKE_KEY=sk-fake\n");
    writeFileSync(
      join(tmp, "probe.ts"),
      'process.stdout.write(`FAKE_KEY_PRESENT=${"CREWHAUS_CHECK_FAKE_KEY" in process.env}`);\n',
    );
    const env = scrubbedEnv(process.env);
    // The exact argv shape runCompileCheck boots with (bootArgvFor).
    const guarded = await defaultCheckRunner({
      argv: bootArgvFor("probe.ts"),
      cwd: tmp,
      env,
      timeoutMs: 15_000,
    });
    expect(guarded.exitCode).toBe(0);
    expect(guarded.stdout).toBe("FAKE_KEY_PRESENT=false");
    // Counterfactual: a plain `bun probe.ts` auto-loads the .env — proving
    // the --env-file flag is load-bearing, not incidental.
    const unguarded = await defaultCheckRunner({
      argv: ["bun", "probe.ts"],
      cwd: tmp,
      env,
      timeoutMs: 15_000,
    });
    expect(unguarded.stdout).toBe("FAKE_KEY_PRESENT=true");
  }, 30_000);

  // ── F5a — the install step is bounded ────────────────────────────────────
  test("a hung bun install times out, fails the step, and skips the boot", async () => {
    const { runner, calls } = scriptedRunner({
      install: run({ exitCode: 1, timedOut: true }),
    });
    const result = await runCompileCheck({
      target: "cli",
      bundle: CLI_BUNDLE,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
      installTimeoutMs: 5_000,
    });
    expect(result.green).toBe(false);
    expect(result.steps[1]?.status).toBe("failed");
    expect(result.steps[1]?.detail).toContain("timed out after 5000ms");
    expect(result.steps[2]?.status).toBe("skipped");
    // The configured bound reached the runner.
    expect(calls[0]?.timeoutMs).toBe(5_000);
  });

  // ── F5b — proxy/CA vars survive the scrub; credentials do not ────────────
  test("HTTPS_PROXY/HTTP_PROXY/NO_PROXY/SSL_CERT_FILE/NODE_EXTRA_CA_CERTS pass through to install AND boot; secrets never do", async () => {
    const { runner, calls } = scriptedRunner({
      boot: run({ exitCode: 1, stderr: "no Anthropic credentials found: set ..." }),
    });
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      HTTPS_PROXY: "http://proxy:3128",
      HTTP_PROXY: "http://proxy:3128",
      NO_PROXY: "localhost",
      SSL_CERT_FILE: "/etc/ssl/corp.pem",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
      ANTHROPIC_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
    };
    await runCompileCheck({
      target: "cli",
      bundle: CLI_BUNDLE,
      outDir: tmp,
      assertions: [CLI_ASSERTION],
      runner,
      env: base,
    });
    const expected = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      HTTPS_PROXY: "http://proxy:3128",
      HTTP_PROXY: "http://proxy:3128",
      NO_PROXY: "localhost",
      SSL_CERT_FILE: "/etc/ssl/corp.pem",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem",
    };
    expect(calls[0]?.env).toEqual(expected); // install
    expect(calls[1]?.env).toEqual(expected); // boot
  });

  test("scrubbedEnv omits unset passthrough vars instead of writing empty strings", () => {
    expect(scrubbedEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  test("emptyEnvFile is created once, empty, and reused across calls", () => {
    const first = emptyEnvFile();
    expect(readFileSync(first, "utf-8")).toBe("");
    expect(emptyEnvFile()).toBe(first);
  });
});

// ── F6 — boot-gate strings stay coupled to the sources that emit them ──────
describe("BOOT_GATE_PATTERNS ↔ emitting workspace sources (F6)", () => {
  const REPO_ROOT = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "../../..");

  /**
   * Path-anchored coupling: each gate's regex must match the ACTUAL source
   * that emits the message at runtime. When a package rewords its gate
   * message, this fails and points at the exact file to re-derive the
   * pattern from — retiring the silent-drift failure mode where a reworded
   * gate turns a green "gated" verdict into a red structural failure.
   */
  const EMITTING_SOURCES: ReadonlyArray<{ gate: string; files: readonly string[] }> = [
    {
      // runtime-core resolveAuth path: the message lives in the anthropic
      // adapter; the error-name alternative in the shared errors package.
      gate: "provider credentials",
      files: ["packages/adapter-anthropic/src/client.ts", "packages/errors/src/index.ts"],
    },
    {
      // Env-ref rewriting: onchain throws it directly; the channel daemon
      // emits it into its generated boot guard.
      gate: "spec env refs",
      files: ["packages/target-onchain/src/index.ts", "packages/target-channel-bot/src/index.ts"],
    },
    {
      // Every MCP secret ref resolves through mcp-host at boot; the throw
      // that names the unset variable lives in resolve.ts.
      gate: "MCP server credentials",
      files: ["packages/mcp-host/src/resolve.ts"],
    },
    { gate: "stdin input", files: ["packages/target-crew/src/index.ts"] },
    { gate: "--smoke fixture", files: ["packages/target-voice/src/index.ts"] },
    { gate: "--prompt", files: ["packages/target-browser-driver/src/index.ts"] },
    { gate: "eval dataset", files: ["packages/dataset-registry/src/index.ts"] },
  ];

  test("the table covers every gate exactly once", () => {
    expect(EMITTING_SOURCES.map((s) => s.gate).sort()).toEqual(
      [...BOOT_GATE_PATTERNS.map((p) => p.gate)].sort(),
    );
  });

  for (const { gate, files } of EMITTING_SOURCES) {
    for (const file of files) {
      test(`"${gate}" pattern matches its emitter ${file}`, () => {
        const entry = BOOT_GATE_PATTERNS.find((p) => p.gate === gate);
        expect(entry).toBeDefined();
        const source = readFileSync(join(REPO_ROOT, file), "utf-8");
        expect(entry?.pattern.test(source)).toBe(true);
      });
    }
  }
});
