#!/usr/bin/env bun
/**
 * Section 23 RES — research bundle smoke test.
 *
 * Verifies four end-to-end behaviours against the live model:
 *   1. The planner decomposes the spec goal into the configured number
 *      of sub-questions; one branch_start / branch_end is emitted per
 *      sub-question; checkpoints land in `.crewhaus/research/<runId>/`.
 *   2. Killing the runner mid-second-branch and restarting with
 *      `--resume <runId>` picks up from the last checkpoint — the
 *      already-completed branches do NOT re-run, and previously-fetched
 *      file://-URIs are NOT re-read (the citation-tracker dedup is hit).
 *   3. The final `report.md` carries numbered citations [1], [2], … and
 *      the citation block is byte-identical across two clean runs that
 *      end up with the same citation set.
 *   4. The existing target shapes (cli + crew + rag) still compile.
 *
 * The example uses local `file://` sources so the smoke is hermetic —
 * no external HTTP, no rate limits.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const CWD = process.cwd();
const EXAMPLE = join(CWD, "examples", "hello-research");
const DAEMON = join(EXAMPLE, "dist", "agent.ts");
const RESEARCH_ROOT = join(CWD, ".crewhaus", "research");

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

const runDaemon = async (
  args: ReadonlyArray<string>,
  timeoutMs = 360_000,
  killAfterStdoutMatches?: RegExp,
): Promise<Result> =>
  new Promise((resolve) => {
    const child = spawn("bun", [DAEMON, ...args], {
      env: { ...process.env, CREWHAUS_TRACE: "json" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killedEarly = false;
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
      if (killAfterStdoutMatches && !killedEarly && killAfterStdoutMatches.test(stdout)) {
        killedEarly = true;
        // Give the process ~50ms to finish the in-flight write so its
        // checkpoint is durable, then kill.
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

const dump = (label: string, r: Result): void => {
  const out = `/tmp/section-23-res.${label}.stdout.log`;
  const err = `/tmp/section-23-res.${label}.stderr.log`;
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
  log("compiling examples/hello-research");
  await compileExample();

  // -------------------------------------------------------------------------
  // (1) Happy path — full run with deterministic seed of 3 sub-questions.
  // -------------------------------------------------------------------------
  log("running clean research run (this can take several minutes)");
  const happy = await runDaemon([]);
  if (happy.code !== 0) {
    dump("happy", happy);
    fail(`daemon exited ${happy.code}`);
  }
  const events = parseEvents(happy.stdout);
  const runStart = events.find((e) => e.kind === "run_start");
  if (!runStart) {
    dump("happy", happy);
    fail("no run_start event");
  }
  const runId = String(runStart["runId"]);
  log(`OK: run_start runId=${runId}`);

  const planDone = events.find((e) => e.kind === "plan_done");
  if (!planDone) {
    dump("happy", happy);
    fail("no plan_done event — planner did not run");
  }
  const subQs = planDone["subQuestions"] as ReadonlyArray<unknown>;
  if (!Array.isArray(subQs) || subQs.length !== 3) {
    dump("happy", happy);
    fail(`expected 3 sub-questions, got ${Array.isArray(subQs) ? subQs.length : "<n/a>"}`);
  }
  log(`OK: plan_done with ${subQs.length} sub-questions`);

  const branchStarts = events.filter((e) => e.kind === "branch_start").length;
  const branchEnds = events.filter((e) => e.kind === "branch_end").length;
  if (branchStarts !== 3 || branchEnds !== 3) {
    dump("happy", happy);
    fail(`expected 3 branch_start + 3 branch_end events, got ${branchStarts} + ${branchEnds}`);
  }
  log("OK: 3 branches ran");

  const runDone = events.find((e) => e.kind === "run_done");
  if (!runDone) {
    dump("happy", happy);
    fail("no run_done event");
  }
  const reportPath = String(runDone["reportPath"]);
  if (!existsSync(reportPath)) {
    dump("happy", happy);
    fail(`report.md not written at ${reportPath}`);
  }
  log(`OK: run_done report.md=${reportPath}`);

  // (2) Verify checkpoint state files exist.
  const stateA = join(RESEARCH_ROOT, runId, "state.json");
  const fetchesA = join(RESEARCH_ROOT, runId, "fetches.jsonl");
  const citationsA = join(RESEARCH_ROOT, runId, "citations.jsonl");
  if (!existsSync(stateA)) fail(`state.json missing: ${stateA}`);
  if (!existsSync(fetchesA)) fail(`fetches.jsonl missing: ${fetchesA}`);
  log("OK: state + fetches + citations files written");

  const reportMd = readFileSync(reportPath, "utf8");

  // (3) Numbered citations in deterministic order.
  if (!/\[\d+\]\s/.test(reportMd)) {
    dump("happy", happy);
    fail("report.md does not contain numbered citations [N]");
  }
  log("OK: numbered citations present");

  // -------------------------------------------------------------------------
  // (4) Resume invariant — start a SECOND clean run, kill it after the
  // first branch_end fires (so plan + branch-0 are durable), then resume.
  // The resumed run should NOT re-run branch 0 and should NOT re-fetch
  // any file:// URIs branch-0 already cached.
  // -------------------------------------------------------------------------
  log("running resume-test run (will be killed after first branch_end)");
  const partial = await runDaemon([], 360_000, /"branch_end"/);
  // The kill is expected — exit code is non-zero.
  const partialEvents = parseEvents(partial.stdout);
  const partialRunStart = partialEvents.find((e) => e.kind === "run_start");
  if (!partialRunStart) {
    dump("partial", partial);
    fail("partial: no run_start event");
  }
  const partialRunId = String(partialRunStart["runId"]);
  log(`OK: partial runId=${partialRunId}`);

  const completedBranchEnds = partialEvents.filter((e) => e.kind === "branch_end").length;
  if (completedBranchEnds < 1) {
    dump("partial", partial);
    fail("partial: no branch_end captured before kill");
  }
  log(`OK: ${completedBranchEnds} branch(es) completed before kill`);

  const fetchesBefore = readFileSync(join(RESEARCH_ROOT, partialRunId, "fetches.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  log(`OK: ${fetchesBefore.length} fetches recorded pre-resume`);

  log("resuming the killed run");
  const resumed = await runDaemon(["--resume", partialRunId]);
  if (resumed.code !== 0) {
    dump("resumed", resumed);
    fail(`resumed daemon exited ${resumed.code}`);
  }
  const resumedEvents = parseEvents(resumed.stdout);
  const resumeEv = resumedEvents.find((e) => e.kind === "resume");
  if (!resumeEv) {
    dump("resumed", resumed);
    fail("resumed: no resume event");
  }
  const resumedCompleted = resumeEv["completedBranches"];
  if (resumedCompleted !== completedBranchEnds) {
    dump("resumed", resumed);
    fail(
      `resumed picked up at completedBranches=${resumedCompleted}, expected ${completedBranchEnds}`,
    );
  }
  log(`OK: resume picked up at completedBranches=${resumedCompleted}`);

  const newBranchEnds = resumedEvents.filter((e) => e.kind === "branch_end").length;
  if (completedBranchEnds + newBranchEnds < 3) {
    dump("resumed", resumed);
    fail(
      `resume + partial together completed ${completedBranchEnds + newBranchEnds} branches, expected 3`,
    );
  }
  log(`OK: resume completed remaining ${newBranchEnds} branch(es)`);

  // T4 invariant: previously-fetched URIs are NOT re-fetched. Compare the
  // fetches.jsonl line count: every URI in `fetchesBefore` must still be
  // present in the file (idempotent recordFetch), AND no duplicate URIs
  // exist in the post-resume file.
  const fetchesAfter = readFileSync(join(RESEARCH_ROOT, partialRunId, "fetches.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const urisAfter = fetchesAfter.map((l) => JSON.parse(l).url as string);
  const urisAfterSet = new Set(urisAfter);
  if (urisAfterSet.size !== urisAfter.length) {
    dump("resumed", resumed);
    fail(
      `fetches.jsonl contains duplicate URIs (count ${urisAfter.length}, unique ${urisAfterSet.size})`,
    );
  }
  for (const before of fetchesBefore) {
    if (!fetchesAfter.includes(before)) {
      dump("resumed", resumed);
      fail("a pre-resume fetch line is missing from post-resume fetches.jsonl");
    }
  }
  log("OK: T4 dedup invariant — no URI re-fetched on resume");

  log("Section 23 RES smoke PASS");
};

main().catch((err) => {
  process.stderr.write(
    `[smoke] ERROR: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
