import { expect, test } from "bun:test";
import { join } from "node:path";

/**
 * What the builtin checker's worker runs is what the checker's source says.
 *
 * The worker runs `BUILTIN_WORKER_SOURCE` (./worker-source), a bundle of
 * ./worker and the checker it imports, kept as text so a compiled single
 * binary carries it (see ./runner). Text nothing type-checks or reviews line
 * by line must not drift from its source, nor be edited by hand: this
 * rebuilds it and compares. On a failure, run
 * `bun run scripts/gen-worker-source.ts` from the package.
 */
test("worker-source.ts is a fresh build of the checker", () => {
  const script = join(import.meta.dir, "..", "..", "scripts", "gen-worker-source.ts");
  const run = Bun.spawnSync([process.execPath, script, "--check"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  // Bundling the checker is slow by construction on a loaded CI runner.
}, 20_000);
