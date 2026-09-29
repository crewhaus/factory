/**
 * A FIFO named where a document is read or written is refused without being
 * opened (C074's sibling in this package, bounds review).
 *
 * Every reader here `statSync`ed the path (which does not block on a FIFO,
 * and reports it as 0 bytes) and then `readFileSync`ed it; every writer, with
 * `overwrite`, `writeFileSync`ed it. Both are synchronous opens that wait for
 * ever for the other end of the pipe, and with them the event loop:
 * heartbeats, other sessions, the whole harness. The other end is kept
 * waiting here, so these tests stay bounded even against that code — the
 * open would complete and the peer exit. It never exits here, because
 * nothing opens the pipe.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentDiff,
  documentTextTool as documentText,
  docxRead,
  docxWrite,
  emlParse,
  icsParse,
  icsWrite,
  mboxSplit,
  pdfInfo,
  pdfText,
  vcardParse,
} from "./index";

let workspace: string;
const originalCwd = process.cwd();

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "tool-docs-fifo-")));
  process.chdir(workspace);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * Make `name` a FIFO with the other end (`"writer"` for a read, `"reader"`
 * for a write) blocked on it, run `body`, and check the peer is still
 * blocked: nothing opened the pipe.
 */
async function withFifo(
  name: string,
  peer: "writer" | "reader",
  body: () => Promise<void>,
): Promise<void> {
  const fifo = join(workspace, name);
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const command = peer === "writer" ? `printf x > '${fifo}'` : `cat '${fifo}' > /dev/null`;
  const other = Bun.spawn(["sh", "-c", command], { stdout: "ignore", stderr: "ignore" });
  try {
    await body();
    expect(other.exitCode).toBeNull();
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  } finally {
    other.kill("SIGKILL");
    await other.exited;
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

describe("a reader refuses a FIFO", () => {
  const cases: [string, { execute: (input: never, ctx: never) => unknown }, unknown][] = [
    ["doc.txt", documentText, { path: "doc.txt" }],
    ["page.html", documentText, { path: "page.html" }],
    ["a.pdf", pdfInfo, { path: "a.pdf" }],
    ["b.pdf", pdfText, { path: "b.pdf" }],
    ["a.docx", docxRead, { path: "a.docx" }],
    ["a.eml", emlParse, { path: "a.eml" }],
    ["a.mbox", mboxSplit, { path: "a.mbox" }],
    ["a.ics", icsParse, { path: "a.ics" }],
    ["a.vcf", vcardParse, { path: "a.vcf" }],
    ["left.txt", documentDiff, { a: "left.txt", b: "left.txt" }],
  ];
  for (const [name, tool, input] of cases) {
    test.if(posix)(
      `${name}`,
      async () => {
        await withFifo(name, "writer", async () => {
          const out = await answer(tool, input);
          expect(out).toContain(`"${name}" is a fifo, not a regular file`);
        });
      },
      10_000,
    );
  }

  test("a missing file and a directory are still named as before", async () => {
    expect(await answer(documentText, { path: "nope.txt" })).toContain("no such file: nope.txt");
    Bun.spawnSync(["mkdir", join(workspace, "dir.txt")]);
    expect(await answer(documentText, { path: "dir.txt" })).toContain(
      '"dir.txt" is a directory, not a file',
    );
  });
});

describe("a writer's destination that is a FIFO is refused, overwrite or not", () => {
  test.if(posix)(
    "IcsWrite with overwrite",
    async () => {
      await withFifo("cal.ics", "reader", async () => {
        const out = await answer(icsWrite, {
          path: "cal.ics",
          stamp: "2024-01-01T00:00:00Z",
          events: [{ uid: "u", summary: "s", start: "2024-01-15T09:00:00Z" }],
          overwrite: true,
        });
        expect(out).toContain('"cal.ics" is a fifo, not a regular file');
      });
    },
    10_000,
  );

  test.if(posix)(
    "DocxWrite with overwrite",
    async () => {
      await withFifo("w.docx", "reader", async () => {
        const out = await answer(docxWrite, {
          path: "w.docx",
          blocks: [{ type: "paragraph", text: "x" }],
          overwrite: true,
        });
        expect(out).toContain('"w.docx" is a fifo, not a regular file');
      });
    },
    10_000,
  );

  test("an ordinary overwrite still replaces the file and keeps its mode", async () => {
    writeFileSync(join(workspace, "cal.ics"), "old", { mode: 0o640 });
    const refused = await answer(icsWrite, {
      path: "cal.ics",
      stamp: "2024-01-01T00:00:00Z",
      events: [{ uid: "u", summary: "s", start: "2024-01-15T09:00:00Z" }],
    });
    expect(refused).toContain('"cal.ics" already exists; pass overwrite to replace it');
    await answer(icsWrite, {
      path: "cal.ics",
      stamp: "2024-01-01T00:00:00Z",
      events: [{ uid: "u", summary: "s", start: "2024-01-15T09:00:00Z" }],
      overwrite: true,
    });
    expect(readFileSync(join(workspace, "cal.ics"), "utf8")).toContain("BEGIN:VCALENDAR");
    if (posix) expect(lstatSync(join(workspace, "cal.ics")).mode & 0o777).toBe(0o640);
  });
});
