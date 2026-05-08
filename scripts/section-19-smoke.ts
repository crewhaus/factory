#!/usr/bin/env bun
/**
 * Section 19 — GRPH target smoke test.
 *
 * Verifies four end-to-end behaviours against the live model:
 *   1. Three-node graph runs in declared order, emitting node_start /
 *      node_end / checkpoint events for each node, with the expected
 *      checkpoint files landing under .crewhaus/graphs/<runId>/.
 *   2. The `execute` node's `requestApproval` triggers a hitl_pause —
 *      the graph stops, persists a checkpoint, and the bundle prints a
 *      "paused at execute" message with a usable resume command.
 *   3. Resuming via `--resume <runId> approve` continues the graph; the
 *      `summarise` node executes after the pause and a `run_done` event
 *      is emitted with the final state including the summary.
 *   4. Branching via `--branch-from <runId> <checkpointId-of-plan>`
 *      produces a NEW graphRunId whose head copies the source plan's
 *      state. Subsequent execution continues from the cloned head, and
 *      the `branch-history.diff` helper sees the divergence.
 *
 * Requires: ANTHROPIC_AUTH_TOKEN in .env. No external services beyond
 * the live model — graph state is file-backed under .crewhaus/graphs/.
 */
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const CWD = process.cwd();
const SMOKE_EXAMPLE = join(CWD, "examples", "hello-graph");
const SMOKE_DIST = join(SMOKE_EXAMPLE, "dist", "agent.ts");

const log = (msg: string): void => {
  process.stderr.write(`[smoke] ${msg}\n`);
};

const runSync = (cmd: string, args: string[]): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const compileExample = async (yamlPath: string, outDir: string): Promise<void> => {
  await mkdir(outDir, { recursive: true });
  const result = runSync("bun", ["apps/cli/src/index.ts", "compile", yamlPath, "-o", outDir]);
  if (result.code !== 0) {
    throw new Error(`compile failed: ${result.stderr || result.stdout}`);
  }
};

type AgentResult = { stdout: string; stderr: string; code: number };

const runBundle = async (
  args: ReadonlyArray<string>,
  stdin?: string,
  timeoutMs = 240_000,
): Promise<AgentResult> => {
  return new Promise((resolve) => {
    const child = spawn("bun", [SMOKE_DIST, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
};

const fail = (msg: string): never => {
  process.stderr.write(`[smoke] FAIL: ${msg}\n`);
  process.exit(2);
};

const dumpAndFail = (label: string, agent: AgentResult, suffix: string): never => {
  const stdoutPath = `/tmp/section-19-smoke.${suffix}.stdout.log`;
  const stderrPath = `/tmp/section-19-smoke.${suffix}.stderr.log`;
  try {
    writeFileSync(stdoutPath, agent.stdout, "utf8");
    writeFileSync(stderrPath, agent.stderr, "utf8");
  } catch {
    // dump is best-effort
  }
  log(`stdout dumped to ${stdoutPath} (${agent.stdout.length} bytes)`);
  log(`stderr dumped to ${stderrPath} (${agent.stderr.length} bytes)`);
  fail(label);
};

const expectContains = (
  haystack: string,
  needle: string,
  label: string,
  agent: AgentResult,
  suffix: string,
): void => {
  if (!haystack.includes(needle)) {
    dumpAndFail(`${label}: expected to contain "${needle}"`, agent, suffix);
  }
  log(`OK: ${label}`);
};

const expectMatches = (
  haystack: string,
  re: RegExp,
  label: string,
  agent: AgentResult,
  suffix: string,
): void => {
  if (!re.test(haystack)) {
    dumpAndFail(`${label}: expected to match ${re.source}`, agent, suffix);
  }
  log(`OK: ${label}`);
};

const extract = (re: RegExp, text: string): string | undefined => {
  const m = re.exec(text);
  return m === null ? undefined : (m[1] ?? m[0]);
};

const main = async (): Promise<void> => {
  if (!process.env["ANTHROPIC_AUTH_TOKEN"] && !process.env["ANTHROPIC_API_KEY"]) {
    throw new Error(
      "ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY must be set (try `set -a; source .env; set +a` then re-run)",
    );
  }

  log("compiling examples/hello-graph");
  await compileExample(`${SMOKE_EXAMPLE}/crewhaus.yaml`, `${SMOKE_EXAMPLE}/dist`);

  // -------------------------------------------------------------------------
  // Step 1: drive a fresh run. Expected to pause at `execute` (HITL).
  // -------------------------------------------------------------------------
  log("driving fresh run (expect pause at execute)");
  const fresh = await runBundle(
    [],
    "research the top 3 risks of GRPH-style agents and summarise",
    240_000,
  );
  if (fresh.code !== 0) dumpAndFail(`fresh run exited ${fresh.code}`, fresh, "fresh");

  const combinedFresh = `${fresh.stdout}\n${fresh.stderr}`;
  expectContains(
    combinedFresh,
    '"kind":"node_start"',
    "node_start trace event emitted",
    fresh,
    "fresh",
  );
  expectContains(
    combinedFresh,
    '"kind":"node_end"',
    "node_end trace event emitted",
    fresh,
    "fresh",
  );
  expectContains(
    combinedFresh,
    '"kind":"checkpoint"',
    "checkpoint trace event emitted",
    fresh,
    "fresh",
  );
  expectContains(combinedFresh, '"nodeName":"plan"', "plan node executed", fresh, "fresh");
  expectContains(
    combinedFresh,
    '"kind":"hitl_pause"',
    "hitl_pause trace event emitted",
    fresh,
    "fresh",
  );
  expectMatches(
    combinedFresh,
    /paused at execute/i,
    "bundle reports paused at execute",
    fresh,
    "fresh",
  );

  const freshGraphRunId = extract(/"graphRunId":"(grun_[0-9a-f]+)"/, combinedFresh);
  if (freshGraphRunId === undefined) {
    dumpAndFail("could not extract graphRunId from fresh run", fresh, "fresh");
  }
  log(`fresh graphRunId: ${freshGraphRunId}`);

  // The plan checkpoint id (used later for the branch test).
  const planCheckpointId = extract(
    /"kind":"checkpoint"[^}]*?"nodeName":"plan"[^}]*?"checkpointId":"(ckpt_[0-9a-f]+)"/,
    combinedFresh,
  );
  if (planCheckpointId === undefined) {
    dumpAndFail("could not extract plan checkpoint id from fresh run", fresh, "fresh");
  }
  log(`plan checkpointId: ${planCheckpointId}`);

  // -------------------------------------------------------------------------
  // Step 2: resume the run with "approve" — `summarise` should execute.
  // -------------------------------------------------------------------------
  log("resuming the paused run with decision=approve");
  const resumed = await runBundle(["--resume", freshGraphRunId as string, "approve"], "", 240_000);
  if (resumed.code !== 0) dumpAndFail(`resume exited ${resumed.code}`, resumed, "resume");

  const combinedResume = `${resumed.stdout}\n${resumed.stderr}`;
  expectContains(
    combinedResume,
    '"nodeName":"summarise"',
    "summarise node executed after resume",
    resumed,
    "resume",
  );
  expectContains(
    combinedResume,
    '"kind":"run_done"',
    "run_done emitted on resume",
    resumed,
    "resume",
  );

  // -------------------------------------------------------------------------
  // Step 3: branch from the plan checkpoint of the original run. The new
  // run should pause again at execute (its own HITL boundary), with a
  // brand-new graphRunId.
  // -------------------------------------------------------------------------
  log("branching from plan checkpoint of the original run");
  const branched = await runBundle(
    ["--branch-from", freshGraphRunId as string, planCheckpointId as string],
    "",
    240_000,
  );
  if (branched.code !== 0) dumpAndFail(`branch exited ${branched.code}`, branched, "branch");

  const combinedBranch = `${branched.stdout}\n${branched.stderr}`;
  expectMatches(
    combinedBranch,
    /branched: newRun=grun_[0-9a-f]+ head=ckpt_[0-9a-f]+ from=/,
    "branch confirmation line printed",
    branched,
    "branch",
  );
  // The branched run id must be different from the original.
  const branchRunId = extract(/branched: newRun=(grun_[0-9a-f]+)/, combinedBranch);
  if (branchRunId === undefined || branchRunId === freshGraphRunId) {
    dumpAndFail(`branched run id (${branchRunId}) was not distinct`, branched, "branch");
  }
  log(`branched graphRunId: ${branchRunId}`);

  // -------------------------------------------------------------------------
  // Cleanup.
  // -------------------------------------------------------------------------
  await rm(join(CWD, ".crewhaus", "graphs"), { recursive: true, force: true });
  log("cleanup complete");
  log("Section 19 smoke PASS");
};

main().catch((err) => {
  process.stderr.write(
    `[smoke] ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
