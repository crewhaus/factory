import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
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
import { DEFAULT_JUDGE_MODEL } from "@crewhaus/eval-judge";
import { parseSpec } from "@crewhaus/spec";
import { cliVersion } from "./version";

// `tsc -b` also compiles this file into `dist/`; resolve the CLI entrypoint
// from the source tree so the dist test copy can still spawn it.
const SRC_DIR = import.meta.dir.replace(/([/\\])dist$/, "$1src");
const CLI_PATH = join(SRC_DIR, "index.ts");
const REPO_ROOT = join(import.meta.dir, "../../..");
const HELLO_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-cli/crewhaus.yaml");
const BROWSER_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-browser/crewhaus.yaml");
const VOICE_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-voice/crewhaus.yaml");
const CHANNEL_SPEC = join(REPO_ROOT, "apps/cli/test-fixtures/minimal-channel/crewhaus.yaml");

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

/**
 * Spawn the CLI as a child Bun process and capture exit code + streams.
 *
 * HERMETICITY: the CLI roots its runtime artifacts at `<cwd>/.crewhaus` —
 * sessions, event logs, emitted specs, graph checkpoints, prompt cache, state,
 * audit chains. This helper used to default `cwd` to REPO_ROOT, so ~125 spawns
 * wrote all of that straight into the operator's checkout root. `.gitignore`
 * hides `.crewhaus/`, which is exactly what made it easy to miss: it
 * accumulated across every run (2642 session files in one checkout) and a
 * stale session id could still resolve in a later test.
 *
 * The default is now a per-test `sandboxCwd`, so each spawn starts from an
 * empty directory and its artifacts die with the test. Exactly one call site
 * still opts back in with `cwd: REPO_ROOT` — `doctor --philosophy-alignment`,
 * whose package-presence checks stat `process.cwd()` directly. Everything
 * else is cwd-independent: specs and `-o` targets are passed as absolute
 * paths, and the built-in tool map resolves from the CLI module rather than
 * the working directory.
 */
async function runCli(args: ReadonlyArray<string>, opts: RunOpts = {}): Promise<RunResult> {
  const baseEnv: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...HERMETIC_REGISTRY,
  };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v !== undefined) baseEnv[k] = v;
  }
  const proc = Bun.spawn([process.execPath, CLI_PATH, ...args], {
    cwd: opts.cwd ?? sandboxCwd,
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
/**
 * The default spawn cwd. Kept SEPARATE from `tmp` (which tests pass as the
 * `-o` output dir and then assert on) so the CLI's own `.crewhaus/` artifacts
 * never show up in a directory listing a test is inspecting.
 */
let sandboxCwd: string;

/**
 * Hermetic harness registry for every spawn in this file.
 *
 * `run`/`compile`/`eval`/`dev` self-register the harness they touch, and for
 * a spec passed by path that is the SPEC's directory — `HELLO_SPEC` and its
 * siblings above, inside the repo. The default registry root's ephemeral-cwd
 * guard cannot help (it looks at the cwd, not at the spec dir), so without
 * this every run of this file writes a row per fixture into the developer's
 * real `~/.crewhaus/harnesses.json`.
 */
const REGISTRY_ROOT = mkdtempSync(join(tmpdir(), "crewhaus-cli-registry-"));
const HERMETIC_REGISTRY: Record<string, string> = {
  CREWHAUS_REGISTRY_ROOT: join(REGISTRY_ROOT, "registry"),
  CREWHAUS_WATCHME_ROOT: join(REGISTRY_ROOT, "watchme"),
};
afterAll(() => {
  rmSync(REGISTRY_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "crewhaus-cli-test-"));
  sandboxCwd = mkdtempSync(join(tmpdir(), "crewhaus-cli-cwd-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(sandboxCwd, { recursive: true, force: true });
});

describe("crewhaus compile", () => {
  test("emits agent.ts for a valid spec", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "agent.ts"))).toBe(true);
    expect(result.stdout).toContain("compiled bundle");
  });

  test("emits a pinned package.json so the bundle runs standalone", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(result.exitCode).toBe(0);
    const manifestPath = join(tmp, "package.json");
    expect(result.stdout).toContain(`wrote ${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.name).toBe("crewhaus-compiled-bundle");
    // Every @crewhaus import in the emitted entrypoint is declared, all
    // pinned to the CLI's own version — never the "latest" fallback, which
    // would make the bundle's behavior depend on the day it first ran.
    const agent = readFileSync(join(tmp, "agent.ts"), "utf-8");
    const imports = [...agent.matchAll(/from "(@crewhaus\/[a-z0-9-]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(imports.length).toBeGreaterThan(0); // guard: emitter import style changed → loop vacuous
    for (const dep of imports) expect(manifest.dependencies[dep]).toBeDefined();
    expect(cliVersion()).toBeDefined();
    for (const pin of Object.values(manifest.dependencies)) expect(pin).toBe(cliVersion());
  });

  test("a user-authored package.json in the out-dir is kept on plain compile", async () => {
    const manifestPath = join(tmp, "package.json");
    const foreign = '{ "name": "my-harness", "dependencies": { "left-pad": "1.0.0" } }\n';
    writeFileSync(manifestPath, foreign);
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(manifestPath, "utf-8")).toBe(foreign);
    // The message must warn that the pinned manifest was NOT written — a
    // silent keep would reintroduce the unresolvable-imports failure with
    // no signal (e.g. after an --emit-as cf-worker compile into this dir).
    expect(result.stdout).toContain(`kept ${manifestPath}`);
    expect(result.stdout).toContain("pinned @crewhaus manifest was NOT written");
  });

  test("--with-eval-harness emits a pinned manifest for the eval bridge too", async () => {
    const result = await runCli(["compile", CHANNEL_SPEC, "--with-eval-harness", "-o", tmp]);
    expect(result.exitCode).toBe(0);
    // Primary (channel) bundle and the projected eval bridge each carry
    // their own manifest — each is its own standalone local bundle.
    for (const dir of [tmp, join(tmp, "eval")]) {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      expect(manifest.name).toBe("crewhaus-compiled-bundle");
      expect(Object.keys(manifest.dependencies).length).toBeGreaterThan(0);
      for (const pin of Object.values(manifest.dependencies)) expect(pin).toBe(cliVersion());
    }
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

  // Loop contract 0.4 (Batch B, G42) — `--emit-loop`: projectLoop() of the
  // lowered IR, the wire contract shared with the studio /builder and the
  // compiler-worker's POST /loop.
  test("--emit-loop with -o writes loop.json byte-matching the keystone projection golden (G42)", async () => {
    const fixturesDir = join(REPO_ROOT, "packages/compiler/src/__fixtures__");
    const golden = JSON.parse(
      readFileSync(join(fixturesDir, "loop-projections.golden.json"), "utf-8"),
    ) as Record<string, unknown>;
    const { LOOP_PROJECTION_SPECS } = (await import(
      join(fixturesDir, "loop-projection-specs.ts")
    )) as { LOOP_PROJECTION_SPECS: Record<string, string> };
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, LOOP_PROJECTION_SPECS["cli"] as string);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--emit-loop", "-o", outDir]);
    expect(result.exitCode).toBe(0);
    const loopPath = join(outDir, "loop.json");
    expect(existsSync(loopPath)).toBe(true);
    // A print mode like --emit-ir: no codegen.
    expect(existsSync(join(outDir, "agent.ts"))).toBe(false);
    expect(result.stdout).toContain(`wrote ${loopPath}`);
    // Byte-parity with the golden the compiler + compiler-worker pin — the
    // CLI, the worker endpoint, and the studio must render the same object.
    const projection = JSON.parse(readFileSync(loopPath, "utf-8"));
    expect(JSON.stringify(projection)).toBe(JSON.stringify(golden["cli"]));
  });

  test("--emit-loop without -o exits 0 (human render; stdout capture is racy — see --emit-ir note)", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--emit-loop"]);
    expect(result.exitCode).toBe(0);
  });

  test("--emit-loop --json without -o exits 0", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--emit-loop", "--json"]);
    expect(result.exitCode).toBe(0);
  });

  test("--emit-loop is a read-only view: the FR-002 scope gate does NOT run (POST /loop parity)", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      "name: evil\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: |\n    do a thing\ntools:\n  - mcp__evil__exfiltrate\n",
    );
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--emit-loop", "-o", outDir]);
    // The same spec FAILS `compile`/`--emit-ir` by default (gate tests
    // below); the projection is not an artifact, so it renders.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("[strict]");
    expect(existsSync(join(outDir, "loop.json"))).toBe(true);
  });

  test("--emit-loop rejects --check and --emit-ir combinations", async () => {
    const withCheck = await runCli(["compile", HELLO_SPEC, "--emit-loop", "--check"]);
    expect(withCheck.exitCode).toBe(1);
    expect(withCheck.stderr).toContain("--emit-loop");
    const withEmitIr = await runCli(["compile", HELLO_SPEC, "--emit-loop", "--emit-ir"]);
    expect(withEmitIr.exitCode).toBe(1);
    expect(withEmitIr.stderr).toContain("mutually exclusive");
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

  // Loop contract 0.4 (Batch A) — compile warnings (accepted-but-unwired
  // spec keys) always print, one line per warning, code + path + message;
  // `--strict` escalates them to a failed build that emits nothing. A
  // workflow spec declaring `continuity:` is the canonical warning case
  // (its emitter prints the ignored-note comment instead of wiring it).
  const WARNING_SPEC =
    "name: warnful\ntarget: workflow\nmodel: claude-sonnet-4-6\nsteps:\n  - name: step1\n    instructions: do the thing\ncontinuity: true\n";

  test("compile prints accepted-but-unwired warnings (code+path+message, one per line) and still emits", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, WARNING_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--no-register", "-o", outDir], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    // One line, carrying the code, the spec path, and the message.
    expect(result.stderr).toContain("crewhaus: warning[accepted-but-unwired] continuity:");
    expect(result.stderr).toContain("accepted on the workflow shape");
    const warningLines = result.stderr.split("\n").filter((l) => l.includes("warning["));
    expect(warningLines.length).toBe(1);
    // Warnings do not fail the build without --strict.
    expect(result.stdout).toContain("compiled bundle");
    expect(existsSync(join(outDir, "agent.ts"))).toBe(true);
  });

  test("compile --strict escalates warnings to errors and writes NOTHING", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, WARNING_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--strict", "--no-register", "-o", outDir], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(1);
    // The warning itself still prints (with its path), then the escalation.
    expect(result.stderr).toContain("crewhaus: warning[accepted-but-unwired] continuity:");
    expect(result.stderr).toContain("--strict: 1 compile warning(s) escalated to errors");
    // A strict-failed build must not emit — the out dir is never created.
    expect(existsSync(outDir)).toBe(false);
  });

  test("compile --strict passes a warning-free spec (and prints no warning lines)", async () => {
    const outDir = join(tmp, "out");
    const result = await runCli(
      ["compile", HELLO_SPEC, "--strict", "--no-register", "-o", outDir],
      {
        cwd: tmp,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("warning[");
    expect(existsSync(join(outDir, "agent.ts"))).toBe(true);
  });

  // D40 — channel-reactions-join is INFORMATIONAL: it fires on a fully
  // wired, correctly configured feature (the outbound-ts join file just has
  // to accumulate at runtime), so no spec edit can ever clear it. --strict
  // must NOT escalate it — otherwise strict compiles would be permanently
  // unusable for every reactions-enabled channel spec. The heads-up line
  // itself still prints.
  test("compile --strict does NOT escalate the informational channel-reactions-join warning", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      "name: reactful\ntarget: channel\nagent:\n  model: claude-sonnet-4-6\n  instructions: reply kindly\nchannels:\n  slack:\n    botToken: $SLACK_BOT_TOKEN\n    signingSecret: $SLACK_SIGNING_SECRET\nrouting:\n  sessionKey: thread\nfeedback:\n  channelReactions: true\n",
    );
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--strict", "--no-register", "-o", outDir], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    // The informational warning still prints (code + path)…
    expect(result.stderr).toContain(
      "crewhaus: warning[channel-reactions-join] feedback.channelReactions:",
    );
    // …but never escalates, and the bundle is written.
    expect(result.stderr).not.toContain("escalated to errors");
    expect(existsSync(join(outDir, "session-router.ts"))).toBe(true);
  });

  // 0.6.0 PR 7 — the model-plan notices that no spec edit can properly clear
  // are informational too: model-plan-pending-runtime fires on a key the plan
  // tells authors to adopt (its runtime lands in a later PR-train row — since
  // PR 10 honours a candidate's failover chain and breaker, the pending key
  // here is a `strategy.guide` side call on a compiled cli bundle, which
  // waits for the emitters' boot-time wireModels row), and model-sunset is a
  // wall-clock notice on a 0.5.x pool that compiled under --strict yesterday.
  // Both print; neither fails --strict.
  test("compile --strict does NOT escalate the informational model-plan-pending-runtime / model-sunset notices", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      [
        "name: pooled",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: route it",
        "  model_pool:",
        "    candidates:",
        "      - { model: claude-haiku-4-5, tags: [cheap], fallbacks: [claude-sonnet-4-6] }",
        "      - { model: claude-opus-4-1, tags: [strong] }",
        "    strategy:",
        "      guide: { model: claude-opus-4-1, every: first_turn }",
        "",
      ].join("\n"),
    );
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--strict", "--no-register", "-o", outDir], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "crewhaus: warning[model-plan-pending-runtime] agent.model_pool.strategy.guide:",
    );
    // PR 10 honours the candidate's failover chain: nothing pends on it.
    expect(result.stderr).not.toContain("agent.model_pool.candidates[0].fallbacks");
    expect(result.stderr).toContain(
      "crewhaus: warning[model-sunset] agent.model_pool.candidates[1]",
    );
    expect(result.stderr).not.toContain("escalated to errors");
    expect(existsSync(join(outDir, "agent.ts"))).toBe(true);
  });

  // Item 1 — the cli emitter used to DROP the spec's `feedback:` block, so a
  // compiled bundle had no rating prompt and no user_feedback capture at all
  // while `crewhaus run` had both. The bundle now threads the block into
  // runChatLoop (the runtime owns the prompt); only the autoDistill half stays
  // a toolchain step, and the compile says so without failing --strict.
  test("a feedback spec compiles the block into the bundle and warns only about autoDistill", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      "name: ghostwriter\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: ghostwrite\nfeedback:\n  modality: binary\n  autoDistill: true\n",
    );
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--strict", "--no-register", "-o", outDir], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    // The improvement contract reached the shipped artifact.
    expect(readFileSync(join(outDir, "agent.ts"), "utf-8")).toContain("feedback:");
    // Honest about the half it does not carry — and never escalated.
    expect(result.stderr).toContain(
      "crewhaus: warning[cli-autodistill-toolchain] feedback.autoDistill:",
    );
    expect(result.stderr).not.toContain("escalated to errors");
  });

  test("compile --help documents the warning line shape and --strict escalation", async () => {
    const result = await runCli(["compile", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("accepted-but-unwired");
    expect(result.stdout).toContain("warning[<code>] <path>: <message>");
    expect(result.stdout).toContain("--strict");
    expect(result.stdout).toContain("Escalate compile warnings to errors");
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
    expect(spec.agent.model).toBe("claude-opus-5");
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

  // Phase 3 §3.3 — `cli.banner` used to be codegen-only: a compiled bundle
  // printed the brand, `crewhaus run` never read `ir.cli`, so an authored
  // banner was invisible to everyone who ran the spec directly. Both surfaces
  // now render from @crewhaus/target-cli's `renderBanner` (the byte-level
  // codegen/interpreter parity is pinned in that package's banner.test.ts).
  describe("cli.banner", () => {
    /** A cli spec carrying a banner block, written into the test's tmp dir. */
    function writeBannerSpec(taglines: ReadonlyArray<string>, mode = "static"): string {
      const path = join(tmp, "crewhaus.yaml");
      writeFileSync(
        path,
        [
          "name: bannered",
          "target: cli",
          "agent:",
          "  model: claude-sonnet-4-6",
          "  instructions: be brief",
          "cli:",
          "  banner:",
          `    taglineMode: ${mode}`,
          "    taglines:",
          ...taglines.map((t) => `      - ${JSON.stringify(t)}`),
          "",
        ].join("\n"),
      );
      return path;
    }

    test("prints the spec's banner on a cold `crewhaus run`", async () => {
      const spec = writeBannerSpec(["exhaustive by default"]);
      const result = await runCli(["run", spec], {
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: "test-no-call" },
        closeStdinImmediately: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("\n\x1b[1mbannered\x1b[0m — exhaustive by default\n\n");
      // Brand first: the banner precedes the boot diagnostics, exactly as it
      // does in a compiled bundle.
      expect(result.stdout.indexOf("exhaustive by default")).toBeLessThan(
        result.stdout.indexOf("agent ready"),
      );
    });

    test("a spec without a banner block prints none", async () => {
      const result = await runCli(["run", HELLO_SPEC], {
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: "test-no-call" },
        closeStdinImmediately: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("\x1b[1m");
    });

    test("CREWHAUS_RESUMED=1 suppresses the banner (resumed sessions don't re-banner)", async () => {
      const spec = writeBannerSpec(["exhaustive by default"]);
      const result = await runCli(["run", spec], {
        cwd: tmp,
        env: { ANTHROPIC_API_KEY: "test-no-call", CREWHAUS_RESUMED: "1" },
        closeStdinImmediately: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("exhaustive by default");
      expect(result.stdout).toContain("agent ready");
    });
  });

  // Section 18 (#18 remainder) — the run path must wire the sandbox floor for
  // code-execution tools. Before this, python/javascript/shell resolved but
  // were always denied because `sandboxAvailable` was never set.
  const CODE_EXEC_SPEC =
    "name: coder\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: run code\ntools:\n  - python\n";

  test("run wires the sandbox backend for code-exec tools when CREWHAUS_SANDBOX is set", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), CODE_EXEC_SPEC);
    const result = await runCli(["run", join(tmp, "crewhaus.yaml")], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test-no-call", CREWHAUS_SANDBOX: "docker" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    // Diagnostic reflects the resolved (available) backend → sandboxAvailable:true.
    expect(result.stdout).toContain('[sandbox] backend "docker"');
    expect(result.stdout).toContain("enabled");
    expect(result.stdout).toContain("agent ready");
  });

  test("run prints the CREWHAUS_SANDBOX notice when unset and code-exec tools are declared", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), CODE_EXEC_SPEC);
    const result = await runCli(["run", join(tmp, "crewhaus.yaml")], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test-no-call" }, // CREWHAUS_SANDBOX intentionally unset
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[sandbox] assuming docker");
    expect(result.stdout).toContain("set CREWHAUS_SANDBOX");
  });

  test("run reports the sandbox floor as disabled under CREWHAUS_SANDBOX=noop", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), CODE_EXEC_SPEC);
    const result = await runCli(["run", join(tmp, "crewhaus.yaml")], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test-no-call", CREWHAUS_SANDBOX: "noop" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[sandbox] disabled");
    expect(result.stdout).toContain("will be denied");
  });

  test("run does NOT print a sandbox diagnostic when no code-exec tools are declared", async () => {
    const result = await runCli(["run", HELLO_SPEC], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("[sandbox]");
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
    // Bound to the constant, not a literal: the help text naming a stale
    // default is the exact drift this assertion exists to catch.
    expect(result.stdout).toContain(DEFAULT_JUDGE_MODEL);
    expect(result.stdout).toContain("Anthropic credentials");
  });

  // E52 — `eval history|baseline(s)|diff` forward to the eval-report verbs
  // with a one-line stderr notice; ONLY a spec FILE with the exact alias
  // name suppresses the alias (design-pinned carve-out).
  test("eval history aliases to eval-report history with the stderr notice", async () => {
    const result = await runCli(["eval", "history"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "`crewhaus eval history` is an alias for the canonical `crewhaus eval-report history`",
    );
    expect(result.stdout).toContain("no recorded runs match");
  });

  test("eval baselines (plural guess) maps to the eval-report baseline verb", async () => {
    const result = await runCli(["eval", "baselines", "show"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("`crewhaus eval-report baseline`");
    expect(result.stdout).toContain("no baselines pinned");
  });

  test("a spec FILE literally named history suppresses the alias — the run path still owns it", async () => {
    writeFileSync(
      join(tmp, "history"),
      "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n",
    );
    const result = await runCli(["eval", "history"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("is an alias");
    expect(result.stderr).toContain("missing --dataset");
  });

  test("eval history.yaml is never an alias — whole-word matches only", async () => {
    writeFileSync(
      join(tmp, "history.yaml"),
      "name: t\ntarget: cli\nagent:\n  model: claude-opus-4-7\n  instructions: hi\n",
    );
    const result = await runCli(["eval", "history.yaml"], { cwd: tmp, env: {} });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("is an alias");
    expect(result.stderr).toContain("missing --dataset");
  });

  test("a DIRECTORY named diff does not suppress the alias (file carve-out only)", async () => {
    // `eval-report diff -o diff` creates exactly this inhabitant; the alias
    // must still fire instead of dying with the misleading run-path
    // "missing --dataset".
    mkdirSync(join(tmp, "diff"));
    const result = await runCli(["eval", "diff", "runA", "runB"], { cwd: tmp, env: {} });
    expect(result.stderr).toContain("`crewhaus eval-report diff`");
    expect(result.stderr).not.toContain("missing --dataset");
    expect(result.exitCode).toBe(1); // unknown run ids — the eval-report path's own error
    expect(result.stderr).toContain("results.json not found");
  });

  test("run --help lists the --justification-judge flag", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--justification-judge");
  });

  // Loop contract 0.4 (Batch A) — --streaming flag / spec agent.streaming,
  // spec-declared hooks layered below settings.json, and the full
  // loop-contract spec key set threading through runChatLoop boot.
  test("run --streaming forces streaming on and prints the diagnostic", async () => {
    const result = await runCli(["run", HELLO_SPEC, "--streaming"], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[streaming] mid-stream tool dispatch enabled");
    expect(result.stdout).toContain("agent ready");
  });

  test("spec agent.streaming: true enables streaming without the flag", async () => {
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      "name: streamy\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: hi\n  streaming: true\n",
    );
    const result = await runCli(["run", join(tmp, "crewhaus.yaml")], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[streaming] mid-stream tool dispatch enabled");
  });

  test("no flag + no spec streaming → no [streaming] diagnostic (runtime default keeps governing)", async () => {
    const result = await runCli(["run", HELLO_SPEC], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("[streaming]");
  });

  test("spec hooks merge below settings.json hooks — the [hooks] line counts both layers", async () => {
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      "name: hooked\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: hi\nhooks:\n  - event: stop\n    command: 'true'\n",
    );
    mkdirSync(join(tmp, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(tmp, ".crewhaus", "settings.json"),
      '{ "hooks": [ { "event": "stop", "command": "true" } ] }\n',
    );
    const result = await runCli(["run", join(tmp, "crewhaus.yaml")], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[hooks] 2 loaded (1 from spec)");
  });

  test("spec hooks alone (no settings.json) still load, marked as spec-sourced", async () => {
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      "name: hooked\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: hi\nhooks:\n  - event: pre-tool\n    matcher: Bash\n    command: 'true'\n    timeout_ms: 3000\n",
    );
    const result = await runCli(["run", join(tmp, "crewhaus.yaml")], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[hooks] 1 loaded (1 from spec)");
  });

  test("the full loop-contract key set (limits/thinking/rate_limits/compaction tuning) boots cleanly", async () => {
    writeFileSync(
      join(tmp, "crewhaus.yaml"),
      [
        "name: loopy",
        "target: cli",
        "agent:",
        "  model: claude-sonnet-4-6",
        "  instructions: be helpful",
        "  thinking:",
        "    effort: low",
        "  rate_limits:",
        '    "*":',
        "      rpm: 120",
        "limits:",
        "  max_tool_iterations: 25",
        "  max_concurrent_tools: 2",
        "  context_limit: 120000",
        "  deadline_ms: 600000",
        "  turn_timeout_ms: 120000",
        "  model_call_timeout_ms: 60000",
        "  loop_detection:",
        "    window: 12",
        "    threshold: 3",
        "    escalation: warn",
        "compaction:",
        "  threshold: 0.8",
        "  snip_keep_head: 6",
        "  snip_keep_tail: 30",
        "",
      ].join("\n"),
    );
    const result = await runCli(["run", join(tmp, "crewhaus.yaml")], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test-no-call" },
      closeStdinImmediately: true,
    });
    // Boots and exits cleanly with every loop-contract option threaded into
    // runChatLoop (the runtime enforcement itself is covered by
    // runtime-core's own tests; the option-name mapping by loop-contract.test.ts).
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("agent ready");
  });

  test("run --help documents --streaming and the --budget-usd ↔ limits interplay", async () => {
    const result = await runCli(["run", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--streaming");
    expect(result.stdout).toContain("--budget-usd");
    // The interplay contract: independent bounds, first to trip governs,
    // budget gates EVERY model call (0.6.0 §7.12 — tool iterations included,
    // a mid-turn breach is the classified crewhaus_budget stop) while limits
    // bound the current turn/run.
    expect(result.stdout).toContain("limits:");
    expect(result.stdout).toContain("INDEPENDENTLY");
    expect(result.stdout).toContain("EVERY model call");
    expect(result.stdout).toContain("crewhaus_budget");
    expect(result.stdout).toContain("budget.scope: session");
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
    // Item 40 — the detect/fix surface is documented AND (see below) parseable.
    expect(result.stdout).toContain("--detect");
    expect(result.stdout).toContain("--no-probe");
    expect(result.stdout).toContain("--fix");
  });

  // Item 40 — regression guard. The detect/fix flags were documented and
  // dispatched (`if (args.flags["detect"]) …`) but NEVER registered in
  // DOCTOR_SCHEMA, so the real arg parser rejected them before dispatch:
  // `crewhaus doctor --detect` died with `unknown flag: --detect`. These spawn
  // the real CLI so the flags must survive parseFor(rest, DOCTOR_SCHEMA).
  test("--detect --no-probe parses and prints the inventory block (item 40)", async () => {
    const result = await runCli(["doctor", "--detect", "--no-probe"], { cwd: tmp, env: {} });
    expect(result.stderr).not.toContain("unknown flag");
    // Read-only inventory always exits 0.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("inventory (what's reachable right now):");
  });

  test("--fix parses and prints the mechanical fix-plan report (item 40)", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), "name: t\ntarget: cli\n");
    const result = await runCli(["doctor", "--fix"], {
      cwd: tmp,
      env: { ANTHROPIC_API_KEY: "test" },
    });
    expect(result.stderr).not.toContain("unknown flag");
    expect(result.stdout).toContain("doctor --fix:");
  });

  // FR-002 — the philosophy-alignment audit now includes a Pillar 3 sink-side
  // pass over the built-in tool map, sharing auditToolScopes with
  // `compile --strict`. All built-in outward tools ship scope:"external", so
  // the new check is green and the overall audit exits 0.
  //
  // This is the ONE spawn in this file that genuinely needs REPO_ROOT:
  // collectPhilosophyFindings() stats `join(process.cwd(), "packages", …)` and
  // `join(process.cwd(), "AGENTS.md")` with no upward walk and no fallback, so
  // from the default sandbox cwd it reports 11 findings and exits 1. (The tool
  // map is NOT why — loadToolMap() resolves static bare specifiers from the
  // CLI module, so Pillar 3 stays green from any cwd.)
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

// F2 (post-#41 fix) — `lint --fix`'s nearest-match tool-name correction must
// not silently cross a read-only/mutating capability boundary. "Reit" is
// Levenshtein-2 from BOTH the read-only built-in `Read` and the mutating
// built-in `Edit`; a plain alphabetical tie-break would previously pick one
// (Edit, alphabetically first) without the author ever consenting to a
// mutating tool being substituted for a typo. These run from the default
// sandbox cwd: loadToolMap() resolves the built-in tool packages from static
// bare specifiers in the CLI module, never from the cwd, so the real
// Read/Edit/Write entries are in the map either way.
describe("crewhaus lint --fix — cross-capability tool-name guard (item 41 fix)", () => {
  test("a typo equidistant from a read-only and a mutating tool is NOT auto-applied; prints a suggestion", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    const original =
      "name: t\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n  tools:\n    - Reit\n";
    writeFileSync(specPath, original);
    const result = await runCli(["lint", specPath, "--fix"], {
      env: { ANTHROPIC_API_KEY: "test" },
    });
    // Not auto-fixed: the spec on disk is byte-for-byte unchanged.
    expect(readFileSync(specPath, "utf-8")).toBe(original);
    // A suggestion is printed naming both candidates, not a silent rewrite.
    expect(result.stdout).toContain("suggestion:");
    expect(result.stdout).toContain("Reit");
    expect(result.stdout).toContain("Read");
    expect(result.stdout).toContain("Edit");
    expect(result.stdout).toContain("ambiguous");
    expect(result.stdout).not.toContain("fixed: tool");
  });

  test("an unambiguous tool-name typo still auto-fixes", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    // "Reed" is close to "Read" only (far from Edit/Write) — no capability
    // ambiguity, so --fix should still rewrite it in place.
    writeFileSync(
      specPath,
      "name: t\ntarget: cli\nagent:\n  model: m\n  instructions: hi\n  tools:\n    - Reed\n",
    );
    const result = await runCli(["lint", specPath, "--fix"], {
      env: { ANTHROPIC_API_KEY: "test" },
    });
    expect(result.stdout).toContain('fixed: tool "Reed" → "Read" (nearest match)');
    expect(readFileSync(specPath, "utf-8")).toContain("- Read");
    expect(readFileSync(specPath, "utf-8")).not.toContain("Reed");
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

  // Item 27 — `crewhaus run --budget-usd` (run-level spend cap). The
  // invalid-value branch dies before any model call, so it is testable
  // without credentials.
  test("run rejects --budget-usd 0 (non-positive) via die()", async () => {
    const result = await runCli(["run", HELLO_SPEC, "--budget-usd", "0"], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid --budget-usd");
  });

  test("run rejects a non-numeric --budget-usd via die()", async () => {
    const result = await runCli(["run", HELLO_SPEC, "--budget-usd", "lots"], {
      env: { ANTHROPIC_API_KEY: "test-no-call" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid --budget-usd");
  });

  // F4 — the fitness evals silently inherited the runner's retry with no
  // opt-out; `--no-retry` is now a real flag (threaded into every fitness
  // runEval call) and documented in the help text.
  test("optimize accepts --no-retry (parses past the flag; fails later on the missing graders file)", async () => {
    const dataset = join(tmp, "dataset.jsonl");
    writeFileSync(dataset, '{"id":"q1","input":"hi","expected_output":"hi"}');
    const missingGraders = join(tmp, "does-not-exist-graders.yaml");
    const result = await runCli(
      ["optimize", HELLO_SPEC, "--no-retry", "--dataset", dataset, "--graders", missingGraders],
      { env: { ANTHROPIC_API_KEY: "test-no-call" } },
    );
    expect(result.exitCode).toBe(1);
    // Pre-fix parseArgs died here with `unknown flag: --no-retry`.
    expect(result.stderr).not.toContain("unknown flag");
    expect(result.stderr).toContain("could not read");
  });

  test("optimize --help documents --no-retry", async () => {
    const result = await runCli(["optimize", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--no-retry");
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
      {
        env: {
          ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "",
          // Hermetic dataset registry: optimize PINS recovered dev samples
          // into `<specName>-regressions` by default (item 9). Back when the
          // spawn cwd was the repo root that wrote the shared checkout's
          // `.crewhaus/datasets/hello-regressions`, which every later
          // `crewhaus eval` on the hello fixture then unioned into ITS
          // dataset (observed: eval.test.ts graded 3 samples out of a
          // 2-sample dataset). The sandbox cwd closes that path too; this
          // explicit pin keeps the registry visible to the assertions below.
          CREWHAUS_DATASETS_DIR: join(tmp, "datasets"),
        },
      },
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

describe("crewhaus build-image — digest recording wiring (item 47)", () => {
  /**
   * A fake `docker` on PATH: `buildx build` succeeds; `buildx imagetools
   * inspect` is scripted per test and touches a marker file so tests can
   * assert whether a digest lookup happened at all. The push test uses the
   * inspect-FAILURE path (warning, exit 0) so the suite never mutates the
   * repo's real docker/digests.json — the successful record round-trip is
   * covered at the package seam in @crewhaus/docker-images' tests.
   */
  function installFakeDocker(dir: string, inspectExit: number): { bin: string; marker: string } {
    const bin = join(dir, "fakebin");
    const marker = join(dir, "inspect-called");
    mkdirSync(bin, { recursive: true });
    const script = [
      "#!/bin/bash",
      'if [ "$1" = "buildx" ] && [ "$2" = "build" ]; then exit 0; fi',
      'if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then',
      `  touch "${marker}"`,
      `  if [ ${inspectExit} -eq 0 ]; then echo "Digest: sha256:${"b".repeat(64)}"; fi`,
      `  exit ${inspectExit}`,
      "fi",
      "exit 1",
    ].join("\n");
    writeFileSync(join(bin, "docker"), `${script}\n`, { mode: 0o755 });
    return { bin, marker };
  }

  test("--no-record builds without touching the digests lockfile", async () => {
    const { bin, marker } = installFakeDocker(tmp, 0);
    const result = await runCli(["build-image", "cli", "--tag", "t1", "--no-record"], {
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("built crewhaus/cli:t1");
    expect(result.stdout).not.toContain("recorded");
    // stderr must carry no build-image output. Unrelated environment noise
    // (e.g. adapter-anthropic's claude-CLI-version fallback warning on
    // machines without the claude binary) is tolerated.
    expect(result.stderr).not.toContain("build-image");
    expect(result.stderr).not.toContain("digest");
    expect(existsSync(marker)).toBe(false);
  });

  // F2 regression: a local (--load) build records NOTHING — the local image
  // ID is a config digest, not a pullable registry digest — and the CLI says
  // so with an info line instead of warning or writing an unpullable pin.
  test("a local build (no --push) records nothing, skips digest inspection, and prints the info line", async () => {
    const { bin, marker } = installFakeDocker(tmp, 0);
    const result = await runCli(["build-image", "cli", "--tag", "t2"], {
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("built crewhaus/cli:t2");
    expect(result.stdout).toContain(
      "local image ID is not a registry digest — use --push to record a pullable digest",
    );
    expect(result.stdout).not.toContain("recorded sha256:");
    // stderr must carry no build-image output (environment noise tolerated —
    // see the --no-record test above).
    expect(result.stderr).not.toContain("build-image");
    expect(result.stderr).not.toContain("digest");
    // No digest lookup of any kind happened for the --load build.
    expect(existsSync(marker)).toBe(false);
  });

  test("recording is default-on for --push: a failed registry digest lookup warns but does not fail the build", async () => {
    const { bin, marker } = installFakeDocker(tmp, 1);
    const result = await runCli(["build-image", "cli", "--tag", "t3", "--push"], {
      env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("built crewhaus/cli:t3");
    expect(result.stderr).toContain("digest was not recorded");
    // The lookup went to the registry (imagetools inspect), not the local store.
    expect(existsSync(marker)).toBe(true);
  });

  test("--help documents --no-record and the pushed-digests-only contract", async () => {
    const result = await runCli(["build-image", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--no-record");
    expect(result.stdout).toContain("registry\n               manifest digest");
    expect(result.stdout).toContain("Local (--load) builds record nothing");
  });
});

// build-image and federation used to hand-roll their own argv loops, which
// swallowed unknown flags as positionals and emitted bespoke error strings.
// They now route through parseFor/BUILD_IMAGE_SCHEMA and FEDERATION_SCHEMA
// like every other subcommand.
describe("crewhaus build-image / federation — shared arg parsing", () => {
  test("build-image rejects an unknown flag instead of treating it as a positional", async () => {
    const result = await runCli(["build-image", "cli", "--tag", "t1", "--bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag: --bogus");
  });

  test("build-image reports a missing flag value in the shared wording", async () => {
    const result = await runCli(["build-image", "cli", "--tag"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('flag "--tag" requires a value');
  });

  test("build-image -h prints the same usage as --help", async () => {
    const short = await runCli(["build-image", "-h"]);
    const long = await runCli(["build-image", "--help"]);
    expect(short.exitCode).toBe(0);
    expect(short.stdout).toBe(long.stdout);
  });

  test("federation discover --help exits 0", async () => {
    const result = await runCli(["federation", "discover", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: crewhaus federation discover <deployment>");
  });

  test("federation discover without a deployment exits 1", async () => {
    const result = await runCli(["federation", "discover"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing <deployment>");
  });

  test("federation discover rejects an unknown flag", async () => {
    const result = await runCli(["federation", "discover", "peer.example", "--bogus"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown flag: --bogus");
  });
});

describe("crewhaus compile --check — flag surface (item 33)", () => {
  // The check pipeline itself (assertion selection, install/boot behind an
  // injectable runner, verdict mapping) is covered in compile-check.test.ts;
  // these pin the CLI wiring without hitting the network.
  test("--check rejects --emit-ir (nothing emitted to verify)", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--emit-ir", "--check", "-o", tmp]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--check");
    expect(result.stderr).toContain("--emit-ir");
  });

  test("compile --help documents --check", async () => {
    const result = await runCli(["compile", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--check");
    expect(result.stdout).toContain("liveness");
  });

  test("plain compile runs no verification — no verdict line without --check", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("compile --check:");
    // The dependency manifest is now part of the plain compile's emission
    // (the standalone-run fix) — only the verify steps stay --check-gated.
    expect(existsSync(join(tmp, "package.json"))).toBe(true);
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

// Item 59 (F2) — the approval gate must guard EVERY protected-env pin flip:
// `spec pin` and `deploy rollback`, not just `deploy promote`. A protected env
// with no approvals refuses AND audit-logs the refusal; a non-protected env
// stays ungated.
describe("crewhaus approval gate — all pin doors (item 59, F2)", () => {
  /** Register demo@v1 + v2 and mark `prod` protected in environments.json. */
  async function seedProtectedHarness(): Promise<void> {
    const f1 = join(tmp, "a.yaml");
    const f2 = join(tmp, "b.yaml");
    writeFileSync(f1, "target: cli\nname: demo\nagent:\n  model: m\n  instructions: One.\n");
    writeFileSync(f2, "target: cli\nname: demo\nagent:\n  model: m\n  instructions: Two.\n");
    expect((await runCli(["spec", "put", "demo", "v1", f1], { cwd: tmp })).exitCode).toBe(0);
    expect((await runCli(["spec", "put", "demo", "v2", f2], { cwd: tmp })).exitCode).toBe(0);
    mkdirSync(join(tmp, ".crewhaus"), { recursive: true });
    writeFileSync(
      join(tmp, ".crewhaus", "environments.json"),
      JSON.stringify({ environments: { prod: { requireApproval: true, minApprovals: 1 } } }),
    );
  }

  /** Read every governance_approval record from the harness audit store. */
  async function readGovernanceApprovals(): Promise<Array<Record<string, unknown>>> {
    const dir = join(tmp, ".crewhaus", "audit");
    if (!existsSync(dir)) return [];
    const log = await openAuditLog({ rootDir: dir });
    const out: Array<Record<string, unknown>> = [];
    for await (const rec of log.read()) {
      if ((rec as { kind?: string }).kind === "governance_approval") {
        out.push(rec as Record<string, unknown>);
      }
    }
    return out;
  }

  test("spec pin to a PROTECTED env refuses without approval and audit-logs the refusal", async () => {
    await seedProtectedHarness();
    const pinned = await runCli(["spec", "pin", "demo", "prod", "v2"], { cwd: tmp });
    expect(pinned.exitCode).not.toBe(0);
    expect(`${pinned.stdout}${pinned.stderr}`).toContain("blocked");
    // The refusal is audit-logged (governance_approval, satisfied:false).
    const records = await readGovernanceApprovals();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const payload = records.at(-1)?.["payload"] as Record<string, unknown>;
    expect(payload?.["satisfied"]).toBe(false);
    expect(payload?.["toEnv"]).toBe("prod");
    // The pin did NOT flip.
    const alias = await runCli(["spec", "alias", "demo", "prod"], { cwd: tmp });
    expect(alias.exitCode).not.toBe(0);
  });

  test("deploy rollback to a PROTECTED env refuses without approval and audit-logs it", async () => {
    await seedProtectedHarness();
    const rolled = await runCli(["deploy", "rollback", "demo", "prod", "v1"], { cwd: tmp });
    expect(rolled.exitCode).not.toBe(0);
    expect(`${rolled.stdout}${rolled.stderr}`).toContain("blocked");
    const records = await readGovernanceApprovals();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const payload = records.at(-1)?.["payload"] as Record<string, unknown>;
    expect(payload?.["satisfied"]).toBe(false);
    // rollback refusal recorded the exact target version.
    expect(payload?.["toVersion"]).toBe("v1");
  });

  test("spec pin to a NON-protected env stays ungated (pre-item-59 path)", async () => {
    await seedProtectedHarness();
    // `staging` is not declared protected → no gate, pin flips normally.
    const pinned = await runCli(["spec", "pin", "demo", "staging", "v2"], { cwd: tmp });
    expect(pinned.exitCode).toBe(0);
    expect(pinned.stdout).toContain("pinned demo staging → v2");
    // No governance record for an ungated flip.
    expect(await readGovernanceApprovals()).toHaveLength(0);
  });

  test("spec pin to a protected env SUCCEEDS once an approval for the version is recorded", async () => {
    await seedProtectedHarness();
    const approvalsDir = join(tmp, ".crewhaus", "approvals");
    mkdirSync(approvalsDir, { recursive: true });
    writeFileSync(
      join(approvalsDir, "demo__prod.json"),
      JSON.stringify([{ approver: "alice", ts: "2026-07-02T00:00:00Z", version: "v2" }]),
    );
    const pinned = await runCli(["spec", "pin", "demo", "prod", "v2"], { cwd: tmp });
    expect(pinned.exitCode).toBe(0);
    expect(pinned.stdout).toContain("pinned demo prod → v2");
    const alias = await runCli(["spec", "alias", "demo", "prod"], { cwd: tmp });
    expect(alias.stdout.trim()).toBe("v2");
  });
});

// Item 61 — `crewhaus channel provision|verify` wiring. Everything here is
// network-free: dry-run prints redacted calls, the slack path only writes a
// manifest file, and the no-env verify fails on env-ref resolution BEFORE
// any probe would fire.
describe("crewhaus channel provision|verify (item 61)", () => {
  test("usage lists the channel subcommand", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("channel provision <spec.yaml>");
    expect(result.stdout).toContain("channel verify <spec.yaml>");
  });

  test("unknown channel action exits 1 with the allowed set", async () => {
    const result = await runCli(["channel", "frobnicate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('channel action must be "provision" or "verify"');
  });

  test("a non-channel spec is refused", async () => {
    const result = await runCli([
      "channel",
      "provision",
      HELLO_SPEC,
      "--base-url",
      "https://bot.example.com",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires a channel-target spec");
    expect(result.stderr).toContain('"cli"');
  });

  test("provision requires --base-url", async () => {
    const result = await runCli(["channel", "provision", CHANNEL_SPEC]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing --base-url");
  });

  test("provision --dry-run prints every platform call with secrets redacted", async () => {
    const result = await runCli([
      "channel",
      "provision",
      CHANNEL_SPEC,
      "--base-url",
      "https://bot.example.com",
      "--dry-run",
      "-o",
      tmp,
    ]);
    expect(result.exitCode).toBe(0);
    // slack: manifest preview + emit-and-instruct (no --apply).
    expect(result.stdout).toContain("would write");
    expect(result.stdout).toContain('request_url: "https://bot.example.com/slack/events"');
    expect(result.stdout).toContain("app *configuration* token");
    // telegram: the exact setWebhook call, token + secret redacted.
    expect(result.stdout).toContain(
      "would POST https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook",
    );
    expect(result.stdout).toContain('"secret_token":"$TELEGRAM_SECRET_TOKEN"');
    expect(result.stdout).toContain('"url":"https://bot.example.com/telegram/events"');
    // discord: interactions endpoint PATCH + invite URL with derived bits.
    expect(result.stdout).toContain("would PATCH https://discord.com/api/v10/applications/@me");
    expect(result.stdout).toContain(
      '"interactions_endpoint_url":"https://bot.example.com/discord/events"',
    );
    expect(result.stdout).toContain("permissions=274877910016");
    // dry-run writes nothing.
    expect(existsSync(join(tmp, "slack-app-manifest.yaml"))).toBe(false);
  });

  test("provision --platform slack writes the manifest file (no network involved)", async () => {
    const result = await runCli([
      "channel",
      "provision",
      CHANNEL_SPEC,
      "--platform",
      "slack",
      "--base-url",
      "https://bot.example.com",
      "-o",
      tmp,
    ]);
    expect(result.exitCode).toBe(0);
    const manifestPath = join(tmp, "slack-app-manifest.yaml");
    expect(result.stdout).toContain(`wrote ${manifestPath}`);
    const manifest = readFileSync(manifestPath, "utf-8");
    expect(manifest).toContain('- "chat:write"');
    expect(manifest).toContain('- "reactions:read"');
    expect(manifest).toContain('- "reaction_added"');
    expect(manifest).toContain('request_url: "https://bot.example.com/slack/events"');
    // The instructions point the operator at the spec's env refs.
    expect(result.stdout).toContain("$SLACK_BOT_TOKEN");
    expect(result.stdout).toContain("$SLACK_SIGNING_SECRET");
  });

  test("verify --dry-run prints redacted probes and performs nothing", async () => {
    const result = await runCli(["channel", "verify", CHANNEL_SPEC, "--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("would POST https://slack.com/api/auth.test");
    expect(result.stdout).toContain(
      "would GET https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo",
    );
    expect(result.stdout).toContain("would GET https://discord.com/api/v10/applications/@me");
  });

  test("verify without the secret env exits 1 on env-ref checks (no probes fire)", async () => {
    const result = await runCli(["channel", "verify", CHANNEL_SPEC]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("✗");
    expect(result.stdout).toContain("$SLACK_BOT_TOKEN");
    expect(result.stdout).toContain("$TELEGRAM_BOT_TOKEN");
    expect(result.stdout).toContain("$DISCORD_BOT_TOKEN");
    expect(result.stdout).toMatch(/\d+ check\(s\), \d+ failed/);
  });

  test("--platform must be configured in the spec", async () => {
    const result = await runCli(["channel", "verify", CHANNEL_SPEC, "--platform", "matrix"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expected one of: slack, telegram, discord, all");
  });

  // Demo-driver audit: `verify` named 5 of the 8 env vars the emitted daemon
  // refuses to boot without, so fixing exactly what it listed still produced
  // a daemon that exited 2.
  test("verify names EVERY env var the daemon boots on, not just the probeable ones", async () => {
    // Bun auto-loads `<cwd>/.env` into the child's process.env, and back when
    // the spawn cwd was the repo root a developer checkout with a real
    // ANTHROPIC_API_KEY made the provider-credential check PASS — this
    // assertion read "8 check(s), 7 failed" locally while CI (no .env) stayed
    // green. The empty sandbox cwd has no `.env` to load, so that vector is
    // gone; the explicit empties stay as belt-and-braces, and they still win
    // regardless (dotenv never overrides an already-present variable, and the
    // check treats "" as unset).
    const result = await runCli(["channel", "verify", CHANNEL_SPEC], {
      env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
    });
    expect(result.exitCode).toBe(1);
    for (const name of [
      "$SLACK_BOT_TOKEN",
      "$SLACK_SIGNING_SECRET",
      "$TELEGRAM_BOT_TOKEN",
      "$TELEGRAM_SECRET_TOKEN",
      "$DISCORD_APPLICATION_ID",
      "$DISCORD_BOT_TOKEN",
      "$DISCORD_PUBLIC_KEY",
    ]) {
      expect(result.stdout).toContain(name);
    }
    // …plus the provider credential group the daemon also gates on.
    expect(result.stdout).toContain("ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
    expect(result.stdout).toContain("8 check(s), 8 failed");
  });

  // Demo-driver audit: with a token present, verify made a live auth.test, so
  // its exit code depended on the network. --offline is the deterministic
  // pre-flight; the unroutable API bases below would make any probe fail.
  test("verify --offline exits 0 on a fully-set env with no network", async () => {
    const result = await runCli(["channel", "verify", CHANNEL_SPEC, "--offline"], {
      env: {
        SLACK_API_BASE_URL: "http://127.0.0.1:1",
        TELEGRAM_API_BASE_URL: "http://127.0.0.1:1",
        DISCORD_API_BASE_URL: "http://127.0.0.1:1",
        SLACK_BOT_TOKEN: "xoxb-x",
        SLACK_SIGNING_SECRET: "x",
        TELEGRAM_BOT_TOKEN: "x",
        TELEGRAM_SECRET_TOKEN: "x",
        DISCORD_APPLICATION_ID: "x",
        DISCORD_BOT_TOKEN: "x",
        DISCORD_PUBLIC_KEY: "x",
        ANTHROPIC_API_KEY: "x",
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(offline)");
    expect(result.stdout).toContain("offline: no platform probes ran");
    expect(result.stdout).not.toContain("auth.test");
  });

  test("verify --offline and --dry-run are mutually exclusive", async () => {
    const result = await runCli(["channel", "verify", CHANNEL_SPEC, "--offline", "--dry-run"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("mutually exclusive");
  });

  // Demo-driver audit: provision wrote slack-app-manifest.yaml into the cwd
  // and only THEN validated telegram/discord env, leaving a stray file (and a
  // repo diff) behind on the abort.
  test("provision validates every platform's env BEFORE writing anything", async () => {
    const result = await runCli(
      ["channel", "provision", CHANNEL_SPEC, "--base-url", "https://bot.example.com"],
      { cwd: tmp },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("$TELEGRAM_BOT_TOKEN");
    expect(result.stderr).toContain("$DISCORD_BOT_TOKEN");
    expect(result.stderr).toContain("nothing was written or called");
    expect(existsSync(join(tmp, "slack-app-manifest.yaml"))).toBe(false);
    // The single-platform escape hatch the message names still works.
    const slackOnly = await runCli(
      [
        "channel",
        "provision",
        CHANNEL_SPEC,
        "--platform",
        "slack",
        "--base-url",
        "https://bot.example.com",
      ],
      { cwd: tmp },
    );
    expect(slackOnly.exitCode).toBe(0);
    expect(existsSync(join(tmp, "slack-app-manifest.yaml"))).toBe(true);
  });
});

// F2 (pre-merge fix) — `onchain tune`'s add-vs-replace op must be decided
// from the SAME parsed-CST existence check applySpecPatch itself uses
// (`doc.hasIn(path)` via the `yaml` package's parseDocument), not a second
// raw-text regex that can disagree with it.
describe("crewhaus onchain tune — add-vs-replace op selection (item 66, #66 F2)", () => {
  const ONCHAIN_BASE = `name: onchain-test
target: onchain
version: 1
agent:
  model: claude-sonnet-4-6
  instructions: React to treasury events.
chains:
  - id: base-mainnet
    kind: evm
    rpcUrls:
      - https://rpc.example
    finality:
      kind: confirmations
      count: 12
contracts:
  - id: treasury
    chainId: base-mainnet
    address: "0xtreasury0000000000000000000000000000smoke"
    abiRef: abi://safe
triggers:
  - kind: event
    chainId: base-mainnet
    contract: treasury
    event: Transfer
`;

  function writeHistory(): string {
    const historyPath = join(tmp, "receipts.jsonl");
    writeFileSync(
      historyPath,
      `${JSON.stringify({ ts: 1, contractId: "treasury", valueWei: "1000", status: "0x1", simulated: true })}\n`,
    );
    return historyPath;
  }

  test("spec with no transaction_policy block → op add", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, ONCHAIN_BASE);
    const historyPath = writeHistory();
    const patchPath = join(tmp, "patch.json");
    const result = await runCli([
      "onchain",
      "tune",
      specPath,
      "--history",
      historyPath,
      "-o",
      patchPath,
    ]);
    expect(result.exitCode).toBe(0);
    const patch = JSON.parse(readFileSync(patchPath, "utf-8"));
    expect(patch.op).toBe("add");
  });

  test("spec with an existing transaction_policy block → op replace", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      `${ONCHAIN_BASE}transaction_policy:\n  defaultWriteApproval: required\n  allowedContracts: []\n  simulationRequired: true\n`,
    );
    const historyPath = writeHistory();
    const patchPath = join(tmp, "patch.json");
    const result = await runCli([
      "onchain",
      "tune",
      specPath,
      "--history",
      historyPath,
      "-o",
      patchPath,
    ]);
    expect(result.exitCode).toBe(0);
    const patch = JSON.parse(readFileSync(patchPath, "utf-8"));
    expect(patch.op).toBe("replace");
  });

  test("quoted transaction_policy key — parsed-CST check agrees with applySpecPatch, unlike the old raw-text regex", async () => {
    // `/^transaction_policy:/m` (the old check) does NOT match a quoted key
    // like `"transaction_policy":`, even though it's valid YAML and the
    // parsed CST (what applySpecPatch itself uses via doc.hasIn) sees it as
    // present. The old code would have picked "add" here and the patch
    // apply would have been rejected by applySpecPatch ("path already
    // exists"). The fix must pick "replace".
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      `${ONCHAIN_BASE}"transaction_policy":\n  defaultWriteApproval: required\n  allowedContracts: []\n  simulationRequired: true\n`,
    );
    const historyPath = writeHistory();
    const patchPath = join(tmp, "patch.json");
    const result = await runCli([
      "onchain",
      "tune",
      specPath,
      "--history",
      historyPath,
      "-o",
      patchPath,
    ]);
    expect(result.exitCode).toBe(0);
    const patch = JSON.parse(readFileSync(patchPath, "utf-8"));
    expect(patch.op).toBe("replace");

    // And prove the chosen op is actually applySpecPatch-compatible: apply it
    // for real and confirm no "path already exists" / "does not exist" error.
    const { applySpecPatch } = await import("@crewhaus/spec-patch");
    const specYaml = readFileSync(specPath, "utf-8");
    expect(() =>
      applySpecPatch(specYaml, {
        target: patch.target,
        path: patch.path,
        op: patch.op,
        value: patch.value,
        rationale: patch.rationale,
      }),
    ).not.toThrow();
  });
});

// ---- Loop contract 0.4 (Batch F) — the new CLI slice ----

describe("crewhaus compile --emit-as cf-worker (item 6)", () => {
  test("emits the Cloudflare-Worker bundle for a cli spec", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp, "--emit-as", "cf-worker"]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "worker.js"))).toBe(true);
    expect(existsSync(join(tmp, "wrangler.toml"))).toBe(true);
    // The default local bundle's agent.ts is NOT produced.
    expect(existsSync(join(tmp, "agent.ts"))).toBe(false);
    expect(result.stdout).toContain("compiled cf-worker bundle");
  });

  test("rejects an unsupported target with a clear message", async () => {
    const result = await runCli(["compile", CHANNEL_SPEC, "-o", tmp, "--emit-as", "cf-worker"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cf-worker emit supports target=cli|workflow|graph");
    expect(result.stderr).toContain("got channel");
  });

  test("rejects an unknown --emit-as value", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "-o", tmp, "--emit-as", "wasm"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--emit-as must be "local" or "cf-worker"');
  });

  test("--emit-as cf-worker cannot combine with --check", async () => {
    const result = await runCli([
      "compile",
      HELLO_SPEC,
      "-o",
      tmp,
      "--emit-as",
      "cf-worker",
      "--check",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot combine with --check");
  });

  test("--emit-as local is the default bundle (byte path unchanged)", async () => {
    const result = await runCli([
      "compile",
      HELLO_SPEC,
      "-o",
      tmp,
      "--emit-as",
      "local",
      "--no-register",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "agent.ts"))).toBe(true);
    expect(existsSync(join(tmp, "worker.js"))).toBe(false);
  });
});

describe("crewhaus deploy <fly|render|railway|heroku> (item 5)", () => {
  test("scaffolds Fly manifests for a daemon shape (no token → scaffold only)", async () => {
    const out = join(tmp, "fly");
    const result = await runCli(["deploy", "fly", CHANNEL_SPEC, "-o", out]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(out, "fly.toml"))).toBe(true);
    expect(existsSync(join(out, "Dockerfile.fly"))).toBe(true);
    expect(result.stdout).toContain("set FLY_API_TOKEN and re-run with --live");
  });

  test("scaffolds Heroku manifests (heroku.yml + app.json + Dockerfile)", async () => {
    const out = join(tmp, "heroku");
    const result = await runCli(["deploy", "heroku", CHANNEL_SPEC, "-o", out]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(out, "heroku.yml"))).toBe(true);
    expect(existsSync(join(out, "app.json"))).toBe(true);
    expect(existsSync(join(out, "Dockerfile.heroku"))).toBe(true);
  });

  test("rejects a non-daemon (cli) shape", async () => {
    const result = await runCli(["deploy", "fly", HELLO_SPEC, "-o", join(tmp, "x")]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a deployable daemon shape");
  });

  test("--live without the provider token fails, naming the env var", async () => {
    const result = await runCli(["deploy", "render", CHANNEL_SPEC, "-o", join(tmp, "r"), "--live"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("RENDER_API_KEY");
    expect(result.stderr).toContain("--live");
  });

  test("an unknown deploy action is rejected", async () => {
    const result = await runCli(["deploy", "gcp", CHANNEL_SPEC]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("deploy action must be one of");
  });
});

describe("crewhaus runs resume (item 7)", () => {
  test("rejects a malformed session id", async () => {
    const result = await runCli(["runs", "resume", "not-a-session"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expected sess_<16 hex>");
  });

  test("reports when no spec can be resolved", async () => {
    const result = await runCli(["runs", "resume", "sess_0123456789abcdef"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no --spec given and no crewhaus.yaml");
  });

  test("reports when the session is not found (spec resolves)", async () => {
    writeFileSync(join(tmp, "crewhaus.yaml"), readFileSync(HELLO_SPEC, "utf-8"));
    const result = await runCli(["runs", "resume", "sess_0123456789abcdef"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no session "sess_0123456789abcdef"');
  });

  test("an unknown runs action is rejected", async () => {
    const result = await runCli(["runs", "subscribe"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('runs action must be "resume"');
  });

  test("runs resume --help prints usage", async () => {
    const result = await runCli(["runs", "resume", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Re-drives a persisted cli session");
  });
});

describe("crewhaus sessions tail (item 2)", () => {
  function seedSession(dir: string, id: string): void {
    mkdirSync(dir, { recursive: true });
    const lines = [
      {
        ts: Date.UTC(2026, 6, 17, 12, 0, 0),
        version: 1,
        kind: "user_message",
        payload: { content: "hi there" },
      },
      {
        ts: Date.UTC(2026, 6, 17, 12, 0, 1),
        version: 1,
        kind: "model_route",
        payload: { model: "x" },
      },
      {
        ts: Date.UTC(2026, 6, 17, 12, 0, 2),
        version: 1,
        kind: "assistant_message",
        payload: { content: [{ type: "text", text: "hello back" }] },
      },
    ];
    writeFileSync(join(dir, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  }

  test("--no-follow dumps a session transcript (skipping side-channel events)", async () => {
    const dir = join(tmp, ".crewhaus", "sessions");
    seedSession(dir, "sess_00000000000000aa");
    const result = await runCli(["sessions", "tail", "sess_00000000000000aa", "--no-follow"], {
      cwd: tmp,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user> hi there");
    expect(result.stdout).toContain("asst> hello back");
    // The model_route side-channel event renders nothing.
    expect(result.stdout).not.toContain("model_route");
  });

  test("with no id, tails the newest session", async () => {
    const dir = join(tmp, ".crewhaus", "sessions");
    seedSession(dir, "sess_00000000000000aa");
    const result = await runCli(["sessions", "tail", "--no-follow"], { cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("user> hi there");
  });

  test("errors when the session store is absent", async () => {
    const result = await runCli(["sessions", "tail", "--no-follow"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no session store");
  });

  test("rejects a malformed session id", async () => {
    const dir = join(tmp, ".crewhaus", "sessions");
    seedSession(dir, "sess_00000000000000aa");
    const result = await runCli(["sessions", "tail", "bogus", "--no-follow"], { cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("expected sess_<16 hex>");
  });
});

describe("crewhaus dev (item 2)", () => {
  test("--help prints usage", async () => {
    const result = await runCli(["dev", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("supervised");
    expect(result.stdout).toContain("--once");
  });

  test("fails fast on a missing spec", async () => {
    const result = await runCli(["dev", join(tmp, "nope.yaml")]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dev:");
  });

  test("fails fast on a broken spec (no child launched)", async () => {
    const broken = join(tmp, "broken.yaml");
    writeFileSync(broken, "name: x\ntarget: cli\nagent: [unclosed\n");
    const result = await runCli(["dev", broken]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dev:");
  });
});

describe("crewhaus upgrade --hoist-models — arm identity on this runtime (0.6.0 §7.9, §9.2)", () => {
  const POOLED_SPEC = [
    "name: pooled",
    "target: cli",
    "agent:",
    "  model: claude-opus-4-8",
    "  thinking: { effort: high }",
    "  instructions: Help.",
    "  model_pool:",
    "    candidates:",
    "      - { model: claude-haiku-4-5, tags: [cheap] }",
    "      - { model: claude-opus-4-8, tags: [strong], thinking: { effort: high } }",
    "    policy: learned",
    "",
  ].join("\n");
  const ARM_LINE = JSON.stringify({ v: 1, k: "hard", m: "claude-opus-4-8", r: 0.5, s: 1, l: 10 });

  function seedHarness(): { spec: string; arms: string } {
    const spec = join(tmp, "crewhaus.yaml");
    writeFileSync(spec, POOLED_SPEC);
    const routing = join(tmp, ".crewhaus", "routing");
    mkdirSync(routing, { recursive: true });
    const arms = join(routing, "arms.jsonl");
    writeFileSync(arms, `${ARM_LINE}\n`);
    return { spec, arms };
  }

  test("--rewrite-arms is REFUSED: the runtime records arms under the model string, so nothing is touched", async () => {
    const { spec, arms } = seedHarness();
    const result = await runCli(["upgrade", spec, "--hoist-models", "--write", "--rewrite-arms"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--rewrite-arms needs the profile-keyed scoreboard");
    expect(result.stderr).toContain("records pool arms under the model string");
    // Refused BEFORE any work: the spec and the arms file are byte-identical.
    expect(readFileSync(spec, "utf-8")).toBe(POOLED_SPEC);
    expect(readFileSync(arms, "utf-8")).toBe(`${ARM_LINE}\n`);
  });

  test("--rewrite-arms without --hoist-models keeps its usage error", async () => {
    const { spec } = seedHarness();
    const result = await runCli(["upgrade", spec, "--rewrite-arms"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--rewrite-arms requires --hoist-models");
  });

  test("--hoist-models --write leaves arms.jsonl alone and says the arm id stays the model string today", async () => {
    const { spec, arms } = seedHarness();
    const result = await runCli(["upgrade", spec, "--hoist-models", "--write"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hoist-models: 1 profile(s)");
    expect(result.stdout).toContain("records pool arms under the model string");
    expect(result.stdout).toContain("claude-opus-4-8 → $default (1 line(s) recorded)");
    expect(result.stdout).toContain("--rewrite-arms is refused on this runtime");
    expect(result.stdout).not.toContain("arm id becomes the profile name");
    // The spec was hoisted; the learned history was not re-keyed.
    expect(readFileSync(spec, "utf-8")).toContain("model: $default");
    expect(readFileSync(arms, "utf-8")).toBe(`${ARM_LINE}\n`);
  });
});
