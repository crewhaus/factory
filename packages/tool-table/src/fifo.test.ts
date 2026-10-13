/**
 * A FIFO named where a table, a fixed-width file or a stored profile is expected is refused without being opened
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
import { dataDriftCheck, fixedWidthParse, tableProfile } from "./index";

let workspace: string;
const originalCwd = process.cwd();

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "tool-table-fifo-")));
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

describe("tool-table refuses a FIFO", () => {
  test.if(posix)(
    "TableProfile refuses a FIFO file without opening it",
    async () => {
      await withFifo("t.csv", async () => {
        const out = await answer(tableProfile, { file: "t.csv" });
        expect(out).toContain("is a fifo, not a regular file");
        expect(out).toContain("t.csv");
      });
    },
    10_000,
  );

  test.if(posix)(
    "FixedWidthParse refuses a FIFO file without opening it",
    async () => {
      await withFifo("t.txt", async () => {
        const out = await answer(fixedWidthParse, {
          file: "t.txt",
          fields: [{ name: "a", start: 1, length: 2 }],
        });
        expect(out).toContain("is a fifo, not a regular file");
        expect(out).toContain("t.txt");
      });
    },
    10_000,
  );

  test.if(posix)(
    "DataDriftCheck refuses a FIFO stored profile without opening it",
    async () => {
      await withFifo("base.json", async () => {
        writeFileSync(join(workspace, "today.csv"), "a\n1\n");
        const out = await answer(dataDriftCheck, {
          file: "today.csv",
          referenceProfile: "base.json",
          epsilon: 0.01,
        });
        expect(out).toContain("is a fifo, not a regular file");
        expect(out).toContain("base.json");
      });
    },
    10_000,
  );
});
