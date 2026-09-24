import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openForRead, openForReadSync } from "./read";
import { fixture, mkfifo, posix } from "./test-helpers";

const f = fixture("read");
afterAll(() => f.cleanup());

const readers = [
  ["async", openForRead],
  [
    "sync",
    async (root: string, given: string, o: Parameters<typeof openForReadSync>[2]) =>
      openForReadSync(root, given, o),
  ],
] as const;

writeFileSync(join(f.ws, "note.txt"), "hello");

describe("openForRead", () => {
  for (const [name, read] of readers) {
    test(`${name}: reads a contained file, capped`, async () => {
      const big = join(f.ws, `big-${name}.log`);
      writeFileSync(big, "head\n");
      truncateSync(big, 4 * 1024 * 1024 * 1024);
      const r = await read(f.ws, `big-${name}.log`, { maxBytes: 5 });
      expect(r).toMatchObject({
        ok: true,
        text: "head\n",
        truncated: true,
        rel: `big-${name}.log`,
      });
      expect(await read(f.ws, "note.txt", { maxBytes: 100 })).toMatchObject({
        ok: true,
        text: "hello",
        truncated: false,
      });
    });

    test(`${name}: a budget that is not a number is thrown, not read as "empty"`, async () => {
      // NaN compares false with everything: the reader stopped at once and
      // returned "" with truncated:false, as if the file were empty.
      await expect(read(f.ws, "note.txt", { maxBytes: Number.NaN })).rejects.toThrow(RangeError);
      await expect(read(f.ws, "note.txt", { maxBytes: -1 })).rejects.toThrow(
        "maxBytes must be a number >= 0",
      );
    });

    test(`${name}: missing and directory are named in the caller's words`, async () => {
      expect(await read(f.ws, "nope.txt", { maxBytes: 5 })).toMatchObject({
        ok: false,
        code: "not-found",
        path: "nope.txt",
      });
      mkdirSync(join(f.ws, `d-${name}`));
      expect(await read(f.ws, `d-${name}`, { maxBytes: 5 })).toMatchObject({
        ok: false,
        code: "not-regular-file",
        kind: "directory",
      });
      expect(await read(f.ws, "../outside/secret.txt", { maxBytes: 100 })).toMatchObject({
        ok: false,
        code: "escapes-root",
      });
    });
  }
});

describe.if(posix)("openForRead contains the leaf, not just the directory", () => {
  for (const [name, read] of readers) {
    test(`${name}: a fixed-name leaf linked out of a contained directory is refused (security-9#2, security-7#1)`, async () => {
      // A cloned project commits requirements.txt -> ~/.aws/credentials; the
      // tool contained `proj` and joined the leaf onto it.
      const proj = join(f.ws, `proj-${name}`);
      mkdirSync(proj);
      symlinkSync(join(f.outside, "secret.txt"), join(proj, "requirements.txt"));
      symlinkSync("../../outside/secret.txt", join(proj, "package.json"));
      for (const leaf of ["requirements.txt", "package.json"]) {
        const r = await read(f.ws, `proj-${name}/${leaf}`, { maxBytes: 1000 });
        expect(r).toMatchObject({ ok: false, code: "escapes-root", path: `proj-${name}/${leaf}` });
        if (!r.ok) {
          expect(r.reason).not.toContain("TOP-SECRET");
          expect(r.reason).not.toContain(f.outside);
        }
      }
    });

    test(`${name}: an in-root link reads normally unless links are refused at the leaf`, async () => {
      symlinkSync("note.txt", join(f.ws, `alias-${name}`));
      expect(await read(f.ws, `alias-${name}`, { maxBytes: 100 })).toMatchObject({
        ok: true,
        text: "hello",
      });
      const refused = await read(f.ws, `alias-${name}`, {
        maxBytes: 100,
        followLeafSymlink: false,
      });
      expect(refused).toMatchObject({ ok: false, code: "is-symlink", path: `alias-${name}` });
    });

    test(`${name}: a dangling in-root link is not-found, an escaping one is refused`, async () => {
      symlinkSync("absent.txt", join(f.ws, `dangle-${name}`));
      expect(await read(f.ws, `dangle-${name}`, { maxBytes: 10 })).toMatchObject({
        ok: false,
        code: "not-found",
      });
    });

    test(`${name}: a FIFO is refused without being opened, so the call returns (flag-truth-6#3)`, async () => {
      const fifo = join(f.ws, `pipe-${name}.csv`);
      mkfifo(fifo);
      const writer = Bun.spawn(["sh", "-c", `printf x > '${fifo}'`], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        await Bun.sleep(100);
        const r = await read(f.ws, `pipe-${name}.csv`, { maxBytes: 10 });
        expect(r).toMatchObject({ ok: false, code: "not-regular-file", kind: "fifo" });
        if (!r.ok) expect(r.reason).toContain(`"pipe-${name}.csv" is a fifo`);
        await Bun.sleep(200);
        // The writer is still blocked in open(): nobody opened the FIFO.
        expect(writer.exitCode).toBeNull();
      } finally {
        writer.kill("SIGKILL");
        await writer.exited;
      }
    }, 10_000);
  }

  test("a device behind an in-root link is refused as what it is", async () => {
    symlinkSync("/dev/zero", join(f.ws, "zero.bin"));
    // /dev is outside the root, so containment refuses it first.
    expect(await openForRead(f.ws, "zero.bin", { maxBytes: 10 })).toMatchObject({
      ok: false,
      code: "escapes-root",
    });
    // Rooted where the device lives, the kind check is what refuses it.
    expect(await openForRead("/dev", "zero", { maxBytes: 10 })).toMatchObject({
      ok: false,
      code: "not-regular-file",
      kind: "character-device",
    });
  });
});
