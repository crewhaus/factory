import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The builtin checker's worker must still start inside a `bun build
 * --compile` single binary — the CLI ships that way, and a compiled binary
 * embeds only what static imports reach. A worker loaded from a file URL
 * would pass every test run from source and fall back to the caller's
 * thread only in the binary, so this builds a real one that imports the
 * runner, runs it from a directory with no source tree in reach, and checks
 * that the check ran on a worker: a timer fired while a worst-case check was
 * running, and nothing ran in-process. Neither depends on how fast the
 * binary runs.
 */

const scratch = mkdtempSync(join(tmpdir(), "proof-checker-compile-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("the builtin checker runs on a worker inside a compiled single binary", async () => {
  const entry = join(scratch, "entry.ts");
  const runner = join(import.meta.dir, "runner.ts");
  writeFileSync(
    entry,
    `import { builtinCheckerCounts, createBuiltinChecker } from ${JSON.stringify(runner)};

const checker = createBuiltinChecker();
const proved = await checker.check({ claim: "c", statement: "exists k in 0..3: 2*k + 1 = 3", proof: "eval" });
const events: string[] = [];
const worst = checker
  .check({
    claim: "c",
    statement: "let a = 3^2500 / 7^1100 in forall i in 0..9999: a * a / (a + i) > -1",
    proof: "eval",
    timeoutMs: 1000,
  })
  .then((r) => {
    events.push("checked");
    return r;
  });
await new Promise((resolve) => setTimeout(resolve, 0));
events.push("timer");
const stopped = await worst;
console.log(JSON.stringify({ proved: proved.ok, stopped: stopped.reason, events, counts: builtinCheckerCounts() }));
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
    proved: boolean;
    stopped: string;
    events: string[];
    counts: { running: number; waiting: number; inProcess: number };
  };
  expect(out.proved).toBe(true);
  expect(out.stopped).toMatch(/ran out of time/);
  expect(out.events).toEqual(["timer", "checked"]);
  expect(out.counts).toEqual({ running: 0, waiting: 0, inProcess: 0 });
}, 120_000);
