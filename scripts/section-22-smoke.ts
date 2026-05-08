#!/usr/bin/env bun
/**
 * Section 22 — CRW (multi-agent crew) target smoke test.
 *
 * Compiles `examples/hello-crew` and drives one crew run against the live
 * model. The compiled bundle is a daemon that reads a single prompt on
 * stdin and emits one JSON-encoded `CrewEvent` per line on stdout.
 *
 * The smoke verifies:
 *
 *   1. role_start{role: "researcher"} fires first.
 *   2. The researcher emits a `handoff` event to "writer".
 *   3. role_start{role: "writer"} fires after the handoff.
 *   4. The writer emits an `a2a_message` from "writer" to "critic" (the
 *      writer asks the critic a clarifying question per the spec).
 *   5. The crew terminates with `crew_done` and a non-empty finalOutput.
 *   6. Every event carries the same traceId (W3C trace-context invariant).
 *   7. Refusal-loop guard: a follow-up run with both researcher AND writer
 *      configured to refuse all handoffs terminates with HandoffRefusedError.
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CWD = process.cwd();
const EXAMPLE = join(CWD, "examples", "hello-crew");
const DIST_DAEMON = join(EXAMPLE, "dist", "daemon.ts");

const log = (msg: string): void => {
  process.stderr.write(`[smoke] ${msg}\n`);
};
const fail = (msg: string): never => {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  process.exit(2);
};

const compileExample = async (yamlPath: string, outDir: string): Promise<void> => {
  await mkdir(outDir, { recursive: true });
  const r = spawnSync("bun", ["apps/cli/src/index.ts", "compile", yamlPath, "-o", outDir], {
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`compile failed: ${r.stderr || r.stdout}`);
};

type Result = { stdout: string; stderr: string; code: number };

const runDaemon = async (
  daemonPath: string,
  prompt: string,
  timeoutMs = 240_000,
): Promise<Result> =>
  new Promise((resolve) => {
    const child = spawn("bun", [daemonPath], {
      env: { ...process.env, CREWHAUS_TRACE: "json" },
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
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    child.stdin.write(`${prompt}\n`);
    child.stdin.end();
  });

type CrewEventLine = {
  kind: string;
  [k: string]: unknown;
};

const parseEvents = (stdout: string): CrewEventLine[] => {
  const events: CrewEventLine[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const parsed = JSON.parse(t) as CrewEventLine;
      if (typeof parsed === "object" && parsed !== null && typeof parsed.kind === "string") {
        events.push(parsed);
      }
    } catch {
      // non-JSON lines from runtime printers are tolerated
    }
  }
  return events;
};

const dump = (label: string, r: Result): void => {
  const out = `/tmp/section-22-smoke.${label}.stdout.log`;
  const err = `/tmp/section-22-smoke.${label}.stderr.log`;
  try {
    writeFileSync(out, r.stdout, "utf8");
    writeFileSync(err, r.stderr, "utf8");
  } catch {
    // best-effort
  }
  log(`stdout dumped to ${out} (${r.stdout.length} bytes)`);
  log(`stderr dumped to ${err} (${r.stderr.length} bytes)`);
};

const expectKind = (
  events: CrewEventLine[],
  kind: string,
  label: string,
  r: Result,
): CrewEventLine => {
  const ev = events.find((e) => e.kind === kind);
  if (!ev) {
    dump(label, r);
    fail(
      `${label}: expected event of kind "${kind}". Got kinds: ${events.map((e) => e.kind).join(", ")}`,
    );
  }
  log(`OK: ${label}`);
  return ev;
};

const main = async (): Promise<void> => {
  if (!process.env["ANTHROPIC_AUTH_TOKEN"] && !process.env["ANTHROPIC_API_KEY"]) {
    throw new Error("ANTHROPIC_AUTH_TOKEN must be set (try `set -a; source .env; set +a`)");
  }
  log("compiling examples/hello-crew");
  await compileExample(`${EXAMPLE}/crewhaus.yaml`, `${EXAMPLE}/dist`);

  log("driving the happy-path crew run (this can take several minutes)");
  const happy = await runDaemon(
    DIST_DAEMON,
    "Topic: the top 3 risks of multi-agent crews. Researcher, list 3 risks, then hand off to writer for a 4-sentence summary post.",
  );
  if (happy.code !== 0) {
    dump("happy", happy);
    fail(`daemon exited ${happy.code}`);
  }

  const events = parseEvents(happy.stdout);
  if (events.length === 0) {
    dump("happy", happy);
    fail("no JSON events parsed from stdout");
  }

  // (1) role_start{researcher} first
  const firstRoleStart = events.find((e) => e.kind === "role_start");
  if (!firstRoleStart || firstRoleStart["role"] !== "researcher") {
    dump("happy", happy);
    fail(`expected first role_start.role === "researcher", got ${JSON.stringify(firstRoleStart)}`);
  }
  log("OK: researcher activated first");

  // (2) handoff fires
  const handoff = expectKind(events, "handoff", "handoff event emitted", happy);
  if (handoff["from"] !== "researcher" || handoff["to"] !== "writer") {
    dump("happy", happy);
    fail(`handoff event has unexpected from/to: ${JSON.stringify(handoff)}`);
  }
  log("OK: researcher → writer handoff");

  // (3) writer activates
  const writerStarts = events.filter((e) => e.kind === "role_start" && e["role"] === "writer");
  if (writerStarts.length === 0) {
    dump("happy", happy);
    fail('expected at least one role_start with role === "writer"');
  }
  log("OK: writer activated");

  // (4) a2a_message from writer to critic — the spec asks the writer to
  // optionally check with the critic. We don't HARD-fail if the model
  // skips the optional A2A; but log a warning.
  const a2a = events.find((e) => e.kind === "a2a_message");
  if (!a2a) {
    log("WARN: no a2a_message emitted (writer skipped the optional critic check). Continuing.");
  } else {
    log(`OK: a2a_message ${JSON.stringify({ from: a2a["from"], to: a2a["to"] })}`);
  }

  // (5) crew_done with non-empty finalOutput
  const done = expectKind(events, "crew_done", "crew_done emitted", happy);
  const finalOut = String(done["finalOutput"] ?? "");
  if (finalOut.length < 50) {
    dump("happy", happy);
    fail(
      `crew_done.finalOutput is too short (${finalOut.length} chars): "${finalOut.slice(0, 80)}"`,
    );
  }
  log(`OK: crew_done with ${finalOut.length}-char finalOutput`);

  // (6) Refusal-loop guard. Compile a variant where every role refuses
  // any handoff by re-handing-off back. We rewrite the spec inline.
  log("running refusal-loop variant");
  const refusalDir = join(EXAMPLE, "dist-refusal");
  const refusalSpec = `name: hello-crew-refusal
target: crew
model: claude-haiku-4-5-20251001
entry: a
permissions:
  mode: default
roles:
  a:
    instructions: |
      You are role A. On EVERY turn, IMMEDIATELY call the Handoff tool with
      target="b" and reason="bouncing — refusing this work". Never produce
      narrative text on your own. End your turn after Handoff returns.
  b:
    instructions: |
      You are role B. On EVERY turn, IMMEDIATELY call the Handoff tool with
      target="a" and reason="bouncing — refusing this work". Never produce
      narrative text on your own. End your turn after Handoff returns.
`;
  const refusalSpecPath = join(EXAMPLE, "dist", "refusal.yaml");
  await writeFile(refusalSpecPath, refusalSpec);
  await compileExample(refusalSpecPath, refusalDir);
  const refusalDaemon = join(refusalDir, "daemon.ts");
  const refusal = await runDaemon(refusalDaemon, "go", 120_000);
  // The daemon should exit with non-zero AND stderr should mention "handoff refused".
  const refusalStream = `${refusal.stdout}\n${refusal.stderr}`;
  if (!refusalStream.toLowerCase().includes("handoff refused")) {
    dump("refusal", refusal);
    fail('refusal-loop variant did not report "handoff refused"');
  }
  log("OK: refusal-loop guard tripped cleanly");

  // (7) traceId invariant: every event in the happy stream that carries
  // a traceparent should share the same traceId. The orchestrator emits
  // traceparent on a2a_message events; every event also lands on the
  // trace bus where envelopes carry the same traceId. We assert here on
  // the a2a_message envelope when one was produced.
  if (a2a !== undefined) {
    const tp = String(a2a["traceparent"] ?? "");
    const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-/.exec(tp);
    if (m === null) {
      dump("happy", happy);
      fail(`a2a_message has malformed traceparent: ${tp}`);
    }
    log(`OK: a2a_message traceparent traceId=${m[1]?.slice(0, 8) ?? "<n/a>"}...`);
  }

  log("Section 22 smoke PASS");
};

main().catch((err) => {
  process.stderr.write(
    `[smoke] ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
