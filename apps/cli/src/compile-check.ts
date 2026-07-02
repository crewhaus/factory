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
 *   2. install — `bun install` in the out-dir. When the emitter didn't
 *      produce a package.json (only the cf-worker shapes do), a minimal one
 *      is synthesized from the bundle's @crewhaus imports; versions resolve
 *      to the published packages a released CLI emits against.
 *   3. boot — spawn the bundle's entrypoint once, CREDENTIAL-FREE (env
 *      scrubbed to PATH/HOME), with `doctor --liveness` semantics: booting
 *      far enough to reach the shape's own credential/input gate IS the
 *      signal (see BOOT_GATE_PATTERNS — derived empirically by booting
 *      every fixture bundle key-less). Scrubbing is deliberate: with real
 *      credentials in the env, autonomous shapes (workflow, batch, …)
 *      would EXECUTE their agent on boot — paid model calls from a compile
 *      flag. Shapes whose boot needs live credentials/servers therefore
 *      degrade to "gated" (green) and the verdict reports which step ran;
 *      a structural break (SyntaxError, unresolved import) matches no gate
 *      and stays red.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bundle } from "@crewhaus/ir";
import {
  SHAPE_ASSERTIONS,
  type ShapeAssertion,
  assertBundleAgainstShape,
  assertionForTarget,
} from "@crewhaus/smoke-harness";

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

/** Collect the @crewhaus/* packages the emitted bundle imports (sorted, deduped). */
export function collectCrewhausDeps(files: Bundle["files"]): readonly string[] {
  const deps = new Set<string>();
  const re = /["'](@crewhaus\/[a-z0-9-]+)["']/g;
  for (const file of files) {
    if (!file.path.endsWith(".ts") && !file.path.endsWith(".js")) continue;
    for (const m of file.content.matchAll(re)) {
      const dep = m[1];
      if (dep !== undefined) deps.add(dep);
    }
  }
  return [...deps].sort();
}

/**
 * Minimal manifest for bundles whose emitter ships no package.json.
 * Versions are "latest": the check installs the PUBLISHED packages — the
 * contract a released CLI's bundles run against. (In a dev checkout that
 * can lag unreleased emitter features; the boot step then reports the
 * mismatch, which is a real signal, not a false positive.)
 */
export function buildBundlePackageJson(deps: readonly string[]): string {
  const dependencies: Record<string, string> = {};
  for (const dep of deps) dependencies[dep] = "latest";
  return `${JSON.stringify(
    { name: "crewhaus-compiled-bundle", private: true, type: "module", dependencies },
    null,
    2,
  )}\n`;
}

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
 */
export const BOOT_GATE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly gate: string;
}> = [
  // runtime-core resolveAuth / provider adapters (cli, workflow, graph, …).
  { pattern: /no Anthropic credentials found|ProviderAuthError/, gate: "provider credentials" },
  // Env-ref rewriting: `process.env["X"] ?? throw` (channel secrets, onchain RPC).
  { pattern: /missing required env var/, gate: "spec env refs" },
  // crew daemon reads its kickoff input from stdin.
  { pattern: /no input on stdin/, gate: "stdin input" },
  // voice daemon's v0 headless smoke path.
  { pattern: /no --smoke/, gate: "a --smoke pcm fixture" },
  // browser driver needs a prompt to open a session.
  { pattern: /no prompt \(pass --prompt/, gate: "an initial --prompt" },
  // eval bundle resolves its dataset from the local registry.
  { pattern: /dataset "[^"]*" not found/, gate: "a registered eval dataset" },
];

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
  for (const { pattern, gate } of BOOT_GATE_PATTERNS) {
    if (pattern.test(result.stderr)) {
      return {
        status: "gated",
        detail: `boot reached its ${gate} gate — full boot needs live ${gate}`,
      };
    }
  }
  const tail = result.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
  return { status: "failed", detail: `boot exited ${result.exitCode}: ${tail}` };
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
  /** Base env the scrubbed boot env (PATH/HOME) is drawn from. */
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

  // 2 — install the bundle's deps in the out-dir.
  if (!opts.bundle.files.some((f) => f.path === "package.json")) {
    writeFileSync(
      join(opts.outDir, "package.json"),
      buildBundlePackageJson(collectCrewhausDeps(opts.bundle.files)),
    );
  }
  const install = await runner({ argv: ["bun", "install"], cwd: opts.outDir });
  const installOk = !install.timedOut && install.exitCode === 0;
  steps.push(
    installOk
      ? { step: "install", status: "ok" }
      : {
          step: "install",
          status: "failed",
          detail: `bun install exited ${install.exitCode}: ${install.stderr
            .trim()
            .split("\n")
            .slice(-2)
            .join(" | ")
            .slice(0, 300)}`,
        },
  );

  // 3 — liveness boot (credential-free by design; see module doc).
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
    const baseEnv = opts.env ?? process.env;
    const boot = await runner({
      argv: ["bun", entry],
      cwd: opts.outDir,
      env: { PATH: baseEnv["PATH"] ?? "", HOME: baseEnv["HOME"] ?? "" },
      timeoutMs: opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS,
    });
    const outcome = classifyBootOutcome(boot);
    steps.push({ step: "boot", status: outcome.status, detail: outcome.detail });
  }

  return { ...buildVerdict(steps), steps };
}
