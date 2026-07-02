import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditKind, FileAnchorStore, openAuditLog } from "@crewhaus/audit-log";
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

  // Item 42 — generated bundle README, DEFAULT-ON.
  test("emits a generated README.md into the bundle by default (item 42)", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(result.exitCode).toBe(0);
    const readmePath = join(tmp, "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const md = readFileSync(readmePath, "utf-8");
    expect(md).toContain("<!-- crewhaus:generated-readme -->");
    expect(md).toContain("| Target | `cli` |");
    expect(md).toContain("bun agent.ts");
  });

  test("--no-readme skips the generated README.md (item 42 opt-out)", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--no-readme", "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "agent.ts"))).toBe(true);
    expect(existsSync(join(tmp, "README.md"))).toBe(false);
  });

  test("a user-authored README.md in the out-dir is kept, with a notice (item 42)", async () => {
    const readmePath = join(tmp, "README.md");
    writeFileSync(readmePath, "# my notes\n\nhand-written\n");
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(readmePath, "utf-8")).toBe("# my notes\n\nhand-written\n");
    expect(result.stdout).toContain("kept");
    expect(result.stdout).toContain("--no-readme");
  });

  test("a previously GENERATED README.md is refreshed on recompile (item 42)", async () => {
    const first = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(first.exitCode).toBe(0);
    const readmePath = join(tmp, "README.md");
    const generated = readFileSync(readmePath, "utf-8");
    const second = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain(`wrote ${readmePath}`);
    expect(readFileSync(readmePath, "utf-8")).toBe(generated);
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
    // Item 42 — README emission and its opt-out are documented too.
    expect(result.stdout).toContain("README.md");
    expect(result.stdout).toContain("--no-readme");
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
    // Scaffolded in cwd → run in place, no cd needed.
    expect(result.stdout).toContain("next: crewhaus run crewhaus.yaml");
  });

  test("scaffolds into a named subdirectory", async () => {
    const result = await runCli(["init", "myapp"], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    const written = join(tmp, "myapp", "crewhaus.yaml");
    expect(existsSync(written)).toBe(true);
    const spec = parseSpec(readFileSync(written, "utf-8"));
    expect(spec.name).toBe("myapp");
    // Scaffolded into a subdir → the hint must cd into it so the runtime
    // resolves the spec + .crewhaus/ session store from the harness dir.
    expect(result.stdout).toContain("next: cd myapp && crewhaus run crewhaus.yaml");
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

  // Item 28 (half 1) — cache economics columns.
  type CacheSummaryJson = {
    count: number;
    totalUsdMicros: number;
    byProvider: Record<string, number>;
    inputTokens: number;
    outputTokens: number;
    cachedReadTokens: number;
    cacheCreationTokens: number;
    cacheHitRatio: number;
    cacheSavingsUsdMicros: number;
    cacheByModel: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cachedReadTokens: number;
        cacheCreationTokens: number;
        cacheHitRatio: number;
        cacheSavingsUsdMicros: number | null;
      }
    >;
  };

  function seedCacheSession(): void {
    seedSession([
      {
        ts: 1,
        version: 1,
        kind: "cost_accrual",
        payload: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          inputTokens: 1000,
          outputTokens: 100,
          cachedReadTokens: 4000,
          cacheCreationTokens: 2000,
          // 1000×3 + 100×15 + 4000×0.3 + 2000×3.75 (sonnet row + fallback cache rates)
          costUsdMicros: 13_200,
        },
      },
      {
        ts: 2,
        version: 1,
        kind: "cost_accrual",
        // Unmapped model — tokens/ratio still aggregate; savings can't be priced.
        payload: {
          provider: "openai",
          modelId: "fictional-model-99",
          inputTokens: 100,
          outputTokens: 10,
          cachedReadTokens: 100,
          cacheCreationTokens: 50,
          costUsdMicros: 42,
        },
      },
    ]);
  }

  test("json gains cache economics: tokens, hit ratio, and realized savings per provider/model + total", async () => {
    seedCacheSession();
    const result = await runCli(["cost-summary", "--session", SESSION_ID, "--format", "json"], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as CacheSummaryJson;
    // Pre-existing fields keep their exact shape and values (additive-only).
    expect(out.count).toBe(2);
    expect(out.totalUsdMicros).toBe(13_242);
    expect(out.byProvider["anthropic"]).toBe(13_200);
    expect(out.byProvider["openai"]).toBe(42);
    // Totals across models.
    expect(out.inputTokens).toBe(1100);
    expect(out.outputTokens).toBe(110);
    expect(out.cachedReadTokens).toBe(4100);
    expect(out.cacheCreationTokens).toBe(2050);
    // hit = cachedRead / (input + cachedRead) = 4100 / 5200
    expect(out.cacheHitRatio).toBeCloseTo(4100 / 5200, 10);
    // Savings sum only over priced buckets:
    // sonnet reads 4000 × ($3 − $0.3) = 10_800; writes 2000 × ($3.75 − $3) = 1_500 → 9_300.
    expect(out.cacheSavingsUsdMicros).toBe(9_300);
    const sonnet = out.cacheByModel["anthropic/claude-sonnet-4-6"];
    expect(sonnet?.cachedReadTokens).toBe(4000);
    expect(sonnet?.cacheCreationTokens).toBe(2000);
    expect(sonnet?.cacheHitRatio).toBeCloseTo(0.8, 10);
    expect(sonnet?.cacheSavingsUsdMicros).toBe(9_300);
    const unknown = out.cacheByModel["openai/fictional-model-99"];
    expect(unknown?.cacheHitRatio).toBeCloseTo(0.5, 10);
    expect(unknown?.cacheSavingsUsdMicros).toBeNull();
  });

  test("text format appends cache lines per provider/model + total, unknown model prices as n/a", async () => {
    seedCacheSession();
    const result = await runCli(["cost-summary", "--session", SESSION_ID], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    // Pre-existing lines unchanged.
    expect(result.stdout).toContain(`session: ${SESSION_ID}`);
    expect(result.stdout).toContain("accrual events: 2");
    expect(result.stdout).toContain("total: $0.0132");
    // New cache economics lines.
    expect(result.stdout).toContain("cache: read=4100 write=2050 hit=78.8% savings=$0.0093");
    expect(result.stdout).toContain(
      "  anthropic/claude-sonnet-4-6: read=4000 write=2000 hit=80.0% savings=$0.0093",
    );
    expect(result.stdout).toContain(
      "  openai/fictional-model-99: read=100 write=50 hit=50.0% savings=n/a",
    );
  });

  test("old logs keep parsing: token-less and pre-cache-write accruals aggregate with zero-filled cache fields", async () => {
    seedSession([
      // Oldest vintage: no token fields at all.
      {
        ts: 1,
        version: 1,
        kind: "cost_accrual",
        payload: { provider: "anthropic", modelId: "claude-sonnet-4-6", costUsdMicros: 450 },
      },
      // Mid vintage: cachedReadTokens but no cacheCreationTokens.
      {
        ts: 2,
        version: 1,
        kind: "cost_accrual",
        payload: {
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          inputTokens: 1000,
          outputTokens: 10,
          cachedReadTokens: 500,
          costUsdMicros: 3_300,
        },
      },
    ]);
    const result = await runCli(["cost-summary", "--session", SESSION_ID, "--format", "json"], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    const out = JSON.parse(result.stdout) as CacheSummaryJson;
    expect(out.count).toBe(2);
    expect(out.totalUsdMicros).toBe(3_750);
    expect(out.cachedReadTokens).toBe(500);
    expect(out.cacheCreationTokens).toBe(0);
    expect(out.cacheHitRatio).toBeCloseTo(500 / 1500, 10);
    // Savings with zero writes: 500 × ($3 − $0.3) = 1_350 micros.
    expect(out.cacheSavingsUsdMicros).toBe(1_350);
  });

  test("cost-summary --help documents the hit-ratio denominator and savings formula", async () => {
    const result = await runCli(["cost-summary", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cachedReadTokens / (inputTokens + cachedReadTokens)");
    expect(result.stdout).toContain("cache-write premium");
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

// ---------------------------------------------------------------------------
// Item 34 — `crewhaus audit verify` + schedulable `compliance evidence`.
// ---------------------------------------------------------------------------

/** Append one audit record per `kind` to `<dir>` (creating the store). */
async function seedAuditLog(
  dir: string,
  kinds: ReadonlyArray<AuditKind>,
  anchorStore?: FileAnchorStore,
): Promise<void> {
  const log = await openAuditLog({ rootDir: dir, ...(anchorStore ? { anchorStore } : {}) });
  for (const kind of kinds) {
    await log.append({ kind, payload: { seeded: kind } });
  }
}

/** Flip one payload byte on the given line of the newest day file. */
function tamperAuditLog(dir: string, lineIndex: number): void {
  const dayFile = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .at(-1) as string;
  const file = join(dir, dayFile);
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "");
  const record = JSON.parse(lines[lineIndex] as string);
  record.payload = { seeded: "tampered" };
  lines[lineIndex] = JSON.stringify(record);
  writeFileSync(file, `${lines.join("\n")}\n`);
}

describe("crewhaus audit verify", () => {
  test("--help documents --dir, --anchor, and the exit-code contract", async () => {
    const result = await runCli(["audit", "verify", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--dir <auditDir>");
    expect(result.stdout).toContain("--anchor file:<path>");
    expect(result.stdout).toContain("Exit code: 0 intact");
  });

  test("an unknown audit action dies with the allowed list", async () => {
    const result = await runCli(["audit", "frobnicate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('audit action must be "verify"');
  });

  test("verifies the default ./.crewhaus/audit store in cwd and exits 0 when intact", async () => {
    await seedAuditLog(join(tmp, ".crewhaus", "audit"), ["policy_decision", "model_call"]);
    const result = await runCli(["audit", "verify"], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ hash chain intact — 2 record(s)");
    expect(result.stdout).toContain("✓ on-host chain-tail anchor");
    expect(result.stdout).toContain("audit log intact.");
  });

  test("an empty/missing store verifies as intact (0 records, anchor limitation noted)", async () => {
    const result = await runCli(["audit", "verify", "--dir", join(tmp, "no-such-audit")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("0 record(s)");
    expect(result.stdout).toContain("~ on-host chain-tail anchor absent");
  });

  test("a tampered payload exits 1 with the finding's file:line + reason", async () => {
    const auditDir = join(tmp, "audit");
    await seedAuditLog(auditDir, ["policy_decision", "secrets_access", "model_call"]);
    tamperAuditLog(auditDir, 1);
    const result = await runCli(["audit", "verify", "--dir", auditDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("✗ tamper finding at");
    expect(result.stdout).toContain(":2 — hash mismatch");
    expect(result.stdout).toContain("audit verification FAILED.");
  });

  test("--anchor file:<path> cross-checks a mirrored FileAnchorStore and exits 0", async () => {
    const auditDir = join(tmp, "audit");
    const anchorDir = join(tmp, "anchors");
    await seedAuditLog(auditDir, ["policy_decision", "model_call"], new FileAnchorStore(anchorDir));
    const result = await runCli([
      "audit",
      "verify",
      "--dir",
      auditDir,
      "--anchor",
      `file:${anchorDir}`,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ external anchor store agrees");
  });

  test("--anchor catches a truncation that rewrote the on-host anchor in lockstep", async () => {
    const auditDir = join(tmp, "audit");
    const anchorDir = join(tmp, "anchors");
    await seedAuditLog(
      auditDir,
      ["secrets_access", "secrets_access", "secrets_access"],
      new FileAnchorStore(anchorDir),
    );
    // Same-uid attacker: drop the tail record AND rewrite _chain-tail.json.
    const dayFile = readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .at(-1) as string;
    const file = join(auditDir, dayFile);
    const survivors = readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .slice(0, 2);
    writeFileSync(file, `${survivors.join("\n")}\n`);
    const last = JSON.parse(survivors[1] as string);
    const day = dayFile.replace(/\.jsonl$/, "");
    writeFileSync(
      join(auditDir, "_chain-tail.json"),
      JSON.stringify({ day, hash: last.hash, seq: last.seq }),
    );

    // Without the store the lockstep rewrite passes; with it, seq 2 is caught.
    const fooled = await runCli(["audit", "verify", "--dir", auditDir]);
    expect(fooled.exitCode).toBe(0);
    const caught = await runCli([
      "audit",
      "verify",
      "--dir",
      auditDir,
      "--anchor",
      `file:${anchorDir}`,
    ]);
    expect(caught.exitCode).toBe(1);
    expect(caught.stdout).toContain("external anchor mismatch");
  });

  test("a REQUESTED anchor store with no anchor for the log exits 1 (no silent skip)", async () => {
    const auditDir = join(tmp, "audit");
    await seedAuditLog(auditDir, ["policy_decision"]); // opened WITHOUT a store
    const emptyAnchors = join(tmp, "empty-anchors");
    mkdirSync(emptyAnchors, { recursive: true });
    const result = await runCli([
      "audit",
      "verify",
      "--dir",
      auditDir,
      "--anchor",
      `file:${emptyAnchors}`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("✗ external anchor requested (--anchor)");
  });

  test("an unknown --anchor scheme dies with the allowed list", async () => {
    const result = await runCli(["audit", "verify", "--anchor", "s3://bucket/prefix"], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid --anchor "s3://bucket/prefix"');
    expect(result.stderr).toContain("one of: file");
  });
});

describe("crewhaus doctor — audit-log integrity (item 34)", () => {
  test("a tampered .crewhaus/audit store fails doctor even when everything else is healthy", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), "name: t\ntarget: cli\n");
    const auditDir = join(tmp, ".crewhaus", "audit");
    await seedAuditLog(auditDir, ["policy_decision", "model_call"]);
    tamperAuditLog(auditDir, 0);
    const result = await runCli(["doctor"], { cwd: tmp, env: { ANTHROPIC_API_KEY: "test" } });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("✗ Audit log integrity");
    expect(result.stdout).toContain("hash mismatch");
  });

  test("an intact .crewhaus/audit store passes doctor with the record count", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), "name: t\ntarget: cli\n");
    await seedAuditLog(join(tmp, ".crewhaus", "audit"), ["policy_decision"]);
    const result = await runCli(["doctor"], { cwd: tmp, env: { ANTHROPIC_API_KEY: "test" } });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ Audit log integrity (.crewhaus/audit, 1 records)");
  });
});

describe("crewhaus compliance evidence — scheduling ergonomics (item 34)", () => {
  // The UTC quarter the CLI must resolve for --period current, computed with
  // the same arithmetic the implementation uses (compliance-schedule.ts).
  const expectedQuarter = (() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
  })();

  test("--help documents --period current, --all-frameworks, and --fail-on-empty", async () => {
    const result = await runCli(["compliance", "evidence", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--period current");
    expect(result.stdout).toContain("--all-frameworks");
    expect(result.stdout).toContain("--fail-on-empty");
    // --allow-empty never shipped and was removed with the default flip (F4).
    expect(result.stdout).not.toContain("--allow-empty");
  });

  test("--period current resolves to the current UTC quarter in output + bundle path", async () => {
    await seedAuditLog(join(tmp, ".crewhaus", "audit"), ["policy_decision"]);
    const result = await runCli(
      ["compliance", "evidence", "--framework", "soc2", "--period", "current"],
      { cwd: tmp },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`soc2/CC6.1 ${expectedQuarter}: 1 records`);
    expect(
      existsSync(join(tmp, ".crewhaus", "compliance", "soc2", "CC6.1", `${expectedQuarter}.json`)),
    ).toBe(true);
  });

  test("a control with 0 records exits 0 by default with a warning naming the gap (F4)", async () => {
    // policy_decision satisfies CC6.1 only; CC6.7/CC7.2/CC7.3 collect nothing.
    // The documented bare invocation must keep exiting 0 — the gap is warned,
    // not fatal, unless --fail-on-empty opts into the scheduled tripwire.
    await seedAuditLog(join(tmp, ".crewhaus", "audit"), ["policy_decision"]);
    const result = await runCli(
      ["compliance", "evidence", "--framework", "soc2", "--period", "2026-Q2"],
      { cwd: tmp },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("warning: evidence gap");
    expect(result.stderr).toContain("soc2/CC6.7");
    expect(result.stderr).toContain("--fail-on-empty");
    // Bundles were still written (the non-empty ones remain valid evidence).
    expect(existsSync(join(tmp, ".crewhaus", "compliance", "soc2", "CC6.1", "2026-Q2.json"))).toBe(
      true,
    );
  });

  test("--fail-on-empty turns the evidence gap into exit 1 (scheduled tripwire)", async () => {
    await seedAuditLog(join(tmp, ".crewhaus", "audit"), ["policy_decision"]);
    const result = await runCli(
      ["compliance", "evidence", "--framework", "soc2", "--period", "2026-Q2", "--fail-on-empty"],
      { cwd: tmp },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("evidence gap");
    expect(result.stderr).toContain("soc2/CC6.7");
    // Bundles were still written (the non-empty ones remain valid evidence).
    expect(existsSync(join(tmp, ".crewhaus", "compliance", "soc2", "CC6.1", "2026-Q2.json"))).toBe(
      true,
    );
  });

  test("a framework whose every control collected evidence passes --fail-on-empty silently", async () => {
    await seedAuditLog(join(tmp, ".crewhaus", "audit"), [
      "policy_decision", // CC6.1
      "secrets_rotation", // CC6.7
      "model_call", // CC7.2
      "gateway_request", // CC7.3
    ]);
    const result = await runCli(
      ["compliance", "evidence", "--framework", "soc2", "--period", "2026-Q2", "--fail-on-empty"],
      { cwd: tmp },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("evidence gap");
  });

  test("--all-frameworks collects soc2 + iso27001 + hipaa in one run", async () => {
    await seedAuditLog(join(tmp, ".crewhaus", "audit"), ["policy_decision"]);
    const result = await runCli(
      ["compliance", "evidence", "--all-frameworks", "--period", "2026-Q2"],
      { cwd: tmp },
    );
    expect(result.exitCode).toBe(0);
    for (const framework of ["soc2", "iso27001", "hipaa"]) {
      expect(result.stdout).toContain(`${framework}/`);
      expect(existsSync(join(tmp, ".crewhaus", "compliance", framework))).toBe(true);
    }
  });

  test("--framework and --all-frameworks are mutually exclusive", async () => {
    const result = await runCli(
      ["compliance", "evidence", "--framework", "soc2", "--all-frameworks", "--period", "2026-Q2"],
      { cwd: tmp },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });

  test("--control cannot combine with --all-frameworks", async () => {
    const result = await runCli(
      ["compliance", "evidence", "--all-frameworks", "--control", "CC6.1", "--period", "2026-Q2"],
      { cwd: tmp },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--control is framework-specific");
  });

  test("omitting both --framework and --all-frameworks dies pointing at both options", async () => {
    const result = await runCli(["compliance", "evidence", "--period", "2026-Q2"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--framework <id> is required (or pass --all-frameworks)");
  });
});

// ---------------------------------------------------------------------------
// Item 35 — `crewhaus retention` sweep/export/purge (GDPR/TTL enforcement).
// ---------------------------------------------------------------------------

const RETENTION_MS_PER_DAY = 86_400_000;

/** Drop an expired session file (backdated mtime) into `<root>/.crewhaus/sessions`. */
function seedExpiredSession(root: string, id: string, ageDays: number): string {
  const dir = join(root, ".crewhaus", "sessions");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({ id, name: "t" }));
  const old = new Date(Date.now() - ageDays * RETENTION_MS_PER_DAY);
  utimesSync(file, old, old);
  return file;
}

describe("crewhaus retention (item 35)", () => {
  test("--help documents the verbs, the audit exclusion, and the evidence record", async () => {
    const result = await runCli(["retention", "sweep", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--dry-run");
    expect(result.stdout).toContain("NEVER deleted");
    expect(result.stdout).toContain("retention_enforcement");
  });

  test("an unknown retention action dies with the allowed list", async () => {
    const result = await runCli(["retention", "gc"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("retention action must be one of: sweep, export, purge");
  });

  test("sweep --dry-run reports the would-delete set without deleting or appending evidence", async () => {
    const file = seedExpiredSession(tmp, "sess_1111111111111111", 40);
    const result = await runCli(["retention", "sweep", "--dry-run", "--dir", tmp]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would delete session:sess_1111111111111111");
    expect(result.stdout).toContain("dry run: nothing deleted, no evidence appended");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(tmp, ".crewhaus", "audit"))).toBe(false);
  });

  test("a real sweep deletes expired sessions, keeps audit day files, and appends verifiable evidence", async () => {
    const expired = seedExpiredSession(tmp, "sess_1111111111111111", 40);
    const fresh = seedExpiredSession(tmp, "sess_2222222222222222", 1);
    const auditDir = join(tmp, ".crewhaus", "audit");
    await seedAuditLog(auditDir, ["policy_decision"]);
    const dayFile = readdirSync(auditDir).find((f) => f.endsWith(".jsonl")) as string;

    const result = await runCli(["retention", "sweep", "--dir", tmp]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("deleted session:sess_1111111111111111");
    expect(result.stdout).toContain("audit chain integrity");
    expect(result.stdout).toContain("evidence appended to .crewhaus/audit");
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(auditDir, dayFile))).toBe(true);

    // The sweep's own evidence record landed on an intact chain.
    const verifyResult = await runCli(["audit", "verify", "--dir", auditDir]);
    expect(verifyResult.exitCode).toBe(0);
    expect(readFileSync(join(auditDir, dayFile), "utf8")).toContain('"retention_enforcement"');
  });

  test("export copies records out (originals untouched) and writes a manifest", async () => {
    seedExpiredSession(tmp, "sess_1111111111111111", 40);
    await seedAuditLog(join(tmp, ".crewhaus", "audit"), ["model_call"]);
    const outDir = join(tmp, "gdpr-export");
    const result = await runCli(["retention", "export", outDir, "--dir", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(outDir, "sessions", "sess_1111111111111111.json"))).toBe(true);
    expect(existsSync(join(outDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(tmp, ".crewhaus", "sessions", "sess_1111111111111111.json"))).toBe(true);
    expect(result.stdout).toContain("complete audit export");
  });

  test("export without <outDir> and purge with a bad --before both die cleanly", async () => {
    const missingOut = await runCli(["retention", "export", "--dir", tmp]);
    expect(missingOut.exitCode).toBe(1);
    expect(missingOut.stderr).toContain("missing <outDir>");

    const badBefore = await runCli(["retention", "purge", "--before", "not-a-date", "--dir", tmp]);
    expect(badBefore.exitCode).toBe(1);
    expect(badBefore.stderr).toContain('invalid --before "not-a-date"');
  });

  test("purge --dry-run via the CLI leaves files intact and appends no evidence (F1 BLOCKER)", async () => {
    // Verified-by-execution regression: this exact invocation used to
    // perform a REAL purge.
    const file = seedExpiredSession(tmp, "sess_1111111111111111", 40);
    const result = await runCli(["retention", "purge", "--dry-run", "--dir", tmp]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(dry run)");
    expect(result.stdout).toContain("would delete session:sess_1111111111111111");
    expect(result.stdout).toContain("dry run: nothing deleted, no evidence appended");
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(tmp, ".crewhaus", "audit"))).toBe(false);
  });

  test("export --dry-run via the CLI writes nothing (F1)", async () => {
    seedExpiredSession(tmp, "sess_1111111111111111", 40);
    const outDir = join(tmp, "gdpr-export");
    const result = await runCli(["retention", "export", outDir, "--dry-run", "--dir", tmp]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(dry run)");
    expect(result.stdout).toContain("would export 1 session(s)");
    expect(result.stdout).toContain("dry run — nothing written, no evidence appended");
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(join(tmp, ".crewhaus", "audit"))).toBe(false);
  });

  test("filter flags on unsupported actions are REJECTED, not silently ignored (F1)", async () => {
    const file = seedExpiredSession(tmp, "sess_1111111111111111", 40);

    // --since is export-only.
    for (const action of ["sweep", "purge"]) {
      const r = await runCli(["retention", action, "--since", "2026-01-01", "--dir", tmp]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain(`--since is not supported by "retention ${action}"`);
    }
    // --before is purge-only.
    const sweepBefore = await runCli([
      "retention",
      "sweep",
      "--before",
      "2026-01-01",
      "--dir",
      tmp,
    ]);
    expect(sweepBefore.exitCode).toBe(1);
    expect(sweepBefore.stderr).toContain('--before is not supported by "retention sweep"');
    const exportBefore = await runCli([
      "retention",
      "export",
      join(tmp, "out"),
      "--before",
      "2026-01-01",
      "--dir",
      tmp,
    ]);
    expect(exportBefore.exitCode).toBe(1);
    expect(exportBefore.stderr).toContain('--before is not supported by "retention export"');
    // Every rejected invocation deleted/exported nothing.
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(tmp, "out"))).toBe(false);
  });

  test("export refuses <root>/.crewhaus as outDir (F5 containment)", async () => {
    seedExpiredSession(tmp, "sess_1111111111111111", 40);
    const result = await runCli(["retention", "export", join(tmp, ".crewhaus"), "--dir", tmp]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("overlaps the live store");
    expect(existsSync(join(tmp, ".crewhaus", "sessions", "sess_1111111111111111.json"))).toBe(true);
  });
});

describe("crewhaus spec auto-register + changelog (item 46)", () => {
  // Every run uses `cwd: tmp` so the registry (.crewhaus/specs) lands in the
  // per-test temp dir, not the repo checkout.
  const REGISTRY = () => join(tmp, ".crewhaus", "specs");

  function writeSpecVariant(instructions: string): string {
    const src = readFileSync(HELLO_SPEC, "utf-8");
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      src.replace(/instructions: \|[\s\S]*$/m, `instructions: ${instructions}\n`),
    );
    return specPath;
  }

  test("a successful compile auto-registers v1 and starts the changelog", async () => {
    const out = join(tmp, "out");
    const result = await runCli(["compile", HELLO_SPEC, "-o", out], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("registered hello@v1");
    expect(existsSync(join(REGISTRY(), "hello", "v1.yaml"))).toBe(true);
    expect(existsSync(join(REGISTRY(), "hello", "manifest.json"))).toBe(true);
    const changelog = readFileSync(join(REGISTRY(), "hello", "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("# Changelog — hello");
    expect(changelog).toContain("## v1");
    expect(changelog).toContain("- initial version");
  });

  test("recompiling an unchanged spec is a registry no-op", async () => {
    const out = join(tmp, "out");
    const first = await runCli(["compile", HELLO_SPEC, "-o", out], { cwd: tmp });
    expect(first.stdout).toContain("registered hello@v1");
    const second = await runCli(["compile", HELLO_SPEC, "-o", out], { cwd: tmp });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("unchanged hello@v1");
    const changelog = readFileSync(join(REGISTRY(), "hello", "CHANGELOG.md"), "utf-8");
    expect(changelog.match(/^## /gm)).toHaveLength(1);
  });

  test("a changed spec registers v2 with a field-level diff, newest entry first", async () => {
    const out = join(tmp, "out");
    const v1 = writeSpecVariant("Answer briefly.");
    await runCli(["compile", v1, "-o", out], { cwd: tmp });
    const v2 = writeSpecVariant("Answer thoroughly.");
    const result = await runCli(["compile", v2, "-o", out], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("registered hello@v2");
    const changelog = readFileSync(join(REGISTRY(), "hello", "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("- changed `agent.instructions`");
    expect(changelog.indexOf("## v2")).toBeLessThan(changelog.indexOf("## v1"));
  });

  test("--no-register skips the auto-put entirely", async () => {
    const out = join(tmp, "out");
    const result = await runCli(["compile", HELLO_SPEC, "--no-register", "-o", out], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("registered");
    expect(existsSync(REGISTRY())).toBe(false);
  });

  test("spec log prints the accumulated changelog", async () => {
    const out = join(tmp, "out");
    await runCli(["compile", HELLO_SPEC, "-o", out], { cwd: tmp });
    const result = await runCli(["spec", "log", "hello"], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("# Changelog — hello");
    expect(result.stdout).toContain("## v1");
  });

  test("spec log for an unregistered name dies with a helpful message", async () => {
    const result = await runCli(["spec", "log", "nope"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no changelog for "nope"');
  });

  test("a manual `spec put` also appends changelog entries (with diff on the second put)", async () => {
    const f1 = join(tmp, "a.yaml");
    const f2 = join(tmp, "b.yaml");
    writeFileSync(f1, "target: cli\nname: demo\nagent:\n  model: m\n  instructions: One.\n");
    writeFileSync(f2, "target: cli\nname: demo\nagent:\n  model: m\n  instructions: Two.\n");
    const put1 = await runCli(["spec", "put", "demo", "v1", f1], { cwd: tmp });
    expect(put1.exitCode).toBe(0);
    const put2 = await runCli(["spec", "put", "demo", "v2", f2], { cwd: tmp });
    expect(put2.exitCode).toBe(0);
    const log = await runCli(["spec", "log", "demo"], { cwd: tmp });
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('- changed `agent.instructions`: "One." → "Two."');
    expect(log.stdout.indexOf("## v2")).toBeLessThan(log.stdout.indexOf("## v1"));
  });

  test("compile --help and optimize --help document --no-register", async () => {
    const compileHelp = await runCli(["compile", "--help"]);
    expect(compileHelp.exitCode).toBe(0);
    expect(compileHelp.stdout).toContain("--no-register");
    expect(compileHelp.stdout).toContain("spec log");
    const optimizeHelp = await runCli(["optimize", "--help"]);
    expect(optimizeHelp.exitCode).toBe(0);
    expect(optimizeHelp.stdout).toContain("--no-register");
  });

  test("spec --help lists the log action", async () => {
    const result = await runCli(["spec", "log", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("spec log <name>");
    // Review F3: the sanitation behaviour is documented in the help text.
    expect(result.stdout).toContain('"My Agent" → My-Agent');
  });

  test("spec log accepts the display name compile registered under its sanitized slot (review F3)", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      readFileSync(HELLO_SPEC, "utf-8").replace(/^name: .*$/m, "name: My Agent"),
    );
    const out = join(tmp, "out");
    const compiled = await runCli(["compile", specPath, "-o", out], { cwd: tmp });
    expect(compiled.exitCode).toBe(0);
    expect(compiled.stdout).toContain("registered My-Agent@v1");
    // The raw display name no longer dies — it resolves to the same slot.
    const log = await runCli(["spec", "log", "My Agent"], { cwd: tmp });
    expect(log.exitCode).toBe(0);
    expect(log.stdout).toContain('showing log for My-Agent (sanitized from "My Agent")');
    expect(log.stdout).toContain("# Changelog — My-Agent");
    // The sanitized form keeps working too, without the notice.
    const direct = await runCli(["spec", "log", "My-Agent"], { cwd: tmp });
    expect(direct.exitCode).toBe(0);
    expect(direct.stdout).not.toContain("sanitized from");
  });

  test("changelog + spec log never print credential tokens from instructions (review F1)", async () => {
    const out = join(tmp, "out");
    await runCli(["compile", writeSpecVariant("Answer briefly."), "-o", out], { cwd: tmp });
    const second = await runCli(
      ["compile", writeSpecVariant("Use key sk-live-DEADBEEFDEADBEEF for calls."), "-o", out],
      { cwd: tmp },
    );
    expect(second.exitCode).toBe(0);
    const changelog = readFileSync(join(REGISTRY(), "hello", "CHANGELOG.md"), "utf-8");
    expect(changelog).toContain("- changed `agent.instructions`");
    expect(changelog).not.toContain("sk-live");
    expect(changelog).not.toContain("DEADBEEF");
    expect(changelog).toContain("***");
    const log = await runCli(["spec", "log", "hello"], { cwd: tmp });
    expect(log.exitCode).toBe(0);
    expect(log.stdout).not.toContain("sk-live");
  });
});
