/**
 * A FIFO named where an e-invoice is expected is refused without being opened
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
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INVOICE, NACHA_OPTIONS, NACHA_PAYMENTS } from "./fixtures";
import { eInvoiceBuild, eInvoiceParse, paymentFileBuild } from "./index";

let workspace: string;
const originalCwd = process.cwd();

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "tool-einvoice-fifo-")));
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

describe("EInvoiceParse refuses a FIFO", () => {
  test.if(posix)(
    "EInvoiceParse refuses a FIFO file without opening it",
    async () => {
      await withFifo("inv.xml", async () => {
        const out = await answer(eInvoiceParse, { file: "inv.xml" });
        expect(out).toContain("is a fifo, not a regular file");
        expect(out).toContain("inv.xml");
      });
    },
    10_000,
  );
});

/**
 * Make `name` a FIFO with a READER blocked on it, run `body`, and check the
 * reader is still blocked: nothing opened the pipe to write. Against the old
 * code the open completes (a reader is waiting), the bytes go down the pipe,
 * and the reader exits, so the test fails without hanging.
 */
async function withReader(name: string, body: () => Promise<void>): Promise<void> {
  const fifo = join(workspace, name);
  mkdirSync(dirname(fifo), { recursive: true });
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const reader = Bun.spawn(["sh", "-c", `cat '${fifo}' > /dev/null`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await body();
    expect(reader.exitCode).toBeNull();
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  } finally {
    reader.kill("SIGKILL");
    await reader.exited;
  }
}

describe("a builder's outFile that is a FIFO is refused, not opened (C074's sibling, bounds review)", () => {
  // 0.7.1's first cut `writeFileSync`ed an overwrite straight onto the path:
  // with no reader, that synchronous open never returns (killed at 8 s by
  // the reviewer's alarm, where a regular file took 15 ms).
  test.if(posix)(
    "EInvoiceBuild with overwrite",
    async () => {
      await withReader("invoice.xml", async () => {
        const out = await answer(eInvoiceBuild, {
          syntax: "ubl",
          invoice: INVOICE,
          outFile: "invoice.xml",
          overwrite: true,
        });
        expect(out).toContain('"invoice.xml" is a fifo, not a regular file');
      });
    },
    10_000,
  );

  test.if(posix)(
    "PaymentFileBuild with overwrite",
    async () => {
      await withReader("ach/batch.txt", async () => {
        const out = await answer(paymentFileBuild, {
          format: "nacha",
          payments: NACHA_PAYMENTS,
          nacha: NACHA_OPTIONS,
          outFile: "ach/batch.txt",
          overwrite: true,
        });
        expect(out).toContain('"ach/batch.txt" is a fifo, not a regular file');
      });
    },
    10_000,
  );

  test("an overwrite of a regular file still replaces it, and keeps its mode", async () => {
    writeFileSync(join(workspace, "invoice.xml"), "old", { mode: 0o640 });
    const out = await answer(eInvoiceBuild, {
      syntax: "ubl",
      invoice: INVOICE,
      outFile: "invoice.xml",
      overwrite: true,
    });
    expect(JSON.parse(out).file).toBe("invoice.xml");
    expect(readFileSync(join(workspace, "invoice.xml"), "utf8")).toContain("<Invoice");
    if (posix) expect(lstatSync(join(workspace, "invoice.xml")).mode & 0o777).toBe(0o640);
  });
});
