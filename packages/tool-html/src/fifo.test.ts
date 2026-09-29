/**
 * A FIFO named where an HTML file is expected is refused without being opened
 * (C074).
 *
 * The read was a synchronous `readFileSync` after a `statSync` (which does
 * not block on a FIFO, and reports it as 0 bytes). With no writer, opening a
 * FIFO blocks for ever, and with it the event loop: heartbeats, other
 * sessions, the whole harness. A writer is kept waiting on each pipe here,
 * so these tests stay bounded even against that code — an open would
 * complete, the read would return, and the writer would exit. It never
 * exits here, because nothing opens the pipe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { htmlText } from "./index";

let workspace: string;
const originalCwd = process.cwd();

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "tool-html-fifo-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * Make `name` a FIFO with a writer blocked on it, run `body`, and check the
 * writer is still blocked: nothing opened the pipe.
 */
async function withFifo(name: string, body: () => Promise<void>): Promise<void> {
  const fifo = join(workspace, name);
  mkdirSync(dirname(fifo), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const writer = Bun.spawn(["sh", "-c", `printf x > '${fifo}'`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await body();
    expect(writer.exitCode).toBeNull();
  } finally {
    writer.kill("SIGKILL");
    await writer.exited;
  }
}

/** The tool's answer as text, whether it returned or threw. */
async function answer(
  tool: { execute: (input: never, ctx: never) => unknown },
  input: unknown,
): Promise<string> {
  try {
    const out = await tool.execute(input as never, {} as never);
    return typeof out === "string" ? out : JSON.stringify(out);
  } catch (err) {
    return `threw: ${(err as Error).message}`;
  }
}

const posix = process.platform !== "win32";

describe("HtmlText refuses a FIFO", () => {
  test.if(posix)(
    "HtmlText refuses a FIFO file without opening it",
    async () => {
      await withFifo("page.html", async () => {
        const out = await answer(htmlText, { file: "page.html" });
        expect(out).toContain("is a fifo, not a regular file");
        expect(out).toContain("page.html");
      });
    },
    10_000,
  );
});
