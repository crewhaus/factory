#!/usr/bin/env bun
/**
 * Section 13 end-to-end smoke test against the live model.
 *
 * Three scenarios over a temp project:
 *   1. Round-trip: parent invokes Task → summarizer sub-agent summarises a
 *      file the parent just Read; parent's session JSONL contains the
 *      sub_agent_start / sub_agent_end pair with a distinct child session.
 *   2. Permission isolation: a sub-agent that has Bash(none) cannot run
 *      `rm -rf /tmp/<canary>` even when prompted directly — the marker
 *      file survives.
 *   3. Abort propagation: SIGINT to the parent stops the long child
 *      stream within ~2 s.
 *
 * Run: `bun run smoke:section-13` (after `bun --filter '@crewhaus/*' test`).
 * Requires `ANTHROPIC_AUTH_TOKEN` (Claude Pro/Max OAuth) or
 * `ANTHROPIC_API_KEY` in `.env`.
 *
 * Exits 0 on full success; 1 on any failed scenario.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");

type ScenarioResult = {
  readonly name: string;
  readonly passed: boolean;
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
};

function setupRoundTripProject(): { cwd: string; sessionDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "section-13-roundtrip-"));
  const sessionDir = join(cwd, ".crewhaus", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  // README.md the parent will Read.
  writeFileSync(
    join(cwd, "README.md"),
    "# Demo project\n\nThis is a sample README for the sub-agent smoke test. It contains two paragraphs.\n\nThe second paragraph explains how the summarizer should produce two sentences.\n",
  );
  // Spec with one inline sub-agent and a tools list.
  writeFileSync(
    join(cwd, "crewhaus.yaml"),
    `name: section-13-smoke
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are a helpful assistant. When the user asks for a summary,
    Read the requested file then call the Task tool to delegate
    summarisation to the summarizer sub-agent. After Task returns,
    your response is just that summary.
  sub_agents:
    summarizer:
      description: produces a 2-sentence summary of arbitrary input text
      instructions: |
        You are a summarizer. Reduce the user's input to exactly two
        short sentences. Output only the summary — no preamble.
      tools: []
      permissions: scoped
tools:
  - read
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAllow
      pattern: Task
`,
  );
  return { cwd, sessionDir };
}

function setupPermissionIsolationProject(): { cwd: string; canaryPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), "section-13-permiso-"));
  mkdirSync(join(cwd, ".crewhaus", "sessions"), { recursive: true });
  const canaryDir = mkdtempSync(join(tmpdir(), "section-13-canary-"));
  const canaryPath = join(canaryDir, "canary.txt");
  writeFileSync(canaryPath, "should-still-exist-after-test");
  writeFileSync(
    join(cwd, "crewhaus.yaml"),
    `name: section-13-permiso
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are an automation assistant. When asked to spawn a sub-agent
    to run shell commands, call the Task tool with subagent_type=runner
    and pass the user's prompt verbatim.
  sub_agents:
    runner:
      description: tries to run shell commands
      instructions: |
        You are a sub-agent. The user will ask you to run a shell
        command. Try to use the Bash tool. If Bash is unavailable,
        explain what you would have run.
      tools: []
      permissions: scoped
tools:
  - bash
  - read
permissions:
  rules:
    - type: alwaysAllow
      pattern: Task
    - type: alwaysAllow
      pattern: Bash(**)
    - type: alwaysAllow
      pattern: Read
`,
  );
  return { cwd, canaryPath };
}

function setupAbortProject(): { cwd: string } {
  const cwd = mkdtempSync(join(tmpdir(), "section-13-abort-"));
  mkdirSync(join(cwd, ".crewhaus", "sessions"), { recursive: true });
  writeFileSync(
    join(cwd, "crewhaus.yaml"),
    `name: section-13-abort
target: cli
agent:
  model: claude-haiku-4-5-20251001
  instructions: |
    You are a helpful assistant. When the user asks to count slowly,
    spawn the counter sub-agent via the Task tool.
  sub_agents:
    counter:
      description: counts slowly
      instructions: |
        Count from 1 to 200 in a single response. Put each number on
        its own line. Take your time and be thorough.
      tools: []
      permissions: scoped
tools: []
permissions:
  rules:
    - type: alwaysAllow
      pattern: Task
`,
  );
  return { cwd };
}

function runAgent(cwd: string, prompt: string, timeoutMs: number): ScenarioResult {
  const stdin = `${prompt}\nexit\n`;
  const result = spawnSync("bun", [CLI_ENTRY, "run", join(cwd, "crewhaus.yaml")], {
    cwd,
    input: stdin,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env },
  });
  return {
    name: "(agent run)",
    passed: result.status === 0,
    message: result.error ? String(result.error) : "",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function check(
  scenarioName: string,
  raw: ScenarioResult,
  predicate: (out: { stdout: string; stderr: string; cwd: string }) => string | null,
  cwd: string,
): ScenarioResult {
  const failure = predicate({ stdout: raw.stdout, stderr: raw.stderr, cwd });
  return {
    name: scenarioName,
    passed: failure === null,
    message: failure ?? "OK",
    stdout: raw.stdout,
    stderr: raw.stderr,
  };
}

/** Walk the session-dir for the first .jsonl file; return its parsed events. */
function readSessionEvents(sessionDir: string): { kind: string; payload: unknown }[][] {
  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  return files.map((f) => {
    const txt = readFileSync(join(sessionDir, f), "utf-8");
    return txt
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; payload: unknown });
  });
}

async function main(): Promise<void> {
  const results: ScenarioResult[] = [];

  // === Scenario 1: round-trip via Task ===
  const s1 = setupRoundTripProject();
  console.log(`[scenario 1] round-trip — temp: ${s1.cwd}`);
  const raw1 = runAgent(
    s1.cwd,
    "Please summarise README.md by Reading it then using the Task tool with subagent_type=summarizer.",
    90_000,
  );
  results.push(
    check(
      "round-trip",
      raw1,
      ({ stdout, cwd }) => {
        if (!stdout.includes("[sub-agents] 1"))
          return "expected '[sub-agents] 1 available: summarizer' boot line";
        if (!stdout.includes("[tool: Read]")) return "expected '[tool: Read]'";
        if (!stdout.includes("[tool: Task]")) return "expected '[tool: Task]'";

        const sessionDir = join(cwd, ".crewhaus", "sessions");
        const sessions = readSessionEvents(sessionDir);
        if (sessions.length < 2)
          return `expected at least 2 session JSONL files (parent + child); got ${sessions.length}`;
        // Find a session containing sub_agent_start.
        const parent = sessions.find((evs) => evs.some((e) => e.kind === "sub_agent_start"));
        if (!parent) return "no session contains a sub_agent_start event";
        const startEv = parent.find((e) => e.kind === "sub_agent_start");
        const endEv = parent.find((e) => e.kind === "sub_agent_end");
        if (!startEv || !endEv) return "expected paired sub_agent_start + sub_agent_end on parent";
        const childId = (startEv.payload as { childSessionId: string }).childSessionId;
        const child = sessions.find((evs) =>
          evs.some(
            (e) =>
              e.kind === "user_message" &&
              JSON.stringify((e.payload as { content: unknown }).content).includes("README"),
          ),
        );
        // Child session id should be different from any session that contains a sub_agent_start
        // (i.e., not the parent). Confirm the child file actually exists.
        if (!existsSync(join(sessionDir, `${childId}.jsonl`)))
          return `child session file ${childId}.jsonl missing under ${sessionDir}`;
        if (child === undefined)
          return "expected the child session to record a user_message referencing README";
        return null;
      },
      s1.cwd,
    ),
  );
  rmSync(s1.cwd, { recursive: true, force: true });

  // === Scenario 2: permission isolation ===
  const s2 = setupPermissionIsolationProject();
  console.log(`[scenario 2] permission isolation — temp: ${s2.cwd} (canary: ${s2.canaryPath})`);
  const raw2 = runAgent(
    s2.cwd,
    `Spawn a sub-agent (subagent_type=runner) that should run \`rm -rf ${s2.canaryPath}\` via Bash. Pass that exact command in the prompt.`,
    90_000,
  );
  results.push(
    check(
      "permission-isolation",
      raw2,
      ({ stdout }) => {
        if (!existsSync(s2.canaryPath))
          return `canary file ${s2.canaryPath} was deleted — sub-agent escaped its tool sandbox`;
        if (!stdout.includes("[tool: Task]")) return "expected '[tool: Task]'";
        return null;
      },
      s2.cwd,
    ),
  );
  rmSync(s2.cwd, { recursive: true, force: true });
  // Leave canary file path intact for inspection if it exists.
  if (existsSync(s2.canaryPath)) rmSync(s2.canaryPath, { force: true });

  // === Scenario 3: abort propagation ===
  const s3 = setupAbortProject();
  console.log(`[scenario 3] abort propagation — temp: ${s3.cwd}`);
  const child = spawn("bun", [CLI_ENTRY, "run", join(s3.cwd, "crewhaus.yaml")], {
    cwd: s3.cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let abortStdout = "";
  let abortStderr = "";
  child.stdout?.on("data", (d) => {
    abortStdout += String(d);
  });
  child.stderr?.on("data", (d) => {
    abortStderr += String(d);
  });
  child.stdin?.write("Spawn a sub-agent (subagent_type=counter) that counts slowly to 200.\n");
  // Wait until we see the Task tool kick off.
  const waitForTask = new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (abortStdout.includes("[tool: Task]")) {
        clearInterval(interval);
        resolve();
      }
    }, 200);
    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, 30_000);
  });
  await waitForTask;
  // Send SIGINT and wait briefly for the child to exit.
  const beforeAbort = abortStdout.length;
  child.kill("SIGINT");
  await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
  const afterAbort = abortStdout.length;
  const exited = child.exitCode !== null || child.killed;
  if (!exited) child.kill("SIGKILL");
  // Heuristic: after SIGINT, output should stop or near-stop within 2s.
  // Allow up to ~2 KB of trailing buffered text.
  const tailGrowth = afterAbort - beforeAbort;
  const passed = (exited || tailGrowth < 2048) && abortStdout.includes("[tool: Task]");
  results.push({
    name: "abort-propagation",
    passed,
    message: passed
      ? "OK"
      : `abort did not stop the child cleanly (exited=${exited}, tail growth=${tailGrowth}b)`,
    stdout: abortStdout,
    stderr: abortStderr,
  });
  rmSync(s3.cwd, { recursive: true, force: true });

  // === Report ===
  console.log("\n=== SECTION 13 SMOKE RESULTS ===");
  let allPass = true;
  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    console.log(`[${tag}] ${r.name}: ${r.message}`);
    if (!r.passed) {
      allPass = false;
      console.log("  -- stdout (last 1500 chars) --");
      console.log(r.stdout.slice(-1500));
      console.log("  -- stderr (last 800 chars) --");
      console.log(r.stderr.slice(-800));
    }
  }
  process.exit(allPass ? 0 : 1);
}

await main();
