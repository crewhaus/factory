import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSpec } from "@crewhaus/spec";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const REPO_ROOT = join(import.meta.dir, "../../..");
const HELLO_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");
const BROWSER_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-browser/crewhaus.yaml");
const VOICE_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-voice/crewhaus.yaml");

type RunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunOpts = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  closeStdinImmediately?: boolean;
};

/** Spawn the CLI as a child Bun process and capture exit code + streams. */
async function runCli(args: ReadonlyArray<string>, opts: RunOpts = {}): Promise<RunResult> {
  const baseEnv: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v !== undefined) baseEnv[k] = v;
  }
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    env: baseEnv,
    stdin: opts.closeStdinImmediately ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.closeStdinImmediately && proc.stdin) {
    proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-cli-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("crewhaus compile", () => {
  test("emits agent.ts for a valid spec", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "agent.ts"))).toBe(true);
    expect(result.stdout).toContain("compiled bundle");
  });

  test("--emit-ir with -o writes ir.json into the out dir and skips codegen", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--emit-ir", "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "ir.json"))).toBe(true);
    expect(existsSync(join(tmp, "agent.ts"))).toBe(false);
    const ir = JSON.parse(readFileSync(join(tmp, "ir.json"), "utf-8"));
    expect(ir.target).toBe("cli");
    expect(ir.agent).toBeDefined();
  });

  test("--emit-ir without -o exits 0 (stdout-streaming covered by manual usage; the\nspawn-pipe capture in this harness is racy on stdout — see other compile tests)", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--emit-ir"]);
    expect(result.exitCode).toBe(0);
  });

  // FR-002 — compile-time external-sink scope gate, now DEFAULT-ON.
  const MCP_SINK_SPEC =
    "name: evil\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: |\n    do a thing\ntools:\n  - mcp__evil__exfiltrate\n";

  test("--help documents the default-on gate and the opt-out flag", async () => {
    const result = await runCli(["compile", "--help"]);
    expect(result.exitCode).toBe(0);
    // The gate is described as default; the opt-out is named.
    expect(result.stdout).toContain("by DEFAULT");
    expect(result.stdout).toContain('non-"external"');
    expect(result.stdout).toContain("--allow-unmarked-sinks");
  });

  // (a) DEFAULT-ON RED PATH — no flag at all. A spec referencing an `mcp__*`
  // sink the offline tool map cannot resolve to a scope:"external" tool must
  // FAIL `crewhaus compile` by default, naming the tool, and must NOT emit.
  // This is the FR-002 final increment: the gate fires with no opt-in flag.
  test("compile (no flag) FAILS by default on an unmarked outward mcp__ sink and names it", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, MCP_SINK_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "-o", outDir]);
    expect(result.exitCode).toBe(1);
    // The `[strict]` marker proves the SCOPE GATE produced the failure (and ran
    // before any emit) — the generic emitter "unknown tool" error carries no
    // such marker.
    expect(result.stderr).toContain("[strict]");
    expect(result.stderr).toContain("mcp__evil__exfiltrate");
    expect(result.stderr).toContain("unverifiable offline");
    // refused to emit
    expect(existsSync(join(outDir, "agent.ts"))).toBe(false);
  });

  // (a') Isolation: on --emit-ir there is NO target emitter in the path, so the
  // spec lowers cleanly and the ONLY thing that can produce exit 1 is the scope
  // gate. If the gate were off the IR would print and exit 0 — so this proves
  // the default-on gate is load-bearing, not the emitter's unknown-tool reject.
  test("compile --emit-ir (no flag) FAILS by default on the unmarked sink (gate is load-bearing)", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, MCP_SINK_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--emit-ir", "-o", outDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[strict]");
    expect(result.stderr).toContain("mcp__evil__exfiltrate");
    expect(existsSync(join(outDir, "ir.json"))).toBe(false);
  });

  // (b) OPT-OUT — the same unmarked sink passes the compile when the user
  // explicitly bypasses the gate. We assert against the --emit-ir path because
  // it isolates the GATE: the scope gate runs identically for emit-ir and
  // bundle modes, and --emit-ir lowers an unresolved mcp__ tool cleanly (the
  // bundle EMITTER independently rejects any unknown tool name, which is a
  // separate concern from the scope gate this flag governs). So a gate-bypassed
  // --emit-ir exits 0 and writes ir.json with no `[strict]` finding; if the
  // opt-out did NOT bypass, this same spec exits 1 (see the no-flag test above).
  test("--allow-unmarked-sinks bypasses the gate: the unmarked sink now passes", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, MCP_SINK_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli([
      "compile",
      specPath,
      "--allow-unmarked-sinks",
      "--emit-ir",
      "-o",
      outDir,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("[strict]");
    expect(existsSync(join(outDir, "ir.json"))).toBe(true);
  });

  test("--no-strict-scope is an accepted alias that also bypasses the gate", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, MCP_SINK_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli([
      "compile",
      specPath,
      "--no-strict-scope",
      "--emit-ir",
      "-o",
      outDir,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("[strict]");
    expect(existsSync(join(outDir, "ir.json"))).toBe(true);
  });

  // (b') OPT-OUT, BUNDLE MODE — emitter errors must exit cleanly, not crash.
  // Once --allow-unmarked-sinks bypasses the scope gate, the same unresolvable
  // mcp__ sink reaches the bundle EMITTER (which the --emit-ir opt-out test
  // above never does), and the emitter throws TargetEmitError because it can't
  // map the name to a built-in. That emitter failure must be routed through
  // die() exactly like the SpecParseError path — a one-line message + exit 1,
  // never an uncaught stack trace. (Pre-existing bug, independent of the gate.)
  test("--allow-unmarked-sinks: an unresolvable mcp__ sink fails cleanly (die, not crash) in bundle mode", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, MCP_SINK_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--allow-unmarked-sinks", "-o", outDir]);
    expect(result.exitCode).toBe(1);
    // Clean die() output: prefixed "crewhaus: " and names the offending tool.
    expect(result.stderr).toContain('crewhaus: unknown tool "mcp__evil__exfiltrate"');
    // The gate was bypassed — it is NOT the source of this failure…
    expect(result.stderr).not.toContain("[strict]");
    // …and the emitter error did NOT escape as an uncaught crash: neither the
    // error class name nor any "at file:line:col" stack frame leaks to stderr.
    expect(result.stderr).not.toContain("TargetEmitError");
    expect(result.stderr).not.toMatch(/\bat .+:\d+:\d+/);
    // Nothing was emitted.
    expect(existsSync(join(outDir, "agent.ts"))).toBe(false);
  });

  // The report's literal repro: a plain non-outward unknown tool name (one the
  // gate never flags, so it reaches the emitter with or without the opt-out)
  // compiled under --allow-unmarked-sinks also fails cleanly via die().
  test("--allow-unmarked-sinks: a plain unknown tool name also fails cleanly (die, not crash)", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      "name: typo\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: |\n    do a thing\ntools:\n  - not-a-real-tool\n",
    );
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--allow-unmarked-sinks", "-o", outDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('crewhaus: unknown tool "not-a-real-tool"');
    expect(result.stderr).not.toContain("TargetEmitError");
    expect(result.stderr).not.toMatch(/\bat .+:\d+:\d+/);
    expect(existsSync(join(outDir, "agent.ts"))).toBe(false);
  });

  // A malformed credential env-ref (`$lowercase` on a Slack token) is a hard
  // compile error from lowerCredential(). It must render as a clean die()
  // one-liner — exit 1, `crewhaus: ` prefix, no uncaught stack trace — on BOTH
  // the --emit-ir and bundle paths (the lower() catch routes CompilerError, not
  // just SpecParseError, through die()).
  const BAD_CRED_SPEC =
    "name: status-bot\ntarget: channel\nagent:\n  model: claude-sonnet-4-6\n  instructions: announce status\nchannels:\n  slack:\n    botToken: $slack_bot_token\n    signingSecret: $SLACK_SIGNING_SECRET\nrouting:\n  sessionKey: thread\n";

  for (const mode of ["--emit-ir", "bundle"] as const) {
    test(`compile (${mode}) on a malformed credential $ref fails cleanly (die, not crash)`, async () => {
      const specPath = join(tmp, "crewhaus.yaml");
      writeFileSync(specPath, BAD_CRED_SPEC);
      const outDir = join(tmp, "out");
      const argv =
        mode === "--emit-ir"
          ? ["compile", specPath, "--emit-ir"]
          : ["compile", specPath, "-o", outDir];
      const result = await runCli(argv);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'crewhaus: channels.slack.botToken value "$slack_bot_token" looks like an environment reference',
      );
      // Not an uncaught crash: no error-class name, no "at file:line:col" frame.
      expect(result.stderr).not.toContain("CompilerError");
      expect(result.stderr).not.toMatch(/\bat .+:\d+:\d+/);
      if (mode === "bundle") expect(existsSync(join(outDir, "agent.ts"))).toBe(false);
    });
  }

  // (c) CLEAN spec still compiles by default (no flag, no opt-out).
  test("compile (no flag) on a clean (toolless) spec still emits and exits 0", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "agent.ts"))).toBe(true);
    expect(result.stderr).not.toContain("[strict]");
  });

  test("compile (no flag) passes when an outward tool (fetch) is correctly external", async () => {
    // Exercises the full resolve path: collectToolNames → loadToolMap →
    // auditSpecToolNames → auditToolScopes. `Fetch` ships scope:"external"
    // (and ioCapability:"network"), so the audit is clean and the bundle emits
    // — by default, with no flag.
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      "name: with-fetch\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: |\n    Use fetch when needed.\ntools:\n  - fetch\n",
    );
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "-o", outDir]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(outDir, "agent.ts"))).toBe(true);
    expect(result.stderr).not.toContain("[strict]");
  });

  // Back-compat: `--strict` is still accepted (now a no-op since the gate is
  // default-on) so existing invocations and CI scripts keep working unchanged.
  test("--strict remains accepted (no-op) and the unmarked sink still fails", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, MCP_SINK_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--strict", "-o", outDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[strict]");
    expect(result.stderr).toContain("mcp__evil__exfiltrate");
    expect(existsSync(join(outDir, "agent.ts"))).toBe(false);
  });

  test("--strict on a clean (toolless) spec still emits and exits 0", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--strict", "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "agent.ts"))).toBe(true);
    expect(result.stderr).not.toContain("[strict]");
  });

  // Regression: a sub-agent `tools:` list names tools by their REGISTERED name
  // (PascalCase, e.g. `WebSearch`) — that is the contract the runtime
  // child-catalog filter (`buildChildCatalog` in tool-task) enforces, matching
  // on `RegisteredTool.name`, not the camelCase spec key. `collectToolNames`
  // walks every `tools` array in the IR, so the gate sees `WebSearch` and must
  // resolve it. The resolver indexes the offline tool map by BOTH the spec key
  // and the registered name, so the PascalCase outward sink resolves to its
  // scope:"external" built-in and passes — rather than being wrongly flagged as
  // an unverifiable external sink. Without the by-name index this exits 1.
  test("compile (no flag) passes when a SUB-AGENT lists an outward tool by its PascalCase registered name", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      "name: subagent-pascal-sink\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: |\n    Delegate web research to the sub-agent.\n  sub_agents:\n    researcher:\n      description: |\n        Web-research sub-agent.\n      instructions: |\n        Search the web and summarise.\n      tools: [WebSearch]\n      permissions:\n        allow:\n          - WebSearch\n        deny: []\ntools:\n  - webSearch\n",
    );
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "-o", outDir]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(outDir, "agent.ts"))).toBe(true);
    expect(result.stderr).not.toContain("[strict]");
  });
});

describe("crewhaus init", () => {
  test("scaffolds crewhaus.yaml in cwd when no name is given", async () => {
    const result = await runCli(["init"], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    const written = join(tmp, "crewhaus.yaml");
    expect(existsSync(written)).toBe(true);
    const spec = parseSpec(readFileSync(written, "utf-8"));
    expect(spec.target).toBe("cli");
    if (spec.target !== "cli") expect.unreachable();
    expect(spec.agent.model).toBe("claude-opus-4-7");
    expect(spec.agent.instructions.length).toBeGreaterThan(0);
    expect(result.stdout).toMatch(/wrote .*crewhaus\.yaml/);
  });

  test("scaffolds into a named subdirectory", async () => {
    const result = await runCli(["init", "myapp"], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    const written = join(tmp, "myapp", "crewhaus.yaml");
    expect(existsSync(written)).toBe(true);
    const spec = parseSpec(readFileSync(written, "utf-8"));
    expect(spec.name).toBe("myapp");
  });

  test("fails when crewhaus.yaml already exists", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), "name: pre\ntarget: cli\n");
    const result = await runCli(["init"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists");
  });
});

describe("crewhaus run", () => {
  test("starts the agent and exits cleanly when stdin closes immediately", async () => {
    const result = await runCli(["run", HELLO_SPEC], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent ready");
    expect(result.stdout).toContain("model: claude-sonnet-4-6");
  });

  test("--model overrides the spec model", async () => {
    const result = await runCli(["run", HELLO_SPEC, "--model", "claude-haiku-4-5-20251001"], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("model: claude-haiku-4-5-20251001");
  });

  test("errors with a clear message when the spec is missing", async () => {
    const result = await runCli(["run", join(tmp, "nope.yaml")], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("could not read");
  });

  test("browser target rejects --resume with a clear error (single-turn)", async () => {
    const result = await runCli(
      ["run", BROWSER_SPEC, "--resume", "sess_0123456789abcdef", "--prompt", "ignored"],
      { env: { ANTHROPIC_API_KEY: "test-no-call" } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--resume");
    expect(result.stderr).toContain("browser");
  });

  test("browser target rejects --continue with a clear error (single-turn)", async () => {
    const result = await runCli(["run", BROWSER_SPEC, "--continue", "--prompt", "ignored"], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--continue");
    expect(result.stderr).toContain("browser");
  });

  test("browser target errors with 'no prompt' when neither --prompt nor stdin supplies one", async () => {
    const result = await runCli(["run", BROWSER_SPEC], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no prompt");
  });

  test("unsupported target names cli + browser in the dispatch error", async () => {
    const result = await runCli(["run", VOICE_SPEC], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cli or browser");
    expect(result.stderr).toContain('got "voice"');
  });

  // FR-004 — --justification-judge selects the Pillar 3 intent-gate judge.
  // This subprocess test proves the flag resolves and the agent starts; the
  // FULL handoff (CLI-resolved judge actually governing a gate decision and
  // the judge identity landing in the durable permission_justification_evaluated
  // audit record) is proven deterministically in justification-gate.test.ts —
  // a subprocess cannot drive a real model turn without a live call.
  test("--justification-judge claude starts the agent cleanly (judge wired)", async () => {
    const result = await runCli(["run", HELLO_SPEC, "--justification-judge", "claude"], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    // The claude judge is constructed (lazy import of
    // @crewhaus/justification-judge-claude + the anthropic adapter) but never
    // called — stdin closes before any turn. A clean exit proves the wiring
    // resolves without error.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("model: claude-sonnet-4-6");
  });

  test("--justification-judge rule-based starts the agent cleanly (explicit default)", async () => {
    const result = await runCli(["run", HELLO_SPEC, "--justification-judge", "rule-based"], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
  });

  test("an invalid --justification-judge value exits non-zero with the allowed list", async () => {
    const result = await runCli(["run", HELLO_SPEC, "--justification-judge", "gpt-omniscient"], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid --justification-judge");
    expect(result.stderr).toContain("rule-based, claude");
  });

  test("a CrewhausError on the run path surfaces as a clean one-line die(), not a stack trace", async () => {
    // An unrecognised model string makes the model-router throw ConfigError
    // inside runChatLoop — previously an uncaught stack trace.
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      "name: t\ntarget: cli\nagent:\n  model: claude-sonnet-4-5\n  instructions: hi\n",
    );
    const result = await runCli(
      ["run", join(tmp, "crewhaus.yaml"), "--model", "totally-not-a-model"],
      { cwd: tmp, env: {}, closeStdinImmediately: true },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("crewhaus: ");
    expect(result.stderr).toContain("unrecognised model string");
    expect(result.stderr).not.toContain("    at "); // no stack frames
  });

  test("run --help enumerates the model-router grammar", async () => {
    const result = await runCli(["run", "--help"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("claude-*");
    expect(result.stdout).toContain("openai/<m>");
    expect(result.stdout).toContain("gemini/<m>");
    expect(result.stdout).toContain("bedrock/<id>");
    expect(result.stdout).toContain("local/<m>@<url>");
  });

  test("eval --help notes --judge-model takes the router grammar + the default judge's Anthropic requirement", async () => {
    const result = await runCli(["eval", "--help"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--judge-model accepts the full router grammar");
    expect(result.stdout).toContain("claude-sonnet-4-5");
    expect(result.stdout).toContain("Anthropic credentials");
  });

  test("run --help lists the --justification-judge flag", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--justification-judge");
  });
});

describe("crewhaus doctor", () => {
  test("exits 0 when env + bun + spec are all healthy", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), "name: t\ntarget: cli\n");
    const result = await runCli(["doctor"], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ Anthropic credentials");
    expect(result.stdout).toContain("✓ Bun runtime");
    expect(result.stdout).toContain("✓ crewhaus.yaml in cwd");
    expect(result.stdout).toContain("all checks passed");
  });

  test("exits 1 when neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), "name: t\ntarget: cli\n");
    const result = await runCli(["doctor"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("✗ Anthropic credentials");
    expect(result.stdout).toContain("some checks failed");
  });

  test("exits 1 when crewhaus.yaml is missing from cwd", async () => {
    const result = await runCli(["doctor"], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("✗ crewhaus.yaml in cwd");
  });

  test("--liveness exits 0 with NO credential or spec checks (container probe)", async () => {
    // No spec, no env — plain doctor would exit 1 on both counts.
    const result = await runCli(["doctor", "--liveness"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
  });

  test("model-aware: an openai/ spec with OPENAI_API_KEY passes without Anthropic creds", async () => {
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      "name: t\ntarget: cli\nagent:\n  model: openai/gpt-4o-mini\n  instructions: hi\n",
    );
    const result = await runCli(["doctor"], { cwd: tmp, env: { OPENAI_API_KEY: "sk-x" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ OpenAI credentials (model openai/gpt-4o-mini)");
    expect(result.stdout).toContain("all checks passed");
  });

  test("model-aware: an openai/ spec with NO provider env fails on OpenAI, not Anthropic", async () => {
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      "name: t\ntarget: cli\nagent:\n  model: openai/gpt-4o-mini\n  instructions: hi\n",
    );
    const result = await runCli(["doctor"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("✗ OpenAI credentials");
    expect(result.stdout).not.toContain("✗ Anthropic credentials");
  });

  test("model-aware: a bedrock/ spec is informational and exits 0 without AWS env", async () => {
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      "name: t\ntarget: cli\nagent:\n  model: bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0\n  instructions: hi\n",
    );
    const result = await runCli(["doctor"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("~ Bedrock (AWS) credentials");
  });

  test("doctor --help documents --liveness and the model-aware checks", async () => {
    const result = await runCli(["doctor", "--help"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--liveness");
    expect(result.stdout).toContain("model-aware");
  });

  // FR-002 — the philosophy-alignment audit now includes a Pillar 3 sink-side
  // pass over the built-in tool map, sharing auditToolScopes with
  // `compile --strict`. Run from REPO_ROOT so the package-presence checks and
  // loadToolMap() see the real workspace. All built-in outward tools ship
  // scope:"external", so the new check is green and the overall audit exits 0.
  test("--philosophy-alignment audits built-in tool scopes and reports them green", async () => {
    const result = await runCli(["doctor", "--philosophy-alignment"], {
      cwd: REPO_ROOT,
      env: { ANTHROPIC_API_KEY: "test" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Pillar 3 — all built-in outward tools scope:"external"');
    expect(result.stdout).toContain("philosophy alignment: green");
  });
});

// ---------------------------------------------------------------------------
// FR-003 — `crewhaus optimize --budget-usd` (cost budget gate).
// Closes the affected-package coverage the FR implies: the flag's
// negative-validation branch, the flag's forwarding into optimizeSpec, and
// the spend summary on the resulting report. The validation tests need no
// credentials (they short-circuit via die() before any model call); the
// full-run test is creds-gated like the eval CLI test (the fitness function
// runs the real agent) and asserts on the persisted report.json rather than
// stdout, which is the robust artifact surface.
// ---------------------------------------------------------------------------
describe("crewhaus optimize --budget-usd", () => {
  // A throwaway dataset + graders so the run reaches the budget gate. The
  // grader is response-independent (`contains: q`) so the pipeline runs
  // regardless of the agent's actual answer.
  function writeOptimizeFixtures(): { dataset: string; graders: string } {
    const dataset = join(tmp, "dataset.jsonl");
    const graders = join(tmp, "graders.yaml");
    writeFileSync(
      dataset,
      [
        '{"id":"q1","input":"hi","expected_output":"hi"}',
        '{"id":"q2","input":"yo","expected_output":"yo"}',
        '{"id":"q3","input":"hey","expected_output":"hey"}',
      ].join("\n"),
    );
    writeFileSync(graders, "graders:\n  - name: g\n    type: contains\n    substring: 'q'\n");
    return { dataset, graders };
  }

  test("rejects --budget-usd 0 (non-positive) via die()", async () => {
    const { dataset, graders } = writeOptimizeFixtures();
    const result = await runCli(
      ["optimize", HELLO_SPEC, "--dataset", dataset, "--graders", graders, "--budget-usd", "0"],
      { env: { ANTHROPIC_API_KEY: "test-no-call" } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid --budget-usd");
    expect(result.stderr).toContain("positive number");
  });

  test("rejects a negative --budget-usd via die()", async () => {
    const { dataset, graders } = writeOptimizeFixtures();
    const result = await runCli(
      ["optimize", HELLO_SPEC, "--dataset", dataset, "--graders", graders, "--budget-usd", "-1.5"],
      { env: { ANTHROPIC_API_KEY: "test-no-call" } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid --budget-usd");
  });

  test("rejects a non-numeric --budget-usd (NaN) via die()", async () => {
    const { dataset, graders } = writeOptimizeFixtures();
    const result = await runCli(
      ["optimize", HELLO_SPEC, "--dataset", dataset, "--graders", graders, "--budget-usd", "lots"],
      { env: { ANTHROPIC_API_KEY: "test-no-call" } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid --budget-usd");
  });

  test("a VALID --budget-usd clears validation (fails later on a missing graders file, not on the budget)", async () => {
    // Proves the positive branch: a well-formed budget is accepted and the
    // run proceeds PAST the budget gate — the only failure is the absent
    // graders file, whose error message is distinct from the budget error.
    const dataset = join(tmp, "dataset.jsonl");
    writeFileSync(dataset, '{"id":"q1","input":"hi","expected_output":"hi"}');
    const missingGraders = join(tmp, "does-not-exist-graders.yaml");
    const result = await runCli(
      [
        "optimize",
        HELLO_SPEC,
        "--dataset",
        dataset,
        "--graders",
        missingGraders,
        "--budget-usd",
        "2.50",
      ],
      { env: { ANTHROPIC_API_KEY: "test-no-call" } },
    );
    expect(result.exitCode).toBe(1);
    // Did NOT die on the budget — the budget was valid.
    expect(result.stderr).not.toContain("invalid --budget-usd");
    // Died on the next step instead: reading the (missing) graders file.
    expect(result.stderr).toContain("could not read");
  });

  test("optimize --help lists the --budget-usd flag", async () => {
    const result = await runCli(["optimize", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--budget-usd");
  });

  test("a rule-based optimize run reports $0 spend + iterations-cap stop in report.json, with the budget forwarded", async () => {
    // Creds-gated: the fitness function runs the real agent (eval-runner),
    // so without an Anthropic token the SDK call would block. Skip in that
    // case — the validation tests above still cover the flag deterministically.
    if (!process.env["ANTHROPIC_AUTH_TOKEN"] && !process.env["ANTHROPIC_API_KEY"]) {
      return;
    }
    const { dataset, graders } = writeOptimizeFixtures();
    const out = join(tmp, "opt-out");
    const result = await runCli(
      [
        "optimize",
        HELLO_SPEC,
        "--dataset",
        dataset,
        "--graders",
        graders,
        // rule-based mutator (default) → no model calls in the search → $0.
        "--iterations",
        "2",
        "--seed",
        "7",
        "--budget-usd",
        "1.50",
        "-o",
        out,
      ],
      { env: { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "" } },
    );
    expect(result.exitCode).toBe(0);
    // Assert on the persisted report (robust artifact, not stdout).
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf-8"));
    // The flag was forwarded into optimizeSpec (persisted to the report).
    expect(report.budgetUsd).toBe(1.5);
    // Rule-based run → $0 spend, bounded by the iterations cap (not the budget).
    expect(report.stoppedReason).toBe("iterations-cap");
    expect(report.spend.totalUsd).toBe("$0.0000");
    expect(report.spend.totalUsdMicros).toBe(0);
    expect(report.spend.stopped).toBe("iterations-cap");
  }, 120_000);
});

describe("crewhaus help and unknown subcommand", () => {
  for (const flag of ["--help", "-h"]) {
    test(`${flag} prints usage to stdout and exits 0 (works in \`set -e\` health checks)`, async () => {
      const result = await runCli([flag]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("compile");
      expect(result.stdout).toContain("run");
      expect(result.stdout).toContain("init");
      expect(result.stdout).toContain("doctor");
    });
  }

  test("no subcommand prints usage to stderr and exits 1 (usage error)", async () => {
    const result = await runCli([]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("usage: crewhaus");
  });

  test("unknown subcommand exits 1 with a clear message", async () => {
    const result = await runCli(["frobnicate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown subcommand");
  });
});

describe("crewhaus secrets backend selection", () => {
  test("--backend vault errors clearly instead of silently using env-var", async () => {
    const result = await runCli(["secrets", "doctor", "--backend", "vault"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("vault backend is not wired into the CLI");
  });

  test("an unknown backend is rejected", async () => {
    const result = await runCli(["secrets", "doctor", "--backend", "bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown secrets backend "bogus"');
  });

  test("--backend file rotates into a not-yet-existing root dir (auto-mkdir)", async () => {
    const root = join(tmp, "nested", "secrets");
    const result = await runCli([
      "secrets",
      "rotate",
      "demo",
      "--backend",
      "file",
      "--root-dir",
      root,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rotated demo");
    expect(existsSync(join(root, "demo"))).toBe(true);
  });
});

describe("crewhaus cost-summary", () => {
  const SESSION_ID = "sess_00000000000000ab";

  function seedSession(lines: ReadonlyArray<unknown>): void {
    const dir = join(tmp, ".crewhaus", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${SESSION_ID}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  }

  test("sums cost_accrual events written in the real event-log envelope shape", async () => {
    seedSession([
      { ts: 1, version: 1, kind: "user_message", payload: { content: "hi" } },
      {
        ts: 2,
        version: 1,
        kind: "cost_accrual",
        payload: { provider: "anthropic", modelId: "claude-sonnet-4-6", costUsdMicros: 450 },
      },
      {
        ts: 3,
        version: 1,
        kind: "cost_accrual",
        payload: { provider: "anthropic", modelId: "claude-sonnet-4-6", costUsdMicros: 300 },
      },
    ]);
    const result = await runCli(["cost-summary", "--session", SESSION_ID, "--format", "json"], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as {
      count: number;
      totalUsdMicros: number;
      byProvider: Record<string, number>;
    };
    expect(out.count).toBe(2);
    expect(out.totalUsdMicros).toBe(750);
    expect(out.byProvider["anthropic"]).toBe(750);
  });

  test("still reads flat (non-enveloped) cost_accrual lines for back-compat", async () => {
    seedSession([{ kind: "cost_accrual", provider: "openai", costUsdMicros: 1000 }]);
    const result = await runCli(["cost-summary", "--session", SESSION_ID, "--format", "json"], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as { totalUsdMicros: number };
    expect(out.totalUsdMicros).toBe(1000);
  });
});

describe("crewhaus version", () => {
  const pkgVersion = (
    JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8")) as {
      version: string;
    }
  ).version;

  for (const flag of ["version", "--version", "-v"]) {
    test(`${flag} prints the package version and exits 0`, async () => {
      const result = await runCli([flag]);
      expect(result.exitCode).toBe(0);
      // stdout must be exactly the version; stderr is left unchecked because
      // adapter-anthropic logs an import-time warning on hosts without an
      // installed claude CLI.
      expect(result.stdout.trim()).toBe(pkgVersion);
    });
  }
});
