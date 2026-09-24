import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openCheckedAndRead,
  openRegularFile,
  openRegularFileAsync,
  readFileBounded,
  readFileBoundedSync,
  readOpenedFile,
  readOpenedFileSync,
} from "./file";

const posix = process.platform !== "win32";
const dir = mkdtempSync(join(tmpdir(), "tool-safety-file-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function mkfifo(path: string): void {
  const made = Bun.spawnSync(["mkfifo", path]);
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
}

const readers = [
  ["async", readFileBounded],
  [
    "sync",
    async (p: string, o: Parameters<typeof readFileBoundedSync>[1]) => readFileBoundedSync(p, o),
  ],
] as const;

describe("readFileBounded", () => {
  for (const [name, read] of readers) {
    test(`${name}: reads at most maxBytes of a file far too large to read whole`, async () => {
      // Sparse: 8 GiB on paper, nothing on disk. Reading it whole would
      // throw or exhaust memory; a bounded read returns at once.
      const huge = join(dir, `huge-${name}.log`);
      writeFileSync(huge, "head of the log\n");
      truncateSync(huge, 8 * 1024 * 1024 * 1024);
      const r = await read(huge, { maxBytes: 1_000 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.bytes.length).toBe(1_000);
      expect(r.truncated).toBe(true);
      expect(r.size).toBe(8 * 1024 * 1024 * 1024);
      expect(r.text.startsWith("head of the log\n")).toBe(true);
    });

    test(`${name}: exactly maxBytes is not truncated; one more byte is`, async () => {
      const exact = join(dir, `exact-${name}.txt`);
      writeFileSync(exact, "abcde");
      expect(await read(exact, { maxBytes: 5 })).toMatchObject({
        ok: true,
        text: "abcde",
        truncated: false,
      });
      expect(await read(exact, { maxBytes: 4 })).toMatchObject({
        ok: true,
        text: "abcd",
        truncated: true,
      });
      const empty = join(dir, `empty-${name}.txt`);
      writeFileSync(empty, "");
      expect(await read(empty, { maxBytes: 4 })).toMatchObject({
        ok: true,
        text: "",
        truncated: false,
      });
    });

    test(`${name}: a cap inside a multi-byte character drops the partial character`, async () => {
      const utf = join(dir, `utf-${name}.txt`);
      writeFileSync(utf, "ab\u00e9\u00e9");
      const r = await read(utf, { maxBytes: 3 });
      expect(r).toMatchObject({ ok: true, text: "ab", truncated: true });
    });

    test(`${name}: missing, directory, and symlink policy`, async () => {
      expect(await read(join(dir, "nope"), { maxBytes: 10 })).toMatchObject({
        ok: false,
        code: "not-found",
      });
      const sub = join(dir, `sub-${name}`);
      mkdirSync(sub);
      expect(await read(sub, { maxBytes: 10 })).toMatchObject({
        ok: false,
        code: "not-regular-file",
        kind: "directory",
      });
      if (!posix) return;
      const target = join(dir, `target-${name}.txt`);
      writeFileSync(target, "via link");
      const link = join(dir, `link-${name}`);
      symlinkSync(target, link);
      expect(await read(link, { maxBytes: 100 })).toMatchObject({ ok: true, text: "via link" });
      expect(await read(link, { maxBytes: 100, followSymlinks: false })).toMatchObject({
        ok: false,
        code: "symlink-refused",
      });
    });
  }

  test.if(posix)("character devices are refused before they are opened", async () => {
    for (const device of ["/dev/null", "/dev/zero"]) {
      expect(await readFileBounded(device, { maxBytes: 10 })).toMatchObject({
        ok: false,
        code: "not-regular-file",
        kind: "character-device",
      });
      expect(readFileBoundedSync(device, { maxBytes: 10 })).toMatchObject({
        ok: false,
        code: "not-regular-file",
        kind: "character-device",
      });
    }
  });

  test.if(posix)(
    "a FIFO is refused BEFORE it is opened: a writer waiting on it stays blocked",
    async () => {
      const fifo = join(dir, "pipe");
      mkfifo(fifo);
      // The writer's open() blocks until some reader opens the FIFO. If the
      // helper opened it — even non-blocking, even briefly — the writer
      // would wake, write (or take SIGPIPE) and exit.
      const writer = Bun.spawn(["sh", "-c", `printf x > '${fifo}'`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await Bun.sleep(100); // let the writer reach its blocking open
        const a = await readFileBounded(fifo, { maxBytes: 10 });
        const b = readFileBoundedSync(fifo, { maxBytes: 10 });
        for (const r of [a, b]) {
          expect(r).toMatchObject({ ok: false, code: "not-regular-file", kind: "fifo" });
          if (!r.ok) expect(r.reason).toContain("not opened");
        }
        await Bun.sleep(300);
        expect(writer.exitCode).toBeNull();
      } finally {
        writer.kill("SIGKILL");
        await writer.exited;
      }
    },
    20_000,
  );

  test.if(posix)(
    "a path swapped for a FIFO after the check is refused on the open descriptor, without blocking",
    async () => {
      const path = join(dir, "swapped");
      writeFileSync(path, "regular");
      const stale = statSync(path);
      rmSync(path);
      mkfifo(path);
      // No writer exists: a blocking open would hang here for ever.
      const r = await openCheckedAndRead(path, stale, { maxBytes: 10 });
      expect(r).toMatchObject({ ok: false, code: "not-regular-file", kind: "fifo" });
      if (!r.ok) expect(r.reason).toContain("became");
    },
    10_000,
  );

  test("a file replaced between the check and the open is refused", async () => {
    const path = join(dir, "replaced.txt");
    writeFileSync(path, "first");
    const stale = statSync(path);
    const other = join(dir, "other.txt");
    writeFileSync(other, "second");
    renameSync(other, path);
    const r = await openCheckedAndRead(path, stale, { maxBytes: 100 });
    expect(r).toMatchObject({ ok: false, code: "changed-while-opening" });
  });
});

describe("budgets, offsets and the open descriptor", () => {
  const file = join(dir, "twelve.txt");
  writeFileSync(file, "hello world!");

  test("a NaN, negative or missing maxBytes throws instead of reading an empty 'complete' file", async () => {
    for (const maxBytes of [Number.NaN, -1, undefined, Number.POSITIVE_INFINITY, "10"]) {
      const options = { maxBytes } as unknown as { maxBytes: number };
      expect(() => readFileBoundedSync(file, options)).toThrow(RangeError);
      await expect(readFileBounded(file, options)).rejects.toThrow(RangeError);
    }
    // The budget is checked before the path: a bad budget never looks like a bad file.
    expect(() => readFileBoundedSync(join(dir, "missing"), { maxBytes: Number.NaN })).toThrow(
      RangeError,
    );
    expect(readFileBoundedSync(file, { maxBytes: 0 })).toMatchObject({
      ok: true,
      text: "",
      truncated: true,
    });
  });

  test("position starts the read at a byte offset, and truncation is about what follows it", async () => {
    for (const [, read] of readers) {
      expect(await read(file, { maxBytes: 5, position: 6 })).toMatchObject({
        ok: true,
        text: "world",
        truncated: true,
        size: 12,
      });
      expect(await read(file, { maxBytes: 6, position: 6 })).toMatchObject({
        text: "world!",
        truncated: false,
      });
      expect(await read(file, { maxBytes: 6, position: 40 })).toMatchObject({
        text: "",
        truncated: false,
      });
    }
    expect(() => readFileBoundedSync(file, { maxBytes: 5, position: -1 })).toThrow(RangeError);
  });

  test.if(posix)(
    "openRegularFile hands over a checked descriptor, and refuses a FIFO before opening it",
    async () => {
      const opened = openRegularFile(file);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      try {
        expect(opened.stats.size).toBe(12);
        expect(readOpenedFileSync(opened, { maxBytes: 5, position: 6 })).toMatchObject({
          text: "world",
        });
      } finally {
        closeSync(opened.fd);
      }
      const fifo = join(dir, "open-fifo");
      mkfifo(fifo);
      // Opening a FIFO for reading would block until a writer appears.
      expect(openRegularFile(fifo)).toMatchObject({
        ok: false,
        code: "not-regular-file",
        kind: "fifo",
      });
      expect(await openRegularFileAsync(fifo)).toMatchObject({ ok: false, kind: "fifo" });
      const link = join(dir, "open-link");
      symlinkSync(file, link);
      expect(openRegularFile(link, { followSymlinks: false })).toMatchObject({
        ok: false,
        code: "symlink-refused",
      });
      const handle = await openRegularFileAsync(link);
      expect(handle.ok).toBe(true);
      if (!handle.ok) return;
      try {
        expect(await readOpenedFile(handle.handle, handle.stats, { maxBytes: 5 })).toMatchObject({
          text: "hello",
        });
      } finally {
        await handle.handle.close();
      }
    },
  );
});
