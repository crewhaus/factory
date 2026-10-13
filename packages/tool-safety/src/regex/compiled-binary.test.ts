import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The worker must still start inside a `bun build --compile` single binary.
 *
 * Harness bundles ship that way, and a compiled binary embeds only what is
 * reachable through static imports. A worker loaded from a file URL would
 * pass every test run from source and fail only in the binary — so this
 * builds a real one that imports the helper, runs it from a directory with
 * no source tree in reach, and checks both the ok path and the deadline.
 *
 * Neither depends on how fast the binary runs. The ok path's limits are
 * raised to hang bounds, so a stalled runner cannot turn its answer into a
 * timeout or a give-up. The deadline is shown on a run that cannot finish:
 * the worker is the shipped one with its `exec` over one input held (see
 * scriptWorkerClock), as a slow real match holds it, and the deadline's
 * timer is held too and fired once the worker is inside that exec. A real
 * slow match raced the deadline here, and an engine fast enough would have
 * answered first.
 */

const scratch = mkdtempSync(join(tmpdir(), "tool-safety-compile-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("runRegex works, and its deadline holds, inside a compiled single binary", async () => {
  const entry = join(scratch, "entry.ts");
  const helper = join(import.meta.dir, "index.ts");
  const scripted = join(import.meta.dir, "__test__", "scripted-worker-clock.ts");
  writeFileSync(
    entry,
    `import { REGEX_RUN_DEFAULTS, regexWorkerCounts, runRegex } from ${JSON.stringify(helper)};
import { restoreWorkerClock, scriptWorkerClock } from ${JSON.stringify(scripted)};

// Hang bounds only: a start, an exec or a run that slow is a hang.
const limits = REGEX_RUN_DEFAULTS as { startupTimeoutMs: number; giveUpMs: number };
limits.startupTimeoutMs = 60_000;
limits.giveUpMs = 60_000;
const ok = await runRegex({ op: "matchAll", pattern: "\\\\d+", input: "a1b22c333", deadlineMs: 60_000 });

const HELD = "the worker holds this one, x";
const worker = scriptWorkerClock({}, [], [HELD]);
const realSetTimeout = globalThis.setTimeout;
const realNow = performance.now;
const held: Array<() => void> = [];
// The caller's clock stands still, so the screen takes nothing off the
// deadline and its timer asks for exactly 50 ms; that one is held.
performance.now = () => 0;
globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
  if (delay !== 50) return realSetTimeout(fn, delay, ...rest);
  held.push(() => fn(...rest));
  return 0;
}) as typeof setTimeout;
const pending = runRegex({ op: "test", pattern: "\\\\s+$|x", input: HELD, deadlineMs: 50 });
const reached = await Promise.race([worker.hung, pending.then((o) => "ended first: " + o.status)]);
const deadlines = held.length;
for (const fire of held) fire();
const slow = await pending;
globalThis.setTimeout = realSetTimeout;
performance.now = realNow;
// The abandoned thread is still inside the held exec, as one inside a slow
// real match is; released, it exits.
const runaway = regexWorkerCounts().runaway;
restoreWorkerClock();
console.log(JSON.stringify({ ok, reached, deadlines, slow: slow.status, runaway }));
`,
  );
  const binary = join(scratch, process.platform === "win32" ? "probe.exe" : "probe");
  const build = Bun.spawnSync(
    [process.execPath, "build", "--compile", entry, "--outfile", binary],
    { cwd: scratch, stdout: "pipe", stderr: "pipe" },
  );
  expect(build.stderr.toString()).not.toContain("error");
  expect(build.exitCode).toBe(0);

  // Run from an unrelated directory: nothing on disk to fall back on.
  const run = Bun.spawnSync([binary], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  const out = JSON.parse(run.stdout.toString()) as {
    ok: { status: string; result?: { matches: Array<{ match: string }> } };
    reached: string;
    deadlines: number;
    slow: string;
    runaway: number;
  };
  expect(out.ok.status).toBe("ok");
  expect(out.ok.result?.matches.map((m) => m.match)).toEqual(["1", "22", "333"]);
  // The worker was inside the held exec, so nothing but the one deadline
  // could end the run, and it did.
  expect(out.reached).toBe("the worker holds this one, x");
  expect(out.deadlines).toBe(1);
  expect(out.slow).toBe("timeout");
  expect(out.runaway).toBe(1);
}, 120_000);
