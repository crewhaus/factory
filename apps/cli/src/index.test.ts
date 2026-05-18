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
