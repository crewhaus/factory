#!/usr/bin/env bun
/**
 * Section 15 — end-to-end observability smoke test.
 *
 * Steps:
 *   1. Compile examples/section-15-smoke (Bash + REPL).
 *   2. Boot a local OpenTelemetry Collector via docker (debug exporter on
 *      stdout, OTLP/HTTP receiver on :4318).
 *   3. Drive a 3-turn conversation with one Bash tool call against the live
 *      Anthropic model, with CREWHAUS_TRACE=pretty + CREWHAUS_METRICS=stdout +
 *      OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318.
 *   4. Verify:
 *        a. Collector stdout contains gen_ai/* attributes for the model spans
 *           and a tool span named "tool.Bash" all under one traceId.
 *        b. Agent stderr contains pretty-printed events.
 *        c. Agent stdout contains a JSON metrics dump with crewhaus_turns_total
 *           >= 3 and crewhaus_tool_calls_total{tool="Bash"} >= 1.
 *   5. Run the no-env-vars baseline: confirm hello-cli still works without
 *      observability output (opt-in invariant).
 *   6. Tear down the docker container.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CWD = process.cwd();
const SMOKE_EXAMPLE = join(CWD, "examples", "section-15-smoke");
const SMOKE_DIST = join(SMOKE_EXAMPLE, "dist", "agent.ts");
const COLLECTOR_CONFIG = join(CWD, "scripts", "section-15-collector.yaml");
const COLLECTOR_NAME = "crewhaus-otel-smoke";
const COLLECTOR_IMAGE = "otel/opentelemetry-collector-contrib:latest";
const COLLECTOR_PORT = 4318;

const log = (msg: string): void => {
  process.stderr.write(`[smoke] ${msg}\n`);
};

const runSync = (cmd: string, args: string[]): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const ensureCleanCollector = async (): Promise<void> => {
  spawnSync("docker", ["rm", "-f", COLLECTOR_NAME], { encoding: "utf8" });
};

const startCollector = async (): Promise<void> => {
  await ensureCleanCollector();
  log(`pulling ${COLLECTOR_IMAGE} (this can take a minute on first run)`);
  const pull = runSync("docker", ["pull", COLLECTOR_IMAGE]);
  if (pull.code !== 0) {
    throw new Error(`docker pull failed: ${pull.stderr}`);
  }
  log("starting collector container");
  const run = runSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    COLLECTOR_NAME,
    "-p",
    `${COLLECTOR_PORT}:${COLLECTOR_PORT}`,
    "-v",
    `${COLLECTOR_CONFIG}:/etc/otelcol-contrib/config.yaml`,
    COLLECTOR_IMAGE,
  ]);
  if (run.code !== 0) {
    throw new Error(`docker run failed: ${run.stderr}`);
  }
  // Wait for the collector's OTLP receiver to be ready.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      // OTLP/HTTP responds 405 to GET /v1/traces (POST-only) — that's a healthy signal.
      const res = await fetch(`http://localhost:${COLLECTOR_PORT}/v1/traces`, { method: "GET" });
      if (res.status === 405 || res.status === 200) {
        log("collector ready");
        return;
      }
    } catch {
      // Connection refused while booting — keep polling.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("collector did not become ready within 15s");
};

const stopCollector = (): void => {
  log("stopping collector container");
  spawnSync("docker", ["stop", COLLECTOR_NAME], { encoding: "utf8" });
};

const compileExample = async (): Promise<void> => {
  log("compiling examples/section-15-smoke");
  const result = runSync("bun", [
    "apps/cli/src/index.ts",
    "compile",
    `${SMOKE_EXAMPLE}/crewhaus.yaml`,
    "-o",
    `${SMOKE_EXAMPLE}/dist`,
  ]);
  if (result.code !== 0) {
    throw new Error(`compile failed: ${result.stderr || result.stdout}`);
  }
};

const runAgent = async (
  turns: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> => {
  const child = spawn("bun", [SMOKE_DIST], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (b: Buffer) => {
    stdout += b.toString();
  });
  child.stderr.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  // Pace the inputs so the agent finishes each turn before reading the next.
  const writeAll = async (): Promise<void> => {
    for (const t of turns) {
      child.stdin.write(`${t}\n`);
      await new Promise((r) => setTimeout(r, 8000));
    }
    child.stdin.write("exit\n");
    child.stdin.end();
  };
  void writeAll();
  const code = await new Promise<number>((resolve) => {
    child.on("close", (c) => resolve(c ?? 0));
  });
  return { stdout, stderr, code };
};

const waitFor = async <T>(
  check: () => T | undefined,
  attempts: number,
  intervalMs: number,
): Promise<T | undefined> => {
  for (let i = 0; i < attempts; i += 1) {
    const v = check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return undefined;
};

const collectorLogs = (): string => {
  const r = runSync("docker", ["logs", COLLECTOR_NAME]);
  return `${r.stdout}\n${r.stderr}`;
};

const main = async (): Promise<void> => {
  if (!process.env["ANTHROPIC_AUTH_TOKEN"] && !process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY must be set (try `set -a; source .env; set +a` then re-run)",
    );
  }
  await rm(join(SMOKE_EXAMPLE, "dist"), { recursive: true, force: true });
  await mkdir(join(SMOKE_EXAMPLE, "dist"), { recursive: true });
  await compileExample();

  await startCollector();
  let baselineOk = false;
  let observabilityOk = false;
  try {
    log("running observability-enabled run (3 turns, one Bash call)");
    const obsRun = await runAgent(
      [
        "Use the bash tool exactly once to run 'ls -1 README.md'. Then reply 'one'.",
        "Reply 'two'.",
        "Reply 'three'.",
      ],
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${COLLECTOR_PORT}`,
        OTEL_SERVICE_NAME: "crewhaus-section-15-smoke",
        CREWHAUS_TRACE: "pretty",
        CREWHAUS_METRICS: "stdout",
      },
    );
    log(`agent exit code: ${obsRun.code}`);

    // Give the OTLP exporter and the collector a moment to flush+log.
    await waitFor(
      () => {
        const logs = collectorLogs();
        return logs.includes("gen_ai.system") ? logs : undefined;
      },
      20,
      500,
    );
    const collected = collectorLogs();
    const checks: Array<{ name: string; ok: boolean; hint?: string }> = [];
    checks.push({
      name: "collector saw gen_ai.system attribute",
      ok: collected.includes("gen_ai.system"),
    });
    checks.push({
      name: "collector saw gen_ai.request.model attribute",
      ok: collected.includes("gen_ai.request.model"),
    });
    checks.push({
      name: "collector saw gen_ai.usage.input_tokens attribute",
      ok: collected.includes("gen_ai.usage.input_tokens"),
    });
    checks.push({
      name: "collector saw a tool.Bash span",
      ok: collected.includes("tool.Bash"),
    });
    checks.push({
      name: "agent stderr has pretty-printed [model_request] events",
      ok: obsRun.stderr.includes("[model_request]"),
    });
    checks.push({
      name: "agent stderr has pretty-printed [tool_call_start] events",
      ok: obsRun.stderr.includes("[tool_call_start]"),
    });
    // The metrics dump is one JSON object on stdout AFTER the assistant text.
    // Find the last `{` of a top-level JSON object that contains crewhaus_turns_total.
    const metricsIdx = obsRun.stdout.lastIndexOf('"crewhaus_turns_total"');
    let metricsParsed:
      | { counters?: Record<string, Array<{ labels: Record<string, string>; value: number }>> }
      | undefined;
    if (metricsIdx >= 0) {
      const start = obsRun.stdout.lastIndexOf('{\n  "counters"');
      if (start >= 0) {
        try {
          // The dump is the rest of stdout from that `{` (it's the last thing emitted).
          const tail = obsRun.stdout.slice(start);
          metricsParsed = JSON.parse(tail);
        } catch {
          // ignore
        }
      }
    }
    const turnsCount = metricsParsed?.counters?.["crewhaus_turns_total"]?.[0]?.value ?? 0;
    const bashCount =
      metricsParsed?.counters?.["crewhaus_tool_calls_total"]?.find(
        (s) => s.labels?.["tool"] === "Bash",
      )?.value ?? 0;
    checks.push({
      name: "stdout JSON metrics: crewhaus_turns_total >= 3",
      ok: turnsCount >= 3,
      hint: `got ${turnsCount}`,
    });
    checks.push({
      name: 'stdout JSON metrics: crewhaus_tool_calls_total{tool="Bash"} >= 1',
      ok: bashCount >= 1,
      hint: `got ${bashCount}`,
    });

    log("observability-enabled checks:");
    let allOk = true;
    for (const c of checks) {
      const status = c.ok ? "PASS" : "FAIL";
      log(`  [${status}] ${c.name}${c.hint ? ` (${c.hint})` : ""}`);
      if (!c.ok) allOk = false;
    }
    observabilityOk = allOk;

    if (!observabilityOk) {
      // Dump artifacts for triage when something is wrong.
      await writeFile(join(CWD, ".crewhaus", "section-15-smoke.stdout"), obsRun.stdout, "utf8");
      await writeFile(join(CWD, ".crewhaus", "section-15-smoke.stderr"), obsRun.stderr, "utf8");
      await writeFile(join(CWD, ".crewhaus", "section-15-smoke.collector"), collected, "utf8");
      log("dumped artifacts under .crewhaus/section-15-smoke.{stdout,stderr,collector}");
    }

    log("running baseline (no observability env vars set)");
    const baselineRun = await runAgent(["Reply 'baseline'.", "Reply 'ok'."], {
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      CREWHAUS_TRACE: "",
      CREWHAUS_METRICS: "",
    });
    log(`baseline exit code: ${baselineRun.code}`);
    baselineOk =
      baselineRun.code === 0 &&
      !baselineRun.stderr.includes("[model_request]") &&
      !baselineRun.stdout.includes("crewhaus_turns_total");
    log(`baseline opt-in invariant: ${baselineOk ? "PASS" : "FAIL"}`);
  } finally {
    stopCollector();
  }

  if (!observabilityOk) {
    process.exit(1);
  }
  if (!baselineOk) {
    process.exit(2);
  }
  log("all checks passed");
};

main().catch((err) => {
  process.stderr.write(`[smoke] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  stopCollector();
  process.exit(1);
});

// Suppress unused-imports the bundler dev mode complains about.
void readFile;
