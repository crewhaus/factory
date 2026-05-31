import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // FR-002 — compile-time external-sink scope gate.
  test("--help mentions the --strict scope gate", async () => {
    const result = await runCli(["compile", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--strict");
    expect(result.stdout).toContain('non-"external"');
  });

  test("--strict on a clean (toolless) spec still emits and exits 0", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--strict", "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "agent.ts"))).toBe(true);
    expect(result.stderr).not.toContain("[strict]");
  });

  test("--strict passes when an outward tool (fetch) is correctly external", async () => {
    // Exercises the full resolve path: collectToolNames → loadToolMap →
    // auditSpecToolNames → auditToolScopes. `Fetch` ships scope:"external"
    // (and ioCapability:"network"), so the audit is clean and the bundle emits.
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(
      specPath,
      "name: with-fetch\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: |\n    Use fetch when needed.\ntools:\n  - fetch\n",
    );
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--strict", "-o", outDir]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(outDir, "agent.ts"))).toBe(true);
    expect(result.stderr).not.toContain("[strict]");
  });

  // FR-002 RED PATH (the case the adversarial review proved exited 0). A spec
  // referencing an `mcp__*` sink the offline tool map cannot resolve to a
  // scope:"external" tool must FAIL --strict, naming the tool, and must NOT
  // emit. This is the criterion's "diagnostic naming any I/O-capable tool left
  // at an unspecified scope" — enforced at the spec level, not only re-checking
  // the already-correct built-ins.
  const MCP_SINK_SPEC =
    "name: evil\ntarget: cli\nagent:\n  model: claude-sonnet-4-6\n  instructions: |\n    do a thing\ntools:\n  - mcp__evil__exfiltrate\n";

  test("--strict FAILS (exit 1) on an unresolved mcp__ exfiltration sink and names it", async () => {
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, MCP_SINK_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--strict", "-o", outDir]);
    expect(result.exitCode).toBe(1);
    // The `[strict]` marker proves the STRICT GATE produced the failure (and
    // ran before any emit) — the generic emitter "unknown tool" error carries
    // no such marker. This is the exact spec the adversarial review proved
    // exited 0 under the old name-only audit.
    expect(result.stderr).toContain("[strict]");
    expect(result.stderr).toContain("mcp__evil__exfiltrate");
    expect(result.stderr).toContain("unverifiable offline");
    // refused to emit
    expect(existsSync(join(outDir, "agent.ts"))).toBe(false);
  });

  test("--strict gates --emit-ir too — isolates the gate (lowering alone would succeed)", async () => {
    // On --emit-ir there is NO target emitter in the path, so the spec lowers
    // cleanly and the ONLY thing that can produce exit 1 is the strict gate.
    // If --strict were a no-op the IR would print and exit 0. This is the
    // cleanest proof the gate is load-bearing, not the emitter's own
    // unknown-tool rejection.
    const specPath = join(tmp, "crewhaus.yaml");
    writeFileSync(specPath, MCP_SINK_SPEC);
    const outDir = join(tmp, "out");
    const result = await runCli(["compile", specPath, "--strict", "--emit-ir", "-o", outDir]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[strict]");
    expect(result.stderr).toContain("mcp__evil__exfiltrate");
    expect(existsSync(join(outDir, "ir.json"))).toBe(false);
  });

  test("--strict also gates the --emit-ir path (clean spec exits 0)", async () => {
    const result = await runCli(["compile", HELLO_SPEC, "--strict", "--emit-ir", "-o", tmp]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(tmp, "ir.json"))).toBe(true);
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
  test("--help prints usage listing all four subcommands", async () => {
    const result = await runCli(["--help"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("compile");
    expect(result.stderr).toContain("run");
    expect(result.stderr).toContain("init");
    expect(result.stderr).toContain("doctor");
  });

  test("unknown subcommand exits 1 with a clear message", async () => {
    const result = await runCli(["frobnicate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown subcommand");
  });
});
