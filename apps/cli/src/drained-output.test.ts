/**
 * 0.8.0 §11 (review I11) — `crewhaus provability` waits for its output before
 * it exits. Bun drops what a pipe has not taken at exit, so a hard exit right
 * after a large write cut piped `--json` at 64 KiB (or wherever the pipe's
 * buffer ended): the subprocess drive below pipes megabytes of `check --json`
 * through the real entry file and parses all of it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WritableLike, drainedOutput } from "./drained-output";

const CLI_PATH = join(import.meta.dir.replace(/([/\\])dist$/, "$1src"), "index.ts");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("drainedOutput", () => {
  test("drained() waits for every write's own callback, on both streams", async () => {
    const callbacks: Array<() => void> = [];
    const written: string[] = [];
    const stream: WritableLike = {
      write(chunk, callback) {
        written.push(chunk);
        callbacks.push(() => callback());
        return false;
      },
    };
    const io = drainedOutput(stream, stream);
    io.out("a".repeat(10));
    io.err("b");
    let done = false;
    const wait = io.drained().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(written).toEqual(["a".repeat(10), "b"]);
    (callbacks.shift() as () => void)();
    await Promise.resolve();
    expect(done).toBe(false);
    (callbacks.shift() as () => void)();
    await wait;
    expect(done).toBe(true);
  });

  test("a failed write (a reader that went away) still ends the wait", async () => {
    const stream: WritableLike = {
      write(_chunk, callback) {
        queueMicrotask(() => callback(new Error("EPIPE: broken pipe, write")));
        return false;
      },
    };
    const io = drainedOutput(stream, stream);
    io.out("x");
    await io.drained();
  });
});

describe("crewhaus provability — piped output is whole", () => {
  test("megabytes of `check --json` through a pipe parse, every claim present", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "provability-pipe-"));
    dirs.push(cwd);
    const claims = 6_000;
    const lines: string[] = [];
    for (let i = 0; i < claims; i++) {
      lines.push(
        `Claim ${i} says the widget ships within ${i} days of the order [${(i % 50) + 1}].`,
      );
    }
    const defs: string[] = [];
    for (let j = 1; j <= 50; j++) defs.push(`[${j}]: https://acme.example/page${j}`);
    writeFileSync(join(cwd, "answer.md"), `${lines.join("\n\n")}\n\n${defs.join("\n")}\n`);
    const proc = Bun.spawn(
      [
        process.execPath,
        CLI_PATH,
        "provability",
        "check",
        "answer.md",
        "--level",
        "cited",
        "--json",
      ],
      {
        cwd,
        env: { PATH: process.env["PATH"] ?? "" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(err).toBe("");
    expect(code).toBe(0);
    // Well past any pipe buffer: the old hard exit lost everything after it.
    expect(out.length).toBeGreaterThan(1_000_000);
    const bundle = JSON.parse(out) as { verdict: string; claimCount: number };
    expect(bundle.verdict).toBe("pass");
    expect(bundle.claimCount).toBe(claims);
  }, 30_000);
});
