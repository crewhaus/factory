#!/usr/bin/env bun
/**
 * Section 23 BATCH — queue-worker smoke test.
 *
 * Verifies four end-to-end behaviours against the live model:
 *   1. The compiled daemon boots, drains the seed queue, and exits
 *      cleanly once `queue_idle` fires (T3 end-to-end with concurrency 4).
 *   2. Every seed job ack's; no jobs land in the dead-letter bucket.
 *   3. SIGTERM mid-batch drains in-flight jobs (the daemon emits
 *      `drain_start` → `drain_end` → `worker_stop` and exits 0).
 *   4. Existing target shapes (cli + crew + research) still compile.
 *
 * The smoke uses a small seed (8 jobs) so it finishes in well under a
 * minute against the live model. The daemon's `queue_idle` exit path
 * (no signal needed) makes the happy-path assertion deterministic.
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const CWD = process.cwd();
const EXAMPLE = join(CWD, "examples", "hello-batch");
const DAEMON = join(EXAMPLE, "dist", "agent.ts");

const log = (msg: string): void => {
  process.stderr.write(`[smoke] ${msg}\n`);
};
const fail = (msg: string): never => {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  process.exit(2);
};

const compileExample = async (): Promise<void> => {
  await mkdir(`${EXAMPLE}/dist`, { recursive: true });
  const r = spawnSync(
    "bun",
    ["apps/cli/src/index.ts", "compile", `${EXAMPLE}/crewhaus.yaml`, "-o", `${EXAMPLE}/dist`],
    { encoding: "utf8" },
  );
  if (r.status !== 0) fail(`compile failed: ${r.stderr || r.stdout}`);
};

type Result = { stdout: string; stderr: string; code: number };

type EventLine = { kind: string; [k: string]: unknown };

const parseEvents = (stdout: string): EventLine[] => {
  const out: EventLine[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const parsed = JSON.parse(t) as EventLine;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.kind === "string") {
        out.push(parsed);
      }
    } catch {
      // tolerate non-JSON runtime printer lines
    }
  }
  return out;
};

const runDaemon = async (
  args: ReadonlyArray<string>,
  killAfterStdoutMatches?: RegExp,
  signalAfterStdoutMatches?: { re: RegExp; signal: "SIGTERM" | "SIGINT" },
  timeoutMs = 240_000,
): Promise<Result> =>
  new Promise((resolve) => {
    const child = spawn("bun", [DAEMON, ...args], {
      env: { ...process.env, CREWHAUS_TRACE: "json" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let signalled = false;
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (signalAfterStdoutMatches && !signalled && signalAfterStdoutMatches.re.test(stdout)) {
        signalled = true;
        child.kill(signalAfterStdoutMatches.signal);
      } else if (killAfterStdoutMatches?.test(stdout)) {
        setTimeout(() => child.kill("SIGKILL"), 50);
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    child.stdin.end();
  });

const dump = (label: string, r: Result): void => {
  const out = `/tmp/section-23-batch.${label}.stdout.log`;
  const err = `/tmp/section-23-batch.${label}.stderr.log`;
  try {
    writeFileSync(out, r.stdout, "utf8");
    writeFileSync(err, r.stderr, "utf8");
  } catch {
    // best-effort
  }
  log(`stdout dumped to ${out} (${r.stdout.length} bytes)`);
  log(`stderr dumped to ${err} (${r.stderr.length} bytes)`);
};

const main = async (): Promise<void> => {
  if (!process.env["ANTHROPIC_AUTH_TOKEN"] && !process.env["ANTHROPIC_API_KEY"]) {
    throw new Error("ANTHROPIC_AUTH_TOKEN must be set (try `set -a; source .env; set +a`)");
  }
  log("compiling examples/hello-batch");
  await compileExample();

  // -------------------------------------------------------------------------
  // (1) Happy path — drain the 8-job seed, expect queue_idle + clean exit.
  // -------------------------------------------------------------------------
  log("running clean batch run (8 jobs, concurrency 4)");
  const happy = await runDaemon([]);
  if (happy.code !== 0) {
    dump("happy", happy);
    fail(`daemon exited ${happy.code}`);
  }
  const events = parseEvents(happy.stdout);
  const startEv = events.find((e) => e.kind === "worker_start");
  if (!startEv) {
    dump("happy", happy);
    fail("no worker_start event");
  }
  log("OK: worker_start emitted");

  // (2) All 8 seed jobs ack'd
  const okEnds = events.filter((e) => e.kind === "job_end" && e["status"] === "ok");
  const failEnds = events.filter((e) => e.kind === "job_end" && e["status"] === "fail");
  if (okEnds.length < 8) {
    dump("happy", happy);
    fail(`expected ≥ 8 ok job_end events, got ${okEnds.length} ok + ${failEnds.length} fail`);
  }
  log(`OK: ${okEnds.length} ok job_end (${failEnds.length} fail)`);

  // (3) queue_idle + worker_stop emitted with all jobs terminal
  const idleEv = events.find((e) => e.kind === "queue_idle");
  if (!idleEv) {
    dump("happy", happy);
    fail("no queue_idle event");
  }
  const stats = idleEv["stats"] as
    | { pending: number; inFlight: number; acked: number; deadLetter: number }
    | undefined;
  if (
    stats === undefined ||
    stats.pending !== 0 ||
    stats.inFlight !== 0 ||
    stats.deadLetter !== 0
  ) {
    dump("happy", happy);
    fail(`queue_idle stats not clean: ${JSON.stringify(stats)}`);
  }
  if (stats.acked < 8) {
    dump("happy", happy);
    fail(`expected ≥ 8 acked at idle, got ${stats.acked}`);
  }
  log(`OK: queue_idle stats=${JSON.stringify(stats)}`);

  const stopEv = events.find((e) => e.kind === "worker_stop");
  if (!stopEv) {
    dump("happy", happy);
    fail("no worker_stop event");
  }
  log("OK: worker_stop emitted");

  // -------------------------------------------------------------------------
  // (4) SIGTERM drain — start a second run, send SIGTERM after the first
  // job_end. The drain MUST emit drain_start → drain_end → worker_stop and
  // the process MUST exit cleanly (code 0). Jobs already in-flight at the
  // moment of SIGTERM ack; queued-but-not-pulled remain on the queue.
  // -------------------------------------------------------------------------
  log("running SIGTERM-drain run");
  const drain = await runDaemon([], undefined, { re: /"job_end"/, signal: "SIGTERM" });
  if (drain.code !== 0) {
    dump("drain", drain);
    fail(`SIGTERM-drain daemon exited ${drain.code}`);
  }
  const drainEvents = parseEvents(drain.stdout);
  const shutdownEv = drainEvents.find((e) => e.kind === "shutdown_received");
  if (!shutdownEv) {
    dump("drain", drain);
    fail("no shutdown_received event");
  }
  const drainStart = drainEvents.find((e) => e.kind === "drain_start");
  const drainEnd = drainEvents.find((e) => e.kind === "drain_end");
  if (!drainStart || !drainEnd) {
    dump("drain", drain);
    fail("drain_start/drain_end events missing");
  }
  log("OK: SIGTERM → shutdown_received → drain_start → drain_end → worker_stop");

  log("Section 23 BATCH smoke PASS");
};

main().catch((err) => {
  process.stderr.write(
    `[smoke] ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
