/**
 * Item 33 — `crewhaus compile --check` core (shape assertion → dep install →
 * liveness boot), in a side-effect-free module so it is unit-testable (the
 * CLI entry file runs an argv switch on import). The compile path calls
 * `runCompileCheck()` after writing the bundle; every subprocess goes
 * through the injectable `CheckStepRunner` so tests never hit the network.
 *
 * The three steps, in degradation order:
 *   1. assertion — the target shape's `ShapeAssertion` from
 *      @crewhaus/smoke-harness applied generically (fixture-only anchors
 *      skipped). Offline + deterministic; skipped only when the target
 *      ships no assertion.
 *   2. install — `bun install` in the out-dir (bounded by a 120s timeout so
 *      a hung registry cannot hang the compile forever). The compile path
 *      already wrote the synthesized pin-to-CLI-version manifest beside the
 *      bundle (see bundle-manifest.ts); this step re-ensures it — covering
 *      direct runCompileCheck callers — and then installs against whatever
 *      package.json is on disk (a user-authored one is never clobbered).
 *   3. boot — spawn the bundle's entrypoint once, CREDENTIAL-FREE (env
 *      scrubbed to PATH/HOME + the credential-free proxy/CA vars), with
 *      `doctor --liveness` semantics: booting far enough to reach the
 *      shape's own credential/input gate IS the signal (see
 *      BOOT_GATE_PATTERNS — derived empirically by booting every fixture
 *      bundle key-less). Scrubbing is deliberate: with real credentials in
 *      the env, autonomous shapes (workflow, batch, …) would EXECUTE their
 *      agent on boot — paid model calls from a compile flag. Bun would
 *      quietly defeat that scrub by auto-loading a `.env` colocated with
 *      the bundle, so the boot passes `--env-file=<empty file>` to disable
 *      the auto-load (see bootArgvFor). Shapes whose boot needs live
 *      credentials/servers therefore degrade to "gated" (green) and the
 *      verdict reports which step ran; a structural break (SyntaxError,
 *      unresolved import) matches no gate and stays red.
 *
 * Because the scrub is unconditional there is deliberately no `--allow-env`
 * escape hatch: handing the boot real credentials is precisely what would
 * let an autonomous shape execute a paid agent run from a verification flag.
 * The contract is instead that EVERY declared-credential gate is a known
 * gate — so a structurally-correct spec is green whatever it declares, and
 * "gated" (exit 0) vs "failed" (exit 1) is the distinction a caller reads.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bundle } from "@crewhaus/ir";
import {
  SHAPE_ASSERTIONS,
  type ShapeAssertion,
  assertBundleAgainstShape,
  assertionForTarget,
} from "@crewhaus/smoke-harness";
import { ensureBundleManifest } from "./bundle-manifest";

export type CheckStepName = "assertion" | "install" | "boot";
export type CheckStepStatus = "ok" | "gated" | "skipped" | "failed";
export type CheckStep = {
  readonly step: CheckStepName;
  readonly status: CheckStepStatus;
  readonly detail?: string;
};

export type CheckRunResult = {
  readonly exitCode: number;
  /** True when the liveness window elapsed and we killed the process (daemons). */
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

export type CheckStepRunner = (opts: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}) => Promise<CheckRunResult>;

const DEFAULT_BOOT_TIMEOUT_MS = 10_000;
// A hung registry must not hang `compile --check` forever — the install step
// is bounded (override via CompileCheckOptions.installTimeoutMs).
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

/**
 * Env vars copied through the credential scrub. PATH/HOME are needed to find
 * bun and its caches; the proxy/CA vars carry no credentials but are required
 * for `bun install` (and any gated boot probe) to reach the network at all in
 * proxied/corporate environments.
 */
const SCRUB_PASSTHROUGH_VARS = [
  "PATH",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;

/** Credential-free child env: only {@link SCRUB_PASSTHROUGH_VARS} survive. */
export function scrubbedEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of SCRUB_PASSTHROUGH_VARS) {
    const value = baseEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Lazily-created empty env file for `bun --env-file=…`. Without the flag Bun
 * AUTO-LOADS `.env` from the child's cwd — the out-dir — so a colocated .env
 * with real keys would silently defeat the credential scrub and let an
 * autonomous shape execute paid agent runs from a verification flag. An
 * explicit `--env-file` replaces the auto-load entirely (verified on Bun
 * 1.3.14: the child sees none of the .env's vars). An empty temp file is
 * used rather than /dev/null so the flag also works on Windows.
 */
let cachedEmptyEnvFile: string | undefined;
export function emptyEnvFile(): string {
  if (cachedEmptyEnvFile === undefined) {
    const path = join(mkdtempSync(join(tmpdir(), "crewhaus-check-env-")), "empty.env");
    writeFileSync(path, "");
    cachedEmptyEnvFile = path;
  }
  return cachedEmptyEnvFile;
}

/**
 * The exact argv `compile --check` boots a bundle entrypoint with. Exported
 * so the F4 regression tests exercise the REAL construction (flag presence
 * with an injected runner, and .env invisibility with a live subprocess).
 */
export function bootArgvFor(entry: string): readonly string[] {
  return ["bun", `--env-file=${emptyEnvFile()}`, entry];
}

// The manifest helpers moved to ./bundle-manifest (the compile path now
// writes the same synthesized package.json this check installs against);
// re-exported here so existing importers keep working.
export { buildBundlePackageJson, collectCrewhausDeps } from "./bundle-manifest";

/** daemon.ts (daemon shapes) beats agent.ts; undefined = nothing bootable here. */
export function resolveBootEntry(files: Bundle["files"]): string | undefined {
  const paths = new Set(files.map((f) => f.path));
  if (paths.has("daemon.ts")) return "daemon.ts";
  if (paths.has("agent.ts")) return "agent.ts";
  return undefined;
}

/**
 * Known first-boot gates: the message a shape prints when it boots far
 * enough to demand its live inputs. Reaching a gate is the liveness signal
 * (`doctor --liveness` semantics — "booting far enough to parse argv IS the
 * signal"). Derived empirically from booting every fixture bundle with a
 * scrubbed env; keep patterns narrow so structural breakage stays red.
 *
 * Each entry carries TWO phrasings because the verdict line uses the gate in
 * two grammatical positions (item 16): `gate` is a bare noun label that reads
 * after a possessive ("its <gate> gate"), `needs` is the full noun phrase,
 * article and all, that reads after "needs" ("full boot needs <needs>"). One
 * shared string cannot be both — "its a registered eval dataset gate" was the
 * on-camera symptom.
 */
export const BOOT_GATE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  /** Short label, no leading article — reads as "its <gate> gate". */
  readonly gate: string;
  /** Full phrase with its article — reads as "full boot needs <needs>". */
  readonly needs: string;
}> = [
  // runtime-core resolveAuth / provider adapters (cli, workflow, graph, …).
  {
    pattern: /no Anthropic credentials found|ProviderAuthError/,
    gate: "provider credentials",
    needs: "live provider credentials",
  },
  // Env-ref rewriting: `process.env["X"] ?? throw` (channel secrets, onchain RPC).
  {
    pattern: /missing required env var/,
    gate: "spec env refs",
    needs: "the env vars the spec declares",
  },
  // MCP secret refs: @crewhaus/mcp-host resolves every declared server
  // secret at boot — BEFORE any transport connects — and throws a ConfigError
  // naming the variable and the server when one is unset. The check boots
  // credential-free BY DESIGN (see module doc), so a spec that declares an
  // MCP env ref could otherwise never be green: this is a credential gate in
  // exactly the sense provider credentials are, not a structural break.
  {
    pattern: /environment variable \S+ is not set/,
    gate: "MCP server credentials",
    needs: "the MCP server credentials the spec declares",
  },
  // crew daemon reads its kickoff input from stdin.
  { pattern: /no input on stdin/, gate: "stdin input", needs: "input on stdin" },
  // voice daemon's v0 headless smoke path.
  { pattern: /no --smoke/, gate: "--smoke fixture", needs: "a --smoke pcm fixture" },
  // browser driver needs a prompt to open a session.
  { pattern: /no prompt \(pass --prompt/, gate: "--prompt", needs: "an initial --prompt" },
  // eval bundle resolves its dataset from the local registry.
  {
    pattern: /dataset "[^"]*" not found/,
    gate: "eval dataset",
    needs: "a registered eval dataset",
  },
];

/**
 * The one line of a failed boot's stderr that actually NAMES the failure.
 *
 * Bun prints a thrown error as: source excerpt, then the `Name: message`
 * header, then the stack, then its own version banner. A naive last-N-lines
 * tail therefore reports "at agent.ts:22:28 | | Bun v1.3.14" and drops the
 * message entirely — the exact reason a real boot break used to be
 * unreadable. Prefer the error header when one is present; otherwise fall
 * back to the tail (runtimes that print a bare message and exit).
 */
const ERROR_HEADER = /^(?:[A-Z][A-Za-z0-9_]*(?:Error|Exception)\b.*|error:.*)$/;

export function describeBootFailure(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const header = lines.find((l) => ERROR_HEADER.test(l));
  return (header ?? lines.slice(-3).join(" | ")).slice(0, 400);
}

export function classifyBootOutcome(result: CheckRunResult): {
  status: "ok" | "gated" | "failed";
  detail: string;
} {
  if (result.timedOut) {
    return { status: "ok", detail: "daemon stayed alive for the liveness window" };
  }
  if (result.exitCode === 0) {
    return { status: "ok", detail: "booted and exited cleanly" };
  }
  // Gates are matched against BOTH streams: most shapes print their gate to
  // stderr, but nothing guarantees it — a stdout-printed gate must not be
  // misclassified as a structural failure.
  const output = `${result.stdout}\n${result.stderr}`;
  for (const { pattern, gate, needs } of BOOT_GATE_PATTERNS) {
    if (pattern.test(output)) {
      return {
        status: "gated",
        detail: `boot reached its ${gate} gate — full boot needs ${needs}`,
      };
    }
  }
  return {
    status: "failed",
    detail: `boot exited ${result.exitCode}: ${describeBootFailure(result.stderr)}`,
  };
}

/** Fold the steps into the single green/red verdict line. Only "failed" is red. */
export function buildVerdict(steps: readonly CheckStep[]): { green: boolean; line: string } {
  const green = steps.every((s) => s.status !== "failed");
  const parts = steps.map(
    (s) => `${s.step} ${s.status}${s.detail !== undefined ? ` (${s.detail})` : ""}`,
  );
  return { green, line: `compile --check: ${green ? "GREEN" : "RED"} — ${parts.join("; ")}` };
}

export const defaultCheckRunner: CheckStepRunner = async ({ argv, cwd, env, timeoutMs }) => {
  const head = argv[0] ?? "bun";
  const proc = Bun.spawn([head, ...argv.slice(1)], {
    cwd,
    env: env ?? { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer =
    timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, timeoutMs)
      : undefined;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return { exitCode, timedOut, stdout, stderr };
};

export type CompileCheckOptions = {
  readonly target: string;
  readonly bundle: Bundle;
  /** Absolute out-dir the bundle was just written to. */
  readonly outDir: string;
  /** Test seam — defaults to the shipped SHAPE_ASSERTIONS. */
  readonly assertions?: readonly ShapeAssertion[];
  /** Test seam — defaults to a real Bun.spawn runner. */
  readonly runner?: CheckStepRunner;
  readonly bootTimeoutMs?: number;
  /** Upper bound for the `bun install` step (default 120s) — see F5a. */
  readonly installTimeoutMs?: number;
  /** Base env the scrubbed child env (PATH/HOME + proxy/CA vars) is drawn from. */
  readonly env?: NodeJS.ProcessEnv;
};

export type CompileCheckResult = {
  readonly green: boolean;
  readonly line: string;
  readonly steps: readonly CheckStep[];
};

export async function runCompileCheck(opts: CompileCheckOptions): Promise<CompileCheckResult> {
  const runner = opts.runner ?? defaultCheckRunner;
  const steps: CheckStep[] = [];

  // 1 — shape assertion (offline, deterministic).
  const assertion = assertionForTarget(opts.target, opts.assertions ?? SHAPE_ASSERTIONS);
  if (assertion === undefined) {
    steps.push({
      step: "assertion",
      status: "skipped",
      detail: `no smoke assertion for target "${opts.target}"`,
    });
  } else {
    const failures = assertBundleAgainstShape(assertion, opts.bundle);
    const applied = assertion.anchors.filter((a) => a.fixtureOnly !== true).length;
    steps.push(
      failures.length === 0
        ? { step: "assertion", status: "ok", detail: `${applied} anchors` }
        : { step: "assertion", status: "failed", detail: failures.join("; ") },
    );
  }

  // 2 — install the bundle's deps in the out-dir. Scrubbed env (proxy/CA
  // vars pass through — bun needs them to reach the registry) + a timeout so
  // a hung registry cannot hang the compile forever.
  const baseEnv = opts.env ?? process.env;
  const childEnv = scrubbedEnv(baseEnv);
  // The compile path already ensured a manifest; this re-ensure covers direct
  // runCompileCheck callers and — unlike the old unconditional write — never
  // clobbers a user-authored package.json in the out-dir.
  ensureBundleManifest(opts.bundle.files, opts.outDir);
  const installTimeoutMs = opts.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const install = await runner({
    argv: ["bun", "install"],
    cwd: opts.outDir,
    env: childEnv,
    timeoutMs: installTimeoutMs,
  });
  const installOk = !install.timedOut && install.exitCode === 0;
  steps.push(
    installOk
      ? { step: "install", status: "ok" }
      : {
          step: "install",
          status: "failed",
          detail: install.timedOut
            ? `bun install timed out after ${installTimeoutMs}ms (registry unreachable/hung?)`
            : `bun install exited ${install.exitCode}: ${install.stderr
                .trim()
                .split("\n")
                .slice(-2)
                .join(" | ")
                .slice(0, 300)}`,
        },
  );

  // 3 — liveness boot (credential-free by design; see module doc). The
  // --env-file flag in bootArgvFor keeps Bun from auto-loading a `.env`
  // colocated with the bundle, which would defeat the scrub.
  const entry = resolveBootEntry(opts.bundle.files);
  if (entry === undefined) {
    steps.push({
      step: "boot",
      status: "skipped",
      detail: "no agent.ts/daemon.ts entrypoint (bundle boots via its own tooling)",
    });
  } else if (!installOk) {
    steps.push({ step: "boot", status: "skipped", detail: "install failed" });
  } else {
    const boot = await runner({
      argv: bootArgvFor(entry),
      cwd: opts.outDir,
      env: childEnv,
      timeoutMs: opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
    });
    const outcome = classifyBootOutcome(boot);
    steps.push({ step: "boot", status: outcome.status, detail: outcome.detail });
  }

  return { ...buildVerdict(steps), steps };
}
