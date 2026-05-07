#!/usr/bin/env bun
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

/**
 * Section 12 end-to-end smoke test against the live Anthropic API.
 *
 * The Slack side is exercised with a synthetic webhook (no real Slack
 * workspace required). The Slack outbound HTTP is intercepted by a local
 * mock listener that captures `chat.postMessage` calls.
 *
 * Five scenarios:
 *   1. Compile hello-channel + boot the daemon. Probe it.
 *   2. POST one signed app_mention webhook → assert one model call,
 *      one outbound `chat.postMessage`, replied in the right thread.
 *   3. POST the SAME signed payload twice → assert idempotency
 *      (still only one outbound call total).
 *   4. POST a tampered signature → assert 401 + zero new model calls.
 *   5. SIGINT the daemon → assert clean exit (exit code 0).
 *
 * Run with `bun run smoke:section-12` (or directly: `bun scripts/section-12-smoke.ts`).
 * Requires a Claude credential in `.env` — `ANTHROPIC_AUTH_TOKEN` (Pro/Max
 * OAuth) or `ANTHROPIC_API_KEY` (pay-per-token).
 *
 * Exits 0 on full success; 1 on any failure.
 */

// Inline copy of `signSlackBody` from @crewhaus/channel-adapter-slack;
// scripts/ is outside the workspace package graph, so importing the
// package directly fails resolution. The HMAC is small enough that
// inlining beats setting up a fragile cross-tree import.
function signSlackBody(args: { body: string; timestamp: number; signingSecret: string }): string {
  const base = `v0:${args.timestamp}:${args.body}`;
  return `v0=${createHmac("sha256", args.signingSecret).update(base).digest("hex")}`;
}

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");
const TEST_SECRET = "section-12-smoke-secret-1234567890";

type ScenarioResult = {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
};

function envHasAnthropicCreds(): boolean {
  return Boolean(process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["ANTHROPIC_API_KEY"]);
}

function freePort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

async function waitForDaemon(port: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/slack/events`, {
        method: "POST",
        headers: { "x-probe": "1" },
        body: "{}",
      });
      if (res.status > 0) return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`daemon did not become ready on port ${port}`);
}

function buildSignedAppMention(opts: {
  eventId: string;
  text: string;
  threadTs?: string;
}): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    type: "event_callback",
    team_id: "T_SMOKE",
    event_id: opts.eventId,
    event: {
      type: "app_mention",
      user: "U_SMOKE",
      text: opts.text,
      ts: opts.threadTs ?? "1700000000.000100",
      thread_ts: opts.threadTs ?? "1700000000.000100",
      channel: "C_SMOKE",
    },
  });
  const ts = Math.floor(Date.now() / 1000);
  const sig = signSlackBody({ body, timestamp: ts, signingSecret: TEST_SECRET });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": sig,
    },
  };
}

async function postWebhook(
  port: number,
  args: { body: string; headers: Record<string, string> },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: args.headers,
    body: args.body,
  });
}

async function pollUntil<T>(
  pred: () => T | undefined,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = pred();
    if (v !== undefined) return v;
    await Bun.sleep(intervalMs);
  }
  return undefined;
}

async function main(): Promise<void> {
  if (!envHasAnthropicCreds()) {
    process.stderr.write(
      "section-12 smoke requires ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in .env\n",
    );
    process.exit(2);
  }

  const cwd = mkdtempSync(join(tmpdir(), "section-12-smoke-"));
  const distDir = join(cwd, "dist");
  const sessionDir = join(cwd, ".crewhaus", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  process.stdout.write(`[smoke] tmpdir: ${cwd}\n`);

  // Compile the in-repo example into the smoke tmp dir. The same example
  // YAML is used by `bun run compile:hello-channel`; here we redirect the
  // output dir so the smoke is hermetic.
  const compile = Bun.spawnSync({
    cmd: [
      "bun",
      CLI_ENTRY,
      "compile",
      join(REPO_ROOT, "examples/hello-channel/crewhaus.yaml"),
      "-o",
      distDir,
    ],
    cwd: REPO_ROOT,
  });
  if (compile.exitCode !== 0) {
    process.stderr.write(`[smoke] compile failed: ${new TextDecoder().decode(compile.stderr)}\n`);
    process.exit(1);
  }

  // For the daemon to resolve `@crewhaus/*` workspace deps we need it to
  // run from a path within the repo. We re-write daemon.ts into the
  // example's own dist (the same path `bun run run:hello-channel` uses)
  // because that path has node_modules symlinks via Bun workspaces.
  const exampleDist = join(REPO_ROOT, "examples/hello-channel/dist");
  for (const file of ["daemon.ts", "agent.ts", "session-router.ts", "gateway.ts"]) {
    const src = Bun.file(join(distDir, file));
    writeFileSync(join(exampleDist, file), await src.text());
  }

  // Mock Slack outbound API. Captures every chat.postMessage and
  // surfaces it via the captured array for assertions.
  const slackPort = freePort();
  const slackCaptured: Array<{ body: unknown; auth: string }> = [];
  const slackServer = Bun.serve({
    port: slackPort,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/chat.postMessage") {
        const body = (await req.json()) as unknown;
        const auth = req.headers.get("authorization") ?? "";
        slackCaptured.push({ body, auth });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const daemonPort = freePort();
  const daemon: Subprocess = Bun.spawn({
    cmd: ["bun", join(exampleDist, "daemon.ts")],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SLACK_API_BASE_URL: `http://127.0.0.1:${slackPort}`,
      SLACK_BOT_TOKEN: "xoxb-smoke-bot",
      SLACK_SIGNING_SECRET: TEST_SECRET,
      PORT: String(daemonPort),
      CREWHAUS_SESSION_DIR: sessionDir,
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  const results: ScenarioResult[] = [];

  // Scenario 1 — daemon boots and listens.
  try {
    await waitForDaemon(daemonPort);
    results.push({ name: "1. daemon boots", passed: true, message: "ok" });
  } catch (err) {
    results.push({
      name: "1. daemon boots",
      passed: false,
      message: (err as Error).message,
    });
    daemon.kill("SIGKILL");
    await slackServer.stop(true);
    rmSync(cwd, { recursive: true, force: true });
    printSummary(results);
    process.exit(1);
  }

  // Scenario 2 — single signed webhook → one outbound reply.
  try {
    slackCaptured.length = 0;
    const evt = buildSignedAppMention({
      eventId: "Ev_SMOKE_1",
      text: "<@U_BOT> reply with a short greeting to confirm you are alive",
    });
    const res = await postWebhook(daemonPort, evt);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const captured = await pollUntil(
      () => (slackCaptured.length === 1 ? slackCaptured[0] : undefined),
      60_000,
    );
    if (!captured) throw new Error("no outbound chat.postMessage observed within 60s");
    if (captured.auth !== "Bearer xoxb-smoke-bot") {
      throw new Error(`unexpected auth header: ${captured.auth}`);
    }
    const body = captured.body as { channel: string; thread_ts: string; text: string };
    if (body.channel !== "C_SMOKE") {
      throw new Error(`unexpected channel: ${body.channel}`);
    }
    if (body.thread_ts !== "1700000000.000100") {
      throw new Error(`unexpected thread_ts: ${body.thread_ts}`);
    }
    if (typeof body.text !== "string" || body.text.length === 0) {
      throw new Error("expected non-empty reply text from live model");
    }
    results.push({
      name: "2. signed webhook drives a model turn + outbound reply",
      passed: true,
      message: `model said: "${body.text.slice(0, 80)}${body.text.length > 80 ? "..." : ""}"`,
    });
  } catch (err) {
    results.push({
      name: "2. signed webhook drives a model turn + outbound reply",
      passed: false,
      message: (err as Error).message,
    });
  }

  // Scenario 3 — same signed event posted twice is idempotent.
  try {
    slackCaptured.length = 0;
    const evt = buildSignedAppMention({
      eventId: "Ev_SMOKE_DUP",
      text: "<@U_BOT> idempotency probe",
      threadTs: "1700000010.000200",
    });
    const r1 = await postWebhook(daemonPort, evt);
    const r2 = await postWebhook(daemonPort, evt);
    if (r1.status !== 200 || r2.status !== 200) {
      throw new Error(`expected 200/200, got ${r1.status}/${r2.status}`);
    }
    // Wait for the first turn's outbound; then assert no second one
    // arrives in a 5s window.
    const first = await pollUntil(
      () => (slackCaptured.length >= 1 ? slackCaptured[0] : undefined),
      60_000,
    );
    if (!first) throw new Error("first turn did not produce an outbound reply");
    await Bun.sleep(5_000);
    if (slackCaptured.length !== 1) {
      throw new Error(`expected exactly 1 outbound, got ${slackCaptured.length}`);
    }
    results.push({
      name: "3. duplicate Slack event_id is dropped at the gateway",
      passed: true,
      message: "ok",
    });
  } catch (err) {
    results.push({
      name: "3. duplicate Slack event_id is dropped at the gateway",
      passed: false,
      message: (err as Error).message,
    });
  }

  // Scenario 4 — tampered signature is rejected with 401.
  try {
    slackCaptured.length = 0;
    const evt = buildSignedAppMention({
      eventId: "Ev_SMOKE_TAMPER",
      text: "<@U_BOT> should never reach the model",
    });
    const tampered = {
      ...evt,
      headers: { ...evt.headers, "x-slack-signature": `${evt.headers["x-slack-signature"]}00` },
    };
    const res = await postWebhook(daemonPort, tampered);
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
    await Bun.sleep(2_000);
    if (slackCaptured.length !== 0) {
      throw new Error(
        `tampered signature reached the model and produced ${slackCaptured.length} outbound call(s)`,
      );
    }
    results.push({
      name: "4. tampered signature → 401, zero model calls",
      passed: true,
      message: "ok",
    });
  } catch (err) {
    results.push({
      name: "4. tampered signature → 401, zero model calls",
      passed: false,
      message: (err as Error).message,
    });
  }

  // Scenario 5 — clean shutdown via SIGINT.
  try {
    daemon.kill("SIGINT");
    const exited = await Promise.race([daemon.exited, Bun.sleep(10_000).then(() => -1)]);
    if (exited === -1) {
      throw new Error("daemon did not exit within 10s of SIGINT");
    }
    if (exited !== 0) {
      throw new Error(`daemon exited with non-zero code: ${exited}`);
    }
    results.push({
      name: "5. SIGINT shuts the daemon down cleanly",
      passed: true,
      message: "exit 0",
    });
  } catch (err) {
    results.push({
      name: "5. SIGINT shuts the daemon down cleanly",
      passed: false,
      message: (err as Error).message,
    });
    daemon.kill("SIGKILL");
  }

  await slackServer.stop(true);
  rmSync(cwd, { recursive: true, force: true });
  printSummary(results);
  process.exit(results.every((r) => r.passed) ? 0 : 1);
}

function printSummary(results: ReadonlyArray<ScenarioResult>): void {
  const rule = "─".repeat(72);
  process.stdout.write("\n");
  process.stdout.write(`${rule}\n`);
  process.stdout.write("section-12 smoke results\n");
  process.stdout.write(`${rule}\n`);
  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    process.stdout.write(`[${tag}] ${r.name}\n`);
    if (r.message) process.stdout.write(`        ${r.message}\n`);
  }
  process.stdout.write(`${rule}\n`);
  const failed = results.filter((r) => !r.passed).length;
  if (failed === 0) {
    process.stdout.write(`all ${results.length} scenarios passed.\n`);
  } else {
    process.stdout.write(`${failed} of ${results.length} scenarios failed.\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`[smoke] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
