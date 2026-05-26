import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@crewhaus/compiler";
import { type SpawnOptions, type Subprocess, spawn } from "bun";
import { type RuntimeSmokeResult, runtimeSmokeIsEnabled } from "./runtime.js";

/**
 * Service-backed runtime smoke for the compile-only target shapes
 * (batch, channel, onchain, voice). These shapes are not runnable via
 * `crewhaus run` — the run dispatcher rejects them — so the harness
 * compiles each fixture to a temp dir and spawns the emitted entry
 * point directly.
 *
 * Coverage today:
 *   - `runBatchRuntimeSmoke`  — FULLY IMPLEMENTED. The in-memory queue
 *     + seed jobs in the fixture mean the daemon self-terminates after
 *     drain, so the test just spawns + waits + asserts on stdout
 *     events. Needs only ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY.
 *   - `runChannelRuntimeSmoke`, `runOnchainRuntimeSmoke`,
 *     `runVoiceRuntimeSmoke` — SCAFFOLDED. Each function compiles the
 *     fixture, gates on its specific env vars, and returns
 *     `status: "skipped"` with a detailed reason that points at the
 *     activation plan. Activation requires real external services
 *     (Slack workspace, EVM RPC + wallet, OpenAI Realtime API key) —
 *     see RUNTIME-ACTIVATION.md.
 *
 * Shared structure: every smoke uses the same compile → spawn → parse
 * → assert pattern, with `CREWHAUS_SESSION_DIR` set so the runtime's
 * .jsonl event log is reachable after exit.
 */

const RUNTIME_FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "runtime-fixtures");
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DEFAULT_TIMEOUT_MS = 120_000;

/** Compile a runtime fixture YAML to a fresh temp dir and return its path. */
function compileFixtureToDisk(shape: string): string {
  const yaml = readFileSync(join(RUNTIME_FIXTURES_DIR, `${shape}.yaml`), "utf-8");
  const bundle = compile(yaml);
  const outDir = mkdtempSync(join(tmpdir(), `crewhaus-runtime-${shape}-bundle-`));
  for (const f of bundle.files) {
    writeFileSync(join(outDir, f.path), f.content);
  }
  return outDir;
}

/** Build the env block forwarded to spawned bundles. Anthropic auth + any extras. */
function forwardAuthEnv(extras: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "" };
  const oauth = process.env["ANTHROPIC_AUTH_TOKEN"];
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (oauth !== undefined && oauth !== "") env["ANTHROPIC_AUTH_TOKEN"] = oauth;
  if (apiKey !== undefined && apiKey !== "") env["ANTHROPIC_API_KEY"] = apiKey;
  for (const [k, v] of Object.entries(extras)) {
    if (v !== undefined && v !== "") env[k] = v;
  }
  return env;
}

/** Parse a stream of newline-delimited JSON events out of a string blob. */
function parseJsonlEvents(blob: string): Array<{ kind: string; [k: string]: unknown }> {
  const out: Array<{ kind: string; [k: string]: unknown }> = [];
  for (const raw of blob.split("\n")) {
    if (raw.length === 0) continue;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.kind === "string") out.push(obj);
    } catch {
      // ignore non-JSON lines (the bundle may also print plain text)
    }
  }
  return out;
}

async function captureSubprocess(
  proc: Subprocess<"ignore", "pipe", "pipe">,
  timeoutMs: number,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// batch — runnable today
// ---------------------------------------------------------------------------

/**
 * Batch runtime smoke. Compiles `runtime-fixtures/batch.yaml` (in-memory
 * queue + 2 seed jobs), spawns the emitted `agent.ts` worker, and lets
 * it self-terminate after draining. Asserts on the stdout event stream
 * (worker_start → job_start × 2 → worker_stop). Each job invokes the
 * model once, so this test needs ANTHROPIC_* credentials.
 */
export async function runBatchRuntimeSmoke(
  opts: { timeoutMs?: number } = {},
): Promise<RuntimeSmokeResult> {
  if (!runtimeSmokeIsEnabled()) {
    return {
      shape: "batch",
      status: "skipped",
      failures: [],
      skipReason: "neither ANTHROPIC_AUTH_TOKEN nor a real ANTHROPIC_API_KEY is set",
    };
  }

  const bundleDir = compileFixtureToDisk("batch");
  const sessionDir = mkdtempSync(join(tmpdir(), "crewhaus-runtime-batch-session-"));
  try {
    const env = forwardAuthEnv({ CREWHAUS_SESSION_DIR: sessionDir });
    const spawnOpts: SpawnOptions.OptionsObject<"ignore", "pipe", "pipe"> = {
      cwd: REPO_ROOT,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    };
    const proc = spawn([process.execPath, join(bundleDir, "agent.ts")], spawnOpts);
    const { stdout, stderr, exitCode } = await captureSubprocess(
      proc,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const failures: string[] = [];
    if (exitCode !== 0) failures.push(`batch worker exited non-zero (${exitCode})`);

    const events = parseJsonlEvents(stdout);
    const kinds = events.map((e) => e.kind);
    if (!kinds.includes("worker_start")) failures.push(`expected "worker_start" in event stream`);
    if (!kinds.includes("worker_stop")) failures.push(`expected "worker_stop" in event stream`);
    const jobStarts = events.filter((e) => e.kind === "job_start").length;
    if (jobStarts !== 2) {
      failures.push(`expected 2 job_start events (one per seed job), got ${jobStarts}`);
    }
    const jobEnds = events.filter((e) => e.kind === "job_end").length;
    if (jobEnds !== 2) {
      failures.push(`expected 2 job_end events, got ${jobEnds}`);
    }
    if (!stdout.includes("smoke-batch-ok")) {
      failures.push(
        "agent output does not contain the magic token 'smoke-batch-ok' — model output didn't ground in fixture instructions",
      );
    }

    return {
      shape: "batch",
      status: failures.length === 0 ? "ok" : "failed",
      failures,
      stdout,
      stderr,
      events: events.map((e) => ({ kind: e.kind, payload: e })),
    };
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// channel — scaffolded; activation needs a Slack workspace OR a full
// mock harness (signature-correct webhook + chat.postMessage stub).
// ---------------------------------------------------------------------------

/**
 * Channel runtime smoke (Slack). Scaffold only: gates on Slack tokens
 * and never completes the inbound-webhook flow. See RUNTIME-ACTIVATION.md
 * for the work needed to activate (HMAC-signed synthetic webhook, mock
 * chat.postMessage endpoint, daemon teardown semantics).
 */
export async function runChannelRuntimeSmoke(
  opts: { timeoutMs?: number } = {},
): Promise<RuntimeSmokeResult> {
  void opts;
  if (!runtimeSmokeIsEnabled()) {
    return {
      shape: "channel",
      status: "skipped",
      failures: [],
      skipReason: "neither ANTHROPIC_AUTH_TOKEN nor a real ANTHROPIC_API_KEY is set",
    };
  }
  const slackToken = process.env["SMOKE_SLACK_BOT_TOKEN"];
  const slackSecret = process.env["SMOKE_SLACK_SIGNING_SECRET"];
  if (
    slackToken === undefined ||
    slackToken === "" ||
    slackSecret === undefined ||
    slackSecret === ""
  ) {
    return {
      shape: "channel",
      status: "skipped",
      failures: [],
      skipReason:
        "channel runtime smoke needs SMOKE_SLACK_BOT_TOKEN + SMOKE_SLACK_SIGNING_SECRET; see packages/smoke-harness/RUNTIME-ACTIVATION.md for full activation requirements",
    };
  }
  return {
    shape: "channel",
    status: "skipped",
    failures: [],
    skipReason:
      "channel runtime smoke scaffold present; the inbound-webhook driver + chat.postMessage mock are unimplemented (see RUNTIME-ACTIVATION.md)",
  };
}

// ---------------------------------------------------------------------------
// onchain — scaffolded; activation needs an EVM RPC (local anvil or
// a real testnet) plus a transaction that fires the configured trigger.
// ---------------------------------------------------------------------------

/**
 * Onchain runtime smoke. Scaffold only: gates on chain RPC. Activation
 * requires either a local anvil node with a deployed test contract or a
 * funded testnet wallet that can fire a Transfer event during the test
 * window. See RUNTIME-ACTIVATION.md.
 */
export async function runOnchainRuntimeSmoke(
  opts: { timeoutMs?: number } = {},
): Promise<RuntimeSmokeResult> {
  void opts;
  if (!runtimeSmokeIsEnabled()) {
    return {
      shape: "onchain",
      status: "skipped",
      failures: [],
      skipReason: "neither ANTHROPIC_AUTH_TOKEN nor a real ANTHROPIC_API_KEY is set",
    };
  }
  const rpc = process.env["SMOKE_ONCHAIN_RPC"];
  if (rpc === undefined || rpc === "") {
    return {
      shape: "onchain",
      status: "skipped",
      failures: [],
      skipReason:
        "onchain runtime smoke needs SMOKE_ONCHAIN_RPC (anvil URL or testnet RPC); see packages/smoke-harness/RUNTIME-ACTIVATION.md",
    };
  }
  return {
    shape: "onchain",
    status: "skipped",
    failures: [],
    skipReason:
      "onchain runtime smoke scaffold present; the trigger-event fire path (anvil deploy or testnet tx) is unimplemented (see RUNTIME-ACTIVATION.md)",
  };
}

// ---------------------------------------------------------------------------
// voice — scaffolded; activation needs an OpenAI Realtime API key plus
// a recorded PCM clip the daemon can feed through the realtime loop.
// ---------------------------------------------------------------------------

/**
 * Voice runtime smoke (OpenAI Realtime). Scaffold only: gates on
 * OPENAI_API_KEY (or SMOKE_OPENAI_API_KEY override). Activation requires
 * a PCM audio fixture and a way to capture the realtime adapter's
 * response stream; see RUNTIME-ACTIVATION.md.
 */
export async function runVoiceRuntimeSmoke(
  opts: { timeoutMs?: number } = {},
): Promise<RuntimeSmokeResult> {
  void opts;
  if (!runtimeSmokeIsEnabled()) {
    return {
      shape: "voice",
      status: "skipped",
      failures: [],
      skipReason: "neither ANTHROPIC_AUTH_TOKEN nor a real ANTHROPIC_API_KEY is set",
    };
  }
  const openaiKey = process.env["SMOKE_OPENAI_API_KEY"] ?? process.env["OPENAI_API_KEY"];
  if (openaiKey === undefined || openaiKey === "") {
    return {
      shape: "voice",
      status: "skipped",
      failures: [],
      skipReason:
        "voice runtime smoke needs SMOKE_OPENAI_API_KEY or OPENAI_API_KEY; see packages/smoke-harness/RUNTIME-ACTIVATION.md",
    };
  }
  return {
    shape: "voice",
    status: "skipped",
    failures: [],
    skipReason:
      "voice runtime smoke scaffold present; the PCM fixture + realtime response capture are unimplemented (see RUNTIME-ACTIVATION.md)",
  };
}
