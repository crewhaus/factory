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
 */

const scratch = mkdtempSync(join(tmpdir(), "tool-safety-compile-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("runRegex works, and its deadline holds, inside a compiled single binary", async () => {
  const entry = join(scratch, "entry.ts");
  const helper = join(import.meta.dir, "index.ts");
  writeFileSync(
    entry,
    [
      `import { runRegex } from ${JSON.stringify(helper)};`,
      `const ok = await runRegex({ op: "matchAll", pattern: "\\\\d+", input: "a1b22c333" });`,
      `const slow = await runRegex({ op: "test", pattern: "\\\\s+$|x", input: " ".repeat(40000) + "x", deadlineMs: 50 });`,
      "console.log(JSON.stringify({ ok, slow: slow.status }));",
    ].join("\n"),
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
    slow: string;
  };
  expect(out.ok.status).toBe("ok");
  expect(out.ok.result?.matches.map((m) => m.match)).toEqual(["1", "22", "333"]);
  expect(out.slow).toBe("timeout");
}, 120_000);
